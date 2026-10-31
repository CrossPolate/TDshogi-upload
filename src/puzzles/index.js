'use strict';

/**
 * puzzles/ — 1.6 每日诘将棋 / 下一手。
 *
 * 题库由管理员导入；每日题按 JST 日期确定性选取。作答在服务端校验：
 *  - 客户端只拿到题目 SFEN/局面与合法走法，拿不到解法；
 *  - 提交的走法前缀必须与 solution 一致；答错只记次数，不泄露答案；
 *  - tsume 的 solution 是完整手顺（用户手 + 自动应手），答完才返回完整解法。
 */

const { Shogi } = require('shogi.js');
const { Game } = require('../game');
const storage = require('../storage');

const TYPES = ['tsume', 'next'];
const MAX_SOLUTION = 60;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function dayKey(now = Date.now()) {
  return new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function hash(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function validSfen(sfen) {
  try {
    const s = new Shogi();
    s.initializeFromSFENString(String(sfen || ''));
    return true;
  } catch (_) { return false; }
}

function validatePuzzle(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '题目必须是对象' };
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return { ok: false, error: `题目 id 不合法：${id || '(空)'}` };
  const type = String(raw.type || '').trim();
  if (!TYPES.includes(type)) return { ok: false, error: `type 必须是 ${TYPES.join(' / ')}` };
  if (!validSfen(raw.sfen)) return { ok: false, error: 'sfen 不合法' };
  const solution = Array.isArray(raw.solution) ? raw.solution.map((m) => String(m || '').trim()).filter(Boolean) : [];
  if (!solution.length) return { ok: false, error: 'solution 必须是非空 USI 数组' };
  if (solution.length > MAX_SOLUTION) return { ok: false, error: `solution 超过 ${MAX_SOLUTION} 手` };
  if (type === 'next' && solution.length !== 1) return { ok: false, error: 'next 类型的 solution 只能是 1 手' };

  const game = new Game(raw.sfen);
  for (let i = 0; i < solution.length; i += 1) {
    const r = game.applyMove(solution[i]);
    if (!r.ok) return { ok: false, error: `solution[${i}] 非法：${r.error}` };
  }
  if (type === 'tsume' && !(game.result && game.resultDetail === '詰み')) {
    return { ok: false, error: 'tsume 解法最后必须是詰み' };
  }

  const difficulty = Math.max(1, Math.min(5, Math.floor(Number(raw.difficulty) || 1)));
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [];
  return {
    ok: true,
    puzzle: {
      id,
      type,
      sfen: String(raw.sfen),
      solution,
      difficulty,
      tags,
      source: raw.source ? String(raw.source).slice(0, 200) : null,
      license: raw.license ? String(raw.license).slice(0, 80) : null,
      status: raw.status === 'disabled' ? 'disabled' : 'active',
      createdAt: Number(raw.createdAt) || Date.now(),
    },
  };
}

function publicPuzzle(p) {
  return {
    id: p.id,
    type: p.type,
    sfen: p.sfen,
    difficulty: p.difficulty,
    tags: p.tags,
  };
}

function legalTargetsBySq(game) {
  const map = {};
  for (const usi of game.legalMovesUsi()) {
    const drop = usi[1] === '*';
    const from = drop ? usi[0] : usi.slice(0, 2);
    const to = drop ? usi.slice(2, 4) : usi.slice(2, 4);
    if (!map[from]) map[from] = [];
    map[from].push({ to, usi, promote: usi.length === 5, drop });
  }
  return map;
}

function stateFor(puzzle, moves) {
  const game = new Game(puzzle.sfen);
  for (const m of moves || []) {
    const r = game.applyMove(m);
    if (!r.ok) throw new Error(`走法非法：${m}`);
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
  };
}

function todayPuzzle(day = dayKey()) {
  const ids = storage.listActivePuzzleIds();
  if (!ids.length) return null;
  return storage.getPuzzleById(ids[hash(day) % ids.length]);
}

function dailyFor(playerId, day = dayKey()) {
  const puzzle = todayPuzzle(day);
  if (!puzzle) return { ok: true, puzzle: null, solved: false, attempts: 0, day };
  const attempt = playerId ? storage.getPuzzleAttempt(playerId, puzzle.id, day) : null;
  return {
    ok: true,
    day,
    puzzle: publicPuzzle(puzzle),
    solved: !!(attempt && attempt.ok),
    attempts: attempt ? attempt.attempts : 0,
    solution: attempt && attempt.ok ? puzzle.solution : null,
    state: stateFor(puzzle, []),
  };
}

/**
 * 提交一串走法（包含用户手与之前服务端返回的应手）。
 * 返回的 reply 由服务端判定为对手应手，客户端自动落子后继续。
 */
function attempt(playerId, puzzleId, moves) {
  const puzzle = storage.getPuzzleById(puzzleId);
  if (!puzzle || puzzle.status !== 'active') return { ok: false, code: 'NO_PUZZLE', error: '题目不存在或已下架' };
  if (!playerId) return { ok: false, code: 'AUTH', error: '需要玩家身份' };
  if (!Array.isArray(moves) || moves.length > puzzle.solution.length) {
    return { ok: false, code: 'BAD_MOVES', error: '走法序列不合法' };
  }
  const seq = moves.map((m) => String(m || '').trim());
  const day = dayKey();
  const prev = storage.getPuzzleAttempt(playerId, puzzle.id, day) || { attempts: 0, ok: 0 };
  const attempts = (prev.attempts || 0) + 1;
  for (let i = 0; i < seq.length; i += 1) {
    if (seq[i] !== puzzle.solution[i]) {
      storage.putPuzzleAttempt(playerId, puzzle.id, day, { ok: false, attempts });
      return { ok: false, code: 'WRONG_MOVE', error: '这手不对，再试试', attempts };
    }
  }

  // 用户刚走完，且尚未完成 → 下一手是对手应手，自动返回
  let reply = null;
  if (seq.length > 0 && seq.length < puzzle.solution.length && seq.length % 2 === 1) {
    reply = puzzle.solution[seq.length];
  }
  const nextMoves = reply ? seq.concat(reply) : seq;
  const complete = nextMoves.length >= puzzle.solution.length;

  if (complete) {
    storage.putPuzzleAttempt(playerId, puzzle.id, day, { ok: true, attempts });
    return {
      ok: true,
      correct: true,
      complete: true,
      attempts,
      reply,
      solution: puzzle.solution,
      state: stateFor(puzzle, nextMoves),
    };
  }

  if (seq.length === 0) {
    storage.putPuzzleAttempt(playerId, puzzle.id, day, { ok: false, attempts });
    return { ok: true, correct: false, complete: false, attempts, error: '请先走一手' };
  }

  storage.putPuzzleAttempt(playerId, puzzle.id, day, { ok: false, attempts });
  return {
    ok: true,
    correct: true,
    complete: false,
    attempts,
    reply,
    state: stateFor(puzzle, nextMoves),
  };
}

function streak(playerId, day = dayKey()) {
  if (!playerId) return { streak: 0, solvedToday: false };
  const since = new Date(Date.parse(`${day}T00:00:00Z`) - 59 * 86400000).toISOString().slice(0, 10);
  const days = new Set(storage.listPuzzleSolvedDays(playerId, since));
  const solvedToday = days.has(day);
  let cursor = day;
  if (!solvedToday) {
    const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    const d = new Date(`${cursor}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return { streak: n, solvedToday, lastSolvedDay: solvedToday ? day : (n ? cursor : null) };
}

function list() {
  return storage.listPuzzles(500).map((p) => ({ ...p, solution: undefined }));
}

function importPuzzles(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) {
    return { ok: false, error: 'puzzles 必须是非空数组' };
  }
  const errors = [];
  const valid = [];
  for (let i = 0; i < rawList.length; i += 1) {
    const v = validatePuzzle(rawList[i]);
    if (!v.ok) errors.push(`第 ${i + 1} 题：${v.error}`);
    else valid.push(v.puzzle);
  }
  // 全量校验通过才写入，避免“导入一半、题库处于半成品状态”。
  if (errors.length) return { ok: false, imported: 0, errors };
  for (const p of valid) storage.putPuzzle(p);
  return { ok: true, imported: valid.length, errors: [] };
}

module.exports = {
  TYPES,
  dayKey,
  validatePuzzle,
  legalTargetsBySq,
  stateFor,
  todayPuzzle,
  dailyFor,
  attempt,
  streak,
  list,
  importPuzzles,
};
