/**
 * rooms/binding.js — 观战、客户端绑定与断线回位（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 这一块回答一个问题：**「这条 WebSocket 连接属于谁、该绑到哪张棋桌」**。
 * 它是全项目 bug 最密集的区域之一，因为「连接」与「身份」是两回事：
 *  - 同一个 playerId 可以有多条连接（多标签页、刷新时的竞态）；
 *  - 刷新/跳转时**新连接可能先于旧连接 close 到达**，此时按 `connected === false` 找座位会落空；
 *  - 访客身份（guestId）在观战窗口里是公开的，若拿它当玩家身份回位，就会出现「观战窗口误绑座位」。
 *
 * 因此这里的每条路径都带着一段「为什么这么写」的注释——它们都是线上事故的修复记录：
 *  - `_bindClient()`：**必须同时更新 `room.players[seat].clientId`**，否则广播发到已断开的旧连接；
 *  - `spectate()`：私人房的**密码放行**与「本房选手直接放行」（否则复盘回不去）；
 *  - `reconnect()` / `bindToActiveGame()` / `_findDisconnectedSeat()`：`preferRoomId`（URL 指向的房间）
 *    优先，避免「重新匹配后，旧复盘的断线座位按 Map 插入顺序抢先绑定」（幽灵房）。
 *
 * 注入方式：`applyBinding(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 * 依赖：`room-password`（私人房观战校验，纯函数模块）。
 */
'use strict';

const roomPassword = require('../room-password');

module.exports = function applyBinding(X) {
  Object.assign(X.prototype, {
    /**
     * 观战。
     * @param {string} roomIdOrCode 房间 id **或** 6 位房间码（大厅「观战」按钮只拿得到码）
     * @param {string} [password] 私人房间的观战密码（PLAN §T2）
     */
    spectate(clientId, roomIdOrCode, playerId, password) {
      let room = this._room(roomIdOrCode);
      if (!room) {
        // 也接受房间码：统一解析成 roomId，后面的所有键值一律用 room.id
        const id = this.byCode.get(String(roomIdOrCode || '').trim().toUpperCase());
        if (id) room = this._room(id);
      }
      if (!room) return { ok: false, error: '对局不存在或房间码错误' };
      const roomId = room.id;
      // 私人房间观战（PLAN §T2）：**凭密码放行**——房主把「房间码 + 密码」给谁，就等于邀请了谁。
      // 例外：本连接正是该房选手时直接放行（下面的「座位回位」路径要允许他们自己进来，含终局复盘）。
      const seatInfoNow = this.clientToPlayer.get(clientId);
      const seatedHere = !!(seatInfoNow && seatInfoNow.roomId === roomId);
      if (room.isPrivate && !seatedHere && !roomPassword.verify(room.passwordHash, password)) {
        return {
          ok: false,
          needPassword: true, // 结构化标志：前端据此提示输入密码
          error: password ? '房间密码错误' : '这是私人房间，需要密码才能观战',
        };
      }
      // 座位回位（PLAN §H）：本连接 playerId 命中本房间座位 → 回到座位（对局中/复盘中皆可），不进观战席
      const seatInfo = this.clientToPlayer.get(clientId);
      if (seatInfo && seatInfo.roomId === roomId) {
        const mySeat = seatInfo.seat;
        const p = room.players[mySeat];
        if (p) {
          p.clientId = clientId;
          p.connected = true;
          this._bindClient(clientId, roomId, mySeat);
          this._pushState(room);
          return { ok: true, roomId, seat: mySeat, rebind: true };
        }
      }
      // 掉线重进（进行中对局列表入口）：新连接的 clientId 映射已被 _unbindClient 清除，
      // 必须按持久 playerId 匹配座位才能回位（与 reconnect()/bindToActiveGame() 同口径）
      if (playerId && !(room.status === 'FINISHED' && !room.demo)) {
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (p && p.playerId === playerId && !p.connected) {
            // 旧连接仍挂着时先解除其绑定（页面跳转竞态：新连接先于旧 close 到达）
            if (p.clientId && p.clientId !== clientId) {
              this.clientToRoom.delete(p.clientId);
              this.clientToPlayer.delete(p.clientId);
              this.playerToClient.delete(p.playerId);
            }
            p.clientId = clientId;
            p.connected = true;
            this._bindClient(clientId, roomId, seat);
            this._pushState(room);
            return { ok: true, roomId, seat, rebind: true };
          }
        }
      }
      // 正在对局的玩家禁止观战其他对局：
      // 原先静默返回 ok，前端会跳转到别人的对局页，导致玩家"丢失"自己的对局、
      // 重连混乱（表现为"掉线后回不到对局"）。这里直接拒绝并引导回对局。
      const seat = this.clientToPlayer.get(clientId);
      if (seat) {
        const myRoom = this._room(seat.roomId);
        if (myRoom && myRoom.status === 'PLAYING') {
          return { ok: false, error: '你正在对局中，不能观战其他对局', backRoomId: myRoom.id };
        }
      }
      if (!this.spectatorsByRoom.has(roomId)) this.spectatorsByRoom.set(roomId, new Set());
      this.spectatorsByRoom.get(roomId).add(clientId);
      this._broadcastSpectators(room); // 观众列表实时更新（PLAN §G v7）
      this.clientToRoom.set(clientId, roomId);
      // §R3：先记名字再播报——断线路径那时已查不到 registry，只能靠这张表
      const specName = this._specName(clientId);
      this.spectatorNames.set(clientId, specName);
      this._sysChat(room, `${specName} 进入观战`, 'spectate-join');
      return { ok: true, roomId };
    },

    randomSpectate(clientId, playerId) {
      // 排除私人房间（PLAN §T2）：随机观战不该把私人局推给陌生人
      const playing = [...this.rooms.values()].filter((r) => r.status === 'PLAYING' && !r.isPrivate);
      if (!playing.length) return { ok: false, error: '当前没有可观战的对局' };
      const room = playing[Math.floor(Math.random() * playing.length)];
      const res = this.spectate(clientId, room.id, playerId);
      return res;
    },

    _bindClient(clientId, roomId, seat) {
      this.clientToRoom.set(clientId, roomId);
      this.clientToPlayer.set(clientId, { roomId, seat });
      const room = this._room(roomId);
      if (room && room.players[seat]) {
        this.playerToClient.set(room.players[seat].playerId, clientId);
        // 关键：必须更新座位记录的 clientId，否则 _pushState 广播会发到已断开的旧连接
        // 修复：原先 reconnect() 显式设置 p.clientId，bindToActiveGame() 也设置，
        //       但统一收敛到 _bindClient 后遗漏了 p.clientId，导致重连后收不到 state 推送
        room.players[seat].clientId = clientId;
        // 重连回来（此前是掉线态）才播报；首次绑定不给聊天区插消息，否则开局就多一条废话
        const wasDisconnected = room.players[seat].connected === false;
        room.players[seat].connected = true;
        if (wasDisconnected && room.status === 'PLAYING') {
          this._sysChat(room, `✅ ${room.players[seat].name || '对手'} 已回到对局`, 'player-return');
        }
        // 重连成功：清除断线宽限计时器 + WAITING 销毁定时器
        this._clearDisconnectTimer(roomId, seat);
        this._clearWaitingTimer(roomId);
      }
    },

    _unbindClient(clientId) {
      // 匹配队列清理：断线/退出的排队者必须移出，否则僵尸条目会毒化后续配对
      const qIdx = this.matchQueue.indexOf(clientId);
      if (qIdx >= 0) this.matchQueue.splice(qIdx, 1);
      // 聊天节流表清理（2026-09-21 审查 P2-3）：`_lastChatTs` 按 clientId **只写不删**，
      // 每个连过的 clientId 都会留一条，长跑缓慢增长。这里是**唯一的断连汇聚点**，
      // 所有退出路径（关页面/掉线/退出对局/换房）最后都会走到这里。
      if (this._lastChatTs) delete this._lastChatTs[clientId];
      // 观战者断线：同样清理（否则残留收广播 + 泄漏）
      const specRoomId = this.clientToRoom.get(clientId);
      if (specRoomId && !this.clientToPlayer.has(clientId)) {
        const specName = this._specName(clientId); // 必须在 delete 之前取（registry 此刻已被删除）
        const specs = this.spectatorsByRoom.get(specRoomId);
        if (specs) {
          specs.delete(clientId);
          if (specs.size === 0) this.spectatorsByRoom.delete(specRoomId);
          const room = this._room(specRoomId);
          if (room) {
            this._broadcastSpectators(room); // 观众列表实时更新
            this._sysChat(room, `${specName} 离开观战`, 'spectate-leave'); // §R3
          }
        }
        this.spectatorNames.delete(clientId);
      }
      const seat = this.clientToPlayer.get(clientId);
      if (seat) {
        const room = this._room(seat.roomId);
        if (room && room.players[seat.seat]) {
          this.playerToClient.delete(room.players[seat.seat].playerId);
          room.players[seat.seat].connected = false;
          // 对局中玩家断线：启动宽限期计时，超时未重连则判负
          if (room.status === 'PLAYING' && !room.game.isGameOver()) {
            this._scheduleDisconnectLoss(room.id, seat.seat);
            // 聊天区留痕（2026-09-20 用户要求）：玩家栏上的「⚠️ 断线」是**瞬时**提示，
            // 低头看棋盘的对手会错过；聊天区能回看，也顺带让观战者知道发生了什么。
            // ⚠️ 名字只能从 `room.players[seat].name` 取：走到这里 registry 已经删了
            //（§R3 的观众播报就踩过这个，所以那段注释专门写了"必须在这张表里先记下名字"）。
            this._sysChat(
              room,
              `⚠️ ${room.players[seat.seat].name || '对手'} 已离开页面（掉线），等待重连…`,
              'player-leave'
            );
            // 立即推送状态（players.connected=false），让对手实时看到「对手断线」
            this._pushState(room);
          }
          // 等待中房间的玩家断线：20s 宽限后销毁（避免幽灵房间）
          // 修复：原先断线只置 connected=false，房间永远残留，其他人用 code 加入会开局但对手是空壳
          if (room.status === 'WAITING') {
            this._scheduleWaitingDissolve(room.id, 20000);
          }
          // 感想战中演示者断线：演示权置空并广播（任何玩家可认领，PLAN §G）
          if (room.status === 'FINISHED' && room.demo && room.demo.demonstratorSeat === seat.seat) {
            room.demo.demonstratorSeat = null;
            room.demo.updatedAt = Date.now();
            this._broadcastDemo(room);
          }
        }
      }
      this.clientToPlayer.delete(clientId);
      this.clientToRoom.delete(clientId);
    },

    /**
     * 探测玩家是否有未结束的对局（不绑定，仅报告；绑定由 request_state 完成，
     * 避免同 guestId 的观战窗口连接时误绑玩家座位）。
     * @returns {{roomId:string, seat:string}|null}
     */
    findPendingGame(playerId) {
      for (const room of this.rooms.values()) {
        if (room.status !== 'PLAYING') continue;
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (p && p.playerId === playerId) {
            return { roomId: room.id, seat };
          }
        }
      }
      return null;
    },

    reconnect(clientId, playerId, preferRoomId = null) {
      // 根据 playerId 查座位表回位（含「复盘中」房间——掉线/刷新/重进都回到自己座位，PLAN §G v7）
      // 纯 FINISHED（无感想战）的房间仍跳过
      // preferRoomId：客户端 URL 指向的房间优先。重新匹配进入新对局时，旧对局
      // （复盘中）的断线座位不能凭 Map 插入顺序抢先绑定（幽灵房修复）
      if (preferRoomId) {
        const hit = this._findDisconnectedSeat(preferRoomId, playerId);
        if (hit) {
          this._bindClient(clientId, hit.room.id, hit.seat);
          return { ok: true, roomId: hit.room.id, seat: hit.seat, reconnect: true };
        }
      }
      for (const room of this.rooms.values()) {
        if (room.status === 'FINISHED' && (!room.demo || preferRoomId)) continue;
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (p && p.playerId === playerId && !p.connected) {
            // 找到断线的对局，重连
            this._bindClient(clientId, room.id, seat);
            return { ok: true, roomId: room.id, seat, reconnect: true };
          }
        }
      }
      return { ok: false };
    },

    /** 在指定房间内找 playerId 的断线座位（复盘中房间也算，回位口径与 reconnect 一致） */
    _findDisconnectedSeat(roomId, playerId) {
      const room = this._room(roomId);
      if (!room) return null;
      if (room.status === 'FINISHED' && !room.demo) return null;
      for (const seat of ['b', 'w']) {
        const p = room.players[seat];
        if (p && p.playerId === playerId && !p.connected) return { room, seat };
      }
      return null;
    },

    /**
     * 兜底绑定：玩家页面跳转时，新连接可能先于旧连接 close 到达，
     * 此时 reconnect() 找不到 connected=false 的座位。这里按 playerId
     * 强制把新连接绑回其进行中的对局（顶替旧连接，不依赖 close 时序）。
     * preferRoomId：URL 指向的房间优先（幽灵房修复，同 reconnect）；且带
     * preferRoomId 时不再兜底绑定到旧的「复盘中」房间。
     * @returns {{roomId:string, seat:string}|null}
     */
    bindToActiveGame(clientId, playerId, preferRoomId = null) {
      const ordered = [];
      if (preferRoomId) {
        const r0 = this._room(preferRoomId);
        if (r0) ordered.push(r0);
      }
      for (const room of this.rooms.values()) {
        if (room.id !== preferRoomId) ordered.push(room);
      }
      for (const room of ordered) {
        if (room.status === 'FINISHED' && (!room.demo || preferRoomId)) continue;
        for (const seat of ['b', 'w']) {
          const p = room.players[seat];
          if (p && p.playerId === playerId) {
            // 若旧连接仍在（竞态），先解除旧 clientId 的绑定关系
            if (p.clientId && p.clientId !== clientId) {
              this.clientToRoom.delete(p.clientId);
              this.clientToPlayer.delete(p.clientId);
              this.playerToClient.delete(p.playerId);
            }
            p.clientId = clientId;
            p.connected = true;
            this._bindClient(clientId, room.id, seat);
            return { ok: true, roomId: room.id, seat };
          }
        }
      }
      return null;
    },
  });
};
