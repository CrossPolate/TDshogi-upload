/**
 * rooms/gameplay.js — 对局内动作与结算（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 「一局棋从开局到落盘」的写路径都在这里：走子 → 认输 / 入玉宣言 → 判终局 → 结算落谱 → 再来一局 / 离开。
 *
 * 拆出来的理由：这是**规则与数据落盘的交汇处**——每手都要算耗时、判终局、推状态，
 * 终局还要结算 ELO/经验、写棋谱、通知赛事、广播 `game_over`。单独成文件后,
 * 「结算逻辑改了什么」一目了然，不必在两千里外的状态机里找。
 *
 * 注入方式：`applyGameplay(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 *
 * ⚠️ 改动这一块要格外小心：`_finalize()` 是**唯一的落盘出口**（ELO / 经验 / 棋谱 /
 * 赛事回调全在这），出错会污染战绩数据。`_checkGameOver()` 有**幂等保护**
 * （`room.status === 'FINISHED'` 直接 return），避免重复结算。
 *
 * 依赖：`ratings`（ELO/经验）、`records.saveRecord`（棋谱）、`game.newGame`（再来一局）、
 *       `rooms/config`（时制与钟状态）、`tournaments.onMatchFinished`（按需 require）。
 */
'use strict';

const ratings = require('../ratings');
const { newGame } = require('../game');
const { saveRecord } = require('../records');
const { TIME_CONTROLS, DEFAULT_TIME_CONTROL, initClockState } = require('./config');

module.exports = function applyGameplay(X) {
  Object.assign(X.prototype, {
    /**
     * 走子。返回 {ok, error?}。
     */
    makeMove(clientId, usi) {
      const seat = this.clientToPlayer.get(clientId);
      if (!seat) return { ok: false, error: '你不在对局中' };
      const room = this._room(seat.roomId);
      if (!room || room.status !== 'PLAYING') return { ok: false, error: '对局未在进行' };
      const game = room.game;
      if (seat.seat !== game.turn) return { ok: false, error: '还没轮到你' };
      if (!game.isGameOver()) {
        // 每手耗时（秒）：自该方上一手（或开局）起算——KIF 消費時間/累計時間用
        const now = Date.now();
        const spent = Math.max(0, Math.round((now - (room.lastMoveTs || room.createdAt)) / 1000));
        const r = game.applyMove(usi);
        if (!r.ok) return { ok: false, error: r.error || '非法走法' };
        room.moveTimes = room.moveTimes || [];
        room.moveTimes.push(spent);
        room.lastMoveTs = now;
        room.lastActiveAt = now;
        // 走子后重置下一手玩家的读秒（进入新回合计时）
        if (room.inByoyomi) {
          const nextTurn = game.turn;
          room.inByoyomi[nextTurn] = false;
          room.curByoyomi[nextTurn] = room.byoyomi;
        }
        this._checkGameOver(room);
        this._pushState(room);
        return { ok: true };
      }
      return { ok: false, error: '对局已结束' };
    },

    resign(clientId) {
      const seat = this.clientToPlayer.get(clientId);
      if (!seat) return { ok: false, error: '你不在对局中' };
      const room = this._room(seat.roomId);
      if (!room || room.status !== 'PLAYING') return { ok: false, error: '对局未在进行' };
      if (room.game.isGameOver()) return { ok: false, error: '对局已结束' };
      // 认输：判「认输座位」负，而不是当前手番方（避免非手番方认输误判对手）
      room.game.result = seat.seat === 'b' ? 'w' : 'b';
      room.game.resultDetail = '投了';
      this._checkGameOver(room);
      this._pushState(room);
      return { ok: true };
    },

    /**
     * 入玉宣言（PLAN §P1 R-d；用户 2026-09-10 拍板 **AJSA 全套**）。
     *
     * 由**玩家主动申请**，服务端做权威判定——前端只传一个"我要宣言"的意图，
     * 成不成立全部由 `game.declareNyugyoku()` 判定（条件见 game.js 的注释）。
     * 这样规则只有一处实现，前端不需要（也不应该）自己算点数。
     */
    declareNyugyoku(clientId) {
      const seat = this.clientToPlayer.get(clientId);
      if (!seat) return { ok: false, error: '你不是本局玩家，不能宣言' };
      const room = this._room(seat.roomId);
      if (!room || room.status !== 'PLAYING') return { ok: false, error: '对局未在进行' };
      if (room.game.isGameOver()) return { ok: false, error: '对局已结束' };
      const r = room.game.declareNyugyoku(seat.seat);
      if (!r.ok) return { ok: false, error: r.error };
      this._checkGameOver(room);
      this._pushState(room);
      return { ok: true, detail: r.detail, points: r.points, count: r.count };
    },

    /**
     * 房间聊天：玩家或观战者发言，广播给房间内所有人（含观战者）。
     * 防刷屏：单客户端 2 秒内最多 1 条。
     */
    chat(clientId, text) {
      const msg = String(text || '').trim().slice(0, 200);
      if (!msg) return { ok: false, error: '消息为空' };
      const roomId = this.clientToRoom.get(clientId);
      if (!roomId) return { ok: false, error: '你不在任何房间中' };
      const room = this._room(roomId);
      if (!room) return { ok: false, error: '房间不存在' };
      // 节流
      const now = Date.now();
      if (this._lastChatTs && this._lastChatTs[clientId] && now - this._lastChatTs[clientId] < 2000) {
        return { ok: false, error: '发言太频繁，请稍候' };
      }
      this._lastChatTs = this._lastChatTs || {};
      this._lastChatTs[clientId] = now;
      // 发言者身份：玩家用座位名；观战者用其会话真名（旧实现一律显示"观众"，互动体验差）
      const seat = this.clientToPlayer.get(clientId);
      let name = '观众';
      let role = 'spectator';
      if (seat && room.players[seat.seat]) {
        name = room.players[seat.seat].name;
        role = seat.seat === 'b' ? 'player-b' : 'player-w';
      } else {
        const info = this.playerRegistry ? this.playerRegistry(clientId) : null;
        if (info && info.name) name = info.name;
      }
      this._broadcast(roomId, {
        type: 'chat',
        data: { name, text: msg, ts: now, role },
      });
      return { ok: true };
    },

    /**
     * 判终局（**幂等**：已 FINISHED 直接 return，避免重复结算）。
     * 终局后自动进入感想战（`_initDemo`），并清理断线计时器与快照（对局已落盘，无需恢复）。
     */
    _checkGameOver(room) {
      const game = room.game;
      if (!game.isGameOver()) return;
      if (room.status === 'FINISHED') return;
      room.status = 'FINISHED';
      room.result = game.result;
      room.resultDetail = game.resultDetail;
      this._stopClock(room);
      // 感想战：终局自动初始化演示状态（演示权归房主，见 PLAN §G）
      this._initDemo(room);
      // 向全场推送终局 state（含 demo）——双方与观战者据此统一自动进入感想战；
      // 否则只有触发终局的那个连接能进入（其余成员停在旧画面）
      this._pushState(room);
      // 对局结束：清理断线宽限计时器 + 清除快照（对局已落盘 records，无需恢复）
      const timers = this._disconnectTimers.get(room.id);
      if (timers) {
        for (const t of timers.values()) clearTimeout(t);
        this._disconnectTimers.delete(room.id);
      }
      this._clearSnapshot(room.id);
      this._finalize(room);
    },

    /** 结算落盘（ELO / 经验 / 棋谱 / 赛事回调 / `game_over` 广播）——**唯一出口** */
    _finalize(room) {
      const game = room.game;
      const b = room.players.b;
      const w = room.players.w;
      // 胜者 id（与 rated 无关：赛事对局虽不计 ELO，但必须推进对阵表）
      let winnerId = null;
      if (game.result === 'b') winnerId = b ? b.playerId : null;
      else if (game.result === 'w') winnerId = w ? w.playerId : null;
      // ELO 结算（仅 rated 房间）
      if (room.rated && b && w && game.result) {
        ratings.applyGameResult(b.playerId, w.playerId, game.result);
      }
      // 对局经验（PLAN §K7）：完成一局双方 +1（含赛事对局；离开/断线判负同样算完成）
      try {
        if (b) ratings.addExp(b.playerId, 1, 'game');
        if (w) ratings.addExp(w.playerId, 1, 'game');
      } catch (_) {}
      // 保存棋谱
      // ⚠️ 赛事棋谱**强制公开**（T6/需求 12）——判定放在这里、而不是靠调用方传参：
      // 只要这局属于某个赛事，就必须能被所有人查看（赛事详情页要展示全部对局）。
      // 写在落盘路径上，将来新增的建房入口也不会漏掉这条规则。
      const tournamentId = room.tournamentId || null;
      const record = saveRecord({
        startSfen: game.startSfen,
        moves: game.moves,
        moveTimes: room.moveTimes || [],
        timeControl: room.timeControl,
        names: [b ? b.name : '先手', w ? w.name : '後手'],
        result: game.result,
        resultDetail: game.resultDetail,
        playerIds: { b: b ? b.playerId : null, w: w ? w.playerId : null },
        winnerId,
        durationSec: Math.round((Date.now() - room.createdAt) / 1000),
        tournamentId,
        visibility: tournamentId ? 'public' : undefined,
      });
      room.recordId = record.id;
      // 赛事回调
      if (room.tournamentId && winnerId) {
        const { onMatchFinished } = require('../tournaments');
        onMatchFinished(room.tournamentId, room.id, winnerId);
      }
      // 广播对局结束
      this._broadcast(room.id, {
        type: 'game_over',
        data: {
          roomId: room.id,
          result: game.result,
          resultDetail: game.resultDetail,
          winnerId,
          recordId: record.id,
          names: [b ? b.name : '先手', w ? w.name : '後手'],
        },
      });
      this._pushState(room);
    },

    rematch(clientId) {
      const seat = this.clientToPlayer.get(clientId);
      if (!seat) return { ok: false, error: '你不在对局中' };
      const room = this._room(seat.roomId);
      if (!room || room.status !== 'FINISHED') return { ok: false, error: '对局尚未结束' };
      room.rematchVotes = room.rematchVotes || {};
      const already = !!room.rematchVotes[seat.seat];
      room.rematchVotes[seat.seat] = true;
      if (room.rematchVotes.b && room.rematchVotes.w) {
        // 双方同意，重置对局
        room.game = newGame();
        room.status = 'PLAYING';
        room.result = null;
        room.resultDetail = null;
        const tc = TIME_CONTROLS[room.timeControl] || TIME_CONTROLS[DEFAULT_TIME_CONTROL];
        Object.assign(room, initClockState(tc));
        room.lastMoveTs = Date.now();
        room.lastActiveAt = Date.now();
        room.recordId = null;
        room.moveTimes = [];
        room.demo = null; // 再来一局：退出感想战，清空推演
        room.rematchVotes = {};
        this._startClock(room);
        this._broadcast(room.id, { type: 'game_start', data: { roomId: room.id, code: room.code } });
        this._pushState(room);
      } else if (!already) {
        // 仅一方请求：通知对手「对手请求再来一局」
        const requester = room.players[seat.seat];
        const oppSeat = seat.seat === 'b' ? 'w' : 'b';
        const opp = room.players[oppSeat];
        const payload = {
          type: 'rematch_requested',
          data: {
            requesterName: requester ? requester.name : '对手',
            seat: seat.seat,
          },
        };
        if (opp && opp.clientId) this._send(opp.clientId, payload);
      }
      return { ok: true };
    },

    leave(clientId) {
      this.cancelMatch(clientId);
      // 观战者：从观战列表移除并解绑（否则残留导致继续收广播 + 内存泄漏）
      const specRoomId = this.clientToRoom.get(clientId);
      if (specRoomId && !this.clientToPlayer.has(clientId)) {
        const specRoom = this._room(specRoomId);
        const specName = this._specName(clientId); // 必须在清理之前取
        const specs = this.spectatorsByRoom.get(specRoomId);
        if (specs) {
          specs.delete(clientId);
          if (specs.size === 0) this.spectatorsByRoom.delete(specRoomId);
        }
        this.spectatorNames.delete(clientId);
        this.clientToRoom.delete(clientId);
        // §R3：播报「XX 离开观战」
        if (specRoom) this._sysChat(specRoom, `${specName} 离开观战`, 'spectate-leave');
        return { ok: true };
      }
      const seat = this.clientToPlayer.get(clientId);
      if (!seat) return { ok: true };
      const room = this._room(seat.roomId);
      if (!room) return { ok: true };
      // 等待中房间：房主/玩家主动离开 → 立即销毁整个房间（关键修复）
      // 否则房间永远残留成为「幽灵房间」，其他人用 code 加入会开局但对手是空壳
      if (room.status === 'WAITING') {
        // 通知仍在房间里的观战者（若有）
        this._broadcast(room.id, { type: 'room_closed', data: { roomId: room.id, reason: 'host_left' } });
        this._dissolveRoom(room.id, 'host_left');
        this.clientToPlayer.delete(clientId);
        this.clientToRoom.delete(clientId);
        return { ok: true };
      }
      // 对局中离开 → 判「离开座位」负（而不是当前手番方）
      // 修复：原 resultDetail 写「投了」误导对手；中途退出/断线超时应提示「接続切断」
      if (room.status === 'PLAYING' && !room.game.isGameOver()) {
        room.game.result = seat.seat === 'b' ? 'w' : 'b';
        room.game.resultDetail = '接続切断';
        this._checkGameOver(room);
      }
      this._unbindClient(clientId);
      return { ok: true };
    },
  });
};
