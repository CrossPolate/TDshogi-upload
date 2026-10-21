/**
 * tournaments/rules.js — 状态机与权限（**所有权限判定只有这一处**：canManage）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const { addLog } = require('./store');


// ==================================================================
// 管理操作（需求 10）
// ⚠️ 每个操作**第一步都是 canManage()** —— 不要在别处再写一遍权限判断，
// 那正是 §Q7-1 越权的成因（同一判定散落多处，迟早漏掉一处）。
// ==================================================================

/** 操作者角色（写日志用）：管理员优先 */
function roleOf(t, actor) {
  return (actor && actor.isAdmin) ? 'admin' : 'owner';
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

module.exports = {
  roleOf,
  STATUS_FLOW,
  STATUS_ALIAS,
  normalizeStatus,
  canTransition,
  transition,
  ACTION_ROLES,
  canManage,
};
