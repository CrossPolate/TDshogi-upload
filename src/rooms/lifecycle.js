/**
 * rooms/lifecycle.js — 房间生命周期：建房 / 加入 / 匹配 / 开局 / 赛事对局（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 这是**玩家进入一张棋桌的全部路径**：建房、凭码加入、快速匹配，以及赛事系统直接建房。
 * 三条入口共享同一套「先把自己从旧房间摘干净」的前置逻辑（`_autoLeave*` 系列），
 * 这些清理是幽灵房问题的长期修复成果：
 *  - 旧连接残留的座位会被回位扫描捞出来，把新连接绑回旧对局 → `_autoLeaveAllRooms` 按 playerId 清；
 *  - 房主刷新后 WAITING 房没人销毁 → 房间码仍可被加入、开局后对手是空壳 → 建房/换房时立即销毁旧等待房；
 *  - 对局中换玩法 → 自动认输退出（用户拍板，PLAN §H）。
 *
 * 注入方式：`applyLifecycle(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 *
 * ⚠️ `_playerTitle()` 里的 30s TTL 缓存**不能删**：`auth.load()` 是同步读磁盘，
 * 而它被 `_gameState()` 在每次走子时调用（每局 2 次）——直接读等于把磁盘 I/O 塞进对局主循环。
 *
 * 依赖：`game.newGame`、`auth`（genId / load）、`room-password`（私人房）、
 *       `rooms/config`（时制与钟状态）、`logger`。
 */
'use strict';

const { newGame } = require('../game');
const { genId } = require('../auth');
const roomPassword = require('../room-password');
const log = require('../logger');
const { TIME_CONTROLS, DEFAULT_TIME_CONTROL, initClockState } = require('./config');

module.exports = function applyLifecycle(X) {
  Object.assign(X.prototype, {
    /**
     * 创建房间（host 作为先手或随机）。
     * @param {object} host { clientId, playerId, name }
     * @param {string} timeControlId 时间控制预设 id
     * @param {{isPrivate?:boolean, password?:string}} [opts] 私人房间（PLAN §T2）：休闲模式 + 可选密码
     * @returns {{ok:true, roomId, code, seat}|{ok:false, error}}
     */
    createRoom(host, timeControlId, opts) {
      // 若在已结束的对局中则自动退出；对局中自动认输退出（用户确认，PLAN §H）
      this._autoLeaveFinished(host.clientId);
      this._autoResignAndLeave(host.clientId);
      this._autoLeaveAllRooms(host.playerId, host.clientId); // 旧连接残留的座位一并退出（幽灵房修复）
      this._abandonRestoredFor(host.playerId);
      // 同一 playerId 名下已有进行中房间（另一连接/另一窗口）→ 拒绝；
      // 仅等待中的旧房 → 视为放弃并销毁（防止一人占多个房间）
      for (const room of [...this.rooms.values()]) {
        if (room.status === 'FINISHED') continue;
        const seat = ['b', 'w'].find((s) => room.players[s] && room.players[s].playerId === host.playerId);
        if (!seat) continue;
        if (room.status === 'PLAYING' && !room.game.isGameOver()) {
          return { ok: false, error: '你已在对局中，请先结束当前对局' };
        }
        this._broadcast(room.id, { type: 'room_closed', data: { roomId: room.id, reason: 'host_switch' } });
        this._dissolveRoom(room.id, 'host_recreate_other_connection');
      }
      // 同一玩家已处于进行中/等待中房间 → 阻止重复建房
      // 修复：原先未拦截，导致同连接连建多房，留下大量幽灵 WAITING 房间，
      //      其他人用旧 code 加入会「开局但对手是断连的空壳」（即"加进来的人不能正常游戏"）
      const curRoomId = this.clientToRoom.get(host.clientId);
      if (curRoomId) {
        const cur = this._room(curRoomId);
        if (cur && cur.status === 'PLAYING') {
          return { ok: false, error: '你已在对局中，请先结束当前对局' };
        }
        if (cur && cur.status === 'WAITING') {
          // 旧等待房已存在 → 立即销毁，再建新房（避免幽灵）
          this._dissolveRoom(curRoomId, 'host_recreate');
          this._unbindClient(host.clientId);
        }
      }
      const tc = TIME_CONTROLS[timeControlId] || TIME_CONTROLS[DEFAULT_TIME_CONTROL];
      const o = opts || {};
      // 私人房间（PLAN §T2）：休闲模式——**不计 ELO**（`_finalize` 只对 rated 房间结算）；
      // 经验值在 `_finalize` 里是**无条件**加的，所以「经验照常加」无需额外处理。
      const isPrivate = o.isPrivate === true;
      const password = typeof o.password === 'string' ? o.password.trim() : '';
      if (isPrivate && !roomPassword.isValid(password)) {
        return { ok: false, error: `房间密码需 ${roomPassword.MIN}–${roomPassword.MAX} 位` };
      }
      const code = this._genRoomCode();
      const roomId = genId();
      const room = {
        id: roomId,
        code,
        game: newGame(),
        players: { b: null, w: null },
        status: 'WAITING',       // WAITING | PLAYING | FINISHED
        type: 'room',
        creatorId: host.playerId,
        createdAt: Date.now(),
        timeControl: tc.id,
        ...initClockState(tc),
        lastMoveTs: null,
        lastActiveAt: Date.now(),
        result: null,
        resultDetail: null,
        rated: !isPrivate,       // §T2：私人房间不计 ELO
        isPrivate,               // §T2：不进观战列表 / 不可观战 / 排除随机观战
        passwordHash: (isPrivate && password) ? roomPassword.hash(password) : null,
        tournamentId: null,
      };
      // host 随机执先手
      const seat = Math.random() < 0.5 ? 'b' : 'w';
      room.players[seat] = {
        clientId: host.clientId,
        playerId: host.playerId,
        name: host.name,
        connected: true,
      };
      this.rooms.set(roomId, room);
      this.byCode.set(code, roomId);
      this._bindClient(host.clientId, roomId, seat);
      return { ok: true, roomId, code, seat };
    },

    /**
     * 加入房间（按房间码）。
     * @param {object} player { clientId, playerId, name }
     * @param {string} code
     * @param {string} [password] 私人房间密码（PLAN §T2）
     */
    joinRoom(player, code, password) {
      // 若在已结束的对局中则自动退出；对局中自动认输退出（用户确认，PLAN §H）
      this._autoLeaveFinished(player.clientId);
      this._autoResignAndLeave(player.clientId);
      this._autoLeaveAllRooms(player.playerId, player.clientId); // 旧连接残留的座位一并退出（幽灵房修复）
      this._abandonRestoredFor(player.playerId);
      const roomId = this.byCode.get(code.trim().toUpperCase());
      if (!roomId) return { ok: false, error: '房间不存在或房间码错误' };
      // 同一身份不能加入自己的房间（房主座位已是自己的 playerId → 再加入即一人占两位）
      const target = this._room(roomId);
      if (target && ['b', 'w'].some((s) => target.players[s] && target.players[s].playerId === player.playerId)) {
        return { ok: false, error: '这是你自己创建/所在的房间，同一身份不能加入（可在对局结束后再来，或换一个身份测试）' };
      }
      // 私人房间密码校验（PLAN §T2）。
      // ⚠️ 位置讲究：必须放在「处理当前所在房间」**之前**——否则密码输错也会先把玩家
      // 从原等待房踢出去，变成"试错一次就被赶出房间"。
      if (target && target.isPrivate && !roomPassword.verify(target.passwordHash, password)) {
        return {
          ok: false,
          needPassword: true, // 结构化标志：前端据此显示密码输入框再重试
          error: password ? '房间密码错误' : '该房间是私人房间，需要密码',
        };
      }
      const curId = this.clientToRoom.get(player.clientId);
      if (curId) {
        const curRoom = this._room(curId);
        if (curRoom && curRoom.status === 'PLAYING') {
          return { ok: false, error: '你正在对局中，请先结束当前对局' };
        }
        // 自己的等待房未开赛：换房 → 销毁旧等待房（避免幽灵房）；
        // 若目标就是自己的等待房，按"已在房间中"处理（不动原房间）
        if (curRoom && curRoom.status === 'WAITING') {
          if (curId === roomId) return { ok: false, error: '你已在房间中' };
          this._dissolveRoom(curId, 'switch_room');
          this._unbindClient(player.clientId);
        }
      }
      const room = this._room(roomId);
      if (room.status !== 'WAITING') return { ok: false, error: '对局已经开始，无法加入' };
      // 空位
      let seat = null;
      if (!room.players.b) seat = 'b';
      else if (!room.players.w) seat = 'w';
      else return { ok: false, error: '房间已满' };
      if (room.players[seat] && room.players[seat].playerId === player.playerId) {
        return { ok: false, error: '你已在房间中' };
      }
      room.players[seat] = {
        clientId: player.clientId,
        playerId: player.playerId,
        name: player.name,
        connected: true,
      };
      this._bindClient(player.clientId, roomId, seat);
      this._startGame(room);
      return { ok: true, roomId, code, seat };
    },

    /** 对局中自动认输并退出（用户确认：匹配/建房时若在对局中自动退出，PLAN §H） */
    _autoResignAndLeave(clientId) {
      const seat = this.clientToPlayer.get(clientId);
      if (!seat) return;
      const room = this._room(seat.roomId);
      if (!room || room.status !== 'PLAYING' || room.game.isGameOver()) return;
      room.game.result = seat.seat === 'b' ? 'w' : 'b';
      room.game.resultDetail = '投了';
      this._checkGameOver(room);
      this._autoLeaveFinished(clientId);
    },

    /**
     * 快速匹配：将玩家放入队列，两人即配对。
     */
    quickMatch(player) {
      // 若在已结束的对局中则自动退出；对局中自动认输退出（用户确认，PLAN §H）
      this._autoLeaveFinished(player.clientId);
      this._autoResignAndLeave(player.clientId);
      this._autoLeaveAllRooms(player.playerId, player.clientId); // 旧连接残留的座位一并退出（幽灵房修复）
      this._abandonRestoredFor(player.playerId);
      // 已绑在某房间：进行中 → 拒绝；自己的等待房（未开赛）→ 销毁后再匹配
      // （否则房主换玩法后 WAITING 房残留，其他人凭旧 code 加入会开局但对手是空壳）
      const curId = this.clientToRoom.get(player.clientId);
      if (curId) {
        const cur = this._room(curId);
        if (cur && cur.status === 'WAITING') {
          this._dissolveRoom(curId, 'switch_to_match');
          this._unbindClient(player.clientId);
        } else {
          return { ok: false, error: '你已在房间中' };
        }
      }
      // 同一身份已在队列 → 拒绝（防止同浏览器双窗口/双标签自己和自己配对，占两个位置）
      if (this.matchQueue.some((cid) => {
        const p = this.playerRegistry(cid);
        return p && p.playerId === player.playerId;
      })) {
        return { ok: false, error: '同一身份已在匹配队列中——不能自己和自己对弈' };
      }
      if (this.matchQueue.includes(player.clientId)) return { ok: false, error: '已在匹配队列中' };
      this.matchQueue.push(player.clientId);
      // 配对
      if (this.matchQueue.length >= 2) {
        const c1 = this.matchQueue.shift();
        const c2 = this.matchQueue.shift();
        // 从广播器/玩家表取会话信息（由 protocol 层注入 player registry）
        const p1 = this.playerRegistry ? this.playerRegistry(c1) : null;
        const p2 = this.playerRegistry ? this.playerRegistry(c2) : null;
        // 配对安全网：同 playerId 永远不配到一起
        if (p1 && p2 && p1.playerId === p2.playerId) {
          this.matchQueue.unshift(c1);
          return { ok: false, error: '同一身份不能自己和自己对弈' };
        }
        if (p1 && p2) {
          this._startQuickMatch(p1, p2);
        } else {
          // 无法配对则回退到创建房间
          const p = p1 || p2;
          if (p) this.createRoom(p);
        }
      }
      return { ok: true };
    },

    cancelMatch(clientId) {
      const idx = this.matchQueue.indexOf(clientId);
      if (idx >= 0) this.matchQueue.splice(idx, 1);
      return { ok: true };
    },

    /**
     * 若玩家当前绑定的房间已结束（FINISHED），自动解除绑定。
     * 这样赢家/输家无需手动点「退出」即可再次匹配或建房。
     * @returns {boolean} 是否发生了解绑
     */
    _autoLeaveFinished(clientId) {
      const curRoomId = this.clientToRoom.get(clientId);
      if (!curRoomId) return false;
      const room = this._room(curRoomId);
      if (room && room.status === 'FINISHED') {
        // 从结束房间的座位记录中移除该客户端（避免继续广播到此连接）
        const seat = this.clientToPlayer.get(clientId);
        if (seat && room.players[seat.seat]) {
          this.playerToClient.delete(room.players[seat.seat].playerId);
          room.players[seat.seat] = null;   // 清空座位，房间可被再次加入（若 WAITING 已不可能，但保持干净）
        }
        this._unbindClient(clientId);
        return true;
      }
      return false;
    },

    /**
     * 自动退出该身份名下所有其他房间的座位（按 playerId，含已断线的旧连接座位——幽灵房修复）。
     * 既有 _autoLeaveFinished/_autoResignAndLeave 只查「当前连接」绑定的房间，覆盖不到
     * 已关闭旧连接留下的座位；这些座位残留在回位扫描里，会把新连接绑回旧对局（幽灵房）。
     *  - PLAYING 未终局 → 自动认输（投了，PLAN §H 同款）
     *  - FINISHED（含复盘中）→ 移除座位记录（与 _autoLeaveFinished 口径一致）；
     *    由此大厅列表不再把他认作该局选手，重访旧局走观战入口
     *  - 复盘中持有演示权 → 释放
     * exceptClientId：当前连接所在的房间不动（WAITING 换房/对局中认输由既有逻辑处理）
     */
    _autoLeaveAllRooms(playerId, exceptClientId = null) {
      if (!playerId) return;
      const keepRoomId = exceptClientId ? this.clientToRoom.get(exceptClientId) : null;
      for (const room of this.rooms.values()) {
        if (room.restored) continue;               // 恢复局由 _abandonRestoredFor 专门处理
        if (keepRoomId && room.id === keepRoomId) continue;
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (!p || p.playerId !== playerId) continue;
          if (room.status === 'PLAYING' && !room.game.isGameOver()) {
            room.game.result = seat === 'b' ? 'w' : 'b';
            room.game.resultDetail = '投了';
            this._checkGameOver(room);
          }
          if (room.status !== 'FINISHED') continue; // WAITING 房间由既有换房/销毁逻辑处理
          if (room.demo && room.demo.demonstratorSeat === seat) {
            room.demo.demonstratorSeat = null;
            room.demo.updatedAt = Date.now();
            this._broadcastDemo(room);
          }
          if (p.clientId) {
            // 该 clientId 若仍连着（多窗口场景），同步解除其房间绑定
            this.clientToRoom.delete(p.clientId);
            this.clientToPlayer.delete(p.clientId);
          }
          this.playerToClient.delete(playerId);
          room.players[seat] = null;
          this._pushState(room);
        }
      }
    },

    _startQuickMatch(p1, p2) {
      const code = this._genRoomCode();
      const roomId = genId();
      const tc = TIME_CONTROLS[DEFAULT_TIME_CONTROL]; // 快速匹配固定 10 分钟包干
      const room = {
        id: roomId,
        code,
        game: newGame(),
        players: { b: null, w: null },
        status: 'PLAYING',
        type: 'quick',
        creatorId: null,
        createdAt: Date.now(),
        timeControl: tc.id,
        ...initClockState(tc),
        lastMoveTs: Date.now(),
        lastActiveAt: Date.now(),
        result: null,
        resultDetail: null,
        rated: true,
        tournamentId: null,
      };
      const seatB = Math.random() < 0.5 ? p1 : p2;
      const seatW = seatB === p1 ? p2 : p1;
      room.players.b = { ...seatB, connected: true, clientId: seatB.clientId };
      room.players.w = { ...seatW, connected: true, clientId: seatW.clientId };
      this.rooms.set(roomId, room);
      this.byCode.set(code, roomId);
      this._bindClient(seatB.clientId, roomId, 'b');
      this._bindClient(seatW.clientId, roomId, 'w');
      this._startClock(room);
      // 通知双方开赛
      this._broadcast(roomId, { type: 'game_start', data: { roomId, code, seat: this.clientToPlayer.get(seatB.clientId).seat } });
      this._send(seatB.clientId, { type: 'matched', data: { roomId, code } });
      this._send(seatW.clientId, { type: 'matched', data: { roomId, code } });
      this._pushState(room);
    },

    _startGame(room) {
      room.status = 'PLAYING';
      room.lastMoveTs = Date.now();
      room.demo = null;      // 新对局开始：清除上一局的感想战演示状态
      room.emptySince = null;
      this._startClock(room);
      this._broadcast(room.id, { type: 'game_start', data: { roomId: room.id, code: room.code } });
      this._pushState(room);
      // 若任一座位开局时已失联（典型场景：房主建房后断线 → joiner 凭 code 加入），
      // 立即为该座位启动断线判负计时，避免「开局但对手是空壳、永远等不到走子」。
      for (const seat of ['b', 'w']) {
        const p = room.players[seat];
        if (p && !p.connected && !room.game.isGameOver()) {
          this._scheduleDisconnectLoss(room.id, seat);
        }
      }
    },

    /**
     * 为赛事创建一场对局（双方由 playerId 指定，系统直接建房，无等待期）。
     * @param {string} tournamentId
     * @param {string[]} playerIds [先手, 后手]
     * @returns {{roomId:string}|null}
     */
    createTournamentMatch(tournamentId, playerIds) {
      if (!tournamentId || !Array.isArray(playerIds) || playerIds.length !== 2) return null;
      const code = this._genRoomCode();
      const roomId = genId();
      const tc = TIME_CONTROLS[DEFAULT_TIME_CONTROL];
      const room = {
        id: roomId,
        code,
        game: newGame(),
        players: { b: null, w: null },
        status: 'PLAYING',
        type: 'tournament',
        creatorId: null,
        createdAt: Date.now(),
        timeControl: tc.id,
        ...initClockState(tc),
        lastMoveTs: Date.now(),
        lastActiveAt: Date.now(),
        result: null,
        resultDetail: null,
        rated: false, // 赛事对局不计 ELO
        tournamentId,
      };
      // 绑定双方（若在线；不在线则由其主动 joinTournamentMatch 进入）
      const attach = (seat, playerId) => {
        const clientId = this.playerToClient.get(playerId);
        if (clientId) {
          room.players[seat] = { clientId, playerId, name: this._playerName(playerId), connected: true };
          this._bindClient(clientId, roomId, seat);
        } else {
          room.players[seat] = { clientId: null, playerId, name: this._playerName(playerId), connected: false };
        }
      };
      const seatB = Math.random() < 0.5 ? playerIds[0] : playerIds[1];
      const seatW = seatB === playerIds[0] ? playerIds[1] : playerIds[0];
      attach('b', seatB);
      attach('w', seatW);
      this.rooms.set(roomId, room);
      this.byCode.set(code, roomId);
      this._startClock(room);
      this._broadcast(roomId, { type: 'game_start', data: { roomId, code } });
      this._pushState(room);
      return { roomId };
    },

    _playerName(playerId) {
      const sess = require('../auth').load(playerId);
      return sess && sess.name ? sess.name : playerId.slice(0, 6);
    },

    /**
     * §R5：取玩家称号。
     * 称号**不在** `ratings.profile()` 里（那里只有 rating / exp / 战绩），而是挂在会话对象上，
     * 因此必须单独从 auth 读——否则玩家栏的称号会永远是空的。
     *
     * ⚠️ 必须缓存：`auth.load()` 是**同步读磁盘**，而本函数在 `_gameState()` 里每次走子都会调用
     * （每局 2 次）——直接读等于把磁盘 I/O 塞进对局主循环，与 §Q7-2 修掉的是同一类问题。
     * 称号是低频数据，用 TTL 兜住「管理员改称号」的可见延迟即可。
     */
    _playerTitle(playerId) {
      if (!playerId) return null;
      const TTL_MS = 30000;
      const now = Date.now();
      const cached = this._titleCache.get(playerId);
      if (cached && now - cached.at < TTL_MS) return cached.title;
      let title = null;
      try {
        const sess = require('../auth').load(playerId);
        title = (sess && sess.title) || null;
      } catch (_) { title = null; }
      // 缓存不是关键数据：超限整体清空，避免长时间运行后无界增长
      if (this._titleCache.size > 1000) this._titleCache.clear();
      this._titleCache.set(playerId, { title, at: now });
      return title;
    },

    /**
     * 玩家主动进入自己的赛事对局（建局时可能不在线）。
     */
    joinTournamentMatch(clientId, roomId, playerId) {
      const room = this._room(roomId);
      if (!room || room.type !== 'tournament') return { ok: false, error: '赛事对局不存在' };
      let seat = null;
      for (const s of ['b', 'w']) {
        const p = room.players[s];
        if (p && p.playerId === playerId) { seat = s; break; }
      }
      if (!seat) return { ok: false, error: '你不是该对局的参赛者' };
      if (room.players[seat].connected && room.players[seat].clientId !== clientId) {
        return { ok: false, error: '该座位已有连接' };
      }
      const p = room.players[seat];
      p.clientId = clientId;
      p.connected = true;
      p.name = this._playerName(playerId);
      this._bindClient(clientId, roomId, seat);
      this._pushState(room);
      return { ok: true, roomId, seat };
    },

    /** 玩家改名同步：更新对局中双方的名字并推送 */
    updatePlayerName(playerId, newName) {
      for (const room of this.rooms.values()) {
        let updated = false;
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (p && p.playerId === playerId && p.name !== newName) {
            p.name = newName;
            updated = true;
          }
        }
        if (updated) {
          log.info('rooms', `玩家 ${playerId} 改名→${newName}，房间 ${room.id} state 广播`, { roomId: room.id, playerId });
          this._pushState(room);
        }
      }
    },
  });
};
