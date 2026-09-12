/**
 * audit.js — 事件与审计日志（PLAN §M3，§K 的配套）
 *
 * 两类事件共用一个 append-only 存储（kv 前缀 `events/`）：
 *  - login      登录/连接事件（含 IP、UA）——隐私数据，仅管理员可见
 *  - admin      管理员写操作审计——含操作人、来源 IP、目标与变更摘要
 *
 * 设计取舍：
 *  - 存 kv 而非新表：与会话同源（storage 已是 SQLite），零迁移，读取走 listJsonByPrefix。
 *  - 键名 `events/<14位时间戳>-<随机>`：字典序即时间序，裁剪时按序删除最旧的一批即可。
 *  - 登录事件 24h 内同 `playerId + ip` 去重（内存表，重启后失效无妨），
 *    否则每次刷新页面都会写一条，日志瞬间被噪声淹没。
 *  - 容量与保留期双上限，prune() 在启动时跑一次（也可定时）。
 */
'use strict';

const { writeJson, listJsonByPrefix, deleteJson } = require('./storage');

const PREFIX = 'events/';
const MAX_EVENTS = Math.max(100, parseInt(process.env.AUDIT_MAX_EVENTS || '5000', 10) || 5000);
const RETENTION_DAYS = Math.max(1, parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10) || 90);
const LOGIN_DEDUPE_MS = 24 * 60 * 60 * 1000;
const QUERY_MAX = 500;

let seq = 0;
/** 登录去重：`${playerId}|${ip}` -> ts */
const recentLogin = new Map();

function eventKey(ts) {
  seq = (seq + 1) % 1000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${PREFIX}${String(ts).padStart(14, '0')}-${rand}${String(seq).padStart(3, '0')}`;
}

/**
 * 追加一条事件（唯一写入口）。
 * @param {'login'|'admin'|string} type
 * @param {object} data 事件体（不要放密码/令牌）
 * @returns {object} 写入的事件
 */
function append(type, data = {}) {
  const ts = Date.now();
  const key = eventKey(ts);
  const ev = { id: key.slice(PREFIX.length), ts, type, ...data };
  writeJson(key, ev);
  return ev;
}

/**
 * 登录/连接事件。同一 playerId + ip 在 24h 内只记一次。
 * @param {{playerId:string, ip:string|null, ua:string|null, via?:string}} info
 * @returns {object|null} null 表示被去重
 */
function loginEvent({ playerId, ip, ua, via = 'ws' } = {}) {
  if (!playerId) return null;
  const dedupeKey = `${playerId}|${ip || ''}`;
  const now = Date.now();
  const last = recentLogin.get(dedupeKey);
  if (last && now - last < LOGIN_DEDUPE_MS) return null;
  recentLogin.set(dedupeKey, now);
  return append('login', { playerId, ip: ip || null, ua: ua || null, via });
}

/**
 * 管理员操作审计（不去重：每一次都留痕）。
 * @param {{adminId?:string, adminIp?:string|null, action:string, targetId?:string, ok?:boolean, detail?:object}} info
 */
function adminAction({ adminId = null, adminIp = null, action, targetId = null, ok = true, detail = null } = {}) {
  if (!action) return null;
  return append('admin', { adminId, adminIp: adminIp || null, action, targetId, ok: !!ok, detail });
}

/**
 * 查询事件（倒序）。
 * @param {{type?:string, playerId?:string, targetId?:string, since?:number, until?:number, limit?:number}} q
 */
function query(q = {}) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), QUERY_MAX);
  let rows = listJsonByPrefix(PREFIX);
  rows = rows.filter((e) => e && e.ts);
  if (q.type) rows = rows.filter((e) => e.type === q.type);
  if (q.playerId) rows = rows.filter((e) => e.playerId === q.playerId || e.adminId === q.playerId);
  if (q.targetId) rows = rows.filter((e) => e.targetId === q.targetId);
  if (Number.isFinite(q.since)) rows = rows.filter((e) => e.ts >= q.since);
  if (Number.isFinite(q.until)) rows = rows.filter((e) => e.ts <= q.until);
  return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** 某玩家近 N 条登录记录（管理员详情页用） */
function loginHistory(playerId, limit = 50) {
  return query({ type: 'login', playerId, limit });
}

/**
 * 裁剪：先删过期，再按容量删最旧的一批。
 * @returns {{expired:number, overflow:number, kept:number}}
 */
function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let rows = listJsonByPrefix(PREFIX).filter((e) => e && e.ts && e.id);
  let expired = 0;
  for (const e of rows) {
    if (e.ts < cutoff) {
      deleteJson(`${PREFIX}${e.id}`);
      expired += 1;
    }
  }
  if (expired) rows = rows.filter((e) => e.ts >= cutoff);
  let overflow = 0;
  if (rows.length > MAX_EVENTS) {
    rows.sort((a, b) => a.ts - b.ts); // 最旧在前
    const drop = rows.length - MAX_EVENTS;
    for (let i = 0; i < drop; i++) {
      deleteJson(`${PREFIX}${rows[i].id}`);
      overflow += 1;
    }
  }
  return { expired, overflow, kept: Math.max(0, rows.length - overflow) };
}

/** 仅测试/维护用：清空全部事件 */
function clearAll() {
  for (const e of listJsonByPrefix(PREFIX)) {
    if (e && e.id) deleteJson(`${PREFIX}${e.id}`);
  }
}

module.exports = {
  PREFIX,
  MAX_EVENTS,
  RETENTION_DAYS,
  append,
  loginEvent,
  adminAction,
  query,
  loginHistory,
  prune,
  clearAll,
};
