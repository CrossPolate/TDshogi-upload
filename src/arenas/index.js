'use strict';

/**
 * arenas/ — Arena-lite（1.8）：时间窗口内自由加入，按积分反复配对。
 *
 * 设计取舍：
 *  - 不做 berserk / 连麦 / 固定轮次；每个窗口只做「加入 → 按积分相邻配对 → 结算 → 再配对」。
 *  - 只给**在线且空闲**的选手配对，避免产生无人认领的幽灵对局；
 *    离线选手保留积分与参赛资格，回来后进入下一轮。
 *  - 对局复用 rooms 的赛事房创建路径，结果由 rooms 终局回调写入。
 *  - 对局固定 10 分钟包干、不计 ELO（与赛事一致）。
 */
const crypto = require('crypto');
const ratings = require('../ratings');
const { TIME_CONTROLS } = require('../rooms/config');
const store = require('./store');

const ROUND_MINUTES = [3, 5, 10, 15];
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const ARENA_TIME_CONTROLS = ['10:00', '10+30', '15+60', '10sec'];
const DEFAULT_ARENA_TIME_CONTROL = '10:00';

const STATUS_LABELS = {
  open: '报名中',
  running: '进行中',
  finished: '已结束',
  cancelled: '已取消',
};

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function statusOf(a, now = Date.now()) {
  if (a.status === 'open' && now >= a.startsAt) return now >= a.endsAt ? 'finished' : 'running';
  if (a.status === 'running' && now >= a.endsAt) return 'finished';
  return a.status;
}

function create(owner, { name, startsAt, endsAt, roundMinutes, timeControl } = {}) {
  if (!owner || !owner.id) return { ok: false, code: 'AUTH', error: '需要登录账号' };
  if (!ratings.hasPrivilege(owner.id, 'create_tournament')) {
    const need = ratings.LEVEL_PRIVILEGES.create_tournament;
    return {
      ok: false, code: 'LEVEL_REQUIRED', needLevel: need,
      error: `创建竞技场需要 Lv.${need}（你当前 Lv.${ratings.levelOf(owner.id)}）`,
    };
  }
  const title = String(name || '').trim().slice(0, 20);
  if (!title) return { ok: false, error: '请填写竞技场名称' };
  const start = num(startsAt);
  const end = num(endsAt);
  const now = Date.now();
  if (!start || !end) return { ok: false, error: '请选择开始与结束时间' };
  if (start < now - 60 * 1000) return { ok: false, error: '开始时间不能早于当前时间' };
  if (start > now + MAX_AHEAD_MS) return { ok: false, error: '开始时间最多提前 7 天' };
  if (end <= start) return { ok: false, error: '结束时间必须晚于开始时间' };
  if (end - start > MAX_DURATION_MS) return { ok: false, error: '竞技场最长 12 小时' };
  const minutes = Math.round(num(roundMinutes));
  if (!ROUND_MINUTES.includes(minutes)) return { ok: false, error: '配对间隔只能选 3/5/10/15 分钟' };
  const tc = timeControl == null ? DEFAULT_ARENA_TIME_CONTROL : String(timeControl);
  if (!ARENA_TIME_CONTROLS.includes(tc)) return { ok: false, error: '不支持该对局时制' };

  const arenas = store.getCache();
  const id = genId().slice(0, 8);
  arenas[id] = {
    id,
    name: title,
    ownerId: owner.id,
    ownerName: String(owner.name || '').slice(0, 20) || null,
    status: 'open',
    startsAt: start,
    endsAt: end,
    roundMinutes: minutes,
    roundEveryMs: minutes * 60 * 1000,
    timeControl: tc,
    entries: {},
    rounds: [],
    currentRound: 0,
    lastRoundAt: null,
    championId: null,
    championName: null,
    createdAt: now,
    startedAt: null,
    endedAt: null,
  };
  store.persist();
  return { ok: true, arena: publicInfo(arenas[id]) };
}

function join(arenaId, player) {
  const a = store.getCache()[arenaId];
  if (!a) return { ok: false, error: '竞技场不存在' };
  const now = Date.now();
  const status = statusOf(a, now);
  if (status === 'finished' || status === 'cancelled') return { ok: false, error: '竞技场已结束' };
  if (!player || !player.id) return { ok: false, code: 'AUTH', error: '需要登录账号' };
  const existing = a.entries[player.id];
  if (existing && !existing.withdrawnAt) return { ok: false, error: '你已经加入该竞技场' };
  const entry = existing || {
    id: player.id, name: String(player.name || player.id).slice(0, 20),
    joinedAt: now, score: 0, games: 0, wins: 0, draws: 0, losses: 0, byes: 0, roomId: null, withdrawnAt: null,
  };
  entry.name = String(player.name || entry.name || player.id).slice(0, 20);
  entry.withdrawnAt = null;
  a.entries[player.id] = entry;
  store.persist();
  return { ok: true, arena: detail(a, player.id) };
}

function leave(arenaId, playerId) {
  const a = store.getCache()[arenaId];
  if (!a) return { ok: false, error: '竞技场不存在' };
  const e = a.entries[playerId];
  if (!e || e.withdrawnAt) return { ok: false, error: '你还没有加入该竞技场' };
  if (e.roomId && store.isRoomActive(e.roomId)) {
    return { ok: false, error: '对局进行中不能退出，请先完成本局或认输' };
  }
  e.withdrawnAt = Date.now();
  e.roomId = null;
  // 空竞技场不保留在“进行中”列表：超时结束由调度器统一处理
  store.persist();
  return { ok: true };
}

function cancel(arenaId, actorId) {
  const a = store.getCache()[arenaId];
  if (!a) return { ok: false, error: '竞技场不存在' };
  if (a.ownerId !== actorId) return { ok: false, code: 'FORBIDDEN', error: '只有主办人能取消竞技场' };
  if (a.status === 'finished' || a.status === 'cancelled') return { ok: false, error: '竞技场已结束' };
  a.status = 'cancelled';
  a.endedAt = Date.now();
  store.persist();
  return { ok: true };
}

/** 管理员取消：不要求主办人身份，用于主办人失联或违规场次。 */
function adminCancel(arenaId) {
  const a = store.getCache()[arenaId];
  if (!a) return { ok: false, error: '竞技场不存在' };
  if (a.status === 'finished' || a.status === 'cancelled') return { ok: false, error: '竞技场已结束' };
  a.status = 'cancelled';
  a.endedAt = Date.now();
  store.persist();
  return { ok: true, arena: publicInfo(a) };
}

function standings(a) {
  return Object.values(a.entries)
    .filter((e) => !e.withdrawnAt)
    .sort((x, y) => y.score - x.score || y.wins - x.wins || (x.byes || 0) - (y.byes || 0) || x.joinedAt - y.joinedAt)
    .map((e, i) => ({
      rank: i + 1, id: e.id, name: e.name,
      score: e.score, games: e.games, wins: e.wins, draws: e.draws, losses: e.losses, byes: e.byes || 0,
    }));
}

function publicInfo(a) {
  const list = standings(a);
  const status = statusOf(a);
  return {
    id: a.id, name: a.name, ownerId: a.ownerId, ownerName: a.ownerName,
    status, statusLabel: STATUS_LABELS[status] || status,
    startsAt: a.startsAt, endsAt: a.endsAt,
    roundMinutes: a.roundMinutes,
    timeControl: a.timeControl,
    timeControlName: (TIME_CONTROLS[a.timeControl] || TIME_CONTROLS[DEFAULT_ARENA_TIME_CONTROL]).name,
    nextRoundAt: status === 'running' ? ((a.lastRoundAt || Date.now()) + a.roundEveryMs) : null,
    currentRound: a.currentRound, entryCount: list.length,
    top: list.slice(0, 3),
    champion: a.championId ? { id: a.championId, name: a.championName } : null,
  };
}

function detail(a, viewerId = null) {
  const info = publicInfo(a);
  const rounds = a.rounds.slice(-30).map((rd) => ({
    round: rd.round,
    at: rd.at,
    bye: rd.bye ? (a.entries[rd.bye] ? a.entries[rd.bye].name : rd.bye) : null,
    pairs: rd.pairs.map((p) => ({
      a: a.entries[p.a] ? a.entries[p.a].name : p.a,
      b: a.entries[p.b] ? a.entries[p.b].name : p.b,
      roomId: p.roomId || null,
      winner: p.winner || null,
      winnerName: p.winner && p.winner !== '-' && a.entries[p.winner] ? a.entries[p.winner].name : (p.winner === '-' ? '和棋' : null),
      scored: !!p.scored,
    })),
  }));
  const me = viewerId && a.entries[viewerId]
    ? { ...a.entries[viewerId], inMatch: !!(a.entries[viewerId].roomId && store.isRoomActive(a.entries[viewerId].roomId)) }
    : null;
  return { ...info, entries: standings(a), rounds, me, canManage: !!(viewerId && viewerId === a.ownerId) };
}

function list(viewerId = null) {
  return Object.values(store.getCache())
    .map((a) => publicInfo(a))
    .sort((x, y) => {
      const rank = (s) => (s === 'running' ? 0 : s === 'open' ? 1 : s === 'finished' ? 2 : 3);
      return rank(x.status) - rank(y.status) || x.startsAt - y.startsAt;
    })
    .map((x) => ({
      ...x,
      joined: !!(viewerId && store.getCache()[x.id] && store.getCache()[x.id].entries[viewerId] && !store.getCache()[x.id].entries[viewerId].withdrawnAt),
      mine: !!(viewerId && store.getCache()[x.id] && store.getCache()[x.id].ownerId === viewerId),
    }));
}

function hasActiveRoom(e) {
  if (!e.roomId) return false;
  if (store.isRoomActive && store.isRoomActive(e.roomId)) return true;
  e.roomId = null; // 房间已结束/丢失，释放选手参加下一轮
  return false;
}

/** 生成一轮对阵；返回是否真的产生了对局。 */
function runRound(a, now) {
  const pool = Object.values(a.entries)
    .filter((e) => !e.withdrawnAt
      && store.onlineChecker(e.id)
      && store.availabilityChecker(e.id)
      && !hasActiveRoom(e))
    .sort((x, y) => y.score - x.score || y.wins - x.wins || x.joinedAt - y.joinedAt);
  if (pool.length < 2) return false;

  // 尽量避免连续两轮撞同一对手：相邻配对若已交过手，尝试与下一组交换一人。
  const met = new Set();
  for (const rd of a.rounds) for (const p of rd.pairs) met.add([p.a, p.b].sort().join('|'));
  const metPair = (x, y) => met.has([x.id, y.id].sort().join('|'));

  const pairs = [];
  for (let i = 0; i + 1 < pool.length; i += 2) {
    if (i + 2 < pool.length && metPair(pool[i], pool[i + 1])) {
      const a = pool[i];
      const b = pool[i + 1];
      const c = pool[i + 2];
      const d = pool[i + 3];
      if (!metPair(a, c) && (!d || !metPair(b, d))) {
        pool[i + 1] = c;
        pool[i + 2] = b;
      }
    }
    const p1 = pool[i];
    const p2 = pool[i + 1];
    met.add([p1.id, p2.id].sort().join('|'));
    const created = store.matchFactory ? store.matchFactory(a.id, [p1.id, p2.id], a.timeControl) : null;
    const roomId = created && created.roomId ? created.roomId : null;
    if (roomId) { p1.roomId = roomId; p2.roomId = roomId; }
    pairs.push({ a: p1.id, b: p2.id, roomId, winner: null, scored: false });
    if (roomId && store.notifyFn) {
      const data = { arenaId: a.id, round: a.currentRound + 1, roomId };
      store.notifyFn(p1.id, { type: 'arena_round_started', data });
      store.notifyFn(p2.id, { type: 'arena_round_started', data });
    }
  }
  if (!pairs.length) return false;
  // 交换配对后末尾的人才是本轮轮空者。
  const byeId = pool.length % 2 ? pool[pool.length - 1].id : null;

  a.currentRound = (a.currentRound || 0) + 1;
  a.rounds.push({ round: a.currentRound, at: now, pairs, bye: byeId });
  if (byeId && a.entries[byeId]) a.entries[byeId].byes = (a.entries[byeId].byes || 0) + 1;
  if (a.rounds.length > 300) a.rounds.shift();
  return true;
}

function finish(a, now) {
  a.status = 'finished';
  a.endedAt = now;
  const top = standings(a)[0];
  a.championId = top ? top.id : null;
  a.championName = top ? top.name : null;
}

/** 调度节拍：状态推进 + 到期开新轮。`now` 可注入，便于测试。 */
function tick(now = Date.now()) {
  let changed = false;
  for (const a of Object.values(store.getCache())) {
    if (a.status === 'open' && now >= a.startsAt) {
      a.status = 'running';
      a.startedAt = now;
      changed = true;
    }
    if (a.status !== 'running') continue;
    if (now >= a.endsAt) {
      finish(a, now);
      changed = true;
      continue;
    }
    // 首轮在人数不足时**不锁死** lastRoundAt：每 15 秒重试，等第二个人进来立刻配对。
    if (a.lastRoundAt == null) {
      if (runRound(a, now)) {
        a.lastRoundAt = now;
        changed = true;
      }
    } else if (now - a.lastRoundAt >= a.roundEveryMs) {
      runRound(a, now);
      a.lastRoundAt = now;
      changed = true;
    }
  }
  if (changed) store.persist();
  return changed;
}

/** rooms 终局回调：按 roomId 找到对阵并结算；重复调用幂等。 */
function onMatchFinished(arenaId, roomId, winnerId) {
  const a = store.getCache()[arenaId];
  if (!a) return { ok: false, error: '竞技场不存在' };
  for (let i = a.rounds.length - 1; i >= 0; i -= 1) {
    const pair = a.rounds[i].pairs.find((p) => p.roomId === roomId);
    if (!pair) continue;
    if (pair.scored) return { ok: true, duplicate: true };
    pair.scored = true;
    pair.winner = winnerId;
    const ea = a.entries[pair.a];
    const eb = a.entries[pair.b];
    if (!ea || !eb) return { ok: false, error: '参赛者数据缺失' };
    ea.games += 1;
    eb.games += 1;
    if (winnerId === pair.a) {
      ea.score += 1; ea.wins += 1; eb.losses += 1;
    } else if (winnerId === pair.b) {
      eb.score += 1; eb.wins += 1; ea.losses += 1;
    } else {
      ea.score += 0.5; eb.score += 0.5; ea.draws += 1; eb.draws += 1;
    }
    ea.roomId = null;
    eb.roomId = null;
    store.persist();
    return { ok: true };
  }
  return { ok: false, error: '未找到对应轮次' };
}

let schedulerTimer = null;

function startScheduler({ notify = null, isOnline = null, isRoomActive = null, intervalMs = 15000 } = {}) {
  if (typeof notify === 'function') store.setNotifyFn(notify);
  if (typeof isOnline === 'function') store.setOnlineChecker(isOnline);
  if (typeof isRoomActive === 'function') store.setRoomActiveChecker(isRoomActive);
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    try { tick(); } catch (_) { /* 调度失败下一拍重试 */ }
  }, Math.max(3000, Number(intervalMs) || 15000));
  if (schedulerTimer.unref) schedulerTimer.unref();
}

function stopScheduler() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

function getArena(id) {
  return store.getCache()[id] || null;
}

// rooms 在构造时注入：建房工厂 / 空闲检查 / 房间状态查询（回调归 rooms 所有）。
function setMatchFactory(fn) { store.setMatchFactory(fn); }
function setAvailabilityChecker(fn) { store.setAvailabilityChecker(fn); }
function setRoomActiveChecker(fn) { store.setRoomActiveChecker(fn); }

module.exports = {
  ROUND_MINUTES,
  ARENA_TIME_CONTROLS,
  DEFAULT_ARENA_TIME_CONTROL,
  STATUS_LABELS,
  create,
  join,
  leave,
  cancel,
  adminCancel,
  list,
  detail,
  publicInfo,
  standings,
  tick,
  runRound,
  onMatchFinished,
  startScheduler,
  stopScheduler,
  getArena,
  setMatchFactory,
  setAvailabilityChecker,
  setRoomActiveChecker,
};
