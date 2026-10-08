/**
 * tournaments/bracket.js — 单败淘汰对阵表推进（建表 / 轮空 / 下一轮 / 终局回调）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const log = require('../logger');
const store = require('./store');
const { getCache, persist, addLog } = store;   // matchFactory 是可变量，见 store.js 的说明
const { transition } = require('./rules');     // 状态机（收尾走它，与瑞士制一致）
const { swissOnMatchFinished, publicInfo } = require('./swiss-flow');


/**
 * 本赛事**当前仍在进行**的房间 id。
 *
 * ⚠️ 必须按赛制分路：淘汰赛的房间挂在 `bracket` 节点上，而**瑞士制没有 bracket**，
 * 房间在各轮的 `matchIds` 里。只看 `bracket` 的后果是——取消瑞士制赛事**一个房间都不解散**，
 * 参赛者还在里面下棋，赛事却已经不是"进行中"了。
 */
function liveMatchIds(t) {
  if ((t.format || 'single-elimination') === 'swiss') {
    const out = [];
    for (const rec of t.rounds || []) {
      for (const mid of rec.matchIds || []) if (mid) out.push(mid);
    }
    return out;
  }
  return (t.bracket || []).map((n) => n.matchId).filter(Boolean);
}


/**
 * 标准种子布点顺序（长度 = size，元素为 1 起的**种子号**）。P2 修复用。
 *
 * 目标：1 号与 2 号种子分处上下半区（只可能在决赛相遇），各分区内强弱对称，
 * 于是**空位（轮空）优先落到高种子对面**——报名不满员时高种子自动轮空，强弱分布均匀。
 *
 * 生成：从 `[1, 2]` 起，每翻倍把每个种子 s 展开成相邻一对 `{s, (n+1)-s}`（n 为展开后人数）；
 * 偶数位（低半区）小种子在前、奇数位（高半区）大种子在前，即得标准赛程。
 * 例：size=16 → 1,16,9,8,5,12,13,4,3,14,11,6,7,10,15,2（相邻两两之和恒为 17）。
 */
function seedOrder(size) {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next = [];
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      const comp = n + 1 - s;
      if (i % 2 === 0) next.push(s, comp);
      else next.push(comp, s);
    }
    seeds = next;
  }
  return seeds;
}


/**
 * 生成对阵表（平铺满二叉树，节点索引从 0 开始）。
 * 叶节点存玩家，父节点存胜者 id。
 * bracket[i] = { playerId|null, matchId|null, winnerId|null, pair:[childIdx1, childIdx2] }
 */
function makeBracket(size, players) {
  // 构建完美二叉树（叶子数为 size）
  const nodes = [];
  const total = size * 2 - 1;
  for (let i = 0; i < total; i++) nodes.push({ playerId: null, matchId: null, winnerId: null, pair: null, index: i });
  const leafStart = size - 1; // 叶子节点起始索引（满二叉树）
  // ⚠️ P2 修复：按**标准种子布点**填叶，而不是按报名顺序连排。
  // `players` 是报名顺序，这里视作种子序（players[0] = 1 号种子）。
  // 旧实现直接 `nodes[leafStart+i] = players[i]` 会把空位全挤到叶序最右端 →
  // 首轮变成「某几个低种子接连轮空」，强弱分布极不均。改为按 `seedOrder(size)`
  // 把第 k 号种子放到指定叶位；种子号 > 参赛人数 的叶位留空（即轮空位），
  // 而标准布点让这些空位恰好与高种子相邻 → 高种子优先轮空。
  const order = seedOrder(size);
  for (let pos = 0; pos < size; pos++) {
    const p = players[order[pos] - 1] || null; // 种子号 → 报名顺序里的选手
    nodes[leafStart + pos].playerId = p ? p.id : null;
    nodes[leafStart + pos].name = p ? p.name : null;
  }
  // 从下往上建立父子关系
  for (let i = leafStart - 1; i >= 0; i--) {
    nodes[i].pair = [2 * i + 1, 2 * i + 2];
  }
  return nodes;
}


/**
 * 为可开赛的对局分配 matchId（对局 id，由 rooms.js 创建时回填）。
 * 遍历对阵树：父节点两个子节点都已确定参赛者、且父节点尚无对局/胜者 → 建房。
 */
/**
 * 为可开赛的对局分配 matchId；同时处理**轮空**（T3）。
 *
 * ⚠️ 必须**反复扫描到没有变化为止**，不能只走一趟：
 * `bracket` 是平铺满二叉树、**父节点索引小于子节点**，而 `for` 是正序。
 * 轮空会让"某个刚出现的晋级"继续往上传，而它的父节点在本次遍历中**已经走过了**——
 * 单趟遍历只能推进一级，表现为"轮空之后那一轮永远不开赛"。
 */
/**
 * 子树状态：`settled` = 这个节点的归属**已经不会再变**（比赛打完，或本来就空）；
 * `winner` = 该子树最终出来的人（没有则为 null）。
 *
 * ⚠️ 为什么轮空判定需要这个：**不能只看"某一方是否为空"**。
 * 以 4 人档 / 3 名选手为例——半决赛2（C vs 空位）轮空后，决赛的另一边（A vs B）**还没打**；
 * 若只看"另一边为空就判轮空"，决赛会把 C **直接判成冠军**。
 * 必须先确认两边都已定，才轮到"其中一边没有人"这个情形。
 */
function childState(nodes, idx) {
  const n = nodes[idx];
  if (!n) return { settled: true, winner: null };
  if (n.winnerId) return { settled: true, winner: n.winnerId };      // 已出结果
  if (!n.pair) return { settled: true, winner: n.playerId || null }; // 叶子（可能是空位）
  const a = childState(nodes, n.pair[0]);
  const b = childState(nodes, n.pair[1]);
  if (!a.settled || !b.settled) return { settled: false, winner: null };
  // 两子都已定：恰有一方有人 → 轮空晋级，本节点也定了；双方都有人 → 还要打，未定
  if (a.winner && b.winner) return { settled: false, winner: null };
  return { settled: true, winner: a.winner || b.winner };
}


function assignNextMatches(t) {
  if (!t || !t.bracket || !store.matchFactory) return 0;
  let created = 0;
  let changed = true;
  let guard = 0; // 树高最多 log2(32)=5，64 次足够；同时防意外死循环
  while (changed && guard++ < 64) {
    changed = false;
    for (const n of t.bracket) {
      if (n.winnerId || !n.pair) continue; // 已出结果 / 叶子
      if (n.matchId) continue;             // 已建房，等它打完

      const [c1, c2] = n.pair;
      const s1 = childState(t.bracket, c1);
      const s2 = childState(t.bracket, c2);
      if (!s1.settled || !s2.settled) continue; // 有一边还没定，轮不到本节点
      if (!s1.winner && !s2.winner) continue;   // 两边都空：这个分区本来就没人

      // ---- 轮空：恰有一方有人 → 直接判晋级，不建房 ----
      // 触发场景：报名人数不是 2 的幂（如 16 人档只来了 5 人 → 首轮多个空位）。
      if (!s1.winner || !s2.winner) {
        const solo = s1.winner || s2.winner;
        n.winnerId = solo;
        n.playerId = solo;
        addLog(t, { byRole: 'system', action: 'bye', detail: { node: n.index, playerId: solo } });

        // ⚠️ P1 修复：轮空可能**一路走到根**——当 `approved ≤ size/2` 时（lifecycle 只要求 ≥2 人开赛），
        // 根的两个子树会各自靠轮空推出胜者，根自己也是「一边空」，于是**根本没有一场决赛**。
        // 旧实现只写 winnerId、不判根 → championId 恒为 null、status 停在 playing，赛事永久卡死。
        // 这里与 `onMatchFinished` 的根收尾同源：是根就按状态机收尾（设冠军 / status=finished / endedAt / 日志）。
        const isRoot = !t.bracket.some((m) => m.pair && m.pair.includes(n.index));
        if (isRoot) {
          t.championId = solo;
          const r = transition(t, 'finished', {
            byRole: 'system', action: 'finish',
            detail: { championId: solo, decidedBy: 'bye' },
          });
          if (!r.ok) log.error('tournament', '淘汰赛轮空收尾失败', { tournamentId: t.id, error: r.error });
        }

        changed = true;
        continue;
      }

      // ---- 双方都有人 → 建房 ----
      n.players = [s1.winner, s2.winner];
      const res = store.matchFactory(t.id, n.players);
      if (res && res.roomId) {
        n.matchId = res.roomId;
        created++;
        changed = true;
      }
    }
  }
  if (created || changed) persist();
  return created;
}


/**
 * 由对局结束回调调用，推进对阵表。
 * @param {string} tournamentId
 * @param {string} matchId 房间/对局 id
 * @param {string} winnerId 胜者玩家 id
 */
function onMatchFinished(tournamentId, matchId, winnerId) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  // 赛事已被管理员取消：对局回调静默忽略（房间解散与本回调存在竞态）
  if (t.status === 'cancelled') return { ok: true, ignored: true };
  // T8：瑞士制是逐轮配对推进，与淘汰树的"向上传播"完全不同，走另一条路径
  if ((t.format || 'single-elimination') === 'swiss') {
    return swissOnMatchFinished(t, matchId, winnerId);
  }
  // 找到包含该 matchId 的节点，填入胜者
  let node = t.bracket.find((n) => n.matchId === matchId);
  if (!node) return { ok: false, error: '对局不属于该赛事' };
  if (winnerId === '-') {
    // ⚠️ 2026-10-02 审查 P1-5：淘汰赛出现和棋（千日手/持将棋）无法自动判胜负。
    // 旧实现根本收不到和棋回调（gameplay 只在有胜者时回调）；现改为「标记待裁决」：
    // 不写 winnerId、不向上传播，交管理员对本场重赛（否则该节点无人晋级）。
    node.draw = true;
    node.lastMatchId = matchId;
    node.lastPlayers = (node.players || []).slice();
    node.matchId = null;
    node.players = null;
    // ⚠️ 2026-10-02 体验修复（问题 1「赛事和棋要写入赛事日志」）：补 addLog。
    // 此前这里只往 logger 里 warn 一句，赛事详情页的「变更记录」里**什么都没有**——
    // 参赛者看到节点停在「待定」，分不清是"还没打完"还是"和棋卡住了"；管理员也无从知道
    // 该裁决哪一场（只能全表翻）。这里与瑞士制 `swissOnMatchFinished` 的 `match-result`
    // 用同一个 action + `draw` 标记，两条赛制的口径一致。
    addLog(t, {
      byRole: 'system', action: 'match-result',
      detail: { matchId, round: node.index, winnerId: '-', draw: true, players: node.lastPlayers },
    });
    try {
      require('../logger').warn('tournament', '淘汰赛对局和棋，需人工裁决', { tournamentId, matchId });
    } catch (_) { /* 日志失败不影响流程 */ }
    persist();
    return { ok: true, tournament: publicInfo(t), draw: true };
  }
  node.winnerId = winnerId;
  node.playerId = winnerId;
  // ⚠️ 清空之前把"这一场是谁打谁"留一份（T6/需求 12）：
  // 赛后选手要申请重赛，而重赛裁决**必须能核对申请人是不是本场选手**。
  // 只留 `lastMatchId` 而丢了名单，就无从验证"你有没有资格对这场申诉"。
  node.lastMatchId = matchId;
  node.lastPlayers = (node.players || []).slice();
  node.matchId = null;
  node.players = null;
  // 向上传播：父节点两个子节点都出胜者 → 安排下一轮对局
  const parent = t.bracket.find((n) => n.pair && n.pair.includes(node.index));
  if (!parent) {
    // 根节点已填 → 冠军产生。
    // ⚠️ P3 修复：改走状态机 `transition`（与瑞士制 `finishSwiss` 一致）——
    // 状态迁移合法性校验、`endedAt` 记录、操作日志都收敛到一处，不再直接改 `t.status` 绕过。
    t.championId = winnerId;
    const r = transition(t, 'finished', {
      byRole: 'system', action: 'finish',
      detail: { championId: winnerId },
    });
    if (!r.ok) log.error('tournament', '淘汰赛收尾失败', { tournamentId, error: r.error });
    persist();
    return { ok: true, tournament: publicInfo(t), finished: true };
  }
  assignNextMatches(t);
  persist();
  return { ok: true, tournament: publicInfo(t) };
}

module.exports = {
  liveMatchIds,
  makeBracket,
  childState,
  assignNextMatches,
  onMatchFinished,
};
