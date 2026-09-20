/**
 * rooms/snapshot.js — 对局快照与「重启续局」（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 为什么需要：对局状态全在内存里，进程一重启就没了。这里把进行中/等待中的房间
 * 定期落盘（只存**持久身份**，不存 clientId 等连接态），启动时重放走法恢复。
 *
 * 拆出来的理由：这是一个自成一体的「持久化 + 恢复」子系统，与房间状态机本身无关；
 * 而且它踩过的坑（恢复局自愈、私人房属性必须随快照持久化）集中在此，独立成文件更好维护。
 *
 * 注入方式：`applySnapshot(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 *
 * 依赖：`newGame` / `STARTING_SFEN`、`rooms/config` 的 `DEFAULT_TIME_CONTROL`、`storage`（按需 require）、`logger`。
 */
'use strict';

const { newGame, STARTING_SFEN } = require('../game');
const { DEFAULT_TIME_CONTROL } = require('./config');
const log = require('../logger');

module.exports = function applySnapshot(X) {
  Object.assign(X.prototype, {
    /**
     * 放弃玩家名下的「恢复局」（服务器重启时从快照恢复的旧局，room.restored = true）。
     * 在玩家主动开启新对局（建房/加入/匹配）时调用——否则 request_state 的重连兜底
     * 会按 playerId 把玩家绑回僵尸恢复局，表现为新对局「双方锁死、计时器不动」。
     *  - 对手仍在线 → 按接続切断判负推进（保留对手的结算与复盘）
     *  - 对手不在线/无对手/WAITING → 直接解散
     */
    _abandonRestoredFor(playerId) {
      if (!playerId) return;
      for (const room of [...this.rooms.values()]) {
        if (!room.restored || room.status === 'FINISHED') continue;
        const seat = ['b', 'w'].find((s) => room.players[s] && room.players[s].playerId === playerId);
        if (!seat) continue;
        const otherSeat = seat === 'b' ? 'w' : 'b';
        const other = room.players[otherSeat];
        const otherConnected = !!(other && other.connected);
        if (room.status === 'WAITING' || !otherConnected || room.game.isGameOver()) {
          this._broadcast(room.id, { type: 'room_closed', data: { roomId: room.id, reason: 'abandoned_restored' } });
          this._dissolveRoom(room.id, 'player_started_new_game');
        } else {
          room.game.result = seat === 'b' ? 'w' : 'b';
          room.game.resultDetail = '接続切断';
          this._checkGameOver(room);
        }
      }
    },

    /**
     * 序列化房间为可恢复的快照（不包含连接态：clientId/spectators 等运行时信息）。
     */
    _serializeRoom(room) {
      const game = room.game;
      return {
        id: room.id,
        code: room.code,
        status: room.status,
        type: room.type,
        creatorId: room.creatorId,
        createdAt: room.createdAt,
        timeControl: room.timeControl,
        clock: { ...room.clock },
        byoyomi: room.byoyomi,
        curByoyomi: room.curByoyomi ? { ...room.curByoyomi } : null,
        inByoyomi: room.inByoyomi ? { ...room.inByoyomi } : null,
        rated: room.rated,
        // §T2：私人房属性必须随快照持久化，否则重启恢复后私人房会变成"公开可加入"
        isPrivate: !!room.isPrivate,
        passwordHash: room.passwordHash || null,
        tournamentId: room.tournamentId,
        // 駒落ち（让子）：虽然 `startSfen` 已能还原盘面，但**展示用的标签也得存** ——
        // 否则重启后房间会对局页显示成平手局，而盘上确实少着棋子，看着像数据坏了
        handicap: room.handicap || null,
        handicapLabel: room.handicapLabel || null,
        // 对局数据：startSfen + moves 可完整重放恢复 Game
        startSfen: game.startSfen,
        moves: [...game.moves],
        result: game.result,
        resultDetail: game.resultDetail,
        // 玩家（仅持久身份，不存 clientId）
        players: {
          b: room.players.b ? { playerId: room.players.b.playerId, name: room.players.b.name } : null,
          w: room.players.w ? { playerId: room.players.w.playerId, name: room.players.w.name } : null,
        },
      };
    },

    /** 保存单个房间快照（仅 PLAYING 与 WAITING） */
    _snapshotRoom(room) {
      if (!room || (room.status !== 'PLAYING' && room.status !== 'WAITING')) return;
      try {
        require('../storage').putGameSnapshot(room.id, this._serializeRoom(room));
      } catch (err) {
        log.error('rooms', '快照失败', { err, roomId: room.id });
      }
    },

    /** 定期快照所有进行中的对局 */
    _snapshotAll() {
      for (const room of this.rooms.values()) {
        this._snapshotRoom(room);
      }
    },

    /** 对局结束/删除时清除快照 */
    _clearSnapshot(roomId) {
      try { require('../storage').deleteGameSnapshot(roomId); } catch (_) {}
    },

    /**
     * 启动时恢复全部快照（服务器重启后续局）。
     * 玩家重连时由 protocol.reconnect 找到恢复的房间。
     * @returns {number} 恢复的房间数
     */
    restoreSnapshots() {
      let restored = 0;
      let snapshots = [];
      try { snapshots = require('../storage').listGameSnapshots(); } catch (_) { return 0; }
      for (const { roomId, data } of snapshots) {
        try {
          const room = this._restoreRoom(data);
          if (!room) { this._clearSnapshot(roomId); continue; }
          this.rooms.set(room.id, room);
          this.byCode.set(room.code, room.id);
          // 重新绑定玩家（若在线）
          for (const seat of ['b', 'w']) {
            const p = room.players[seat];
            if (p && p.playerId) {
              const clientId = this.playerToClient.get(p.playerId);
              if (clientId) {
                p.clientId = clientId;
                p.connected = true;
                this._bindClient(clientId, room.id, seat);
              } else {
                p.clientId = null;
                p.connected = false;
              }
            }
          }
          // 恢复局自愈（防幽灵复活循环，修复「重启后新对局被旧局劫持」）：
          //  - WAITING 恢复房：没有需要保留的对局，立即销毁
          //  - PLAYING 恢复局：对未连接座位启动 60s 判负计时——
          //    及时重连可续局；都不回来则判负收尾并清快照，
          //    否则僵尸恢复局每次重启复活，request_state 重连兜底会把
          //    玩家绑进死局（表现为新对局「双方锁死、计时器不动」）
          room.restored = true;
          if (room.status === 'WAITING') {
            this._dissolveRoom(room.id, 'restored_waiting_cleanup');
            continue;
          }
          if (room.status === 'PLAYING') {
            this._startClock(room);
            for (const seat of ['b', 'w']) {
              const p = room.players[seat];
              if (p && p.connected === false && !room.game.isGameOver()) {
                this._scheduleDisconnectLoss(room.id, seat);
              }
            }
          }
          restored++;
        } catch (err) {
          log.error('rooms', '恢复房间失败', { err, roomId });
          this._clearSnapshot(roomId);
        }
      }
      return restored;
    },

    /** 从快照重建房间对象（Game 用 startSfen+moves 重放） */
    _restoreRoom(snap) {
      if (!snap || !snap.id) return null;
      const game = newGame(snap.startSfen || STARTING_SFEN, [
        snap.players && snap.players.b ? snap.players.b.name : '先手',
        snap.players && snap.players.w ? snap.players.w.name : '後手',
      ]);
      // 重放走法
      for (const usi of snap.moves || []) {
        const r = game.applyMove(usi);
        if (!r.ok) return null; // 走法无法重放 → 快照无效
      }
      const room = {
        id: snap.id,
        code: snap.code,
        game,
        players: {
          b: snap.players && snap.players.b ? { clientId: null, playerId: snap.players.b.playerId, name: snap.players.b.name, connected: false } : null,
          w: snap.players && snap.players.w ? { clientId: null, playerId: snap.players.w.playerId, name: snap.players.w.name, connected: false } : null,
        },
        status: snap.status || 'FINISHED',
        type: snap.type || 'room',
        creatorId: snap.creatorId || null,
        createdAt: snap.createdAt || Date.now(),
        timeControl: snap.timeControl || DEFAULT_TIME_CONTROL,
        clock: snap.clock ? { ...snap.clock } : { b: 0, w: 0 },
        byoyomi: snap.byoyomi || 0,
        curByoyomi: snap.curByoyomi ? { ...snap.curByoyomi } : { b: 0, w: 0 },
        inByoyomi: snap.inByoyomi ? { ...snap.inByoyomi } : { b: false, w: false },
        lastMoveTs: Date.now(),
        lastActiveAt: Date.now(),
        result: snap.result || null,
        resultDetail: snap.resultDetail || null,
        rated: snap.rated !== false,
        handicap: snap.handicap || null,
        handicapLabel: snap.handicapLabel || null,
        isPrivate: !!snap.isPrivate, // §T2：恢复私人房属性（否则重启后私人房会变成公开）
        passwordHash: snap.passwordHash || null,
        tournamentId: snap.tournamentId || null,
      };
      return room;
    },
  });
};
