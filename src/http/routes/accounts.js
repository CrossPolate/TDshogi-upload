/**
 * src/http/routes/accounts.js — 账号与会话 REST（PLAN §M2 从 `server.js` 拆出）
 *
 * 注册 / 登录 / 令牌校验（`/api/me`）/ 个人资料（§F：手机号[私密]、棋风）。
 *
 * ⚠️ 这里每条接口都**必须自己校验令牌**（`accounts.verifyToken`）——它们不走 `adminOnly`，
 * 因为面对的是普通用户而非管理员。`/api/me` 与两个 profile 接口都返回 401，
 * 而不是 403：前者是"没登录"，后者是"登录了但没权限"，语义不同，前端据此决定是否跳登录页。
 */
'use strict';

const accounts = require('../../accounts');
// ⚠️ 本文件（`src/http/routes/accounts.js`）与 `src/accounts.js` 同名但不同物：
// 后者是账号存储域模块（上一行），本文件是它的 HTTP 路由。
const rateLimit = require('../../ratelimit');

module.exports = function registerAccounts(app) {
  // 注册：{username, password, guestId?}（guestId 用于游客升级保留数据）
  app.post('/api/register', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    const { username, password, guestId } = req.body || {};
    const r = accounts.register(username, password, guestId || null);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, token: accounts.issueToken(r.account.id), account: r.account });
  });

  // 登录：{username, password}
  app.post('/api/login', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    const { username, password } = req.body || {};
    const r = accounts.login(username, password);
    if (!r.ok) return res.status(401).json({ error: r.error });
    res.json({ ok: true, token: r.token, account: r.account });
  });

  // 令牌校验/账号信息：GET /api/me?token=xxx
  app.get('/api/me', (req, res) => {
    const token = req.query.token || req.headers['x-session-token'] || null;
    const accountId = accounts.verifyToken(token);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    res.json({ ok: true, account: accounts.getAccount(accountId) });
  });

  // ==================================================================
  // 个人资料（PLAN §F：手机号[私密]/棋风/注册日期）
  // ==================================================================

  // 本人资料（含手机号私密字段；需有效令牌）
  app.get('/api/account/profile', (req, res) => {
    const accountId = accounts.verifyToken(req.query.token || '');
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    res.json({ ok: true, account: accounts.getOwnProfile(accountId) });
  });

  // 更新资料（phone 传空串=清除；style 需在预设枚举内）
  app.post('/api/account/profile', (req, res) => {
    const body = req.body || {};
    const accountId = accounts.verifyToken(body.token || '');
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    const r = accounts.updateProfile(accountId, { phone: body.phone, style: body.style });
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, profile: r.profile });
  });
};
