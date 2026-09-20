/**
 * api.js — WS / REST 封装
 *
 * 提供：
 *  - WS 连接管理（自动重连、断线 60 秒内恢复）
 *  - 消息发送（send）
 *  - 事件订阅（on(type, handler)）
 *  - REST 请求工具（get/post）
 *
 * WS 路径：ws(s)://host/ws?guest=<guestId>
 */
(function (global) {
  class Client {
    constructor() {
      this.ws = null;
      this.handlers = {};   // type -> [fn]
      this.reconnectTimer = null;
      this.connected = false;
      this.messageQueue = [];
      this.reconnectAttempts = 0;
    }

    connect(guestId) {
      if (this.ws && this.ws.readyState === 1) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?guest=${encodeURIComponent(guestId)}`;
      try {
        this.ws = new WebSocket(url);
      } catch (_) { return; }
      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        // 清空积压消息
        const q = this.messageQueue;
        this.messageQueue = [];
        q.forEach((m) => this.send(m));
        this.emit('open');
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        // hello 携带服务端 identify() 的权威身份/名字 → 记下 playerId（大厅判断
        // 「进行中对局」里哪些是自己对局用，服务端 guestId 对账号用户≠playerId），
        // 并把权威名字写回 localStorage/导航，解决客户端与服务端名字不一致的混乱
        if (msg.type === 'hello' && msg.data) {
          if (msg.data.playerId) this.playerId = msg.data.playerId;
          // 等级与特权（2026-09-20）：服务端在 hello 里下发，各页面直接用，
          // 避免每个页面各自再查一次 profile
          if (msg.data.level != null) this.level = msg.data.level;
          if (msg.data.privileges) this.privileges = msg.data.privileges;
          // 手合割（駒落ち让子）：缓存下来供页面随时取用 —— `hello` 可能在本页注册
          // `on('hello')` 之前就已到达，只靠监听器会拿到空列表（下拉框是空的）
          if (msg.data.handicaps) this.handicaps = msg.data.handicaps;
          // 头像与可选白名单（2026-09-20）：白名单由服务端下发，前端不另抄一份
          if (msg.data.avatar && global.NAV && global.NAV.updateAvatar) {
            try { global.NAV.updateAvatar(msg.data.avatar); } catch (_) {}
          }
          if (msg.data.avatars) this.avatars = msg.data.avatars;
          if (msg.data.name && global.NAV && global.NAV.updateUserName) {
            try { global.NAV.updateUserName(msg.data.name); } catch (_) {}
          }
        }
        this.emit(msg.type, msg.data, msg);
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.emit('close');
        this.scheduleReconnect(guestId);
      };
      this.ws.onerror = () => { this.emit('error'); };
    }

    scheduleReconnect(guestId) {
      clearTimeout(this.reconnectTimer);
      this.reconnectAttempts++;
      // 指数退避，上限 10 秒
      const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
      this.reconnectTimer = setTimeout(() => this.connect(guestId), delay);
    }

    isConnected() { return this.connected; }

    send(msg) {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(msg));
      } else {
        this.messageQueue.push(msg);
      }
    }

    on(type, fn) {
      if (!this.handlers[type]) this.handlers[type] = [];
      this.handlers[type].push(fn);
      return () => this.off(type, fn);
    }

    off(type, fn) {
      const arr = this.handlers[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }

    emit(type, data, raw) {
      (this.handlers[type] || []).slice().forEach((fn) => {
        try { fn(data, raw); } catch (e) { console.error('[api] handler error', type, e); }
      });
    }
  }

  // REST 工具
  async function get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * 带身份的 POST（2026-09-13）——用于**管理类**写操作（赛事审批等）。
   *
   * ⚠️ 身份走 **token 头**，不是 `?player=<id>` 查询参数：
   * 后者是公开查询用的宽松通道，任何人都能填别人的 id，拿它做鉴权等于没有鉴权。
   * ⚠️ 这里**不做权限判断**。客户端"隐藏按钮"只是体验，可被绕过——
   * 真正的拦截在服务端（赛事是 `tournaments.canManage()`），未授权一律 403。
   *
   * @param {string} path
   * @param {object} [body]
   * @param {string} [accountToken] 账号会话令牌（通常是 `guest.id`）
   */
  async function postAuthed(path, body, accountToken) {
    const h = { 'Content-Type': 'application/json' };
    if (accountToken) h['x-account-token'] = accountToken;
    try {
      const at = localStorage.getItem(window.NAV && window.NAV.ADMIN_KEY);
      if (at) h['x-admin-token'] = at;
    } catch (_) { /* 隐私模式读不到存储：当作没有管理员身份 */ }

    const res = await fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await res.json(); } catch (_) { /* 非 JSON 响应（如 502 网关页） */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // 全局单例
  global.API = new Client();
  global.ApiUtils = { get, post, postAuthed };
})(window);
