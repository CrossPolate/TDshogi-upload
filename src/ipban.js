/**
 * ipban.js — 管理员 IP 封禁（PLAN §X，2026-09-15）
 *
 * 需求：管理员可封禁 IP 或网段，拒绝其后续**全部**访问（HTTP + WebSocket），
 * 可设到期时间、必填理由、可查看列表 / 解封 / 延长。
 *
 * ## 设计要点（难点全在边界，详见 PLAN §X2）
 * 1. **两处生效**：HTTP 中间件 + WS 握手。⚠️ 只挡 HTTP 是**假封禁**——
 *    WS 才是对局主通道，漏了它，被封的人照样能下棋；
 * 2. **网段匹配用 BigInt 位运算，不是字符串比对**：
 *    `2001:db8::1` 与 `2001:0db8:0000:0000:0000:0000:0000:0001` 是**同一个地址**，
 *    字符串比对会被轻松绕过；同时掩掉主机位，让 `203.0.113.7/24` 与
 *    `203.0.113.0/24` 归一到**同一条**记录（否则会攒出一堆近似 key）；
 * 3. **默认限时（24h）**：NAT 共享出口（家庭 / 学校 / 公司）封一个 IP
 *    可能误伤几百人，永久封禁必须显式选择；
 * 4. **白名单**：回环 + 内网段 + 环境变量 `IP_BAN_WHITELIST` ——
 *    避免把监控探活、内网调用一起封掉；
 * 5. **落盘**走 storage 的 kv，重启不丢；
 * 6. **不做自动封禁**：限流触发时只给"建议"。自动封禁 + NAT 共享 IP = 大面积误伤，
 *    收益不值这个风险（见 PLAN §X7）。
 */
'use strict';

// ⚠️ 刻意**不引入 `./net`**：`parseIpLiteral` 自己做字面量归一化，
// 而 `net.normalizeIp` 会把 `::1` 改写成 `127.0.0.1`——那对"客户端 IP"正确，
// 对"规则字面量"却是错的（会让 `::1/128` 静默失效，见 parseIpLiteral 的注释）。
const { readJson, writeJson } = require('./storage');
const log = require('./logger');

const KEY = 'ipbans.json';

/** 封禁时长档位（后台下拉用）。`hours: null` = 永久 */
const DURATIONS = [
  { id: '1h', label: '1 小时', hours: 1 },
  { id: '24h', label: '24 小时（默认）', hours: 24 },
  { id: '7d', label: '7 天', hours: 24 * 7 },
  { id: 'forever', label: '永久（谨慎）', hours: null },
];

/**
 * 内置白名单：回环 + RFC1918 内网 + IPv6 本地链路。
 * 封禁永远不作用于这些段——否则一次误操作就能把自己（或监控）关在门外。
 */
const BUILTIN_WHITELIST = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '::1/128', 'fc00::/7', 'fe80::/10',
];

// ==================================================================
// IP ↔ BigInt
// ==================================================================

/** 展开 IPv6 为 8 组 4 位十六进制（处理 `::` 缩写与 zone id） */
function expandV6(ip) {
  let s = String(ip);
  const zone = s.indexOf('%');       // fe80::1%eth0
  if (zone >= 0) s = s.slice(0, zone);
  const halves = s.split('::');
  if (halves.length > 2) return null; // 多个 `::` 非法
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = (halves.length === 2 && halves[1]) ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null; // 无 `::` 就必须写满 8 组
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const parts = halves.length === 2 ? head.concat(new Array(fill).fill('0'), tail) : head;
  if (parts.length !== 8) return null;
  if (parts.some((p) => !/^[0-9a-fA-F]{1,4}$/.test(p))) return null;
  return parts.map((p) => p.padStart(4, '0').toLowerCase());
}

/**
 * 把 IP 转成可比较的整数。
 * @returns {{value:bigint, bits:number, family:4|6}|null}
 */
function ipToInt(ip) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (v4) {
    let n = 0n;
    for (let i = 1; i <= 4; i++) {
      const o = Number(v4[i]);
      if (o > 255) return null;
      n = (n << 8n) | BigInt(o);
    }
    return { value: n, bits: 32, family: 4 };
  }
  const parts = expandV6(ip);
  if (!parts) return null;
  let n = 0n;
  for (const p of parts) n = (n << 16n) | BigInt(parseInt(p, 16));
  return { value: n, bits: 128, family: 6 };
}

function intToV4(n) {
  return [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n)).join('.');
}

/** 整数 → 压缩 IPv6（与标准写法一致，保证同段生成同一个 key） */
function intToV6(n) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  let best = -1; let bestLen = 0; let cur = -1; let curLen = 0;
  groups.forEach((g, i) => {
    if (g === '0') {
      if (cur < 0) cur = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; best = cur; }
    } else { cur = -1; curLen = 0; }
  });
  if (bestLen < 2) return groups.join(':');
  const head = groups.slice(0, best).join(':');
  const tail = groups.slice(best + bestLen).join(':');
  return `${head}::${tail}`;
}

function intToIp(value, family) {
  return family === 4 ? intToV4(value) : intToV6(value);
}

/** 前缀掩码：保留前 prefix 位 */
function maskOf(prefix, bits) {
  if (prefix <= 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

/**
 * 解析规则里的地址字面量：去端口、去 `::ffff:` 映射。
 *
 * ⚠️ 这里**刻意不用 `net.normalizeIp`**：它会把 `::1` 改写成 `127.0.0.1`——
 * 对"客户端 IP"这是对的（两者确实是同一个回环），但对**规则字面量**是错的：
 * `::1/128` 会被改写成 IPv4 地址，随后因为"128 位前缀 > 32 位"被判非法直接丢弃，
 * 于是白名单里的 `::1/128` **静默失效**（本次就是踩了这个才被测试抓出来）。
 *
 * @returns {string|null}
 */
function parseIpLiteral(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return null;
  if (ip[0] === '[') { // [::1]:1234
    const m = /^\[([^\]]+)\]/.exec(ip);
    if (m) ip = m[1];
  }
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  return ipToInt(ip) ? ip : null;
}

/**
 * 解析「IP」或「IP/前缀」为规则。
 *
 * ⚠️ 主机位会被**掩掉**（`203.0.113.7/24` → `203.0.113.0/24`）：
 * 同一网段反复封禁只得到一条记录，不会攒出一堆近似 key。
 *
 * @returns {{key:string, base:bigint, prefix:number, bits:number, family:4|6}|null}
 */
function parseRule(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const slash = s.lastIndexOf('/');
  const ipPart = slash >= 0 ? s.slice(0, slash) : s;
  const ip = parseIpLiteral(ipPart);
  if (!ip) return null;
  const info = ipToInt(ip);
  if (!info) return null;

  let prefix = info.bits;
  if (slash >= 0) {
    const n = Number(s.slice(slash + 1));
    if (!Number.isInteger(n) || n < 0 || n > info.bits) return null;
    prefix = n;
  }
  const base = info.value & maskOf(prefix, info.bits);
  return { key: `${intToIp(base, info.family)}/${prefix}`, base, prefix, bits: info.bits, family: info.family };
}

/** 地址是否落在规则内。⚠️ 跨协议（v4 规则 vs v6 地址）一律不匹配 */
function inRule(rule, info) {
  if (!rule || !info || rule.bits !== info.bits) return false;
  return (info.value & maskOf(rule.prefix, rule.bits)) === rule.base;
}

/**
 * 判断某地址是否落在指定规则内（规则可传 IP 或网段）。
 *
 * 后台「防自锁」判定要用：不能用字符串比对来判断"我要封的这条，是不是把管理员自己
 * 也圈进去了"——`10.0.0.5` 与 `10.0.0.0/24` 的关系，只有位运算能算对。
 */
function covers(spec, ip) {
  const rule = parseRule(spec);
  const info = ipToInt(ip);
  if (!rule || !info) return false;
  return inRule(rule, info);
}

// ==================================================================
// 白名单
// ==================================================================

let whitelistCache = null;

function whitelistRules() {
  if (!whitelistCache) {
    const extra = String(process.env.IP_BAN_WHITELIST || '')
      .split(',').map((x) => x.trim()).filter(Boolean);
    whitelistCache = BUILTIN_WHITELIST.concat(extra).map(parseRule).filter(Boolean);
    if (extra.length) log.info('ipban', `白名单额外加载 ${extra.length} 条自定义规则`);
  }
  return whitelistCache;
}

/** 是否白名单地址（白名单永不被封，也不计入命中） */
function isWhitelisted(ip) {
  const info = ipToInt(ip);
  if (!info) return false;
  return whitelistRules().some((r) => inRule(r, info));
}

// ==================================================================
// 存储与判定
// ==================================================================

let cache = null;
/** 规则解析缓存：`check()` 在每个请求上都会跑，别每次重解 128 位 BigInt */
let ruleCache = new Map();

function all() {
  if (!cache) {
    const d = readJson(KEY, {});
    cache = (d && typeof d === 'object') ? d : {};
  }
  return cache;
}

function persist() { writeJson(KEY, all()); }

function ruleOf(key) {
  if (!ruleCache.has(key)) ruleCache.set(key, parseRule(key));
  return ruleCache.get(key);
}

/** 命中计数落盘的节流间隔：高频请求下不能每个请求都写一次库 */
const HIT_PERSIST_MS = 5000;

/**
 * 判断某 IP 是否被封。
 *
 * ⚠️ **过期判定放在比对时**（而不是等定时清理）：定时器可能还没跑到，
 * 而封禁到期必须**立刻**失效——否则用户会看到"明明到期了还是进不来"。
 *
 * @returns {{banned:boolean, record?:object}}
 */
function check(ip, now = Date.now()) {
  const info = ipToInt(ip);
  if (!info) return { banned: false };
  if (isWhitelisted(ip)) return { banned: false };

  const bans = all();
  for (const rec of Object.values(bans)) {
    if (rec.expiresAt && rec.expiresAt <= now) continue; // 已过期 → 放行
    if (!inRule(ruleOf(rec.ip), info)) continue;

    // 命中计数：用来判断"这条封禁到底有没有用"（后台看得到）
    const shouldPersist = !rec.lastHitAt || (now - rec.lastHitAt) > HIT_PERSIST_MS;
    rec.hits = (rec.hits || 0) + 1;
    rec.lastHitAt = now;
    if (shouldPersist) persist();
    return { banned: true, record: rec };
  }
  return { banned: false };
}

// ==================================================================
// 管理操作
// ==================================================================

/**
 * 封禁（可传 IP 或网段）。
 * @param {string} spec
 * @param {{reason:string, hours?:number|null, byId?:string}} opts `hours` 缺省 = 24；`null` = 永久
 */
function ban(spec, opts) {
  const o = opts || {};
  const rule = parseRule(spec);
  if (!rule) return { ok: false, error: 'IP 或网段格式不正确' };

  const reason = String(o.reason || '').trim();
  if (!reason) return { ok: false, error: '必须填写封禁理由' };
  if (reason.length > 200) return { ok: false, error: '理由过长（最多 200 字）' };

  const hours = o.hours === undefined ? 24 : o.hours;
  if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) {
    return { ok: false, error: '封禁时长不合法' };
  }
  // 白名单段不允许封（否则会把内网/监控一起关掉，且这类封禁"看起来生效了"其实没生效）
  if (isWhitelisted(rule.key.split('/')[0])) {
    return { ok: false, error: '该地址在内网/白名单段内，不能封禁' };
  }

  const now = Date.now();
  const rec = {
    ip: rule.key,
    reason,
    bannedById: o.byId || null,
    bannedAt: now,
    expiresAt: hours === null ? null : now + hours * 3600 * 1000,
    hits: 0,
    lastHitAt: null,
  };
  all()[rule.key] = rec;
  ruleCache.delete(rule.key); // key 本身没变，但保险起见清一下
  persist();
  log.info('ipban', `已封禁 ${rule.key}`, {
    reason, hours: hours === null ? 'forever' : hours, by: o.byId || '-',
  });
  return { ok: true, record: rec };
}

function unban(spec) {
  const rule = parseRule(spec);
  if (!rule) return { ok: false, error: 'IP 或网段格式不正确' };
  const bans = all();
  if (!bans[rule.key]) return { ok: false, error: '该 IP 未被封禁' };
  delete bans[rule.key];
  persist();
  log.info('ipban', `已解封 ${rule.key}`);
  return { ok: true, ip: rule.key };
}

/** 延长封禁：在原到期时间上叠加；已是永久则拒绝（无意义） */
function extend(spec, hours) {
  const rule = parseRule(spec);
  if (!rule) return { ok: false, error: 'IP 或网段格式不正确' };
  const rec = all()[rule.key];
  if (!rec) return { ok: false, error: '该 IP 未被封禁' };
  if (!Number.isFinite(hours) || hours <= 0) return { ok: false, error: '时长不合法' };
  if (rec.expiresAt === null) return { ok: false, error: '已是永久封禁，无需延长' };

  rec.expiresAt += hours * 3600 * 1000;
  // 已过期又延长 → 从当前时刻重新算，否则"延长了却仍是过去时间"，用户看着像没生效
  if (rec.expiresAt <= Date.now()) rec.expiresAt = Date.now() + hours * 3600 * 1000;
  persist();
  log.info('ipban', `已延长 ${rule.key}`, { hours });
  return { ok: true, record: rec };
}

/** 列表（带生效状态，后台直接渲染） */
function list(now = Date.now()) {
  return Object.values(all()).map((r) => Object.assign({}, r, {
    active: !r.expiresAt || r.expiresAt > now,
    permanent: !r.expiresAt,
  })).sort((a, b) => (b.bannedAt || 0) - (a.bannedAt || 0));
}

/**
 * 清理"已过期且过了保留期"的记录（由定时任务调用，纯打扫）。
 * ⚠️ 它**不承担**"让封禁失效"的职责——那由 `check()` 按 `expiresAt` 实时判定，
 * 所以即使这个函数从没跑过，封禁该失效时也会失效。
 */
function pruneExpired(now = Date.now(), keepMs = 7 * 24 * 3600 * 1000) {
  const bans = all();
  let n = 0;
  for (const [k, r] of Object.entries(bans)) {
    if (r.expiresAt && (r.expiresAt + keepMs) < now) { delete bans[k]; n++; }
  }
  if (n) { persist(); log.info('ipban', `清理 ${n} 条过期已久的封禁记录`); }
  return n;
}

/** 仅测试用：丢掉内存缓存，模拟"进程重启后从库里重新读" */
function _resetCache() {
  cache = null;
  ruleCache = new Map();
  whitelistCache = null;
}

module.exports = {
  DURATIONS,
  check, ban, unban, extend, list, pruneExpired, isWhitelisted,
  parseRule, covers, _resetCache,
};
