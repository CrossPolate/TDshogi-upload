// @ts-check
/**
 * ratings.js — ELO 评级系统（参考 81Dojo 的 R300 评级形态）
 *
 * 人人对战计入积分：
 *  - 起始 1500，K=32
 *  - 胜 R' = R + K×(1-E)，负 R' = R + K×(0-E)，平各 0.5
 *  - E = 1/(1+10^((Rb-Ra)/400))
 *
 * 数据以 ratings.json 落盘，内存缓存避免频繁 I/O。
 */
'use strict';

const { readJson, writeJson } = require('./storage');
const auth = require('./auth');
const log = require('./logger');

const START_RATING = 1500;
const K = 32;

function defaultRating() {
  return {
    rating: START_RATING,
    games: 0,     // 总对局数
    wins: 0,
    losses: 0,
    draws: 0,
    points: 0,    // 积分（F1）：与 ELO 独立，每完成一局 +1
    exp: 0,       // 等级经验（PLAN §K7）
    level: 0,     // 等级（由 exp 推导，冗余存储便于查询/编辑）
    // 历史采样点（供个人页 ELO 走势图）：[{t, rating}]
    history: [],
  };
}

/**
 * 加载全部评级表（内存缓存）。
 */
function loadRatings() {
  const data = readJson('ratings.json', {});
  if (!data || typeof data !== 'object') return {};
  return data;
}

let cache = null;

/** history 采样点保留上限（§5.1：无界增长会让单文件体积与读写放大随时间恶化） */
const HISTORY_CAP = 200;

/**
 * F1 兼容回填：老库没有 `points` 字段（该字段晚于既有数据）。按历史局数近似回填
 * （每完成一局 +1），**幂等**——已存在的值不动。返回是否发生了改动。
 */
function backfillPoints(data) {
  let changed = false;
  for (const r of Object.values(data || {})) {
    if (r && typeof r === 'object' && r.points == null) { r.points = r.games || 0; changed = true; }
  }
  return changed;
}

/** 惰性裁剪 history（读/写时顺手做，避免老数据无界） */
function trimHistory(r) {
  if (r && Array.isArray(r.history) && r.history.length > HISTORY_CAP) {
    r.history = r.history.slice(-HISTORY_CAP);
    return true;
  }
  return false;
}

function getCache() {
  if (!cache) {
    cache = loadRatings();
    if (backfillPoints(cache)) persist();
  }
  return cache;
}

/* ---------------- 落盘策略（§5.1：去抖合并写） ----------------
 * 原先每次改动都同步把整张表写回（写放大：一局结束改两个玩家 = 多次整表写）。
 * 现改为「前沿写 + 收尾写」的去抖：
 *   - 前沿写：一个改动窗口的**第一次**立即落盘（保证"改完即有"）；
 *   - 收尾写：窗口内的后续改动合并到窗口末尾再写一次；
 *   - flush()：显式立即落盘（关键点 / 进程退出前调用）。
 */
const PERSIST_DEBOUNCE_MS = 1000;
let persistTimer = null;
let pendingWrite = false;

function _writeNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  pendingWrite = false;
  // ⚠️ 2026-10-04：writeJson 失败会记日志并返回 false——这里补记一条业务上下文，
  // 便于把"评级表没落盘"与别的写失败区分开（不抛，保持既有容错语义）。
  if (!writeJson('ratings.json', getCache())) {
    log.error('ratings', '评级表落盘失败', { file: 'ratings.json' });
  }
}

function persist() {
  if (persistTimer) { pendingWrite = true; return; } // 窗口内：合并到收尾写
  _writeNow();                                       // 前沿写
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (pendingWrite) _writeNow();
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer && persistTimer.unref) persistTimer.unref();
}

/** 立即落盘（关键点 / 进程退出前）——等待中的去抖写会被一并写出。 */
function flush() { _writeNow(); }

/**
 * 以**磁盘为权威**重新加载内存缓存。
 *
 * ⚠️ 契约（§5.1，务必遵守）：本函数会**丢弃内存中尚未落盘的改动**。调用前必须确保内存改动
 * 已落盘（先 `flush()`），否则会静默丢数据。当前唯一生产调用点 `accounts.migrateGuestData`
 * 走的是"先 flush()、再直接写盘、再 refreshCache()"，符合该契约。
 */
function refreshCache() {
  cache = loadRatings();
  if (backfillPoints(cache)) persist();
}

// 进程退出兜底：把等待中的去抖写落盘，避免"改了没写"（writeJson 为同步实现）。
process.on('exit', () => { try { if (persistTimer || pendingWrite) _writeNow(); } catch (_) {} });

function ensurePlayer(ratings, playerId) {
  if (!ratings[playerId]) ratings[playerId] = defaultRating();
  return ratings[playerId];
}

function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

/**
 * 记录一局结果并更新双方评级。
 * @param {string} playerA 先手 id
 * @param {string} playerB 后手 id
 * @param {'b'|'w'|'-'} winner 胜者；b=先手 w=后手 -=平
 */
function applyGameResult(playerA, playerB, winner) {
  const ratings = getCache();
  const a = ensurePlayer(ratings, playerA);
  const b = ensurePlayer(ratings, playerB);

  const rA = a.rating;
  const rB = b.rating;
  const scoreA = winner === 'b' ? 1 : winner === '-' ? 0.5 : 0;
  const scoreB = 1 - scoreA;

  const eA = expectedScore(rA, rB);
  const eB = expectedScore(rB, rA);

  a.rating = Math.round(rA + K * (scoreA - eA));
  // 零和：B 的增量取 A 实际增量的相反数。两次独立 Math.round 会让 rA+rB 产生 ±1 漂移
  // （同一局双方分数和随之变动），这里以 A 的结果为准反推 B，保证总和恒为 rA+rB。
  b.rating = rB - (a.rating - rA);
  a.games++; b.games++;
  if (winner === 'b') a.wins++, b.losses++;
  else if (winner === 'w') a.losses++, b.wins++;
  else { a.draws++; b.draws++; }

  const now = Date.now();
  a.history.push({ t: now, rating: a.rating });
  b.history.push({ t: now, rating: b.rating });
  trimHistory(a); trimHistory(b); // §5.1：history 有上界

  persist();
  return { deltaA: a.rating - rA, deltaB: b.rating - rB };
}

/**
 * 排行榜（按 ELO 降序），limit 控制条数。
 * 附带该玩家自身信息（含排名），用于首页"自己高亮"。
 */
/* ---------------- 会话名缓存（§5.2：排行榜/用户列表不再逐条落盘读） ---------------- */
const SESSION_CACHE_TTL_MS = 5000;
let _sessionCache = null;
let _sessionCacheAt = 0;

/** 批量取"id → 名字"（进程内缓存 5s）。写点应调用 invalidateSessionCache() 以求强一致。 */
function sessionNameMap() {
  const now = Date.now();
  if (_sessionCache && (now - _sessionCacheAt) < SESSION_CACHE_TTL_MS) return _sessionCache;
  const m = new Map();
  try { for (const s of auth.listSessions()) m.set(s.id, s.name); } catch (_) {}
  _sessionCache = m; _sessionCacheAt = now;
  return m;
}

/** 使会话名缓存失效（改名/迁移/封禁等写点调用） */
function invalidateSessionCache() { _sessionCache = null; }

function leaderboard(playerId, limit = 10) {
  const ratings = getCache();
  const names = sessionNameMap();
  const withName = (e) => {
    e.name = names.has(e.id) ? names.get(e.id) : e.id;
    return e;
  };
  const entries = Object.entries(ratings)
    .filter(([, r]) => r.games > 0)
    .map(([id, r]) => ({
      id,
      rating: r.rating,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
    }))
    // 确定性 tiebreak：rating↓ → games↓ → wins↓ → id↑（否则同分名次随对象键序漂移、不稳定）
    .sort((x, y) => y.rating - x.rating || y.games - x.games || y.wins - x.wins
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map(withName);

  const top = entries.slice(0, limit);
  let self = null;
  if (playerId) {
    const idx = entries.findIndex((e) => e.id === playerId);
    if (idx >= 0) {
      self = { ...withName({ ...entries[idx] }), rank: idx + 1 };
    }
  }
  return { list: top, self };
}

// ---------------- 等级系统（PLAN §K7：EXP / Level）----------------
// 规则（用户暂定 2026-09-05）：
//   - 每日登录 +2、完成一局 +1
//   - 从 L 级升到 L+1 级需要 2^(L+1) 经验（0→1:2、1→2:4、2→3:8 …）
//     即升到 L 级的累计经验 = 2^(L+1) - 2
//   - 最高 64 级（名义上限）
//
// 溢出分析（用户问「会不会溢出？」）：
//   - exp 是累计获得量，正常玩家远小于 2^53（Number.MAX_SAFE_INTEGER ≈ 9e15），
//     本身不会溢出；
//   - 升级需求 2^(L+1) 在 L ≥ 51 时超出安全整数精度，但 Number 仍可**表示**
//     到 ~1.8e308，比较 `exp >= 2^(L+1)` 的结果依然正确（exp 恒小于它）；
//   - 真正的问题是设计上的：升满 64 级累计需 2^65-2 ≈ 3.7e19 经验——
//     按每日 +2 要 5e16 天，等于永远满不了级。64 级因此是名义封顶，
//     若想要「摸得着」的满级，改用低增长曲线（如 1.1 倍）或降低 MAX_LEVEL 即可。
const MAX_LEVEL = 64;

/** 由累计经验推导等级：L = floor(log2(exp+2)) - 1，clamp 到 [0, 64] */
function levelFromExp(exp) {
  const e = Math.max(0, Math.floor(Number(exp) || 0));
  const l = Math.floor(Math.log2(e + 2)) - 1;
  return Math.min(MAX_LEVEL, Math.max(0, l));
}

/** 升到 level+1 级需要的累计经验 = 2^(level+2) - 2 */
function nextLevelExp(level) {
  return Math.pow(2, Math.min(level + 1, MAX_LEVEL) + 1) - 2;
}

/**
 * 等级特权表（2026-09-20 用户要求：「等级 5 才能举办赛事」）。
 *
 * ⚠️ 这是**全项目唯一的特权门槛表**：要加新特权就往这里加一行，
 * **不要**在业务模块里散写 `level >= 5`——门槛一旦散落多处，
 * 改门槛时必然漏掉一处（`canManage`/`ACTION_ROLES` 已经立过这个规矩）。
 *
 * 数值含义：所需**等级**（0 = 无门槛）。等级由经验推导，见 `levelFromExp`。
 */
const LEVEL_PRIVILEGES = {
  create_tournament: 5,   // 举办赛事
};

/** 只读等级（不构造完整 profile，避免为了拿个数字连带算 history） */
function levelOf(playerId) {
  const r = playerId ? getCache()[playerId] : null;
  return levelFromExp((r && r.exp) || 0);
}

/**
 * 某玩家是否拥有该特权。
 * 未在 `LEVEL_PRIVILEGES` 里定义的门槛 = **不限制**（新特权默认放开，避免悄悄拦住老功能）。
 *
 * @returns {boolean}
 */
function hasPrivilege(playerId, privilege) {
  const need = LEVEL_PRIVILEGES[privilege];
  if (need == null) return true;
  return levelOf(playerId) >= need;
}

/**
 * 某玩家的全部特权状态（下发给前端展示用）。
 *
 * ⚠️ 从 `LEVEL_PRIVILEGES` 表**推导**，不是另抄一份门槛数值——
 * 前端要显示"需要 Lv.5"时，抄一份就等于把门槛写死在两个地方，
 * 改门槛时必然出现"服务端放行了但按钮还是灰的"。
 *
 * @returns {Record<string, {need:number, ok:boolean}>}
 */
function privilegesOf(playerId) {
  const lv = levelOf(playerId);
  /** @type {Record<string, {need:number, ok:boolean}>} */
  const out = {};
  for (const [key, need] of Object.entries(LEVEL_PRIVILEGES)) {
    out[key] = { need, ok: lv >= need };
  }
  return out;
}

/**
 * 增加经验并结算等级。
 * @param {string} playerId
 * @param {number} amount 正整数
 * @param {string} reason 'daily-login' | 'game' | ...
 */
function addExp(playerId, amount, reason = '') {
  if (!playerId || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: '经验参数无效' };
  const ratings = getCache();
  const r = ensurePlayer(ratings, playerId);
  const before = levelFromExp(r.exp || 0);
  r.exp = (r.exp || 0) + Math.floor(amount);
  r.level = levelFromExp(r.exp);
  persist();
  return { ok: true, exp: r.exp, level: r.level, leveledUp: r.level > before, reason };
}

/**
 * 增加积分（F1）：与 ELO **独立**的累计值，每完成一局 +1。
 *
 * 口径（与经验 `addExp` 一致）：胜/负/和、让子局、判负/弃权均计；「再来一局」每局各计 1。
 * ⚠️ 只在**服务端**累计（终局落谱链路 `rooms/gameplay._finalize`），前端只负责显示。
 *
 * @param {string} playerId
 * @param {number} [amount=1] 正整数
 * @returns {{ok:boolean, points?:number, error?:string}}
 */
function addPoints(playerId, amount = 1) {
  if (!playerId || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: '积分参数无效' };
  const r = ensurePlayer(getCache(), playerId);
  r.points = (r.points || 0) + Math.floor(amount);
  persist();
  return { ok: true, points: r.points };
}

/** 管理员直接编辑 ELO / 经验（等级随经验自动推导） */
function adminSetPlayer(playerId, /** @type {{rating?:number, exp?:number}} */ { rating, exp } = {}) {
  const ratings = getCache();
  const r = ratings[playerId] || defaultRating();
  if (rating !== undefined) {
    const v = Math.floor(Number(rating));
    if (!Number.isFinite(v) || v < 100 || v > 5000) return { ok: false, error: 'ELO 需在 100-5000 之间' };
    r.rating = v;
  }
  if (exp !== undefined) {
    const v = Math.floor(Number(exp));
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: '经验需为非负整数' };
    r.exp = v;
    r.level = levelFromExp(v);
  }
  ratings[playerId] = r;
  persist();
  return { ok: true, level: r.level };
}

/**
 * 个人评级与战绩统计。
 */
function profile(playerId) {
  const ratings = getCache();
  const r = ratings[playerId] || defaultRating();
  if (trimHistory(r)) persist(); // §5.1：读取时惰性裁剪老数据（有界化）
  const games = r.games;
  const winRate = games ? Math.round((r.wins / games) * 100) : 0;
  return {
    rating: r.rating,
    games,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
    points: r.points || 0,
    winRate,
    exp: r.exp || 0,
    level: levelFromExp(r.exp || 0),
    history: r.history.slice(-50),
  };
}

/**
 * 全部用户列表（管理员用）：合并评级 + 会话名。
 * 包含所有有评级记录或会话存在的用户（游客与账号都在，isAccount 区分）。
 * §K：附带最近 IP 与封禁标记（数据来自会话，仅经 adminUsersData 出口返回）。
 * §K7：附带等级 exp/level。
 */
function allUsers() {
  const ratings = getCache();
  const sessions = auth.listSessions();
  // 延迟 require 避免顶部循环依赖（accounts 内部对 ratings 也是延迟引用）
  let isAccountFn = null;
  try { const accounts = require('./accounts'); isAccountFn = (id) => !!accounts.getAccount(id); } catch (_) {}
  const map = new Map();
  for (const s of /** @type {any[]} */ (sessions)) {
    // 没下过棋的纯会话用户也要有完整字段（否则前端显示 ELO undefined）
    map.set(s.id, {
      id: s.id, name: s.name, title: s.title || '', lastSeen: s.lastSeen, createdAt: s.createdAt,
      isAccount: isAccountFn ? isAccountFn(s.id) : false,
      lastIp: (s.net && s.net.lastIp) || null,
      banned: !!s.banned,
      rating: defaultRating().rating, games: 0, wins: 0, losses: 0, draws: 0, winRate: 0,
      points: 0, exp: 0, level: 0,
    });
  }
  for (const [id, r] of Object.entries(ratings)) {
    const cur = map.get(id) || { id, name: id, title: '', lastSeen: null, createdAt: null, lastIp: null, banned: false, isAccount: isAccountFn ? isAccountFn(id) : false };
    cur.rating = r.rating;
    cur.games = r.games;
    cur.wins = r.wins;
    cur.losses = r.losses;
    cur.draws = r.draws;
    cur.winRate = r.games ? Math.round((r.wins / r.games) * 100) : 0;
    cur.points = r.points || 0;
    cur.exp = r.exp || 0;
    cur.level = levelFromExp(r.exp || 0);
    map.set(id, cur);
  }
  return [...map.values()].sort((a, b) => (b.games || 0) - (a.games || 0) || (b.lastSeen || 0) - (a.lastSeen || 0));
}

/** 重置某玩家 ELO 与战绩（管理员，PLAN §K3） */
function resetPlayer(playerId) {
  const ratings = getCache();
  if (!ratings[playerId]) return { ok: false, error: '该用户没有评级记录' };
  ratings[playerId] = defaultRating();
  persist();
  return { ok: true };
}

/** 删除某玩家的评级记录（删账号时用；无记录也视为成功） */
function removePlayer(playerId) {
  if (getCache()[playerId]) {
    delete getCache()[playerId];
    persist();
  }
  return { ok: true };
}

module.exports = {
  START_RATING,
  K,
  MAX_LEVEL,
  levelFromExp,
  nextLevelExp,
  // ---- 等级特权（2026-09-20）：门槛表与判定只有这一处 ----
  LEVEL_PRIVILEGES,
  levelOf,
  hasPrivilege,
  privilegesOf,
  addExp,
  addPoints,
  adminSetPlayer,
  applyGameResult,
  leaderboard,
  profile,
  allUsers,
  resetPlayer,
  removePlayer,
  getCache,
  persist,
  flush,
  refreshCache,
  sessionNameMap,
  invalidateSessionCache,
};
