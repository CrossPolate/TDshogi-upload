'use strict';

/**
 * tournaments/round-robin.js — 循环赛（1.8）。
 *
 * 预先用轮转法排好全部轮次；每轮所有对局都有结果后进入下一轮，最后一轮结束按积分定名次。
 * 与瑞士制共用 `swissStandings`（积分/对手分/排名口径一致），但不使用瑞士制的动态配对。
 */

const log = require('../logger');
const swiss = require('../swiss');
const store = require('./store');
const { persist, addLog } = store;
const { normalizeStatus, transition } = require('./rules');
const { swissStandings, publicInfo } = require('./swiss-flow');

function schedule(players) {
  const list = (players || []).map((p) => p.id);
  const ids = list.slice();
  if (ids.length % 2 === 1) ids.push(null);
  const n = ids.length;
  if (n < 2) return [];
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const pairs = [];
    const byes = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      if (a == null && b == null) continue;
      if (a == null) byes.push(b);
      else if (b == null) byes.push(a);
      else pairs.push([a, b]);
    }
    rounds.push({
      round: r + 1,
      pairs,
      byes,
      results: {},
      matchIds: pairs.map(() => null),
      matchPairs: {},
    });
    // 轮转：除第一个位置外整体旋转
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

function roundDone(rec) {
  const pairs = rec.pairs || [];
  return pairs.every(([a, b]) => !!rec.results[swiss.pairKey(a, b)]);
}

function start(t, approved) {
  t.rounds = schedule(approved);
  t.currentRound = t.rounds.length ? 1 : 0;
  t.totalRounds = t.rounds.length;
  for (const rec of t.rounds) {
    for (const id of rec.byes || []) {
      const p = (t.players || []).find((x) => x.id === id);
      addLog(t, { byRole: 'system', action: 'bye', detail: { round: rec.round, playerId: id, name: p ? p.name : null } });
    }
  }
  addLog(t, { byRole: 'system', action: 'round-robin-start', detail: { rounds: t.totalRounds, players: (t.players || []).length } });
}

function finish(t) {
  const ranked = swissStandings(t);
  const top = ranked[0] || null;
  t.championId = top ? top.id : null;
  t.championTie = !!(ranked[0] && ranked[1] && ranked[0].score === ranked[1].score);
  const r = transition(t, 'finished', {
    byRole: 'system', action: 'finish',
    detail: { championId: t.championId, tie: t.championTie, rounds: t.currentRound },
  });
  if (!r.ok) log.error('tournament', '循环赛收尾失败', { tournamentId: t.id, error: r.error });
  return r.ok;
}

function advance(t) {
  if (normalizeStatus(t.status) !== 'playing') return;
  const rec = (t.rounds || []).find((x) => x.round === t.currentRound);
  if (!rec || !roundDone(rec)) return;
  const next = (t.rounds || []).find((x) => x.round === t.currentRound + 1);
  if (next) {
    t.currentRound = next.round;
    addLog(t, { byRole: 'system', action: 'round-robin-round', detail: { round: next.round } });
  } else {
    finish(t);
  }
}

function onMatchFinished(t, matchId, winnerId) {
  let rec = null;
  let idx = -1;
  for (const r of t.rounds || []) {
    const i = (r.matchIds || []).indexOf(matchId);
    if (i >= 0) { rec = r; idx = i; break; }
  }
  if (!rec) return { ok: false, error: '对局不属于该赛事' };
  const [a, b] = rec.pairs[idx];
  rec.results[swiss.pairKey(a, b)] = winnerId;
  rec.lastMatchId = matchId;
  rec.lastPair = [a, b];
  rec.matchIds[idx] = null;
  addLog(t, { byRole: 'system', action: 'match-result', detail: { round: rec.round, matchId, winnerId, draw: winnerId === '-' } });
  advance(t);
  persist();
  return { ok: true, tournament: publicInfo(t), finished: normalizeStatus(t.status) === 'finished' };
}

function voidPlayer(t, playerId, actor) {
  let affected = 0;
  for (const rec of t.rounds || []) {
    for (let i = 0; i < (rec.pairs || []).length; i += 1) {
      const [a, b] = rec.pairs[i];
      if (a !== playerId && b !== playerId) continue;
      const foe = a === playerId ? b : a;
      rec.results[swiss.pairKey(a, b)] = foe;
      rec.matchIds[i] = null;
      affected += 1;
    }
  }
  if (t.championId === playerId) { t.championId = null; t.championTie = false; }
  addLog(t, { byId: actor.id, byRole: 'admin', action: 'void-player', detail: { playerId, affected } });
  advance(t);
  persist();
  return { ok: true, tournament: publicInfo(t), affected };
}

module.exports = { schedule, roundDone, start, finish, advance, onMatchFinished, voidPlayer };
