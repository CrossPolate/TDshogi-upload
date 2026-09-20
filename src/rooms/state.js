/**
 * rooms/state.js — 对局状态快照、推送与观战名单（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 这一块决定**「客户端看到什么」**：`_gameState()` 把 房间 + 棋局 + 玩家档案（等级/ELO/称号）
 * + 棋钟 + 感想战状态 + 合法走法 揉成一份前端可直接渲染的快照，`_pushState()` 再按连接逐个推送
 * （同一房间的玩家与观战者拿到的快照不同：只有玩家带合法走法）。
 *
 * 拆出来的理由：它基本是**纯读路径**（除了推送本身不改任何状态），却夹在两千行的写路径里；
 * 改「推送字段」是最常见的需求，单独成文件后不必在状态机里翻找。观战名单与系统播报同理。
 *
 * 注入方式：`applyState(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 *
 * 依赖：`ratings`（等级/ELO 档案）、`rooms/config`（默认时制 / 打子符号表）、
 *       `records.movesToKif`（日式记谱，按需 require）、`game.state()`（局面快照）。
 */
'use strict';

const ratings = require('../ratings');
const { STARTING_SFEN } = require('../game');
const { DEFAULT_TIME_CONTROL, DROP_SYMBOL_BY_NAME } = require('./config');

module.exports = function applyState(X) {
  Object.assign(X.prototype, {
    /**
     * 组装某房间的状态快照（`includeLegal=false` 时不带合法走法——观战者不需要）。
     *
     * ⚠️ 这里的字段是**前端渲染契约**：新增/改名要同步检查 `play.js` 的 `render()`。
     * 特别是 `players.*.title`——称号**不在** `ratings.profile()` 里（那里只有 rating/exp/战绩），
     * 必须单独取，否则玩家栏的称号永远是空的。
     */
    _gameState(room, includeLegal = true) {
      const st = room.game.state();
      st.roomId = room.id;
      st.code = room.code;
      st.status = room.status;
      // 日式记谱（如「７六歩(77)」「同　銀(33)」），前端走子列表直接可读
      try {
        const { movesToKif } = require('../records');
        st.movesKif = movesToKif(room.game.startSfen || STARTING_SFEN, room.game.moves || []);
      } catch (_) {
        st.movesKif = [];
      }
      const profB = room.players.b ? ratings.profile(room.players.b.playerId) : null;
      const profW = room.players.w ? ratings.profile(room.players.w.playerId) : null;
      st.players = {
        // connected：该座位当前是否在线（前端据此显示「对手断线，等待重连」）
        // level：等级系统（PLAN §K7），供对局页玩家栏展示
        // title：称号（PLAN §R5）——注意 `ratings.profile()` **不含** title，它只存在于会话中
        b: room.players.b ? { id: room.players.b.playerId, name: room.players.b.name, rating: profB.rating, level: profB.level, title: this._playerTitle(room.players.b.playerId), avatar: this._playerAvatar(room.players.b.playerId), connected: room.players.b.connected !== false } : null,
        w: room.players.w ? { id: room.players.w.playerId, name: room.players.w.name, rating: profW.rating, level: profW.level, title: this._playerTitle(room.players.w.playerId), avatar: this._playerAvatar(room.players.w.playerId), connected: room.players.w.connected !== false } : null,
      };
      // §P1 R-d：当前手番方能否入玉宣言——前端据此决定是否亮出「入玉宣言」按钮。
      // 规则只在 `game.canDeclareNyugyoku()` 实现一处，前端不自己算点数；条件不满足时
      // 按钮根本不出现，因此不存在「误点 → 反则负」的问题（服务端仍保留权威判定，防伪造消息）。
      if (room.status === 'PLAYING' && !room.game.isGameOver()) {
        const seat = room.game.turn;
        const d = room.game.canDeclareNyugyoku(seat);
        st.canDeclare = {
          seat,
          ok: !!d.ok,
          reason: d.reason || null,
          points: d.points == null ? null : d.points,
          count: d.count == null ? null : d.count,
        };
      } else {
        st.canDeclare = { seat: null, ok: false, reason: null, points: null, count: null };
      }
      st.clock = { b: room.clock.b, w: room.clock.w };
      st.timeControl = room.timeControl || DEFAULT_TIME_CONTROL;
      st.byoyomi = room.byoyomi || 0;
      st.curByoyomi = room.curByoyomi ? { ...room.curByoyomi } : null;
      st.inByoyomi = room.inByoyomi ? { ...room.inByoyomi } : null;
      st.roomType = room.type;
      // 駒落ち（让子）：平手为 null。前端据此显示「香落ち（上手先手）」这类提示——
      // 让子局里"谁先手"与平手相反（上手先走），不提示的话玩家会以为是程序出错。
      st.handicap = room.handicap || null;
      st.handicapLabel = room.handicapLabel || null;
      st.rated = room.rated !== false;
      st.seat = null;
      // 观战者名单（对局页右列观众列表，PLAN §G v7）
      st.spectators = this._spectatorList(room);   // §R：带 id/等级的对象数组（按人去重）
      st.moveTimes = room.moveTimes || [];  // 每手耗时（秒）——棋谱列表与 KIF 时间
      // 感想战演示状态（仅终局后携带，重连/观战初载即可拿到推演谱与合法走法，PLAN §G）
      if (room.status === 'FINISHED' && room.demo) {
        const dSeat = room.demo.demonstratorSeat;
        const g = this._demoGame(room);
        // §J4：权威局面（推演终局）。**三处出口**（本处 / `_broadcastDemo` / `demoEnter`）
        // 口径必须一致——都取同一份 `game.state()`，否则前端覆盖逻辑会时灵时不灵。
        const dSnap = g.state();
        st.demo = {
          moves: room.demo.moves,
          kif: room.demo.kif,
          baseIndex: room.demo.baseIndex,
          baseCount: room.demo.baseCount,
          legalMoves: g.legalMovesUsi(),
          legalTargetsBySq: this._legalTargetsMap(g),
          turn: g.turn,
          board: dSnap.board,
          hands: dSnap.hands,
          demonstratorSeat: dSeat || null,
          demonstratorName: dSeat && room.players[dSeat] ? room.players[dSeat].name : null,
        };
      }
      if (!includeLegal || room.status !== 'PLAYING') {
        st.legalMoves = [];
        st.legalTargetsBySq = {};
      } else {
        st.legalMoves = room.game.legalMovesUsi();
        // 当前走子方各起点的合法目标（含打子符号）
        st.legalTargetsBySq = this._legalTargetsMap(room.game);
      }
      return st;
    },

    /** 当前手番方「起点 → 合法目标」映射（含打子符号），供前端点击高亮 */
    _legalTargetsMap(game) {
      const map = {};
      const color = game.turn;
      // 盘上起点
      const board = game.state().board;
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const cell = board[r][c];
          if (cell && cell.piece && cell.color === color) {
            map[cell.sq] = game.legalTargets(cell.sq);
          }
        }
      }
      // 打子符号（有持驹时）
      const hands = game.hands();
      (hands[color] || []).forEach((h) => {
        const sym = DROP_SYMBOL_BY_NAME[h.piece];
        if (sym) map[sym] = game.legalTargets(sym);
      });
      return map;
    },

    /** 向单个连接发消息（`broadcaster` 由构造注入） */
    _send(clientId, payload) {
      this.broadcaster(clientId, payload);
    },

    /**
     * 向房间内所有连接推送各自视角的 state。
     * 玩家与观战者拿到的快照不同（观战者 `includeLegal=false`），所以必须**逐个组装**。
     */
    _pushState(room) {
      // 对每个客户端单独推送（带各自 seat，观战者不带合法走法信息）
      const clientIds = new Set();
      for (const seat of ['b', 'w']) {
        const p = room.players[seat];
        if (p) clientIds.add(p.clientId);
      }
      const specs = this.spectatorsByRoom.get(room.id) || new Set();
      for (const sid of specs) clientIds.add(sid);
      for (const cid of clientIds) {
        const info = this.clientToPlayer.get(cid);
        const state = this._gameState(room, info ? true : false);
        state.seat = info ? info.seat : null;
        state.isPlayer = !!info;
        this.broadcaster(cid, { type: 'state', data: state });
      }
    },

    /**
     * 大厅「进行中对局」列表（REST 轮询用）。
     * 私人房间不出现（PLAN §T2）——这个列表就是给陌生人点进去观战用的。
     */
    /**
     * 管理后台的在线房间列表（§C6 实时干预）。
     *
     * 与 `activeGames()` 的差异是**刻意的**：
     *  - 那个只列**非私人**房间（它的用途是"给陌生人点进去观战"），后台必须看到**全部**，
     *    包括密码房——否则"有人开了房但没人能进去"这类问题根本无从排查；
     *  - 那个只有展示字段，后台还要"谁在里面、连没连着、是不是私人房"，才能判断该不该干预。
     */
    adminRooms() {
      return [...this.rooms.values()].map((r) => ({
        roomId: r.id,
        code: r.code,
        status: r.status,
        isPrivate: !!r.isPrivate,
        rated: !!r.rated,
        tournamentId: r.tournamentId || null,
        handicap: r.handicap || null,
        createdAt: r.createdAt || null,
        moveCount: (r.game && Array.isArray(r.game.moves)) ? r.game.moves.length : 0,
        players: ['b', 'w'].map((seat) => {
          const p = r.players[seat];
          return p
            ? { seat, name: p.name || null, id: p.playerId || null, connected: p.connected !== false }
            : null;
        }).filter(Boolean),
        spectators: this.spectatorCount ? this.spectatorCount(r.id) : 0,
      })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // 新的在前
    },

    activeGames() {
      // 进行中对局 + 感想战中的房间（终局后未清理，type='reviewing' 复盘中，可继续观战）
      // 私人房间不出现（PLAN §T2）：这个列表就是给陌生人点进去观战用的
      return [...this.rooms.values()]
        .filter((r) => !r.isPrivate && (r.status === 'PLAYING' || (r.status === 'FINISHED' && r.demo)))
        .map((r) => ({
          roomId: r.id,
          code: r.code,
          players: {
            b: r.players.b ? r.players.b.name : null,
            w: r.players.w ? r.players.w.name : null,
          },
          // 玩家 id（大厅观战列表悬停信息卡用，PLAN §F3）
          playerIds: {
            b: r.players.b ? r.players.b.playerId : null,
            w: r.players.w ? r.players.w.playerId : null,
          },
          moveCount: r.game.moves.length,
          // 观战人数（PLAN §R4：大厅展示 + 热门排序）
          spectatorCount: this.spectatorCount(r),
          type: r.status === 'FINISHED' ? 'reviewing' : r.type,
          createdAt: r.createdAt,
          // 让子局要在大厅列表里显出来：否则观战者进来才发现棋盘少了几枚棋子
          handicap: r.handicap || null,
          handicapLabel: r.handicapLabel || null,
        }));
    },

    /**
     * 观战人数（PLAN §R4）。**按 playerId 去重**——同一身份开多个窗口只算一个观众，
     * 口径与对局页的观众列表（_spectatorList）保持一致。
     * 只做计数、不查资料，供大厅 5 秒轮询的列表接口使用。
     */
    spectatorCount(room) {
      const specs = this.spectatorsByRoom.get(room.id);
      if (!specs || !specs.size) return 0;
      if (!this.playerRegistry) return specs.size;
      const seen = new Set();
      for (const cid of specs) {
        const info = this.playerRegistry(cid);
        if (info && info.playerId) seen.add(info.playerId);
      }
      return seen.size;
    },

    /** 该连接当前房间的状态快照（重连/首次请求用），无房间返回 null */
    getRoomStateForClient(clientId) {
      const roomId = this.clientToRoom.get(clientId);
      if (!roomId) return null;
      const room = this._room(roomId);
      if (!room) return null;
      const info = this.clientToPlayer.get(clientId);
      const state = this._gameState(room, info ? true : false);
      state.seat = info ? info.seat : null;
      state.isPlayer = !!info;
      return state;
    },

    /**
     * 观战者名单（对局页观众列表用，PLAN §R）。
     * 修复两处体验缺陷：
     *  1. 旧实现只给名字 → 前端无法做悬停卡片、无法区分同名、无法展示等级
     *  2. 同一身份开多个窗口观战会被重复计数 → 现按 playerId 去重
     * @returns {Array<{id:string, name:string, rating:number, level:number}>}
     */
    _spectatorList(room) {
      const specs = this.spectatorsByRoom.get(room.id) || new Set();
      const map = new Map();
      for (const cid of specs) {
        const info = this.playerRegistry ? this.playerRegistry(cid) : null;
        if (!info || !info.playerId) continue;
        if (map.has(info.playerId)) continue; // 同人多窗口只算一个观众
        const prof = ratings.profile(info.playerId);
        map.set(info.playerId, {
          id: info.playerId,
          name: info.name || '观众',
          rating: prof.rating,
          level: prof.level,
          avatar: this._playerAvatar(info.playerId), // 2026-09-20：观众列表也显示头像
        });
      }
      return [...map.values()];
    },

    /** 兼容旧调用：只要名字数组 */
    _spectatorNames(room) {
      return this._spectatorList(room).map((s) => s.name);
    },

    /** 观战者名单变动广播（对局页观众列表实时更新） */
    _broadcastSpectators(room) {
      this._broadcast(room.id, { type: 'spectator_update', data: { spectators: this._spectatorList(room) } });
    },

    /**
     * 系统聊天播报（§R3 观众进出提示）。
     * `kind` 是给前端的**类型标签**——观众进出类消息可被用户关掉显示（避免刷屏），
     * 其余系统消息（如"你已进入观战"）不受影响。
     */
    _sysChat(room, text, kind) {
      this._broadcast(room.id, {
        type: 'chat',
        data: { name: '系统', text, ts: Date.now(), sys: true, kind: kind || null },
      });
    },

    /** 取观战者显示名（§R3）：优先名字缓存 → registry → 兜底「观众」 */
    _specName(clientId) {
      const cached = this.spectatorNames.get(clientId);
      if (cached) return cached;
      const info = this.playerRegistry ? this.playerRegistry(clientId) : null;
      return (info && info.name) || '观众';
    },

    /** 房主所在座位（感想战的演示权默认归房主；找不到则先手） */
    _hostSeat(room) {
      if (room.creatorId) {
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (p && p.playerId === room.creatorId) return seat;
        }
      }
      return 'b';
    },
  });
};
