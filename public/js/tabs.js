/**
 * tabs.js — 通用 Tab 切换（当前用于个人页）
 *
 * 标记约定：
 *   容器   [data-tabs]
 *   按钮   .tab[data-tab="<name>"]
 *   面板   .tab-panel[data-tab="<name>"]
 *
 * 激活钩子：切到 `records` 时调用 `window.RecordsConsole.mount()`（懒挂载，只挂一次）。
 * 初始标签：URL hash（如 `profile.html#records`）—— 支持 history.html 跳转与旧书签深链。
 */
(function () {
  const bar = document.querySelector('[data-tabs]');
  if (!bar) return;
  const tabs = Array.from(bar.querySelectorAll('.tab'));
  const panels = Array.from(document.querySelectorAll('.tab-panel'));
  if (!tabs.length) return;

  const mounted = {};
  const hooks = {
    records: function () { if (window.RecordsConsole) window.RecordsConsole.mount(); },
  };

  function activate(name) {
    if (!tabs.some((t) => t.dataset.tab === name)) return;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
    if (hooks[name] && !mounted[name]) { mounted[name] = true; hooks[name](); }
    // 回写 hash 便于分享/刷新停留在同一标签（replaceState 不污染历史）
    try { if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name); } catch (_) {}
  }

  tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab)));

  const initial = decodeURIComponent((location.hash || '').slice(1));
  activate(initial && tabs.some((t) => t.dataset.tab === initial) ? initial : tabs[0].dataset.tab);

  window.Tabs = { activate };
})();
