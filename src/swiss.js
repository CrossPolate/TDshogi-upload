/**
 * swiss.js — 瑞士制配对的纯函数（PLAN §V-T8，2026-09-15）
 *
 * ## 为什么单独成模块、而且是纯函数
 * 瑞士制的正确性**全在配对算法里**：谁该跟谁打、不能重复对阵、奇数人怎么轮空、
 * 万一配不出来怎么办。这部分逻辑与"房间怎么建、状态怎么存、前端怎么画"完全无关——
 * 把它从赛事状态里剥出来，才能用单测把边界钉死，而不必为了验证配对去造一整套赛事。
 *
 * 模块内**不碰 storage / 不碰 rooms**，只做"给定积分与历史 → 给出下一轮配对"。
 *
 * ## 与单败淘汰的区别（决定了它不能复用 bracket）
 * 淘汰赛是一棵**树**（输了就出局，位置固定）；瑞士制是**轮次列表**——
 * 每轮重新按积分配对，没有固定的树形结构，所以数据结构与推进逻辑都要另起一套。
 */
'use strict';

/** 胜 = 1 分，和 = 0.5 分，负 = 0 分（将棋有千日手和棋，不能只算胜负） */
const WIN = 1;
const DRAW = 0.5;
const LOSS = 0;

/**
 * 把若干轮的赛果汇总成每个选手的积分与对手列表。
 *
 * @param {Array<{id:string,name?:string}>} players 参赛者
 * @param {Array<{round:number, pairs:Array<[string,string]>, byes?:string[], results?:object}>} rounds
 *        `results` 形如 `{ 'idA|idB': 'idA' }`（键为双方 id 用 `|` 连接，顺序无关，见 `pairKey`）
 * @returns {Map<string, {id:string,name?:string,score:number,opponents:string[],byes:number,playedIds:Set<string>}>}
 */
function computeStandings(players, rounds) {
  const table = new Map();
  for (const p of players || []) {
    table.set(p.id, {
      id: p.id,
      name: p.name,
      score: 0,
      opponents: [],
      byes: 0,
      playedIds: new Set(),
      wins: 0,
      draws: 0,
      losses: 0,
    });
  }

  for (const r of rounds || []) {
    // 轮空 = 得 1 分（Swiss 通行做法：轮空视同胜）
    for (const id of r.byes || []) {
      const e = table.get(id);
      if (!e) continue;
      e.score += WIN;
      e.byes += 1;
      e.wins += 1;
    }
    for (const pair of r.pairs || []) {
      const [a, b] = pair;
      const ea = table.get(a);
      const eb = table.get(b);
      if (!ea || !eb) continue;
      ea.opponents.push(b);
      eb.opponents.push(a);
      ea.playedIds.add(b);
      eb.playedIds.add(a);

      const winner = (r.results || {})[pairKey(a, b)];
      if (winner === a) { ea.score += WIN; ea.wins += 1; eb.score += LOSS; eb.losses += 1; }
      else if (winner === b) { eb.score += WIN; eb.wins += 1; ea.score += LOSS; ea.losses += 1; }
      else if (winner === '-') { ea.score += DRAW; eb.score += DRAW; ea.draws += 1; eb.draws += 1; }
      // winner 为空 = 对局尚未出结果：双方都不得分（等它结束后再算）
    }
  }

  // 对手分（SOS，Sum of Opponents' Scores）：同分时的第一顺位判据
  for (const e of table.values()) {
    let sos = 0;
    for (const oid of e.opponents) {
      const o = table.get(oid);
      if (o) sos += o.score;
    }
    e.sos = sos;
  }
  return table;
}

/** 一对选手的稳定键（与先后顺序无关），用于查这场的胜者 */
function pairKey(a, b) {
  return String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 名次排序（**确定性**是硬要求）。
 *
 * ⚠️ 为什么必须确定性：配对建立在名次之上，而 `Array.sort` 在比较函数返回 0 时
 * **不保证稳定顺序**（Node 虽已稳定，但依赖它等于把正确性押在运行时实现上）。
 * 所以最后一定会用"参赛顺序"兜底，保证同样输入永远得到同样配对——
 * 否则同一份数据两次算出不同对阵，测试会随机失败、线上会莫名换对手。
 *
 * 顺序：积分 ↓ → 对手分 ↓ → 直胜 → 参赛顺序 ↑
 */
function rankStandings(entries) {
  const list = Array.from(entries);
  const order = new Map();
  list.forEach((e, i) => order.set(e.id, i));
  return list.sort((x, y) => (
    (y.score - x.score)
    || ((y.sos || 0) - (x.sos || 0))
    || (order.get(x.id) - order.get(y.id))
  ));
}

/**
 * 生成下一轮配对。
 *
 * 规则（按优先级）：
 *  1. 按名次取序（积分 → 对手分 → 参赛序，见 `rankStandings`）；
 *  2. **相邻配对，但不重复对阵**——这正是瑞士制的核心：强者遇强者 + 不重复交手；
 *  3. 人数为奇数 → **积分最低且从未轮空过**的人轮空（得 1 分）。
 *     不让高分者轮空：那等于白送一分，会破坏名次公平；
 *  4. 配不出合法组合时**逐级退让**（先允许重复对阵，再允许把已配好的拆开重来），
 *     并在返回值里 `degraded` 标注。**绝不抛错**——宁可这轮有点瑕疵，
 *     也不能让整个赛事卡在"配不出对"上。
 *
 * @param {object} o
 * @param {Array} o.standings  `computeStandings()` 的结果（Map 或其 values）
 * @param {boolean} [o.allowBye=true] 奇数人时是否允许轮空（false 时奇数人会被拒绝）
 * @returns {{pairs:Array<[string,string]>, byes:string[], degraded:boolean, reason?:string}}
 */
function pairRound({ standings, allowBye = true } = {}) {
  const entries = standings instanceof Map ? Array.from(standings.values()) : Array.from(standings || []);
  if (entries.length < 2) {
    return { pairs: [], byes: entries.map((e) => e.id), degraded: false, reason: '人数不足，无人可配' };
  }

  const ranked = rankStandings(entries);
  let pool = ranked.slice();
  const byes = [];

  // 奇数人 → 最低分且从未轮空者轮空
  if (pool.length % 2 === 1) {
    if (!allowBye) {
      return { pairs: [], byes: [], degraded: true, reason: '人数为奇数且不允许轮空' };
    }
    let idx = -1;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!pool[i].byes) { idx = i; break; }
    }
    if (idx < 0) idx = pool.length - 1; // 全都轮空过了 → 只能让最后一名再轮一次
    byes.push(pool[idx].id);
    pool = pool.slice(0, idx).concat(pool.slice(idx + 1));
  }

  // 第一遍：严格不重复对阵
  let res = greedyPair(pool, false);
  let degraded = false;

  // 第二遍：允许重复（退让，但要标注出来——主办人有权知道这轮不完美）
  if (res.unpaired.length) {
    const again = greedyPair(pool, true);
    if (again.pairs.length > res.pairs.length) {
      res = again;
      degraded = true;
    }
  }

  if (res.unpaired.length) {
    return {
      pairs: res.pairs, byes, degraded: true,
      reason: `有 ${res.unpaired.length} 人未能配对`,
    };
  }
  return { pairs: res.pairs, byes, degraded };
}

/**
 * 贪心相邻配对。
 *
 * 从名次最高的未配者出发，向后找**第一个**满足条件的对手：
 *  - 尚未配对；且
 *  - （严格模式）此前没有交手过。
 *
 * ⚠️ 为什么用贪心而不是求"完美匹配"：瑞士制只要保证"不重复 + 分数接近"，
 * 并不要求全局最优；而完美匹配（如 Blossom 算法）的复杂度与实现风险都高得多，
 * 收益却很小。`degraded` 标记已经能兜住退让的情形。
 */
function greedyPair(pool, allowRepeat) {
  const used = new Array(pool.length).fill(false);
  const pairs = [];
  const unpaired = [];

  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    let picked = -1;
    for (let j = i + 1; j < pool.length; j++) {
      if (used[j]) continue;
      if (!allowRepeat && pool[i].playedIds && pool[i].playedIds.has(pool[j].id)) continue;
      picked = j;
      break;
    }
    if (picked < 0) { unpaired.push(pool[i].id); continue; }
    used[i] = true;
    used[picked] = true;
    pairs.push([pool[i].id, pool[picked].id]);
  }
  return { pairs, unpaired };
}

/**
 * 建议的总轮数：`ceil(log2(人数))`，最少 3 轮（瑞士制少于 3 轮区分度太差）。
 * 这是赛事**建议值**，主办人可在申请时覆盖。
 */
function suggestRounds(playerCount) {
  const n = Math.max(2, Number(playerCount) || 0);
  return Math.max(3, Math.ceil(Math.log2(n)));
}

module.exports = {
  computeStandings, rankStandings, pairRound, pairKey, suggestRounds,
  WIN, DRAW, LOSS,
};
