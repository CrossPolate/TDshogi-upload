/**
 * a11y.js — 可访问性（无障碍）基础设施（§6.3，2026-09-28）
 *
 * **范围**：只做「核心操作」的系统性无障碍，不追求全站合规。具体三类：
 *   1. 弹层（dialog）的语义与焦点：`role="dialog"` 在 HTML 里给；本文件负责
 *      **打开时把焦点移进去、关闭时把焦点还给触发者**，并把 `Esc` 接成"关闭"。
 *   2. 键盘可达：核心操作（走子、升降变、弹层按钮）必须能纯键盘完成。
 *   3. 对比度：见 `docs/可访问性走查.md`（静态核算，不在此文件）。
 *
 * **为什么不自己管显隐**：各页显隐机制不同（对局页用 `.show` class、管理页/赛事页用
 * `style.display`）。本文件**只**负责焦点与键盘，显隐仍由各页原逻辑负责——
 * 少一处"两套逻辑打架"的风险。
 *
 * **用法**（打开/关闭弹层时各调一次，紧挨着你原来的显隐代码）：
 *   A11y.onDialogOpen(el, { onClose: () => hideIt() });   // 显示弹层后
 *   A11y.onDialogClose(el);                               // 隐藏弹层后
 *
 * ⚠️ 必须在本文件之前加载的页面脚本之外、**早于**任何调用它的脚本（见各页 `<script>` 顺序）。
 */
(function (global) {
  'use strict';

  /** 已打开的弹层栈（后进先出：Esc 只关最上面那个） */
  const stack = [];

  /** 可聚焦元素选择器（焦点移入时找第一个） */
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * 弹层打开后调用：记住触发者、把焦点移入弹层。
   * @param {HTMLElement} el 弹层根元素（带 role="dialog"）
   * @param {{onClose?: Function}} [opts] onClose：Esc 时调用（应触发该页原本的关闭逻辑）
   */
  function onDialogOpen(el, opts) {
    if (!el) return;
    const o = opts || {};
    // 已在这个栈里就别重复入栈（防重复打开把栈撑乱）
    if (stack.some((d) => d.el === el)) return;
    stack.push({ el, onClose: typeof o.onClose === 'function' ? o.onClose : null, prev: null });
    const top = stack[stack.length - 1];
    top.prev = (global.document && global.document.activeElement) || null;
    el.setAttribute('aria-hidden', 'false');
    // 焦点移入：优先 [autofocus]，否则第一个可聚焦元素，否则容器本身
    const first = el.querySelector('[autofocus]') || el.querySelector(FOCUSABLE);
    const target = first || el;
    if (target && typeof target.focus === 'function') {
      // 容器若不可聚焦，先补一个 tabindex，保证焦点有处可落（屏幕阅读器需要）
      if (target === el && !el.getAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      try { target.focus(); } catch (_) { /* 某些替身环境没有真实焦点，忽略 */ }
    }
  }

  /** 弹层关闭后调用：把焦点还给打开它之前的元素 */
  function onDialogClose(el) {
    if (!el) return;
    const i = stack.findIndex((d) => d.el === el);
    if (i < 0) return;
    const d = stack.splice(i, 1)[0];
    el.setAttribute('aria-hidden', 'true');
    if (d.prev && typeof d.prev.focus === 'function') {
      try { d.prev.focus(); } catch (_) { /* ignore */ }
    }
  }

  /** 当前是否有打开的弹层 */
  function hasOpenDialog() { return stack.length > 0; }

  // Esc 关闭最上层弹层。用**捕获阶段**：即使某个输入框 stopPropagation 也能兜住。
  if (global.document && typeof global.document.addEventListener === 'function') {
    global.document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !stack.length) return;
      const top = stack[stack.length - 1];
      if (top.onClose) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        top.onClose();
      }
    }, true);
  }

  global.A11y = { onDialogOpen, onDialogClose, hasOpenDialog, _stack: stack };
})(typeof window !== 'undefined' ? window : globalThis);
