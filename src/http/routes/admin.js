/**
 * src/http/routes/admin.js — 管理后台 REST（PLAN §M2 从 `server.js` 拆出）
 *
 * 用户管理（封禁/改名/改分/改资料/删号）、审计查询、棋谱导入与元数据、赛事审核。
 *
 * ⚠️ **两条铁律**（§Q7 越权问题的修复成果，新增接口必须遵守）：
 *  1. **鉴权一律用 `adminOnly`**——不要自己写 `req.query.token && admin.verify(...)`。
 *     历史上正是因为每个接口各抄一份判定，「新增接口忘记写校验」成了一个静默存在的错误类别。
 *  2. **写操作一律用 `adminWrite(fn)`**——它顺带落审计日志（`audit.adminAction`）。
 *     绕过它直接 `res.json` 的写接口，事后查不到"是谁改的"。
 */
'use strict';

// ⚠️ 本文件是**管理后台路由**（`src/http/routes/admin.js`），
// 与 `src/admin.js`（管理身份校验模块）同名但不同物——看日志/堆栈时留意路径。
const auth = require('../../auth');
const accounts = require('../../accounts');
const ratings = require('../../ratings');
const tournaments = require('../../tournaments');
const audit = require('../../audit');
const rateLimit = require('../../ratelimit');
const ipban = require('../../ipban');
const net = require('../../net');
const announcements = require('../../announcements');
const reports = require('../../reports');
const { adminOnly, adminWrite, tournamentAction } = require('../middleware');
const { protocol, resolvePlayer } = require('../context');

/**
 * 管理端「用户 id」解析（Bug3）。
 *
 * 前端用户列表给的是 24 hex 会话 id，但历史/其它入口可能传来**账号会话令牌**
 * （`<accountId>.<ts>.<sig>`）——而 `auth.*` 系列（`adminRename`/`banPlayer`/`adminSetTitle`…）
 * 都要求 24 hex 会话 id，令牌会被 `getSessionRaw` 直接拒绝 → 管理端报「用户不存在」。
 * 这里统一走 http 层的 `resolvePlayer`（令牌 → accountId，游客/裸 id 原样返回），
 * 并对「是账号但缺会话文件」的情况补建会话，确保管理操作不因 id 形态而失败。
 *
 * 说明：身份解析只有 `resolvePlayer`（宽松读）与 `resolveOwner`（严格归属）两处，
 * 本函数复用前者，没有另抄一份判定。
 *
 * @param {string} raw 路径里的 :id
 * @returns {string|null} 规范化的会话 id，无法解析返回 null
 */
function resolveAdminUserId(raw) {
  const id = resolvePlayer(raw);
  if (!id) return null;
  if (!auth.getSessionRaw(id)) {
    const acct = accounts.getAccount(id);
    if (acct) auth.markAccountSession(id, acct.username); // 账号必然应有会话；缺则补建
  }
  return id;
}

module.exports = function registerAdmin(app) {
  // ---------- 全量数据（管理后台表格数据源） ----------

  // 全量棋谱（管理后台"全部棋谱"专供）：**仅管理员**。
  // 此前允许 ?player=<任意 id> 查询，而游客 id 在大厅/观战页是公开的
  // → 任何人可枚举他人棋谱（PLAN §Q7）。普通用户的检索一律走 WS `record_search`
  // （连接握手时已由 identify() 绑定身份，服务端强制按该身份过滤）。
  app.get('/api/history', rateLimit.expressMiddleware(rateLimit.heavy), adminOnly, (req, res) => {
    res.json(protocol.historyData(req.adminToken));
  });

  // 管理员：全部用户数据
  app.get('/api/admin/users', rateLimit.expressMiddleware(rateLimit.heavy), adminOnly, (req, res) => {
    res.json(protocol.adminUsersData(req.adminToken));
  });

  // 管理员：指定用户数据
  app.get('/api/admin/users/:id', adminOnly, (req, res) => {
    const uid = resolveAdminUserId(req.params.id);
    const data = uid ? protocol.adminUserData(uid, req.adminToken) : null;
    if (!data) return res.status(403).json({ error: '无管理员权限或用户不存在' });
    res.json(data);
  });

  // ---------- 用户管理写操作（PLAN §K3，全部写审计日志） ----------

  // 封禁（days>0 有期，否则永久；同时踢掉该身份全部在线连接）
  app.post('/api/admin/users/:id/ban', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'ban' };
    const r = auth.banPlayer(uid, { reason: body.reason, days: body.days, by: 'admin' });
    let kicked = 0;
    if (r.ok) {
      const untilTxt = r.banned.until ? `，至 ${new Date(r.banned.until).toLocaleString('zh-CN')}` : '';
      kicked = protocol.kickPlayer(uid, `你的账号已被封禁${r.banned.reason ? '：' + r.banned.reason : ''}${untilTxt}`);
    }
    return { ...r, action: 'ban', kicked };
  }));

  app.post('/api/admin/users/:id/unban', adminWrite((req) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'unban' };
    const r = auth.unbanPlayer(uid);
    return { ...r, action: 'unban' };
  }));

  // 改名（显示名；同步进行中对局内双方看到的名字）
  app.post('/api/admin/users/:id/rename', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'rename' };
    const r = auth.adminRename(uid, body.name);
    if (r.ok) {
      try { protocol.rooms.updatePlayerName(uid, r.name); } catch (_) {}
    }
    return { ...r, action: 'rename', audit: { to: r.name } };
  }));

  // 重置 ELO 与战绩
  app.post('/api/admin/users/:id/reset-rating', adminWrite((req) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'reset-rating' };
    const r = ratings.resetPlayer(uid);
    return { ...r, action: 'reset-rating' };
  }));

  // 编辑 ELO / 经验（等级随经验自动推导，PLAN §K7）
  app.post('/api/admin/users/:id/elo', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'edit-elo' };
    const r = ratings.adminSetPlayer(uid, { rating: body.rating, exp: body.exp });
    return { ...r, action: 'edit-elo', audit: { rating: body.rating, exp: body.exp } };
  }));

  // 重置密码（仅账号；新明文密码仅本次响应返回；同时使旧会话令牌全部失效）
  app.post('/api/admin/users/:id/reset-password', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'reset-password' };
    const r = accounts.adminResetPassword(uid, body.newPassword);
    return { ...r, action: 'reset-password', audit: { manual: !!body.newPassword } };
  }));

  // 编辑资料（手机号/棋风存账号；用户称号存会话，展示为「名称（称号）」——游客账号统一）
  app.post('/api/admin/users/:id/profile', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '用户不存在', action: 'update-profile' };
    let r = { ok: true, action: 'update-profile' };
    if (body.phone !== undefined || body.style !== undefined) {
      r = accounts.adminUpdateProfile(uid, { phone: body.phone, style: body.style });
    }
    if (r.ok && body.title !== undefined) {
      const tr = auth.adminSetTitle(uid, body.title);
      if (!tr.ok) r = tr;
    }
    return { ...r, action: 'update-profile', audit: { hasPhone: body.phone !== undefined, hasStyle: body.style !== undefined, hasTitle: body.title !== undefined } };
  }));

  // 删除账号（高危：body.confirm 必须为该账号用户名或 'DELETE'；棋谱保留、评级清空）
  app.delete('/api/admin/users/:id', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    const acct = uid ? accounts.getAccount(uid) : null;
    if (!acct) return { ok: false, error: '账号不存在（游客请直接删除会话对应记录）', action: 'delete-account' };
    if (body.confirm !== acct.username && body.confirm !== 'DELETE') {
      return { ok: false, error: `确认失败：请提交账号用户名「${acct.username}」或 DELETE`, action: 'delete-account' };
    }
    const kicked = protocol.kickPlayer(uid, '你的账号已被删除');
    const r = accounts.deleteAccount(uid);
    return { ...r, action: 'delete-account', kicked, audit: { username: r.username } };
  }));

  // ---------- 审计 / 棋谱导入 ----------

  // 管理员操作审计日志（PLAN §K4「操作审计」tab 数据源）
  app.get('/api/admin/audit', rateLimit.expressMiddleware(rateLimit.heavy), adminOnly, (req, res) => {
    res.json({ events: audit.query({ type: 'admin', limit: 200 }) });
  });

  // 管理员：导入 KIF 棋谱
  app.post('/api/admin/records/import', adminOnly, (req, res) => {
    const text = req.body && req.body.text;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: '缺少 KIF 文本' });
    const result = require('../../records').importKif(text);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, record: result.record });
  });

  // ⚠️ 2026-10-02 体验修复（问题 2「审计带上 adminId」）：这两个写接口没走 `adminWrite`
  // （手写审计），因此要自己带上管理员标识，否则审计里这一批事件永远是"无名"的。
  // `adminOnly` 已把 token 放进 `req.adminToken`；`tokenIdentity` 只取非敏感会话标识。

  // 设置公开/私有（管理员）
  app.post('/api/admin/records/:id/visibility', adminOnly, (req, res) => {
    const records = require('../../records');
    const r = records.setVisibility(req.params.id, (req.body || {}).visibility);
    audit.adminAction({ adminId: require('../../admin').tokenIdentity(req.adminToken), adminIp: req.clientIp || null, action: 'record-visibility', targetId: req.params.id, ok: !!r.ok, detail: { visibility: (req.body || {}).visibility } });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  });

  // 编辑展示信息（管理员）：标题/赛事/轮次/日期/标签/简介/双方名覆盖/结果说明/置顶
  app.post('/api/admin/records/:id/meta', adminOnly, (req, res) => {
    const records = require('../../records');
    const r = records.setMeta(req.params.id, req.body || {});
    audit.adminAction({ adminId: require('../../admin').tokenIdentity(req.adminToken), adminIp: req.clientIp || null, action: 'record-meta', targetId: req.params.id, ok: !!r.ok, detail: { fields: Object.keys(req.body || {}) } });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  });

  // ---------- 赛事管理（见 PLAN §E） ----------

  // 全量列表（含 pending_approval/rejected/cancelled）
  app.get('/api/admin/tournaments', adminOnly, (req, res) => {
    res.json({ tournaments: tournaments.listAllTournaments() });
  });

  app.post('/api/admin/tournaments/:id/approve', tournamentAction('approve'));
  app.post('/api/admin/tournaments/:id/reject', tournamentAction('reject'));
  app.post('/api/admin/tournaments/:id/cancel', tournamentAction('cancel'));

  // ---- T6 赛后存档（需求 11）----
  // ⚠️ 走 `adminWrite`（= `adminOnly` + 审计落盘），**不要**自己写 `checkAdmin`：
  // 绕开审计后，"谁把这场存档了/改了冠军"事后就查不到了。

  // 存档赛事：存档后主办人只读，管理员仍可编辑（每次编辑留痕）
  app.post('/api/admin/tournaments/:id/archive', adminWrite((req) => {
    const r = tournaments.archiveTournament(req.params.id, { id: null, isAdmin: true });
    return { ok: r.ok, error: r.error, action: 'tournament.archive', tournament: r.tournament };
  }));

  // 编辑已存档赛事：仅 `archived`，且字段收窄到结论性信息（冠军 / 备注）
  app.post('/api/admin/tournaments/:id/edit', adminWrite((req, body) => {
    const r = tournaments.editArchived(
      req.params.id, body.field, body.value,
      { id: null, isAdmin: true }, body.note
    );
    return {
      ok: r.ok, error: r.error, action: 'tournament.edit',
      // ⚠️ 2026-10-02 体验修复（问题 4）：无变更现在也回 ok（见 `tournaments/archive.js`
      // 的说明），因此审计里必须留下 `unchanged` —— 否则事后翻审计就分不清
      // "确实改过" 与 "点了一次保存但没改任何东西"（前者要留痕，后者不该留下假记录）。
      audit: {
        field: body.field,
        from: null,
        to: body.value == null ? null : String(body.value).slice(0, 80),
        unchanged: !!r.unchanged,
      },
      unchanged: !!r.unchanged,
      tournament: r.tournament,
    };
  }));

  // ---------- 举报（2026-09-20 用户要求）----------
  // 提交走 WS（对局页点按钮），查询与处理只在管理端。
  app.get('/api/admin/reports', rateLimit.expressMiddleware(rateLimit.heavy), adminOnly, (req, res) => {
    res.json({
      reports: reports.list(req.query.status || ''),
      pending: reports.pendingCount(),
      categories: reports.CATEGORIES,
    });
  });

  app.post('/api/admin/reports/:id', adminWrite((req, body) => {
    const r = reports.decide(req.params.id, body && body.status, body && body.note, 'admin');
    return {
      ok: r.ok, error: r.error, action: 'report.decide',
      audit: { id: req.params.id, status: body && body.status },
      report: r.report,
    };
  }));

  // ---------- §X IP 封禁 ----------

  // 列表 + 时长档位 + 请求者自己的 IP（前端据此提示"别把自己封了"）
  app.get('/api/admin/ipbans', adminOnly, (req, res) => {
    res.json({
      bans: ipban.list(),
      durations: ipban.DURATIONS,
      myIp: net.clientIp(req),
    });
  });

  app.post('/api/admin/ipbans', adminWrite((req, body) => {
    const b = body || {};
    const spec = String(b.ip || '').trim();

    // ⚠️ 防自锁（PLAN §X2）：不允许封"把管理员自己也圈进去"的规则。
    // 一旦封了，管理员连后台都进不来，只能上服务器改库——多数部署根本没这个通道。
    // ⚠️ 判定必须走位运算：`10.0.0.5` 是否落在 `10.0.0.0/24` 里，字符串比不出来。
    const myIp = net.clientIp(req);
    if (ipban.covers(spec, myIp)) {
      return { ok: false, error: `这条规则会把你自己（${myIp}）也封掉，已阻止`, action: 'ip-ban' };
    }

    // `hours` 直接透传：`undefined` 走默认 24h、`null` 表示永久（由 ipban.ban 统一解释）
    const r = ipban.ban(spec, { reason: b.reason, hours: b.hours, byId: 'admin' });
    return {
      ok: r.ok, error: r.error, action: 'ip-ban',
      audit: { ip: spec, reason: b.reason, hours: b.hours === null ? 'forever' : b.hours },
      record: r.record,
    };
  }));

  app.post('/api/admin/ipbans/unban', adminWrite((req, body) => {
    const r = ipban.unban(body && body.ip);
    return { ok: r.ok, error: r.error, action: 'ip-unban', audit: { ip: body && body.ip } };
  }));

  app.post('/api/admin/ipbans/extend', adminWrite((req, body) => {
    const hours = Number(body && body.hours);
    const r = ipban.extend(body && body.ip, hours);
    return {
      ok: r.ok, error: r.error, action: 'ip-ban-extend',
      audit: { ip: body && body.ip, hours },
    };
  }));

  // ---------- §C1 总览仪表盘 ----------
  // 一次凑齐"一眼看全局"要用的数字，省掉后台首屏打好几个请求。
  app.get('/api/admin/overview', adminOnly, (req, res) => {
    // ⚠️ 复用**公开出口** `homeData()` 的统计局（在线/进行中/等待中）——
    // 自己再算一遍迟早会与首页口径不一致（§T1 就是为统一这个口径而设的）。
    const home = protocol.homeData();
    const bans = ipban.list();
    res.json({
      stats: home.stats || {},
      activeGames: (home.games || []).length,
      recordsTotal: home.recordsTotal || 0,
      recentBattles: home.recentBattles || [],
      userCount: ratings.allUsers().length,
      tournamentCount: tournaments.listAllTournaments().length,
      announcementCount: announcements.listAnnouncements().length,
      banCount: bans.length,
      activeBanCount: bans.filter((b) => b.active).length,
      recentAudit: audit.query({ type: 'admin', limit: 8 }),
    });
  });

  // ---------- §C5 公告管理 ----------
  // 此前公告只能手改 data/announcements.json —— 后端本来就有读写能力，后台却一直没有入口。

  app.get('/api/admin/announcements', adminOnly, (req, res) => {
    res.json({
      announcements: announcements.listAnnouncements(),
      limits: {
        title: announcements.MAX_TITLE,
        content: announcements.MAX_CONTENT,
        count: announcements.MAX_COUNT,
      },
    });
  });

  app.post('/api/admin/announcements', adminWrite((req, body) => {
    const r = announcements.addAnnouncement({ title: body.title, content: body.content, pinned: !!body.pinned });
    return {
      ok: r.ok, error: r.error, action: 'announcement.add',
      audit: { title: String(body.title || '').slice(0, 60) },
      announcement: r.announcement,
    };
  }));

  app.post('/api/admin/announcements/:id/update', adminWrite((req, body) => {
    const r = announcements.updateAnnouncement(req.params.id, {
      title: body.title, content: body.content, pinned: body.pinned,
    });
    return {
      ok: r.ok, error: r.error, action: 'announcement.update',
      audit: { id: req.params.id, pinned: body.pinned },
      announcement: r.announcement,
    };
  }));

  app.post('/api/admin/announcements/:id/delete', adminWrite((req) => {
    const r = announcements.deleteAnnouncement(req.params.id);
    return { ok: r.ok, error: r.error, action: 'announcement.delete', audit: { id: req.params.id } };
  }));

  // ---------- 道具系统（2026-10-03 新功能：后台发放入口）----------
  // 一期没有独立的道具后台，把 `tools/item-admin.js` 的三个动作（grant / coin / code）搬到这里，
  // 顺便让每一次发放都自动落审计（含 `adminId`，能查到"谁发的"）。
  // ⚠️ 铁律照旧：读用 `adminOnly`，写用 `adminWrite`。
  // ⚠️ 这里用**行内 require**：道具模块与后台路由无其它耦合，行内引入可避免在文件顶部再多一条依赖。
  const itemsMod = require('../../items');

  // 目录（前端据此渲染道具下拉与价格）
  app.get('/api/admin/items/catalog', adminOnly, (req, res) => {
    res.json({ catalog: itemsMod.catalog(), slots: itemsMod.SLOTS });
  });

  // 某账号的钱包 / 拥有 / 装备（`:id` 走 resolveAdminUserId；账号 id 即道具存储键）
  app.get('/api/admin/items/account/:id', adminOnly, (req, res) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return res.status(404).json({ error: '账号不存在' });
    const snap = itemsMod.snapshot(uid);
    res.json({ accountId: uid, wallet: snap.wallet, owned: snap.owned, equipped: snap.equipped });
  });

  // 发道具（不校验价格）
  app.post('/api/admin/items/account/:id/grant', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '账号不存在', action: 'item-grant' };
    const itemId = (body && body.itemId) || '';
    const r = itemsMod.grant(uid, itemId, 'admin');
    return {
      ...r, action: 'item-grant',
      audit: { accountId: uid, itemId },
      wallet: itemsMod.snapshot(uid).wallet,
    };
  }));

  // 加/减货币（amount 为整数，可为负）
  app.post('/api/admin/items/account/:id/coin', adminWrite((req, body) => {
    const uid = resolveAdminUserId(req.params.id);
    if (!uid) return { ok: false, error: '账号不存在', action: 'item-coin' };
    const amount = Number(body && body.amount);
    const r = itemsMod.addCoin(uid, amount);
    return {
      ...r, action: 'item-coin',
      audit: { accountId: uid, amount },
      owned: itemsMod.snapshot(uid).owned,
    };
  }));

  // 定义/覆盖兑换码（itemId 空 = 只发币）
  app.post('/api/admin/items/code', adminWrite((req, body) => {
    const code = String((body && body.code) || '').trim();
    if (!code) return { ok: false, error: '兑换码不能为空', action: 'item-code' };
    const def = itemsMod.defineCode(code, {
      itemId: (body && body.itemId) || null,
      coin: Number(body && body.coin) || 0,
      maxUses: Number(body && body.maxUses) || 1,
    });
    return {
      ...def, action: 'item-code',
      audit: { code, itemId: def.itemId, coin: def.coin, maxUses: def.maxUses },
      code: def,
    };
  }));

  // ---------- §C6 实时干预 ----------

  // 在线房间列表（含私人房——见 rooms/adminRooms 的注释）
  app.get('/api/admin/rooms', adminOnly, (req, res) => {
    res.json({ rooms: protocol.rooms.adminRooms() });
  });

  // 强制解散房间（房内的人会收到 room_closed）
  app.post('/api/admin/rooms/:id/close', adminWrite((req) => {
    const r = protocol.rooms.adminCloseRoom(req.params.id);
    return {
      ok: r.ok, error: r.error, action: 'room.close',
      audit: r.info || { roomId: req.params.id },
    };
  }));

  // 强制下线某玩家（踢连接；对局中会走断线判负流程）
  app.post('/api/admin/kick', adminWrite((req, body) => {
    const id = body && body.playerId;
    if (!id) return { ok: false, error: '缺少 playerId', action: 'player.kick' };
    const kicked = protocol.kickPlayer(id, (body && body.message) || '你已被管理员强制下线');
    return { ok: true, action: 'player.kick', kicked, audit: { playerId: id, kicked } };
  }));

  // ---------- 商品管理（2026-10-07）：素材上传 / 目录 CRUD / BGM 三轨 ----------

  // 上传素材（头像 256×256 / 立绘 / BGM）。body: { kind, filename, data(base64) }
  app.post('/api/admin/items/upload', adminWrite((req, body) => {
    const kind = body && body.kind;
    const filename = (body && body.filename) || '';
    const data = body && body.data;
    if (!data || typeof data !== 'string') {
      return { ok: false, error: '缺少文件数据', action: 'item-upload' };
    }
    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch (_) {
      return { ok: false, error: '文件数据解码失败', action: 'item-upload' };
    }
    const r = itemsMod.assets.saveAsset(kind, filename, buf);
    return {
      ...r,
      action: 'item-upload',
      audit: r.ok
        ? { kind, assetId: r.asset.id, size: r.asset.size, width: r.asset.width, height: r.asset.height }
        : { kind, error: r.error, code: r.code },
    };
  }));

  // 素材列表（按 kind 可选过滤）
  app.get('/api/admin/items/assets', adminOnly, (req, res) => {
    res.json({ assets: itemsMod.assets.listAssets(req.query.kind || null) });
  });

  // 删除素材（仅清文件与注册；商品若还引用着 URL，由管理员自行改商品）
  app.post('/api/admin/items/assets/:id/delete', adminWrite((req) => {
    const r = itemsMod.assets.deleteAsset(req.params.id);
    return { ...r, action: 'item-asset-delete', audit: { assetId: req.params.id } };
  }));

  // 新建 / 覆盖商品（写入 data/items-catalog.json）
  app.post('/api/admin/items/catalog', adminWrite((req, body) => {
    const r = itemsMod.upsertItem(body || {});
    return {
      ...r,
      action: 'item-catalog-upsert',
      audit: r.ok ? { id: r.item.id, type: r.item.type, price: r.item.price } : { error: r.error, code: r.code },
    };
  }));

  // 删除商品（内置项不可删，只可覆盖）
  app.post('/api/admin/items/catalog/:id/delete', adminWrite((req) => {
    const r = itemsMod.deleteItem(req.params.id);
    return { ...r, action: 'item-catalog-delete', audit: { id: req.params.id, ...r } };
  }));

  // BGM 三轨读写（菜单 / 开局 / 终盘）
  app.get('/api/admin/items/bgm-roles', adminOnly, (req, res) => {
    res.json({ ok: true, roles: itemsMod.getBgmRoles(), phases: itemsMod.bgmRoles.PHASES, labels: itemsMod.bgmRoles.PHASE_LABELS });
  });

  app.post('/api/admin/items/bgm-roles', adminWrite((req, body) => {
    const r = itemsMod.setBgmRoles(body || {});
    return {
      ...r,
      action: 'item-bgm-roles',
      audit: r.ok ? r.roles : { error: r.error, code: r.code },
    };
  }));
};
