/**
 * protocol/handlers/game.js — 对局内动作与感想战演示（§M2 拆分，2026-09-28）
 *
 * 覆盖：move / resign / declare_nyugyoku / rematch / demo_*（演示行棋）
 *
 * 规则判定全在 `rooms` 层（shogi.js 权威引擎），这里只负责「转发 + 错误回执」。
 * mixin 注入见 `protocol.js` 末尾。
 */
'use strict';

module.exports = {
  _hMove(clientId, player, data) {
    const res = this.rooms.makeMove(clientId, data && data.usi);
    if (!res.ok) this._error(clientId, res.error || '走子失败');
  },

  _hResign(clientId) {
    const res = this.rooms.resign(clientId);
    if (!res.ok) this._error(clientId, res.error);
  },

  /** 入玉宣言（PLAN §P1 R-d）：玩家申请，服务端按 AJSA 规则权威判定 */
  _hDeclareNyugyoku(clientId) {
    const res = this.rooms.declareNyugyoku(clientId);
    if (!res.ok) this._error(clientId, res.error);
  },

  _hRematch(clientId) {
    // ⚠️ 2026-10-02 审查 P2-3：rematch 会失败（不在对局中 / 对局未结束），必须回执，
    // 否则前端「再来一局」点了没反应、且无任何提示。
    const res = this.rooms.rematch(clientId);
    if (!res.ok) this._error(clientId, res.error || '无法再来一局');
  },

  /** 感想战演示行棋（PLAN §G）：move / undo / transfer / claim / reset 共用一条 */
  _hDemoAction(clientId, type, data) {
    const res = this.rooms.demoAction(clientId, type.replace('demo_', ''), data || {});
    if (!res.ok) this._error(clientId, res.error);
  },

  /** 感想战历史手合法走法按需下发（任意历史手行棋，PLAN §H） */
  _hDemoLegal(clientId, data) {
    const res = this.rooms.demoLegal(clientId, data || {});
    // ⚠️ 2026-10-02 审查 P2-4：失败也要回执，否则前端永久等待合法目标高亮。
    if (res.ok) this._send(clientId, { type: 'demo_legal', data: res.data });
    else this._error(clientId, res.error || '无法获取合法走法');
  },

  /** 进入感想战页：下发该客户端视角的完整载荷（demo_init） */
  _hDemoEnter(clientId, data) {
    const res = this.rooms.demoEnter(clientId, data && data.roomId);
    if (!res.ok) this._error(clientId, res.error);
    else this._send(clientId, { type: 'demo_init', data: res.demo });
  },
};
