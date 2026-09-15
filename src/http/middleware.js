/**
 * src/http/middleware.js — HTTP 中间件与鉴权包装（PLAN §M2 从 `server.js` 拆出）
 *
 * 这里集中三件**跨路由**的事：
 *  1. `requestId`：给每个请求分配短 id（§P4），写响应头 + 挂 `req.log`；
 *  2. `adminEntryGate`：管理后台入口隐蔽（§J5，`ADMIN_ENTRY_KEY`）；
 *  3. 管理鉴权与写操作包装（`adminOnly` / `adminWrite` / `tournamentAction`）——
 *     **注意所有管理路由都走同一个 `adminOnly`**，绝不在这里再判一次权限：
 *     「两套判定并存」正是 §Q7-1 越权问题的成因。
 *
 * 拆出来的理由：这些是「横切关注点」，原先夹在 45 条路由之间，改一处鉴权要在文件里翻半天；
 * 而且新增管理接口时**看不到**别人怎么写的鉴权，很容易又抄一份（就是那个错误类别的复现路径）。
 */
'use strict';

const audit = require('../audit');
const log = require('../logger');
const net = require('../net');
const ipban = require('../ipban');
const { checkAdmin, protocol } = require('./context');

/**
 * 安全响应头（PLAN §Q7 余项，2026-09-15）。
 *
 * ## 为什么这里**没有** CSRF 防护
 * 本项目的凭证**全部走请求头**（`x-admin-token` / `x-account-token`），
 * **不使用 Cookie**——浏览器不会自动携带它们，第三方站点无法伪造"带凭证的请求"，
 * 所以 CSRF 面天然不存在。
 * ⚠️ **将来若改成用 Cookie 存 token，必须同步补 CSRF token**（届时这条注释就是提醒）。
 *
 * ## 各头的作用
 *  - `X-Content-Type-Options: nosniff` —— 禁止浏览器猜类型（挡"上传的 .png 其实是 HTML"这类）；
 *  - `X-Frame-Options` + `frame-ancestors` —— 防点击劫持（管理后台尤其需要）；
 *  - `Referrer-Policy` —— 跨站时不泄露完整 URL（对局/复盘页 URL 里带 room/record id）；
 *  - `Content-Security-Policy` —— ⚠️ 保留 `'unsafe-inline'` 是**被迫的**：
 *    页面里有大量 inline `onclick` / `style`（历史写法），一旦收紧会直接打挂整个前端。
 *    现阶段它的实际价值是**兜住外链脚本**：`script-src` 只允许本站。
 *    等 inline 写法清理干净后，再把 `'unsafe-inline'` 去掉（那时 CSP 才真正形成防线）。
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    // ⚠️ Google Fonts 必须显式放行：`public/css/style.css` 用 `@import` 引了
    // Noto Serif SC / Noto Sans SC。收紧 CSP 时漏掉这两个 host，字体会**静默回退到系统字体**
    // —— 没有任何报错，只是全站排版悄悄变了样（本次就是这样被发现的）。
    // `@import` 取的是 CSS，走 `style-src`；真正的字体文件在 gstatic 上，走 `font-src`。
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' ws: wss:", // WS 是对局主通道，必须放行
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  next();
}

/**
 * IP 封禁门（PLAN §X4 的**第一个生效点**）。
 *
 * ⚠️ 挂载位置：**`requestId` 之后、限流之前**。
 *  - 在 `requestId` 之后 → 被封时日志能带上 requestId，用户报障时可对账；
 *  - 在限流之前 → 被封的 IP 不该继续消耗限流计数，也不该污染限流统计。
 *
 * ⚠️ 它**只挡 HTTP**。WS 那侧由 `server.js` 的 `verifyClient` 拦——
 * **两个都要有，只挡一处等于没封**（WS 才是对局主通道）。
 */
function ipBanGate(req, res, next) {
  const ip = req.clientIp || net.clientIp(req);
  const r = ipban.check(ip);
  if (r.banned) {
    if (req.log) {
      req.log.warn('ipban', '拒绝已封禁 IP 的请求', {
        ip, reason: r.record.reason, path: req.originalUrl || req.url,
      });
    }
    // 明确告知、不静默：静默会让被封者反复重试（刷日志），也让用户以为"网站坏了"
    return res.status(403).json({ error: '该网络地址已被禁止访问本站', banned: true });
  }
  next();
}

/** 管理后台入口门禁用的 key（未设置时保持开放，避免把自己锁在门外） */
const ADMIN_ENTRY_KEY = process.env.ADMIN_ENTRY_KEY || '';

/**
 * 请求标识（PLAN §P4）：分配 8 位短 id → 响应头 `X-Request-Id` + `req.log`（带 requestId 的子 logger）。
 * 价值：用户报障时只要报这个 id，就能在日志里定位到那一次请求，不必靠"大概几点几分"去猜。
 */
function requestId(req, res, next) {
  const id = Math.random().toString(36).slice(2, 10);
  req.id = id;
  req.log = log.child({ requestId: id });
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * 管理后台入口门禁（PLAN §J5）：设置 `ADMIN_ENTRY_KEY` 后，访问 `/admin.html` 必须带 `?k=<key>`，
 * 否则按 404 处理——连"后台存在"这件事都不暴露。未设置该变量时保持开放。
 * 注：这层只是入口隐蔽，真正的权限校验仍在 `admin.verify`（所有 `/api/admin/*` 均校验）。
 */
function adminEntryGate(req, res, next) {
  if (ADMIN_ENTRY_KEY && req.path === '/admin.html' && req.query.k !== ADMIN_ENTRY_KEY) {
    return res.status(404).send('Not Found');
  }
  next();
}

/**
 * Express 中间件版：`app.get(path, adminOnly, handler)`。
 * 鉴权通过后把 token 放进 `req.adminToken`，handler 直接取用，不必再解析一次。
 */
function adminOnly(req, res, next) {
  const token = checkAdmin(req);
  if (!token) return res.status(403).json({ error: '无管理员权限' });
  req.adminToken = token;
  next();
}

/**
 * 管理写路由统一包装：鉴权交给 `adminOnly` → 执行业务 → `audit.adminAction` 落审计。
 * handler(req, body) 返回 {ok, action, error?, audit?, ...data}；ok=false 时返回 400 与 error。
 *
 * 返回**处理函数数组**，Express 会依次执行 → 调用处 `app.post(path, adminWrite(fn))` 无需改动，
 * 而鉴权与读接口走的是**同一个 `adminOnly`**（不在这里再判一次，避免两套判定并存）。
 */
function adminWrite(handler) {
  const h = (req, res) => {
    let r;
    try {
      r = handler(req, req.body || {}) || { ok: false, error: '无结果' };
    } catch (err) {
      req.log.error('admin', '写操作异常', { err });
      // 带上真实原因：吞成笼统的"服务器内部错误"会让排障无从下手（2026-09-05 备注/封禁报障教训）
      r = { ok: false, error: `服务器内部错误: ${err.message}`, action: 'unknown', requestId: req.id };
    }
    const { action, audit: detail, ...data } = r;
    audit.adminAction({
      adminIp: req.clientIp || null,
      action: action || 'unknown',
      targetId: req.params.id || null,
      ok: !!r.ok,
      detail: detail || null,
    });
    if (!r.ok) return res.status(400).json({ error: r.error || '操作失败' });
    res.json({ ok: true, ...data });
  };
  return [adminOnly, h];
}

/** 赛事审核/取消动作（幂等：状态已变更返回 400） */
function tournamentAction(action) {
  const h = (req, res) => {
    const tournaments = require('../tournaments');
    const id = req.params.id;
    let r;
    if (action === 'approve') r = tournaments.approveTournament(id);
    else if (action === 'reject') r = tournaments.rejectTournament(id, req.body && req.body.reason);
    else r = tournaments.cancelTournament(id, req.body && req.body.reason);
    if (!r.ok) return res.status(400).json(r);
    // 取消时解散其进行中/等待中的对局房间（房内收 room_closed）
    if (r.matchIds && r.matchIds.length) {
      r.dissolvedMatches = protocol.rooms.dissolveTournamentMatches(r.matchIds);
    }
    res.json(r);
  };
  return [adminOnly, h]; // 同 adminWrite：返回数组，调用处不变，鉴权走同一个 adminOnly
}

module.exports = {
  requestId, securityHeaders, adminEntryGate, adminOnly, adminWrite,
  tournamentAction, ADMIN_ENTRY_KEY, ipBanGate,
};
