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
const { protocol } = require('../context');

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
    const data = protocol.adminUserData(req.params.id, req.adminToken);
    if (!data) return res.status(403).json({ error: '无管理员权限或用户不存在' });
    res.json(data);
  });

  // ---------- 用户管理写操作（PLAN §K3，全部写审计日志） ----------

  // 封禁（days>0 有期，否则永久；同时踢掉该身份全部在线连接）
  app.post('/api/admin/users/:id/ban', adminWrite((req, body) => {
    const r = auth.banPlayer(req.params.id, { reason: body.reason, days: body.days, by: 'admin' });
    let kicked = 0;
    if (r.ok) {
      const untilTxt = r.banned.until ? `，至 ${new Date(r.banned.until).toLocaleString('zh-CN')}` : '';
      kicked = protocol.kickPlayer(req.params.id, `你的账号已被封禁${r.banned.reason ? '：' + r.banned.reason : ''}${untilTxt}`);
    }
    return { ...r, action: 'ban', kicked };
  }));

  app.post('/api/admin/users/:id/unban', adminWrite((req) => {
    const r = auth.unbanPlayer(req.params.id);
    return { ...r, action: 'unban' };
  }));

  // 改名（显示名；同步进行中对局内双方看到的名字）
  app.post('/api/admin/users/:id/rename', adminWrite((req, body) => {
    const r = auth.adminRename(req.params.id, body.name);
    if (r.ok) {
      try { protocol.rooms.updatePlayerName(req.params.id, r.name); } catch (_) {}
    }
    return { ...r, action: 'rename', audit: { to: r.name } };
  }));

  // 重置 ELO 与战绩
  app.post('/api/admin/users/:id/reset-rating', adminWrite((req) => {
    const r = ratings.resetPlayer(req.params.id);
    return { ...r, action: 'reset-rating' };
  }));

  // 编辑 ELO / 经验（等级随经验自动推导，PLAN §K7）
  app.post('/api/admin/users/:id/elo', adminWrite((req, body) => {
    const r = ratings.adminSetPlayer(req.params.id, { rating: body.rating, exp: body.exp });
    return { ...r, action: 'edit-elo', audit: { rating: body.rating, exp: body.exp } };
  }));

  // 重置密码（仅账号；新明文密码仅本次响应返回；同时使旧会话令牌全部失效）
  app.post('/api/admin/users/:id/reset-password', adminWrite((req, body) => {
    const r = accounts.adminResetPassword(req.params.id, body.newPassword);
    return { ...r, action: 'reset-password', audit: { manual: !!body.newPassword } };
  }));

  // 编辑资料（手机号/棋风存账号；用户称号存会话，展示为「名称（称号）」——游客账号统一）
  app.post('/api/admin/users/:id/profile', adminWrite((req, body) => {
    let r = { ok: true, action: 'update-profile' };
    if (body.phone !== undefined || body.style !== undefined) {
      r = accounts.adminUpdateProfile(req.params.id, { phone: body.phone, style: body.style });
    }
    if (r.ok && body.title !== undefined) {
      const tr = auth.adminSetTitle(req.params.id, body.title);
      if (!tr.ok) r = tr;
    }
    return { ...r, action: 'update-profile', audit: { hasPhone: body.phone !== undefined, hasStyle: body.style !== undefined, hasTitle: body.title !== undefined } };
  }));

  // 删除账号（高危：body.confirm 必须为该账号用户名或 'DELETE'；棋谱保留、评级清空）
  app.delete('/api/admin/users/:id', adminWrite((req, body) => {
    const acct = accounts.getAccount(req.params.id);
    if (!acct) return { ok: false, error: '账号不存在（游客请直接删除会话对应记录）', action: 'delete-account' };
    if (body.confirm !== acct.username && body.confirm !== 'DELETE') {
      return { ok: false, error: `确认失败：请提交账号用户名「${acct.username}」或 DELETE`, action: 'delete-account' };
    }
    const kicked = protocol.kickPlayer(req.params.id, '你的账号已被删除');
    const r = accounts.deleteAccount(req.params.id);
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

  // 设置公开/私有（管理员）
  app.post('/api/admin/records/:id/visibility', adminOnly, (req, res) => {
    const records = require('../../records');
    const r = records.setVisibility(req.params.id, (req.body || {}).visibility);
    audit.adminAction({ adminIp: req.clientIp || null, action: 'record-visibility', targetId: req.params.id, ok: !!r.ok, detail: { visibility: (req.body || {}).visibility } });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  });

  // 编辑展示信息（管理员）：标题/赛事/轮次/日期/标签/简介/双方名覆盖/结果说明/置顶
  app.post('/api/admin/records/:id/meta', adminOnly, (req, res) => {
    const records = require('../../records');
    const r = records.setMeta(req.params.id, req.body || {});
    audit.adminAction({ adminIp: req.clientIp || null, action: 'record-meta', targetId: req.params.id, ok: !!r.ok, detail: { fields: Object.keys(req.body || {}) } });
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
      audit: { field: body.field, from: null, to: body.value == null ? null : String(body.value).slice(0, 80) },
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
};
