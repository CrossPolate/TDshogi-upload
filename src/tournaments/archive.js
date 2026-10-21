/**
 * tournaments/archive.js — 赛后存档与重赛（存档 / 自动存档 / 管理员编辑 / 重赛裁决）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const log = require('../logger');
const swiss = require('../swiss');
const store = require('./store');
const { getCache, persist, addLog } = store;   // matchFactory 是可变量，见 store.js 的说明
const { roleOf, normalizeStatus, transition, canManage } = require('./rules');
const { matchParticipants, publicInfo } = require('./swiss-flow');
const { assignNextMatches } = require('./bracket');
const { clearUpstream } = require('./lifecycle');


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
  // ⚠️ 2026-10-02 体验修复（问题 4「editArchived 无变化」）：**无变化不是失败**。
  // 管理后台是**预填表单**（载入当前值 → 用户点保存），点一次保存而没改任何东西是
  // 完全正常的操作；旧实现回 `{ok:false, error:'内容没有变化'}` → HTTP 400 →
  // 前端只能弹一条红色错误，与"其实已经和你想的一样"自相矛盾（用户以为没保存成功）。
  // 改为**显式成功但无变更**：不写 `adminEditLog`、不落盘（确实什么都没改），
  // 用 `unchanged: true` 让前端给出「无变更」提示而不是报错（向后兼容：老前端只认 ok）。
  if (before === next) return { ok: true, unchanged: true, tournament: publicInfo(t) };

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
  const res = store.matchFactory ? store.matchFactory(t.id, [pa, pb]) : null;
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
      if (!node) {
        // ⚠️ 2026-10-02 审查 P1-6：淘汰赛分支失败必须**回滚**（与瑞士制分支一致），
        // 否则这条申请会变成「已批准但没生效」的僵尸——且 rm.status!=='pending' 使后续无法重试。
        rm.status = 'pending';
        rm.decidedAt = null;
        rm.decidedById = null;
        rm.note = '';
        return { ok: false, error: '对阵节点已不存在' };
      }

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

module.exports = {
  ARCHIVE_AFTER_HOURS,
  archiveTournament,
  autoArchiveDue,
  editArchived,
  requestRematch,
  approveSwissRematch,
  decideRematch,
};
