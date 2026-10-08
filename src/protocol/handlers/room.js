/**
 * protocol/handlers/room.js — 房间 / 匹配 / 观战类消息（§M2 拆分，2026-09-28）
 *
 * 从 `protocol.js` 的 `_routeInner` switch 里抽出的 case 体，以 **mixin** 形式
 * 注入 `Protocol.prototype`（见 `protocol.js` 末尾的 `Object.assign`）——
 * `this.rooms` / `this._send()` / `this._error()` 调用链完全不变。
 *
 * 覆盖：create_room / join_room / quick_match / cancel_match / leave /
 *       spectate / random_spectate / request_state / join_tournament_match
 *
 * ⚠️ 约定：handler 方法名为 `_h<动作>`，签名统一 `(clientId, player, data)`，
 * 只做「取参数 → 调 rooms → 回执/报错」，**不含业务规则**（规则在 rooms 层）。
 */
'use strict';

/**
 * 统一的失败回执（⚠️ 2026-10-02 体验修复，问题 3/6）。
 *
 * rooms 层返回的 `{ok:false}` 里不只有一句 `error`：它还带着**结构化字段**——
 * `backRoomId`（"回你自己正在进行的那一局"）、`code`（机器可读原因）、
 * `needPassword`（提示补密码）。此前各 handler 一律 `this._error(clientId, res.error)`，
 * 只传文案，结构化字段就地丢掉：前端（`public/js/lobby.js` 明确在读 `data.backRoomId`）
 * 永远拿不到它，于是"匹配失败后转圈不复位""被静默判负后不知道回哪"这类问题反复出现。
 *
 * @param {object} h handler 的 `this`（Protocol 实例）
 * @param {string} clientId
 * @param {object} res rooms 层返回值（含 error / backRoomId / code / needPassword）
 */
function fail(h, clientId, res) {
  const extra = {};
  if (res && res.backRoomId) extra.backRoomId = res.backRoomId;
  if (res && res.code) extra.code = res.code;
  if (res && res.needPassword) extra.needPassword = true;
  h._error(clientId, (res && res.error) || '操作失败', Object.keys(extra).length ? extra : undefined);
}

module.exports = {
  /** create_room：参数校验/建房规则在 `rooms.createRoom`，这里只透传 */
  _hCreateRoom(clientId, player, data) {
    const tc = data && data.timeControl;
    // 私人房间（PLAN §T2）：isPrivate 决定 rated=false（不计 ELO，经验照常加）
    const res = this.rooms.createRoom(player, tc, {
      isPrivate: !!(data && data.isPrivate),
      password: (data && data.password) || '',
      // 駒落ち（让子）手合割 id；空 = 平手。未知 id 由 createRoom 拒绝
      handicap: data && data.handicap,
    });
    if (!res.ok) { fail(this, clientId, res); return; }
    this._send(clientId, { type: 'room_created', data: res });
  },

  _hJoinRoom(clientId, player, data) {
    const res = this.rooms.joinRoom(player, data && data.code, (data && data.password) || '');
    if (res.ok) {
      this._send(clientId, { type: 'room_joined', data: res });
    } else {
      // 私人房间（§T2）「需要密码」、跨连接「已有进行中对局」都是**结构化标志**，
      // 由 `fail()` 统一按需带出（needPassword / backRoomId / code），
      // 前端据此显示密码框或复位 UI——而不是让用户从一句文案里猜该做什么。
      fail(this, clientId, res);
    }
  },

  _hQuickMatch(clientId, player) {
    const res = this.rooms.quickMatch(player);
    if (!res.ok) fail(this, clientId, res);
    else this._send(clientId, { type: 'matching', data: { ok: true } });
  },

  _hCancelMatch(clientId) {
    this.rooms.cancelMatch(clientId);
    this._send(clientId, { type: 'matching', data: { ok: false } });
  },

  _hLeave(clientId) {
    this.rooms.leave(clientId);
    this._send(clientId, { type: 'left' });
  },

  /** spectate：roomId 也可传 6 位房间码；password 用于私人房间观战（PLAN §T2） */
  _hSpectate(clientId, player, data) {
    const res = this.rooms.spectate(clientId, data && (data.roomId || data.code), player.playerId, data && data.password);
    if (res.ok) {
      this._send(clientId, { type: 'spectating', data: { roomId: res.roomId, seat: res.seat || null, rebind: !!res.rebind } });
      const state = this.rooms.getRoomStateForClient(clientId);
      this._send(clientId, { type: 'state', data: state });
    } else {
      fail(this, clientId, res);
    }
  },

  _hRandomSpectate(clientId, player) {
    const res = this.rooms.randomSpectate(clientId, player.playerId);
    if (res.ok) {
      this._send(clientId, { type: 'spectating', data: { roomId: res.roomId, seat: res.seat || null, rebind: !!res.rebind } });
      const state = this.rooms.getRoomStateForClient(clientId);
      this._send(clientId, { type: 'state', data: state });
    } else {
      fail(this, clientId, res);
    }
  },

  /**
   * request_state：断线重连/刷新页面时按需恢复对局。
   *
   * `data.roomId` = 页面 URL 指向的房间：回位优先绑定它（重新匹配后不被旧对局
   * 复盘中房间的断线座位按插入顺序劫持——幽灵房修复）。
   */
  _hRequestState(clientId, player, data) {
    let state = this.rooms.getRoomStateForClient(clientId);
    if (!state) {
      // 断线重连：玩家明确请求状态（request_state）时才尝试恢复对局，
      // 避免观战窗口（同 guestId）误绑玩家座位。
      const wantRoom = data && data.roomId;
      const rec = this.rooms.reconnect(clientId, player.playerId, wantRoom);
      if (rec.ok) {
        state = this.rooms.getRoomStateForClient(clientId);
      } else {
        // 页面跳转竞态兜底：新连接先于旧连接 close 到达时无绑定
        const bound = this.rooms.bindToActiveGame(clientId, player.playerId, wantRoom);
        if (bound && bound.ok) state = this.rooms.getRoomStateForClient(clientId);
      }
    }
    if (state) {
      this._send(clientId, { type: 'state', data: state });
    } else {
      // ⚠️ **必须明确回执**：静默不响应会让前端停在空白页干等（用户只能看到一片白）。
      // 触发场景（2026-09-13 定位）：从大厅点一张"自己是选手"的对局卡片 → 前台不带
      // spectate → 走 request_state → 但该局已结束/房间已销毁 → reconnect /
      // bindToActiveGame 全失败 → 原先这里什么都不发 → 页面全白。这条历史 bug 拖了很久，
      // 就是因为它是**静默**失败：日志里连个错都没有。
      this._send(clientId, { type: 'no_room', data: { roomId: (data && data.roomId) || null } });
    }
  },

  /** join_tournament_match：玩家主动进入自己的赛事对局（建局时可能不在线） */
  _hJoinTournamentMatch(clientId, player, data) {
    const res = this.rooms.joinTournamentMatch(clientId, data && data.roomId, player.playerId);
    if (!res.ok) fail(this, clientId, res);
  },
};
