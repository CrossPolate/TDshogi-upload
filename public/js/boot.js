/**
 * boot.js — SPA 外壳启动器（最后加载，等所有 View 注册完）
 *
 * 一次性把「全局单例」装配好：
 *   - 导航栏只渲染一次（nav.renderNav），此后切页仅由 router 更新 active 态；
 *   - 唯一 WebSocket（api.connect）在此建立，页面按需订阅 / 退订；
 *   - 启动路由（Router.start）渲染首屏。
 *
 * 身份变更（多标签改名 / 换头像后 `storage` 事件）：**不整页刷新**，
 * 而是「关旧连接 → 用新身份重连 → 重挂当前 View」（指导方案 §4）。
 */
(function (global) {
  'use strict';

  function boot() {
    const nav = global.NAV;
    const api = global.API;

    // 1) 导航栏渲染一次（返回本机身份；含徽章 / 主题 / 语言按钮）
    let guest = null;
    try { guest = nav && nav.renderNav ? nav.renderNav(null) : null; } catch (e) {
      console.error('[boot] renderNav 失败', e);
    }

    // 2) 唯一 WebSocket
    try {
      if (api && api.connect) api.connect(guest && guest.id);
    } catch (e) { console.error('[boot] WS 连接失败', e); }

    // 3) BGM / 设置的引导交给 sound.js（它自行 DOMContentLoaded 拉轨）
    // 4) 启动路由，渲染首屏
    try {
      if (global.Router && global.Router.start) global.Router.start();
    } catch (e) { console.error('[boot] 路由启动失败', e); }

    // 5) 跨标签变更：设置就地应用；身份变更重连 + 重挂，而非 location.reload()
    window.addEventListener('storage', (e) => {
      if (!e || !e.key) return;
      // 本机身份 / 管理令牌 / 设置 / 语言变更才需处理
      const relevant = e.key === 'tdshogi_guest' || e.key === 'tdshogi_admin_token'
        || e.key === 'tdshogi_settings' || e.key === 'tdshogi_locale';
      if (!relevant) return;
      try {
        // 语言变更（存独立键 tdshogi_locale，不在 tdshogi_settings 里）→ 就地重应用语言
        if (e.key === 'tdshogi_locale') {
          const id = e.newValue || (global.localStorage && global.localStorage.getItem('tdshogi_locale'));
          const cur = global.I18N && global.I18N.current ? global.I18N.current() : null;
          if (id && global.I18N && global.I18N.setLocale && (!cur || cur.id !== id)) global.I18N.setLocale(id);
          return;
        }
        // 主题 / 音乐 / 音效等设置变更：就地应用即可
        if (e.key === 'tdshogi_settings') {
          if (global.Settings && global.Settings.apply) global.Settings.apply();
          return;
        }
        // 身份变更：关旧连接 → 重连 → 重挂当前 View（不刷新文档，BGM 不断）
        if (api && api.reconnectAs) {
          const g = global.NAV && global.NAV.getGuest ? global.NAV.getGuest() : null;
          api.reconnectAs(g && g.id);
        }
        if (global.Router && global.Router.reload) global.Router.reload();
        // 导航徽章刷新
        if (nav && nav.refreshBadge) nav.refreshBadge();
      } catch (err) { console.error('[boot] 身份变更处理失败', err); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
