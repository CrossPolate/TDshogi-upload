/**
 * src/http/routes/records.js — 棋谱 REST（PLAN §M2 从 `server.js` 拆出）
 *
 * 导出 / 回放 / 复盘 / 检索，以及谱主与管理员对棋谱的写操作（书签 / 评论 / 变着）。
 *
 * ⚠️ **权限口径统一走 `records.canView(rec, { playerId, isAdmin })`**：
 * 早期各处自己写判断，于是「公开棋谱」上线时漏改了几处，导致公开棋谱仍报 403。
 * 现在只需在这一个函数里维护「谁能看」的规则。
 */
'use strict';

const records = require('../../records');
// ⚠️ 本文件（`src/http/routes/records.js`）与 `src/records.js` 同名但不同物：
// 后者是棋谱存储域模块（上面已 require 为 `records`），本文件是它的 HTTP 路由。
const auth = require('../../auth');
const accounts = require('../../accounts');
const audit = require('../../audit');
const rateLimit = require('../../ratelimit');
const { protocol, resolvePlayer, sanitize, checkAdmin } = require('../context');

module.exports = function registerRecords(app) {
  // ---------- 读取：导出 / 回放 / 复盘 ----------

  // 棋谱导出（权限：owner 或管理员）
  app.get('/api/records/:id/export', (req, res) => {
    const fmt = req.query.fmt === 'csa' ? 'csa' : 'kif';
    const rec = records.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: '棋谱不存在' });
    const guest = resolvePlayer(req.query.guest);
    // §L2：管理员 / 谱主 / 已公开棋谱 均可导出（管理员判定统一走 checkAdmin）
    if (!records.canView(rec, { playerId: guest, isAdmin: !!checkAdmin(req) })) {
      return res.status(403).json({ error: '无权导出他人的棋谱' });
    }
    const data = protocol.exportData(req.params.id, fmt);
    if (!data) return res.status(404).json({ error: '棋谱不存在' });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    // 文件名：先手名_后手名_对局日期.格式（中文用 RFC 5987 编码，兼容各浏览器）
    const recNames = (rec.names && rec.names[0] && rec.names[1])
      ? `${sanitize(rec.names[0])}_vs_${sanitize(rec.names[1])}`
      : req.params.id;
    const dateStr = rec.createdAt ? new Date(rec.createdAt).toISOString().slice(0, 10) : 'nodate';
    const base = `${recNames}_${dateStr}`;
    const ascii = base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.set('Content-Disposition',
      `attachment; filename="${ascii}.${fmt}"; filename*=UTF-8''${encodeURIComponent(base)}.${fmt}`);
    res.send(data.text);
  });

  // 棋谱回放数据（权限：owner 或管理员）
  app.get('/api/records/:id/playback', (req, res) => {
    const rec = records.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: '棋谱不存在' });
    const guest = resolvePlayer(req.query.guest);
    // §L2：公开棋谱任何人可回放（管理员判定统一走 checkAdmin）
    if (!records.canView(rec, { playerId: guest, isAdmin: !!checkAdmin(req) })) {
      return res.status(403).json({ error: '只能回放自己的棋谱' });
    }
    res.json(records.playbackData(rec));
  });

  // 复盘数据（完整：含书签/评论/变着）。权限：owner 或管理员。
  app.get('/api/records/:id/review', (req, res) => {
    const guest = resolvePlayer(req.query.guest);
    const rec = records.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: '棋谱不存在' });
    // §L2：公开棋谱任何人可复盘（管理员判定统一走 checkAdmin）
    if (!records.canView(rec, { playerId: guest, isAdmin: !!checkAdmin(req) })) {
      return res.status(403).json({ error: '只能复盘自己的棋谱' });
    }
    res.json(records.reviewData(req.params.id));
  });

  // 棋谱检索（REST 版，保留给管理后台/外部工具）：
  //   ?query=关键词&player=&movesMin=&movesMax=&result=&opening=前N手(逗号分隔)&limit=
  // 权限（PLAN §Q7 越权修复）：
  //   - 管理员（adminToken）→ 可检索全部，或按 player 指定任一人
  //   - 非管理员 → player 参数**必须是可验证的账号令牌**，且只能查该令牌自己的棋谱
  //   - 游客 → 一律 403（游客 id 无法自证身份），前端改走 WS `record_search`
  app.get('/api/records/search', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    const isAdmin = !!checkAdmin(req); // 管理员判定统一走 checkAdmin
    const raw = req.query.player || null;

    let playerId = null;
    if (isAdmin) {
      playerId = raw ? resolvePlayer(raw) : null; // 管理员：可传 id，也可传账号令牌
    } else {
      const accountId = accounts.verifyToken(raw);
      if (!accountId) {
        return res.status(403).json({
          error: '无权检索：请使用页面内的棋谱检索（已按你的登录身份过滤）',
        });
      }
      playerId = accountId; // 只允许查令牌自身的棋谱，忽略请求者可能夹带的其他 id
    }

    const q = {
      playerId,
      movesMin: req.query.movesMin != null ? parseInt(req.query.movesMin, 10) : undefined,
      movesMax: req.query.movesMax != null ? parseInt(req.query.movesMax, 10) : undefined,
      result: req.query.result || undefined,
      opening: req.query.opening || undefined,
      query: req.query.query || undefined,
      limit: req.query.limit != null ? parseInt(req.query.limit, 10) : 100,
    };
    res.json({ records: records.searchRecords(q), isAdmin });
  });

  // ---------- 写入：书签 / 评论 / 变着（谱主或管理员） ----------

  // 书签（toggle）
  app.post('/api/records/:id/bookmark', (req, res) => {
    const guest = req.body && req.body.guest;
    const moveNo = req.body && req.body.moveNo;
    const on = !!(req.body && req.body.on);
    const rec = records.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: '棋谱不存在' });
    if (!checkAdmin(req) && !records.isOwner(rec, guest)) {
      return res.status(403).json({ error: '无权操作' });
    }
    const r = records.toggleBookmark(req.params.id, moveNo, on);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  // 评论（§L3 升级）：新增 / 编辑（带 commentId）/ 删除（带 commentId 且 text 为空）
  // 权限：谱主可写自己的评论；管理员可写、编辑、删除任意评论（force）
  app.post('/api/records/:id/comment', (req, res) => {
    const isAdmin = !!checkAdmin(req); // 管理员判定统一走 checkAdmin
    const guest = resolvePlayer(req.body && req.body.guest);
    const moveNo = req.body && req.body.moveNo;
    const text = req.body && req.body.text;
    const commentId = (req.body && req.body.commentId) || null;
    const rec = records.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: '棋谱不存在' });
    // §L：公开棋谱的评论仅管理员可维护（访客只读，避免展示内容被随意改动）
    if (records.isPublic(rec) && !isAdmin) {
      return res.status(403).json({ error: '公开棋谱的评论仅管理员可维护' });
    }
    if (!isAdmin && !records.isOwner(rec, guest)) {
      return res.status(403).json({ error: '无权操作（仅谱主与管理员可评论）' });
    }
    const session = auth.load(guest) || null;
    const authorName = isAdmin ? '管理员' : (session ? session.name : null);
    const r = records.setComment(req.params.id, moveNo, text, {
      authorId: guest,
      authorName,
      commentId,
      force: isAdmin,
    });
    if (isAdmin) {
      audit.adminAction({
        adminIp: req.clientIp || null,
        action: commentId ? 'record-comment-edit' : 'record-comment-add',
        targetId: req.params.id,
        ok: !!r.ok,
        detail: { moveNo, commentId, hasText: !!(text && String(text).trim()) },
      });
    }
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  // 变着（添加一条变着走法）
  app.post('/api/records/:id/variation', (req, res) => {
    const guest = req.body && req.body.guest;
    const parent = req.body && req.body.parent;
    const move = req.body && req.body.move;
    const rec = records.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: '棋谱不存在' });
    if (!checkAdmin(req) && !records.isOwner(rec, guest)) {
      return res.status(403).json({ error: '无权操作' });
    }
    const r = records.addVariation(req.params.id, parent, move);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });
};
