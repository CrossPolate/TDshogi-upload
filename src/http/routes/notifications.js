'use strict';

/** routes/notifications.js — 站内通知中心（1.7，受 FEATURE_NOTIFICATIONS 保护）。 */
const features = require('../../features');
const notifications = require('../../notifications');
const storage = require('../../storage');
const rateLimit = require('../../ratelimit');
const { resolveAccount } = require('../context');

module.exports = function registerNotifications(app) {
  const gate = (res) => {
    if (!features.isOn('notifications')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '通知中心尚未开放' });
      return false;
    }
    return true;
  };

  app.get('/api/notifications', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const limit = Number(req.query.limit) || 30;
    const offset = Number(req.query.offset) || 0;
    res.json({
      ok: true,
      unread: notifications.unread(actor),
      items: notifications.list(actor, { limit, offset }),
    });
  });

  app.post('/api/notifications/read', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const id = String((req.body && req.body.id) || '').trim();
    if (!id) return res.status(400).json({ ok: false, code: 'BAD_ID', error: '缺少通知 id' });
    const changed = storage.markNotificationRead(actor, id);
    res.json({ ok: true, changed: changed > 0, unread: notifications.unread(actor) });
  });

  app.post('/api/notifications/read-all', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = resolveAccount(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const changed = storage.markAllNotificationsRead(actor);
    res.json({ ok: true, changed, unread: 0 });
  });
};
