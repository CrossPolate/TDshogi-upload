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

const START_RATING = 1500;
const K = 32;

function defaultRating() {
  return {
    rating: START_RATING,
    games: 0,     // 总对局数
    wins: 0,
    losses: 0,
    draws: 0,
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

function getCache() {
  if (!cache) cache = loadRatings();
  return cache;
}

function persist() {
  writeJson('ratings.json', getCache());
}

/** 强制刷新内存缓存（账号迁移游客数据后调用） */
function refreshCache() {
  cache = loadRatings();
}

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
  b.rating = Math.round(rB + K * (scoreB - eB));
  a.games++; b.games++;
  if (winner === 'b') a.wins++, b.losses++;
  else if (winner === 'w') a.losses++, b.wins++;
  else { a.draws++; b.draws++; }

  const now = Date.now();
  a.history.push({ t: now, rating: a.rating });
  b.history.push({ t: now, rating: b.rating });

  persist();
  return { deltaA: a.rating - rA, deltaB: b.rating - rB };
}

/**
 * 排行榜（按 ELO 降序），limit 控制条数。
 * 附带该玩家自身信息（含排名），用于首页"自己高亮"。
 */
function leaderboard(playerId, limit = 10) {
  const ratings = getCache();
  const withName = (e) => {
    const s = auth.load(e.id);
    e.name = s ? s.name : e.id;
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
    .sort((x, y) => y.rating - x.rating)
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

/** 管理员直接编辑 ELO / 经验（等级随经验自动推导） */
function adminSetPlayer(playerId, { rating, exp } = {}) {
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
  const games = r.games;
  const winRate = games ? Math.round((r.wins / games) * 100) : 0;
  return {
    rating: r.rating,
    games,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
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
  for (const s of sessions) {
    // 没下过棋的纯会话用户也要有完整字段（否则前端显示 ELO undefined）
    map.set(s.id, {
      id: s.id, name: s.name, title: s.title || '', lastSeen: s.lastSeen, createdAt: s.createdAt,
      isAccount: isAccountFn ? isAccountFn(s.id) : false,
      lastIp: (s.net && s.net.lastIp) || null,
      banned: !!s.banned,
      rating: defaultRating().rating, games: 0, wins: 0, losses: 0, draws: 0, winRate: 0,
      exp: 0, level: 0,
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
  addExp,
  adminSetPlayer,
  applyGameResult,
  leaderboard,
  profile,
  allUsers,
  resetPlayer,
  removePlayer,
  getCache,
  persist,
  refreshCache,
};
