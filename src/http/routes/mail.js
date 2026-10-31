'use strict';

/**
 * routes/mail.js — 邮箱验证 / 密码找回（1.7）。
 *
 * 找回接口刻意统一响应，不暴露“账号是否存在/邮箱是否绑定”。
 * 邮件服务未配置时返回 MAIL_UNAVAILABLE，管理员重置密码仍是兜底。
 */

const features = require('../../features');
const mail = require('../../mail');
const rateLimit = require('../../ratelimit');
const { resolveAccount, protocol } = require('../context');

module.exports = function registerMail(app) {
  const gate = (res) => {
    if (!features.isOn('mail')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '邮箱找回尚未开放' });
      return false;
    }
    return true;
  };

  app.post('/api/account/email', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const email = (req.body && req.body.email) || '';
    mail.requestEmailVerification(accountId, email).then((r) => {
      if (!r.ok) {
        const code = r.code === 'MAIL_UNAVAILABLE' ? 503 : 400;
        return res.status(code).json(r);
      }
      res.json({ ok: true, email: r.email, message: '验证邮件已发送，请查收' });
    }).catch((e) => {
      if (req.log) req.log.error('mail', '邮箱验证请求失败', { err: e });
      res.status(500).json({ ok: false, error: '邮件发送失败，请稍后重试' });
    });
  });

  app.post('/api/account/email/verify', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const r = mail.verifyEmail(req.body && req.body.token);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/account/password/forgot', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const identifier = (req.body && (req.body.identifier || req.body.email || req.body.username)) || '';
    mail.requestPasswordReset(identifier).then((r) => {
      if (!r.ok) {
        const code = r.code === 'MAIL_UNAVAILABLE' ? 503 : 500;
        return res.status(code).json(r);
      }
      res.json({ ok: true, message: '如果该账号绑定了已验证邮箱，重置邮件会很快送达' });
    }).catch((e) => {
      if (req.log) req.log.error('mail', '密码找回请求失败', { err: e });
      res.status(500).json({ ok: false, error: '请求失败，请稍后重试' });
    });
  });

  app.post('/api/account/password/reset', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const r = mail.resetPassword(req.body && req.body.token, req.body && req.body.password);
    if (!r.ok) return res.status(400).json(r);
    // 已建立的 WS 连接不会自动校验 tokenInvalidBefore，重置后主动踢下线。
    try { if (r.accountId) protocol.kickPlayer(r.accountId, '密码已重置，请重新登录'); } catch (_) {}
    res.json({ ok: true });
  });
};
