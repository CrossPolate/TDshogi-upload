/**
 * rooms/clock.js — 对局棋钟（本时 / 读秒 / 超时判负）（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 服务端的棋钟是**权威计时**：每秒 tick 推进当前手番一方的时间，
 * 本时耗尽进入读秒（給整手 byoyomi），读秒也耗尽则 `時間切れ` 判负。
 * 前端 `play-clock.js` 只是显示与本地倒计时的近似，以服务端推送的 `clock` 消息校准。
 *
 * 拆出来的理由：计时规则集中成一块（本时/读秒/包干三种形态），与房间状态机、
 * 匹配、绑定等无关，独立后改「读秒给多少」这类规则不必翻大文件。
 *
 * 注入方式：`applyClock(RoomManager)` 挂到 prototype 上，`this.*` 调用链不变。
 * 依赖：`rooms/config` 的 `TICK_MS`。
 */
'use strict';

const { TICK_MS } = require('./config');

module.exports = function applyClock(X) {
  Object.assign(X.prototype, {
    _startClock(room) {
      this._stopClock(room.id);
      const timer = setInterval(() => this._tick(room.id), TICK_MS);
      this._clockTimers.set(room.id, timer);
    },

    _stopClock(roomId) {
      const timer = this._clockTimers.get(roomId);
      if (timer) clearInterval(timer);
      this._clockTimers.delete(roomId);
    },

    _tick(roomId) {
      const room = this._room(roomId);
      if (!room || room.status !== 'PLAYING') return;
      const turn = room.game.turn;
      const byoyomi = room.byoyomi || 0;

      if (room.clock[turn] > 0) {
        // 本时消耗
        room.clock[turn] -= TICK_MS;
        if (room.clock[turn] <= 0) {
          room.clock[turn] = 0;
          if (byoyomi > 0) {
            // 本时耗尽 → 进入读秒：给当前手完整的 byoyomi
            room.inByoyomi[turn] = true;
            room.curByoyomi[turn] = byoyomi;
            this._broadcast(roomId, { type: 'clock', data: this._clockData(room) });
          } else {
            // 包干：本时用尽即判负
            const game = room.game;
            game.result = turn === 'b' ? 'w' : 'b';
            game.resultDetail = '時間切れ';
            this._checkGameOver(room);
          }
        } else {
          this._broadcast(roomId, { type: 'clock', data: this._clockData(room) });
        }
      } else if (byoyomi > 0) {
        // 本时已为 0（含 0+10 快棋：初始即读秒）
        if (!room.inByoyomi[turn]) {
          room.inByoyomi[turn] = true;
          room.curByoyomi[turn] = byoyomi;
        }
        // 读秒中
        room.curByoyomi[turn] -= TICK_MS;
        if (room.curByoyomi[turn] <= 0) {
          room.curByoyomi[turn] = 0;
          const game = room.game;
          game.result = turn === 'b' ? 'w' : 'b';
          game.resultDetail = '時間切れ';
          this._checkGameOver(room);
        } else {
          this._broadcast(roomId, { type: 'clock', data: this._clockData(room) });
        }
      }
      // byoyomi === 0 且 clock === 0 的包干情况：已在上一分支 clock 耗尽时判负，无需处理
    },

    _clockData(room) {
      return {
        clock: { ...room.clock },
        byoyomi: room.byoyomi || 0,
        curByoyomi: room.curByoyomi ? { ...room.curByoyomi } : null,
        inByoyomi: room.inByoyomi ? { ...room.inByoyomi } : null,
        turn: room.game.turn,
      };
    },
  });
};
