/**
 * tabs.js — 通用 Tab 切换（profile 页子模块）
 *
 * 标记约定：
 *   容器   [data-tabs]
 *   按钮   .tab[data-tab="<name>"]
 *   面板   .tab-panel[data-tab="<name>"]
 *
 * SPA 迁移（2026-10-09）：从「加载即自启的 IIFE」改为**被 profile 的 mount/unmount 驱动**的
 * 函数集合（导出 `window.ProfileParts.Tabs`），**绝不自启**——
 *   - `mount(opts)`  由 profile.mount 调用：绑定点击、按 opts.initial 激活初始标签。
 *     opts.hooks（name → fn）是标签激活钩子（如 records → RecordsConsole.mount()，懒挂载）。
 *   - `activate(name)` 切换标签（保留导出，便于外部按需切换）。
 *   - `destroy()`    由 profile.unmount 调用：解绑全部监听、清空懒挂载记录，零残留。
 *
 * 初始标签：由 profile 从 params.tab（router 已把 history.html / #records 映射为 tab=records）
 * 解析后传入；hash 回写保留（replaceState 不污染历史，便于分享/刷新停留在同一标签）。
 */
(function (global) {
  'use strict';

  let bar = null;
  let tabs = [];
  let panels = [];
  let hooks = {};
  const mountedHooks = {};   // 懒挂载记录：每个 hook 只跑一次
  let teardown = [];

  function activate(name) {
    if (!tabs.some((t) => t.dataset.tab === name)) return;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
    if (hooks[name] && !mountedHooks[name]) { mountedHooks[name] = true; hooks[name](); }
    // 回写 hash 便于分享/刷新停留在同一标签（replaceState 不污染历史）
    try { if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name); } catch (_) {}
  }

  /**
   * 挂载标签栏。幂等：重复调用先拆旧的再绑新的；容器不在则静默不做。
   * @param {{initial?:string, hooks?:Object<string,function>}} [opts]
   */
  function mount(opts) {
    destroy();
    opts = opts || {};
    bar = document.querySelector('[data-tabs]');
    if (!bar) return;
    tabs = Array.from(bar.querySelectorAll('.tab'));
    panels = Array.from(document.querySelectorAll('.tab-panel'));
    if (!tabs.length) return;
    hooks = opts.hooks || {};

    tabs.forEach((t) => {
      const handler = () => activate(t.dataset.tab);
      t.addEventListener('click', handler);
      teardown.push(() => t.removeEventListener('click', handler));
    });

    const initial = opts.initial && tabs.some((t) => t.dataset.tab === opts.initial)
      ? opts.initial
      : tabs[0].dataset.tab;
    activate(initial);
  }

  /** 拆除：由 profile.unmount 调用（监听全解、懒挂载记录清空） */
  function destroy() {
    teardown.forEach((fn) => { try { fn(); } catch (_) {} });
    teardown = [];
    bar = null;
    tabs = [];
    panels = [];
    hooks = {};
    for (const k of Object.keys(mountedHooks)) delete mountedHooks[k];
  }

  global.ProfileParts = global.ProfileParts || {};
  global.ProfileParts.Tabs = { mount, activate, destroy };
})(window);
