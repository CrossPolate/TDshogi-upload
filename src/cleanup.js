/**
 * cleanup.js — 游客数据清理（PLAN §U5）
 *
 * 规则（2026-09-13 用户确认）：
 *  1. 游客会话「超过 N 天未登录」（以 `lastSeen` 为准，默认 30 天）→ **删除会话**；
 *  2. **排除已注册**：账号记录里存在 `account.guestId === session.id` → **保留**
 *     （人已经注册了，只是这段时间没来，不能把人清掉）；
 *  3. 棋谱：**双方都属于待清理游客** → 删；**只要有一方是注册用户或仍在活跃的游客** → 保留。
 *
 * ⚠️ 删除**不可逆**，所以本模块的设计围绕"先看清楚、再动手"：
 *  - 支持 `CLEANUP_DRY_RUN=1`：只算清单、只记日志、**不删任何东西**
 *    （上线前务必先在真实数据上跑一遍，把清单过目）；
 *  - 每轮把动作写日志（`scope='cleanup'`），含删了哪些 id / 哪些棋谱；
 *  - `plan()` 是**纯函数**（不碰数据库），便于单测反复验证——清理逻辑写错就是丢数据；
 *  - 调度沿用 `backup.js` 的 `startAutoBackup` 模式（启动补一次 + 每 6 小时检查），
 *    失败只记日志，**绝不影响对局服务**。
 *
 * 环境变量：
 *  - `GUEST_RETENTION_DAYS`：保留天数，默认 30
 *  - `CLEANUP_DRY_RUN=1`：干跑模式（只出清单）
 */
'use strict';

const storage = require('./storage');
const accounts = require('./accounts');
const log = require('./logger');

const RETENTION_DAYS = Number(process.env.GUEST_RETENTION_DAYS || 30);
const DRY_RUN = process.env.CLEANUP_DRY_RUN === '1';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 算出本轮要清理哪些数据（**纯计算，不修改任何东西**）。
 *
 * @param {{now?:number, days?:number}} [opts]
 * @returns {{cutoff:number, days:number, staleSessions:Array, staleIds:Set,
 *            staleRecords:Array, keptByRegistration:number,
 *            totalSessions:number, totalRecords:number}}
 */
function plan(opts) {
  const o = opts || {};
  const days = o.days != null ? o.days : RETENTION_DAYS;
  const now = o.now != null ? o.now : Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  // 「已注册」的游客 id —— 依据是 accounts 里保留的来源 guestId。
  // 用 listAccountsRaw 而非 listAccounts：后者走 publicInfo()，会把 guestId 剔掉。
  const registered = new Set(
    accounts.listAccountsRaw().map((a) => a && a.guestId).filter(Boolean)
  );

  const sessions = storage.listSessions();
  const staleSessions = sessions.filter((s) => {
    if (!s || !s.id) return false;
    if (registered.has(s.id)) return false; // 已注册 → 永不清理
    const seen = s.lastSeen || s.createdAt || 0;
    return seen > 0 && seen < cutoff;
  });
  const staleIds = new Set(staleSessions.map((s) => s.id));

  // 棋谱：**双方都**在待清理集合里才删。
  // 一方是注册用户 → staleIds 不含它 → 保留；
  // 一方是尚未超期的游客 → 同样保留（删了会连带抹掉那个人的对局记录）。
  // ⚠️ `listSummaries()` 返回的是 `playerIds: { b, w }`，**不是**扁平的 playerB / playerW
  //（虽然表里有这两列，但出口做了组装）——按扁平字段取会永远得到 undefined，从而一条都不删。
  const all = storage.listSummaries({ limit: 1000000 });
  const staleRecords = all.filter((r) => {
    const p = r.playerIds || {};
    return staleIds.has(p.b) && staleIds.has(p.w);
  });

  return {
    cutoff,
    days,
    staleSessions,
    staleIds,
    staleRecords,
    keptByRegistration: sessions.filter((s) => s && registered.has(s.id)).length,
    totalSessions: sessions.length,
    totalRecords: all.length,
  };
}

/**
 * 执行一轮清理。
 * @returns {{dryRun:boolean, days:number, sessions:number, records:number,
 *            sessionIds:string[], recordIds:string[], deletedSessions?:number, deletedRecords?:number}}
 */
function run(opts) {
  const o = opts || {};
  // `opts.dryRun` 可覆盖模块级开关——测试需要在同一次运行里验证"干跑"与"真删"两种路径，
  // 而环境变量在 require 时就固定了，改不动。
  const dryRun = o.dryRun != null ? !!o.dryRun : DRY_RUN;
  const p = plan(o);
  const summary = {
    dryRun,
    days: p.days,
    sessions: p.staleSessions.length,
    records: p.staleRecords.length,
    sessionIds: p.staleSessions.map((s) => s.id),
    recordIds: p.staleRecords.map((r) => r.id),
  };

  if (dryRun) {
    log.info('cleanup', `[dry-run] 待清理游客会话 ${summary.sessions} 个、棋谱 ${summary.records} 条（未删除）`, {
      retentionDays: p.days, sessionIds: summary.sessionIds, recordIds: summary.recordIds,
    });
    return summary;
  }

  let deletedSessions = 0;
  for (const s of p.staleSessions) {
    try { deletedSessions += storage.deleteSession(s.id); } catch (err) {
      log.error('cleanup', `删除会话 ${s.id} 失败`, { err, sessionId: s.id });
    }
  }
  let deletedRecords = 0;
  for (const r of p.staleRecords) {
    try { deletedRecords += storage.deleteRecord(r.id); } catch (err) {
      log.error('cleanup', `删除棋谱 ${r.id} 失败`, { err, recordId: r.id });
    }
  }

  summary.deletedSessions = deletedSessions;
  summary.deletedRecords = deletedRecords;
  if (deletedSessions || deletedRecords) {
    log.info('cleanup', `已清理游客会话 ${deletedSessions} 个、棋谱 ${deletedRecords} 条（保留期 ${p.days} 天）`, {
      retentionDays: p.days, sessionIds: summary.sessionIds, recordIds: summary.recordIds,
    });
  } else {
    log.info('cleanup', '无超过保留期的游客数据，未做清理');
  }
  return summary;
}

let timer = null;

/** 启动定期清理：启动时补一次 + 每 6 小时检查（与 backup.startAutoBackup 同模式） */
function startAutoCleanup() {
  try { run(); } catch (err) { log.error('cleanup', '启动清理失败', { err }); }
  if (timer) return;
  timer = setInterval(() => {
    try { run(); } catch (err) { log.error('cleanup', '定期清理失败', { err }); }
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref(); // 不阻止进程退出（测试/CI 里尤其重要）
}

function stopAutoCleanup() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { plan, run, startAutoCleanup, stopAutoCleanup, RETENTION_DAYS, DRY_RUN };
