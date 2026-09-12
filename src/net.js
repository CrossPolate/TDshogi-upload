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
 * IP 归一化与校验：去端口、::ffff: 前缀映射、::1 → 127.0.0.1。
 * 非法值返回 null（宁可没有，也不要把脏数据写进库）。
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
  const isV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)
    && ip.split('.').every((n) => Number(n) <= 255);
  const isV6 = ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip);
  return isV4 || isV6 ? ip : null;
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
