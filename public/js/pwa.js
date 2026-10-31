/**
 * pwa.js — 1.7 PWA：注册 Service Worker、更新提示、安装入口。
 * 开关 FEATURE_PWA；不改变普通浏览器行为。
 */
(function (global) {
  'use strict';

  function canInstall() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  }

  function addInstallButton(ev) {
    const actions = document.querySelector('.nav-actions');
    if (!actions || document.getElementById('pwaInstall')) return;
    const btn = document.createElement('button');
    btn.id = 'pwaInstall';
    btn.className = 'theme-toggle';
    btn.type = 'button';
    btn.title = '安装到桌面';
    btn.textContent = '⬇';
    btn.addEventListener('click', async () => {
      try {
        ev.prompt();
        await ev.userChoice;
      } catch (_) {}
      btn.remove();
    });
    actions.appendChild(btn);
  }

  function init() {
    if (!global.FEATURES || !global.FEATURES.isOn('pwa') || !canInstall()) return;
    global.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      addInstallButton(e);
    });
    let started = false;
    async function start() {
      if (started) return;
      started = true;
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        if (reg.waiting && global.UI && global.UI.toast) global.UI.toast('新版本已就绪，重新打开页面生效');
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' && navigator.serviceWorker.controller && global.UI && global.UI.toast) {
              global.UI.toast('新版本已就绪，重新打开页面生效');
            }
          });
        });
      } catch (_) { /* 非 HTTPS / 浏览器限制：静默 */ }
    }
    // FEATURE 开关是异步拉取的，可能在 window load 之后才 ready；不能再只挂 load 监听。
    if (document.readyState === 'complete') start();
    else global.addEventListener('load', start, { once: true });
  }

  if (global.FEATURES && global.FEATURES.ready) global.FEATURES.ready.then(init).catch(() => {});
  else init();
})(window);
