'use strict';

/** routes/studies.js — 开局统计（1.9，受 FEATURE_STUDIES 保护）。 */
const features = require('../../features');
const studies = require('../../studies');
const rateLimit = require('../../ratelimit');
const { resolveAccount } = require('../context');
const records = require('../../records');

module.exports = function registerStudies(app) {
  const gate = (res) => {
    if (!features.isOn('studies')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '开局统计尚未开放' });
      return false;
    }
    return true;
  };

  app.get('/api/studies/openings', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const limit = Number(req.query.limit) || 12;
    res.json({ ok: true, ...studies.openingStats({ limit }) });
  });

  app.get('/api/studies', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    res.json({ ok: true, studies: studies.list(actor) });
  });

  app.post('/api/studies', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = studies.create(actor, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.get('/api/studies/:id', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    const r = studies.detail(req.params.id, actor);
    if (!r.ok) return res.status(r.code === 'FORBIDDEN' ? 403 : 404).json(r);
    r.items = (r.items || []).map((it) => {
      const rec = records.getRecord(it.recordId);
      return {
        ...it,
        record: rec ? { id: rec.id, names: rec.names, result: rec.result, moveCount: (rec.moves || []).length } : null,
      };
    });
    res.json(r);
  });

  app.post('/api/studies/:id/items', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = studies.addItem(actor, req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.delete('/api/studies/:id/items/:recordId', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = studies.removeItem(actor, req.params.id, req.params.recordId, req.query.ply || 0);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.delete('/api/studies/:id', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = studies.remove(actor, req.params.id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });
};
