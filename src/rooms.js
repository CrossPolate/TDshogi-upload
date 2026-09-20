/**
 * rooms.js — 房间 / 匹配 / 对局状态机（服务端核心）· **RoomManager 骨架与 mixin 装配入口**
 *
 * 房间是实时对局的载体：
 *  - code: 6 位房间码（邀请好友）
 *  - game: Game 实例（shogi.js 权威规则）
 *  - players: { b, w } 玩家会话信息
 *  - spectators: 观战者 id 集合
 *
 * 对局状态机：WAITING → PLAYING → FINISHED（将死/投了/超时/离开），支持再来一局。
 * 快速匹配队列：两名玩家即可配对建房。
 * 广播：房间级 fan-out，避免全局广播。
 *
 * ⚠️ **§M1 拆分（2026-09-12）**：本文件由 2056 行拆到 ~230 行，只保留**骨架**
 * （构造 / 房间码 / 房间查找 / 广播 / 统计），其余按职责拆到 `src/rooms/` 下的 mixin：
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `config`   | 时间与超时常量、打子符号表、`initClockState` |
 * | `lifecycle`| 建房 / 加入 / 匹配 / 开局 / 赛事对局 |
 * | `gameplay` | 走子 / 认输 / 宣告 / 聊天 / 判终局 / **结算落盘** / 再来一局 / 离开 |
 * | `binding`  | 观战 / 连接绑定 / 断线回位 |
 * | `state`    | 状态快照、推送、观战名单、系统播报 |
 * | `clock`    | 棋钟 tick（本时 / 读秒 / 超时） |
 * | `cleanup`  | 房间销毁与各类宽限计时 |
 * | `snapshot` | 快照与重启续局 |
 * | `demo`     | 感想战（推演谱 / 演示权 / 历史手） |
 *
 * mixin 以 `Object.assign(X.prototype, {…})` 注入，**`this.*` 调用链完全不变**——
 * 对调用方（`protocol.js` 的 `require('./rooms')`）完全透明。装配见文件末尾。
 */
'use strict';

const tournaments = require('./tournaments'); // 建房工厂注入（见 constructor）

// §M1：时间控制 / 超时常量 / 打子符号表 / `initClockState()` 均在 `rooms/config.js`；
// 本骨架只用到房间码字母表与快照间隔。
const { ROOM_CODE_ALPHABET, SNAPSHOT_INTERVAL_MS } = require('./rooms/config');

class RoomManager {
  constructor(broadcaster) {
    this.broadcaster = broadcaster; // (clientId, payload) => void
    this.rooms = new Map();         // roomId -> room
    this.byCode = new Map();        // code -> roomId
    this.matchQueue = [];           // 快速匹配队列（clientId 数组）
    this.clientToRoom = new Map();  // clientId -> roomId（含观战）
    this.clientToPlayer = new Map();// clientId -> {roomId, seat}
    this.playerToClient = new Map();// playerId -> clientId（当前活跃连接）
    this.spectatorsByRoom = new Map();// roomId -> Set<clientId>
    // §R3：观战者名字缓存（clientId -> name）。
    // 必须单独存：断线走的是 `protocol._onClose` → 它**先**删除 playerRegistry、
    // **再**调用 `_unbindClient()`，那时已查不到名字，只能靠这张表播报「XX 离开观战」。
    this.spectatorNames = new Map();
    // §R5：称号缓存（playerId -> { title, at }）。见 `_playerTitle()` 的说明。
    this._titleCache = new Map();
    // 头像缓存（playerId -> { avatar, at }）。与称号同因：`auth.load()` 是同步读磁盘，
    // 而玩家栏每次走子都要拿对手头像 —— 不缓存就是把 I/O 塞进对局主循环。
    this._avatarCache = new Map();
    this._clockTimers = new Map();  // roomId -> interval
    this._disconnectTimers = new Map(); // roomId -> Map<seat, timer>（断线宽限期）
    // 对局快照定时器（进行中对局定期落盘，重启可恢复）
    this._snapshotTimer = setInterval(() => this._snapshotAll(), SNAPSHOT_INTERVAL_MS);
    // FINISHED 房间定期清理（已结束 5 分钟以上即从内存/byCode 删除）
    // 修复：原先 FINISHED 房间永远留在 rooms Map，导致内存泄漏 + 进行中列表残留
    this._finishedCleanupTimer = setInterval(() => this._cleanupFinished(), 60 * 1000);
    // 赛事建房工厂：供 tournaments 层推进对阵表时创建对局
    tournaments.setMatchFactory((tournamentId, playerIds) =>
      this.createTournamentMatch(tournamentId, playerIds));
  }

  // ==================================================================
  // 工具
  // ==================================================================
  _genRoomCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      }
    } while (this.byCode.has(code));
    return code;
  }

  _room(roomId) {
    return this.rooms.get(roomId);
  }

  _broadcast(roomId, payload, exceptClientId = null) {
    const room = this._room(roomId);
    if (!room) return;
    const ids = new Set();
    if (room.players.b) ids.add(room.players.b.clientId);
    if (room.players.w) ids.add(room.players.w.clientId);
    const specs = this.spectatorsByRoom.get(roomId) || new Set();
    for (const sid of specs) ids.add(sid);
    for (const cid of ids) {
      if (exceptClientId && cid === exceptClientId) continue;
      this.broadcaster(cid, payload);
    }
  }

  _broadcastLobby() {
    // 对战页进行中对局列表、首页统计由 REST 轮询，这里省略
  }

  // `_gameState()`（前端渲染契约的组装）与 `_legalTargetsMap()`（合法目标映射，含打子符号）
  // 已拆到 **rooms/state.js**（§M1）。新增/改动推送字段时请到那边改，并同步检查 play.js 的 render()。

  // ==================================================================
  // 建房 / 加入 / 匹配 / 赛事对局 —— 已拆到 **rooms/lifecycle.js**（§M1）
  // ==================================================================
  // 含 `createRoom` / `joinRoom` / `quickMatch` / `cancelMatch` / `_autoResignAndLeave` /
  // `_autoLeaveFinished` / `_autoLeaveAllRooms` / `_startQuickMatch` / `_startGame` /
  // `createTournamentMatch` / `joinTournamentMatch` / `_playerName` / `_playerTitle` /
  // `updatePlayerName`。

  // `_autoResignAndLeave()`（对局中换玩法 → 自动认输退出）已拆到 **rooms/lifecycle.js**（§M1）。

  // `quickMatch()`（快速匹配队列）与 `cancelMatch()` 已拆到 **rooms/lifecycle.js**（§M1）。

  // `_autoLeaveFinished()` / `_autoLeaveAllRooms()`（旧房间清理，幽灵房修复的成果）
  // 已拆到 **rooms/lifecycle.js**（§M1）。

  // `_abandonRestoredFor()`（放弃僵尸恢复局）已拆到 **rooms/snapshot.js**（§M1）。

  // 房间销毁与宽限计时已拆到 **rooms/cleanup.js**（§M1）：
  // `_dissolveRoom` / `_scheduleWaitingDissolve` / `_clearWaitingTimer` /
  // `_scheduleDisconnectLoss` / `_clearDisconnectTimer` / `dissolveTournamentMatches` /
  // `_cleanupFinished` / `_connectedMemberCount`。

  // ==================================================================
  // 开局 / 赛事对局 —— 已拆到 **rooms/lifecycle.js**（§M1）
  // ==================================================================
  // 含 `_startQuickMatch`（快速匹配建房）/ `_startGame`（正式开局）/ `createTournamentMatch` /
  // `joinTournamentMatch` / `_playerName` / `_playerTitle`（**30s TTL 缓存，别删**：
  // `auth.load()` 是同步读磁盘，而它每步走子都会被 `_gameState()` 调用）。

  // ==================================================================
  // 走子 / 认输 / 宣告 / 聊天 / 结算 / 再来一局 / 离开 —— 已拆到 **rooms/gameplay.js**（§M1）
  // ==================================================================
  // 含 `makeMove` / `resign` / `declareNyugyoku` / `chat` / `_checkGameOver` /
  // `_finalize`（**唯一的落盘出口**：ELO / 经验 / 棋谱 / 赛事回调）/ `rematch` / `leave`。

  // ==================================================================
  // 观战 / 客户端绑定 —— 已拆到 **rooms/binding.js**（§M1）
  // ==================================================================
  // 含 `spectate` / `randomSpectate` / `_bindClient` / `_unbindClient` /
  // `findPendingGame` / `reconnect` / `_findDisconnectedSeat` / `bindToActiveGame`。

  // `_send()`（向单连接发消息）已拆到 **rooms/state.js**（§M1）。

  // `_scheduleDisconnectLoss()`（断线宽限后判负）与 `_clearDisconnectTimer()` 已拆到
  // **rooms/cleanup.js**（§M1）。

  // `updatePlayerName()`（改名同步：更新对局中双方名字并推送）已拆到 **rooms/lifecycle.js**（§M1）。

  // `_pushState()`（按连接逐个推送各自视角的 state）已拆到 **rooms/state.js**（§M1）。

  // ==================================================================
  // 棋钟 —— 已拆到 **rooms/clock.js**（§M1）
  // ==================================================================
  // 含 `_startClock` / `_stopClock` / `_tick`（本时→读秒→时间切れ判负）/ `_clockData`。

  // ==================================================================
  // 断线重连 / 回位 —— 已拆到 **rooms/binding.js**（§M1）
  // ==================================================================
  // 含 `findPendingGame` / `reconnect` / `_findDisconnectedSeat` / `bindToActiveGame`；
  // `preferRoomId`（URL 指向的房间）优先，修复「重新匹配后被旧复盘的断线座位抢先绑定」的幽灵房问题。

  // ==================================================================
  // 列表 / 信息 —— 已拆到 **rooms/state.js**（§M1）
  // ==================================================================
  // 含 `activeGames()`（大厅对局列表）/ `spectatorCount()`（观战人数去重）/
  // `getRoomStateForClient()`（该连接的房间快照）。

  // ==================================================================
  // 对局快照 / 重启恢复 —— 已拆到 **rooms/snapshot.js**（§M1）
  // ==================================================================
  // 该模块含：`_abandonRestoredFor` / `_serializeRoom` / `_snapshotRoom` /
  // `_snapshotAll` / `_clearSnapshot` / `restoreSnapshots` / `_restoreRoom`。

  // `dissolveTournamentMatches()`（管理员取消赛事 → 解散其全部对局房间）已拆到
  // **rooms/cleanup.js**（§M1）。

  // ==================================================================
  // 观战名单 / 系统播报 —— 已拆到 **rooms/state.js**（§M1）
  // ==================================================================
  // 该模块含 `_spectatorList` / `_spectatorNames` / `_broadcastSpectators` /
  // `_sysChat`（观众进出播报）/ `_specName`（显示名）/ `_hostSeat`（房主座位）。

  // `_sysChat()`（系统播报）/ `_specName()`（观战者显示名）/ `_hostSeat()`（房主座位）
  // 已拆到 **rooms/state.js**（§M1）。

  // ==================================================================
  // 感想战（PLAN §G v4）：推演谱 / 演示权 / 历史手 —— 已拆到 **rooms/demo.js**（§M1）
  // ==================================================================
  // 9 个方法（_initDemo / _sfenAtOriginal / _demoGame / _refreshDemoKif / _demoGameAt /
  // _broadcastDemo / demoEnter / demoLegal / demoAction）由 `require('./rooms/demo')`
  // 注入本类 prototype，`this.*` 调用链完全不变（装配见文件末尾）。

  // `_cleanupFinished()`（每分钟巡检：无连接房间给缓冲后回收、FINISHED 房间按 TTL 回收）
  // 与 `_connectedMemberCount()` 已拆到 **rooms/cleanup.js**（§M1）。

  // `restoreSnapshots()` 与 `_restoreRoom()`（重启续局 + 恢复局自愈）已拆到
  // **rooms/snapshot.js**（§M1）。

  /**
   * 房间维度统计。
   *
   * ⚠️ 这里**刻意不返回 `online`**（PLAN §T1）：在线人数必须按「唯一身份数」计算，
   * 而本层只看得到 `clientToRoom`（已绑定房间的连接）——既漏掉大厅/观战等未进房的连接，
   * 又会把同一人的多个标签页重复计入。原公式
   * `rooms.size + (clientToRoom.size - rooms.size)` 恒等于 `clientToRoom.size`，本身就是错的。
   * 在线口径统一由 `protocol._stats()` 提供，**只此一处**。
   */
  stats() {
    return {
      playing: [...this.rooms.values()].filter((r) => r.status === 'PLAYING').length,
      reviewing: [...this.rooms.values()].filter((r) => r.status === 'FINISHED' && r.demo).length,
      waiting: [...this.rooms.values()].filter((r) => r.status === 'WAITING').length,
      matching: this.matchQueue.length,
      totalGames: this.rooms.size,
    };
  }
}

// ==================================================================
// mixin 装配（PLAN §M1）
// ==================================================================
// 拆出去的模块把方法挂到 `RoomManager.prototype` 上（`this.*` 调用链**完全不变**），
// 因此对调用方（`protocol.js` 的 `require('./rooms')`）完全透明——它拿到的仍是同一个 `{ RoomManager }`。
// 逐个文件搬运，每搬一块都可独立验证（方法个数 + 名字必须与拆分前一致）。
require('./rooms/demo')(RoomManager);
require('./rooms/snapshot')(RoomManager);
require('./rooms/clock')(RoomManager);
require('./rooms/state')(RoomManager);
require('./rooms/binding')(RoomManager);
require('./rooms/cleanup')(RoomManager);
require('./rooms/gameplay')(RoomManager);
require('./rooms/lifecycle')(RoomManager);

module.exports = { RoomManager };
