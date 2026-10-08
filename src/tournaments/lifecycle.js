/**
 * tournaments/lifecycle.js — 赛前生命周期（建赛 / 审批 / 报名 / 踢人 / 开赛 / 作废 / 冠军）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const swiss = require('../swiss');
const ratings = require('../ratings');
const { genId } = require('../auth');
const log = require('../logger');
const { getCache, persist, SIZE_OPTIONS, FORMATS, MIN_SWISS_ROUNDS, MAX_SWISS_ROUNDS, numOrNull, validateSchedule, addLog } = require('./store');
const { roleOf, normalizeStatus, transition, canManage } = require('./rules');
const { startSwissRound, voidPlayerSwiss, publicInfo } = require('./swiss-flow');
const { liveMatchIds, makeBracket, childState, assignNextMatches } = require('./bracket');


/**
 * 创建赛事（需登录正式账号，由 protocol 层校验后传入 owner）。
 *
 * T1 起支持完整**建赛申请表**（需求 9）。所有字段都**在服务端重新校验一遍**——
 * 前端校验只防手滑，防不了直接构造 WS 消息的人。
 *
 * @param {string} name
 * @param {number} size 4 / 8 / 16 / 32
 * @param {{id:string, name:string}} owner
 * @param {object} [opts] 申请表字段，全部可选（老调用方只传 name+size 仍可用）
 *   - `reason`           举办理由
 *   - `registerStart` / `registerEnd`  报名起止（时间戳）
 *   - `matchStart` / `matchEnd`        比赛起止（时间戳）
 *   - `format`           赛制，当前仅 `'single-elimination'`
 *   - `requireApproval`  报名是否需主办人批准，**默认 true**
 */
function createTournament(name, size, owner, opts) {
  const o = opts || {};

  // 等级特权（2026-09-20 用户要求）：举办赛事需要达到 `LEVEL_PRIVILEGES.create_tournament`。
  // ⚠️ 判定放在这里（而不是 protocol / HTTP 路由层）：`createTournament` 是所有入口的必经之路，
  // 放一层就等于"以后新增一个建赛入口时又得记得补一遍"。
  if (owner && owner.id && !ratings.hasPrivilege(owner.id, 'create_tournament')) {
    const need = ratings.LEVEL_PRIVILEGES.create_tournament;
    return {
      ok: false,
      code: 'LEVEL_REQUIRED',
      needLevel: need,
      error: `举办赛事需要 Lv.${need}（你当前 Lv.${ratings.levelOf(owner.id)}）`,
    };
  }

  if (!SIZE_OPTIONS.includes(size)) return { ok: false, error: `参赛人数必须为 ${SIZE_OPTIONS.join(' / ')}` };

  const format = o.format || 'single-elimination';
  if (!FORMATS.includes(format)) return { ok: false, error: '暂不支持该赛制' };

  // 瑞士制总轮数（T8）：不填则按人数给建议值（max(3, ceil(log2(n)))）。
  // ⚠️ 必须在这里定死并存下来——轮数是赛程的一部分，中途改会让已打的轮次失去意义。
  let totalRounds = null;
  if (format === 'swiss') {
    const wanted = Math.round(Number(o.totalRounds) || 0);
    totalRounds = wanted || swiss.suggestRounds(size);
    if (totalRounds < MIN_SWISS_ROUNDS || totalRounds > MAX_SWISS_ROUNDS) {
      return { ok: false, error: `瑞士制轮数需在 ${MIN_SWISS_ROUNDS}~${MAX_SWISS_ROUNDS} 之间` };
    }
  }

  const regStart = numOrNull(o.registerStart);
  const regEnd = numOrNull(o.registerEnd);
  const matchStart = numOrNull(o.matchStart);
  const matchEnd = numOrNull(o.matchEnd);
  const timeErr = validateSchedule({ regStart, regEnd, matchStart, matchEnd });
  if (timeErr) return { ok: false, error: timeErr };

  const tournaments = getCache();
  const id = genId().slice(0, 8);
  tournaments[id] = {
    id,
    name: String(name || '未命名赛事').slice(0, 20),
    size,
    format,
    status: 'pending_approval', // 见文件头状态机
    ownerId: owner ? owner.id : null,
    ownerName: owner ? owner.name : null, // 快照：账号可能被删除
    createdAt: Date.now(),

    // ---- 建赛申请表（需求 9）----
    reason: String(o.reason || '').trim().slice(0, 200),
    registerStart: regStart,
    registerEnd: regEnd,
    matchStart,
    matchEnd,
    requireApproval: o.requireApproval !== false, // 默认**需要审核**（Q2 用户确认）

    // ---- 报名池（T1 两段式：开赛时把 approved 冻结进 players）----
    // ⚠️ 主办人**不自动参赛**（2026-09-13 用户要求）：办赛与参赛是两件事。
    // 早先的实现会把主办人直接塞进 players，导致"报名人数"里永远混着一个
    // 从没报过名的人，也让"未满员轮空"的判定失真。想下棋就自己去报名。
    entrants: [],
    players: [],   // [{id, name}]

    // ---- 单败淘汰 ----
    bracket: [],   // 对阵表（平铺树），见 makeBracket

    // ---- 瑞士制（T8）----
    // ⚠️ 瑞士制**没有淘汰树**：每轮重新按积分配对，所以不能复用 `bracket`。
    // `rounds[i] = { round, pairs:[[idA,idB]], byes:[id], results:{'a|b':winnerId},
    //                matchIds:[roomId], degraded, reason }`
    // `matchIds` 与 `pairs` 同下标一一对应（建房失败的位置是 null）。
    totalRounds,
    rounds: [],
    currentRound: 0,   // 0 = 尚未开赛

    championId: null,
    championManual: false, // 是否为主办人/管理员手动指定（需求 10）
    rematches: [],         // 重赛申请（需求 10/12）
    logs: [],              // 管理动作留痕（见 addLog）
    matchIds: [],          // 本赛事产生的全部房间 id（赛事棋谱聚合用，需求 12）

    endedAt: null,
    archivedAt: null,      // 存档（需求 11）
    adminEditLog: [],      // 存档后管理员编辑记录
  };
  addLog(tournaments[id], {
    byId: owner ? owner.id : null, byName: owner ? owner.name : null, byRole: 'owner', action: 'create',
  });
  persist();
  return { ok: true, tournament: publicInfo(tournaments[id]) };
}


/**
 * 管理员审核：通过 → open 进入报名。
 */
function approveTournament(id, reviewer = 'admin') {
  const t = getCache()[id];
  if (!t) return { ok: false, error: '赛事不存在' };
  // 走 transition：状态合法性由状态机表判定，不再各函数自己写 if
  const r = transition(t, 'registration', { byRole: 'admin', action: 'approve' });
  if (!r.ok) return r;
  t.reviewedAt = Date.now();
  t.reviewedBy = reviewer;
  persist();
  return { ok: true, tournament: publicInfo(t) };
}


/**
 * 管理员审核：拒绝。
 */
function rejectTournament(id, reason = '', reviewer = 'admin') {
  const t = getCache()[id];
  if (!t) return { ok: false, error: '赛事不存在' };
  const r = transition(t, 'rejected', { byRole: 'admin', action: 'reject', detail: { reason } });
  if (!r.ok) return r;
  // T1：拒绝原因改存 `rejectReason` —— `reason` 这个字段让给"举办理由"（需求 9），
  // 两者语义完全不同，不能共用（旧数据里的 reason 由 publicInfo 按状态归位）。
  t.rejectReason = String(reason || '').slice(0, 200);
  t.reviewedAt = Date.now();
  t.reviewedBy = reviewer;
  persist();
  return { ok: true, tournament: publicInfo(t) };
}


/**
 * 管理员取消：open/playing → cancelled。
 * 返回仍在进行中的对局房间 id，由调用方（server 路由）经 rooms 层解散，
 * 避免 tournaments↔rooms 循环依赖。
 */
function cancelTournament(id, reason = '') {
  const t = getCache()[id];
  if (!t) return { ok: false, error: '赛事不存在' };
  const matchIds = liveMatchIds(t);
  // 状态机已限定"只能从 registration / playing 取消"，finished/archived 一律拒绝——
  // 这正是需求 11「主办人结束后不能取消赛事」在数据层的落实（与 canManage 同一口径）。
  const r = transition(t, 'cancelled', { byRole: 'system', action: 'cancel', detail: { reason } });
  if (!r.ok) return r;
  t.rejectReason = String(reason || '').slice(0, 200);
  for (const n of t.bracket || []) n.matchId = null;
  for (const rec of t.rounds || []) rec.matchIds = (rec.matchIds || []).map(() => null);
  persist();
  return { ok: true, tournament: publicInfo(t), matchIds };
}


/** 已通过审核的报名人数 = 实际参赛人数（T3：名额按这个算，不是按报名总数） */
function approvedCount(t) {
  return (t.entrants || []).filter((e) => e.status === 'approved').length;
}


/** 从报名池取某个人的记录 */
function entrantOf(t, playerId) {
  return (t.entrants || []).find((e) => e.id === playerId) || null;
}


/**
 * 报名（T3 两段式）。
 *
 * `requireApproval` 决定走向：
 *  - `false` → 报名即参赛（`status='approved'`）
 *  - `true`  → 进报名池等主办人批准（`status='pending'`）
 *
 * ⚠️ **名额按 `approved` 计**，不是按报名总数——否则"待审核的人"会把名额占满，
 * 真正被批准的反而报不进来。
 *
 * @returns {{ok:boolean, tournament?:object, pending?:boolean, error?:string}}
 */
function joinTournament(tournamentId, player) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (normalizeStatus(t.status) !== 'registration') return { ok: false, error: '赛事已开赛或结束' };

  const entrants = t.entrants || (t.entrants = []);
  const mine = entrants.find((e) => e.id === player.id);
  if (mine) {
    if (mine.status === 'kicked') return { ok: false, error: '你已被主办人移出本赛事' };
    if (mine.status === 'rejected') return { ok: false, error: '你的报名已被拒绝' };
    return { ok: false, error: mine.status === 'pending' ? '报名已提交，等待主办人批准' : '你已报名本赛事' };
  }
  if (approvedCount(t) >= t.size) return { ok: false, error: '赛事名额已满' };

  const auto = t.requireApproval === false;
  entrants.push({ id: player.id, name: player.name, at: Date.now(), status: auto ? 'approved' : 'pending' });
  addLog(t, {
    byId: player.id, byName: player.name, byRole: 'player',
    action: 'join', detail: { auto },
  });

  // 免审核 + 已满员 → 自动开赛（保留原有的"满员自动开赛"体验）
  const started = auto && approvedCount(t) >= t.size;
  if (started) startTournament(tournamentId, { byRole: 'system', action: 'start', detail: { reason: 'full' } });

  persist();
  return { ok: true, tournament: publicInfo(t), pending: !auto, started };
}


/**
 * 批准 / 拒绝报名（需求 10）。
 *
 * @param {'approve'|'reject'} decision
 * @param {{id?:string, isAdmin?:boolean}} actor
 * @returns {{ok:boolean, tournament?:object, started?:boolean, error?:string}}
 */
function decideEntrant(tournamentId, playerId, decision, actor) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!canManage(t, actor, 'decide_entrant')) return { ok: false, error: '没有权限' };

  const e = entrantOf(t, playerId);
  if (!e) return { ok: false, error: '该玩家不在报名名单中' };
  if (e.status !== 'pending') return { ok: false, error: '该报名已处理过' };

  e.decidedAt = Date.now();
  let started = false;

  if (decision === 'approve') {
    if (approvedCount(t) >= t.size) return { ok: false, error: '名额已满' };
    e.status = 'approved';
    addLog(t, { byId: actor.id, byRole: roleOf(t, actor), action: 'entrant-approve', detail: { playerId } });
    // 批准后正好满员 → 自动开赛（与免审核路径保持一致的手感）
    if (approvedCount(t) >= t.size) {
      started = !!startTournament(tournamentId, { byRole: 'system', action: 'start', detail: { reason: 'full' } }).ok;
    }
  } else {
    e.status = 'rejected';
    addLog(t, { byId: actor.id, byRole: roleOf(t, actor), action: 'entrant-reject', detail: { playerId } });
  }

  persist();
  return { ok: true, tournament: publicInfo(t), started };
}


/**
 * 踢出报名者（需求 10）。**仅报名阶段**可用。
 *
 * 已开赛的情况刻意不在这里处理：那时该选手已经进了对阵表，移除他必须连带
 * 处理"已赛结果怎么办、对手是否晋级"——那是「取消选手成绩」（T4）的语义。
 * 两个操作职责分开，比让一个函数按状态走两套分支清楚得多。
 */
function kickPlayer(tournamentId, playerId) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (normalizeStatus(t.status) !== 'registration') {
    return { ok: false, error: '已开赛，请使用「取消选手成绩」' };
  }
  const e = entrantOf(t, playerId);
  if (!e) return { ok: false, error: '该玩家不在报名名单中' };
  if (e.status === 'kicked') return { ok: false, error: '该玩家已被移出' };

  e.status = 'kicked';
  e.decidedAt = Date.now();
  persist();
  return { ok: true, tournament: publicInfo(t) };
}


/**
 * 清空某节点**所有祖先**的胜负标记（改判后必须重算）。
 *
 * ⚠️ 从**父节点**开始清，**绝不动传入节点自己**：调用方刚把新结果设在它身上，
 * 顺手连它一起清会把改判结果一起抹掉（本次就踩了这个坑，表现为
 * "取消成绩后 winnerId 变成了 null 而不是对手"）。
 *
 * ⚠️ 为什么祖先必须清：一个节点的结果变了，它上面整条通往决赛的路径就都失效了。
 * 不清的话，赛事会出现"两个人都像在冠军路径上"，冠军甚至可能仍是已被取消成绩的选手。
 * `matchId` 这里不动（房间重建交给 `assignNextMatches`）。
 */
function clearUpstream(t, idx) {
  const bracket = t.bracket || [];
  let parent = bracket.find((x) => x.pair && x.pair.includes(idx));
  let guard = 0;
  while (parent && guard++ < 64) {
    parent.winnerId = null;
    parent.playerId = null;
    const asChild = parent.index;
    parent = bracket.find((x) => x.pair && x.pair.includes(asChild));
  }
}


/**
 * 取消选手成绩（需求 10）：该选手**所有对局一律判对手胜**，并重算下游。
 *
 * 与「踢出报名者」的分工：那个只管报名阶段（人还没进对阵表），这个管开赛后。
 *
 * @returns {{ok:boolean, tournament?:object, affected?:number, error?:string}}
 */
function voidPlayer(tournamentId, playerId, actor) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!canManage(t, actor, 'void_player')) return { ok: false, error: '没有权限' };
  if (!(t.players || []).some((p) => p.id === playerId)) {
    return { ok: false, error: '该选手不在参赛名单中' };
  }

  // T8：瑞士制没有"上游"可清，改判的后果也不同（见 voidPlayerSwiss 的注释）
  if ((t.format || 'single-elimination') === 'swiss') {
    return voidPlayerSwiss(t, playerId, actor);
  }

  let affected = 0;
  // ⚠️ 自底向上（高索引 → 根）：先作废叶子侧对局、再处理父节点。
  // 若先写根再 clearUpstream（来自子节点），根的改判会被抹掉，
  // 表现为「决赛判负后 winnerId 又变回 null」。
  const nodes = t.bracket || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node || !node.pair) continue; // 叶子不是对局

    // ⚠️ 对手必须从**子树胜者**推，**不能**从 `node.players` 取：
    // 对局一结束 `onMatchFinished` 就会把 `players` 清空（房间已结束、名单无用），
    // 那时 `players.find(p => p !== me)` 得到 undefined → 被当成"这里本来就空着"→
    // 结果是把这一场**作废**而不是"判对手胜"，还会顺手重新建一场房（本次踩过）。
    // 子树胜者才是真正站在这一场两边的人。
    const s1 = childState(t.bracket, node.pair[0]);
    const s2 = childState(t.bracket, node.pair[1]);
    const involved = s1.winner === playerId || s2.winner === playerId || node.playerId === playerId;
    if (!involved) continue;

    const foe = s1.winner === playerId ? s2.winner
      : (s2.winner === playerId ? s1.winner : null);

    node.winnerId = foe;   // 判对手胜（`foe` 为 null 表示这一场本就无人可判）
    node.playerId = foe;
    node.matchId = null;   // 该场已判负：房间作废，不能留着"进行中"
    affected++;
    clearUpstream(t, node.index); // 成绩一变，往上整条路都要重算

    // ⚠️ 根节点被直接判胜 → 必须收尾（与 bracket.js 轮空收尾同源）。
    // 否则 assignNextMatches 见根已有 winnerId 会跳过，赛事永远卡在 playing
    // （症状与 P1-2 轮空不收尾相同）。
    const isRoot = !((t.bracket || []).some((m) => m.pair && m.pair.includes(node.index)));
    if (isRoot && foe && !t.championId) {
      t.championId = foe;
      const fr = transition(t, 'finished', {
        byId: actor.id, byRole: roleOf(t, actor),
        action: 'finish',
        detail: { championId: foe, decidedBy: 'void-player' },
      });
      if (!fr.ok) log.error('tournament', '取消成绩后根节点收尾失败', { tournamentId, error: fr.error });
    }
  }

  // 被取消成绩的人可能已经站在冠军位上 → 退掉冠军并**回退到进行中**（P3）。
  // 与 `decideRematch`（archive.js）保持一致：只清 championId 而不回退状态，
  // 会让赛事停在 `finished` 却没了冠军——既不能再走收尾、也进不了存档，等于卡死。
  if (t.championId === playerId) {
    t.championId = null;
    t.championManual = false;
    t.endedAt = null;
    if (normalizeStatus(t.status) === 'finished') t.status = 'playing';
  }

  addLog(t, {
    byId: actor.id, byRole: roleOf(t, actor),
    action: 'void-player', detail: { playerId, affected },
  });

  assignNextMatches(t); // 空出来的位置可能触发轮空/新建房
  persist();
  return { ok: true, tournament: publicInfo(t), affected };
}


/**
 * 设置冠军（需求 10）。
 *
 * ⚠️ **仅管理员**：需求原文写的是"主办人可设置冠军"，已被用户 2026-09-13
 * 明确修正为**只有管理员**（见 `ACTION_ROLES.set_champion`）。
 * 用于"对阵已打完但赛事还没自动收尾"或"冠军需要人工裁定"的场景。
 */
function setChampion(tournamentId, playerId, actor) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!canManage(t, actor, 'set_champion')) {
    return { ok: false, error: '没有权限（设置冠军仅管理员可操作）' };
  }

  const inPlayers = (t.players || []).some((p) => p.id === playerId)
    || (t.entrants || []).some((e) => e.id === playerId && e.status === 'approved');
  if (!inPlayers) return { ok: false, error: '该选手不在参赛名单中' };

  // ⚠️ 2026-10-02 体验修复：报名阶段不能设冠军——registration→finished 非法，
  // 此前会写入一个哪里都不显示的「幽灵冠军」。改为：必须能推进到 finished 才接受，否则回滚并报错。
  const prev = { championId: t.championId, championManual: t.championManual, endedAt: t.endedAt };
  t.championId = playerId;
  t.championManual = true; // 标记为人工裁定，避免被自动收尾覆盖
  t.endedAt = t.endedAt || Date.now();
  if (normalizeStatus(t.status) !== 'finished') {
    let tr;
    try {
      tr = transition(t, 'finished', {
        byId: actor.id, byRole: 'admin', action: 'set-champion-finish', detail: { playerId },
      });
    } catch (e) { tr = { ok: false }; }
    if (!tr || tr.ok === false) {
      t.championId = prev.championId;
      t.championManual = prev.championManual;
      t.endedAt = prev.endedAt;
      return { ok: false, error: '当前赛事状态还不能设置冠军（需已开赛且对阵结束）' };
    }
  }
  addLog(t, { byId: actor.id, byRole: 'admin', action: 'set-champion', detail: { playerId } });
  persist();
  return { ok: true, tournament: publicInfo(t) };
}


/**
 * 开赛（T3）：把**已通过审核**的报名者冻结进 `players`，生成对阵表并安排首轮。
 *
 * 为什么必须有"冻结"这一步：报名池是活的（有人刚被批准、有人被踢），
 * 而对阵表一旦生成就必须对应**一份固定的参赛名单**——不冻结的话，
 * 开赛后批准一个新报名，名单与对阵表就对不上了。
 *
 * @param {object} [logEntry] 记日志用（自动开赛 vs 主办人手动开赛要能区分）
 * @returns {{ok:boolean, error?:string, tournament?:object}}
 */
function startTournament(tournamentId, logEntry) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };

  const approved = (t.entrants || [])
    .filter((e) => e.status === 'approved')
    .map((e) => ({ id: e.id, name: e.name }));

  if (approved.length < 2) return { ok: false, error: '至少需要 2 名通过审核的参赛者才能开赛' };

  const r = transition(t, 'playing', logEntry || { byRole: 'system', action: 'start' });
  if (!r.ok) return r;

  t.players = approved;

  if ((t.format || 'single-elimination') === 'swiss') {
    // 瑞士制（T8）：**没有对阵树**，开赛就是"配第一轮"。
    // 人数不必是 2 的幂——配对算法自己会处理奇数（最低分且未轮空者轮空）。
    t.bracket = [];
    t.rounds = [];
    t.currentRound = 0;
    startSwissRound(t, 1);
  } else {
    // 未满员也允许开赛：`makeBracket` 会让多余的叶位留空（playerId = null），
    // 由 `assignNextMatches` 的轮空分支直接判晋级（T3）。
    t.bracket = makeBracket(t.size, approved);
    assignNextMatches(t);
  }

  persist();
  return { ok: true, tournament: publicInfo(t) };
}

module.exports = {
  createTournament,
  approveTournament,
  rejectTournament,
  cancelTournament,
  approvedCount,
  entrantOf,
  joinTournament,
  decideEntrant,
  kickPlayer,
  clearUpstream,
  voidPlayer,
  setChampion,
  startTournament,
};
