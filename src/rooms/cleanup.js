/**
 * rooms/cleanup.js — 房间销毁与各类宽限计时（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 房间是内存对象，**没人清理就会永久泄漏**（还会在「进行中对局」列表里留下幽灵）。
 * 这里集中三类回收策略，都是踩过坑之后补的：
 *  - `_dissolveRoom()`：销毁房间，清掉全部绑定/定时器/快照。早期 `leave()`/断线/重复建房
 *    **都不销毁 WAITING 房间**，导致「房主刷新后房间码仍可被加入 → 开局但对手是空壳」+ 内存泄漏。
 *  - `_cleanupFinished()`：定期巡检——完全无连接的房间给 NO_MEMBER_CLEANUP_MS 缓冲后回收
 *    （覆盖刷新/闪断），FINISHED 且还有人的房间按 FINISHED_TTL_MS 回收（感想战不会永远开着）。
 *  - 断线宽限：PLAYING 中掉线超过 RECONNECT_GRACE_MS 未回即判负（`接続切断`，与投了区分）。
 *
 * 注入方式：`applyCleanup(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 * 依赖：`rooms/config`（三个宽限常量）、`logger`。
 */
'use strict';

const { RECONNECT_GRACE_MS, NO_MEMBER_CLEANUP_MS, FINISHED_TTL_MS } = require('./config');
const log = require('../logger');

module.exports = function applyCleanup(X) {
  Object.assign(X.prototype, {
    /**
     * 销毁房间：清理所有绑定与资源，避免 WAITING 房间永远残留成为「幽灵房间」。
     * 修复：原先 leave()/断线/重复建房均不销毁 WAITING 房间，导致：
     *  1) 房主刷新/离开后，房间码仍可被其他人加入 → 出现「开局但对手是空壳」
     *  2) 进行中列表内存泄漏（rooms Map 永远增长）
     * @param {string} roomId
     * @param {string} reason 用于日志
     */
    /**
     * 管理员强制解散房间（§C6 实时干预）。
     *
     * 公开包装：HTTP 路由**不应该**直接调 `_dissolveRoom`——那是内部方法，
     * "拆房间要同时清掉哪些绑定 / 定时器 / 快照"的知识必须留在这一层，
     * 否则又会散到别处去（§M1 刚把它收敛回来）。
     *
     * @returns {{ok:boolean, error?:string, info?:{roomId:string, players:string}}}
     */
    adminCloseRoom(roomId) {
      const room = this._room(roomId);
      if (!room) return { ok: false, error: '房间不存在或已结束' };
      const info = {
        roomId,
        players: ['b', 'w']
          .map((s) => (room.players[s] ? room.players[s].name : null))
          .filter(Boolean).join(' vs '),
      };
      this._dissolveRoom(roomId, 'admin_close');
      return { ok: true, info };
    },

    _dissolveRoom(roomId, reason = 'dissolve') {
      const room = this._room(roomId);
      if (!room) return;
      this.rooms.delete(roomId);
      this.byCode.delete(room.code);
      this._stopClock(roomId);
      // 清理所有玩家绑定（先于清座位，避免 unbind 误判）
      for (const seat of ['b', 'w']) {
        const p = room.players[seat];
        if (p && p.clientId) {
          this.clientToRoom.delete(p.clientId);
          this.clientToPlayer.delete(p.clientId);
        }
        if (p && p.playerId) this.playerToClient.delete(p.playerId);
      }
      // 观战者
      const specs = this.spectatorsByRoom.get(roomId);
      if (specs) {
        for (const sid of specs) this.clientToRoom.delete(sid);
        this.spectatorsByRoom.delete(roomId);
      }
      // 清理该房间的所有定时器
      const dt = this._disconnectTimers.get(roomId);
      if (dt) { for (const t of dt.values()) clearTimeout(t); this._disconnectTimers.delete(roomId); }
      const wt = this._waitingTimers && this._waitingTimers.get(roomId);
      if (wt) { clearTimeout(wt); this._waitingTimers.delete(roomId); }
      this._clearSnapshot(roomId);
      log.info('rooms', `房间 ${roomId} (${room.code}) 销毁 (${reason})`, { roomId, reason });
    },

    /**
     * 安排 WAITING 房间在 N 秒后自动销毁（若仍无玩家重连）。
     * 给玩家一个「刷新页面重连」的机会；超时后清理，避免幽灵。
     */
    _scheduleWaitingDissolve(roomId, ms = 20000) {
      if (!this._waitingTimers) this._waitingTimers = new Map();
      if (this._waitingTimers.has(roomId)) return;
      const t = setTimeout(() => {
        this._waitingTimers && this._waitingTimers.delete(roomId);
        const r = this._room(roomId);
        if (!r || r.status !== 'WAITING') return;
        // 仍有连接的玩家 → 不销毁（可能加入了第二个玩家）
        const anyConnected = (r.players.b && r.players.b.connected) || (r.players.w && r.players.w.connected);
        if (anyConnected) return;
        this._dissolveRoom(roomId, 'waiting_timeout');
      }, ms);
      this._waitingTimers.set(roomId, t);
    },

    _clearWaitingTimer(roomId) {
      if (!this._waitingTimers) return;
      const t = this._waitingTimers.get(roomId);
      if (t) { clearTimeout(t); this._waitingTimers.delete(roomId); }
    },

    /**
     * 断线宽限期：对局中玩家断线后，超过 RECONNECT_GRACE_MS 未重连则判负。
     * 重连成功时由 _bindClient 清除对应计时器。
     */
    _scheduleDisconnectLoss(roomId, seat) {
      const room = this._room(roomId);
      if (!room) return;
      const timers = this._disconnectTimers.get(roomId) || new Map();
      // 幂等：同座位已有计时器则跳过
      if (timers.has(seat)) return;
      const timer = setTimeout(() => {
        const cur = this._room(roomId);
        if (!cur || cur.status !== 'PLAYING' || cur.game.isGameOver()) return;
        const p = cur.players[seat];
        // 仍未重连 → 判该座位负（接続切断，与主动投了区分）
        if (p && !p.connected) {
          cur.game.result = seat === 'b' ? 'w' : 'b';
          cur.game.resultDetail = '接続切断';
          // 聊天区留痕（2026-09-20）：宽限期到了才判负——与「刚掉线」区分开，
          // 否则用户会以为"一掉线就判负了"。
          this._sysChat(cur, `⏱ ${p.name || '对手'} 掉线超过宽限期未回归，判负`, 'player-timeout');
          this._checkGameOver(cur);
        }
        timers.delete(seat);
        if (timers.size === 0) this._disconnectTimers.delete(roomId);
      }, RECONNECT_GRACE_MS);
      timers.set(seat, timer);
      this._disconnectTimers.set(roomId, timers);
    },

    _clearDisconnectTimer(roomId, seat) {
      const timers = this._disconnectTimers.get(roomId);
      if (!timers) return;
      const t = timers.get(seat);
      if (t) { clearTimeout(t); timers.delete(seat); }
      if (timers.size === 0) this._disconnectTimers.delete(roomId);
    },

    /**
     * 管理员取消赛事：解散其全部进行中/等待中的对局房间。
     * 由 server 路由在 tournaments.cancelTournament 返回 matchIds 后调用。
     * 房内所有人收到 room_closed 通知。
     */
    dissolveTournamentMatches(matchIds, reason = 'tournament_cancelled') {
      let n = 0;
      for (const roomId of matchIds || []) {
        const room = this._room(roomId);
        if (!room) continue;
        this._broadcast(roomId, { type: 'room_closed', data: { roomId, reason } });
        this._dissolveRoom(roomId, reason);
        n++;
      }
      return n;
    },

    /**
     * 房间清理（PLAN §G6 改版，用户建议）：
     *  - 完全无连接（玩家+观战者均 0）：缓冲 NO_MEMBER_CLEANUP_MS（默认 2 分钟，
     *    覆盖刷新/闪断）后清理，任何状态一律适用
     *  - FINISHED（感想战中）且有连接成员：自最后活动起 FINISHED_TTL_MS（默认 30 分钟）后清理
     *  - WAITING/PLAYING 的断线场景仍走各自的 20s/60s 宽限（现状不变）
     *
     * 由构造里的定时器每分钟巡检一次（`_finishedCleanupTimer`）。
     */
    _cleanupFinished() {
      const now = Date.now();
      for (const room of [...this.rooms.values()]) {
        const members = this._connectedMemberCount(room);
        if (members === 0) {
          if (!room.emptySince) {
            room.emptySince = now;
          } else if (now - room.emptySince >= NO_MEMBER_CLEANUP_MS) {
            this._dissolveRoom(room.id, 'no_members_cleanup');
          }
          continue;
        }
        room.emptySince = null;
        if (room.status !== 'FINISHED') continue;
        const lastActive = Math.max(
          room.demo ? room.demo.updatedAt || 0 : 0,
          room.lastActiveAt || 0,
          room.createdAt || 0
        );
        if (now - lastActive >= FINISHED_TTL_MS) {
          this._dissolveRoom(room.id, 'finished_ttl_cleanup');
        }
      }
    },

    /** 房间当前连接成员数（在线玩家 + 观战者） */
    _connectedMemberCount(room) {
      let n = 0;
      for (const seat of ['b', 'w']) {
        const p = room.players[seat];
        if (p && p.connected !== false) n++;
      }
      const specs = this.spectatorsByRoom.get(room.id);
      if (specs) n += specs.size;
      return n;
    },
  });
};
