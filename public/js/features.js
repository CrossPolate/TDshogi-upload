/**
 * features.js — 1.6–1.9 功能开关的前端缓存。
 *
 * 只负责“显示哪些入口”，不是权限：真正的鉴权/开关仍在服务端。
 * 请求失败时保持全部关闭，旧功能不受影响。
 */
(function (global) {
  'use strict';

  const state = {
    loaded: false,
    flags: {},
    features: [],
  };
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function isOn(name) {
    return state.flags[name] === true;
  }

  function all() {
    return Object.assign({}, state.flags);
  }

  function info() {
    return state.features.slice();
  }

  function whenReady(fn) {
    return ready.then(fn);
  }

  async function load() {
    try {
      const res = await fetch('/api/features', { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        state.flags = data.flags || {};
        state.features = Array.isArray(data.features) ? data.features : [];
      }
    } catch (_) {
      // 离线/旧服务端：保持全部关闭
    } finally {
      state.loaded = true;
      resolveReady(state);
      try {
        global.dispatchEvent(new global.CustomEvent('tdshogi-features', { detail: all() }));
      } catch (_) { /* 老浏览器忽略 */ }
    }
  }

  global.FEATURES = { isOn, all, info, ready, whenReady, load, get loaded() { return state.loaded; } };
  load();
})(window);
