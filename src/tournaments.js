/**
 * tournaments.js — 赛事（单败淘汰）
 *
 * 设计文档：`docs/TOURNAMENT.md`（数据模型 / 权限矩阵 / 状态机 / T1–T8 阶段）。
 * 本文件在 **T1** 阶段扩充为完整模型；报名池、赛后存档、权限判定都在此收敛。
 *
 * ## 状态机（2026-09-13，T1）
 *
 * ```
 * pending_approval ──approve──→ registration ──开赛──→ playing ──出结果──→ finished ──→ archived
 *        │                          │                    │                    │
 *        └──reject──→ rejected      └────cancel───────→ cancelled ←──cancel────┘
 * ```
 *  - `registration`：报名中（原 `open`，**读旧数据时映射**，见 `normalizeStatus()`）
 *  - `archived`：已存档——主办人只读、仅管理员可编辑（每次编辑写 `adminEditLog`）
 *  - `finished` 仍有收尾窗口，主办人在此阶段**仍可**操作；进 `archived` 后不行
 *
 * ⚠️ **所有管理动作的权限判定只允许存在于一处**：`canManage()`。
 * 这是 §Q7-1 越权事故的直接教训——当年每个管理接口各抄一份判定，
 * 「新增接口忘记校验」就成了一个静默存在的错误类别。
 *
 * 赛事对局复用房间对局基础设施（rooms.js），对局结束后通过回调推进。
 * 数据以 tournaments.json 落盘（经 storage kv 兼容层）。
 */
'use strict';

const log = require('./logger');

const { readJson, writeJson } = require('./storage');
const { genId } = require('./auth');
// T8：瑞士制的配对与积分是**纯函数**（`src/swiss.js`），与赛事状态解耦——
// 配对算法的正确性靠那 12 项单测钉死，这里只负责"把状态喂进去、把结果存下来"。
const swiss = require('./swiss');

function loadTournaments() {
  const data = readJson('tournaments.json', {});
  return data && typeof data === 'object' ? data : {};
}

let cache = null;
function getCache() {
  if (!cache) cache = loadTournaments();
  return cache;
}
function persist() {
  writeJson('tournaments.json', getCache());
}

// 4–32 且为 2 的幂（Q3 用户确认）：保证对阵树是完美二叉树，不会出现「首轮轮空位」的复杂情形
const SIZE_OPTIONS = [4, 8, 16, 32];
// 赛制（T8）：单败淘汰 + 瑞士制。循环赛需求原文未要求，暂不做。
const FORMATS = ['single-elimination', 'swiss'];
const FORMAT_LABELS = { 'single-elimination': '单败淘汰', swiss: '瑞士制（积分编排）' };
/** 瑞士制轮数区间：少于 3 轮区分度太差，多于 9 轮对 32 人档也没有必要 */
const MIN_SWISS_ROUNDS = 3;
const MAX_SWISS_ROUNDS = 9;

/** 把可能是字符串/空值的时间字段归一化为时间戳或 null */
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 时间字段自洽校验。
 * **服务端必须再验一遍**——前端校验只防手滑，防不了直接构造 WS 消息的人。
 * @returns {string|null} 错误说明；null = 通过
 */
function validateSchedule(s) {
  const { regStart, regEnd, matchStart, matchEnd } = s || {};
  if (regStart && regEnd && regStart >= regEnd) return '报名结束时间必须晚于报名开始时间';
  if (matchStart && matchEnd && matchStart >= matchEnd) return '比赛结束时间必须晚于比赛开始时间';
  if (regEnd && matchStart && matchStart < regEnd) return '比赛开始时间不能早于报名结束时间';
  return null;
}

/**
 * 追加一条操作日志（T1）。
 *
 * 需求 10/11 涉及大量管理动作（踢人、取消成绩、审重赛、设冠军、存档后编辑…），
 * **日志是事后追责与排障的唯一依据**——尤其是"取消选手成绩"这类直接影响比赛结果的操作。
 * 只保留最近 200 条：赛事生命周期有限，没必要无限增长。
 */
function addLog(t, entry) {
  if (!t) return;
  if (!Array.isArray(t.logs)) t.logs = [];
  t.logs.push(Object.assign({ at: Date.now() }, entry || {}));
  if (t.logs.length > 200) t.logs.shift();
}

// 建房工厂：由 rooms.js 注入，避免循环依赖
// (tournamentId, playerIds) => { roomId } | null
let matchFactory = null;
function setMatchFactory(fn) {
  matchFactory = fn;
}

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

// ==================================================================
// 管理操作（需求 10）
// ⚠️ 每个操作**第一步都是 canManage()** —— 不要在别处再写一遍权限判断，
// 那正是 §Q7-1 越权的成因（同一判定散落多处，迟早漏掉一处）。
// ==================================================================

/** 操作者角色（写日志用）：管理员优先 */
function roleOf(t, actor) {
  return (actor && actor.isAdmin) ? 'admin' : 'owner';
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
  for (const node of t.bracket || []) {
    if (!node.pair) continue; // 叶子不是对局

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
  }

  // 被取消成绩的人可能已经站在冠军位上
  if (t.championId === playerId) t.championId = null;
  t.championManual = false;

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

  t.championId = playerId;
  t.championManual = true; // 标记为人工裁定，避免被自动收尾覆盖
  t.endedAt = t.endedAt || Date.now();
  addLog(t, { byId: actor.id, byRole: 'admin', action: 'set-champion', detail: { playerId } });
  persist();
  return { ok: true, tournament: publicInfo(t) };
}

// ==================================================================
// 赛后存档与管理员编辑（T6 / 需求 11）
// ==================================================================

/** 赛后收尾窗口：决赛出结果后多久自动存档（小时）。留窗口是给申诉/重赛留时间 */
const ARCHIVE_AFTER_HOURS = 24;

/**
 * 存档赛事：**仅管理员**。
 *
 * 存档后主办人**只读**（`canManage` 里已按状态拦下，不是靠这里），
 * 管理员仍可编辑，但每次编辑写 `adminEditLog`。
 */
function archiveTournament(tournamentId, actor) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!canManage(t, actor, 'archive')) return { ok: false, error: '没有权限（存档仅管理员可操作）' };

  const r = transition(t, 'archived', {
    byId: actor.id, byRole: 'admin', action: 'archive', detail: { manual: true },
  });
  if (!r.ok) return r;
  t.archivedAt = Date.now();
  persist();
  return { ok: true, tournament: publicInfo(t) };
}

/**
 * 扫描并自动存档到期的赛事（T6/需求 11）。
 *
 * 到期条件：`finished` 且距 `endedAt` 超过 `ARCHIVE_AFTER_HOURS`。
 * **由 server 定时调用**（启动时先跑一次，防止进程重启期间错过窗口）。
 *
 * @param {number} [now] 便于测试注入时间
 * @returns {number} 本次存档的赛事数
 */
function autoArchiveDue(now = Date.now()) {
  const cache = getCache();
  const due = Object.values(cache).filter((t) => (
    normalizeStatus(t.status) === 'finished'
    && t.endedAt
    && (now - t.endedAt) >= ARCHIVE_AFTER_HOURS * 3600 * 1000
  ));
  let n = 0;
  for (const t of due) {
    const r = transition(t, 'archived', { byRole: 'system', action: 'archive', detail: { auto: true } });
    if (r.ok) { t.archivedAt = now; n++; }
  }
  if (n) {
    persist();
    log.info('tournament', `自动存档 ${n} 个已结束赛事（超过 ${ARCHIVE_AFTER_HOURS} 小时）`);
  }
  return n;
}

/**
 * 编辑已存档赛事（T6/需求 11）：**仅管理员**，且**仅 `archived`**。
 *
 * 允许改的字段刻意收窄到"结论性信息"：冠军、备注。
 * 每改一次写 `adminEditLog`（`{ at, byId, field, from, to, note }`），
 * 详情页对管理员显示"编辑历史"——赛后改结论必须留痕，否则无法追溯。
 *
 * @param {'championId'|'note'} field
 */
function editArchived(tournamentId, field, value, actor, note) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!canManage(t, actor, 'edit_archived')) {
    return { ok: false, error: '没有权限（仅管理员可编辑已存档赛事）' };
  }

  const EDITABLE = ['championId', 'note'];
  if (EDITABLE.indexOf(field) < 0) return { ok: false, error: `不可编辑字段：${field}` };

  let next = value;
  if (field === 'championId') {
    next = value || null;
    if (next && !(t.players || []).some((p) => p.id === next)) {
      return { ok: false, error: '该选手不在参赛名单中' };
    }
  } else {
    next = String(value == null ? '' : value).slice(0, 300);
  }

  const before = t[field] == null ? null : t[field];
  if (before === next) return { ok: false, error: '内容没有变化' };

  t[field] = next;
  t.adminEditLog = t.adminEditLog || [];
  t.adminEditLog.push({
    at: Date.now(),
    byId: (actor && actor.id) || null,
    field,
    from: before,
    to: next,
    note: String(note || '').slice(0, 200),
  });
  if (field === 'championId') t.championManual = !!next; // 改过冠军 = 人工裁定
  persist();
  return { ok: true, tournament: publicInfo(t) };
}

// ==================================================================
// 重赛（T6 / 需求 12）
// ==================================================================

/**
 * 参赛者申请重赛。**仅该场比赛的两名选手之一**可发起。
 *
 * ⚠️ 这里**不能**只判 `canManage(t, actor, 'request_rematch')`：那个判定只回答
 * "你是不是本赛事的参赛者"，回答不了"**这一场**是不是你打的"——
 * 少了后半句，任何一个参赛者都能对别人的对局提申诉。
 *
 * ⚠️ 用 `lastMatchId` 而非 `matchId` 定位：对局一结束 `matchId` 就被清空了
 * （房间已回收），而申诉恰恰是在**赛后**提出的。
 *
 * @returns {{ok:boolean, rematch?:object, tournament?:object, error?:string}}
 */
function requestRematch(tournamentId, matchId, reason, player) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!player || !player.id) return { ok: false, error: '需要登录' };
  if (normalizeStatus(t.status) !== 'playing') return { ok: false, error: '赛事不在进行中，无法申请重赛' };

  const info = matchParticipants(t, matchId);
  if (!info) return { ok: false, error: '这一场不属于该赛事' };
  if (info.players.indexOf(player.id) < 0) return { ok: false, error: '只有本场参赛者可以申请重赛' };

  // ⚠️ 瑞士制只允许对**当前轮**申请重赛：前面轮次的结果是后面配对的依据，
  // 改掉它会让"已经开打甚至打完的后续轮次"失去依据（那些房间还活着，收回代价很大）。
  // 与其做一个半吊子的"改历史"，不如明确拒绝。
  if (info.round != null && info.round < (t.currentRound || 0)) {
    return { ok: false, error: `只能对当前第 ${t.currentRound} 轮申请重赛（之前的轮次是后续配对的依据）` };
  }

  const list = t.rematches || (t.rematches = []);
  if (list.some((r) => r.matchId === matchId && r.status === 'pending')) {
    return { ok: false, error: '该场的重赛申请已在处理中' };
  }

  const rm = {
    id: `rm${Date.now().toString(36)}${(list.length + 1).toString(36)}`,
    nodeIndex: info.index != null ? info.index : null,
    round: info.round != null ? info.round : null,
    pair: info.players.slice(), // 存下这一场是谁打谁（瑞士制没有节点可查）
    matchId,
    byId: player.id,
    byName: player.name || null,
    reason: String(reason || '').slice(0, 200),
    status: 'pending',
    at: Date.now(),
  };
  list.push(rm);
  addLog(t, {
    byId: player.id, byName: player.name, byRole: 'player',
    action: 'rematch-request', detail: { matchId, node: rm.nodeIndex, round: rm.round },
  });
  persist();
  return { ok: true, rematch: rm, tournament: publicInfo(t) };
}

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

/**
 * 批准瑞士制重赛：抹掉那一场的赛果并重建房间。
 *
 * ⚠️ **不做"丢弃后续轮次"那件事**：调用前已经限制过"只能对当前轮申请"，
 * 所以当前轮之后本来就没有轮次。少了那个前提，这里就得去收掉已经开打的房间——
 * 那是另一个量级的复杂度，不如把规则收紧。
 *
 * 重置后本轮会变成"未凑齐"，等这一场重打完自然会推进（`maybeAdvanceSwiss`）。
 */
function approveSwissRematch(t, rm) {
  const rec = (t.rounds || []).find((r) => r.round === rm.round);
  if (!rec) return { ok: false, error: '该轮次已不存在' };
  if (rec.round !== (t.currentRound || 0)) {
    return { ok: false, error: '只能重赛当前轮' };
  }
  // 申请时是 playing，但主办人可能拖到赛事收尾后才裁决。
  // 这里**直接拒绝**而不是把 finished 退回 playing：瑞士制的冠军是按名次算出来的，
  // 退回意味着冠军要被收回，而"已经宣布的冠军被悄悄撤掉"比"拒绝重赛"伤害更大。
  if (normalizeStatus(t.status) !== 'playing') {
    return { ok: false, error: '赛事已收尾，无法重赛' };
  }

  const pair = rm.pair || [];
  const key = swiss.pairKey(pair[0], pair[1]);
  const pi = (rec.pairs || []).findIndex(([a, b]) => swiss.pairKey(a, b) === key);
  if (pi < 0) return { ok: false, error: '这一场已不在该轮次中' };

  delete rec.results[key];
  rec.matchIds[pi] = null;

  const pa = (t.players || []).find((x) => x.id === pair[0]) || { id: pair[0], name: '?' };
  const pb = (t.players || []).find((x) => x.id === pair[1]) || { id: pair[1], name: '?' };
  const res = matchFactory ? matchFactory(t.id, [pa, pb]) : null;
  rec.matchIds[pi] = (res && res.roomId) ? res.roomId : null;
  if (!rec.matchIds[pi]) {
    log.error('tournament', '重赛建房失败', { tournamentId: t.id, round: rec.round, pair });
  }
  return { ok: true };
}

/**
 * 裁决重赛申请（需求 10）：主办人 / 管理员。
 *
 * 批准 = **作废该场结果**并重建这一局：清掉节点胜负与上游，
 * 再由 `assignNextMatches` 依据子树重新推双方、重新建房
 * （所以这里**不需要**自己恢复 `players`——它会重算，手动塞反而可能与子树不一致）。
 * 若冠军正是由这条路径产生的，一并退掉，赛事回到进行中。
 */
function decideRematch(tournamentId, rematchId, decision, actor, note) {
  const t = getCache()[tournamentId];
  if (!t) return { ok: false, error: '赛事不存在' };
  if (!canManage(t, actor, 'decide_rematch')) return { ok: false, error: '没有权限' };

  const rm = (t.rematches || []).find((r) => r.id === rematchId);
  if (!rm) return { ok: false, error: '重赛申请不存在' };
  if (rm.status !== 'pending') return { ok: false, error: '该申请已处理过' };

  rm.status = decision === 'approve' ? 'approved' : 'rejected';
  rm.decidedAt = Date.now();
  rm.decidedById = (actor && actor.id) || null;
  rm.note = String(note || '').slice(0, 200);

  if (rm.status === 'approved') {
    if ((t.format || 'single-elimination') === 'swiss') {
      // 瑞士制：抹掉该场赛果 + 重建房（没有节点/上游可清，见 approveSwissRematch）
      const sr = approveSwissRematch(t, rm);
      if (!sr.ok) {
        // 判定失败就别把状态改成 approved——否则这条申请会变成"批准了但没生效"
        rm.status = 'pending';
        rm.decidedAt = null;
        rm.decidedById = null;
        rm.note = '';
        return sr;
      }
    } else {
      const node = (t.bracket || []).find((n) => n.index === rm.nodeIndex);
      if (!node) return { ok: false, error: '对阵节点已不存在' };

      node.winnerId = null;
      node.playerId = null;
      node.matchId = null;
      node.players = (node.lastPlayers || []).slice(); // 交回 assignNextMatches 重算
      node.lastMatchId = null;
      clearUpstream(t, node.index);

      // 冠军可能正是由这条路径产生的 → 退掉，赛事回到进行中
      if (t.championId) {
        t.championId = null;
        t.championManual = false;
        t.endedAt = null;
        if (normalizeStatus(t.status) === 'finished') t.status = 'playing';
      }
      assignNextMatches(t); // 重新建房
    }
  }

  addLog(t, {
    byId: actor.id, byRole: roleOf(t, actor),
    action: rm.status === 'approved' ? 'rematch-approve' : 'rematch-reject',
    detail: { rematchId, node: rm.nodeIndex, round: rm.round, note: rm.note },
  });
  persist();
  return { ok: true, tournament: publicInfo(t), rematch: rm };
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
  return (rec.pairs || []).every(([a, b]) => !!rec.results[swiss.pairKey(a, b)]);
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
    const res = matchFactory ? matchFactory(t.id, [pa, pb]) : null;
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

  addLog(t, {
    byRole: 'system', action: 'match-result',
    detail: { round: rec.round, matchId, winnerId },
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
  for (let i = 0; i < size; i++) {
    nodes[leafStart + i].playerId = players[i] ? players[i].id : null;
    nodes[leafStart + i].name = players[i] ? players[i].name : null;
  }
  // 从下往上建立父子关系
  for (let i = leafStart - 1; i >= 0; i--) {
    nodes[i].pair = [2 * i + 1, 2 * i + 2];
  }
  return nodes;
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
  if (!t || !t.bracket || !matchFactory) return 0;
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
        changed = true;
        continue;
      }

      // ---- 双方都有人 → 建房 ----
      n.players = [s1.winner, s2.winner];
      const res = matchFactory(t.id, n.players);
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
    // 根节点已填 → 冠军产生
    t.championId = winnerId;
    t.status = 'finished';
    // 记结束时刻（T6/需求 11）：自动存档按它算 N 小时收尾窗口
    t.endedAt = Date.now();
    persist();
    return { ok: true, tournament: publicInfo(t), finished: true };
  }
  assignNextMatches(t);
  persist();
  return { ok: true, tournament: publicInfo(t) };
}

/**
 * 公开列表：只返回可展示的赛事（审核中/被拒/已取消不对外）。
 */
function listTournaments() {
  // T1：`registration` 是新的"报名中"（旧数据写 `open`，由 normalizeStatus 映射）；
  // `archived`（已存档）与 `finished` 一样对外可见——办过的赛事应当能回看。
  const PUBLIC_STATUS = ['registration', 'playing', 'finished', 'archived'];
  return Object.values(getCache())
    .filter((t) => PUBLIC_STATUS.includes(normalizeStatus(t.status)))
    .map(publicInfo)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 管理员全量列表：含 pending_approval / rejected / cancelled。
 */
function listAllTournaments() {
  return Object.values(getCache())
    .map(publicInfo)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getTournament(tournamentId) {
  const t = getCache()[tournamentId];
  return t ? publicInfo(t) : null;
}

// ==================================================================
// 状态机（T1）
// ==================================================================

/**
 * 合法状态迁移表。**不在表里的一律拒绝**。
 * 把"什么状态能到什么状态"写成数据，比散在十几个 `if` 里可靠得多——加状态时只改这里。
 */
const STATUS_FLOW = {
  pending_approval: ['registration', 'rejected'],
  registration: ['playing', 'cancelled'],
  playing: ['finished', 'cancelled'],
  finished: ['archived'],
  archived: [],  // 终态：只读（管理员可改字段，但不改状态）
  rejected: [],
  cancelled: [],
};

/** 旧状态名 → 新名。历史数据里写的是 `open`（T1 起叫 `registration`）。 */
const STATUS_ALIAS = { open: 'registration' };

/** 读取时统一映射（**不改磁盘数据**，只在出口归一） */
function normalizeStatus(s) {
  return STATUS_ALIAS[s] || s || 'pending_approval';
}

function canTransition(from, to) {
  const list = STATUS_FLOW[normalizeStatus(from)] || [];
  return list.includes(to);
}

/**
 * 唯一的状态迁移入口：校验合法性 → 改状态 → 记日志。
 * @returns {{ok:boolean, error?:string}}
 */
function transition(t, to, entry) {
  if (!t) return { ok: false, error: '赛事不存在' };
  const from = normalizeStatus(t.status);
  if (from === to) return { ok: false, error: '状态已变更' };
  if (!canTransition(from, to)) {
    return { ok: false, error: `当前状态（${from}）不能变更为 ${to}` };
  }
  t.status = to;
  if (to === 'finished') t.endedAt = Date.now();
  if (to === 'archived') t.archivedAt = Date.now();
  addLog(t, entry);
  return { ok: true };
}

// ==================================================================
// 权限（T1 核心）：**全项目唯一的赛事权限判定入口**
// ==================================================================

/**
 * 动作 → 允许的角色。
 * ⚠️ 改权限**只改这张表**，不要在各处写 `if (t.ownerId === me)`——
 * §Q7-1 的越权事故就是"每个接口各抄一份判定"抄出来的。
 */
const ACTION_ROLES = {
  approve_tournament: ['admin'],
  reject_tournament: ['admin'],
  // 需求 10 原文写"主办人可设置冠军"，**已被用户 2026-09-13 修正为仅管理员**
  set_champion: ['admin'],
  archive: ['admin'],
  edit_archived: ['admin'],   // 存档后仅管理员可编辑（需求 11）
  decide_entrant: ['admin', 'owner'],
  kick_player: ['admin', 'owner'],
  void_player: ['admin', 'owner'],
  assign_round: ['admin', 'owner'],
  decide_rematch: ['admin', 'owner'],
  cancel: ['admin', 'owner'], // 主办人另受"仅未结束时"限制，见下
  request_rematch: ['player'], // 参赛者申请重赛（需求 12）
};

/**
 * 唯一的赛事权限判定。
 *
 * @param {object} t 赛事
 * @param {{id?:string, isAdmin?:boolean}} actor 操作者（管理员也可能是 owner）
 * @param {string} action 见 ACTION_ROLES
 * @returns {boolean}
 */
function canManage(t, actor, action) {
  if (!t || !actor || !action) return false;
  const roles = ACTION_ROLES[action];
  if (!roles) return false;

  const isAdmin = !!actor.isAdmin;
  const isOwner = !!(actor.id && t.ownerId === actor.id);
  const isPlayer = !!actor.id && (
    (t.entrants || []).some((e) => e.id === actor.id && e.status === 'approved')
    || (t.players || []).some((p) => p.id === actor.id)
  );
  const s = normalizeStatus(t.status);

  if (isAdmin) {
    // 管理员全权，但"取消"对已收尾的赛事同样不允许（与主办人限制保持一致）
    if (action === 'cancel' && (s === 'finished' || s === 'archived' || s === 'cancelled' || s === 'rejected')) return false;
    // T6：「编辑」通道**只对已存档赛事开放**。存档前有正常的管理操作可用，
    // 那时走"编辑"会把还没定论的东西记成"赛后更正"，也会绕过状态机与操作日志的语义。
    if (action === 'edit_archived') return s === 'archived';
    return roles.includes('admin');
  }

  if (isOwner) {
    if (!roles.includes('owner')) return false;
    // ⚠️ 需求 11（用户 2026-09-13 明确："主办人结束后不能取消赛事"）：
    // 进 archived / cancelled / rejected 后主办人**只读**；finished 仍留收尾窗口
    //（自动存档前的 24 小时，用于处理申诉等）。
    if (s === 'archived' || s === 'cancelled' || s === 'rejected') return false;
    if (action === 'cancel') return s === 'registration' || s === 'playing';
    return true;
  }

  if (isPlayer) {
    return roles.includes('player') && s === 'playing';
  }
  return false;
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

/**
 * 某玩家的赛事荣誉。
 *
 * ⚠️ **只统计 `finished` / `archived`**：进行中的赛事还没有结论，
 * 写进"荣誉"会误导（这也是"荣誉"与"参赛记录"的区别）。
 * `cancelled` / `rejected` / `pending_approval` 一律不算参赛。
 *
 * @param {string} playerId
 * @param {number} [limit=20] 荣誉明细上限（个人页是概览，不铺全量）
 * @returns {{stats:object, items:Array}}
 */
function honorsOf(playerId, limit = 20) {
  const stats = { joined: 0, finished: 0, titles: 0, runnerUps: 0, top4: 0, winRate: 0 };
  if (!playerId) return { stats, items: [] };

  const items = [];
  for (const t of Object.values(getCache())) {
    const st = normalizeStatus(t.status);
    if (st === 'cancelled' || st === 'rejected' || st === 'pending_approval') continue;

    const joined = (t.players || []).some((p) => p.id === playerId)
      || (t.entrants || []).some((e) => e.id === playerId && e.status === 'approved');
    if (!joined) continue;
    stats.joined++;

    if (st !== 'finished' && st !== 'archived') continue; // 还没打完：只计入"参赛"
    stats.finished++;

    const place = placeOf(t, playerId);
    if (place === 1) stats.titles++;
    else if (place === 2) stats.runnerUps++;
    else if (place === 3) stats.top4++;
    if (!place) continue; // 拿到参赛次数但没有名次 → 不进荣誉明细

    items.push({
      tournamentId: t.id,
      name: t.name,
      place,
      placeLabel: PLACE_LABEL[place] || '',
      size: t.size,
      format: t.format || 'single-elimination',
      formatLabel: FORMAT_LABELS[t.format || 'single-elimination'] || null,
      playerCount: (t.players || []).length,
      endedAt: t.endedAt || t.archivedAt || null,
      manual: !!t.championManual, // 冠军由管理员人工裁定 → 详情页会标注
    });
  }

  items.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  stats.winRate = stats.finished ? Math.round((stats.titles / stats.finished) * 100) : 0;
  return { stats, items: items.slice(0, limit) };
}

module.exports = {
  createTournament,
  joinTournament,
  decideEntrant,   // T3：批准/拒绝报名
  kickPlayer,      // T3：踢出报名者（仅报名阶段）
  voidPlayer,      // T4：取消选手成绩（开赛后；判对手胜 + 重算下游）
  setChampion,     // T4：设置冠军（**仅管理员**）
  requestRematch,  // T6：参赛者申请重赛
  decideRematch,   // T6：裁决重赛（主办人/管理员）
  // ---- T6 新增：赛后存档与管理员编辑 ----
  archiveTournament, // 手动存档（仅管理员）
  autoArchiveDue,    // 自动存档扫描（由 server 定时调用）
  editArchived,      // 编辑已存档赛事（仅管理员）
  ARCHIVE_AFTER_HOURS,
  startTournament, // T3：手动开赛（报名阶段，主办人/管理员）
  approvedCount,   // T3：已批准人数（= 参赛人数）
  approveTournament,
  rejectTournament,
  cancelTournament,
  onMatchFinished,
  listTournaments,
  listAllTournaments,
  getTournament,
  setMatchFactory,
  assignNextMatches,
  // ---- T1 新增：状态机与权限 ----
  // 对外暴露是**有意**的：protocol / HTTP 路由 与 单测都通过它们做判定，
  // 这样"权限只有一处"才真的成立（藏在模块内部反而会诱使调用方自己写一份）。
  canManage,
  canTransition,
  normalizeStatus,
  transition,
  addLog,
  publicInfo,
  STATUS_FLOW,
  ACTION_ROLES,
  SIZE_OPTIONS,
  FORMATS,
  // ---- T8：瑞士制 ----
  swissStandings,     // 名次表（详情页与测试用）
  matchParticipants,  // "这一场是谁打谁"（重赛资格判定复用）
  honorsOf,           // 赛事荣誉（个人页）
  placeOf,            // 单赛事名次（荣誉计算用）
  PLACE_LABEL,
  FORMAT_LABELS,
  MIN_SWISS_ROUNDS,
  MAX_SWISS_ROUNDS,
};
