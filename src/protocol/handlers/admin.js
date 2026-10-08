/**
 * protocol/handlers/admin.js — 管理员登录（§M2 拆分，2026-09-28）
 *
 * 覆盖：admin_login
 *
 * 防爆破（PLAN §Q7）：按 **IP** 计——同一 IP 的多个连接共享额度，比按连接更有效；
 * 登录成功即清零，不影响管理员正常进出。
 */
'use strict';

const admin = require('../../admin');
const ratelimit = require('../../ratelimit');

module.exports = {
  _hAdminLogin(clientId, player, data) {
    const info = this.playerRegistry.get(clientId);
    const key = (info && info.ip) || clientId;
    const rlA = ratelimit.adminLogin.hit(key);
    if (!rlA.allowed) {
      this._error(clientId, `尝试过于频繁，请 ${Math.ceil(rlA.retryAfterMs / 1000)} 秒后再试`);
      return;
    }
    const res = admin.login(data && data.password);
    if (res.ok) {
      ratelimit.adminLogin.reset(key);
      // 记录该连接的管理员 token（存客户端）
      this._send(clientId, { type: 'admin_logged_in', data: { token: res.token } });
    } else {
      this._error(clientId, res.error);
    }
  },
};
