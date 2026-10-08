/**
 * protocol/handlers/tournament.js — 赛事建/报名（§M2 拆分，2026-09-28）
 *
 * 覆盖：create_tournament / join_tournament
 *
 * ⚠️ 建赛的字段**服务端会再校验一遍**（时间自洽性、赛制、人数档位）：
 * 前端校验只防手滑，防不了直接构造 WS 消息的人。
 */
'use strict';

const accounts = require('../../accounts');
const tournaments = require('../../tournaments');

module.exports = {
  _hCreateTournament(clientId, player, data) {
    // B2：创建赛事需要登录正式账号（guestId 为会话令牌且能解析到账号）。
    // 游客 id 是 24 hex，账号 id 在 accounts 表中存在——以此区分。
    if (!accounts.getAccount(player.playerId)) {
      this._error(clientId, '创建赛事需要登录正式账号，请在个人页注册/登录');
      return;
    }
    // T1/T2：透传建赛申请表字段。**服务端会再校验一遍**（时间自洽性、赛制、人数档位），
    // 前端校验只防手滑，防不了直接构造 WS 消息的人。
    const res = tournaments.createTournament(data && data.name, data && data.size,
      { id: player.playerId, name: player.name }, {
        reason: data && data.reason,
        registerStart: data && data.registerStart,
        registerEnd: data && data.registerEnd,
        matchStart: data && data.matchStart,
        matchEnd: data && data.matchEnd,
        format: data && data.format,
        // T8：瑞士制总轮数（不填则服务端按人数给建议值）
        totalRounds: data && data.totalRounds,
        requireApproval: data && data.requireApproval,
      });
    if (res.ok) {
      this._send(clientId, { type: 'tournament_created', data: res.tournament });
    } else {
      this._error(clientId, res.error);
    }
  },

  _hJoinTournament(clientId, player, data) {
    const res = tournaments.joinTournament(data && data.id, { id: player.playerId, name: player.name });
    if (res.ok) {
      // T3：两段式报名——`pending` 表示"只是提交了申请，还没被批准"，
      // 前端据此给不同提示（否则会给用户"已经参赛了"的错觉）。
      this._send(clientId, {
        type: 'tournament_joined',
        data: Object.assign({}, res.tournament, { pending: !!res.pending, started: !!res.started }),
      });
    } else {
      this._error(clientId, res.error);
    }
  },
};
