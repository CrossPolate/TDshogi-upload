/**
 * protocol/handlers/social.js — 身份 / 头像 / 聊天 / 举报 / 棋谱检索（§M2 拆分，2026-09-28）
 *
 * 覆盖：rename / set_avatar / chat / report / record_search
 *
 * 三条身份相关的安全约定（别改坏）：
 *  - rename / set_avatar 都走**会话文件**（游客也能改名换头像）+ 校验 `player.key`
 *    （B1 持有证明：只有握手时出示过 secret 的连接才能改）；
 *  - record_search 的**身份只认握手 identify() 的结果**，客户端传的 playerId 一律忽略
 *    （游客 id 在大厅/观战页是公开的，按客户端传值查即可枚举他人棋谱）。
 */
'use strict';

const auth = require('../../auth');
const reports = require('../../reports');
const { searchRecords } = require('../../records');

module.exports = {
  _hRename(clientId, player, data) {
    const res = auth.rename(player.playerId, data && data.name, player.key);
    if (!res.ok) { this._error(clientId, res.error); return; }
    player.name = res.name;
    const info = this.playerRegistry.get(clientId);
    if (info) info.name = res.name;
    this._send(clientId, { type: 'renamed', data: { name: res.name } });
    // 同步进行中对局里该玩家的名字（对手即时看到新名）
    this.rooms.updatePlayerName(player.playerId, res.name);
    this._broadcastStats();
  },

  /**
   * set_avatar（2026-09-20）：与改名同款，走**会话文件**——游客也能换头像，
   * 不必为了换个头像去注册账号。白名单校验在 `auth.setAvatar` 里。
   */
  _hSetAvatar(clientId, player, data) {
    // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 把「已拥有的头像道具字形」并入白名单。
    // accountId 取本连接身份 id（player.playerId）；游客 id 查不到 → 只返回免费字形集合，行为不变。
    // 整段 try/catch 容错：items 出错时退回只传原 3 参，绝不因道具系统拖垮换头像。
    let res;
    try {
      const items = require('../../items');
      res = auth.setAvatar(player.playerId, data && data.avatar, player.key, items.avatarOptionsFor(player.playerId));
    } catch (_) {
      res = auth.setAvatar(player.playerId, data && data.avatar, player.key);
    }
    if (!res.ok) { this._error(clientId, res.error); return; }
    player.avatar = res.avatar;
    this._send(clientId, { type: 'avatar_updated', data: { avatar: res.avatar } });
    // 进行中的对局要**立刻**生效：清掉房间侧的头像缓存并重推 state
    this.rooms.refreshAvatar(player.playerId);
  },

  /** 房间聊天（玩家 / 观战者） */
  _hChat(clientId, player, data) {
    const res = this.rooms.chat(clientId, data && data.text);
    if (!res.ok) this._error(clientId, res.error);
  },

  /**
   * 举报（2026-09-20）：`targetId` 由客户端给（对局页就是对面座位），
   * 但**被举报人的显示名由服务端查会话**——不信客户端传的名字，
   * 否则举报记录里的"被举报人"可以被伪造成任意人。
   */
  _hReport(clientId, player, data) {
    const rp = reports.submit({
      byId: player.playerId,
      byName: player.name,
      targetId: data && data.targetId,
      targetName: data && data.targetName,
      category: data && data.category,
      detail: data && data.detail,
      context: data && data.context,
    });
    if (rp.ok) this._send(clientId, { type: 'reported', data: { id: rp.report.id } });
    else this._error(clientId, rp.error);
  },

  /**
   * 棋谱检索（PLAN §Q7）：**身份只认握手时 identify() 的结果**，客户端传的
   * playerId 一律忽略（见文件头说明）。
   */
  _hRecordSearch(clientId, player, data) {
    const d = data || {};
    const asInt = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const q = {
      playerId: player.playerId,
      query: typeof d.query === 'string' && d.query.trim() ? d.query.trim() : undefined,
      opening: typeof d.opening === 'string' && d.opening.trim() ? d.opening.trim() : undefined,
      result: (d.result === 'b' || d.result === 'w' || d.result === '-') ? d.result : undefined,
      movesMin: asInt(d.movesMin),
      movesMax: asInt(d.movesMax),
      limit: Math.min(Math.max(asInt(d.limit) || 100, 1), 200),
    };
    this._send(clientId, { type: 'record_search_result', data: { records: searchRecords(q) } });
  },
};
