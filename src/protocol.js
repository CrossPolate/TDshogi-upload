/**
 * protocol.js — WebSocket 消息路由
 *
 * 负责：
 *  - 连接管理（建立/关闭/断线重连）
 *  - 游客鉴权（根据客户端 guestId 建立会话）
 *  - 客户端 → 服务端消息分发（调用 rooms 层）
 *  - 服务端 → 客户端消息回发（广播）
 *
 * 客户端消息（type 字段）：
 *   create_room / join_room / quick_match / cancel_match /
 *   move / resign / rematch / spectate / random_spectate /
 *   leave / rename / request_state / create_tournament / join_tournament
 *
 * 服务端消息（type 字段）：
 *   hello / matched / game_start / state / clock / move_invalid /
 *   game_over / elo_updated / spectator_update / tournament_update / error
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
const { listPlayerRecords, getRecord, exportRecord, recentSummaries, searchRecords } = require('./records');
const { countRecords, listSummaries } = require('./storage');
const { listAnnouncements } = require('./announcements');
const handicap = require('./handicap'); // 手合割（駒落ち让子）表：`hello` 下发给前端渲染建房下拉
const reports = require('./reports');

class Protocol {
  constructor({ onBroadcast }) {
    // clientId -> ws
    this.clients = new Map();
    // clientId -> { playerId, name, guestId }
    this.playerRegistry = new Map();
    // playerId -> Set<clientId>（同一身份可有多窗口连接，全部保留）
    this.playerToClients = new Map();

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
    // 建立游客/账号会话（meta 含客户端 IP/UA，PLAN §K1/K2）
    const session = auth.identify(effectiveId, meta);
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
    const clientId = `${session.id}_${Date.now().toString(36)}`;
    this.clients.set(clientId, ws);
    this.playerRegistry.set(clientId, {
      playerId: session.id,
      name: session.name,
      guestId: session.id,
      ip: meta.ip || null, // 供 WS 侧按 IP 限流（PLAN §Q7，如 admin_login 防爆破）
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
        avatar: session.avatar || null,
        avatars: auth.AVATARS,
        // 举报类别（2026-09-20）：同样只在服务端维护一份，前端拿来直接渲染下拉
        reportCategories: reports.CATEGORIES,
        // 手合割（駒落ち让子）：服务端是唯一来源，前端建房下拉直接用它渲染
        handicaps: handicap.list().map((d) => ({ id: d.id, label: d.label, hint: d.hint })),
        reconnect: pending ? { ok: true, ...pending } : null,
        stats: this._stats(), // 统一统计出口（§T1）：在线人数按「唯一身份数」计
      },
    }));

    ws.on('message', (raw) => this._onMessage(clientId, raw));
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
    const player = { clientId, playerId: info.playerId, name: info.name };
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

  _routeInner(clientId, player, msg) {
    const { type, data } = msg;
    const r = this.rooms;
    switch (type) {
      case 'create_room': {
        const tc = data && data.timeControl;
        // 私人房间（PLAN §T2）：isPrivate 决定 rated=false（不计 ELO，经验照常加）
        const res = r.createRoom(player, tc, {
          isPrivate: !!(data && data.isPrivate),
          password: (data && data.password) || '',
          // 駒落ち（让子）手合割 id；空 = 平手。未知 id 由 createRoom 拒绝
          handicap: data && data.handicap,
        });
        if (!res.ok) { this._error(clientId, res.error); break; }
        this._send(clientId, { type: 'room_created', data: res });
        break;
      }
      case 'join_room': {
        const res = r.joinRoom(player, data && data.code, (data && data.password) || '');
        if (res.ok) {
          this._send(clientId, { type: 'room_joined', data: res });
        } else if (res.needPassword) {
          // 私人房间（§T2）：把「需要密码」作为**结构化标志**回传，
          // 前端据此显示密码输入框再重试——而不是让用户从一句文案里猜该做什么
          this._send(clientId, { type: 'error', data: { message: res.error, needPassword: true } });
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'quick_match': {
        const res = r.quickMatch(player);
        if (!res.ok) this._error(clientId, res.error);
        else this._send(clientId, { type: 'matching', data: { ok: true } });
        break;
      }
      case 'cancel_match': {
        r.cancelMatch(clientId);
        this._send(clientId, { type: 'matching', data: { ok: false } });
        break;
      }
      case 'move': {
        const res = r.makeMove(clientId, data && data.usi);
        if (!res.ok) this._error(clientId, res.error || '走子失败');
        break;
      }
      case 'resign': {
        const res = r.resign(clientId);
        if (!res.ok) this._error(clientId, res.error);
        break;
      }
      // 入玉宣言（PLAN §P1 R-d）：玩家申请，服务端按 AJSA 规则权威判定
      case 'declare_nyugyoku': {
        const res = r.declareNyugyoku(clientId);
        if (!res.ok) this._error(clientId, res.error);
        break;
      }
      case 'rematch': {
        r.rematch(clientId);
        break;
      }
      case 'spectate': {
        // roomId 也可传 6 位房间码；password 用于私人房间观战（PLAN §T2）
        const res = r.spectate(clientId, data && (data.roomId || data.code), player.playerId, data && data.password);
        if (res.ok) {
          this._send(clientId, { type: 'spectating', data: { roomId: res.roomId, seat: res.seat || null, rebind: !!res.rebind } });
          const state = r.getRoomStateForClient(clientId);
          this._send(clientId, { type: 'state', data: state });
        } else if (res.needPassword) {
          this._send(clientId, { type: 'error', data: { message: res.error, needPassword: true } });
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'random_spectate': {
        const res = r.randomSpectate(clientId, player.playerId);
        if (res.ok) {
          this._send(clientId, { type: 'spectating', data: { roomId: res.roomId, seat: res.seat || null, rebind: !!res.rebind } });
          const state = r.getRoomStateForClient(clientId);
          this._send(clientId, { type: 'state', data: state });
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'leave': {
        r.leave(clientId);
        this._send(clientId, { type: 'left' });
        break;
      }
      case 'rename': {
        const res = auth.rename(player.playerId, data && data.name);
        if (res.ok) {
          player.name = res.name;
          const info = this.playerRegistry.get(clientId);
          if (info) info.name = res.name;
          this._send(clientId, { type: 'renamed', data: { name: res.name } });
          // 同步进行中对局里该玩家的名字（对手即时看到新名）
          this.rooms.updatePlayerName(player.playerId, res.name);
          this._broadcastStats();
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'report': {
        // 举报（2026-09-20）：`targetId` 由客户端给（对局页就是对面座位），
        // 但**被举报人的显示名由服务端查会话**——不信客户端传的名字，
        // 否则举报记录里的"被举报人"可以被伪造成任意人。
        const rp = reports.submit({
          byId: player.playerId,
          byName: player.name,
          targetId: data && data.targetId,
          targetName: data && data.targetName,
          category: data && data.category,
          detail: data && data.detail,
          context: data && data.context,
        });
        if (rp.ok) this._send(clientId, { type: 'reported', data: { id: rp.report.id } });
        else this._error(clientId, rp.error);
        break;
      }
      case 'set_avatar': {
        // 头像（2026-09-20）：与改名同款，走**会话文件**——游客也能换头像，
        // 不必为了换个头像去注册账号。白名单校验在 `auth.setAvatar` 里。
        const res = auth.setAvatar(player.playerId, data && data.avatar);
        if (res.ok) {
          player.avatar = res.avatar;
          this._send(clientId, { type: 'avatar_updated', data: { avatar: res.avatar } });
          // 进行中的对局要**立刻**生效：清掉房间侧的头像缓存并重推 state
          this.rooms.refreshAvatar(player.playerId);
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'request_state': {
        let state = r.getRoomStateForClient(clientId);
        if (!state) {
          // 断线重连：玩家明确请求状态（request_state）时才尝试恢复对局，
          // 避免观战窗口（同 guestId）误绑玩家座位。
          // data.roomId = 页面 URL 指向的房间：回位优先绑定它（重新匹配后
          // 不被旧对局复盘中房间的断线座位按插入顺序劫持——幽灵房修复）
          const wantRoom = data && data.roomId;
          const rec = r.reconnect(clientId, player.playerId, wantRoom);
          if (rec.ok) {
            state = r.getRoomStateForClient(clientId);
          } else {
            // 页面跳转竞态兜底：新连接先于旧连接 close 到达时无绑定
            const bound = r.bindToActiveGame(clientId, player.playerId, wantRoom);
            if (bound && bound.ok) state = r.getRoomStateForClient(clientId);
          }
        }
        if (state) {
          this._send(clientId, { type: 'state', data: state });
        } else {
          // ⚠️ **必须明确回执**：静默不响应会让前端停在空白页干等（用户只能看到一片白）。
          // 触发场景（2026-09-13 定位）：从大厅点一张"自己是选手"的对局卡片 →
          // 前台不带 spectate → 走 request_state → 但该局已结束/房间已销毁 →
          // reconnect / bindToActiveGame 全失败 → 原先这里什么都不发 → 页面全白。
          // 这条历史 bug 拖了很久，就是因为它是**静默**失败：日志里连个错都没有。
          this._send(clientId, { type: 'no_room', data: { roomId: (data && data.roomId) || null } });
        }
        break;
      }
      case 'chat': {
        // 房间聊天（玩家/观战者）
        const res = r.chat(clientId, data && data.text);
        if (!res.ok) this._error(clientId, res.error);
        break;
      }
      case 'admin_login': {
        // 防爆破（PLAN §Q7）：按 **IP** 计（同一 IP 的多个连接共享额度，比按连接更有效）；
        // 登录成功即清零，不影响管理员正常进出。
        const info = this.playerRegistry.get(clientId);
        const key = (info && info.ip) || clientId;
        const rlA = ratelimit.adminLogin.hit(key);
        if (!rlA.allowed) {
          this._error(clientId, `尝试过于频繁，请 ${Math.ceil(rlA.retryAfterMs / 1000)} 秒后再试`);
          break;
        }
        const res = admin.login(data && data.password);
        if (res.ok) {
          ratelimit.adminLogin.reset(key);
          // 记录该连接的管理员 token（存客户端）
          this._send(clientId, { type: 'admin_logged_in', data: { token: res.token } });
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'create_tournament': {
        // B2：创建赛事需要登录正式账号（guestId 为会话令牌且能解析到账号）。
        // 游客 id 是 24 hex，账号 id 在 accounts 表中存在——以此区分。
        if (!accounts.getAccount(player.playerId)) {
          this._error(clientId, '创建赛事需要登录正式账号，请在个人页注册/登录');
          break;
        }
        // T1/T2：透传建赛申请表字段。**服务端会再校验一遍**（时间自洽性、赛制、人数档位），
        // 前端校验只防手滑，防不了直接构造 WS 消息的人。
        const res = tournaments.createTournament(data && data.name, data && data.size,
          { id: player.playerId, name: player.name }, {
            reason: data && data.reason,
            registerStart: data && data.registerStart,
            registerEnd: data && data.registerEnd,
            matchStart: data && data.matchStart,
            matchEnd: data && data.matchEnd,
            format: data && data.format,
            // T8：瑞士制总轮数（不填则服务端按人数给建议值）
            totalRounds: data && data.totalRounds,
            requireApproval: data && data.requireApproval,
          });
        if (res.ok) {
          this._send(clientId, { type: 'tournament_created', data: res.tournament });
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'join_tournament': {
        const res = tournaments.joinTournament(data && data.id, { id: player.playerId, name: player.name });
        if (res.ok) {
          // T3：两段式报名——`pending` 表示"只是提交了申请，还没被批准"，
          // 前端据此给不同提示（否则会给用户"已经参赛了"的错觉）。
          this._send(clientId, {
            type: 'tournament_joined',
            data: Object.assign({}, res.tournament, { pending: !!res.pending, started: !!res.started }),
          });
        } else {
          this._error(clientId, res.error);
        }
        break;
      }
      case 'join_tournament_match': {
        // 玩家主动进入自己的赛事对局（建局时可能不在线）
        const res = r.joinTournamentMatch(clientId, data && data.roomId, player.playerId);
        if (!res.ok) this._error(clientId, res.error);
        break;
      }
      // 感想战演示行棋（PLAN §G）：move/undo/transfer/claim/reset
      case 'demo_move':
      case 'demo_undo':
      case 'demo_transfer':
      case 'demo_claim':
      case 'demo_reset': {
        const res = r.demoAction(clientId, type.replace('demo_', ''), data || {});
        if (!res.ok) this._error(clientId, res.error);
        break;
      }
      // 感想战历史手合法走法按需下发（任意历史手行棋，PLAN §H）
      case 'demo_legal': {
        const res = r.demoLegal(clientId, data || {});
        if (res.ok) this._send(clientId, { type: 'demo_legal', data: res.data });
        break;
      }
      // 进入感想战页：下发该客户端视角的完整载荷（demo_init）
      case 'demo_enter': {
        const res = r.demoEnter(clientId, data && data.roomId);
        if (!res.ok) this._error(clientId, res.error);
        else this._send(clientId, { type: 'demo_init', data: res.demo });
        break;
      }
      // 棋谱检索（PLAN §Q7）：**身份只认握手时 identify() 的结果**，客户端传的 playerId 一律忽略。
      // 原因：游客 id 在大厅/观战页是公开的，若按客户端传值查即可枚举他人棋谱（旧 REST 接口的越权点）。
      case 'record_search': {
        const d = data || {};
        const asInt = (v) => {
          const n = parseInt(v, 10);
          return Number.isFinite(n) ? n : undefined;
        };
        const q = {
          playerId: player.playerId,
          query: typeof d.query === 'string' && d.query.trim() ? d.query.trim() : undefined,
          opening: typeof d.opening === 'string' && d.opening.trim() ? d.opening.trim() : undefined,
          result: (d.result === 'b' || d.result === 'w' || d.result === '-') ? d.result : undefined,
          movesMin: asInt(d.movesMin),
          movesMax: asInt(d.movesMax),
          limit: Math.min(Math.max(asInt(d.limit) || 100, 1), 200),
        };
        this._send(clientId, { type: 'record_search_result', data: { records: searchRecords(q) } });
        break;
      }
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

  // ==================================================================
  // 发送辅助
  // ==================================================================
  _send(clientId, payload) {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(payload)); } catch (_) {}
    }
  }

  _error(clientId, message) {
    this._send(clientId, { type: 'error', data: { message } });
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

module.exports = { Protocol };
