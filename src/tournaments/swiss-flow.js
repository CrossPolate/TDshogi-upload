/**
 * tournaments/swiss-flow.js — 瑞士制推进 + 名次/公开信息（积分编排、结束轮、名次表、publicInfo）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const log = require('../logger');
const swiss = require('../swiss');
const store = require('./store');
const { persist, FORMAT_LABELS, addLog } = store;   // matchFactory 是可变量，见 store.js 的说明
const { roleOf, normalizeStatus, transition } = require('./rules');


/**
 * 定位"这一场是谁打谁"。
 *
 * 抽出来是为了让**申请人资格判定只有一份**：淘汰赛从 `lastPlayers` 取
 *（对局结束后 `players` 会被清空），瑞士制从该轮的 `lastPair` / `pairs` 取。
 * 两条赛制各写一遍资格判定，迟早有一条忘核对——那就是"谁都能申诉别人对局"的漏洞。
 *
 * @returns {{players:string[], index?:number, round?:number}|null}
 */
function matchParticipants(t, matchId) {
  if (!matchId) return null;
  if ((t.format || 'single-elimination') === 'swiss') {
    for (const rec of t.rounds || []) {
      // 先查 `matchPairs`：赛后 `matchIds` 已被清空，只有它还留着"这一场是谁打谁"
      const mp = rec.matchPairs || {};
      if (mp[matchId]) return { players: mp[matchId].slice(), round: rec.round };
      const i = (rec.matchIds || []).indexOf(matchId); // 兜底：老数据没有 matchPairs
      if (i >= 0 && rec.pairs[i]) return { players: rec.pairs[i].slice(), round: rec.round };
    }
    return null;
  }
  const node = (t.bracket || []).find((n) => n.matchId === matchId || n.lastMatchId === matchId);
  if (!node) return null;
  return { players: (node.lastPlayers || node.players || []).slice(), index: node.index };
}


// ==================================================================
// 瑞士制（T8）：逐轮配对与推进
//
// 与单败淘汰的根本差异：**没有淘汰树**。每轮按当前积分重新配对，
// 所以既不能复用 `bracket`，也不能复用 `assignNextMatches` 那套"从下往上传播"的推进。
// 配对与积分算法的实现全在 `src/swiss.js`（纯函数 + 12 项单测），这里只做状态读写。
// ==================================================================

/** 把 `t.rounds` 转成 swiss.js 需要的形态（**去掉房间 id 等非算法字段**） */
function swissRounds(t) {
  return (t.rounds || []).map((r) => ({
    round: r.round, pairs: r.pairs, byes: r.byes, results: r.results,
  }));
}


/**
 * 当前名次表（瑞士制积分榜）。
 *
 * ⚠️ 出口做**显式整形**：`computeStandings` 内部用 `Set` 记对手（`playedIds`），
 * 直接下发会被 `JSON.stringify` 丢掉，调用方拿到的是残缺对象；
 * 而且内部字段名（`opponents`/`playedIds`）不适合当接口契约。
 */
function swissStandings(t) {
  const table = swiss.computeStandings(t.players || [], swissRounds(t));
  return swiss.rankStandings(Array.from(table.values())).map((e, i) => ({
    rank: i + 1,
    id: e.id,
    name: e.name || null,
    score: e.score,
    sos: e.sos || 0,        // 对手分（同分时的第一判据）
    played: (e.opponents || []).length,
    byes: e.byes || 0,
    wins: e.wins || 0,
    draws: e.draws || 0,
    losses: e.losses || 0,
  }));
}


/** 本轮是否每一场都有结果了（轮空不需要结果，它直接得 1 分） */
function swissRoundDone(rec) {
  // ⚠️ 2026-10-02 审查 P2-12a：建房失败（matchId 为空）的对局视为「本轮跳过」，
  // 否则 every 恒假 → 该轮永不推进、赛事永久卡死（旧实现只 log.error，配对仍留在 pairs 里）。
  const pairs = rec.pairs || [];
  const ids = rec.matchIds || [];
  return pairs.every(([a, b], i) => !!rec.results[swiss.pairKey(a, b)] || ids[i] == null);
}


/**
 * 开一轮：按当前名次配对、建房，并把这一轮记进 `t.rounds`。
 *
 * @param {number} roundNo 1 起
 */
function startSwissRound(t, roundNo) {
  const table = swiss.computeStandings(t.players || [], swissRounds(t));
  const paired = swiss.pairRound({ standings: table });

  const rec = {
    round: roundNo,
    pairs: paired.pairs,
    byes: paired.byes,
    results: {},
    matchIds: [],
    // ⚠️ `matchIds` 会在每场打完后清空（防重复回调），所以"这一场是谁打谁"要**另留一份**：
    // 重赛申请必须在赛后还能定位到场次与选手，而那时 `matchIds` 已经找不到它了。
    matchPairs: {},
    degraded: !!paired.degraded,
    reason: paired.reason || null,
  };

  for (const id of paired.byes) {
    const p = (t.players || []).find((x) => x.id === id);
    addLog(t, {
      byRole: 'system', action: 'bye',
      detail: { round: roundNo, playerId: id, name: p ? p.name : null },
    });
  }

  paired.pairs.forEach(([a, b], i) => {
    const pa = (t.players || []).find((x) => x.id === a) || { id: a, name: '?' };
    const pb = (t.players || []).find((x) => x.id === b) || { id: b, name: '?' };
    const res = store.matchFactory ? store.matchFactory(t.id, [pa, pb]) : null;
    rec.matchIds[i] = (res && res.roomId) ? res.roomId : null;
    if (rec.matchIds[i]) rec.matchPairs[rec.matchIds[i]] = [a, b];
    else {
      // 建房失败不能让整轮**静默卡住**：没有房就永远等不到结果，这里必须留下痕迹
      log.error('tournament', `瑞士制第 ${roundNo} 轮建房失败`, { tournamentId: t.id, players: [a, b] });
    }
  });

  t.rounds = (t.rounds || []).concat([rec]);
  t.currentRound = roundNo;
  addLog(t, {
    byRole: 'system', action: 'swiss-round',
    detail: {
      round: roundNo, matches: paired.pairs.length, byes: paired.byes.length,
      degraded: rec.degraded,
    },
  });
  return rec;
}


/**
 * 瑞士制收尾：按名次定冠军。
 *
 * ⚠️ **并列第一不静默**：瑞士制没有淘汰，完全可能出现同分。
 * 这里按 `rankStandings` 的顺序（积分 → 对手分 → 参赛序）取第一，
 * 并用 `championTie` 标注是否与第二同分——详情页会写明"与第二名同分，按对手分裁定"。
 * 假装没有并列会让人以为那是干净的第一。
 */
function finishSwiss(t) {
  const ranked = swissStandings(t);
  const top = ranked[0] || null;
  t.championId = top ? top.id : null;
  t.championTie = !!(ranked[0] && ranked[1] && ranked[0].score === ranked[1].score);
  const r = transition(t, 'finished', {
    byRole: 'system', action: 'finish',
    detail: { championId: t.championId, tie: t.championTie, rounds: t.currentRound },
  });
  if (!r.ok) {
    // 状态机不允许（理论上 playing→finished 是合法的）——记下来而不是吞掉
    log.error('tournament', '瑞士制收尾失败', { tournamentId: t.id, error: r.error });
  }
  return r.ok;
}


/**
 * 当前轮已打完就推进；已收尾的赛事不动。
 *
 * 抽出来是因为有**两个**触发点：对局结束、以及成绩改判（取消选手成绩 / 重赛批准）——
 * 后两者改完赛果后本轮同样可能刚好凑齐，必须也能推进。
 */
function maybeAdvanceSwiss(t) {
  if (normalizeStatus(t.status) !== 'playing') return;
  const rec = (t.rounds || [])[t.rounds.length - 1];
  if (!rec || !swissRoundDone(rec)) return;
  if (rec.round >= (t.totalRounds || 0)) finishSwiss(t);
  else startSwissRound(t, rec.round + 1);
}


/**
 * 瑞士制下"取消选手成绩"：把他**已参与的每一场都判对手胜**。
 *
 * ⚠️ 与淘汰赛的差别：淘汰赛要清"上游"（通往决赛那条路）；
 * 瑞士制没有上游，但**改分会改变名次 → 影响后续对阵**。
 * 处理方式：已打完的轮次**保留**（那是既成事实，重排名次不会让它们消失），
 * 而"当前轮刚好凑齐"时照常推进（`maybeAdvanceSwiss`）。
 */
function voidPlayerSwiss(t, playerId, actor) {
  let affected = 0;
  for (const rec of t.rounds || []) {
    for (let i = 0; i < (rec.pairs || []).length; i++) {
      const [a, b] = rec.pairs[i];
      if (a !== playerId && b !== playerId) continue;
      const foe = a === playerId ? b : a;
      rec.results[swiss.pairKey(a, b)] = foe; // 判对手胜
      rec.matchIds[i] = null;                 // 该场已判负：房间作废，不能留着"进行中"
      rec.voided = rec.voided || [];
      if (rec.voided.indexOf(playerId) < 0) rec.voided.push(playerId);
      affected++;
    }
  }

  if (t.championId === playerId) { t.championId = null; t.championTie = false; }
  t.championManual = false;
  addLog(t, {
    byId: actor.id, byRole: roleOf(t, actor),
    action: 'void-player', detail: { playerId, affected },
  });

  maybeAdvanceSwiss(t);
  persist();
  return { ok: true, tournament: publicInfo(t), affected };
}


/** 瑞士制的对局结束：记赛果 → 整轮打完才配下一轮 → 轮数跑完按名次收尾 */
function swissOnMatchFinished(t, matchId, winnerId) {
  let rec = null;
  let idx = -1;
  for (const r of t.rounds || []) {
    const i = (r.matchIds || []).indexOf(matchId);
    if (i >= 0) { rec = r; idx = i; break; }
  }
  if (!rec) return { ok: false, error: '对局不属于该赛事' };

  const [a, b] = rec.pairs[idx];
  rec.results[swiss.pairKey(a, b)] = winnerId;
  // 重赛申诉要靠它定位（`matchIds` 马上会被清空，与 bracket 路径的 lastMatchId 同理）
  rec.lastMatchId = matchId;
  rec.lastPair = [a, b];
  rec.matchIds[idx] = null;

  // ⚠️ 2026-10-02 体验修复（问题 1）：显式带上 `draw` 标记——和棋（`'-'`，即千日手/持将棋）
  // 与"正常出胜负"在日志里长得一样（都只有 winnerId），前端/管理员只能靠猜。
  // 补一个布尔标记后，「变更记录」能一眼看出"这一场是和棋，不是还没打完"。
  addLog(t, {
    byRole: 'system', action: 'match-result',
    detail: { round: rec.round, matchId, winnerId, draw: winnerId === '-' },
  });

  if (!swissRoundDone(rec)) {
    persist();
    return { ok: true, tournament: publicInfo(t) };
  }

  maybeAdvanceSwiss(t); // 本轮凑齐 → 配下一轮，或按名次收尾
  persist();
  return { ok: true, tournament: publicInfo(t), finished: normalizeStatus(t.status) === 'finished' };
}


/**
 * 对外视图。
 *
 * ⚠️ 每个 T1 新增字段都用 `|| []` / `|| null` 兜底：**旧数据没有这些字段**，
 * 不兜底会让前端到处 `undefined`。历史包袱必须在这里吸收干净，不能漏给调用方。
 *
 * ⚠️ `status` 出口做 `normalizeStatus()` 映射（旧数据写的是 `open`）；
 * 并且 `reason` 字段的**语义在新旧数据里不同**——旧数据里它是"拒绝/取消原因"，
 * T1 起是"举办理由"。这里按状态区分归属，避免把拒绝理由显示成举办理由。
 */
function publicInfo(t) {
  if (!t) return null;
  const players = t.players || [];
  const st = normalizeStatus(t.status);
  const legacyReason = (st === 'rejected' || st === 'cancelled') ? (t.reason || null) : null;

  return {
    id: t.id,
    name: t.name,
    size: t.size,
    format: t.format || 'single-elimination',
    status: st,
    ownerId: t.ownerId || null,
    ownerName: t.ownerName || null,
    createdAt: t.createdAt,

    // ---- 建赛申请表（需求 9）----
    reason: (st === 'rejected' || st === 'cancelled') ? '' : (t.reason || ''),
    registerStart: t.registerStart || null,
    registerEnd: t.registerEnd || null,
    matchStart: t.matchStart || null,
    matchEnd: t.matchEnd || null,
    requireApproval: t.requireApproval !== false,

    // ---- 报名与对阵 ----
    entrants: t.entrants || [],
    players,
    playerCount: players.length,
    bracket: t.bracket || [],

    // ---- 赛制与瑞士制（T8）----
    formatLabel: FORMAT_LABELS[t.format || 'single-elimination'] || null,
    totalRounds: t.totalRounds || null,
    currentRound: t.currentRound || 0,
    // ⚠️ 只给瑞士制下发 rounds / standings：淘汰赛没有这两个概念，
    // 而 `standings` 每次都要重跑一遍积分计算（列表页会批量调 publicInfo）。
    rounds: (t.format === 'swiss') ? (t.rounds || []) : [],
    standings: (t.format === 'swiss') ? swissStandings(t) : [],
    championTie: !!t.championTie,

    championId: t.championId || null,
    championManual: !!t.championManual,
    rematches: t.rematches || [],
    note: t.note || null, // T6：管理员可编辑的赛事备注（赛后更正用）

    // ---- 赛后存档（需求 11）----
    endedAt: t.endedAt || null,
    archivedAt: t.archivedAt || null,

    // ---- 审核 ----
    reviewedAt: t.reviewedAt || null,
    reviewedBy: t.reviewedBy || null,
    rejectReason: t.rejectReason || legacyReason,

    // ---- 变更记录（详情页用）----
    // ⚠️ 只取**最近 50 条**：办得久的赛事日志会越积越多，
    // 全量下发既浪费带宽也会把页面拉得极长（用户要求"避免爆炸"的一致口径）。
    logs: (t.logs || []).slice(-50),

    // ---- 管理员编辑历史（T6/需求 11）----
    // ⚠️ 这是**赛后改结论的留痕**，属敏感信息：HTTP 出口会按"是否管理员"决定要不要下发
    // （见 `src/http/routes/tournaments.js` 的 `adminEditLog` 处理），这里原样带上。
    adminEditLog: (t.adminEditLog || []).slice(-50),
  };
}


// ==================================================================
// 赛事荣誉（个人页"赛事荣誉栏"）
//
// 赛事结果是**公开信息**，所以这里算出来的东西可以直接下发给任何人，
// 不需要走隐私白名单（`privacy.stripPrivate` 也不会误伤：键名与 PRIVATE_KEYS 无交集）。
// ==================================================================

/** 名次 → 文案 */
const PLACE_LABEL = { 1: '冠军', 2: '亚军', 3: '四强' };


/**
 * 某人在该赛事中的**名次**（1 冠军 / 2 亚军 / 3 四强 / null 无名次）。
 *
 * ⚠️ 两种赛制的名次来源完全不同，必须分路：
 *  - **淘汰赛**：冠军看 `championId`；亚军 = 决赛的另一位选手；
 *    四强 = 半决赛（根的左右子树）的参赛者。
 *    ⚠️ 对局结束后 `node.players` 会被清空（见 `onMatchFinished`），
 *    所以只能读 `lastPlayers`——拿 `players` 反推会全部落空；
 *  - **瑞士制**：没有淘汰，名次由积分榜（`swissStandings`）给出。
 *    只认前四——8 人档的第 5 名谈不上"荣誉"。
 *
 * @returns {number|null}
 */
function placeOf(t, playerId) {
  if (!t || !playerId) return null;

  // ⚠️ 未结束的赛事**没有名次**：半决赛还在打的人不等于"四强"，
  // 决赛还没开始更谈不上冠亚军。不判状态的话，进行中的赛事会被算成"满员四强"。
  const st = normalizeStatus(t.status);
  if (st !== 'finished' && st !== 'archived') return null;

  if (t.championId === playerId) return 1;

  if ((t.format || 'single-elimination') === 'swiss') {
    const row = swissStandings(t).find((x) => x.id === playerId);
    if (!row) return null;
    return row.rank <= 2 ? row.rank : (row.rank <= 4 ? 3 : null);
  }

  const bracket = t.bracket || [];
  const root = bracket[0];
  if (!root) return null;

  // 亚军：决赛的两位选手，除去冠军
  const finalists = root.lastPlayers || (root.matchId ? root.players : null) || [];
  if (finalists.indexOf(playerId) >= 0) return 2;

  // 四强：半决赛节点（根的左右子树）的参赛者
  const semiPlayers = [];
  for (const i of root.pair || []) {
    const n = bracket[i];
    if (!n) continue;
    const ps = n.lastPlayers || n.players || null;
    if (ps) semiPlayers.push.apply(semiPlayers, ps);
    else if (n.playerId) semiPlayers.push(n.playerId); // 轮空晋级的人没有 lastPlayers
  }
  return semiPlayers.indexOf(playerId) >= 0 ? 3 : null;
}

module.exports = {
  matchParticipants,
  swissRounds,
  swissStandings,
  swissRoundDone,
  startSwissRound,
  finishSwiss,
  maybeAdvanceSwiss,
  voidPlayerSwiss,
  swissOnMatchFinished,
  publicInfo,
  PLACE_LABEL,
  placeOf,
};
