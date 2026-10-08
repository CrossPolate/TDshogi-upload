/**
 * net.js — 客户端网络信息（IP / UA）采集（PLAN §M3，§K 的地基）
 *
 * 设计要点：
 *  - 单一入口：HTTP 与 WebSocket 握手都走 clientIp(req) / clientUa(req)，
 *    避免各处各写一份「到底取 XFF 还是 remoteAddress」的解析。
 *  - 反代信任可配：TRUST_PROXY 未配置时**不信任任何代理头**——
 *    否则任何人伪造 X-Forwarded-For 就能伪装 IP。
 *      TRUST_PROXY=0|false  不使用代理头（直连部署，默认）
 *      TRUST_PROXY=1        信任最后 1 层代理（Nginx 反代，取 XFF 倒数第 1 个）
 *      TRUST_PROXY=true     信任全部代理（多层 CDN，取 XFF 最左那个）
 *  - 只做解析不做存储：是否落盘由调用方决定（见 auth / audit）。
 */
'use strict';

const TRUST_PROXY = String(process.env.TRUST_PROXY || '0').trim();
const UA_MAX = 200;

/**
 * 反代层数。0 = 不信任代理头。
 * @returns {number} 0 | 正整数 | Infinity
 */
function trustProxyHops() {
  if (TRUST_PROXY === 'true') return Infinity;
  if (TRUST_PROXY === '' || TRUST_PROXY === 'false') return 0;
  const n = parseInt(TRUST_PROXY, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 传给 app.set('trust proxy', ...) 的值（Express 与本项目口径一致） */
function trustProxySetting() {
  const hops = trustProxyHops();
  return hops === Infinity ? true : hops;
}

/**
 * IPv6 规范化（2026-10-02 审查 P2-10）：小写化 + 去 zone-id + 去前导零 + 展开 `::`，
 * 让 `2001:db8::1` 与 `2001:0DB8:0:0:0:0:0:1` 归一为同一字符串——否则它们会得到**不同的**
 * 限流桶键与 WS 连接计数键（IP 封禁走 ipban 的整数归一，不受此影响）。非法输入原样返回。
 * @param {string} ip
 */
function canonV6(ip) {
  const s = String(ip).split('%')[0].toLowerCase();
  const parts = s.split('::');
  if (parts.length > 2) return ip;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  const groups = head.concat(tail);
  if (!groups.length || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  if (parts.length === 1 && groups.length !== 8) return ip;
  if (parts.length === 2 && groups.length >= 8) return ip;
  const fill = 8 - groups.length;
  const full = head.concat(new Array(fill).fill('0'), tail);
  // ⚠️ 2026-10-03 修复（由 tests/net.test.js 的幂等用例抓出）：这里原写作
  // `String(parseInt(g, 16))` —— 把每一组**按十六进制解析后又用十进制输出**，
  // 于是 `2001:db8::1` 会变成 `8193:3512:0:0:0:0:0:1`（非标准），**再归一一次还会继续漂**
  // （8193 被当十六进制 → 33171），既不幂等、也让基于 IP 的封禁匹配不上/可被绕过。
  // 正确做法：解析成数值后用**十六进制**输出。
  return full.map((g) => parseInt(g, 16).toString(16)).join(':');
}

/**
 * IP 归一化与校验：去端口、::ffff: 前缀映射、::1 → 127.0.0.1、IPv4 规范点分十进制、
 * IPv6 规范化。非法值返回 null（宁可没有，也不要把脏数据写进库）。
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeIp(raw) {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (!ip) return null;
  if (ip[0] === '[') { // [::1]:1234 形式
    const m = /^\[([^\]]+)\]/.exec(ip);
    if (m) ip = m[1];
  }
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  const isV4 = m4 && ip.split('.').every((n) => Number(n) <= 255);
  const isV6 = ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip);
  // ⚠️ 2026-10-04 审查 P2：IPv4 也要归一化——`010.2.3.4` / `1.2.3.04` 等带前导零的变体若原样
  // 返回，会拿到**不同的**限流桶键 / WS 连接计数键，从而绕过限流与并发上限。
  // 每段 `Number(x)` 去前导零再转回字符串，保持四段点分十进制（段 ≤255 校验保留在上面）。
  if (isV4) return m4.slice(1).map((n) => String(Number(n))).join('.');
  return isV6 ? canonV6(ip) : null;
}

function forwardedList(req) {
  const raw = req && req.headers ? req.headers['x-forwarded-for'] : null;
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 取客户端 IP。
 * @param {object} req http.IncomingMessage（HTTP 请求或 WS 握手请求）
 * @returns {string|null}
 */
function clientIp(req) {
  if (!req) return null;
  const hops = trustProxyHops();
  if (hops > 0) {
    const list = forwardedList(req);
    if (list.length) {
      // hops = 1 取倒数第 1 个（最靠近本站的代理看到的地址）；true 取最左（原始客户端）
      const idx = hops === Infinity ? 0 : Math.max(0, list.length - hops);
      const ip = normalizeIp(list[idx]);
      if (ip) return ip;
    }
    const real = normalizeIp(req.headers && req.headers['x-real-ip']);
    if (real) return real;
  }
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

/**
 * 取客户端 UA（截断，防超长脏数据）。
 * @returns {string|null}
 */
function clientUa(req) {
  const ua = req && req.headers ? req.headers['user-agent'] : null;
  if (!ua) return null;
  return String(ua).slice(0, UA_MAX);
}

/** 一次性打包（连接建立时调用） */
function clientInfo(req) {
  return { ip: clientIp(req), ua: clientUa(req) };
}

/** Express 中间件：把 ip/ua 挂到 req 上，供审计与登录接口复用 */
function attachClientInfo(req, _res, next) {
  req.clientIp = clientIp(req);
  req.clientUa = clientUa(req);
  next();
}

/**
 * 脱敏显示（巡检/演示场景，ADMIN_IP_MASK=1 时对管理员也只显示段位）。
 * 1.2.3.4 → 1.2.*.* ；2001:db8::1 → 2001:db8:*
 */
function maskIp(ip) {
  const s = normalizeIp(ip);
  if (!s) return null;
  if (s.includes(':')) return `${s.split(':').slice(0, 2).join(':')}:*`;
  const p = s.split('.');
  return `${p[0]}.${p[1]}.*.*`;
}

module.exports = {
  TRUST_PROXY,
  trustProxyHops,
  trustProxySetting,
  normalizeIp,
  clientIp,
  clientUa,
  clientInfo,
  attachClientInfo,
  maskIp,
};
