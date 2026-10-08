/**
 * protocol.js — WebSocket 消息路由（**连接骨架 + 路由分发入口**）
 *
 * 负责：
 *  - 连接管理（建立/关闭/断线重连）
 *  - 游客鉴权（根据客户端 guestId 建立会话；B1 持有证明见 `auth.identify`）
 *  - 客户端 → 服务端消息分发（switch **一行一分支**，转发到 handlers）
 *  - 服务端 → 客户端消息回发（广播）
 *
 * 客户端消息（type 字段）：
 *   create_room / join_room / quick_match / cancel_match /
 *   move / resign / rematch / spectate / random_spectate /
 *   leave / rename / request_state / create_tournament / join_tournament
 *
 * 服务端消息（type 字段）：
 *   hello / matched / game_start / state / clock / move_invalid /
 *   game_over / spectator_update / error
 *
 * ⚠️ 这里**只列真正会发出的消息**（2026-09-23 审查 P2-4）：原先还写着 `elo_updated` 与
 * `tournament_update`，但全项目**从未发送过** —— 客户端照着文档等一个永远不来的消息，
 * 排障时会白查一轮。要么实现、要么从文档删掉；这两个的语义已由 `state`（含评级变化后的
 * 对局状态）与 `tournament_update`→`tournament_detail` 的 HTTP 拉取覆盖，故删文档。
 *
 * ⚠️ **§M2 拆分（2026-09-28）**：本文件原先 698 行、27 个 case 体全挤在 `_routeInner` 里。
 * 现按职责把 **case 体**拆到 `src/protocol/handlers/` 下的 mixin，以
 * `Object.assign(Protocol.prototype, …)` 注入（与 `rooms.js` + `rooms/` 同一范式，
 * `this.rooms` / `this._send()` 调用链完全不变）：
 *
 * | 文件 | 覆盖的消息 |
 * |---|---|
 * | `handlers/room`       | create_room · join_room · quick_match · cancel_match · leave · spectate · random_spectate · request_state · join_tournament_match |
 * | `handlers/game`       | move · resign · declare_nyugyoku · rematch · demo_move/undo/transfer/claim/reset/legal/enter |
 * | `handlers/social`     | rename · set_avatar · chat · report · record_search |
 * | `handlers/tournament` | create_tournament · join_tournament |
 * | `handlers/admin`      | admin_login |
 *
 * 本文件只保留：连接生命周期 / 限流 / 路由 switch / 发送辅助 / REST 数据出口。
 * **加消息**：在对应 handler 里加 `_hXxx`，再到 switch 挂一行即可；`tests/messages.test.js`
 * 仍从本文件的 switch 分支 反向核对契约表（`src/messages.js` 的 C2S），所以**别绕过 switch
 * 直连 handler**，否则那条双向一致性检查会失效。
 */
'use strict';

const auth = require('./auth');
const accounts = require('./accounts');
const log = require('./logger');
const messages = require('./messages');
const admin = require('./admin');
const ratings = require('./ratings');
const audit = require('./audit');
const privacy = require('./privacy');
const ratelimit = require('./ratelimit');
const { RoomManager } = require('./rooms');
const tournaments = require('./tournaments');
const { listPlayerRecords, getRecord, exportRecord, recentSummaries } = require('./records');
const { countRecords, listSummaries } = require('./storage');
const { listAnnouncements } = require('./announcements');
const handicap = require('./handicap'); // 手合割（駒落ち让子）表：`hello` 下发给前端渲染建房下拉

// §M2：消息处理器（mixin）——各模块导出 `_h*` 方法集合，装配见文件末尾
const roomHandlers = require('./protocol/handlers/room');
const gameHandlers = require('./protocol/handlers/game');
const socialHandlers = require('./protocol/handlers/social');
const tournamentHandlers = require('./protocol/handlers/tournament');
const adminHandlers = require('./protocol/handlers/admin');
const reports = require('./reports');

class Protocol {
  constructor({ onBroadcast }) {
    // clientId -> ws
    this.clients = new Map();
    // clientId -> { playerId, name, guestId }
    this.playerRegistry = new Map();
    // playerId -> Set<clientId>（同一身份可有多窗口连接，全部保留）
    this.playerToClients = new Map();
    // 连接自增序号：保证 clientId 全局唯一（P1-1 排障时定位到的碰撞 bug：
    // 同一身份的双连接在同一毫秒内握手时，纯时间戳后缀会生成**完全相同的
    // clientId**，后到的连接覆盖 `clients`/`playerRegistry` 里先到的注册 →
    // 先到的连接此后收不到任何回执（消息全部发到后者的 socket 上），表现为
    // "请求被静默丢弃"。e2e-test.js「同身份占用防护」段历史抖动即源于此。）
    this._connSeq = 0;

    this.rooms = new RoomManager((clientId, payload) => {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(payload)); } catch (_) {}
      }
    });
    // 供 rooms 层在匹配配对时取会话
    this.rooms.playerRegistry = (clientId) => {
      const info = this.playerRegistry.get(clientId);
      if (!info) return null;
      return { clientId, playerId: info.playerId, name: info.name };
    };
  }

  // ==================================================================
  // 连接管理
  // ==================================================================
  handleConnection(ws, guestId, meta = {}) {
    // guestId 可能是：游客 id（24 hex）或账号会话令牌（三段 . 分隔）
    // 会话令牌 → 解析为账号 id，使对局/评级/棋谱都绑定到账号
    let effectiveId = guestId;
    const accountId = accounts.verifyToken(guestId);
    if (accountId) effectiveId = accountId;
    // ⚠️ 安全（2026-10-02 审查 P0-1）：连接身份**必须凭据**，不能「报出 id 即本人」。
    // 与 HTTP 侧 `resolveOwner`（src/http/context.js）保持同一口径：
    //  - 账号会话：必须凭**令牌**；裸账号 id（24 hex，公开数据）不可信 → 丢弃，按新游客处理；
    //  - 已绑定持有证明（secret）的游客会话：必须出示**匹配的 key** → 否则按新游客处理。
    // 说明：未绑定 secret 的游客仍沿用「游客 id 即凭证」的既有设计（现状保留）。
    else if (guestId && /^[0-9a-f]{24}$/.test(guestId)) {
      const existing = auth.getSessionRaw(guestId);
      if (existing && existing.isAccount) {
        log.warn('auth', 'WS 拒绝以裸账号 id 建立身份，按新游客处理', { id: guestId });
        effectiveId = null;
      } else if (existing && existing.secret) {
        const vk = auth.verifyKey(guestId, meta && meta.key);
        if (!vk.ok) {
          log.warn('auth', 'WS 持有证明缺失或不匹配，按新游客处理', { id: guestId });
          effectiveId = null;
        }
      }
    }
    // 建立游客/账号会话（meta 含客户端 IP/UA，PLAN §K1/K2）
    // ⚠️ B1：账号身份（token）**不**绑定游客持有证明——账号的凭据是 token；
    //    仅游客会话消费 meta.key（首次连接即把 secret 绑定到会话，见 auth.identify）。
    const identifyMeta = accountId ? Object.assign({}, meta, { key: null }) : meta;
    const session = auth.identify(effectiveId, identifyMeta);
    // 封禁拦截（PLAN §K3）：封禁身份无法建立任何连接（自然无法对局/观战/聊天）
    if (session.banned) {
      const untilTxt = session.banned.until ? `，至 ${new Date(session.banned.until).toLocaleString('zh-CN')}` : '';
      const reason = session.banned.reason ? `：${session.banned.reason}` : '';
      try {
        ws.send(JSON.stringify({ type: 'error', data: { message: `此身份已被封禁${reason}${untilTxt}` } }));
        ws.close();
      } catch (_) {}
      return;
    }
    // 每日登录经验（PLAN §K7）：24h 内首次连接 +2（loginEvent 的同人同 IP 去重兼做「每日首次」判定）
    try {
      const loginEv = audit.loginEvent({ playerId: session.id, ip: meta.ip || null, ua: meta.ua || null, via: 'ws' });
      if (loginEv) ratings.addExp(session.id, 2, 'daily-login');
    } catch (_) {}
    const clientId = `${session.id}_${Date.now().toString(36)}${(++this._connSeq).toString(36)}`;
    this.clients.set(clientId, ws);
    this.playerRegistry.set(clientId, {
      playerId: session.id,
      name: session.name,
      guestId: session.id,
      ip: meta.ip || null, // 供 WS 侧按 IP 限流（PLAN §Q7，如 admin_login 防爆破）
      key: accountId ? null : (meta.key || null), // B1：本次连接携带的持有证明（账号身份为 null）
    });
    // 同一身份可多窗口并存（同浏览器多标签），全部登记，不互相顶替
    if (!this.playerToClients.has(session.id)) this.playerToClients.set(session.id, new Set());
    this.playerToClients.get(session.id).add(clientId);

    // 探测是否存在未结束对局（仅报告，不绑定——绑定由 request_state 完成，
    // 避免观战窗口同 guestId 连接时误绑玩家座位）
    const pending = this.rooms.findPendingGame(session.id);

    // 发送欢迎消息 + 初始状态
    ws.send(JSON.stringify({
      type: 'hello',
      data: {
        clientId,
        playerId: session.id,
        name: session.name,
        // 等级与等级特权（2026-09-20）：随 hello 下发，前端不必再单发一次请求。
        // `privileges` 由 `LEVEL_PRIVILEGES` 表推导（含 need/ok 两项），
        // 前端可以直接渲染"需要 Lv.5（你当前 Lv.2）"而不必抄门槛数值。
        level: ratings.levelOf(session.id),
        privileges: ratings.privilegesOf(session.id),
        // 头像（2026-09-20）：当前头像 + 可选白名单。白名单只维护在 `auth.AVATARS` 一处，
        // 前端直接拿它渲染选择器，不另抄一份表。
        // ⚠️ 2026-10-03 道具系统骨架 —— 可选集合改为「免费字形 ∪ 该账号已拥有的头像道具」
        // （`items.avatarOptionsFor`）：否则前端选择器根本列不出道具头像，用户无处可选。
        avatar: session.avatar || null,
        avatars: (() => {
          try { return require('./items').avatarOptionsFor(session.id); } catch (_) { return auth.AVATARS; }
        })(),
        // 举报类别（2026-09-20）：同样只在服务端维护一份，前端拿来直接渲染下拉
        reportCategories: reports.CATEGORIES,
        // 手合割（駒落ち让子）：服务端是唯一来源，前端建房下拉直接用它渲染
        handicaps: handicap.list().map((d) => ({ id: d.id, label: d.label, hint: d.hint })),
        reconnect: pending ? { ok: true, ...pending } : null,
        stats: this._stats(), // 统一统计出口（§T1）：在线人数按「唯一身份数」计
      },
    }));

    // ⚠️ 2026-10-02 审查 P3：包一层 try/catch——_route 之外的代码（限流 / registry / _error）若抛错
    // 会逃逸到 ws 的 emit，成为未处理异常（虽有进程级兜底，但该连接后续消息会被跳过）。
    ws.on('message', (raw) => {
      try { this._onMessage(clientId, raw); } catch (err) { log.error('protocol', '消息处理异常', { err, clientId }); }
    });
    ws.on('close', () => this._onClose(clientId));
    ws.on('error', () => this._onClose(clientId));

    this._broadcastStats();
  }

  _onClose(clientId) {
    const info = this.playerRegistry.get(clientId);
    if (info) {
      const set = this.playerToClients.get(info.guestId);
      if (set) {
        set.delete(clientId);
        if (set.size === 0) this.playerToClients.delete(info.guestId);
      }
    }
    this.clients.delete(clientId);
    this.playerRegistry.delete(clientId);
    // 通知 rooms 层该客户端断开（对局中则开始 60 秒重连期）
    this.rooms._unbindClient(clientId);
    this._broadcastStats();
  }

  _onMessage(clientId, raw) {
    // 连接级消息速率限制（PLAN §Q7）：正常对局远低于阈值，只拦「脚本刷消息」。
    // 超限时静默丢弃 + 节流提示（提示本身也限流，否则错误响应会形成新的洪泛）。
    const rl = ratelimit.wsMsg.hit(clientId);
    if (!rl.allowed) {
      if (ratelimit.wsNotice.hit(clientId).allowed) {
        this._error(clientId, '消息过于频繁，已限流');
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return this._error(clientId, '消息格式错误');
    }
    const info = this.playerRegistry.get(clientId);
    if (!info) return;
    // ⚠️ 必须带上 `key`（B1 持有证明）：`player.key` 是 rename/set_avatar 的鉴权输入。
    // 此前只拷了 playerId/name，WS 路径上 key 恒为 undefined → 绑定了 secret 的游客
    // 一改名就报「身份校验失败」。registry 在握手时已存好 key，这里原样传下去。
    const player = { clientId, playerId: info.playerId, name: info.name, key: info.key };
    this._route(clientId, player, msg);
  }

  // ==================================================================
  // 路由
  // ==================================================================
  _route(clientId, player, msg) {
    // §P5：进业务分支前先过消息契约校验——缺必填参数 / 未知类型当场回**明确错误**，
    // 而不是让 undefined 流进 rooms 层、最后被报成一句模糊的"走子失败"。
    // 契约表（src/messages.js）与下方 switch 分支的一致性由 tests/messages.test.js 锁定。
    const type = msg && msg.type;
    const checked = messages.validate(type, msg && msg.data);
    if (!checked.ok) return this._error(clientId, checked.error);
    try {
      this._routeInner(clientId, player, msg);
    } catch (err) {
      log.error('protocol', `处理 ${type} 出错`, { err, clientId });
      this._error(clientId, '服务器内部错误');
    }
  }

  /**
   * 路由分发：**一行一分支**，实体逻辑在 `src/protocol/handlers/*`（§M2）。
   *
   * ⚠️ switch 必须覆盖 `src/messages.js` 契约表里的**全部** C2S 类型：
   * `tests/messages.test.js` 从本函数的 switch 分支 反查，双向核对，防"请求落到 default"。
   */
  _routeInner(clientId, player, msg) {
    const { type, data } = msg;
    switch (type) {
      case 'create_room': return this._hCreateRoom(clientId, player, data);
      case 'join_room': return this._hJoinRoom(clientId, player, data);
      case 'quick_match': return this._hQuickMatch(clientId, player);
      case 'cancel_match': return this._hCancelMatch(clientId);
      case 'move': return this._hMove(clientId, player, data);
      case 'resign': return this._hResign(clientId);
      // 入玉宣言（PLAN §P1 R-d）：玩家申请，服务端按 AJSA 规则权威判定
      case 'declare_nyugyoku': return this._hDeclareNyugyoku(clientId);
      case 'rematch': return this._hRematch(clientId);
      case 'spectate': return this._hSpectate(clientId, player, data);
      case 'random_spectate': return this._hRandomSpectate(clientId, player);
      case 'leave': return this._hLeave(clientId);
      case 'rename': return this._hRename(clientId, player, data);
      case 'report': return this._hReport(clientId, player, data);
      case 'set_avatar': return this._hSetAvatar(clientId, player, data);
      case 'request_state': return this._hRequestState(clientId, player, data);
      case 'chat': return this._hChat(clientId, player, data);
      case 'admin_login': return this._hAdminLogin(clientId, player, data);
      case 'create_tournament': return this._hCreateTournament(clientId, player, data);
      case 'join_tournament': return this._hJoinTournament(clientId, player, data);
      case 'join_tournament_match': return this._hJoinTournamentMatch(clientId, player, data);
      // 感想战演示行棋（PLAN §G）：move / undo / transfer / claim / reset 共用一条
      case 'demo_move':
      case 'demo_undo':
      case 'demo_transfer':
      case 'demo_claim':
      case 'demo_reset': return this._hDemoAction(clientId, type, data);
      // 感想战历史手合法走法按需下发（任意历史手行棋，PLAN §H）
      case 'demo_legal': return this._hDemoLegal(clientId, data);
      // 进入感想战页：下发该客户端视角的完整载荷（demo_init）
      case 'demo_enter': return this._hDemoEnter(clientId, data);
      // 棋谱检索（PLAN §Q7）：身份只认握手 identify() 的结果（见 handlers/social.js）
      case 'record_search': return this._hRecordSearch(clientId, player, data);
      default:
        this._error(clientId, `未知消息类型: ${type}`);
    }
  }

  // ==================================================================
  // REST 辅助（供 server.js 调用）
  // ==================================================================
  lobbyData() {
    // 非管理员公开出口：统一过隐私白名单（PLAN §M3/§K——结构性保证，不靠人肉记忆）
    return privacy.stripPrivate({
      // 在线人数一律走统一统计出口（§T1），口径见 `_stats()` 注释
      stats: this._stats(),
      games: this.rooms.activeGames(),
      announcements: listAnnouncements(),
      leaderboard: ratings.leaderboard(null, 10),
    });
  }

  homeData() {
    const lb = ratings.leaderboard(null, 10);
    return privacy.stripPrivate({
      stats: this._stats(), // 统一统计出口（§T1）
      games: this.rooms.activeGames(),
      announcements: listAnnouncements(),
      leaderboard: lb,
      // 首页改版新增：平台数据条 + 最新对局战报（games 字段保留兼容旧入口）
      recordsTotal: countRecords(),
      recentBattles: recentSummaries(5),
    });
  }

  /**
   * 全量棋谱（管理后台「全部棋谱」数据源）。
   *
   * ⚠️ PLAN §Q7：此出口**仅限管理员**。此前支持按任意 playerId 查询，
   * 而游客 id 在大厅列表 / 观战页 / 悬停卡里都是公开的 →
   * 任何人拿到他人的 id 就能枚举其全部棋谱。
   * 普通用户的检索已迁到 WS `record_search`（身份由连接握手时绑定并强制过滤），
   * 因此这里**不再提供非管理员分支**。
   * @param {string|null} adminToken 管理员 token
   * @returns {{records:Array, isAdmin:true}|null} 非管理员返回 null
   */
  historyData(adminToken) {
    if (!admin.verify(adminToken)) return null;
    // 含公共 kif-import 库与所有用户对局。
    // PLAN §Q7-2：列表只需摘要 —— 旧实现 listRecords(1000) 会解析 1000 份整谱，阻塞主线程。
    return { records: listSummaries({ limit: 1000 }), isAdmin: true };
  }

  /**
   * 管理员：全部用户数据（评级 + 会话）。
   * 普通用户无权访问。
   */
  adminUsersData(adminToken) {
    if (!admin.verify(adminToken)) return null;
    return { users: ratings.allUsers() };
  }

  /**
   * 踢出某身份的全部在线连接（封禁生效用，PLAN §K3）。
   * @returns {number} 踢掉的连接数
   */
  kickPlayer(playerId, message = '你的账号已被管理员强制下线') {
    const set = this.playerToClients.get(playerId);
    if (!set) return 0;
    let n = 0;
    for (const clientId of [...set]) {
      this._send(clientId, { type: 'error', data: { message } });
      const ws = this.clients.get(clientId);
      if (ws) {
        try { ws.close(); n += 1; } catch (_) {}
      }
    }
    return n;
  }

  /**
   * 管理员：查看指定用户数据。
   * 追加手机号（私密字段仅管理员可见，PLAN §F）与账号注册时间。
   * §K：追加网络信息（net）、封禁状态、管理员备注、最近登录事件——均仅此管理员出口返回。
   */
  adminUserData(userId, adminToken) {
    if (!admin.verify(adminToken)) return null;
    if (!userId) return null;
    const prof = ratings.profile(userId);
    const records = listPlayerRecords(userId, 200);
    const session = auth.load(userId) || { name: userId };
    const own = accounts.getOwnProfile(userId);
    return {
      profile: prof,
      records,
      name: session.name,
      phone: own ? own.profile.phone : '',
      style: own ? own.profile.style : null,
      accountCreatedAt: own ? own.createdAt : null,
      isAccount: !!own,
      net: session.net || null,
      banned: session.banned || null,
      title: session.title || '',
      events: audit.loginHistory(userId, 50),
    };
  }

  /**
   * 玩家信息卡（公开，悬停小窗数据源，PLAN §F3）。
   * 绝不返回手机号。
   */
  playerCardData(playerId) {
    if (!playerId || !/^[0-9a-f]{24}$/.test(String(playerId))) return null;
    const session = auth.load(playerId);
    const card = accounts.getPublicCard(playerId);
    if (!session && !card) return null; // 未知玩家
    const prof = ratings.profile(playerId);
    const recent = listPlayerRecords(playerId, 10).map((r) => {
      if (!r.playerIds || r.result === '-') return 'draw';
      const mine = r.playerIds.b === playerId ? 'b' : 'w';
      return r.result === mine ? 'win' : 'loss';
    });
    return privacy.stripPrivate({
      id: playerId,
      name: session ? session.name : (card ? card.username : playerId),
      title: (session && session.title) || null,   // 用户称号（管理员编辑，PLAN §K7 追加）
      isAccount: !!card,
      rating: prof.rating,
      level: prof.level,                     // 等级系统（PLAN §K7）
      games: prof.games,
      wins: prof.wins,
      losses: prof.losses,
      winRate: prof.winRate,
      style: card ? card.style : null,       // 游客无棋风
      createdAt: card ? card.createdAt : null,
      recent,
    });
  }

  exportData(recordId, fmt) {
    const rec = getRecord(recordId);
    if (!rec) return null;
    return { text: exportRecord(rec, fmt === 'csa' ? 'csa' : 'kif'), fmt: fmt === 'csa' ? 'csa' : 'kif' };
  }

  tournamentsData() {
    return { tournaments: tournaments.listTournaments() };
  }

  profileData(playerId) {
    const prof = ratings.profile(playerId);
    const records = require('./records').listPlayerRecords(playerId, 20);
    const session = auth.load(playerId) || { name: '无名棋士' };
    // 赛事荣誉（个人页"赛事荣誉栏"）：赛事结果本身就是公开信息，不涉及隐私，
    // 所以放在同一出口一起下发（stripPrivate 的键名黑名单与它无交集）。
    const honors = tournaments.honorsOf(playerId);
    // 被查看者的头像（2026-09-20 补）：个人页身份卡上那个大头像必须画**这个人**的。
    // 原先不下发 → 前端只好画自己的/占位字形，看别人的资料页时就成了"我把他头像改了"
    // （用户报的 bug）。头像本就是公开信息（对局 state、聊天、观众列表都在发）。
    // 非管理员出口：过隐私白名单（PLAN §K2）
    return privacy.stripPrivate({
      profile: prof, records, name: session.name, avatar: session.avatar || null, honors,
    });
  }

  /**
   * 公开推送入口：给某身份的**全部活跃连接**推一条消息（REST 侧要用时走这里）。
   *
   * ⚠️ 2026-10-04 新增（修一个小洞）：此前只有 WS handler 内部能推（`this._send`），
   * 于是 REST 改了会显示在线界面的东西（典型：道具系统里装备头像）只能
   * "数据改了、界面不动，得刷新才看到"。这里把 `_sendToPlayer` 包成公开方法，
   * **REST 与 WS 走同一条推送路径**，不要各写一套。
   *
   * @param {string} playerId
   * @param {object} payload
   * @returns {number|undefined} 实际发出的连接数（由 `_sendToPlayer` 决定）
   */
  notifyPlayer(playerId, payload) {
    return this._sendToPlayer(playerId, payload);
  }

  // ==================================================================
  // 发送辅助
  // ==================================================================
  _send(clientId, payload) {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(payload)); } catch (_) {}
    }
  }

  /**
   * ⚠️ 2026-10-02 体验修复（问题 3/6）：允许带上**结构化字段**。
   *
   * rooms 层的失败回执里不只有 `error` 文案，还有 `backRoomId`（"回你自己的对局"）、
   * `code`（机器可读原因）、`needPassword`（补密码）等标志。旧实现只透传 `message`，
   * 于是前端（`public/js/lobby.js` 明确在读 `data.backRoomId`）**永远收不到**这些字段，
   * UI 复位不了、也不知道该把用户送回哪——这是典型的"服务端报了错、前端却什么都做不了"。
   *
   * 只放行**白名单**字段：避免调用方顺手把内部对象塞进错误回执漏给客户端。
   *
   * @param {string} clientId
   * @param {string} message
   * @param {{backRoomId?:string, code?:string, needPassword?:boolean}} [extra]
   */
  _error(clientId, message, extra) {
    const data = { message };
    if (extra && typeof extra === 'object') {
      if (extra.backRoomId) data.backRoomId = String(extra.backRoomId);
      if (extra.code) data.code = String(extra.code);
      if (extra.needPassword) data.needPassword = true;
    }
    this._send(clientId, { type: 'error', data });
  }

  _sendToPlayer(playerId, payload) {
    // 发给该身份的所有活跃连接（同浏览器多窗口都能收到）
    const set = this.playerToClients.get(playerId);
    if (set) {
      for (const clientId of set) this._send(clientId, payload);
    }
  }

  _broadcastToRoomState(roomId) {
    // 保留为空方法（避免误调崩溃）；create_room 流程已不再调用它
  }

  _broadcastStats() {
    // 简易广播统计（对战页用 REST 轮询，这里可留空或推送给大厅）
  }

  /**
   * 统一的统计出口（PLAN §T1）。
   *
   * 在线人数**只有一种口径**：`playerToClients.size`（唯一身份数）。
   * `rooms.stats()` 不再返回 `online`——它那层的公式曾算错（恒等于 clientToRoom.size，
   * 只统计已绑定房间的连接，漏掉大厅/观战/未进房的连接），留着只会让下一个人再算错一遍。
   * 所有对外出口（hello / lobbyData / homeData）都必须走这里。
   */
  _stats() {
    return { ...this.rooms.stats(), online: this.playerToClients.size };
  }

  getOnlineCount() {
    return this.playerToClients.size;
  }
}

// §M2（2026-09-28）：消息处理器以 mixin 注入，与 `rooms.js` 的装配方式一致——
// `this.*` 调用链完全不变，对 `server.js` / 测试完全透明。
Object.assign(Protocol.prototype,
  roomHandlers, gameHandlers, socialHandlers, tournamentHandlers, adminHandlers);

module.exports = { Protocol };
