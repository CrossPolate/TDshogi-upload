'use strict';
/**
 * reports.js — 举报（2026-09-20 用户要求）
 *
 * **为什么单独一个模块**：举报是跨「对局 / 棋谱 / 玩家卡」的通用能力，
 * 而它自己有一条完整生命周期（提交 → 待处理 → 已处理/驳回）。
 * 塞进 rooms 会让对局模块多背一份审核状态；塞进 admin 又变成"玩家提交也要走管理端"。
 *
 * 数据落 kv（`reports.json`），与 tournaments / announcements 同款。
 *
 * ## 设计取舍
 *
 * - **被举报人的名字由服务端查**，不信客户端传来的 `targetName`——
 *   否则举报记录里可以写任意名字，管理员看到的"被举报人"就是伪造的。
 * - **同一举报人对同一目标 30 分钟内只收一条**：举报按钮在对局页，
 *   手滑连点、或输棋后连点发泄，都不该产生一堆重复记录。
 * - **不限制举报人等级**：举报是"防坏人"的机制，抬门槛等于把新人挡在保护之外。
 */
const { readJson, writeJson } = require('./storage');
const { genId } = require('./auth');

/** 举报类别（前端按这份清单渲染下拉；服务端按它校验） */
const CATEGORIES = [
  { id: 'cheat', label: '作弊 / 使用外挂' },
  { id: 'abuse', label: '辱骂 / 骚扰' },
  { id: 'stall', label: '恶意拖延 / 挂机' },
  { id: 'impersonate', label: '冒充他人' },
  { id: 'other', label: '其他' },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** 同一举报人对同一目标的去重窗口 */
const DEDUPE_MS = 30 * 60 * 1000;
/** 单人在窗口内的总条数上限（防止把举报当刷屏通道） */
const QUOTA_MAX = 10;
const QUOTA_MS = 60 * 60 * 1000;

/** 内存态的时间戳记录（不落盘：重启后重新计数即可，不值得为它写盘） */
let recent = [];

function load() {
  const data = readJson('reports.json', []);
  return Array.isArray(data) ? data : [];
}
function persist(list) {
  writeJson('reports.json', list);
}

/** 清理过期的时间戳记录，避免无界增长 */
function pruneRecent(now) {
  recent = recent.filter((r) => now - r.at < QUOTA_MS);
}

/**
 * 提交举报。
 *
 * @param {{byId:string, byName:string, targetId:string, targetName?:string,
 *          category:string, detail?:string, context?:object}} o
 * @returns {{ok:boolean, report?:object, error?:string}}
 */
function submit(o) {
  const p = o || {};
  const byId = String(p.byId || '');
  const targetId = String(p.targetId || '');
  if (!byId) return { ok: false, error: '无法识别举报人' };
  if (!targetId) return { ok: false, error: '缺少被举报人' };
  // 举报自己既无意义，也是"误点"的常见来源（按钮在对局页，视角切换后容易点错）
  if (targetId === byId) return { ok: false, error: '不能举报自己' };
  if (!CATEGORY_IDS.includes(p.category)) return { ok: false, error: '请选择举报类别' };

  const now = Date.now();
  pruneRecent(now);

  const same = recent.find((r) => r.by === byId && r.target === targetId);
  if (same && now - same.at < DEDUPE_MS) {
    return { ok: false, error: '你已举报过该玩家，我们正在处理（30 分钟内无需重复提交）' };
  }
  const mine = recent.filter((r) => r.by === byId);
  if (mine.length >= QUOTA_MAX) {
    return { ok: false, error: '举报过于频繁，请稍后再试' };
  }

  const list = load();
  const report = {
    id: genId().slice(0, 8),
    at: now,
    byId,
    byName: String(p.byName || '').slice(0, 16) || '匿名',
    targetId,
    // ⚠️ 名字以服务端查询为准（客户端传的只作兜底）——否则记录里的被举报人可以是伪造的
    targetName: resolveName(targetId) || String(p.targetName || '').slice(0, 16) || '未知',
    category: p.category,
    detail: String(p.detail || '').trim().slice(0, 200),
    // 上下文（房间/棋谱）只留 id，不留内容——举报记录不是聊天备份
    context: p.context && typeof p.context === 'object'
      ? { roomId: p.context.roomId || null, recordId: p.context.recordId || null }
      : null,
    status: 'pending',   // pending | handled | rejected
    handledBy: null,
    handledAt: null,
    note: '',
  };
  list.push(report);
  // 只留最近 1000 条：举报是给人看的队列，不是审计归档（审计在 audit 模块）
  if (list.length > 1000) list.splice(0, list.length - 1000);
  persist(list);

  recent.push({ by: byId, target: targetId, at: now });
  return { ok: true, report };
}

/** 从会话查显示名（账号与游客都走同一张会话表） */
function resolveName(playerId) {
  try {
    const sess = require('./auth').load(playerId);
    return (sess && sess.name) || null;
  } catch (_) {
    return null;
  }
}

/** 列表（管理员）；`status` 为空表示全部 */
function list(status) {
  const all = load().slice().reverse(); // 新的在前
  return status ? all.filter((r) => r.status === status) : all;
}

/** 待处理数量（管理后台 tab 上的角标） */
function pendingCount() {
  return load().filter((r) => r.status === 'pending').length;
}

/**
 * 处理一条举报（仅管理员）。
 * @param {'handled'|'rejected'} status
 */
function decide(id, status, note, by) {
  if (!['handled', 'rejected'].includes(status)) return { ok: false, error: '无效的处理结果' };
  const list = load();
  const r = list.find((x) => x.id === id);
  if (!r) return { ok: false, error: '举报不存在' };
  if (r.status !== 'pending') return { ok: false, error: '该举报已处理过' };
  r.status = status;
  r.handledBy = String(by || 'admin').slice(0, 32);
  r.handledAt = Date.now();
  r.note = String(note || '').trim().slice(0, 200);
  persist(list);
  return { ok: true, report: r };
}

/** 仅测试用：清掉内存里的限流时间戳 */
function _resetThrottle() { recent = []; }

module.exports = {
  CATEGORIES, CATEGORY_IDS,
  submit, list, pendingCount, decide,
  _resetThrottle,
};
