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

  /**
   * HTML 转义（防 XSS）：用于所有拼接进 innerHTML 的动态文本。
   *
   * ⚠️ 必须**同时转义单引号**（2026-09-21 安全审查 P1-3）：
   * 只转 `& < > "` 时，凡是把值拼进**单引号属性**（如 `onclick="f('<id>')"`）的地方，
   * 一个 `'` 就能逃出属性 → 存储型 XSS。审查实测：游客改名 `');alert()//`
   * （12 字符，恰好通过长度校验）→ 管理员点该用户任一按钮即以管理员身份执行脚本。
   */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * 轻提示：写入 `#toast` 并显示 2.5 秒。
   * 找不到 `#toast` 时静默返回（原各份实现会直接抛错——提示失败不该拖垮整页逻辑）。
   */
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    // 多语言（PLAN §Z5）：这里是**所有提示的必经之路**（含服务端下发的错误文案），
    // 所以词典里补一条就能翻一条，不必去改服务端。
    // ⚠️ 带变量的句子（如「已批准 3 人」）查不到整句，需要在调用点用 `t('已批准 {n} 人', {n})`。
    el.textContent = window.I18N ? window.I18N.t(msg) : msg;
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

  // ==================================================================
  // 列表分页（前台通用，2026-09-13）
  // ==================================================================
  /**
   * 把「全量数组 + 当前页」切成该页数据，并把分页条渲染进容器。
   *
   * 为什么放 util.js：棋谱页 / 赛事页 / 管理后台都要分页——
   * **同一份翻页逻辑抄三遍，迟早只改两处**（`resultText` 当年的重复就是这么来的）。
   *
   * 只做「切片 + 渲染分页条」，**不碰业务列表的渲染**：调用方拿到 `slice` 自己画。
   * 翻页按钮走 `addEventListener` 而非 inline onclick —— 分页条里不该出现拼接的字符串事件。
   *
   * @param {object} o
   * @param {Array}  o.items              全量数据
   * @param {number} [o.page=1]           当前页（1 起；越界会**自动夹回**合法范围）
   * @param {number} [o.size=20]          每页条数
   * @param {Element|string} [o.container] 分页条容器（元素或 id；省略则只切片不渲染）
   * @param {(page:number)=>void} [o.onPage] 翻页回调
   * @returns {{slice:Array, page:number, totalPages:number, total:number}}
   */
  function paginate(o) {
    const opts = o || {};
    const items = opts.items || [];
    const size = Math.max(1, opts.size || 20);
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    // 页码夹回合法范围：检索后数据变少时不该停在空页上（表现为「一片空白但没说为什么」）
    const page = Math.min(Math.max(1, opts.page || 1), totalPages);
    const slice = items.slice((page - 1) * size, page * size);

    const box = typeof opts.container === 'string'
      ? document.getElementById(opts.container)
      : opts.container;
    if (box) {
      const info = '<span style="font-size:12px;color:var(--text-dim);">';
      if (totalPages <= 1) {
        box.innerHTML = total ? `${info}共 ${total} 条</span>` : '';
      } else {
        box.innerHTML =
          `<button class="btn btn-ghost btn-sm" data-pg="${page - 1}"${page <= 1 ? ' disabled' : ''}>上一页</button>` +
          `${info}第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>` +
          `<button class="btn btn-ghost btn-sm" data-pg="${page + 1}"${page >= totalPages ? ' disabled' : ''}>下一页</button>`;
        if (typeof opts.onPage === 'function') {
          Array.prototype.forEach.call(box.querySelectorAll('button[data-pg]'), (btn) => {
            btn.addEventListener('click', () => {
              if (btn.disabled) return;
              opts.onPage(Number(btn.getAttribute('data-pg')));
            });
          });
        }
      }
    }
    return { slice, page, totalPages, total };
  }

  // ==================================================================
  // 赛事对阵图（2026-09-13：列表页与详情页共用）
  // ==================================================================
  /**
   * 把满二叉树形态的 `bracket` 按层级分列画出来。
   *
   * 为什么放 util.js：列表页与详情页要画**同一棵树**——
   * 抄两份的结果必然是一边修了另一边没修（`resultText` 的老教训）。
   *
   * @param {object} t 赛事（`publicInfo` 形态：需 size / bracket / players）
   * @param {object} [o]
   * @param {string}  [o.myId]     自己的玩家 id → 高亮并给「进入对局」
   * @param {boolean} [o.detail]   详情页模式：把「空位 / 轮空」也标出来
   * @returns {string} HTML 片段；无对阵表时返回空串
   */
  function bracketHtml(t, o) {
    const opts = o || {};
    const nodes = (t && t.bracket) || [];
    if (!nodes.length) return '';

    // 参赛者名字：开赛后看 players；轮空位在 players 里没有，用 pair 递归不上溯，
    // 所以这里以 players 为准、entrants 兜底（详情页在报名阶段也能显示名字）。
    const nameOf = (id) => {
      if (!id) return null;
      const p = (t.players || []).find((x) => x.id === id)
        || (t.entrants || []).find((x) => x.id === id);
      return p ? p.name : null;
    };

    // 满二叉树按层切：第 d 层起点 2^d - 1、个数 2^d
    const depth = Math.round(Math.log2(t.size || nodes.length + 1));
    const levels = [];
    for (let d = 0; d <= depth; d++) {
      const start = Math.pow(2, d) - 1;
      levels.push(nodes.slice(start, start + Math.pow(2, d)));
    }

    const cols = levels.map((levelNodes) => {
      const cells = levelNodes.map((n) => {
        const isLeaf = !n.pair;
        const inMatch = !!(n.matchId && n.players);
        const p1 = inMatch ? nameOf(n.players[0]) : null;
        const p2 = inMatch ? nameOf(n.players[1]) : null;
        const winnerName = nameOf(n.winnerId);
        const mine = opts.myId && inMatch && n.players.indexOf(opts.myId) >= 0;

        let body;
        if (inMatch) {
          const tag = mine
            ? `<a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(n.matchId)}&join=1" style="margin-top:6px;">进入对局</a>`
            : '<div style="font-size:11px;color:var(--gold-light);margin-top:6px;">对局进行中</div>';
          body = `<div class="p">${esc(p1 || '?')} vs ${esc(p2 || '?')}</div>${tag}`;
        } else if (winnerName) {
          body = `<div class="p winner">${esc(winnerName)} 晋级</div>`;
        } else if (isLeaf) {
          const nm = n.name || nameOf(n.playerId);
          body = nm
            ? `<div class="p"${n.playerId ? ` data-player-id="${esc(n.playerId)}"` : ''}>${esc(nm)}</div>`
            : (opts.detail ? '<div class="p" style="color:var(--text-dim);">空位</div>' : '<div class="p" style="color:var(--text-dim);">待定</div>');
        } else {
          body = '<div class="p" style="color:var(--text-dim);">待定</div>';
        }

        const border = n.winnerId ? 'border-color:var(--gold);' : '';
        return `<div class="bracket-match" style="${border}">${body}</div>`;
      }).join('');
      return `<div class="bracket-col">${cells}</div>`;
    }).join('');

    return `<div class="bracket">${cols}</div>`;
  }

  // ==================================================================
  // 头像（2026-09-20）
  // ==================================================================
  /**
   * 取要显示的头像字形。
   *
   * ⚠️ 服务端**存与传的就是字形本身**（见 `src/auth.js` 的 `AVATARS`），
   * 所以这里没有"id → 字形"的映射表 —— 白名单只有服务端那一份，
   * 前端直接渲染，不存在"两边表不同步"的问题。
   * 兜底：拿不到头像时用名字首字（与旧的 `.profile-avatar` 行为一致）。
   */
  function avatarGlyph(avatar, name) {
    if (avatar) return String(avatar);
    const n = String(name == null ? '' : name).trim();
    return n ? n[0] : '棋';
  }

  /**
   * 头像圆标（行内元素）。**各页面共用这一份** ——
   * 导航、玩家栏、聊天、观众列表各写一遍的话，迟早出现"圆的方的、大小不一"。
   *
   * @param {{avatar?:string|null, name?:string, size?:number}} o
   */
  function avatarHtml(o) {
    const opts = o || {};
    const size = opts.size || 28;
    return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px;"`
      + ` title="${esc(opts.name || '')}">${esc(avatarGlyph(opts.avatar, opts.name))}</span>`;
  }

  global.debugLog = debugLog;
  global.UI = { $, esc, toast, debugLog, resultText, paginate, bracketHtml, avatarGlyph, avatarHtml };
})(window);
