/**
 * src/http/routes/accounts.js — 账号与会话 REST（PLAN §M2 从 `server.js` 拆出）
 *
 * 注册 / 登录 / 令牌校验（`/api/me`）/ 个人资料（§F：手机号[私密]、棋风）。
 *
 * ⚠️ 这里每条接口都**必须自己校验令牌**——它们不走 `adminOnly`，
 * 因为面对的是普通用户而非管理员。`/api/me` 与两个 profile 接口都返回 401，
 * 而不是 403：前者是"没登录"，后者是"登录了但没权限"，语义不同，前端据此决定是否跳登录页。
 *
 * ⚠️ 2026-10-04 架构优化（体检 #8）：令牌取参统一走 `context.resolveAccount(req)`——
 * 本文件不再自持 `query.token` / `x-session-token` 的口径（口径只留一处，新增接口不会抄错）。
 */
'use strict';

const accounts = require('../../accounts');
// ⚠️ 本文件（`src/http/routes/accounts.js`）与 `src/accounts.js` 同名但不同物：
// 后者是账号存储域模块（上一行），本文件是它的 HTTP 路由。
const rateLimit = require('../../ratelimit');
const { resolveAccount } = require('../context');

module.exports = function registerAccounts(app) {
  // 注册：{username, password, guestId?}（guestId 用于游客升级保留数据）
  app.post('/api/register', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    const { username, password, guestId, migrationKey } = req.body || {};
    const r = accounts.register(username, password, guestId || null, migrationKey || null);
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

  // 令牌校验/账号信息：GET /api/me?token=xxx（也接受 x-session-token / x-account-token）
  app.get('/api/me', (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    res.json({ ok: true, account: accounts.getAccount(accountId) });
  });

  // ==================================================================
  // 个人资料（PLAN §F：手机号[私密]/棋风/注册日期）
  // ==================================================================

  // 本人资料（含手机号私密字段；需有效令牌）
  app.get('/api/account/profile', (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    res.json({ ok: true, account: accounts.getOwnProfile(accountId) });
  });

  // 更新资料（phone 传空串=清除；style 需在预设枚举内）
  app.post('/api/account/profile', (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    const body = req.body || {};
    const r = accounts.updateProfile(accountId, { phone: body.phone, style: body.style });
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, profile: r.profile });
  });
};
