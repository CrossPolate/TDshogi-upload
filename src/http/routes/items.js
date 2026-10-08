/**
 * src/http/routes/items.js — 道具系统 REST（DESIGN §6）
 *
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 端点：
 *   GET  /api/items           我的装扮快照（需登录，未登录 401）
 *   GET  /api/items/catalog   目录（公开，**不含素材地址**）
 *   POST /api/items/equip     {token, slot, itemId|null}
 *   POST /api/items/buy       {token, itemId}
 *   POST /api/items/redeem    {token, code}
 *
 * ⚠️ 鉴权同 `/api/account/profile`：未登录返回 **401**（语义是「没登录」，非 403）。
 * ⚠️ 2026-10-04 架构优化（体检 #8）：取参统一走 `context.resolveAccount(req)`
 * —— 原先本文件自带 `tokenOf()`（`body.token` / `query.token` / `x-session-token`），
 * 又是一份口径；现在全项目只剩 `resolveAccount` 一处。
 *
 * ⚠️ 2026-10-03 架构优化（两项）：
 *  1. 公开 `/api/items/catalog` 回 `items.publicCatalog()` —— **只回元信息**，不带 `asset`。
 *  2. 三个写接口加**更严限流档**（`rateLimit.auth`）：货币/兑换是敏感写路径。
 */
'use strict';

const rateLimit = require('../../ratelimit');
const items = require('../../items');
const { resolveAccount } = require('../context');

module.exports = function registerItems(app) {
  // 我的装扮快照（未登录 401）——目录已按「已拥有/免费」裁剪 `asset`
  app.get('/api/items', (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    res.json({ ok: true, ...items.snapshot(accountId) });
  });

  // 目录（公开）——**只回元信息**，不带素材地址
  app.get('/api/items/catalog', (req, res) => {
    res.json({ ok: true, catalog: items.publicCatalog() });
  });

  // BGM 三轨（公开可读；带上 token 则按「玩家装备」覆盖系统默认）
  // ⚠️ 2026-10-08：三首默认 BGM 人人自带且默认装备 —— 登录后返回装备轨，游客走系统轨。
  // 同时下发 appearance（棋子图集 / 读秒音，装扮槽位），前端启动时一次拉齐。
  app.get('/api/items/bgm-roles', (req, res) => {
    const accountId = resolveAccount(req);
    res.json({
      ok: true,
      roles: items.bgmTracksFor(accountId),
      appearance: items.appearanceFor(accountId),
    });
  });

  // 装备 / 卸下（itemId 传 null 表示卸下）
  app.post('/api/items/equip', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    const body = req.body || {};
    const r = items.equip(accountId, body.slot, body.itemId === undefined ? null : body.itemId);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, equipped: r.equipped });
  });

  // 货币购买
  app.post('/api/items/buy', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    const r = items.buy(accountId, (req.body || {}).itemId);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, wallet: r.wallet, owned: r.owned });
  });

  // 兑换码
  app.post('/api/items/redeem', rateLimit.expressMiddleware(rateLimit.auth), (req, res) => {
    const accountId = resolveAccount(req);
    if (!accountId) return res.status(401).json({ error: '未登录或令牌已失效' });
    const r = items.redeem(accountId, (req.body || {}).code);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, owned: r.owned, wallet: r.wallet });
  });
};
