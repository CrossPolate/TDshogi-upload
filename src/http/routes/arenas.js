'use strict';

/** routes/arenas.js — Arena-lite 竞技场（1.8，受 FEATURE_ARENAS 保护）。 */
const features = require('../../features');
const arenas = require('../../arenas');
const auth = require('../../auth');
const accounts = require('../../accounts');
const rateLimit = require('../../ratelimit');
const { resolveAccount } = require('../context');

function nameOf(id) {
  const s = auth.load(id);
  if (s && s.name) return s.name;
  const a = accounts.getAccount(id);
  return (a && (a.nickname || a.username)) || String(id).slice(0, 6);
}

module.exports = function registerArenas(app) {
  const gate = (res) => {
    if (!features.isOn('arenas')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '竞技场尚未开放' });
      return false;
    }
    return true;
  };

  app.get('/api/arenas', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const viewer = resolveAccount(req);
    res.json({
      ok: true,
      arenas: arenas.list(viewer),
      roundMinutes: arenas.ROUND_MINUTES,
      timeControls: arenas.ARENA_TIME_CONTROLS,
    });
  });

  app.post('/api/arenas', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const b = req.body || {};
    const r = arenas.create(
      { id: actor, name: nameOf(actor) },
      { name: b.name, startsAt: b.startsAt, endsAt: b.endsAt, roundMinutes: b.roundMinutes, timeControl: b.timeControl }
    );
    if (!r.ok) return res.status(r.code === 'LEVEL_REQUIRED' ? 403 : 400).json(r);
    res.json(r);
  });

  app.get('/api/arenas/:id', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const a = arenas.getArena(req.params.id);
    if (!a) return res.status(404).json({ ok: false, code: 'NO_ARENA', error: '竞技场不存在' });
    res.json({ ok: true, arena: arenas.detail(a, resolveAccount(req)) });
  });

  app.post('/api/arenas/:id/join', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = arenas.join(req.params.id, { id: actor, name: nameOf(actor) });
    if (!r.ok) return res.status(r.code === 'AUTH' ? 401 : 400).json(r);
    res.json(r);
  });

  app.post('/api/arenas/:id/leave', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = arenas.leave(req.params.id, actor);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true });
  });

  app.post('/api/arenas/:id/cancel', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = arenas.cancel(req.params.id, actor);
    if (!r.ok) return res.status(r.code === 'FORBIDDEN' ? 403 : 400).json(r);
    res.json({ ok: true });
  });
};
