'use strict';

/**
 * correspondence/ — 1.8 异步长局。
 *
 * 独立于实时 rooms：每步一个 deadline，状态全部落 corr_games；不常驻内存、不走 1 秒棋钟。
 * 玩家打开时才用 Game 重放局面；超时由 `sweepDue()` 扫描（server 定时调用）。
 */

const crypto = require('crypto');
const { Game, STARTING_SFEN } = require('../game');
const storage = require('../storage');

const DAY = 24 * 60 * 60 * 1000;
const TIME_OPTIONS = [1, 3, 7]; // 天/步
const RESULT_DETAIL = { resign: '投了', timeout: '時間切れ', agreedDraw: '合意', aborted: '中止' };

function legalTargetsBySq(game) {
  const map = {};
  for (const usi of game.legalMovesUsi()) {
    const drop = usi[1] === '*';
    const from = drop ? usi[0] : usi.slice(0, 2);
    const to = usi.slice(2, 4);
    (map[from] || (map[from] = [])).push({ to, usi, promote: usi.length === 5, drop });
  }
  return map;
}

function stateFor(g) {
  const game = new Game(g.startSfen || STARTING_SFEN);
  for (const m of g.moves || []) {
    const r = game.applyMove(m);
    if (!r.ok) throw new Error(`长局走法非法：${m}`);
  }
  const s = game.state();
  return {
    sfen: s.sfen,
    board: s.board,
    hands: s.hands,
    turn: s.turn,
    lastMove: s.lastMove,
    check: s.check,
    result: s.result,
    resultDetail: s.resultDetail,
    legalTargetsBySq: legalTargetsBySq(game),
    deadline: s.turn === 'b' ? g.deadlineB : g.deadlineW,
  };
}

function create({ creatorId, opponentId, timePerMoveMs, creatorSide = 'b', startSfen = STARTING_SFEN }) {
  if (!creatorId || !opponentId || creatorId === opponentId) return { ok: false, code: 'BAD_PLAYER', error: '对手不合法' };
  const ms = Math.floor(Number(timePerMoveMs));
  if (!Number.isFinite(ms) || ms < 60 * 1000 || ms > 30 * DAY) return { ok: false, code: 'BAD_TIME', error: '每步时限不合法' };
  const side = creatorSide === 'w' ? 'w' : 'b';
  const now = Date.now();
  const g = {
    id: `cg_${crypto.randomBytes(8).toString('hex')}`,
    startSfen,
    moves: [],
    playerB: side === 'b' ? creatorId : opponentId,
    playerW: side === 'w' ? creatorId : opponentId,
    timePerMoveMs: ms,
    deadlineB: now + ms,
    deadlineW: null,
    status: 'playing',
    result: null,
    resultDetail: null,
    createdAt: now,
    updatedAt: now,
  };
  storage.putCorrGame(g);
  return { ok: true, game: g };
}

function findSeat(g, playerId) {
  if (g.playerB === playerId) return 'b';
  if (g.playerW === playerId) return 'w';
  return null;
}

function move(playerId, id, usi) {
  const g = storage.getCorrGame(id);
  if (!g) return { ok: false, code: 'NO_GAME', error: '对局不存在' };
  if (g.status !== 'playing') return { ok: false, code: 'FINISHED', error: '对局已结束' };
  const seat = findSeat(g, playerId);
  if (!seat) return { ok: false, code: 'FORBIDDEN', error: '不是这局选手' };
  const state0 = stateFor(g);
  if (state0.turn !== seat) return { ok: false, code: 'NOT_TURN', error: '还没轮到你' };
  const deadline = seat === 'b' ? g.deadlineB : g.deadlineW;
  if (!deadline || deadline <= Date.now()) {
    // 交给 sweep 统一判超时；这里给明确回执。
    return { ok: false, code: 'TIMEOUT', error: '本步已超时' };
  }
  const game = new Game(g.startSfen || STARTING_SFEN);
  for (const m of g.moves || []) game.applyMove(m);
  const r = game.applyMove(usi);
  if (!r.ok) return { ok: false, code: 'ILLEGAL', error: r.error };
  g.moves.push(usi);
  const now = Date.now();
  // 走子视为拒绝未决的和棋提议（避免旧提议一直挂着）。
  g.drawOfferBy = null;
  g.drawOfferedAt = null;
  if (game.result) {
    g.status = 'finished';
    g.result = game.result;
    g.resultDetail = game.resultDetail;
    g.deadlineB = null;
    g.deadlineW = null;
  } else {
    const next = game.turn === 'b' ? 'b' : 'w';
    g.deadlineB = next === 'b' ? now + g.timePerMoveMs : null;
    g.deadlineW = next === 'w' ? now + g.timePerMoveMs : null;
  }
  g.updatedAt = now;
  storage.updateCorrGame(g);
  return { ok: true, game: g, state: stateFor(g), finished: g.status === 'finished' };
}

function resign(playerId, id) {
  const g = storage.getCorrGame(id);
  if (!g) return { ok: false, code: 'NO_GAME', error: '对局不存在' };
  if (g.status !== 'playing') return { ok: false, code: 'FINISHED', error: '对局已结束' };
  const seat = findSeat(g, playerId);
  if (!seat) return { ok: false, code: 'FORBIDDEN', error: '不是这局选手' };
  g.status = 'finished';
  g.result = seat === 'b' ? 'w' : 'b';
  g.resultDetail = RESULT_DETAIL.resign;
  g.deadlineB = null;
  g.deadlineW = null;
  g.drawOfferBy = null;
  g.drawOfferedAt = null;
  g.updatedAt = Date.now();
  storage.updateCorrGame(g);
  return { ok: true, game: g, state: stateFor(g) };
}

function offerDraw(playerId, id) {
  const g = storage.getCorrGame(id);
  if (!g) return { ok: false, code: 'NO_GAME', error: '对局不存在' };
  if (g.status !== 'playing') return { ok: false, code: 'FINISHED', error: '对局已结束' };
  const seat = findSeat(g, playerId);
  if (!seat) return { ok: false, code: 'FORBIDDEN', error: '不是这局选手' };
  if (g.drawOfferBy === playerId) return { ok: true, game: g, pending: true };
  g.drawOfferBy = playerId;
  g.drawOfferedAt = Date.now();
  g.updatedAt = g.drawOfferedAt;
  storage.updateCorrGame(g);
  return { ok: true, game: g };
}

function respondDraw(playerId, id, accept) {
  const g = storage.getCorrGame(id);
  if (!g) return { ok: false, code: 'NO_GAME', error: '对局不存在' };
  if (g.status !== 'playing') return { ok: false, code: 'FINISHED', error: '对局已结束' };
  const seat = findSeat(g, playerId);
  if (!seat) return { ok: false, code: 'FORBIDDEN', error: '不是这局选手' };
  if (!g.drawOfferBy) return { ok: false, code: 'NO_OFFER', error: '没有待处理的和棋提议' };
  if (g.drawOfferBy === playerId) return { ok: false, code: 'SELF', error: '不能回应自己的和棋提议' };
  g.drawOfferBy = null;
  g.drawOfferedAt = null;
  g.updatedAt = Date.now();
  if (!accept) {
    storage.updateCorrGame(g);
    return { ok: true, game: g, accepted: false };
  }
  g.status = 'finished';
  g.result = '-';
  g.resultDetail = RESULT_DETAIL.agreedDraw;
  g.deadlineB = null;
  g.deadlineW = null;
  storage.updateCorrGame(g);
  return { ok: true, game: g, accepted: true };
}

/** 中止：只允许开局后两着以内（双方各走一手之前），避免下到一半借中止逃棋。 */
function abort(playerId, id) {
  const g = storage.getCorrGame(id);
  if (!g) return { ok: false, code: 'NO_GAME', error: '对局不存在' };
  if (g.status !== 'playing') return { ok: false, code: 'FINISHED', error: '对局已结束' };
  const seat = findSeat(g, playerId);
  if (!seat) return { ok: false, code: 'FORBIDDEN', error: '不是这局选手' };
  if ((g.moves || []).length >= 2) return { ok: false, code: 'TOO_LATE', error: '已经走过两手，不能中止' };
  g.status = 'aborted';
  g.result = null;
  g.resultDetail = RESULT_DETAIL.aborted;
  g.deadlineB = null;
  g.deadlineW = null;
  g.drawOfferBy = null;
  g.drawOfferedAt = null;
  g.updatedAt = Date.now();
  storage.updateCorrGame(g);
  return { ok: true, game: g };
}

function sweepDue(now = Date.now()) {
  const due = storage.listCorrDue(now);
  const out = [];
  for (const g of due) {
    const side = g.deadlineB && g.deadlineB <= now ? 'b' : (g.deadlineW && g.deadlineW <= now ? 'w' : null);
    if (!side) continue;
    g.status = 'finished';
    g.result = side === 'b' ? 'w' : 'b';
    g.resultDetail = RESULT_DETAIL.timeout;
    g.deadlineB = null;
    g.deadlineW = null;
    g.drawOfferBy = null;
    g.drawOfferedAt = null;
    g.updatedAt = now;
    storage.updateCorrGame(g);
    out.push(g);
  }
  return out;
}

function listFor(playerId) {
  return storage.listCorrGames(playerId).map((g) => {
    const seat = findSeat(g, playerId);
    const opponentId = seat === 'b' ? g.playerW : g.playerB;
    const state = g.status === 'playing' ? stateFor(g) : null;
    return {
      id: g.id,
      opponentId,
      seat,
      timePerMoveMs: g.timePerMoveMs,
      status: g.status,
      result: g.result,
      resultDetail: g.resultDetail,
      turn: state ? state.turn : null,
      myTurn: !!state && state.turn === seat,
      deadline: state ? state.deadline : null,
      moves: g.moves.length,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  });
}

let sweepTimer = null;
function startSweep(notify) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      for (const g of sweepDue()) {
        if (notify) {
          notify(g.playerB, { type: 'corr_finished', data: { gameId: g.id, result: g.result, resultDetail: g.resultDetail } });
          notify(g.playerW, { type: 'corr_finished', data: { gameId: g.id, result: g.result, resultDetail: g.resultDetail } });
        }
      }
    } catch (_) { /* 扫描失败下一轮重试 */ }
  }, 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = {
  DAY,
  TIME_OPTIONS,
  create,
  stateFor,
  move,
  resign,
  offerDraw,
  respondDraw,
  abort,
  sweepDue,
  listFor,
  startSweep,
};
