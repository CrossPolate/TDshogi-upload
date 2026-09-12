/**
 * rooms/demo.js — 感想战（推演谱 / 演示权 / 历史手）（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 感想战 = 终局后的「复盘推演」：双方或观战者轮流当演示者，在同一个棋盘上摆变化，
 * 支持历史手回退与分支（在某一手走不同的棋 → 截断其后推演、重设起点）。
 *
 * 拆出来的理由：这 9 个方法自成一个玩法子系统（推演谱的基点/分支模型 + 演示权状态机），
 * 与对局主流程（走子/棋钟/结算）没有耦合——只在「终局」与「房间绑定」处各有一个入口。
 *
 * 注入方式：`applyDemo(RoomManager)` 把方法挂到 prototype 上，**`this.*` 调用链完全不变**，
 * 因此对调用方（protocol.js / 房间主流程）是透明的。
 *
 * 依赖：`newGame` / `STARTING_SFEN`（规则引擎）、`records.movesToKif`（日式记谱，按需 require）。
 */
'use strict';

const { newGame, STARTING_SFEN } = require('../game');

module.exports = function applyDemo(X) {
  Object.assign(X.prototype, {
    /**
     * 终局后初始化演示状态（推演谱：可变基点分支模型，PLAN §G v4）。
     * baseIndex/baseSfen：推演谱的起点（默认=原对局终局）；在棋谱历史手处下出
     * 不同的棋 → 起点回退到该手、之后的推演截断（新分支覆盖）。
     */
    _initDemo(room) {
      const moves = room.game.moves || [];
      room.demo = {
        baseIndex: moves.length,               // 推演起点 = 原谱第 N 手后
        baseCount: moves.length,               // 原对局总手数（不变，用于界面区分本谱/推演）
        baseSfen: room.game.state().sfen,      // 起点局面 SFEN
        moves: [],                             // 推演着法（USI，规则合法，服务端校验）
        kif: [],                               // 推演着法日式记谱
        demonstratorSeat: this._hostSeat(room),
        updatedAt: Date.now(),
        _game: null,                           // 推演 Game（懒重建）
      };
    },

    /** 原谱第 k 手后的局面 SFEN（k=0 即初始局面） */
    _sfenAtOriginal(room, k) {
      const g = newGame(room.game.startSfen || STARTING_SFEN, ['先手', '後手']);
      const moves = room.game.moves || [];
      for (let i = 0; i < k && i < moves.length; i++) g.applyMove(moves[i]);
      return g.state().sfen;
    },

    /** 推演 Game 实例：起点 SFEN + 重放推演着法（懒重建） */
    _demoGame(room) {
      const demo = room.demo;
      if (!demo._game) {
        const g = newGame(demo.baseSfen, ['先手', '後手']);
        for (const usi of demo.moves) g.applyMove(usi);
        demo._game = g;
      }
      return demo._game;
    },

    /** 推演谱日式记谱（相对起点重放） */
    _refreshDemoKif(room) {
      const demo = room.demo;
      try {
        const { movesToKif } = require('../records');
        demo.kif = movesToKif(demo.baseSfen, demo.moves);
      } catch (_) {
        demo.kif = demo.moves.map((u, i) => `${u}`);
      }
    },

    /** 推演谱第 k 手后的 Game 实例（k ≤ baseIndex 用本谱重放；> baseIndex 叠推演） */
    _demoGameAt(room, k) {
      let g;
      if (k <= room.demo.baseIndex) {
        g = newGame(room.game.startSfen || STARTING_SFEN, ['先手', '後手']);
        const moves = room.game.moves || [];
        for (let i = 0; i < k && i < moves.length; i++) g.applyMove(moves[i]);
      } else {
        g = this._demoGame(room);
        const moves = room.demo.moves;
        for (let i = room.demo.baseIndex; i < k && i < moves.length; i++) g.applyMove(moves[i]);
      }
      return g;
    },

    _broadcastDemo(room, exceptClientId = null) {
      if (!room.demo) return;
      const seat = room.demo.demonstratorSeat;
      const g = this._demoGame(room);
      // §J4：推演终局的**权威局面**。`state()` 顺带给出 board/hands，零额外计算；
      // 前端在「最新一手」用它覆盖本地重放结果，使持驹/盘面漂移不再靠肉眼发现。
      const snap = g.state();
      this._broadcast(room.id, {
        type: 'demo_state',
        data: {
          moves: room.demo.moves,
          kif: room.demo.kif,
          baseIndex: room.demo.baseIndex,
          baseCount: room.demo.baseCount,
          legalMoves: g.legalMovesUsi(),
          legalTargetsBySq: this._legalTargetsMap(g),
          turn: g.turn,
          board: snap.board,
          hands: snap.hands,
          demonstratorSeat: seat || null,
          demonstratorName: seat && room.players[seat] ? room.players[seat].name : null,
        },
      }, exceptClientId);
    },

    /**
     * 进入感想战页：返回该客户端视角的完整载荷（独立感想战页 demo.html 用）。
     * 玩家带座位与演示权；观战者/离开者以旁观身份进入。
     */
    demoEnter(clientId, roomId) {
      const seatInfo = this.clientToPlayer.get(clientId);
      const rid = roomId || (seatInfo ? seatInfo.roomId : this.clientToRoom.get(clientId));
      const room = this._room(rid);
      if (!room) return { ok: false, error: '对局房间不存在（可能已清理，请到棋谱页复盘）' };
      if (room.status !== 'FINISHED') return { ok: false, error: '对局尚未结束' };
      if (!room.demo) this._initDemo(room);
      const demo = room.demo;
      const g = this._demoGame(room);
      // §J4：权威局面（与 `_broadcastDemo` 同口径）——重连或首次进入也能拿到正确持驹
      const snap = g.state();
      const mySeat = seatInfo ? seatInfo.seat : null;
      const { movesToKif } = require('../records');
      const gameKif = movesToKif(room.game.startSfen || STARTING_SFEN, room.game.moves || []);
      return {
        ok: true,
        demo: {
          roomId: room.id,
          mySeat,
          isPlayer: !!mySeat,
          startSfen: room.game.startSfen || STARTING_SFEN,
          gameMoves: room.game.moves || [],
          gameKif,
          moves: demo.moves,
          kif: demo.kif,
          baseIndex: demo.baseIndex,
          baseCount: demo.baseCount,
          legalMoves: g.legalMovesUsi(),
          legalTargetsBySq: this._legalTargetsMap(g),
          turn: g.turn,
          // §J4：权威局面（推演终局），前端在「最新一手」用它覆盖本地重放
          board: snap.board,
          hands: snap.hands,
          demonstratorSeat: demo.demonstratorSeat || null,
          demonstratorName: demo.demonstratorSeat ? (room.players[demo.demonstratorSeat] || {}).name : null,
          names: (room.game.names && room.game.names.length === 2) ? room.game.names : ['先手', '後手'],
          result: room.game.result,
          resultDetail: room.game.resultDetail,
        },
      };
    },

    /** 感想战：按需下发指定手数局面的合法走法（历史手行棋，PLAN §H） */
    demoLegal(clientId, data = {}) {
      const seatInfo = this.clientToPlayer.get(clientId);
      const roomId = seatInfo ? seatInfo.roomId : this.clientToRoom.get(clientId);
      const room = this._room(roomId);
      if (!room) return { ok: false, error: '房间不存在' };
      if (room.status !== 'FINISHED') return { ok: false, error: '对局尚未结束' };
      if (!room.demo) this._initDemo(room);
      const idx = Math.max(0, Math.min(Number(data.index) || 0, room.demo.baseIndex + room.demo.moves.length));
      const g = this._demoGameAt(room, idx);
      return {
        ok: true,
        data: {
          index: idx,
          legalMoves: g.legalMovesUsi(),
          legalTargetsBySq: this._legalTargetsMap(g),
          turn: g.turn,
        },
      };
    },

    /**
     * 感想战演示操作分发（仅 FINISHED 房间）。
     * action: move（演示者按规则行棋）/ undo（待った）/ transfer / claim / reset（清空推演）
     */
    demoAction(clientId, action, data = {}) {
      const seatInfo = this.clientToPlayer.get(clientId);
      const roomId = seatInfo ? seatInfo.roomId : this.clientToRoom.get(clientId);
      const room = this._room(roomId);
      if (!room) return { ok: false, error: '房间不存在' };
      if (room.status !== 'FINISHED') return { ok: false, error: '对局尚未结束' };
      if (!room.demo) this._initDemo(room);
      const demo = room.demo;
      const mySeat = seatInfo ? seatInfo.seat : null; // 观战者为 null
      const isDemo = !!mySeat && demo.demonstratorSeat === mySeat;
      const curName = demo.demonstratorSeat ? (room.players[demo.demonstratorSeat] || {}).name : null;
      switch (action) {
        case 'move': {
          if (!isDemo) return { ok: false, error: curName ? `正在由 ${curName} 演示` : '演示权空闲，请先认领' };
          const usi = String(data.usi || '');
          // 分支：携带 index（在该手之后的局面下行棋）。与既有推演不同 → 截断/重设起点开新分支
          if (Number.isInteger(data.index) && data.index !== demo.baseIndex + demo.moves.length) {
            const idx = Math.max(0, Math.min(data.index, demo.baseCount));
            if (idx <= demo.baseIndex) {
              demo.baseIndex = idx;
              demo.baseSfen = this._sfenAtOriginal(room, idx);
              demo.moves = [];
            } else {
              demo.moves = demo.moves.slice(0, idx - demo.baseIndex);
            }
            demo._game = null;
          }
          const res = this._demoGame(room).applyMove(usi); // 服务端规则校验（含王手过滤）
          if (!res.ok) return { ok: false, error: res.error || '非法走法' };
          demo.moves.push(usi);
          this._refreshDemoKif(room);
          demo.updatedAt = Date.now();
          this._broadcastDemo(room); // 全员回显（含演示者）——客户端统一以服务端回执渲染
          return { ok: true };
        }
        case 'undo': {
          // 待った：优先回退推演手；推演谱为空且起点在本谱内 → 跨界回退本谱一手（PLAN §H）
          if (demo.moves.length) {
            demo.moves.pop();
          } else if (demo.baseIndex > 0) {
            demo.baseIndex -= 1;
            demo.baseSfen = this._sfenAtOriginal(room, demo.baseIndex);
          } else {
            return { ok: false, error: '没有可回退的推演手' };
          }
          demo._game = null; // 强制重建
          this._refreshDemoKif(room);
          demo.updatedAt = Date.now();
          this._broadcastDemo(room); // 全员（含请求方）按新推演谱重绘
          return { ok: true };
        }
        case 'transfer': {
          if (!isDemo) return { ok: false, error: '只有演示者可以交接演示权' };
          demo.demonstratorSeat = mySeat === 'b' ? 'w' : 'b';
          demo.updatedAt = Date.now();
          this._broadcastDemo(room);
          return { ok: true };
        }
        case 'claim': {
          if (!mySeat) return { ok: false, error: '观战者不能获得演示权' };
          if (demo.demonstratorSeat) return { ok: false, error: '演示权已被占用' };
          demo.demonstratorSeat = mySeat;
          demo.updatedAt = Date.now();
          this._broadcastDemo(room);
          return { ok: true };
        }
        case 'reset': {
          if (!isDemo) return { ok: false, error: '只有演示者可以清空推演' };
          demo.baseIndex = demo.baseCount;
          demo.baseSfen = this._sfenAtOriginal(room, demo.baseCount);
          demo.moves = [];
          demo.kif = [];
          demo._game = null;
          demo.updatedAt = Date.now();
          this._broadcastDemo(room); // 全员回到本谱终局
          return { ok: true };
        }
        default:
          return { ok: false, error: '未知演示操作' };
      }
    },
  });
};
