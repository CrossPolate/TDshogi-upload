'use strict';

/**
 * studies/ — 1.9 开局统计（研究收藏的只读基础）。
 * 将棋开局按战法/围玉标签聚合；只读公开棋谱的 meta.opening，不解析整谱。
 */
const crypto = require('crypto');
const storage = require('../storage');
const records = require('../records');

function openingStats({ limit = 12 } = {}) {
  const rows = storage.openingTagStats(1500)
    .map((r) => ({
      tag: String(r.openingTag || '').trim(),
      count: Number(r.n) || 0,
      blackWins: Number(r.blackWins) || 0,
      whiteWins: Number(r.whiteWins) || 0,
      draws: Number(r.draws) || 0,
    }))
    .filter((x) => x.tag && x.count > 0)
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const total = rows.reduce((n, x) => n + x.count, 0);
  const list = rows
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
    .map((x) => {
      const decisive = x.blackWins + x.whiteWins;
      return { ...x, blackRate: decisive ? Math.round((x.blackWins / decisive) * 100) : null };
    });
  const publicTotal = storage.countPublicRecords();
  return { total, publicTotal, untagged: Math.max(0, publicTotal - total), list };
}

function list(actorId) {
  return storage.listStudies({ ownerId: actorId, includePublic: true }).map((st) => {
    const items = storage.listStudyItems(st.id);
    return { ...st, itemCount: items.length, mine: st.ownerId === actorId };
  });
}

function create(ownerId, { title, visibility } = {}) {
  const t = String(title || '').trim().slice(0, 40);
  if (!t) return { ok: false, error: '请填写研究标题' };
  const st = {
    id: `st_${crypto.randomBytes(6).toString('hex')}`,
    ownerId,
    title: t,
    visibility: visibility === 'public' ? 'public' : 'private',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  storage.putStudy(st);
  return { ok: true, study: st };
}

function detail(id, actorId) {
  const st = storage.getStudy(id);
  if (!st) return { ok: false, code: 'NO_STUDY', error: '研究不存在' };
  if (st.visibility !== 'public' && st.ownerId !== actorId) return { ok: false, code: 'FORBIDDEN', error: '无权查看该研究' };
  return { ok: true, study: st, items: storage.listStudyItems(id), mine: st.ownerId === actorId };
}

function addItem(actorId, studyId, { recordId, ply = 0, note = '' } = {}) {
  const st = storage.getStudy(studyId);
  if (!st) return { ok: false, code: 'NO_STUDY', error: '研究不存在' };
  if (st.ownerId !== actorId) return { ok: false, code: 'FORBIDDEN', error: '只有作者能编辑研究' };
  const rec = records.getRecord(String(recordId || ''));
  if (!rec) return { ok: false, code: 'NO_RECORD', error: '棋谱不存在' };
  if (!records.canView(rec, { playerId: actorId })) return { ok: false, code: 'FORBIDDEN', error: '无权收藏该棋谱' };
  if (st.visibility === 'public' && rec.visibility !== 'public') {
    return { ok: false, code: 'PRIVATE_RECORD', error: '公开研究只能收藏公开棋谱' };
  }
  storage.putStudyItem({ studyId, recordId: rec.id, ply: Math.max(0, Math.floor(Number(ply) || 0)), note: String(note || '').slice(0, 200) });
  st.updatedAt = Date.now();
  storage.putStudy(st);
  return { ok: true };
}

function removeItem(actorId, studyId, recordId, ply = 0) {
  const st = storage.getStudy(studyId);
  if (!st) return { ok: false, error: '研究不存在' };
  if (st.ownerId !== actorId) return { ok: false, error: '只有作者能编辑研究' };
  const n = storage.deleteStudyItem(studyId, recordId, ply);
  st.updatedAt = Date.now();
  storage.putStudy(st);
  return { ok: n > 0 };
}

function remove(actorId, studyId) {
  const st = storage.getStudy(studyId);
  if (!st) return { ok: false, error: '研究不存在' };
  if (st.ownerId !== actorId) return { ok: false, error: '只有作者能删除研究' };
  storage.deleteStudy(studyId);
  return { ok: true };
}

function update(actorId, studyId, { title, visibility } = {}) {
  const st = storage.getStudy(studyId);
  if (!st) return { ok: false, error: '研究不存在' };
  if (st.ownerId !== actorId) return { ok: false, error: '只有作者能编辑研究' };
  if (title !== undefined) {
    const t = String(title || '').trim().slice(0, 40);
    if (!t) return { ok: false, error: '标题不能为空' };
    st.title = t;
  }
  if (visibility !== undefined) st.visibility = visibility === 'public' ? 'public' : 'private';
  st.updatedAt = Date.now();
  storage.putStudy(st);
  return { ok: true, study: st };
}

module.exports = { openingStats, list, create, detail, addItem, removeItem, remove, update };
