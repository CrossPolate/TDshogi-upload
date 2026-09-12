/**
 * util.js — 跨页面公共工具（PLAN §M5 附带的收敛）
 *
 * 此前这三段代码被**逐字复制**到各个页面脚本里：
 *   - `$`      3 份（home / play / play-clock）
 *   - `esc`   10 份（lobby / tournaments / hovercard / home / history / review /
 *                    gallery / profile（**同一文件里还定义了两次**）/ admin）
 *   - `toast`  8 份（连 `2500` 这个提示时长都硬编码了 8 次）
 *
 * 重复本身还不是最要紧的——**`esc` 是 XSS 防护函数**才是关键。它被抄了 10 份，意味着
 * 哪天要补一个转义字符（比如单引号），你得改 10 个地方，**漏掉一个就是那个页面的 XSS 漏洞**，
 * 而且不会有任何报错、页面照常工作，只是安静地等一个恶意昵称。收敛为唯一实现后，
 * 这类「改一处漏九处」的风险从结构上消失。
 *
 * 用法：各页面删掉原来的本地定义，换成一行绑定——**所有调用点一行都不用改**：
 *   const { $, esc, toast } = window.UI;
 *
 * ⚠️ 加载顺序：必须早于 `nav.js` 与所有页面脚本（它们都会用到这些函数）。
 *
 * 另外还暴露 **`window.debugLog`**（前端调试日志，PLAN §P4 的对等物；也挂在 `window.UI.debugLog`），
 * 默认关闭、关闭时零开销——开关与用法见文件末尾的说明。
 */
(function (global) {
  'use strict';

  /** 取元素：`$('id')` → `document.getElementById('id')` */
  function $(id) { return document.getElementById(id); }

  /** HTML 转义（防 XSS）：用于所有拼接进 innerHTML 的动态文本 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));
  }

  /**
   * 轻提示：写入 `#toast` 并显示 2.5 秒。
   * 找不到 `#toast` 时静默返回（原各份实现会直接抛错——提示失败不该拖垮整页逻辑）。
   */
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ==================================================================
  // 调试日志（PLAN §P4 的前端对等物）
  //
  // **为什么需要**：前端此前只有 `console.error`，没有任何「可开关的调试输出」。
  // 排查「这手为什么没渲染」「视角为什么没翻」只能临时插 `console.log`、改完再删——
  // 刷新一次就没了，而且生产环境还会留噪音。这里给它一个统一、可控、可留痕的出口。
  //
  // **开关**（任一命中即开启；关闭时**零输出、零开销**，函数第一行就 return）：
  //   1. URL 带 `?debug=1`     —— 排障时直接甩一个链接给用户，最快
  //   2. `localStorage.tdshogi_debug === '1'` —— 持久开关（`debugLog.enable()` 会写入）
  //   3. `window.TDSHOGI_DEBUG = true` —— 脚本里预置（自动化测试用）
  //
  // 刻意**不放进设置面板**：那是「用户偏好」，而这是「排障开关」，
  // 混进去只会让普通用户多一个不该点的选项。
  //
  // 用法：
  //   debugLog('play', 'state 到达', state);      // 生产静默，开启后带时间戳输出
  //   debugLog('board', '渲染耗时', ms, 'ms');
  //   debugLog.enable();                          // 控制台里随时打开，无需改代码
  //   debugLog.dump();                            // 取出最近 200 条（用户报障时可整段复制）
  //
  // ⚠️ 别往里丢敏感数据（token / 密码）：开启后它会原样打到控制台并留在环形缓冲里。
  // ==================================================================
  const DEBUG_KEY = 'tdshogi_debug';
  const DEBUG_RING_MAX = 200;

  function readDebugSwitch() {
    if (global.TDSHOGI_DEBUG === true) return true;
    try {
      // URLSearchParams 在极老浏览器上可能不存在，用 try 兜住（排障工具不该拖垮页面）
      const q = new URLSearchParams((global.location && global.location.search) || '');
      const v = q.get('debug');
      if (v === '1' || v === 'true') return true;
    } catch (_) { /* 忽略：退化成其余开关 */ }
    try {
      if (global.localStorage && global.localStorage.getItem(DEBUG_KEY) === '1') return true;
    } catch (_) { /* 隐私模式下 localStorage 可能直接抛错 */ }
    return false;
  }

  let debugOn = readDebugSwitch();
  const debugRing = [];

  /** `HH:mm:ss.SSS`——与服务端 text 日志**同格式**，两端口志可以对着看 */
  function debugStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  /** 把参数压成一行文本（仅供 dump 留痕；输出到 console 时仍是原始对象，可展开） */
  function debugJoin(args) {
    return args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
  }

  /**
   * 调试日志。关闭时**零开销**（第一行即返回，不构造字符串、不入缓冲）。
   * @param {string} scope 模块名（play / board / clock / api …），与服务端 logger 的 scope 同义
   * @param {...*} args 原样透传给 console（**不做 stringify**，保留控制台展开对象的能力）
   */
  function debugLog(scope) {
    if (!debugOn) return;
    const args = Array.prototype.slice.call(arguments, 1);
    const head = `${debugStamp()} DEBUG [${scope}]`;
    if (debugRing.length >= DEBUG_RING_MAX) debugRing.shift();
    debugRing.push(`${head} ${debugJoin(args)}`);
    if (global.console && global.console.log) {
      global.console.log.apply(global.console, [head].concat(args));
    }
  }

  /** 打开调试日志（并记住，刷新后仍生效） */
  debugLog.enable = function () {
    debugOn = true;
    try { global.localStorage.setItem(DEBUG_KEY, '1'); } catch (_) { /* 存不下也无所谓 */ }
    if (global.console && global.console.log) {
      global.console.log('[debugLog] 已开启。关闭：debugLog.disable()；导出最近日志：debugLog.dump()');
    }
  };

  /** 关闭调试日志（并清掉持久标记） */
  debugLog.disable = function () {
    debugOn = false;
    try { global.localStorage.removeItem(DEBUG_KEY); } catch (_) { /* 忽略 */ }
  };

  debugLog.isOn = function () { return debugOn; };

  /** 重新按「URL / localStorage」判定开关（`?debug=1` 是页面加载时读的，改 URL 后调它） */
  debugLog.refresh = function () { debugOn = readDebugSwitch(); return debugOn; };

  /** 取出最近记录（环形缓冲，上限 200 条）。用户报障时可整段复制给开发者 */
  debugLog.dump = function () { return debugRing.slice(); };

  debugLog.clear = function () { debugRing.length = 0; };

  // ==================================================================
  // 对局结果文案（PLAN §M5：原先 history.js 与 review.js 各有一份）
  // ==================================================================
  // 两份实现语义相同、签名不同：一份要 `{text, cls}` 给列表着色，一份只要纯文本。
  // 合并为一个函数、用 options 区分——**「谁赢了」这条规则只维护一处**，
  // 否则将来加新结果说明（時間切れ / 入玉宣言 / 反则负…）很容易只改一边、另一页显示成"未完成"。
  //
  //   UI.resultText(r)                      → '先手 胜'
  //   UI.resultText(r, { names })           → 用指定双方名（缺省用 r.names）
  //   UI.resultText(r, { withClass: true }) → { text, cls }（列表着色用）
  function resultText(r, opts) {
    const o = opts || {};
    const n = o.names || r.names || ['先手', '後手'];
    let text;
    if (r.result === 'b') text = `${n[0]} 胜`;
    else if (r.result === 'w') text = `${n[1]} 胜`;
    else if (r.result === '-') text = r.resultDetail || '和棋';
    else text = '未完成';
    if (!o.withClass) return text;
    return { text, cls: (r.result === 'b' || r.result === 'w') ? 'result-win' : 'result-draw' };
  }

  global.debugLog = debugLog;
  global.UI = { $, esc, toast, debugLog, resultText };
})(window);
