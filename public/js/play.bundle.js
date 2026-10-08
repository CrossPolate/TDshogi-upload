/* ==== js/a11y.js ==== */
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

/* ==== js/settings.js ==== */
/**
 * settings.js — 用户设置中心（PLAN §S1）
 *
 * 把散落各处的偏好收敛到**单一** localStorage 键 `tdshogi_settings`：
 * 此前主题在 nav.js（`tdshogi_theme`）、音效在 sound.js（`tdshogi_sound`），各自为政。
 * 本模块统一读写；旧键**只读一次做迁移、不删除**（回滚安全）。
 *
 * ⚠️ 加载顺序：必须**早于** nav.js / sound.js / board.js（它们在初始化时会读设置）。
 *
 * 设计要点：
 *  - `SCHEMA` 是设置项的**唯一描述**（面板据此渲染）——加设置项只改这一处
 *  - 单向数据流：UI/代码调 `set()` → 存储 + 广播 → 订阅者各自应用。
 *    绝不在 `apply()` 里回调写入 set()，否则会递归。
 *  - 面板 DOM 与样式**动态注入**，无需修改 9 个 HTML 文件
 */
(function (global) {
  const KEY = 'tdshogi_settings';
  const LEGACY_THEME = 'tdshogi_theme';
  const LEGACY_SOUND = 'tdshogi_sound';

  const DEFAULTS = {
    theme: 'dark',              // dark | light
    sound: true,                // 行棋/吃子音效
    showCoords: false,          // 棋盘坐标（筋 1–9 / 段 一–九），默认隐藏
    dragToMove: false,          // 触屏拖拽走子；关闭时用「点选两步」避免误触
    highlightLastMove: true,    // 上一步落点高亮
    spectatorNotices: true,     // §R3：聊天区显示「XX 进入/离开观战」
    // §U4 音效细分。取值：'default'（合成音）/ 'file:<名字>'（真实音频文件，落子音
    // 在 public/sound/）。audio 资源 2026-09-26 实装。
    // ⚠️ 2026-10-08：棋子图集 atlas、读秒音 soundByoyomi **迁入装扮**，不再进设置面板。
    soundMinute: 'default',     // 本时整分钟提醒音（§U1）
    soundMove: 'default',       // 棋驹落子/吃子音
    // ⚠️ 2026-10-07：BGM 曲目选择移出设置面板 —— 曲目只在「装扮」里装备；
    // 这里只留全局音乐开关（右上角 🔊 按钮的持久化键）。
    music: true,                // 全局 BGM 开关（菜单/开局/终盘三轨）
    musicVolume: 50,            // ⚠️ 2026-10-08：BGM 音量百分比，默认 50%
    playOpponentBgm: true,      // ⚠️ 2026-10-08：对局中是否与对手 BGM 交替循环（默认开）
  };

  /** 设置项元数据（面板渲染的唯一来源） */
  const SCHEMA = [
    { group: '显示', key: 'theme', type: 'select', label: '主题',
      options: [['dark', '深色'], ['light', '浅色']] },
    { group: '显示', key: 'showCoords', type: 'bool', label: '棋盘坐标',
      hint: '棋盘四周显示 1–9 筋、一–九 段' },
    { group: '显示', key: 'highlightLastMove', type: 'bool', label: '上一步高亮' },
    { group: '对局', key: 'sound', type: 'bool', label: '行棋音效' },
    { group: '对局', key: 'dragToMove', type: 'bool', label: '触屏拖拽走子',
      hint: '关闭时用「点棋子 → 点目标格」两步走子，可减少误触' },
    { group: '对局', key: 'spectatorNotices', type: 'bool', label: '观众进出提示',
      hint: '在聊天区显示「XX 进入/离开观战」；人多时可关掉避免刷屏' },
    // ⚠️ 2026-10-08：「棋子图集」「读秒音」迁入装扮页装备，此处不再提供。
    // §U4 音效与 BGM。'file:<名字>' 选项对应真实音频：落子音在 public/sound/。
    // 分钟提醒暂无素材，只有合成音一项。
    { group: '音效', key: 'soundMinute', type: 'select', label: '分钟提醒音',
      options: [['default', '默认（合成音）']], hint: '本时剩余每跨过一个整分钟响一声' },
    { group: '音效', key: 'soundMove', type: 'select', label: '落子音',
      options: [['default', '默认（合成音）'], ['file:pieces/pieces_wood', '棋子敲击']],
      hint: '含吃子（音色更沉）' },
    // ⚠️ 2026-10-07：「对局 BGM」下拉已移除 —— 曲目在「装扮」里装备，总开关在右上角 🔊。
    // ⚠️ 2026-10-08：补 BGM 音量 + 是否播放对手 BGM（对局中双方曲交替循环）。
    { group: '音乐', key: 'musicVolume', type: 'range', label: 'BGM 音量',
      min: 0, max: 100, step: 5, hint: '默认 50%，只影响 BGM，不影响行棋音效' },
    { group: '音乐', key: 'playOpponentBgm', type: 'bool', label: '播放对手 BGM',
      hint: '对局中自己与对手的开局曲交替循环；关闭则只播自己的' },
  ];

  let cache = null;
  const listeners = [];

  /** 读取并合并（含旧键一次性迁移与非法值归一化） */
  function load() {
    if (cache) return cache;
    let stored = {};
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') stored = o;
      }
    } catch (_) { stored = {}; }

    // 旧键迁移：仅在新键尚无该字段时搬运（避免覆盖用户在面板里改过的新值）
    try {
      if (stored.theme === undefined) {
        const t = localStorage.getItem(LEGACY_THEME);
        if (t) stored.theme = t;
      }
      if (stored.sound === undefined) {
        const s = localStorage.getItem(LEGACY_SOUND);
        if (s !== null) stored.sound = s !== 'off';
      }
    } catch (_) {}

    cache = Object.assign({}, DEFAULTS, stored);
    // 归一化：localStorage 可被手改，非法值一律回落到默认
    if (cache.theme !== 'light') cache.theme = 'dark';
    cache.sound = !!cache.sound;
    cache.showCoords = !!cache.showCoords;
    cache.dragToMove = !!cache.dragToMove;
    cache.highlightLastMove = !!cache.highlightLastMove;
    cache.music = cache.music !== false; // 全局音乐开关默认开
    cache.playOpponentBgm = cache.playOpponentBgm !== false; // 默认播对手 BGM
    // 音量：0–100 整数百分比，默认 50
    const vol = Number(cache.musicVolume);
    cache.musicVolume = Number.isFinite(vol) ? Math.min(100, Math.max(0, Math.round(vol))) : 50;
    // select 项白名单：取值必须在 SCHEMA 的 options 里（音效/BGM 选项随素材扩充，
    // 手写死白名单会漏维护；从 SCHEMA 派生则加选项时只改一处）
    for (const it of SCHEMA) {
      if (it.type !== 'select') continue;
      if (!it.options.some(([v]) => String(v) === String(cache[it.key]))) {
        cache[it.key] = DEFAULTS[it.key];
      }
    }
    return cache;
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
  }

  /** 全部设置（副本） */
  function all() { return Object.assign({}, load()); }

  /** 读单项 */
  function get(key) { return load()[key]; }

  /**
   * 写单项并广播。只接受 DEFAULTS 里存在的键（白名单，防止写入垃圾字段）。
   * @returns {boolean} 是否发生了变更
   */
  function set(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return false;
    const cur = load();
    if (cur[key] === value) return false;
    cur[key] = value;
    persist();
    apply(key);
    listeners.slice().forEach((fn) => {
      try { fn(all(), key); } catch (e) { console.error('[settings] 订阅者出错:', e); }
    });
    return true;
  }

  /** 订阅变更：fn(allSettings, changedKey) */
  function subscribe(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /**
   * 把设置应用到页面（幂等，可重复调用）。
   * @param {string} [key] 只应用某一项；省略则全部应用
   */
  function apply(key) {
    const s = load();

    if (!key || key === 'theme') {
      document.documentElement.classList.toggle('theme-light', s.theme === 'light');
      // ⚠️ 按 id 取主题按钮：`.theme-toggle` 这个类名同时被语言按钮复用（2026-09-20），
      // 按类名取"第一个"会把语言按钮的「中/EN」覆写成月亮图标。
      // 保留类名兜底：万一导航还没渲染（面板先打开），至少别报错。
      const btn = document.getElementById('themeToggle') || document.querySelector('.theme-toggle');
      if (btn) btn.textContent = s.theme === 'light' ? '☀️' : '🌙';
    }

    if (!key || key === 'sound') {
      // 只同步「内部状态」，不回调 setEnabled（那会再次触发 set → 递归）
      if (global.Sound && typeof global.Sound.applyEnabled === 'function') {
        global.Sound.applyEnabled(s.sound);
      }
    }

    if (!key || key === 'music') {
      // 全局音乐开关（右上角 🔊）：只同步内部状态，不回调 setMusicOn
      if (global.Sound && typeof global.Sound.applyMusicOn === 'function') {
        global.Sound.applyMusicOn(s.music);
      }
      const btn = document.getElementById('musicToggle');
      if (btn) {
        btn.textContent = s.music ? '🔊' : '🔇';
        btn.title = s.music ? '关闭音乐' : '开启音乐';
        btn.classList.toggle('music-off', !s.music);
      }
    }

    if (!key || key === 'musicVolume') {
      if (global.Sound && typeof global.Sound.applyMusicVolume === 'function') {
        global.Sound.applyMusicVolume(s.musicVolume);
      }
    }

    if (!key || key === 'playOpponentBgm') {
      if (global.Sound && typeof global.Sound.applyPlayOpponentBgm === 'function') {
        global.Sound.applyPlayOpponentBgm(s.playOpponentBgm);
      }
    }

    if (!key || key === 'dragToMove') {
      // 给 body 打标记：CSS 在 `pointer: coarse` 下据此放开棋盘的纵向滚动（§S3）。
      // 桌面端带不带这个 class 都无影响（CSS 规则本身限定在触屏媒体查询内）。
      if (document.body) document.body.classList.toggle('no-drag', !s.dragToMove);
    }
  }

  // ==================================================================
  // 设置面板（DOM 与样式动态注入，不改 9 个 HTML）
  // ==================================================================

  const STYLE_ID = 'settingsStyle';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
.settings-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;
  justify-content:center;z-index:400;padding:16px;}
.settings-mask.show{display:flex;}
.settings-panel{width:min(420px,100%);max-height:min(80vh,560px);overflow:auto;background:var(--bg-2,#1b1b1f);
  color:var(--text,#eee);border:1px solid rgba(128,128,128,.25);border-radius:12px;
  box-shadow:0 12px 40px rgba(0,0,0,.5);}
.settings-head{display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;border-bottom:1px solid rgba(128,128,128,.2);font-weight:700;}
.settings-close{background:none;border:none;color:inherit;font-size:16px;cursor:pointer;padding:4px 8px;line-height:1;}
.settings-body{padding:4px 16px;}
.settings-group{padding:10px 0;border-bottom:1px solid rgba(128,128,128,.15);}
.settings-group:last-child{border-bottom:none;}
.settings-group-title{font-size:12px;color:var(--text-dim,#999);margin-bottom:6px;}
.settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:9px 0;cursor:pointer;}
.settings-text{display:flex;flex-direction:column;gap:2px;}
.settings-label{font-size:14px;}
.settings-hint{font-size:11px;color:var(--text-dim,#999);line-height:1.4;}
.settings-row input[type=checkbox]{width:20px;height:20px;flex:none;accent-color:var(--gold,#c9a227);cursor:pointer;}
.settings-row select{background:var(--bg-3,#26262c);color:inherit;border:1px solid rgba(128,128,128,.3);
  border-radius:6px;padding:5px 8px;font-size:13px;cursor:pointer;}
.settings-foot{padding:10px 16px 14px;font-size:11px;color:var(--text-dim,#999);}
@media (max-width:640px){
  .settings-panel{max-height:88vh;}
  .settings-row{padding:12px 0;}
  .settings-panel{width:100%;}
}`;
    document.head.appendChild(st);
  }

  function itemHtml(it, s) {
    const hint = it.hint ? `<span class="settings-hint">${it.hint}</span>` : '';
    if (it.type === 'bool') {
      return `
        <label class="settings-row">
          <span class="settings-text"><span class="settings-label">${it.label}</span>${hint}</span>
          <input type="checkbox" data-set-key="${it.key}" ${s[it.key] ? 'checked' : ''}>
        </label>`;
    }
    if (it.type === 'select') {
      return `
        <label class="settings-row">
          <span class="settings-text"><span class="settings-label">${it.label}</span>${hint}</span>
          <select data-set-key="${it.key}">
            ${it.options.map(([v, t]) => `<option value="${v}"${String(s[it.key]) === String(v) ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </label>`;
    }
    if (it.type === 'range') {
      return `
        <label class="settings-row">
          <span class="settings-text"><span class="settings-label">${it.label}</span>${hint}</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <input type="range" data-set-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}"
              value="${s[it.key]}" style="width:120px;accent-color:var(--gold,#c9a227);">
            <span data-set-val="${it.key}" style="font-size:12px;min-width:36px;text-align:right;">${s[it.key]}%</span>
          </span>
        </label>`;
    }
    return '';
  }

  function renderPanel() {
    const mask = document.getElementById('settingsMask');
    if (!mask) return;
    const s = load();
    const groups = [];
    for (const it of SCHEMA) {
      let g = groups.find((x) => x.name === it.group);
      if (!g) { g = { name: it.group, items: [] }; groups.push(g); }
      g.items.push(it);
    }
    mask.innerHTML = `
      <div class="settings-panel" role="dialog" aria-label="设置">
        <div class="settings-head">
          <span>⚙️ 设置</span>
          <button class="settings-close" type="button" title="关闭">✕</button>
        </div>
        <div class="settings-body">
          ${groups.map((g) => `
            <div class="settings-group">
              <div class="settings-group-title">${g.name}</div>
              ${g.items.map((it) => itemHtml(it, s)).join('')}
            </div>`).join('')}
        </div>
        <div class="settings-foot">设置保存在本机浏览器，不会上传</div>
      </div>`;
    mask.querySelector('.settings-close').addEventListener('click', closePanel);
    mask.querySelectorAll('[data-set-key]').forEach((el) => {
      const key = el.getAttribute('data-set-key');
      const isRange = el.type === 'range';
      const evt = isRange ? 'input' : 'change';
      el.addEventListener(evt, () => {
        const v = el.type === 'checkbox' ? el.checked : el.value;
        set(key, isRange ? Number(v) : v);
        const valEl = mask.querySelector(`[data-set-val="${key}"]`);
        if (valEl) valEl.textContent = `${el.value}%`;
      });
    });
  }

  function ensurePanel() {
    let mask = document.getElementById('settingsMask');
    if (mask) return mask;
    ensureStyle();
    mask = document.createElement('div');
    mask.id = 'settingsMask';
    mask.className = 'settings-mask';
    // 点遮罩空白处关闭
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.appendChild(mask);
    return mask;
  }

  function openPanel() {
    const mask = ensurePanel();
    renderPanel();
    mask.classList.add('show');
  }

  function closePanel() {
    const mask = document.getElementById('settingsMask');
    if (mask) mask.classList.remove('show');
  }

  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  global.Settings = {
    KEY, DEFAULTS, SCHEMA,
    get, set, all, subscribe, apply,
    openPanel, closePanel,
  };

  // 首次应用（script 位于 body 末尾，documentElement 已就绪）
  apply();
})(window);

/* ==== js/util.js ==== */
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

  /**
   * 模态提示框：阻断式弹窗，用于**必须让用户看清**的错误（注册/登录失败原因等）。
   *
   * 为什么不用 toast：toast 2.5s 就消失、无焦点管理，失败原因一闪而过用户根本读不完。
   * 这里做成轻量 dialog（可 Esc/点遮罩/点确定关闭），不依赖 a11y.js（没有也能用）。
   */
  function alertBox(title, message) {
    const t = (s) => (window.I18N ? window.I18N.t(String(s == null ? '' : s)) : String(s == null ? '' : s));
    let root = document.getElementById('uiAlert');
    if (!root) {
      root = document.createElement('div');
      root.id = 'uiAlert';
      root.className = 'modal-overlay';
      root.style.display = 'none';
      root.innerHTML =
        '<div class="card ui-alert-box" role="dialog" aria-modal="true" aria-labelledby="uiAlertTitle" aria-describedby="uiAlertMsg">' +
        '<div id="uiAlertTitle" class="ui-alert-title"></div>' +
        '<div id="uiAlertMsg" class="ui-alert-msg"></div>' +
        '<button type="button" class="btn btn-primary" id="uiAlertOk" style="width:100%;">确定</button>' +
        '</div>';
      document.body.appendChild(root);
      const close = () => {
        root.style.display = 'none';
        const dlg = root.querySelector('[role="dialog"]');
        if (window.A11y && dlg) window.A11y.onDialogClose(dlg);
      };
      root._close = close;
      root.querySelector('#uiAlertOk').addEventListener('click', close);
      root.addEventListener('click', (e) => { if (e.target === root) close(); });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
      });
    }
    root.querySelector('#uiAlertTitle').textContent = t(title);
    root.querySelector('#uiAlertMsg').textContent = t(message);
    root.style.display = 'flex';
    const dlg = root.querySelector('[role="dialog"]');
    if (window.A11y && dlg) {
      window.A11y.onDialogOpen(dlg, { onClose: root._close });
    }
    const ok = root.querySelector('#uiAlertOk');
    if (ok && typeof ok.focus === 'function') ok.focus();
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
   * ⚠️ 2026-10-07：道具头像支持**图片 URL**（以 `/` 开头的站内路径）——
   * 文本上下文（title 等）回落到 🖼，真正绘制走 `avatarHtml` / `setAvatarContent`。
   * 兜底：拿不到头像时用名字首字（与旧的 `.profile-avatar` 行为一致）。
   */
  function isAvatarImage(avatar) {
    return typeof avatar === 'string' && avatar.charAt(0) === '/' && avatar.length > 1;
  }

  function avatarGlyph(avatar, name) {
    if (isAvatarImage(avatar)) return '🖼';
    if (avatar) return String(avatar);
    const n = String(name == null ? '' : name).trim();
    return n ? n[0] : '棋';
  }

  /**
   * 头像圆标（行内元素）。**各页面共用这一份** ——
   * 导航、玩家栏、聊天、观众列表各写一遍的话，迟早出现"圆的方的、大小不一"。
   * 图片头像渲染为 `<img>`（object-fit: cover），字形头像保持原文本。
   *
   * @param {{avatar?:string|null, name?:string, size?:number}} o
   */
  function avatarHtml(o) {
    const opts = o || {};
    const size = opts.size || 28;
    const title = esc(opts.name || '');
    const base = `class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px;overflow:hidden;"`;
    if (isAvatarImage(opts.avatar)) {
      return `<span ${base} title="${title}">`
        + `<img src="${esc(opts.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;">`
        + `</span>`;
    }
    return `<span ${base} title="${title}">${esc(avatarGlyph(opts.avatar, opts.name))}</span>`;
  }

  /**
   * 把头像写进已有元素（文本或图片）。
   * 供 nav / play-views / chat 等用 `textContent` 的地方升级到图片头像。
   */
  function setAvatarContent(el, avatar, name) {
    if (!el) return;
    if (isAvatarImage(avatar)) {
      el.innerHTML = `<img src="${esc(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;">`;
    } else {
      el.textContent = avatarGlyph(avatar, name);
    }
  }

  // ==================================================================
  // 事件委托（2026-09-23，安全审查遗留项 13f）
  // ==================================================================
  const actionHandlers = {};

  /**
   * 注册一个 `data-act` 动作。**整页只装一次 click 监听**（本文件加载时就装好）。
   *
   * ⚠️⚠️ 为什么不再用 inline `onclick="fn('${id}')"`（审查 P1-3 的根因）：
   * 把值拼进**属性**里，安全就全靠"每个调用点都记得让 `esc` 转义"。
   * 2026-09-21 补上单引号转义只是**止血** —— 只要有人新加一处忘了 `esc`，
   * 立刻又是一个存储型 XSS（游客改个名字，管理员点一下就在管理员身份下执行脚本）。
   * 改用 `data-*` 后：① 值为**普通属性文本**，引号逃不出属性、更不会被执行；
   * ② 事件走**委托**，脚本重渲染列表也不会丢监听；③ 整页一个监听，比 34 个 inline 属性更省。
   * （仍要 `esc`：那是防 HTML 注入，与"会不会执行"是两件事。）
   *
   * 用法：
   *   UI.onAction('user-ban', (el) => adminBan(el.dataset.id, el.dataset.name));
   *   `<button data-act="user-ban" data-id="…" data-name="…">封禁</button>`
   *
   * 另有一条**通用**约定：任何元素带 `data-href` 即点击跳转
   * （替代原先 6 处 `onclick="location.href='review.html?id=…'"`）。
   *
   * @param {string} name  `data-act` 的值
   * @param {(el:Element, ev:Event)=>void} fn 处理器，`el` 是最近的 `[data-act]` 元素
   */
  function onAction(name, fn) {
    actionHandlers[name] = fn;
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const jump = t.closest('[data-href]');
    if (jump) {
      const href = jump.getAttribute('data-href');
      if (href) global.location.href = href;
      return;
    }
    const el = t.closest('[data-act]');
    if (!el) return;
    const fn = actionHandlers[el.getAttribute('data-act')];
    if (fn) fn(el, e);
  });

  global.debugLog = debugLog;
  global.UI = {
    $, esc, toast, alert: alertBox, debugLog, resultText, paginate, bracketHtml,
    avatarGlyph, avatarHtml, setAvatarContent, isAvatarImage,
    onAction,
  };
})(window);

/* ==== js/i18n.js ==== */
/**
 * i18n.js — 多语言（PLAN §Z5）
 *
 * 设计取舍（三条，都是为了让"加一种语言"的边际成本尽量低）：
 *
 * 1. **以中文原文当键**。本项目只有一种源语言，所谓"key"本来就是那句待翻译的话——
 *    再立一层 `t.home.hero.title` 式的 key 命名空间，等于每加一句文案都要同时改
 *    HTML/JS + 词典 + key 表三处。代价是**改中文原文会丢翻译**，
 *    所以靠一条测试兜底：「en 词典的值里不许残留中文」+「键必须非空」。
 *
 * 2. **DOM 整段匹配**：文本节点的 `trim()` 后**完全等于**某个词条时才替换，
 *    属性（`placeholder`/`title`/`aria-label`）同理。于是**静态页面零改动**就会被覆盖——
 *    不需要给每个元素标 `data-i18n`。刻意只做"整段相等"，避免把长句里的词误替换成英文
 *    （那种"半句中文半句英文"的界面比不翻译更难读）。
 *
 * 3. **节点记住原文**（WeakMap）。否则切到英文后，节点里存的就是英文，
 *    再切回中文时拿英文去查表必然查不到 —— 用户就"回不去中文"了。
 *
 * ⚠️ 中文是默认语言，此文件对中文用户**零开销**：不建观察器、DOM 扫描直接跳过。
 * ⚠️ 服务端下发的字符串（错误提示、系统播报）也走 `t()`（`UI.toast` 是必经之路），
 *    所以**给词典补一条就能翻一条**，不必改服务端；带变量的句子（`已批准 3 人`）
 *    需要在调用点用 `t('已批准 {n} 人', { n })`。
 */
(function () {
  const STORAGE_KEY = 'tdshogi_locale';

  /**
   * 可选语言。`short` 用于导航栏那个小按钮（点一下轮换到下一种）。
   *
   * ⚠️ 顺序 = 轮换顺序。中文放第一（默认语言、也是词典的"源语言"）。
   * 日语排在英文之后：将棋术语本就来自日语，而且中文界面里大量术语**已经就是日文汉字**
   * （先手/後手/詰み/香落ち/二枚落ち…），所以 ja 词条里有一批与原文**完全相同**是**正常**的
   * ——英语那套"译文不许与原文相同"的约束对 ja 不适用（ja 另有一套人工自检，见下方 ja 词表注释）。
   */
  const LOCALES = [
    { id: 'zh-CN', label: '中文', short: '中' },
    { id: 'en', label: 'English', short: 'EN' },
    { id: 'ja', label: '日本語', short: 'JA' },
  ];

  // ==================================================================
  // 词典：`en` 下是「中文原文 → 英文」。变量写成 `{name}`。
  // ==================================================================
  const DICT = {
    en: {
      // ---- 导航与通用 ----
      首页: 'Home',
      对战: 'Play',
      棋谱: 'Games',
      赛事: 'Tournaments',
      个人: 'Profile',
      管理后台: 'Admin console',
      切换主题: 'Toggle theme',
      设置: 'Settings',
      语言: 'Language',
      '个人 · 游客': 'Profile · Guest',
      '个人 · 已登录账号': 'Profile · Signed in',
      复制: 'Copy',
      已复制: 'Copied',
      确定: 'OK',
      取消: 'Cancel',
      关闭: 'Close',
      返回: 'Back',
      保存: 'Save',
      刷新: 'Refresh',
      加载中: 'Loading…',
      暂无: 'None',
      暂无数据: 'No data yet',
      没有数据: 'No data',
      查看详情: 'View details',
      在线: 'Online',
      离线: 'Offline',
      未知: 'Unknown',
      无名棋士: 'Unnamed player',
      系统: 'System',
      你: 'You',

      // ---- 时间控制（服务端下发的 name 也照此翻） ----
      '10 分钟包干（标准比赛）': '10 min sudden death (standard)',
      '15 分钟 + 60 秒读秒': '15 min + 60 s byoyomi',
      '10 分钟 + 30 秒读秒': '10 min + 30 s byoyomi',
      '10 秒快棋': '10 s bullet',
      '10分钟包干': '10 min',
      '15分+60秒': '15 min + 60 s',
      '10分+30秒': '10 min + 30 s',
      '10秒': '10 s',

      // ---- 首页 ----
      天锻将棋道场: 'TDShogi Dojo',
      '日本将棋 · 在线实时对战 · 免注册即刻对局': 'Japanese shogi · real-time online play · no sign-up required',
      '⚔️ 开始对局': '⚔️ Start a game',
      '🎲 随机观战': '🎲 Watch a random game',
      在线人数: 'Online',
      对局中: 'Playing',
      等待对局: 'Waiting',
      复盘中: 'Reviewing',
      累计棋谱: 'Games played',
      三步开始你的将棋之旅: 'Three steps to start playing shogi',
      立即开局: 'Play right away',
      '无需注册，打开就能玩。快速匹配在线对手，或生成房间码邀请好友来一局。':
        'No sign-up needed — just start. Match with an online player, or create a room code and invite a friend.',
      登记账号: 'Create an account',
      '注册正式账号，ELO 评级、胜绩与全部棋谱永久保存，游客数据可一键升级迁移。':
        'Register to keep your ELO rating, results and all game records — your guest data migrates in one click.',
      复盘精进: 'Review and improve',
      '每局自动存为标准 KIF/CSA 棋谱，复盘器支持书签、评论与变着研究。':
        'Every game is saved as standard KIF/CSA. The reviewer supports bookmarks, comments and variations.',
      系统公告: 'Announcements',
      ELO排行榜: 'ELO leaderboard',
      最新对局战报: 'Latest results',
      '查看我的棋谱 →': 'My games →',
      将棋规则速查: 'Shogi rules at a glance',
      '🎯 目标：将死对方的王（玉将）': '🎯 Goal: checkmate the opponent’s king',
      '轮流走子，攻击对方的王使其无路可逃即为「詰み」（将死）获胜。被将军时必须应将；本平台服务端自动判定王手与将死。':
        'Players alternate moves; trapping the opponent’s king with no escape is checkmate (詰み) and wins. You must answer a check — the server detects checks and mate for you.',
      '⬆️ 升变：进入敌阵可强化棋子': '⬆️ Promotion: enter the enemy camp to upgrade a piece',
      '棋子进入、离开或在对方三段阵地内移动时可以选择升变（翻面）：飞车→龙王、角行→龙马、银将/桂马/香车/步兵均获得金将走法。玉与金不能升变。':
        'A piece may promote (flip) when it moves into, out of, or within the enemy’s last three ranks: rook→dragon, bishop→horse, and silver/knight/lance/pawn all gain gold-general moves. King and gold cannot promote.',
      '🖐️ 打入：吃掉的棋子归你使用': '🖐️ Drops: captured pieces join your hand',
      '吃掉的对方棋子放入自己的驹台，之后可在任意空格「打入」重新上战场——这是将棋最独特的规则（二步、打步詰等禁手已由服务端校验）。':
        'Captured pieces go to your hand and can later be dropped onto any empty square — shogi’s most distinctive rule. Illegal drops (two pawns on a file, pawn-drop mate, etc.) are rejected by the server.',

      // ---- 大厅 ----
      快速匹配: 'Quick match',
      '点击后自动与在线棋手配对，无需房间码': 'Automatically paired with an online player — no room code needed',
      '寻找对手中…': 'Looking for an opponent…',
      取消匹配: 'Cancel match',
      创建房间: 'Create a room',
      '生成 6 位房间码，邀请好友加入对局。': 'Get a 6-character room code and invite a friend.',
      比赛时间: 'Time control',
      '手合割（让子）': 'Handicap',
      '不让子：双方各 20 枚，房主随机执先手，计入 ELO。':
        'No handicap: 20 pieces each, the host plays a random colour, rated.',
      '🔒 私人房间': '🔒 Private room',
      '（不计 ELO，经验照常 · 不开放观战）': '(unrated, XP still earned, no spectators)',
      '房间密码（4-8 位，可留空表示不设密码）': 'Room password (4–8 chars, leave empty for none)',
      加入房间: 'Join a room',
      '输入 6 位房间码': 'Enter the 6-character room code',
      房间码: 'Room code',
      房间号: 'Room code',
      加入: 'Join',
      观战: 'Watch',
      '👁 观战（用房间码）': '👁 Watch (with a room code)',
      '进行中的对局': 'Games in progress',
      '当前没有进行中的对局': 'No games in progress',
      '人观战': 'watching',
      房间对局: 'Room game',
      快速对局: 'Quick match game',

      // ---- 让子（手合割） ----
      平手: 'Even game',
      香落ち: 'Lance handicap',
      右香落ち: 'Right-lance handicap',
      角落ち: 'Bishop handicap',
      飛車落ち: 'Rook handicap',
      飛香落ち: 'Rook + lance handicap',
      二枚落ち: 'Two-piece handicap',
      四枚落ち: 'Four-piece handicap',
      六枚落ち: 'Six-piece handicap',
      八枚落ち: 'Eight-piece handicap',
      十枚落ち: 'Ten-piece handicap',
      让子: 'Handicap',
      上手: 'Giver (handicap)',
      下手: 'Receiver (handicap)',

      // ---- 对局页 ----
      房间: 'Room',
      对局: 'Game',
      认输: 'Resign',
      再来一局: 'Rematch',
      请求再来一局: 'Request a rematch',
      退出对局: 'Leave game',
      对手断线: 'Opponent disconnected',
      对手已断线: 'Opponent is disconnected',
      '⚠️ 断线': '⚠️ Disconnected',
      '连接中…': 'Connecting…',
      '对手': 'Opponent',
      你已获胜: 'You win',
      你已落败: 'You lose',
      和棋: 'Draw',
      未完成: 'Unfinished',
      胜利: 'Win',
      失败: 'Loss',
      胜: 'Win',
      负: 'Loss',
      持驹: 'In hand',
      观众: 'Spectators',
      暂无观众: 'No spectators yet',
      操作: 'Actions',
      聊天: 'Chat',
      全部: 'All',
      发送: 'Send',
      说点什么: 'Say something…',
      系统消息: 'System',
      走子记录: 'Move list',
      入玉宣言: 'Declare nyugyoku',
      举报对手: 'Report opponent',
      尚未走子: 'No moves yet',
      回放: 'Replay',
      观众进出提示: 'Spectator join/leave notices',
      请稍等: 'Please wait',
      轮到你走: 'Your turn',
      等待对手走子: 'Waiting for the opponent',
      同意: 'Agree',
      同意再来一局: 'Agree to rematch',
      已申请再来一局: 'Rematch requested',

      // ---- 设置面板 ----
      显示: 'Display',
      棋子: 'Pieces',
      音效: 'Sound',
      主题: 'Theme',
      深色: 'Dark',
      浅色: 'Light',
      跟随系统: 'Follow system',
      棋盘坐标: 'Board coordinates',
      上一步高亮: 'Highlight last move',
      行棋音效: 'Move sounds',
      触屏拖拽走子: 'Drag to move (touch)',
      棋子图集: 'Piece set',
      金輝: 'Kinki',
      凌雲: 'Ryoko',
      分钟提醒音: 'Minute reminder',
      读秒音: 'Byoyomi tick',
      落子音: 'Move sound',
      '对局 BGM': 'Game BGM',
      关闭音效: 'Off',
      默认: 'Default',
      开启: 'On',

      // ---- 棋谱/复盘 ----
      棋谱列表: 'Game list',
      复盘: 'Review',
      开始: 'Start',
      结束: 'End',
      上一步: 'Previous',
      下一步: 'Next',
      首手: 'First',
      末手: 'Last',
      书签: 'Bookmark',
      评论: 'Comment',
      变着: 'Variation',
      导入: 'Import',
      导出: 'Export',
      手数: 'Moves',
      结果: 'Result',
      对局时间: 'Played at',
      用时: 'Duration',
      导出KIF: 'Export KIF',
      导出CSA: 'Export CSA',

      // ---- 个人页 ----
      昵称: 'Name',
      等级: 'Level',
      战绩: 'Record',
      胜率: 'Win rate',
      赛事荣誉: 'Tournament honours',
      夺冠: 'Titles',
      亚军: 'Runner-up',
      四强: 'Top 4',
      参赛赛事: 'Tournaments entered',
      夺冠率: 'Title rate',
      还没有参加过赛事: 'No tournaments yet',
      '去「赛事」页报名，或自己办一场吧！': 'Sign up on the Tournaments page, or host one yourself!',
      编辑资料: 'Edit profile',
      头像: 'Avatar',
      保存修改: 'Save changes',

      // ---- 赛事 ----
      我的赛事: 'My tournaments',
      进行中: 'In progress',
      已结束: 'Finished',
      待审核: 'Pending review',
      已取消: 'Cancelled',
      报名: 'Sign up',
      取消报名: 'Withdraw',
      已报名: 'Signed up',
      报名名单: 'Entrants',
      待批准: 'Pending approval',
      批准: 'Approve',
      拒绝: 'Reject',
      全部批准: 'Approve all',
      开始比赛: 'Start tournament',
      取消赛事: 'Cancel tournament',
      存档赛事: 'Archive tournament',
      对阵表: 'Bracket',
      名次表: 'Standings',
      赛程: 'Schedule',
      冠军: 'Champion',
      轮空: 'Bye',
      主办: 'Host',
      主办人: 'Host',
      主办人管理面板: 'Organiser panel',
      管理员: 'Administrator',
      参赛人数: 'Players',
      创建赛事: 'Create tournament',
      赛事名称: 'Tournament name',
      举办理由: 'Reason for hosting',
      赛制: 'Format',
      单败淘汰: 'Single elimination',
      瑞士制: 'Swiss system',

      // ---- 登录/账号 ----
      登录: 'Sign in',
      退出登录: 'Sign out',
      用户名: 'Username',
      密码: 'Password',
      注册: 'Register',
      账号: 'Account',
      游客: 'Guest',
      升级为账号: 'Upgrade to an account',

      // ---- 常见服务端消息 ----
      '还没轮到你': 'Not your turn yet',
      '非法走法': 'Illegal move',
      '未知的手合割': 'Unknown handicap',
      '你已在对局中，请先结束当前对局': 'You are already in a game — finish it first',
      '对局尚未结束': 'The game is not over yet',
      '房间不存在': 'Room not found',
      '房间已满': 'Room is full',
      '需要密码': 'Password required',
      '密码错误': 'Wrong password',
      '请输入 6 位房间码': 'Enter the 6-character room code',
      '你不在对局中': 'You are not in a game',
      '对手已离开': 'The opponent left',
      '服务器内部错误': 'Internal server error',
      '网络异常，正在重连…': 'Network problem — reconnecting…',
      '已重新连接': 'Reconnected',
      '行动超时': 'Move timed out',
      '时间切れ': 'Out of time',
      该房间需要密码: 'This room requires a password',

      // ---- 页面标题与首页补充 ----
      'TDShogi · 在线将棋对战平台': 'TDShogi · Online shogi platform',
      'TDShogi · 猹狸的将棋道场': 'TDShogi · Shogi Dojo',
      '平台实时数据': 'Live platform stats',
      '三步开始': 'Get started in three steps',
      '⏱ 持钟：包干与本手持读秒': '⏱ Clocks: sudden death and per-move byoyomi',
      '常规时制为每方「10+0」包干用时；快棋采用「0+10」形式——不设总时长，每手棋 10 秒读秒，超时即负。时间耗尽前留意读秒提示音。':
        'The standard control is 10+0 sudden death per side; bullet uses 0+10 — no total time, 10 seconds per move, and running out loses. Listen for the byoyomi cue.',

      // ---- 大厅补充 ----
      '对战 · TDShogi': 'Play · TDShogi',
      对战大厅: 'Play lobby',
      '一键匹配在线对手，两人即开，实时对局。': 'Match with an online player instantly — two players and you are live.',
      开始匹配: 'Start matching',
      '正在寻找对手…': 'Looking for an opponent…',
      点击下方按钮取消: 'Press the button below to cancel',
      复制房间码: 'Copy room code',
      '等待对手加入后自动开局…': 'The game starts automatically once your opponent joins…',
      '输入好友提供的 6 位房间码加入对局。': 'Enter the 6-character code your friend gave you.',
      '进行中的对局（观战）': 'Games in progress (spectate)',
      '输入房间码，如 AB3X7Q': 'Enter the room code, e.g. AB3X7Q',

      // ---- 对局页补充 ----
      '对局 · TDShogi': 'Game · TDShogi',
      '👁 观战中': '👁 Spectating',
      '🔄 视角·先手': '🔄 View · Black',
      '🎤 感想战中': '🎤 Review mode',
      '🙋 我来演示': '🙋 Let me demonstrate',
      '🤝 交给对方': '🤝 Hand over',
      '↩️ 待った': '↩️ Take back',
      '🗑 清空推演': '🗑 Clear line',
      '⏭ 回到最新': '⏭ Back to latest',
      '✋ 自由摆棋': '✋ Free placement',
      '按规则行棋 · 不计入棋谱': 'Legal moves only · not saved to records',
      '观众（': 'Spectators (',
      提交举报: 'Submit report',
      '是否升变？': 'Promote?',
      不成: 'Don’t promote',
      成: 'Promote',
      '切换观战视角（先手 / 后手）': 'Switch viewpoint (Black / White)',
      音效开关: 'Sound on/off',
      '入玉宣言：玉在敌阵 + 敌阵内 10 枚以上 + 点数先手 28 / 后手 27 以上，且自己手番、未被王手 → 宣言方胜（AJSA 规则）':
        'Nyugyoku declaration: your king in the enemy camp, 10+ of your pieces in the enemy camp, 28 points (Black) or 27 (White), on your turn and not in check → the declaring side wins (AJSA rules).',
      '举报对手：作弊 / 辱骂 / 恶意挂机等': 'Report opponent: cheating / abuse / idling, etc.',
      '补充说明（可选）': 'Additional details (optional)',

      // ---- 赛事详情 ----
      '赛事详情 · TDShogi': 'Tournament · TDShogi',
      // 注意与上面的 `加载中` 是**两条**：原文一个带省略号一个不带，键必须与原文一致
      '加载中…': 'Loading…',

      // ---- 赛事列表 ----
      '赛事 · TDShogi': 'Tournaments · TDShogi',
      棋手赛事: 'Tournaments',
      '单败淘汰 / 瑞士制 · 报名满员自动开赛 · 赛事对局不计 ELO':
        'Single elimination / Swiss · starts automatically when full · tournament games are unrated',
      '🏆 我要创建赛事': '🏆 Create a tournament',
      '← 返回全部赛事': '← All tournaments',
      进行中的赛事: 'Ongoing tournaments',
      往期赛事: 'Past tournaments',
      赛事创建申请: 'Tournament application',
      '4 人': '4 players',
      '8 人': '8 players',
      '16 人': '16 players',
      '32 人': '32 players',
      '瑞士制（积分编排）': 'Swiss system',
      '循环赛（待实装）': 'Round-robin (not yet available)',
      '轮数（瑞士制）': 'Rounds (Swiss)',
      '按人数自动（推荐）': 'Automatic by player count (recommended)',
      '3 轮': '3 rounds',
      '4 轮': '4 rounds',
      '5 轮': '5 rounds',
      '6 轮': '6 rounds',
      '7 轮': '7 rounds',
      '8 轮': '8 rounds',
      '9 轮': '9 rounds',
      '瑞士制按积分逐轮配对（强者遇强者、不重复对阵），没有淘汰——输一两场仍有机会。':
        'Swiss pairs players by score each round (strong vs strong, no repeat pairings) with no elimination — losing a game or two still leaves you in it.',
      '人数为奇数时，每轮积分最低且未轮空过的一人轮空（视同胜）。':
        'With an odd number of players, the lowest-scoring player who has not yet had a bye sits out (counted as a win).',
      '举办理由（10–200 字，管理员据此审核）': 'Why you are hosting (10–200 chars; admins review this)',
      报名开始: 'Registration opens',
      报名结束: 'Registration closes',
      比赛开始: 'Play starts',
      比赛结束: 'Play ends',
      '报名需我审核（关闭则报名即参赛）': 'I approve sign-ups (if off, signing up is entering)',
      提交后进入: 'Submitting sends it to',
      管理员审核: 'admin review',
      '，通过后才开放报名。': ', and registration opens only after approval.',
      主办人不会自动参赛: 'The host does not enter automatically',
      // ⚠️ 译文**首尾不要带空白**（排版用的空白属于标记层，不该进词典）。
      //    带空白曾是 2026-09-20 "切语言卡死浏览器"的燃料，见 `nodeContent()` 的说明。
      '——想下棋请另外报名。': '— sign up separately if you want to play.',
      '时间未填写的项视为「不限」。': 'Any time field left empty means “no limit”.',
      提交申请: 'Submit application',
      '如：暑期棋王赛': 'e.g. Summer Shogi Cup',
      '说明办赛目的、面向人群、赛程安排等': 'Describe the purpose, the intended players, the schedule, etc.',

      // ---- 个人页 ----
      '个人 · TDShogi': 'Profile · TDShogi',
      '当前为游客身份。注册账号后，你的对局、积分与棋谱将绑定到账号，可在任意浏览器登录继续。注册会保留当前游客的全部数据。':
        'You are playing as a guest. Register and your games, rating and records attach to the account, usable from any browser. Your current guest data is kept.',
      注册新账号: 'Register a new account',
      注册并保留游客数据: 'Register and keep guest data',
      已有账号登录: 'Sign in to an existing account',
      '已登录账号 · ID:': 'Signed in · ID:',
      '游客账号 · ID:': 'Guest · ID:',
      改名: 'Rename',
      '🎨 换头像': '🎨 Change avatar',
      '选一个头像（点击即生效）': 'Pick an avatar (applies immediately)',
      'ELO 积分': 'ELO rating',
      '📋 我的资料': '📋 My details',
      手机号: 'Phone',
      '（不公开显示，仅管理员可见）': '(not public — admins only)',
      '棋风（公开显示）': 'Style (public)',
      不设定: 'Not set',
      '居飞车·急战': 'Static rook · rapid attack',
      '居飞车·持久战': 'Static rook · slow game',
      振飞车: 'Ranging rook',
      力战型: 'Fighting style',
      奇袭型: 'Surprise style',
      接受型: 'Counter style',
      '注册日期：': 'Registered:',
      保存资料: 'Save details',
      对局数: 'Games',
      平: 'D',
      'ELO 走势': 'ELO trend',
      最近对局: 'Recent games',
      // ---- 个人页 Tab（2026-10-04 棋谱并入个人页，Tab 化单一入口）----
      概览: 'Overview',
      装扮: 'Items',
      我的装扮: 'My items',
      '用户名（2-16 字符）': 'Username (2–16 characters)',
      // ⚠️ 2026-10-02 体验修复（i18n key 漂移）：注册页占位符已是「密码（至少 8 位）」
      //    （服务端 `MIN_PASSWORD = 8`），词典却还停在「至少 4 位」——键对不上，
      //    英文界面会漏翻成中文。这里把键与译文一并修正。
      '密码（至少 8 位）': 'Password (at least 8 characters)',
      确认密码: 'Confirm password',
      点击更换头像: 'Click to change avatar',
      '修改名字（12 字内）': 'Change name (up to 12 characters)',
      '11 位手机号，留空清除': '11-digit phone number; leave empty to clear',
      // ---- 2026-10-02 体验修复新增文案（账号名说明 / 多标签同步 / 连接未就绪 / 登出提示）----
      '账号名不可更改（与注册用户名一致）；如需更换请联系管理员。':
        'The account name cannot be changed — it is your sign-in username. Contact an admin if you need a different one.',
      '身份已在其他标签页变更，正在刷新…': 'Your identity changed in another tab — refreshing…',
      '连接尚未就绪，请稍后再试': 'The connection is not ready yet, please try again shortly',
      '已退出登录，已切换为游客身份': 'Signed out — switched back to guest',

      // ---- 棋谱广场 ----
      '棋谱广场 · TDShogi': 'Gallery · TDShogi',
      '🏆 棋谱广场': '🏆 Gallery',
      '管理员精选的公开棋谱（赛事名局、经典对局）。点击任一局进入复盘。':
        'Public records picked by the admins (tournament highlights, classic games). Click one to review it.',
      全部标签: 'All tags',
      搜索: 'Search',
      '搜索双方名 / 标题 / 赛事': 'Search players / title / event',

      // ---- 棋谱列表 ----
      '棋谱 · TDShogi': 'Games · TDShogi',
      棋谱管理: 'My games',
      '🌐 棋谱广场 →': '🌐 Gallery →',
      '对局记录（仅自己的）': 'Your games only',
      全部结果: 'All results',
      先手胜: 'Black wins',
      后手胜: 'White wins',
      检索: 'Search',
      重置: 'Reset',
      '点击任意棋谱进入「复盘器」，可前进/后退、加书签、写评论、保存变着，并导出 KIF/CSA。':
        'Click any record to open the reviewer: step back and forth, add bookmarks and comments, save variations, and export KIF/CSA.',
      从左侧选择棋谱进入复盘器: 'Pick a record on the left to start reviewing',
      感想战式的复盘分析: 'Review and analysis',
      浏览公开棋谱: 'Browse the gallery',
      '关键词（选手名）': 'Keyword (player name)',
      '开局（如 7g7f,3c3d）': 'Opening moves (e.g. 7g7f,3c3d)',
      '手数范围（如 20-80）': 'Move range (e.g. 20-80)',
      // ---- 棋谱检索台（records-console.js 动态文案，2026-10-04 并入个人页）----
      // ⚠️ 词表按「整段文本节点精确匹配」翻译：`开局 ` / `{n} 手` / `{n} 局` / `进入复盘 →`
      //    都是拼接出来的，由 records-console.js 显式走 `I18N.t()`；
      //    `🌐 公开` / `🔒 私有` / 空结果提示是独立文本节点，DOM 扫描会自动翻译。
      '暂无匹配的对局。完成对局后可在此检索与复盘。':
        'No matching games yet — finish a game and you can search and review it here.',
      '{n} 手': '{n} moves',
      '{n} 局': '{n} games',
      '开局 ': 'Opening',
      '🌐 公开': '🌐 Public',
      '🔒 私有': '🔒 Private',
      '进入复盘 →': 'Review →',
      // 棋谱并入个人页后新增的静态标签（profile.html）
      对局记录与检索: 'Game records & search',
      全部棋谱: 'All games',

      // ---- 复盘器 ----
      '复盘 · TDShogi': 'Review · TDShogi',
      '加载棋谱中…': 'Loading record…',
      返回棋谱列表: 'Back to game list',
      先手: 'Black',
      後手: 'White',
      '🔄 翻转视角': '🔄 Flip viewpoint',
      '🛡️ 管理员：对局信息与展示设置': '🛡️ Admin: game info and visibility',
      标题: 'Title',
      轮次: 'Round',
      对局日期: 'Date',
      '标签（逗号分隔）': 'Tags (comma separated)',
      先手展示名: 'Black display name',
      後手展示名: 'White display name',
      结果说明: 'Result note',
      广场置顶: 'Pin in gallery',
      简介: 'Description',
      保存对局信息: 'Save game info',
      '私有（仅谱主可见）': 'Private (owner only)',
      '公开（广场可见）': 'Public (visible in gallery)',
      应用可见性: 'Apply visibility',
      // ⚠️ 这里只能写带全角冒号的原文：`显示`（设置面板的分组标题）已经在上面定义过，
      // 再写一遍会被**静默覆盖**（后写的同名字段会静默盖掉先写的）。
      '显示：': 'Show:',
      日式: 'Japanese',
      '◀ 上一手': '◀ Previous',
      '下一手 ▶': 'Next ▶',
      '末手 ⏭': 'Last ⏭',
      '✋ 自由摆放': '✋ Free placement',
      '↩️ 撤销摆放': '↩️ Undo placement',
      当前手: 'Current move',
      '↪ 添加变着': '↪ Add variation',
      保存变着: 'Save variation',
      本手已存在变着: 'A variation already exists here',
      '切换先手 / 后手视角': 'Switch Black / White viewpoint',
      展示在广场卡片上的一句话说明: 'One-line note shown on the gallery card',
      '在当前局面上自由摆放棋子（草稿，不入谱）': 'Place pieces freely on the current position (a draft, not recorded)',
      '评论当前手…': 'Comment on this move…',
      '走法 USI，如 7g7f 或 P*5e': 'Move in USI, e.g. 7g7f or P*5e',
      '说点什么…': 'Say something…',

      // ---- 2026-09-20 收尾补充（个人页入口 / 荣誉 / 举报按钮）----
      // ⚠️ 尾部符号**不在**宽松匹配的范围内（只处理"前缀 emoji"与空白），
      // 所以带尾巴的原文要各自登记一条。
      '查看详情 →': 'View details →',
      举报: 'Report',
      '查看个人页 →': 'View profile →',
      '正在查看个人页：': 'Viewing profile:',
      返回我的个人页: 'Back to my profile',
      '玩家 · ID: {id}': 'Player · ID: {id}',
      参赛: 'Entered',
      人工裁定: 'Awarded by admin',
      和: 'Draw',
      '已报名赛事，等这届赛程结束后会出现在这里。':
        'You are entered in a tournament; it will show up here once that tournament ends.',

      // ---- JS 提示语 / 动态按钮文案（2026-09-23 补齐，来源：`npm run i18n --js`）----
      // 这些大多走 `UI.toast()`，而 toast 会对整句调 `t()`（见 util.js 注释），
      // 所以**补一条就翻一条**；带变量的那几条在调用点用 `t('… {n} …', {n})`。
      '10分钟 + 30秒': '10 min + 30 sec',
      '15分钟 + 60秒': '15 min + 60 sec',
      '· 观战': '· Spectating',
      '⚠️ 断线 · 60秒内未重连将判你获胜': '⚠️ Disconnected · you win if it does not reconnect within 60 s',
      '✋ 自由摆棋中（本地草稿，不入谱不同步）': '✋ Free placement (local draft; not recorded or synced)',
      不限: 'No limit',
      两次输入的密码不一致: 'The two passwords do not match',
      '举办理由至少 10 个字（管理员据此审核）':
        'Reason for hosting: at least 10 characters (the admin reviews it)',
      '你好，请多指教': 'Hello, nice to meet you',
      '你已进入观战，欢迎交流！': 'You are now spectating — feel free to chat!',
      保存失败: 'Save failed',
      '保存失败，请重试': 'Save failed, please try again',
      '再来一局？': 'Play another game?',
      初始局面无法加书签: 'The starting position cannot be bookmarked',
      '加入成功，对局开始！': 'Joined — the game begins!',
      加载失败: 'Load failed',
      匹配: 'Match',
      '匹配成功！对局开始': 'Match found — the game begins',
      头像已更新: 'Avatar updated',
      '好棋！': 'Good move!',
      对局信息已保存: 'Game info saved',
      对方: 'Opponent',
      已公开到棋谱广场: 'Published to the game gallery',
      '已公开（广场可见）': 'Public (visible in the gallery)',
      已加书签: 'Bookmark added',
      已取消书签: 'Bookmark removed',
      已存档: 'Archived',
      已批准报名: 'Entry approved',
      已拒绝: 'Rejected',
      已拒绝报名: 'Entry rejected',
      已移出该报名者: 'Entry removed',
      已设为私有: 'Set to private',
      已退出登录: 'Signed out',
      '当前轮到 先手▲': 'Turn: Sente ▲',
      '当前轮到 後手△': 'Turn: Gote △',
      '房间密码需 4-8 位': 'Room password must be 4–8 characters',
      '房间已创建，等待对手加入': 'Room created — waiting for an opponent',
      报名中: 'Open for entry',
      '报名已提交，等待主办人批准': "Entry submitted — waiting for the organizer's approval",
      报名成功: 'Entry successful',
      '报名成功！名额已满，赛事自动开始':
        'Entry successful — the field is full, so the tournament starts automatically',
      报名结束时间必须晚于报名开始时间: 'Entry close must be after entry open',
      操作失败: 'Action failed',
      改名成功: 'Name changed',
      比赛开始时间不能早于报名结束时间: 'Start time cannot be earlier than entry close',
      比赛结束时间必须晚于比赛开始时间: 'End time must be after the start time',
      注册失败: 'Registration failed',
      '注册失败，请重试': 'Registration failed, please try again',
      演示: 'Demo',
      登录失败: 'Sign-in failed',
      '登录失败，请重试': 'Sign-in failed, please try again',
      '私人房间已创建，把房间码与密码发给好友':
        'Private room created — send the room code and password to your friend',
      稍等我一下: 'Give me a moment',
      网络错误: 'Network error',
      解说: 'Commentary',
      请填写用户名和密码: 'Please enter a username and password',
      请填写赛事名称: 'Please enter a tournament name',
      '请输入 6 位有效房间码': 'Please enter a valid 6-character room code',
      请输入名字: 'Please enter a name',
      谢谢指教: 'Thanks for the game',
      资料已保存: 'Profile saved',
      '赛事不存在，或已被删除。': 'This tournament does not exist or has been deleted.',
      '载入中…': 'Loading…',
      这手厉害: 'Great move',
      '链接里没有赛事 id，请从赛事列表进入。':
        'No tournament id in the link — please open it from the tournament list.',
      '🎤 正在由你演示（对方实时观看）': '🎤 You are playing the moves (the opponent watches live)',
      '🎤 正在由 {name} 演示': '🎤 {name} is playing the moves',
      '💤 演示暂停——点「我来演示」开始行棋':
        '💤 Demo paused — press "I will play the moves" to start moving',
      '🔄 视角·後手': '🔄 View · Gote',
      '🕐 审核中': '🕐 Under review',
      '🧑‍🔧 退出自由摆棋': '🧑‍🔧 Exit free placement',
      '（对阵已重算）': '(bracket recalculated)',
      '（已结束）': '(finished)',

      // ---- 补齐提取器修好后暴露的漏译 + 音效/BGM 选项（2026-09-26）----
      // 起因：i18n-report.js 的 stripComments 漏掉单行 `/* */` 的闭合，大段代码被当
      // 注释吃掉，报告一直假绿。修好后一次性暴露这批真缺口，逐条补齐。
      // 带 emoji 的词只收「去 emoji 的词干」（查词有 emoji 前缀宽松匹配，见 lookup）。
      '比赛中': 'In progress',
      '已通过': 'Approved',
      '你的报名被主办人拒绝': 'Your entry was rejected by the organizer',
      '举报已提交，管理员会尽快处理': 'Report submitted; an admin will review it shortly',
      '人数档位': 'Player count',
      '免审核（报名即参赛）': 'No approval needed (join instantly)',
      '关闭时用「点棋子 → 点目标格」两步走子，可减少误触': 'When off, moves take two taps (piece → square), reducing mis-taps',
      '创建赛事需要登录正式账号，请先登录': 'Creating a tournament needs a full account — please sign in first',
      '初始局面无法添加变着': 'Cannot add variations to the initial position',
      '初始局面无法评论': 'Cannot comment on the initial position',
      '删除这条评论？': 'Delete this comment?',
      '制勝': 'Victory',
      '取消赛事的原因（可留空）：': 'Reason for cancelling the tournament (optional):',
      '取消选手成绩': 'Disqualify player',
      '取消选手成绩：该选手所有对局判对手胜，并重算后续轮次': 'Disqualify: every game of this player becomes a loss and later rounds are recalculated',
      '变着已保存': 'Variation saved',
      '只能复盘自己的棋谱': 'You can only review your own games',
      '含吃子（音色更沉）': 'Includes captures (deeper tone)',
      '在聊天区显示「XX 进入/离开观战」；人多时可关掉避免刷屏': 'Show "XX joined/left" in chat; turn off in crowded rooms to avoid spam',
      '备注已更新': 'Note updated',
      '存档': 'Archive',
      '存档后主办人只读；系统也会在结束后 24 小时自动存档': 'After archiving it is read-only; the system also auto-archives 24h after the end',
      '审核拒绝': 'Reject',
      '审核通过': 'Approve',
      '对局开始！': 'Game started!',
      '对局结束': 'Game over',
      '局面尚未加载': 'Board not loaded yet',
      '已存档赛事仅管理员可编辑，且每次编辑都会留痕': 'Archived tournaments are admin-editable only, and every edit is logged',
      '已被移出': 'Removed',
      '已请求再来一局，等待对方同意…': 'Rematch requested, waiting for the opponent…',
      '已退出自由摆棋，回到推演谱最新一手': 'Left free placement; back to the latest analysis move',
      '开赛': 'Start event',
      '循环': 'Loop',
      '批准报名': 'Approve entry',
      '批准重赛（该场重打）': 'Approve rematch (replay this game)',
      '找不到可举报的对手': 'No opponent to report',
      '投了': 'Resigned',
      '报名审核': 'Entry review',
      '报名时间': 'Sign-up period',
      '报名被拒绝': 'Entry rejected',
      '拒绝报名': 'Reject entry',
      '接続切断': 'Disconnected',
      '提交创建申请': 'Submit creation request',
      '提交时间': 'Submitted at',
      '時間切れ': 'Time out',
      '本时剩余每跨过一个整分钟响一声': 'Chime at every whole minute of main time left',
      '棋子敲击': 'Piece strike',
      '棋盘四周显示 1–9 筋、一–九 段': 'Show 1–9 files and 一–九 ranks around the board',
      '棋谱不存在': 'Game record not found',
      '此身份已在其他窗口登录，本页已断开': 'This account signed in elsewhere; this page was disconnected',
      '没有可撤销的操作': 'Nothing to undo',
      '深层沉浸': 'Deep Immersion',
      '清空全部推演手，回到本谱终局局面？': 'Clear all analysis moves and return to the final position of this record?',
      '申请重赛': 'Request rematch',
      '登录后可报名参加本赛事。': 'Sign in to enter this tournament.',
      '确定开始比赛？开始后报名名单将被冻结。': 'Start the tournament? The entry list will be frozen.',
      '确定认输吗？': 'Resign now?',
      '空弦': 'Open String',
      '缺少棋谱 ID': 'Missing game record ID',
      '自由摆放已开启：移动/驹台放置/双击升变，翻页即丢弃': 'Free placement on: move / piece-stand placement / double-tap promote — discarded when paging',
      '自由摆放未开启': 'Free placement is off',
      '自由摆棋开启：任意移动/吃子/双击升变（本地草稿，不入谱不同步）': 'Free placement on: move / capture / double-tap promote (local draft, not saved to the record)',
      '詰み': 'Checkmate',
      '设置冠军': 'Set champion',
      '评论已保存': 'Comment saved',
      '评论已删除': 'Comment deleted',
      '评论已更新': 'Comment updated',
      '该对局已结束或不存在，即将返回大厅': 'This game is over or does not exist; returning to the lobby',
      '读秒每 10 秒报时；最后 10 秒逐秒': 'Byoyomi chimes every 10s, then every second in the last 10',
      '赛事备注（仅管理员可编辑，会记入编辑历史）：': 'Tournament note (admin-only, edits are logged):',
      '赛事已取消': 'Tournament cancelled',
      '赛事已存档': 'Tournament archived',
      '赛事已开始': 'Tournament started',
      '赛事结束': 'Tournament ended',
      '轮空直接晋级': 'Bye: advance without playing',
      '需主办人审核': 'Organizer approval required',
      '静弈': 'Quiet Game',
      '驳回重赛': 'Reject rematch',
      '默认关闭；对局进行中循环播放': 'Off by default; loops during play',
      '默认（合成音）': 'Default (synth)',
      '静音': 'Mute',
      '待主办人批准': 'Awaiting organizer approval',
      '待管理员审核': 'Awaiting admin review',
      '你已被主办人移出本赛事': 'You were removed from this tournament by the organizer',
      '已移出': 'Removed',
    },

    /**
     * 日本語。
     *
     * ⚠️ 与 en 不同，**这里有一条"与原文完全相同"是正常的**：本项目的界面文案大量沿用了
     * 将棋术语（先手/後手/詰み/香落ち/二枚落ち/入玉/持将棋…），而这些词在日语里就是原样。
     * 所以"译文不许与原文相同"那条**只对 en 生效**；
     * ja 换了一条更合适的自检：**不许出现明显的简体字**（飞/车/让/时/图/详…），
     * 那才说明是"从中文抄过来忘了改成日文写法"。
     */
    ja: {
      // ---- ナビゲーション・共通 ----
      首页: 'ホーム',
      对战: '対局',
      棋谱: '棋譜',
      赛事: '大会',
      个人: 'マイページ',
      管理后台: '管理コンソール',
      切换主题: 'テーマ切替',
      设置: '設定',
      语言: '言語',
      '个人 · 游客': 'マイページ · ゲスト',
      '个人 · 已登录账号': 'マイページ · ログイン中',
      复制: 'コピー',
      已复制: 'コピーしました',
      确定: 'OK',
      取消: 'キャンセル',
      关闭: '閉じる',
      返回: '戻る',
      保存: '保存',
      刷新: '更新',
      加载中: '読み込み中…',
      '加载中…': '読み込み中…',
      暂无: 'なし',
      暂无数据: 'データがありません',
      没有数据: 'データがありません',
      查看详情: '詳細を見る',
      在线: 'オンライン',
      离线: 'オフライン',
      未知: '不明',
      无名棋士: '名無し',
      系统: 'システム',
      你: 'あなた',

      // ---- 持ち時間 ----
      '10 分钟包干（标准比赛）': '10分切れ負け（標準）',
      '15 分钟 + 60 秒读秒': '15分 + 60秒秒読み',
      '10 分钟 + 30 秒读秒': '10分 + 30秒秒読み',
      '10 秒快棋': '10秒将棋',
      '10分钟包干': '10分',
      '15分+60秒': '15分+60秒',
      '10分+30秒': '10分+30秒',
      '10秒': '10秒',

      // ---- ホーム ----
      天锻将棋道场: '天鍛将棋道場',
      '日本将棋 · 在线实时对战 · 免注册即刻对局': '本将棋・オンライン対局・登録不要ですぐ指せる',
      '⚔️ 开始对局': '⚔️ 対局をはじめる',
      '🎲 随机观战': '🎲 ランダム観戦',
      在线人数: 'オンライン',
      对局中: '対局中',
      等待对局: '対局待ち',
      复盘中: '検討中',
      累计棋谱: '総棋譜数',
      三步开始你的将棋之旅: '3ステップではじめよう',
      立即开局: 'すぐに対局',
      '无需注册，打开就能玩。快速匹配在线对手，或生成房间码邀请好友来一局。':
        '登録不要ですぐ指せます。オンラインの相手とクイックマッチ、または部屋コードで友達を招待。',
      登记账号: 'アカウント登録',
      '注册正式账号，ELO 评级、胜绩与全部棋谱永久保存，游客数据可一键升级迁移。':
        '登録するとELOレーティング・戦績・棋譜が保存され、ゲストのデータもそのまま引き継げます。',
      复盘精进: '検討で上達',
      '每局自动存为标准 KIF/CSA 棋谱，复盘器支持书签、评论与变着研究。':
        '対局はKIF/CSA形式で自動保存。検討機能ではブックマーク・コメント・変化が使えます。',
      系统公告: 'お知らせ',
      ELO排行榜: 'ELOランキング',
      最新对局战报: '最新の対局結果',
      '查看我的棋谱 →': '自分の棋譜 →',
      将棋规则速查: '将棋のルール早見',
      '🎯 目标：将死对方的王（玉将）': '🎯 目的：相手の玉を詰ませる',
      '⬆️ 升变：进入敌阵可强化棋子': '⬆️ 成り：敵陣に入ると駒が強くなる',
      '🖐️ 打入：吃掉的棋子归你使用': '🖐️ 打つ：取った駒は自分の持ち駒',

      // ---- ロビー ----
      快速匹配: 'クイックマッチ',
      '点击后自动与在线棋手配对，无需房间码': '押すとオンラインの相手と自動でマッチングします（部屋コード不要）',
      '寻找对手中…': '対戦相手を探しています…',
      取消匹配: 'マッチング解除',
      创建房间: '部屋を作る',
      '生成 6 位房间码，邀请好友加入对局。': '6桁の部屋コードで友達を招待できます。',
      比赛时间: '持ち時間',
      '手合割（让子）': '手合割（駒落ち）',
      '不让子：双方各 20 枚，房主随机执先手，计入 ELO。':
        '駒落ちなし：お互い20枚、部屋主が先後ランダム、レーティング対象。',
      '🔒 私人房间': '🔒 プライベート部屋',
      '（不计 ELO，经验照常 · 不开放观战）': '（レーティング対象外・経験値は加算・観戦不可）',
      '房间密码（4-8 位，可留空表示不设密码）': '部屋パスワード（4〜8文字、空欄なら設定なし）',
      加入房间: '部屋に参加',
      '输入 6 位房间码': '6桁の部屋コードを入力',
      房间码: '部屋コード',
      房间号: '部屋コード',
      加入: '参加',
      观战: '観戦',
      '👁 观战（用房间码）': '👁 観戦（部屋コード）',
      进行中的对局: '対局中',
      '进行中的对局（观战）': '対局中（観戦）',
      '当前没有进行中的对局': '対局中の部屋はありません',
      人观战: '人観戦',
      房间对局: '部屋対局',
      快速对局: 'クイック対局',
      对战大厅: '対戦ロビー',
      '一键匹配在线对手，两人即开，实时对局。': 'オンラインの相手とすぐ対局できます。',
      开始匹配: 'マッチング開始',
      正在寻找对手中: '対戦相手を探しています…',
      '正在寻找对手…': '対戦相手を探しています…',
      点击下方按钮取消: '下のボタンでキャンセルできます',
      复制房间码: '部屋コードをコピー',
      '等待对手加入后自动开局…': '相手が入ると自動で対局が始まります…',
      '输入好友提供的 6 位房间码加入对局。': '友達から受け取った6桁の部屋コードを入力してください。',
      '输入房间码，如 AB3X7Q': '部屋コードを入力（例：AB3X7Q）',
      该房间需要密码: 'この部屋はパスワードが必要です',

      // ---- 手合割（駒落ち）----
      平手: '平手',
      香落ち: '香落ち',
      右香落ち: '右香落ち',
      角落ち: '角落ち',
      飛車落ち: '飛車落ち',
      飛香落ち: '飛香落ち',
      二枚落ち: '二枚落ち',
      四枚落ち: '四枚落ち',
      六枚落ち: '六枚落ち',
      八枚落ち: '八枚落ち',
      十枚落ち: '十枚落ち',
      让子: '駒落ち',
      上手: '上手',
      下手: '下手',
      参赛: '参加',
      人工裁定: '主催者裁定',

      // ---- 対局画面 ----
      房间: '部屋',
      对局: '対局',
      认输: '投了',
      再来一局: 'もう一局',
      请求再来一局: 'もう一局を申し込む',
      退出对局: '対局を退出',
      对手断线: '相手が切断しました',
      对手已断线: '相手が切断しています',
      '⚠️ 断线': '⚠️ 切断',
      '连接中…': '接続中…',
      对手: '相手',
      你已获胜: 'あなたの勝ち',
      你已落败: 'あなたの負け',
      和棋: '引き分け',
      未完成: '未完了',
      胜利: '勝ち',
      失败: '負け',
      胜: '勝ち',
      负: '負け',
      和: '分け',
      持驹: '持ち駒',
      观众: '観戦者',
      暂无观众: '観戦者はいません',
      操作: '操作',
      聊天: 'チャット',
      全部: 'すべて',
      发送: '送信',
      系统消息: 'システム',
      入玉宣言: '入玉宣言',
      举报对手: '相手を通報',
      举报: '通報',
      提交举报: '通報する',
      尚未走子: 'まだ指し手がありません',
      走子记录: '指し手',
      回放: '再生',
      '👁 观战中': '👁 観戦中',
      '🔄 视角·先手': '🔄 視点・先手',
      '🎤 感想战中': '🎤 検討中',
      '🙋 我来演示': '🙋 自分が動かす',
      '🤝 交给对方': '🤝 相手に渡す',
      '↩️ 待った': '↩️ 待った',
      '🗑 清空推演': '🗑 消去',
      '⏭ 回到最新': '⏭ 最新へ',
      '✋ 自由摆棋': '✋ 自由配置',
      '按规则行棋 · 不计入棋谱': 'ルール通りに指す・棋譜には残りません',
      观众进出提示: '観戦者の出入りを通知',
      '切换观战视角（先手 / 后手）': '観戦視点の切替（先手／後手）',
      音效开关: '効果音の切替',
      '补充说明（可选）': '補足（任意）',
      '说点什么…': '何か入力…',
      请稍等: 'しばらくお待ちください',
      轮到你走: 'あなたの番です',
      等待对手走子: '相手の着手を待っています',
      同意: '同意する',
      同意再来一局: 'もう一局に同意',
      已申请再来一局: 'もう一局を申し込みました',

      // ---- 設定 ----
      显示: '表示',
      棋子: '駒',
      音效: 'サウンド',
      主题: 'テーマ',
      深色: 'ダーク',
      浅色: 'ライト',
      跟随系统: 'システムに合わせる',
      棋盘坐标: '盤の座標',
      上一步高亮: '直前の手を強調',
      行棋音效: '着手音',
      触屏拖拽走子: 'タッチで駒を動かす',
      棋子图集: '駒のデザイン',
      金輝: '金輝',
      凌雲: '凌雲',
      分钟提醒音: '分アラート',
      读秒音: '秒読み音',
      落子音: '着手音',
      '对局 BGM': '対局BGM',
      关闭音效: 'オフ',
      默认: '既定',
      开启: 'オン',

      // ---- 棋譜・検討 ----
      棋谱管理: '自分の棋譜',
      复盘: '検討',
      开始: '最初',
      结束: '最後',
      上一步: '前へ',
      下一步: '次へ',
      首手: '初手',
      末手: '最終手',
      书签: 'ブックマーク',
      评论: 'コメント',
      变着: '変化',
      导入: 'インポート',
      导出: 'エクスポート',
      手数: '手数',
      结果: '結果',
      对局时间: '対局日時',
      用时: '所要時間',
      导出KIF: 'KIF出力',
      导出CSA: 'CSA出力',
      棋手赛事: '大会',
      往期赛事: '過去の大会',
      进行中的赛事: '開催中の大会',

      // ---- マイページ ----
      昵称: '名前',
      等级: 'レベル',
      战绩: '戦績',
      胜率: '勝率',
      赛事荣誉: '大会の戦績',
      夺冠: '優勝',
      亚军: '準優勝',
      四强: 'ベスト4',
      参赛赛事: '参加大会',
      夺冠率: '優勝率',
      还没有参加过赛事: 'まだ大会に参加していません',
      编辑资料: 'プロフィール編集',
      头像: 'アイコン',
      保存修改: '変更を保存',
      'ELO 积分': 'ELOレーティング',
      对局数: '対局数',
      平: '分け',
      'ELO 走势': 'ELOの推移',
      最近对局: '最近の対局',
      // ---- マイページのタブ（2026-10-04 棋譜をマイページへ統合）----
      概览: '概要',
      装扮: 'アイテム',
      我的装扮: 'マイアイテム',
      用户名: 'ユーザー名',
      密码: 'パスワード',
      确认密码: 'パスワード（確認）',
      手机号: '電話番号',
      棋风: '棋風',
      注册日期: '登録日',
      保存资料: '保存',
      改名: '名前を変更',
      返回我的个人页: '自分のページへ戻る',
      '正在查看个人页：': 'このページを表示中：',
      '玩家 · ID: {id}': 'プレイヤー · ID: {id}',
      '查看个人页 →': 'マイページを見る →',

      // ---- 大会 ----
      我的赛事: '自分の大会',
      赛事创建申请: '大会の申請',
      待审核: '承認待ち',
      已取消: '中止',
      报名: '参加登録',
      取消报名: '参加取消',
      已报名: '参加済み',
      报名名单: '参加者',
      批准: '承認',
      拒绝: '拒否',
      全部批准: 'まとめて承認',
      开始比赛: '対局開始',
      取消赛事: '大会を中止',
      存档赛事: 'アーカイブ',
      对阵表: 'トーナメント表',
      名次表: '順位表',
      赛程: '日程',
      冠军: '優勝',
      轮空: '不戦勝',
      主办: '主催',
      主办人: '主催者',
      管理员: '管理者',
      参赛人数: '参加人数',
      创建赛事: '大会を作成',
      赛事名称: '大会名',
      赛制: '形式',
      单败淘汰: 'トーナメント',
      瑞士制: 'スイス式',
      轮数: 'ラウンド数',
      报名开始: '参加受付開始',
      报名结束: '参加受付終了',
      比赛开始: '対局開始',
      比赛结束: '対局終了',
      提交申请: '申請する',
      '如：暑期棋王赛': '例：サマー将棋選手権',
      单败淘汰瑞士制: 'トーナメント／スイス式',
      '单败淘汰 / 瑞士制 · 报名满员自动开赛 · 赛事对局不计 ELO':
        'トーナメント／スイス式・定員で自動開始・大会の対局はレーティング対象外',
      循环赛待实装: 'リーグ戦（未実装）',
      '循环赛（待实装）': 'リーグ戦（未実装）',
      '瑞士制（积分编排）': 'スイス式',
      详情: '詳細',

      // ---- 棋譜広場 ----
      搜索: '検索',
      全部标签: 'すべてのタグ',
      棋谱列表: '棋譜一覧',

      // ---- ログイン・アカウント ----
      登录: 'ログイン',
      退出登录: 'ログアウト',
      注册: '登録',
      账号: 'アカウント',
      游客: 'ゲスト',
      已有账号登录: 'アカウントでログイン',
      注册新账号: '新しいアカウントを作る',
      注册并保留游客数据: '登録してゲストデータを引き継ぐ',

      // ---- サーバーからの主なメッセージ ----
      还没轮到你: 'まだあなたの番ではありません',
      非法走法: '反則手です',
      未知的手合割: '不明な手合割です',
      '你已在对局中，请先结束当前对局': 'すでに対局中です。先に今の対局を終えてください',
      对局尚未结束: '対局はまだ終わっていません',
      房间不存在: '部屋が見つかりません',
      房间已满: '部屋が満員です',
      需要密码: 'パスワードが必要です',
      密码错误: 'パスワードが違います',
      '请输入 6 位房间码': '6桁の部屋コードを入力してください',
      你不在对局中: '対局中ではありません',
      对手已离开: '相手が退出しました',
      服务器内部错误: 'サーバーエラー',
      '网络异常，正在重连…': '通信エラー、再接続しています…',
      已重新连接: '再接続しました',
      行动超时: '手番が切れました',
      '时间切れ': '時間切れ',

      // ---- ページタイトル ----
      'TDShogi · 在线将棋对战平台': 'TDShogi · オンライン将棋対局',
      'TDShogi · 猹狸的将棋道场': 'TDShogi · 将棋道場',
      '对战 · TDShogi': '対局 · TDShogi',
      '对局 · TDShogi': '対局 · TDShogi',
      '棋谱 · TDShogi': '棋譜 · TDShogi',
      '赛事 · TDShogi': '大会 · TDShogi',
      '赛事详情 · TDShogi': '大会詳細 · TDShogi',
      '个人 · TDShogi': 'マイページ · TDShogi',
      '复盘 · TDShogi': '検討 · TDShogi',
      '棋谱广场 · TDShogi': '棋譜広場 · TDShogi',
      平台实时数据: 'リアルタイム統計',
      三步开始: '3ステップではじめる',

      // ---- ホーム：ルール早見・時計の説明 ----
      '轮流走子，攻击对方的王使其无路可逃即为「詰み」（将死）获胜。被将军时必须应将；本平台服务端自动判定王手与将死。':
        '交互に手を指し、相手の玉を逃げ場のない状態にすれば「詰み」で勝ちです。王手は必ず受けます。王手・詰みの判定はサーバーが行います。',
      '棋子进入、离开或在对方三段阵地内移动时可以选择升变（翻面）：飞车→龙王、角行→龙马、银将/桂马/香车/步兵均获得金将走法。玉与金不能升变。':
        '敵陣に入る・出る・敵陣内で動くときに成れます（裏返す）：飛車→竜王、角行→竜馬、銀将・桂馬・香車・歩は金将の動きになります。玉と金は成れません。',
      '吃掉的对方棋子放入自己的驹台，之后可在任意空格「打入」重新上战场——这是将棋最独特的规则（二步、打步詰等禁手已由服务端校验）。':
        '取った相手の駒は自分の持ち駒になり、空いているマスに「打つ」ことができます。将棋ならではのルールです（二歩・打ち歩詰めなどの禁じ手はサーバーが判定します）。',
      '⏱ 持钟：包干与本手持读秒': '⏱ 時計：切れ負けと秒読み',
      '常规时制为每方「10+0」包干用时；快棋采用「0+10」形式——不设总时长，每手棋 10 秒读秒，超时即负。时间耗尽前留意读秒提示音。':
        '通常は1人「10+0」の切れ負け方式、10秒将棋は「0+10」形式（総持ち時間なし・1手10秒の秒読み・切れたら負け）です。時間がなくなる前に秒読み音にご注意ください。',

      // ---- 対局画面の残り ----
      '观众（': '観戦者（',
      '是否升变？': '成りますか？',
      不成: '不成',
      成: '成',
      '举报对手：作弊 / 辱骂 / 恶意挂机等': '相手を通報：不正行為・暴言・放置など',
      '入玉宣言：玉在敌阵 + 敌阵内 10 枚以上 + 点数先手 28 / 后手 27 以上，且自己手番、未被王手 → 宣言方胜（AJSA 规则）':
        '入玉宣言：玉が敵陣にあり、敵陣内に自分の駒が10枚以上、点数が先手28点／後手27点以上、自分の手番で王手されていない → 宣言側の勝ち（AJSAルール）',

      // ---- マイページの残り ----
      '当前为游客身份。注册账号后，你的对局、积分与棋谱将绑定到账号，可在任意浏览器登录继续。注册会保留当前游客的全部数据。':
        '現在はゲストです。アカウントを登録すると対局・レーティング・棋譜がアカウントに紐づき、どのブラウザからでもログインして続けられます。ゲストのデータはそのまま引き継がれます。',
      '已登录账号 · ID:': 'ログイン中 · ID:',
      '游客账号 · ID:': 'ゲスト · ID:',
      '🎨 换头像': '🎨 アイコン変更',
      '选一个头像（点击即生效）': 'アイコンを選ぶ（クリックで反映）',
      '📋 我的资料': '📋 プロフィール',
      '（不公开显示，仅管理员可见）': '（非公開・管理者のみ閲覧可）',
      '棋风（公开显示）': '棋風（公開）',
      不设定: '未設定',
      '居飞车·急战': '居飛車・急戦',
      '居飞车·持久战': '居飛車・持久戦',
      振飞车: '振り飛車',
      力战型: '力戦型',
      奇袭型: '奇襲型',
      接受型: '受け型',
      '注册日期：': '登録日：',
      '用户名（2-16 字符）': 'ユーザー名（2〜16文字）',
      '密码（至少 8 位）': 'パスワード（8文字以上）',
      点击更换头像: 'クリックしてアイコンを変更',
      '修改名字（12 字内）': '名前を変更（12文字以内）',
      '11 位手机号，留空清除': '11桁の電話番号（空欄で削除）',
      '账号名不可更改（与注册用户名一致）；如需更换请联系管理员。':
        'アカウント名は変更できません（ログイン用ユーザー名と同じです）。変更が必要な場合は管理者にご連絡ください。',
      '身份已在其他标签页变更，正在刷新…': '別のタブで身元が変更されました。再読み込みします…',
      '连接尚未就绪，请稍后再试': 'まだ接続できていません。しばらくしてからお試しください',
      '已退出登录，已切换为游客身份': 'ログアウトしました（ゲストに戻りました）',
      'ELO 与经验需为整数': 'ELOと経験値は整数で入力してください',
      'ELO/经验已保存': 'ELOと経験値を保存しました',

      // ---- 大会の残り ----
      '🏆 我要创建赛事': '🏆 大会を作成する',
      '← 返回全部赛事': '← 大会一覧へ戻る',
      '4 人': '4人',
      '8 人': '8人',
      '16 人': '16人',
      '32 人': '32人',
      '轮数（瑞士制）': 'ラウンド数（スイス式）',
      '按人数自动（推荐）': '人数に応じて自動（推奨）',
      '3 轮': '3ラウンド',
      '4 轮': '4ラウンド',
      '5 轮': '5ラウンド',
      '6 轮': '6ラウンド',
      '7 轮': '7ラウンド',
      '8 轮': '8ラウンド',
      '9 轮': '9ラウンド',
      '瑞士制按积分逐轮配对（强者遇强者、不重复对阵），没有淘汰——输一两场仍有机会。':
        'スイス式は勝ち点順に毎ラウンド組み合わせます（強豪同士・再対戦なし）。敗退はなく、1〜2敗でも優勝の可能性が残ります。',
      '人数为奇数时，每轮积分最低且未轮空过的一人轮空（视同胜）。':
        '参加者が奇数の場合、各ラウンドで勝ち点が最も低く、まだ不戦勝のない人が不戦勝になります（勝ちとして扱います）。',
      '举办理由（10–200 字，管理员据此审核）': '開催理由（10〜200字・管理者が確認します）',
      '报名需我审核（关闭则报名即参赛）': '参加に主催者の承認が必要（オフなら参加＝受付）',
      提交后进入: '送信すると',
      管理员审核: '管理者の承認',
      '，通过后才开放报名。': 'へ回り、承認後に参加受付が始まります。',
      主办人不会自动参赛: '主催者は自動では参加しません',
      '——想下棋请另外报名。': '— 指したい場合は別途お申し込みください。',
      '时间未填写的项视为「不限」。': '未入力の項目は「制限なし」とみなします。',
      '说明办赛目的、面向人群、赛程安排等': '開催の目的・対象・日程などを記入してください',
      已通过审核: '承認しました',
      已拒绝: '拒否しました',

      // ---- 棋譜一覧・広場 ----
      '🌐 棋谱广场 →': '🌐 棋譜広場 →',
      '对局记录（仅自己的）': '自分の対局のみ',
      全部结果: 'すべての結果',
      先手胜: '先手の勝ち',
      后手胜: '後手の勝ち',
      检索: '検索',
      重置: 'リセット',
      '点击任意棋谱进入「复盘器」，可前进/后退、加书签、写评论、保存变着，并导出 KIF/CSA。':
        '棋譜をクリックすると検討画面が開きます。前後の移動・ブックマーク・コメント・変化の保存、KIF/CSAの書き出しができます。',
      从左侧选择棋谱进入复盘器: '左の一覧から棋譜を選んでください',
      感想战式的复盘分析: '検討・感想戦モード',
      浏览公开棋谱: '公開棋譜を見る',
      '关键词（选手名）': 'キーワード（対局者名）',
      '开局（如 7g7f,3c3d）': '序盤（例：7g7f,3c3d）',
      '手数范围（如 20-80）': '手数範囲（例：20-80）',
      // ---- 棋譜検索台（records-console.js の動的文言、2026-10-04 マイページへ統合）----
      // ⚠️ `开局 ` / `{n} 手` / `{n} 局` / `进入复盘 →` は連結されるため records-console.js 側で
      //    明示的に `I18N.t()` を通す。`🌐 公开` / `🔒 私有` と空結果の案内は独立ノードなので自動翻訳。
      '暂无匹配的对局。完成对局后可在此检索与复盘。':
        '一致する対局はありません。対局を終えるとここで検索・検討できます。',
      '{n} 手': '{n} 手',
      '{n} 局': '{n} 局',
      '开局 ': '序盤',
      '🌐 公开': '🌐 公開',
      '🔒 私有': '🔒 非公開',
      '进入复盘 →': '検討へ →',
      // マイページ統合で追加された静的ラベル（profile.html）
      对局记录与检索: '対局記録と検索',
      全部棋谱: 'すべての棋譜',
      '🏆 棋谱广场': '🏆 棋譜広場',
      '管理员精选的公开棋谱（赛事名局、经典对局）。点击任一局进入复盘。':
        '管理者が選んだ公開棋譜（大会の名局・名対局）。クリックすると検討が開きます。',
      '搜索双方名 / 标题 / 赛事': '対局者名・タイトル・大会で検索',

      // ---- 検討画面 ----
      加载棋谱中: '棋譜を読み込み中…',
      '加载棋谱中…': '棋譜を読み込み中…',
      返回棋谱列表: '棋譜一覧へ戻る',
      先手: '先手',
      後手: '後手',
      '🔄 翻转视角': '🔄 視点を反転',
      '🛡️ 管理员：对局信息与展示设置': '🛡️ 管理者：対局情報と公開設定',
      标题: 'タイトル',
      轮次: 'ラウンド',
      对局日期: '対局日',
      '标签（逗号分隔）': 'タグ（カンマ区切り）',
      先手展示名: '先手の表示名',
      後手展示名: '後手の表示名',
      结果说明: '結果の説明',
      广场置顶: '広場でピン留め',
      简介: '紹介文',
      保存对局信息: '対局情報を保存',
      '私有（仅谱主可见）': '非公開（本人のみ）',
      '公开（广场可见）': '公開（広場に表示）',
      应用可见性: '公開設定を適用',
      '显示：': '表示：',
      日式: '日本語',
      '◀ 上一手': '◀ 前へ',
      '下一手 ▶': '次へ ▶',
      '末手 ⏭': '最終手 ⏭',
      '✋ 自由摆放': '✋ 自由配置',
      '↩️ 撤销摆放': '↩️ 配置を戻す',
      当前手: '現在の手',
      '↪ 添加变着': '↪ 変化を追加',
      保存变着: '変化を保存',
      本手已存在变着: 'この手には既に変化があります',
      '切换先手 / 后手视角': '先手／後手の視点を切替',
      展示在广场卡片上的一句话说明: '広場のカードに出す一行説明',
      '在当前局面上自由摆放棋子（草稿，不入谱）': '現在の局面に自由に駒を置く（下書き・棋譜には残りません）',
      '评论当前手…': 'この手にコメント…',
      '走法 USI，如 7g7f 或 P*5e': 'USI形式の指し手（例：7g7f、P*5e）',

      // ---- JS 提示語・動的ボタン文言（2026-09-23 追加、出典：`npm run i18n --js`）----
      // 大半は `UI.toast()` 経由で、toast が文全体を `t()` に掛ける（util.js 参照）。
      // 変数つきの数件は**呼び出し側**で `t('… {name} …', {name})` の形にしてある。
      '10分钟 + 30秒': '10分 + 30秒',
      '15分钟 + 60秒': '15分 + 60秒',
      '· 观战': '· 観戦',
      '⚠️ 断线 · 60秒内未重连将判你获胜': '⚠️ 切断 · 60秒以内に再接続しない場合、あなたの勝ちになります',
      '✋ 自由摆棋中（本地草稿，不入谱不同步）': '✋ 自由配置中（ローカルの下書き・棋譜に残らず同期もしません）',
      不限: '制限なし',
      两次输入的密码不一致: 'パスワードが一致しません',
      '举办理由至少 10 个字（管理员据此审核）': '開催理由は10文字以上（管理者が確認します）',
      '你好，请多指教': 'よろしくお願いします',
      '你已进入观战，欢迎交流！': '観戦に入りました。お気軽にどうぞ！',
      保存失败: '保存に失敗しました',
      '保存失败，请重试': '保存に失敗しました。もう一度お試しください',
      '再来一局？': 'もう一局指しますか？',
      初始局面无法加书签: '初期局面にはブックマークできません',
      '加入成功，对局开始！': '参加しました。対局開始！',
      加载失败: '読み込みに失敗しました',
      匹配: 'マッチング',
      '匹配成功！对局开始': 'マッチング成立！対局開始',
      头像已更新: 'アイコンを更新しました',
      '好棋！': '好手！',
      对局信息已保存: '対局情報を保存しました',
      对方: '相手',
      已公开到棋谱广场: '棋譜広場に公開しました',
      '已公开（广场可见）': '公開（広場に表示）',
      已加书签: 'ブックマークに追加しました',
      已取消书签: 'ブックマークを解除しました',
      已存档: 'アーカイブ済み',
      已批准报名: '参加を承認しました',
      已拒绝报名: '参加を拒否しました',
      已移出该报名者: 'その参加者を外しました',
      已设为私有: '非公開にしました',
      已退出登录: 'ログアウトしました',
      '当前轮到 先手▲': '現在の手番：先手▲',
      '当前轮到 後手△': '現在の手番：後手△',
      '房间密码需 4-8 位': '部屋パスワードは4〜8文字です',
      '房间已创建，等待对手加入': '部屋を作成しました。相手の参加を待っています',
      报名中: '参加受付中',
      '报名已提交，等待主办人批准': '参加を申請しました。主催者の承認を待っています',
      报名成功: '参加できました',
      '报名成功！名额已满，赛事自动开始': '参加できました！定員に達したため、大会は自動的に始まります',
      报名结束时间必须晚于报名开始时间: '参加受付終了は参加受付開始より後にしてください',
      操作失败: '操作に失敗しました',
      改名成功: '名前を変更しました',
      比赛开始时间不能早于报名结束时间: '対局開始は参加受付終了より早くできません',
      比赛结束时间必须晚于比赛开始时间: '対局終了は対局開始より後にしてください',
      注册失败: '登録に失敗しました',
      '注册失败，请重试': '登録に失敗しました。もう一度お試しください',
      演示: 'デモ',
      登录失败: 'ログインに失敗しました',
      '登录失败，请重试': 'ログインに失敗しました。もう一度お試しください',
      '私人房间已创建，把房间码与密码发给好友':
        'プライベート部屋を作成しました。部屋コードとパスワードを友達に送ってください',
      稍等我一下: 'ちょっと待ってください',
      网络错误: '通信エラー',
      解说: '解説',
      请填写用户名和密码: 'ユーザー名とパスワードを入力してください',
      请填写赛事名称: '大会名を入力してください',
      '请输入 6 位有效房间码': '有効な6桁の部屋コードを入力してください',
      请输入名字: '名前を入力してください',
      谢谢指教: 'ありがとうございました',
      资料已保存: 'プロフィールを保存しました',
      '赛事不存在，或已被删除。': '大会が存在しないか、削除されています。',
      '载入中…': '読み込み中…',
      这手厉害: '見事な一手',
      '链接里没有赛事 id，请从赛事列表进入。': 'リンクに大会IDがありません。大会一覧から開いてください。',
      '🎤 正在由你演示（对方实时观看）': '🎤 あなたが動かしています（相手はリアルタイムで観戦中）',
      '🎤 正在由 {name} 演示': '🎤 {name} が動かしています',
      '💤 演示暂停——点「我来演示」开始行棋':
        '💤 デモは一時停止中。「自分が動かす」を押すと指せます',
      '🔄 视角·後手': '🔄 視点・後手',
      '🕐 审核中': '🕐 審査中',
      '🧑‍🔧 退出自由摆棋': '🧑‍🔧 自由配置を終了',
      '（对阵已重算）': '（組み合わせを再計算しました）',
      '（已结束）': '（終了）',
      // `--js` 扫描才暴露的两条：en 词典里早有（In progress / Finished），ja 漏了
      进行中: '進行中',
      已结束: '終了',

      // ---- 2026-09-26：与 en 同批补齐（提取器修复后暴露的漏译 + 音效/BGM 选项）----
      '比赛中': '対戦中',
      '已通过': '承認済み',
      '你的报名被主办人拒绝': 'あなたの参加申込は主催者に拒否されました',
      '举报已提交，管理员会尽快处理': '通報を送信しました。管理者がまもなく対応します',
      '人数档位': '人数枠',
      '免审核（报名即参赛）': '承認不要（申込後すぐに参加可能）',
      '关闭时用「点棋子 → 点目标格」两步走子，可减少误触': 'オフにすると「駒をタップ→升目をタップ」の2手で指せます。誤タップが減ります',
      '创建赛事需要登录正式账号，请先登录': '大会の作成には正式アカウントが必要です。先にログインしてください',
      '初始局面无法添加变着': '初期局面には変化手を追加できません',
      '初始局面无法评论': '初期局面にはコメントできません',
      '删除这条评论？': 'このコメントを削除しますか？',
      '制勝': '制勝',
      '取消赛事的原因（可留空）：': '大会を中止する理由（入力は任意）：',
      '取消选手成绩': '選手の成績を取り消す',
      '取消选手成绩：该选手所有对局判对手胜，并重算后续轮次': '成績を取り消す：この選手の全対局は不戦敗とし、以降のラウンドを再計算します',
      '变着已保存': '変化手を保存しました',
      '只能复盘自己的棋谱': '自分の棋譜のみ復盤できます',
      '含吃子（音色更沉）': '駒取りの音付き（より低く）',
      '在聊天区显示「XX 进入/离开观战」；人多时可关掉避免刷屏': 'チャットに「XX が観戦に入室/退室」を表示。人が多いときはオフにできます',
      '备注已更新': 'メモを更新しました',
      '存档': 'アーカイブ',
      '存档后主办人只读；系统也会在结束后 24 小时自动存档': 'アーカイブ後は主催者も読み取り専用。終了24時間後に自動アーカイブされます',
      '审核拒绝': '審査却下',
      '审核通过': '審査承認',
      '对局开始！': '対局開始！',
      '对局结束': '対局終了',
      '局面尚未加载': '局面はまだ読み込まれていません',
      '已存档赛事仅管理员可编辑，且每次编辑都会留痕': 'アーカイブ済み大会は管理者のみ編集可能で、編集ごとに履歴が残ります',
      '已被移出': '移出されました',
      '已请求再来一局，等待对方同意…': '再戦を申し込みました。相手の同意を待っています…',
      '已退出自由摆棋，回到推演谱最新一手': '自由配置を終了し、検討の最新手に戻りました',
      '开赛': '大会開始',
      '循环': 'ループ',
      '批准报名': '参加を承認',
      '批准重赛（该场重打）': '再戦を承認（この対局を再実施）',
      '找不到可举报的对手': '通報できる相手が見つかりません',
      '投了': '投了',
      '报名审核': '参加審査',
      '报名时间': '申込期間',
      '报名被拒绝': '参加申込は拒否されました',
      '拒绝报名': '参加を拒否',
      '接続切断': '接続切断',
      '提交创建申请': '作成申請を送信',
      '提交时间': '送信日時',
      '時間切れ': '時間切れ',
      '本时剩余每跨过一个整分钟响一声': '本残りが1分ごとに一音鳴ります',
      '棋子敲击': '駒の音',
      '棋盘四周显示 1–9 筋、一–九 段': '盤の周囲に筋（1–9）・段（一–九）を表示',
      '棋谱不存在': '棋譜が見つかりません',
      '此身份已在其他窗口登录，本页已断开': 'このアカウントは別のウィンドウでログインしました。本ページは切断されました',
      '没有可撤销的操作': '元に戻せる操作がありません',
      '深层沉浸': '深層没入',
      '清空全部推演手，回到本谱终局局面？': '検討手をすべて消して終局局面に戻りますか？',
      '申请重赛': '再戦を申請',
      '登录后可报名参加本赛事。': 'ログインするとこの大会に参加申込できます。',
      '确定开始比赛？开始后报名名单将被冻结。': '大会を開始しますか？開始後は参加者が固定されます。',
      '确定认输吗？': '投了しますか？',
      '空弦': '空弦',
      '缺少棋谱 ID': '棋譜 ID がありません',
      '自由摆放已开启：移动/驹台放置/双击升变，翻页即丢弃': '自由配置オン：移動・駒台配置・ダブルタップ成り。ページ送りで破棄されます',
      '自由摆放未开启': '自由配置はオフです',
      '自由摆棋开启：任意移动/吃子/双击升变（本地草稿，不入谱不同步）': '自由配置オン：自由な移動・取り・ダブルタップ成り（ローカル下書き、棋譜には残りません）',
      '詰み': '詰み',
      '设置冠军': '優勝者を設定',
      '评论已保存': 'コメントを保存しました',
      '评论已删除': 'コメントを削除しました',
      '评论已更新': 'コメントを更新しました',
      '该对局已结束或不存在，即将返回大厅': 'この対局は終了したか存在しません。ロビーに戻ります',
      '读秒每 10 秒报时；最后 10 秒逐秒': '秒読みは10秒ごと、最後の10秒は毎秒',
      '赛事备注（仅管理员可编辑，会记入编辑历史）：': '大会メモ（管理者のみ編集可、編集履歴に記録）：',
      '赛事已取消': '大会は中止されました',
      '赛事已存档': '大会をアーカイブしました',
      '赛事已开始': '大会は開始しました',
      '赛事结束': '大会終了',
      '轮空直接晋级': '不戦（BYE）で次へ進出',
      '需主办人审核': '主催者の承認が必要です',
      '静弈': '静弈',
      '驳回重赛': '再戦を却下',
      '默认关闭；对局进行中循环播放': '既定はオフ。対局中にループ再生',
      '默认（合成音）': '既定（合成音）',
      '静音': 'ミュート',
      '待批准': '承認待ち',
      '待主办人批准': '主催者の承認待ち',
      '待管理员审核': '管理者の審査待ち',
      '你已被主办人移出本赛事': 'あなたは主催者によりこの大会から移出されました',
      '已移出': '移出済み',
    },
  };

  // ==================================================================
  // 核心
  // ==================================================================
  const key = STORAGE_KEY;
  let locale = 'zh-CN';
  try {
    const saved = localStorage.getItem(key);
    if (saved && LOCALES.some((l) => l.id === saved)) locale = saved;
  } catch (_) { /* 隐私模式下 localStorage 会抛错：用默认语言即可，不影响对局 */ }

  /** 词条原文（DOM 节点原始中文）→ 避免切回中文时"查英文表" */
  const srcOf = new WeakMap();
  let observer = null;

  /** 去空白索引：中文排版里空格不承载语义，而「天锻将棋 道场」这类写法很常见 */
  const normIdx = {};
  function indexOf(l) {
    if (!normIdx[l]) {
      const m = new Map();
      for (const [k, v] of Object.entries(DICT[l] || {})) {
        const nk = k.replace(/\s+/g, '');
        if (!m.has(nk)) m.set(nk, v);
      }
      normIdx[l] = m;
    }
    return normIdx[l];
  }

  /** 开头的 emoji/图形字符（含变体选择符与 ZWJ），如「🏠 创建房间」的前缀 */
  const LEAD_EMOJI = /^((?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)+)/u;

  /**
   * 查词，三级宽松匹配（都是**安全**的：只会跨过空白与"开头图标"这类排版差异，
   * 不会把另一句话当成同一句）。
   *
   * 1. 整段精确匹配；
   * 2. 去掉全部空白再匹配（`天锻将棋 道场` ↔ `天锻将棋道场`）；
   * 3. 前缀 emoji **原样保留**、其余部分再匹配（`🏠 创建房间` → `🏠 ` + Create a room）。
   *
   * 有了第 2、3 条，词典里就不必为「带 emoji 的同一个词」再抄一遍，
   * 否则每加一个图标都要多维护一条，迟早漏。
   */
  function lookup(l, s) {
    const d = DICT[l];
    if (!d) return undefined;
    if (Object.prototype.hasOwnProperty.call(d, s)) return d[s];
    const idx = indexOf(l);
    const ns = s.replace(/\s+/g, '');
    if (idx.has(ns)) return idx.get(ns);
    const m = LEAD_EMOJI.exec(s);
    if (m) {
      const rest = s.slice(m[0].length);
      if (Object.prototype.hasOwnProperty.call(d, rest)) return m[0] + d[rest];
      const rn = rest.replace(/\s+/g, '');
      if (idx.has(rn)) return m[0] + idx.get(rn);
    }
    return undefined;
  }

  function subst(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
  }

  /**
   * 取译文。
   * @param {string} text 中文原文（找不到译文时**原样返回**——宁可显示中文，也不要显示 key）
   * @param {object} [vars] `{n}` 变量
   */
  function t(text, vars) {
    if (text == null) return text;
    const s = String(text);
    if (locale === 'zh-CN') return subst(s, vars);
    const hit = lookup(locale, s);
    return subst(hit === undefined ? s : hit, vars);
  }

  /**
   * 算出某节点应显示的内容：用**原文**的首尾空白包住译文（缩进/换行是排版的一部分，不能吃掉）。
   *
   * ⚠️⚠️ 入参只有「**固定不变的原文**」与译文，**故意不接收"节点当前的内容"**。
   *
   * 2026-09-20 事故（用户报"反复切语言直接卡死浏览器"）：原实现是
   * `next = 当前内容的首部空白 + 译文 + 当前内容的尾部空白`，
   * 于是**译文自身首尾带空白**时（本仓库真出现过 3 条：`' — sign up…'`、`'Viewing profile: '`、
   * `'　— 指したい…'`），每写一次就多出一层空白：
   *   写入 → MutationObserver(characterData) → translateNode → 再写入 → …… **无限微任务循环**，
   * 主线程被彻底占满（浏览器卡死），文本还会无限膨胀。
   *
   * 只依赖原文 ⇒ 结果是个**常数** ⇒ 写完一次后 `node.textContent === next` 恒成立 ⇒
   * 循环在**结构上不可能**发生（不靠"词典里别写脏数据"来保证）。
   */
  function nodeContent(raw, translated) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    return m ? m[1] + translated + m[3] : translated;
  }

  function translateNode(node) {
    const hasSrc = srcOf.has(node);
    const raw = hasSrc ? srcOf.get(node) : node.textContent;
    if (!raw || !raw.trim()) return;
    if (!hasSrc) srcOf.set(node, raw);
    const next = nodeContent(raw, t(raw.trim()));
    if (node.textContent !== next) { // 相同则不写，避免触发观察器空转
      node.textContent = next;
      noteWrite();
    }
  }

  // ==================================================================
  // 写入风暴熔断（安全网）
  //
  // 上面"结论只依赖原文"已经从**结构上**堵住了自激，这里再兜一层：
  // 万一将来又冒出某种自激（新代码、新页面、新的动态渲染方式），
  // 宁可**停用自动翻译**（界面退回中文），也绝不允许把浏览器卡死。
  //
  // ⚠️ 只统计**观察器回调里**产生的写入：`setLocale()` 主动全量重扫时
  // 大页面本来就会写上万次，那是正常的，不能算风暴。
  // ==================================================================
  const WRITES_PER_SECOND_LIMIT = 5000;
  let writeWindowStart = 0;
  let writesInWindow = 0;
  let inObserver = false;
  let observerTripped = false;
  let totalWrites = 0;

  function noteWrite() {
    totalWrites++;
    if (!inObserver || observerTripped) return; // 主动重扫不算，已熔断不再统计
    const now = Date.now();
    if (now - writeWindowStart > 1000) { writeWindowStart = now; writesInWindow = 0; }
    writesInWindow++;
    if (writesInWindow > WRITES_PER_SECOND_LIMIT) {
      observerTripped = true;
      if (observer) { try { observer.disconnect(); } catch (_) { /* 忽略 */ } observer = null; }
      console.warn('[i18n] 检测到 DOM 写入风暴，已停用自动翻译以免卡死页面'
        + '（界面会退回中文；重新加载页面即可恢复。如需手动重扫：I18N.apply(document.body)）');
    }
  }

  const ATTRS = ['placeholder', 'title', 'aria-label'];

  function translateEl(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const raw = el.getAttribute(a);
      if (!raw || !raw.trim()) continue;
      const out = t(raw.trim());
      if (out !== raw) el.setAttribute(a, out);
    }
  }

  /** 扫描一棵子树（静态页面加载时、或切换语言时、或 JS 渲染出新内容后） */
  function apply(root) {
    if (locale === 'zh-CN') return; // 中文：不需要做任何事（默认语言零开销）
    const node = root || document.body;
    if (!node) return;
    if (node.nodeType === 3) { translateNode(node); return; }
    if (node.nodeType === 1) translateEl(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === 3) {
        // 跳过 style/script 里的文本
        const p = n.parentNode;
        if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE')) continue;
        translateNode(n);
      } else {
        translateEl(n);
      }
    }
  }

  /** 切换语言：把已翻译的节点按原文重扫一遍，并通知页面重渲染动态文案 */
  function setLocale(id) {
    if (!LOCALES.some((l) => l.id === id)) return false;
    locale = id;
    try { localStorage.setItem(key, id); } catch (_) {}
    // ⚠️ 直接写 locale id（'zh-CN' / 'en' / 'ja' 本身就是合法的 BCP-47）；
    // 别写成"非 en 就当 zh-CN"——加了日语之后那样会把 ja 标成 zh-CN。
    if (document.documentElement) document.documentElement.lang = id;
    // 先把已有节点**还原成原文**再扫描：否则英文会被当成"原文"再查一次表
    // （守卫 DOM 能力：单元测试里没有 document.querySelectorAll，不该因此抛错）
    if (document.querySelectorAll) {
      document.querySelectorAll('*').forEach((el) => {
        if (el.childNodes) {
          el.childNodes.forEach((n) => {
            if (n.nodeType === 3 && srcOf.has(n)) n.textContent = srcOf.get(n);
          });
        }
      });
    }
    apply(document.body);
    startObserver();
    // 导航由 JS 渲染（不在静态 HTML 里），语言一变得主动更新一次。
    // ⚠️ 只更新**文字**、绝不重建元素：重建会换掉用户正在点的语言按钮，
    // 连点时会丢 click → 看起来像卡死（见 nav.js 的 `applyLocale` 注释）。
    if (window.NAV && window.NAV.applyLocale) { try { window.NAV.applyLocale(); } catch (_) {} }
    return true;
  }

  function current() {
    return LOCALES.find((l) => l.id === locale) || LOCALES[0];
  }

  /** 轮换到下一种语言（导航栏那个小按钮用） */
  function cycle() {
    const i = LOCALES.findIndex((l) => l.id === locale);
    return setLocale(LOCALES[(i + 1) % LOCALES.length].id);
  }

  /**
   * JS 动态渲染后如果调用 `apply()` 不方便，就靠观察器兜住。
   * ⚠️ 只在非中文时启用——中文用户的默认路径上不该多一个全局观察器。
   */
  function startObserver() {
    // ⚠️ `observerTripped` 之后**不再自动重挂**：能触发一次风暴的东西会一直触发，
    // 自动重挂等于"熔断器自己复位"，会把浏览器再卡死一次。
    if (observerTripped || observer || locale === 'zh-CN' || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver((records) => {
      if (observerTripped) return;
      inObserver = true;
      try {
        for (const r of records) {
          if (r.type === 'characterData') { translateNode(r.target); continue; }
          r.addedNodes.forEach((n) => {
            if (n.nodeType === 1 || n.nodeType === 3) apply(n);
          });
        }
      } finally { inObserver = false; }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /**
   * 按**当前语言**格式化日期 / 时间。
   *
   * ⚠️ 各页面原先到处写死 `toLocaleString('zh-CN')`（2026-09-20 修）：语言切到英/日文后
   * **日期还是中文格式**，界面一眼就能看出"翻了一半"。语言是全局开关，日期格式得跟着走。
   *
   * - `fmtDate(ts, opts)` 只出年月日（`toLocaleDateString`）
   * - `fmt(ts, opts)` 出年月日 + 时分秒（`toLocaleString`）
   * - 第二参数原样透传（如 `{ month: '2-digit', ... }`）；空值/非法日期返回 `''`
   *   （调用方可以 `I18N.fmt(ts) || '—'` 自己决定占位符）
   */
  function fmt(ts, opts) {
    const d = new Date(ts);
    if (!ts || isNaN(d.getTime())) return '';
    try { return d.toLocaleString(locale, opts); } catch (_) { return d.toLocaleString('zh-CN', opts); }
  }

  function fmtDate(ts, opts) {
    const d = new Date(ts);
    if (!ts || isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(locale, opts); } catch (_) { return d.toLocaleDateString('zh-CN', opts); }
  }

  function init() {
    if (document.documentElement) document.documentElement.lang = locale;
    apply(document.body);
    startObserver();
  }

  window.I18N = {
    LOCALES,
    t,
    apply,
    setLocale,
    cycle,
    current,
    fmt,
    fmtDate,
    init,
    /** 仅供测试与工具：词典本体 + 查词函数（`scripts/i18n-report.js` 用它算覆盖率） */
    _dict: DICT,
    _lookup: lookup,
    /** 仅供测试：合成规则。「翻译必须收敛」这条不变量由它保证（人工自查，暂无自动化用例） */
    _nodeContent: nodeContent,
    /** 仅供测试：写入计数 + 熔断状态 */
    _stats: () => ({ writes: totalWrites, tripped: observerTripped }),
  };
  window.t = t; // JS 里直接 `t('...')`（与其它全局工具一致，本项目无模块系统）

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ==== js/nav.js ==== */
/**
 * nav.js — 全局导航渲染与游客身份
 *
 * 页面共用：左上品牌 TDShogi，右上 首页/对战/棋谱/赛事/个人 五页导航。
 * 游客身份存 localStorage（键 tdshogi_guest）。
 */
(function (global) {
  const GUEST_KEY = 'tdshogi_guest';
  const THEME_KEY = 'tdshogi_theme';
  const ADMIN_KEY = 'tdshogi_admin_token'; // 与 admin.js 的 ADMIN_KEY 保持一致

  function getGuest() {
    // 名字以服务端 identify() 为权威来源（解决「客户端/服务端名不一致」导致
    // 同一玩家在大厅/对局/历史/个人页显示不同名字的 ID 混乱问题）。
    // 首次访问只生成 id，name 在 hello 时由 API 注入。
    let g = null;
    try { g = JSON.parse(localStorage.getItem(GUEST_KEY)); } catch (_) {}
    if (!g || !g.id) {
      g = { id: genId(), name: '' };
      saveGuest(g);
    }
    // 持有证明（B1）：老数据惰性补发——没有 key 就生成一个并持久化。
    // 它随 WS 连接（?key=）上行，服务端首次见到即绑定为该会话的 secret；此后改名/换头像必须带对。
    if (!g.key) { g.key = genKey(); saveGuest(g); }
    return g;
  }

  function saveGuest(g) {
    localStorage.setItem(GUEST_KEY, JSON.stringify(g));
  }

  /**
   * hello 到达后用服务端返回的名字更新本地身份，并同步刷新导航栏徽章。
   * 解决「客户端 randomName 与服务端 identify name 不一致」导致的 ID 混乱。
   */
  function updateUserName(name) {
    name = String(name || '').trim().slice(0, 16) || '无名棋士';
    const g = getGuest();
    if (g.name === name) return;
    g.name = name;
    saveGuest(g);
    // 刷新导航栏用户徽章（可能跨页未重渲染）
    const badge = document.querySelector('.nav-user span');
    if (badge) badge.textContent = name;
  }

  /**
   * 头像到达后更新（2026-09-20）：写进本地 guest 记录并刷新导航徽标。
   * 服务端在 `hello` 里下发头像，所以任意页面一进来就能显示。
   */
  function updateAvatar(avatar) {
    if (!avatar) return;
    const g = getGuest();
    if (g.avatar === avatar) return;
    g.avatar = avatar;
    saveGuest(g);
    const el = document.querySelector('.nav-user .nav-avatar');
    if (el && global.UI) {
      if (global.UI.setAvatarContent) global.UI.setAvatarContent(el, avatar, g.name);
      else if (global.UI.avatarGlyph) el.textContent = global.UI.avatarGlyph(avatar, g.name);
    }
  }

  function genId() {
    let s = '';
    const hex = '0123456789abcdef';
    for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }

  /**
   * 生成 64 位 hex 持有证明（B1）。
   * 优先用 crypto.getRandomValues（现代浏览器）；没有则退化为 Math.random
   * —— 该 key 仅作游客会话持有证明（非口令），弱随机时影响有限，但属已知降级（见 SECURITY.md）。
   */
  function genKey() {
    try {
      if (global.crypto && global.crypto.getRandomValues) {
        const b = new Uint8Array(32);
        global.crypto.getRandomValues(b);
        return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) { /* 退化为弱随机 */ }
    let s = '';
    const hex = '0123456789abcdef';
    for (let i = 0; i < 64; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }

  function randomName() {
    const list = ['无名棋士', '一歩名人', '飛車使い', '銀将', '桂馬', '香車', '角行', '竜王', '棋聖', '玉将'];
    return list[Math.floor(Math.random() * list.length)];
  }

  const NAV = [
    { id: 'home', label: '首页', href: 'index.html' },
    { id: 'lobby', label: '对战', href: 'lobby.html' },
    // 2026-10-04：顶部导航「棋谱」项移除 —— 棋谱检索台已并入个人页「棋谱」标签
    // （history.html 改为跳转）。棋谱广场入口仍在 gallery.html 与个人页棋谱标签。
    { id: 'tournaments', label: '赛事', href: 'tournaments.html' },
    { id: 'profile', label: '个人', href: 'profile.html' },
  ];

  /**
   * 本机是否已登录管理员（localStorage 持有 admin token）。
   * 注意：这只是「入口可见性」，不是权限校验——真正的鉴权始终在服务端 admin.verify。
   */
  function isAdminSession() {
    try { return !!localStorage.getItem(ADMIN_KEY); } catch (_) { return false; }
  }

  /**
   * 管理后台入口 HTML。普通用户一律不渲染（PLAN §J5：不暴露后台入口）；
   * 本机登录过管理员才显示，方便管理员自己进出。
   */
  function adminEntryHtml() {
    if (!isAdminSession()) return '';
    return `<a class="admin-entry" href="admin.html" title="管理后台">🛡️</a>`;
  }

  /**
   * 渲染导航栏。
   * @param {string} current 当前页 id（'home'|'lobby'|'history'|'tournaments'|'profile'）
   */
  function getTheme() {
    // 主题的唯一数据源是 Settings（PLAN §S1）；Settings 未加载时回退旧键，保证单独打开也不炸
    if (global.Settings) return global.Settings.get('theme');
    return localStorage.getItem(THEME_KEY) || 'dark';
  }

  function applyTheme() {
    if (global.Settings) { global.Settings.apply('theme'); return; }
    const theme = getTheme();
    document.documentElement.classList.toggle('theme-light', theme === 'light');
    // ⚠️ 按 **id** 取，不要用 `querySelector('.theme-toggle')`（取"第一个"）：
    // 语言切换按钮（2026-09-20 新增）复用了同一个类名，按类名取会命中语言按钮，
    // 把它的「中/EN」覆写成 🌙 —— 两个按钮长得一样，排查起来很费劲。
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }

  // 多语言（PLAN §Z5）：导航文案走 `t()`；`i18n.js` 万一没加载（或页面漏引）就原样显示中文，
  // 绝不让"漏引一个 script"变成整页导航空白。
  function tr(s) {
    return global.I18N ? global.I18N.t(s) : s;
  }
  /** 语言按钮上显示当前语言（点一下切到下一种） */
  function localeShort() {
    return global.I18N ? global.I18N.current().short : '中';
  }

  function toggleLocale() {
    if (!global.I18N) return;
    global.I18N.cycle();
  }

  /**
   * 语言切换后**就地**更新导航文案（**不重建元素**）。
   *
   * ⚠️ 这里绝不能用 `nav.innerHTML = ...` 整块重建：**语言按钮就在导航里**，
   * 重建会把用户"正在点的那个按钮"换掉 —— `mousedown` 与 `mouseup` 落在两个不同元素上
   * 就不再产生 `click` 事件，于是"连点几下之后点了没反应"，看起来像卡死。
   * （2026-09-20 用户反馈"反复点切换语言会卡死"，根因就是这个；
   *   实测切语言本身只要几毫秒，12k 节点也才 36ms，慢的从来不是词典与扫描。）
   *
   * 导航文案由 JS 渲染、不在静态 HTML 里，所以语言一变必须**主动更新一次** ——
   * 但只能是"改文字"，不能是"换元素"。
   */
  function applyLocale() {
    document.querySelectorAll('.nav-links a[data-nav]').forEach((a) => {
      const item = NAV.find((n) => n.id === a.getAttribute('data-nav'));
      if (item) a.textContent = tr(item.label);
    });
    const lang = document.getElementById('langToggle');
    if (lang) { lang.textContent = localeShort(); lang.title = tr('语言'); }
    const theme = document.getElementById('themeToggle');
    if (theme) theme.title = tr('切换主题');
    const settings = document.getElementById('settingsToggle');
    if (settings) settings.title = tr('设置');
    const user = document.querySelector('.nav-user');
    if (user) {
      const g = getGuest();
      const isAcc = typeof g.id === 'string' && g.id.includes('.');
      user.title = isAcc ? tr('个人 · 已登录账号') : tr('个人 · 游客');
    }
  }

  // ⚠️ 2026-10-02 体验修复：多标签页身份同步（账号页 / 导航通用）。
  //
  // 背景：游客与账号身份都持久化在 localStorage（`GUEST_KEY`）。在一个标签页登录 /
  // 登出 / 换号后，**其它已打开的标签页**里 localStorage 虽然变了，但内存中的 `guest`、
  // 导航徽章、以及已经建立的 WS 连接身份（账号靠令牌）都还是旧的 —— 表现为"另一个标签
  // 仍显示已登录 / 旧名字"，继续在那页操作还可能串到旧身份。
  //
  // 这里监听 `storage` 事件（**只在其它标签页触发**，本标签页的改动不会回调自己，
  // 天然没有回环）：同一身份只改了名字 / 头像 → 就地刷新显示；身份本身变了 →
  // 整页重载（WS 才会用新身份重连），并借 profile.js 同款 flash 机制给一句可见提示。
  let renderedIdentityId = null; // 本标签当前"已渲染 / 已连接"的身份 id，用于判断身份是否变了
  function onStorageSync(e) {
    if (e && e.key && e.key !== GUEST_KEY) return; // 只关心身份键（主题 / 管理员键无关）
    let next = null;
    try { next = JSON.parse(localStorage.getItem(GUEST_KEY)); } catch (_) { return; }
    if (!next || !next.id) return;
    if (renderedIdentityId === null) { renderedIdentityId = next.id; return; } // 还没渲染：交给 renderNav
    if (next.id === renderedIdentityId) {
      // 同一身份，只是名字 / 头像变了（例如另一标签改了名）：就地刷新，不动连接
      const badge = document.querySelector('.nav-user span');
      if (badge && next.name) badge.textContent = next.name;
      const av = document.querySelector('.nav-user .nav-avatar');
      if (av && global.UI) {
        if (global.UI.setAvatarContent) global.UI.setAvatarContent(av, next.avatar, next.name);
        else if (global.UI.avatarGlyph) av.textContent = global.UI.avatarGlyph(next.avatar, next.name);
      }
      return;
    }
    // 身份换人了（登录 / 登出 / 换号）：本标签的连接仍是旧身份，必须整页重载才会重连。
    try { window.sessionStorage.setItem('tdshogi_flash', '身份已在其他标签页变更，正在刷新…'); } catch (_) {}
    location.reload();
  }
  try { global.addEventListener('storage', onStorageSync); } catch (_) { /* 极老浏览器没有 storage 事件：忽略 */ }

  function renderNav(current) {
    const guest = getGuest();
    renderedIdentityId = guest.id; // 记录本标签已渲染的身份 id（供上面的 storage 同步判断）
    const isAccount = typeof guest.id === 'string' && guest.id.includes('.');
    // 头像（2026-09-20）：徽标改成显示头像；**登录态改由 title 表达**——
    // 原先那个 🔐/👤 图标只在"点开个人页才知道登没登"这个场景有用，
    // 而现在每个玩家都有头像，徽标位置给头像信息量更大。
    const userBadge = (global.UI && global.UI.avatarHtml)
      ? global.UI.avatarHtml({ avatar: guest.avatar, name: guest.name, size: 28 })
      : (global.UI && global.UI.avatarGlyph)
        ? global.UI.avatarGlyph(guest.avatar, guest.name)
        : (isAccount ? '🔐' : '👤');
    // 名字首次到达前（hello 未回）显示占位，避免导航与对局/列表不同步
    const displayName = guest.name || '载入中…';
    const nav = document.querySelector('.nav');
    if (nav) {
      nav.innerHTML = `
        <a class="brand" href="index.html">
          <span class="brand-logo">TDShogi</span>
          <span class="brand-stamp">将棋</span>
        </a>
        <nav class="nav-links">
          ${NAV.map((n) => `<a href="${n.href}" class="${n.id === current ? 'active' : ''}" data-nav="${n.id}">${tr(n.label)}</a>`).join('')}
        </nav>
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="theme-toggle" id="langToggle" title="${tr('语言')}">${localeShort()}</button>
          <button class="theme-toggle music-toggle" id="musicToggle" title="${tr('音乐')}">🔊</button>
          <button class="theme-toggle" id="themeToggle" title="${tr('切换主题')}">🌙</button>
          <button class="theme-toggle" id="settingsToggle" title="${tr('设置')}">⚙️</button>
          ${adminEntryHtml()}
          <a class="nav-user" href="profile.html" title="${isAccount ? tr('个人 · 已登录账号') : tr('个人 · 游客')}">
            <span>${displayName}</span>
            <span class="nav-avatar">${userBadge}</span>
          </a>
        </div>
      `;
    } else {
      // 某些页面可能没有 nav 容器，动态创建
      const n = document.createElement('header');
      n.className = 'nav';
      n.innerHTML = `
        <a class="brand" href="index.html"><span class="brand-logo">TDShogi</span><span class="brand-stamp">将棋</span></a>
        <nav class="nav-links">
          ${NAV.map((x) => `<a href="${x.href}" class="${x.id === current ? 'active' : ''}" data-nav="${x.id}">${tr(x.label)}</a>`).join('')}
        </nav>
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="theme-toggle" id="langToggle" title="${tr('语言')}">${localeShort()}</button>
          <button class="theme-toggle music-toggle" id="musicToggle" title="${tr('音乐')}">🔊</button>
          <button class="theme-toggle" id="themeToggle" title="${tr('切换主题')}">🌙</button>
          <button class="theme-toggle" id="settingsToggle" title="${tr('设置')}">⚙️</button>
          ${adminEntryHtml()}
        </div>
      `;
      document.body.insertBefore(n, document.body.firstChild);
    }
    // 三个按钮用 addEventListener 绑定（2026-09-23，审查项 13f）：
    // 这里刚**重建**过 DOM（innerHTML），所以每次 renderNav 都重新绑一遍 ——
    // 元素是新的，不会重复绑定。
    bindNavButtons();
    applyTheme();
    // ⚠️ 2026-10-07：BGM 三轨初始化（拉服务端配置 + 起菜单曲）；失败静默
    if (global.Sound && global.Sound.initFromServer) {
      try { global.Sound.initFromServer(); } catch (_) { /* 音频不可用不影响页面 */ }
    }
    // 音乐按钮初始态
    if (global.Settings && global.Sound) {
      const on = global.Settings.get('music') !== false;
      const mb = document.getElementById('musicToggle');
      if (mb) {
        mb.textContent = on ? '🔊' : '🔇';
        mb.title = on ? '关闭音乐' : '开启音乐';
        mb.classList.toggle('music-off', !on);
      }
    }
    return guest;
  }

  /**
   * 绑定导航里的三个按钮（2026-09-23，安全审查遗留项 13f：去掉 inline `onclick`）。
   *
   * 为什么这里用 `addEventListener` 而不是 `UI.onAction` 委托：这三个按钮在
   * **每次 `renderNav` 时都被整块重建**（`innerHTML` 换掉），而它们的 `id` 是稳定的 ——
   * 重建后重新绑一遍即可；元素是新的，不存在重复监听。
   * ⚠️ 别改成"绑在 `.nav` 上做委托再按 id 分派"：那要先判断元素在不在 nav 里，更容易写错。
   */
  function bindNavButtons() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    on('langToggle', () => toggleLocale());
    on('themeToggle', () => toggleTheme());
    on('settingsToggle', () => {
      if (global.Settings && global.Settings.openPanel) global.Settings.openPanel();
    });
    // ⚠️ 2026-10-07：右上角全局音乐开关（菜单/开局/终盘三轨一起开/关）
    on('musicToggle', () => {
      const cur = global.Settings ? global.Settings.get('music') !== false : true;
      const next = !cur;
      if (global.Sound && global.Sound.setMusicOn) global.Sound.setMusicOn(next);
      else if (global.Settings) global.Settings.set('music', next);
      const btn = document.getElementById('musicToggle');
      if (btn) {
        btn.textContent = next ? '🔊' : '🔇';
        btn.title = next ? '关闭音乐' : '开启音乐';
        btn.classList.toggle('music-off', !next);
      }
      if (global.UI && global.UI.toast) global.UI.toast(next ? '音乐已开启' : '音乐已关闭');
    });
  }

  function toggleTheme() {
    const next = getTheme() === 'light' ? 'dark' : 'light';
    if (global.Settings) global.Settings.set('theme', next);
    else localStorage.setItem(THEME_KEY, next);
    applyTheme();
  }

  global.NAV = { renderNav, applyLocale, toggleLocale, getGuest, saveGuest, updateUserName, updateAvatar, randomName, genId, genKey, GUEST_KEY, THEME_KEY, ADMIN_KEY, isAdminSession, toggleTheme, getTheme, applyTheme };
})(window);

/* ==== js/api.js ==== */
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
      let url = `${proto}://${location.host}/ws?guest=${encodeURIComponent(guestId)}`;
      // B1：带上游客持有证明（非口令，仅作会话归属校验）。
      // 账号身份（token）时服务端会忽略它；游客身份则用于首次绑定 secret / 后续改名换头像校验。
      try {
        const g = global.NAV && global.NAV.getGuest && global.NAV.getGuest();
        if (g && g.key) url += `&key=${encodeURIComponent(g.key)}`;
      } catch (_) { /* 取不到就不带（老数据首次也会由 getGuest 惰性补发） */ }
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
    let data = {};
    try { data = await res.json(); } catch (_) { /* 非 JSON 响应（如 502 网关页） */ }
    // ⚠️ 失败时必须把服务端 `{error}` 带出来：原先只抛 `HTTP 400`，
    // 注册接口的「密码至少 8 位 / 用户名已被占用」等文案全被吞掉，前端只能显示「请重试」。
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
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

/* ==== js/pieces.js ==== */
/**
 * pieces.js — 棋子图片素材配置与渲染
 *
 * 使用你提供的自定义木棋子图集（kinki.png / ryoko.png）。
 * 每张图为 512×256、4 行 × 8 列网格，每格 64×64。
 *
 * 坐标布局（kinki.png / ryoko.png 通用）：
 *   row 0: 玉将 飛車 角行 金将 銀将 桂馬 香車 步兵  ← 先手未升变（正立）
 *   row 1: 玉将 龍王 龍馬 成金 成銀 成桂 成香 と   ← 先手成駒（正立）
 *   row 2: 玉将 飛車 角行 金将 銀将 桂馬 香車 步兵  ← 后手未升变（倒置）
 *   row 3: 玉将 龍王 龍馬 成金 成銀 成桂 成香 と   ← 后手成駒（倒置）
 *
 * 后手棋子整体旋转 180°（沿用 v1.1 设计；方向区分先手/后手）。
 *
 * 如果你提供的图集 cell 排列与此不一致，请直接调整下面的 PIECE_ATLAS 即可。
 */
(function () {
  'use strict';

  const CELL = 64;                 // 每格像素（512/8=64, 256/4=64）
  const COLS = 8;
  const ATLAS_DEFAULT = 'pieces/kinki.png';   // 默认先手（金棋楷书）
  const ATLAS_ALT = 'pieces/ryoko.png';        // 备用字体风格

  /**
   * 棋子素材集：kind → { row, col, promoted }
   *   row/col = 图集中的网格位置
   *   promoted = 是否成駒（用于选择 row 0/1 或 2/3）
   * 方向（先手/后手）由 caller 用 CSS transform rotate(180°) 表达。
   */
  const PIECE_ATLAS = {
    // 顺序：未升变 → 升变（与图集 row 0/1 一一对应）
    OU:  { kind: 'OU',  row: 0, col: 0 },   // 玉
    HI:  { kind: 'HI',  row: 0, col: 1 },   // 飛
    KA:  { kind: 'KA',  row: 0, col: 2 },   // 角
    KI:  { kind: 'KI',  row: 0, col: 3 },   // 金
    GI:  { kind: 'GI',  row: 0, col: 4 },   // 銀
    KE:  { kind: 'KE',  row: 0, col: 5 },   // 桂
    KY:  { kind: 'KY',  row: 0, col: 6 },   // 香
    FU:  { kind: 'FU',  row: 0, col: 7 },   // 歩
    // 成駒（row 1）：玉 龍 馬 成金 成銀 成桂 成香 と（与图集 row 1 一一对应）
    OU2: { kind: 'OU2', row: 1, col: 0 },   // 玉（成不变）
    RY:  { kind: 'RY',  row: 1, col: 1 },   // 龍（飛成）
    UM:  { kind: 'UM',  row: 1, col: 2 },   // 馬（角成）
    NG:  { kind: 'NG',  row: 1, col: 4 },   // 成銀（row1 col4；col3 是成金——错位会导致成銀显示成金将形）
    NY:  { kind: 'NY',  row: 1, col: 6 },   // 成香（row1 col6）
    NK:  { kind: 'NK',  row: 1, col: 5 },   // 成桂（row1 col5）
    TO:  { kind: 'TO',  row: 1, col: 7 },   // と（row1 col7）
  };

  /**
   * kind → 素材 row/col。
   * kinki.png / ryoko.png 的 row 0/1（先手未升变/成駒）是正立字。
   * 后手棋子统一用 row 0/1 的正立字，通过 transform:rotate(180) 决定方向（viewpoint）。
   * @param {string} kind
   * @param {boolean} promoted
   * @param {string} color（保留用于将来切换字体/图集）
   */
  function locate(kind, promoted, color) {
    const base = !promoted ? kind : ({ HI: 'RY', KA: 'UM', GI: 'NG', KE: 'NK', KY: 'NY', FU: 'TO', KI: 'KI', OU: 'OU2' })[kind] || kind;
    return PIECE_ATLAS[base] || PIECE_ATLAS.OU;
  }

  /**
   * 生成一枚棋子的 HTML（div + background-image）。
   * 棋子朝向由 viewpoint 决定：己方棋子正立，对方棋子旋转 180°（方向区分）。
   *
   * 缩放逻辑：背景图按显示尺寸等比缩放（background-size 宽 = 8×size），
   * position 偏移同样用 size 步长 → 每个显示格子恰好完整呈现一枚棋子且居中。
   * （旧实现 background-size 用原始 512px + 64px 偏移，而 div 只有 44-56px，
   *   导致棋子只显示左上部分、看起来偏离格心。）
   *
   * @param {object} opts { kind, color:'b'|'w', promoted, size, viewpoint:'b'|'w' }
   * @returns {string} HTML 字符串
   */
  function pieceHTML({ kind, color, promoted, size = 44, atlas = ATLAS_DEFAULT, viewpoint = 'b' }) {
    const cell = locate(kind, promoted, color);
    const x = -cell.col * size;
    const y = -cell.row * size;
    // 己方正立（不旋转），对方旋转 180°（朝下，方向区分）
    const isMine = color === viewpoint;
    const rotate = isMine ? '' : 'transform:rotate(180deg);';
    return `<div class="piece-img" style="width:${size}px;height:${size}px;background-image:url('${atlas}');background-position:${x}px ${y}px;background-size:${COLS * size}px auto;${rotate}"></div>`;
  }

  // 暴露全局
  window.PIECE_ATLAS = PIECE_ATLAS;
  window.PIECE_CELL = CELL;
  window.PIECE_COLS = COLS;
  window.PIECE_ATLAS_DEFAULT = ATLAS_DEFAULT;
  window.PIECE_ATLAS_ALT = ATLAS_ALT;
  window.pieceHTML = pieceHTML;
  window.locate = locate;
})();

/* ==== js/piece-kinds.js ==== */
/**
 * piece-kinds.js — 棋种映射的单一来源（PLAN §M6 优化第一步）
 *
 * 背景：此前棋种映射散在三处且各自维护——
 *   - `board.js` 的 NAME_TO_KEY（渲染用）
 *   - `freeboard.js` 的 PROMOTE / DEMOTE / DROP_NAME（走子、吃子、升变用）
 *   - 服务端 `game.js` 的 KIND_NAME（权威命名）
 * 重复即风险：PLAN §J3 的「吃馬却多出飞车」就是 DEMOTE 表里 `'馬': '飛'` 写错一个字，
 * 潜伏到用户在棋盘上吃子才暴露。
 *
 * 对策：前端所有棋种映射收敛到本文件，并在加载时做**互逆自检**——
 * 只要有人再写错，控制台立刻报错，不等用户发现。
 * 纯数据 + 纯函数，可被 Node 直接加载做互逆自检（见下方 validate()）。
 */
(function (global) {
  /** 未成 → 成（中文名，与服务端 KIND_NAME 一致） */
  const PROMOTE = {
    '歩': 'と', '香': '成香', '桂': '成桂', '銀': '成銀', '角': '馬', '飛': '龍',
  };

  /**
   * 成 → 未成（吃子进驹台、双击降级用）。
   * 含日式别名：杏=成香、圭=成桂、全=成銀、馬=角成、龍=飛成。
   * ⚠️ 曾把 '馬' 错写成 '飛'（PLAN §J3），互逆自检会拦住这类错误。
   */
  const DEMOTE = {
    'と': '歩',
    '成香': '香', '杏': '香',
    '成桂': '桂', '圭': '桂',
    '成銀': '銀', '全': '銀',
    '馬': '角',
    '龍': '飛',
  };

  /** 打子符号 → 中文名（服务端 legalTargets 用 P/L/N/S/G/B/R） */
  const DROP_NAME = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛' };

  /** 中文名 → 打子符号（DROP_NAME 的反查） */
  const NAME_TO_DROP = {};
  for (const [sym, name] of Object.entries(DROP_NAME)) NAME_TO_DROP[name] = sym;

  /** 中文名 → shogi.js kind（渲染图集用；与服务端 KIND_NAME 对应） */
  const NAME_TO_KEY = {
    '歩': 'FU', '香': 'KY', '桂': 'KE', '銀': 'GI', '金': 'KI',
    '角': 'KA', '飛': 'HI', '玉': 'OU', '王': 'OU',
    'と': 'TO', '杏': 'NY', '圭': 'NK', '全': 'NG', '馬': 'UM', '龍': 'RY',
    '成香': 'NY', '成桂': 'NK', '成銀': 'NG',
  };

  /** 成駒名集合（用于 promoted 判定与降级） */
  const PROMOTED_NAMES = new Set([
    'と', '成香', '杏', '成桂', '圭', '成銀', '全', '馬', '龍',
  ]);

  /** 任意棋名 → 原始（未成）棋种：吃子进驹台时用它 */
  function rawOf(name) {
    return DEMOTE[name] || name;
  }

  /** 棋名 → 成駒名（不可升变返回 null，如金/玉） */
  function promoteOf(name) {
    return PROMOTE[name] || null;
  }

  /** 是否成駒 */
  function isPromoted(name) {
    return PROMOTED_NAMES.has(name);
  }

  /** 棋名 → 打子符号（不可打的成駒/玉返回 null） */
  function dropSymOf(name) {
    return NAME_TO_DROP[name] || null;
  }

  /** 打子符号 → 中文名 */
  function nameOfDrop(sym) {
    return DROP_NAME[sym] || null;
  }

  /**
   * 映射自检：PROMOTE 与 DEMOTE 必须严格互逆，且每个别名都要能还原。
   * @returns {string[]} 错误列表（空数组 = 健康）
   */
  function validate() {
    const errs = [];
    for (const [base, promo] of Object.entries(PROMOTE)) {
      if (DEMOTE[promo] !== base) {
        errs.push(`PROMOTE/DEMOTE 不互逆：${base} → ${promo} → ${DEMOTE[promo] || '(缺失)'}`);
      }
    }
    for (const [promo, base] of Object.entries(DEMOTE)) {
      if (PROMOTE[base] === undefined) {
        errs.push(`DEMOTE 的 ${promo} → ${base}，但 ${base} 不在 PROMOTE 中`);
      }
    }
    for (const [sym, name] of Object.entries(DROP_NAME)) {
      if (NAME_TO_DROP[name] !== sym) errs.push(`DROP_NAME 反查不一致：${sym} / ${name}`);
    }
    return errs;
  }

  global.PieceKinds = {
    PROMOTE, DEMOTE, DROP_NAME, NAME_TO_DROP, NAME_TO_KEY, PROMOTED_NAMES,
    rawOf, promoteOf, isPromoted, dropSymOf, nameOfDrop, validate,
  };

  // 加载即自检：写错映射会在控制台立刻报错（生产环境也只是多一次极小的计算）
  const errs = validate();
  if (errs.length && global.console && global.console.error) {
    global.console.error('[PieceKinds] 棋种映射自检失败：', errs);
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/board.js ==== */
/**
 * board.js — 棋子渲染 + 棋盘渲染 + 走子交互
 *
 * 棋子：使用你自定义的木棋子图集（pieces/kinki.png 或 pieces/ryoko.png）。
 *  - 两方棋子用同一张图集（统一字体/风格）
 *  - 先手/后手以方向区分（后手旋转 180°）
 *  - 升变使用图集中对应的成駒 cell
 *
 * 棋盘：9x9，格内用 USI 坐标定位。支持渲染由服务端下发的 state.board。
 */
(function (global) {
  // 棋子中文名 → kind（来自服务端 KIND_NAME）
  // 单一来源：piece-kinds.js（PLAN §M6）；未加载时退回内联备份，保证旧页面不炸
  const NAME_TO_KEY = (global.PieceKinds && global.PieceKinds.NAME_TO_KEY) || {
    '歩': 'FU', '香': 'KY', '桂': 'KE', '銀': 'GI', '金': 'KI',
    '角': 'KA', '飛': 'HI', '玉': 'OU', '王': 'OU',
    'と': 'TO', '杏': 'NY', '圭': 'NK', '全': 'NG', '馬': 'UM', '龍': 'RY',
    '成香': 'NY', '成桂': 'NK', '成銀': 'NG',
  };

  /**
   * 当前棋子图集路径。
   * 优先级：外部显式覆盖（window.PIECE_ATLAS_DEFAULT，由装扮装备写入）> 默认 kinki。
   * ⚠️ 2026-10-08：棋子图集从设置迁入装扮 —— 装备 pieces 道具后由 profile/init 写入
   * `window.PIECE_ATLAS_DEFAULT`，不再读 Settings.atlas。
   */
  function getAtlas() {
    if (window.PIECE_ATLAS_DEFAULT) return window.PIECE_ATLAS_DEFAULT;
    return 'pieces/kinki.png';
  }

  /** 当前格尺寸（px），由 CSS 变量 --cell-size 驱动，窄屏响应式缩小 */
  function cellSize() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--cell-size');
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0 && /^\s*[\d.]+px/.test(v)) return n;
    // 移动端自适应（PLAN §N）：--cell-size 为 'auto' 时按视口宽度推导。
    // 注意：CSS 自定义属性不解析 vw/min()（getComputedStyle 拿到的是原始 token），
    // 因此手机端媒体查询里 --cell-size 设为 auto，由这里按视口算出像素值。
    const vw = Math.min(window.innerWidth, 640);
    // 扣除「棋盘 padding + 页面留白」。开启坐标后四周各多约 11px，必须同步扣除，
    // 否则手机会因棋盘变宽而横向溢出（§S4）。
    const coordsOn = !!(window.Settings && window.Settings.get('showCoords'));
    const chrome = coordsOn ? 92 : 70;
    const byViewport = Math.floor((vw - chrome) / 9);
    return Math.max(28, Math.min(48, byViewport));
  }

  /**
   * 渲染一个棋子（返回 HTML），用于棋盘格和持驹区。
   * 现在改用图片素材（pieces.js.pieceHTML），传入 piece 对象。
   * 内部函数名避开 window.pieceHTML 避免递归。
   * @param {object} piece { piece, color, promoted, sq }
   * @param {number} size
   * @param {string} viewpoint 'b' | 'w'（决定棋子朝向）
   */
  function renderPiece(piece, size, viewpoint) {
    if (!window.pieceHTML) return '';  // pieces.js 未加载
    const kind = NAME_TO_KEY[piece.piece] || 'FU';
    return window.pieceHTML({
      kind,
      color: piece.color,
      promoted: !!piece.promoted,
      size,
      atlas: getAtlas(),
      viewpoint: viewpoint || 'b',
    });
  }

  /**
   * 棋盘渲染器。
   * @param {HTMLElement} container
   */
  class ShogiBoard {
    constructor(container, opts = {}) {
      this.container = container;
      this.opts = opts;
      this.onSelect = opts.onSelect || null;   // (fromSq, piece) => void
      this.onMove = opts.onMove || null;       // (usi) => void
      this.onDrop = opts.onDrop || null;       // (dropPiece, toSq) => void
      this.state = null;
      this.selected = null;     // 当前选中格名（'7g'）或打子符号（'P'）
      this.targets = [];        // 合法目标
      this.interactive = false; // 是否可交互（走子方）
      this.readonly = false;    // 完全只读（回放）
      this.build();
    }

    build() {
      this.container.innerHTML = '';
      this.boardEl = document.createElement('div');
      this.boardEl.className = 'shogi-board';
      this.boardEl.style.position = 'relative';
      this.boardEl.style.display = 'inline-block';
      this.renderEmptyBoard();
      this.buildCoords();
      this.container.appendChild(this.boardEl);
    }

    /**
     * 棋盘坐标层（PLAN §S4）。
     *
     * 用**绝对定位的独立层**，而不是给每个 `.cell` 挂 `::before`：
     *  - 绝对定位元素不参与 `.board-grid` 的网格布局，不会挤格子
     *  - 不侵入 `.cell` 已有的伪元素（绿点/方块目标标记都用 `::after`）
     *  - `pointer-events: none` 保证绝不吃掉点击与拖拽
     *
     * 显示与否由 `Settings.showCoords` 决定（默认隐藏）；开关打开时给 `.shogi-board`
     * 加 `.coords-on`，由 CSS 扩大 padding 腾出标注空间。
     */
    buildCoords() {
      const wrap = document.createElement('div');
      wrap.className = 'board-coords';
      wrap.innerHTML = '<div class="coords coords-files coords-top"></div>'
        + '<div class="coords coords-files coords-bottom"></div>'
        + '<div class="coords coords-ranks coords-left"></div>'
        + '<div class="coords coords-ranks coords-right"></div>';
      this.coordsEl = wrap;
      this.boardEl.appendChild(wrap);
    }

    /**
     * 更新坐标内容与显隐，**跟随视角翻转**（与 render() 的行列映射保持同一口径）。
     *
     * 只保留**一对**标注（不是四边全给），并随视角换边：
     *  - 先手视角：筋号在上边、段名在右边
     *  - 后手视角：棋盘整体 180° 翻转 → 筋号落到下边、段名落到左边
     *
     * 四个容器仍在 DOM 中（CSS 已按四边定位），这里只填需要显示的那一对、
     * 清空另一对——空容器无内容即无视觉呈现，省掉一份位置切换逻辑。
     * 棋盘 padding 四边保持等宽，标注只在两处也不会让棋盘偏心。
     * @param {string} viewpoint 'b' | 'w'
     */
    renderCoords(viewpoint) {
      if (!this.coordsEl) return;
      const on = !!(window.Settings && window.Settings.get('showCoords'));
      this.boardEl.classList.toggle('coords-on', on);
      this.coordsEl.style.display = on ? '' : 'none';
      if (!on) return;
      const isB = viewpoint !== 'w';
      const nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
      const kanji = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
      // 先手视角：DOM 左→右为 9…1 筋、上→下为 一…九 段；后手视角两者皆反向
      const files = isB ? nums.slice().reverse() : nums;
      const ranks = isB ? kanji : kanji.slice().reverse();
      const fHtml = files.map((t) => `<span>${t}</span>`).join('');
      const rHtml = ranks.map((t) => `<span>${t}</span>`).join('');
      const filesEl = this.coordsEl.querySelector(isB ? '.coords-top' : '.coords-bottom');
      const ranksEl = this.coordsEl.querySelector(isB ? '.coords-right' : '.coords-left');
      const filesOther = this.coordsEl.querySelector(isB ? '.coords-bottom' : '.coords-top');
      const ranksOther = this.coordsEl.querySelector(isB ? '.coords-left' : '.coords-right');
      if (filesEl) filesEl.innerHTML = fHtml;
      if (ranksEl) ranksEl.innerHTML = rHtml;
      if (filesOther) filesOther.innerHTML = '';
      if (ranksOther) ranksOther.innerHTML = '';
    }

    renderEmptyBoard() {
      const grid = document.createElement('div');
      grid.className = 'board-grid';
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(9,1fr);gap:0;position:relative;';
      this.cells = [];
      const sz = cellSize();
      for (let r = 0; r < 9; r++) {
        const row = [];
        for (let c = 0; c < 9; c++) {
          const cell = document.createElement('div');
          cell.className = 'cell';
          cell.id = `fb-cell-${r}-${c}`;   // §6.3：供 aria-activedescendant 引用
          cell.setAttribute('role', 'gridcell');
          cell.style.cssText = `position:relative;width:${sz}px;height:${sz}px;`;
          cell.dataset.r = r;
          cell.dataset.c = c;
          grid.appendChild(cell);
          row.push(cell);
        }
        this.cells.push(row);
      }
      this.boardEl.appendChild(grid);
    }

    /**
     * 更新棋盘显示。
     *
     * 服务端 board[r][col]：
     *   - board[0] = y=1 = 段 1（顶部，后手方）
     *   - board[8] = y=9 = 段 9（底部，先手方）
     *   - col 0 = 1筋，col 8 = 9筋
     *
     * 标准视角（自己永远在下方、近处）：
     *   - 先手(b) 视角：行不变（board[0]=后手在顶部=对面，board[8]=先手在底部=自己），
     *                    列反转（9筋在左）。
     *   - 后手(w) 视角：行镜像（board[0]=后手翻转到底部=自己，board[8]=先手翻到顶部=对面），
     *                    列不变（1筋在左）。
     *
     * 棋子方向由 viewpoint 决定（pieces.js：己方正立，对方旋转180°）。
     *
     * @param {object} state
     * @param {object} extra
     * @param {string} viewpoint 'b' | 'w'
     */
    render(state, extra = {}, viewpoint = 'b') {
      this.state = state;
      this.extra = extra;
      this.viewpoint = viewpoint;
      this.renderCoords(viewpoint); // 坐标层与格子同口径翻转（PLAN §S4）
      const board = state.board;
      const flipRow = viewpoint === 'w'; // 后手视角：行镜像（自己翻到底部）
      const colFrom = (c) => viewpoint === 'b' ? (8 - c) : c; // 列方向（先手9筋左，后手1筋左）
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const dr = flipRow ? (8 - r) : r;  // 行：后手镜像
          const cell = this.cells[dr][c];
          cell.innerHTML = '';
          // 必须包含 has-piece：否则吃子目标（方块）的类残留到空格格子上，
          // 导致「合法目标空格」被污染成绿色方块而非绿点
          cell.classList.remove('sel', 'target', 'check', 'last', 'has-piece');
          const col = colFrom(c);
          const piece = board[r][col];
          if (piece && piece.piece) {
            cell.innerHTML = renderPiece(piece, cellSize() - 8, viewpoint);
            cell.dataset.sq = piece.sq;
          } else {
            // 空格 sq 应从「服务端」未镜像的行 r 反推
            cell.dataset.sq = this._rCToSq(r, c, viewpoint);
          }
        }
      }
      this.applyHighlights(extra);
    }

    _rCToSq(r, c, viewpoint = 'b') {
      // 显示 (r,c) 来自服务端 display[r][colFrom(c)]
      const col = viewpoint === 'b' ? (8 - c) : c;
      const y = r + 1;
      const x = col + 1;
      const rankChar = String.fromCharCode(97 + (y - 1));
      return `${x}${rankChar}`;
    }

    applyHighlights(extra) {
      // 上一步（USI 如 '7g7f' 或打子 'P*5e' → 只需高亮落点 '7f'/'5e'）
      // 修复：原直接传完整 USI 给 highlightSq，_findCell 永远匹配不到（格子 sq 是单格），
      //       导致「上一步」橙色高亮从不显示
      // 上一步高亮可在设置里关闭（PLAN §S1 highlightLastMove，默认开启）
      const showLast = !window.Settings || window.Settings.get('highlightLastMove') !== false;
      if (extra.lastMove && showLast) {
        const lastTo = extra.lastMove.length >= 4 ? extra.lastMove.slice(2) : extra.lastMove;
        this.highlightSq(lastTo, 'last');
      }
      // 王手红格
      (extra.check || []).forEach((sq) => this.highlightSq(sq, 'check'));
      // 选中
      if (this.selected) {
        this.highlightSq(this.selected, 'sel');
      }
      // 合法目标
      (this.targets || []).forEach((t) => this.highlightSq(t.to, 'target'));
    }

    highlightSq(sq, cls) {
      const cell = this._findCell(sq);
      if (cell) cell.classList.add(cls);
    }

    _findCell(sq) {
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          const cell = this.cells[r][c];
          if (cell.dataset.sq === sq) return cell;
        }
      }
      return null;
    }

    /**
     * 设置交互状态（可走子时传 legalTargets 映射）。
     */
    setInteractive(interactive) {
      this.interactive = interactive;
    }

    setSelected(from) {
      this.selected = from;
    }
  }

  // 打子符号（服务端 legalTargets 用 'P','L','N','S','G','B','R'）
  const DROP_SYMBOLS = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛' };
  const DROP_KANJI = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' };

  /**
   * 渲染持驹区。只清除已渲染的棋子 (.hand-piece)，保留容器内其他节点
   * （如 label 标签），避免反复 append 造成内存泄漏与标签丢失。
   */
  function renderHands(container, hands, color, onPick, viewpoint = 'b') {
    // 只清除已渲染的棋子节点，保留容器内的 label 等
    container.querySelectorAll('.hand-piece').forEach((el) => el.remove());
    const list = hands && hands[color] ? hands[color] : [];
    list.forEach((h) => {
      const wrap = document.createElement('div');
      wrap.className = 'hand-piece';
      wrap.dataset.piece = h.piece;
      const key = NAME_TO_KEY[h.piece] || 'FU';
      wrap.innerHTML = window.pieceHTML({
        kind: key, color, promoted: false, size: 44, atlas: getAtlas(), viewpoint,
      });
      if (h.count > 1) {
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = h.count;
        wrap.appendChild(count);
      }
      if (onPick) {
        wrap.onclick = () => onPick(h.piece);
      }
      container.appendChild(wrap);
    });
  }

  global.ShogiBoard = ShogiBoard;
  global.renderHands = renderHands;
  global.DROP_SYMBOLS = DROP_SYMBOLS;
  global.DROP_KANJI = DROP_KANJI;
})(window);

/* ==== js/sound.js ==== */
/**
 * sound.js — 音效与 BGM（Web Audio 合成 + 真实音频文件，PLAN §U4）
 *
 * 提供：
 *  - playMove()      行棋落子：短促木质敲击（噪声冲击 + 中频衰减）
 *  - playCapture()   吃子：更重的敲击（低频更足）
 *  - playByoyomi()   读秒滴答：高频短「嗒」
 *  - playStart()     对局开始：上扬双音
 *  - playEnd()       对局结束：下行双音
 *  - bgmStart/Stop/Sync 对局 BGM（`file:<名字>` 素材循环；素材缺失自动切合成 pad）
 *
 * 两种音源并存：
 *  - `default` 方案由 AudioContext 实时合成，零素材、永远可用；
 *  - `file:<名字>` 方案播放真实音频（落子音 `sound/<名字>.mp3`、BGM `music/<名字>.mp3`），
 *    文件缺失/自动播放被拦时**静默降级**——落子音退回合成音、BGM 退回合成 pad，
 *    两者都绝不抛错、绝不影响对局（`public/music/` 本身就是**可选素材**）。
 *
 * 首次用户交互后 AudioContext 才允许出声（浏览器自动播放策略），
 * 因此 play.js 在用户点击棋盘时初始化音频上下文。
 */
(function (global) {
  'use strict';

  const SOUND_KEY = 'tdshogi_sound';
  let ctx = null;
  let enabled = true;

  // 音效开关的唯一数据源是 Settings（PLAN §S1）；Settings 未加载时回退旧键
  if (global.Settings) {
    enabled = global.Settings.get('sound');
  } else {
    try { enabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (_) {}
  }

  /** 懒初始化 AudioContext（需在用户手势后调用才可出声） */
  function ensureCtx() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    return ctx;
  }

  /** 主音量（0-1），避免突兀 */
  const MASTER = 0.35;

  function env(gainNode, t0, peak, decay) {
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  }

  /** 落子：短促噪声冲击 + 中频衰减（木质敲击感） */
  function playMove() {
    if (!enabled) return;
    // §U4 真实音频方案；未选/同步失败 → 立刻合成音；异步失败（404/被拦）→ onFail 回退合成音
    if (playMoveFile(1, synthMove)) return;
    synthMove();
  }

  /** 落子合成音（真实音频不可用时的回退路径） */
  function synthMove() {
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER;
    master.connect(ac.destination);

    // 噪声冲击（木击的"啪"）
    const dur = 0.06;
    const buffer = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const nFilter = ac.createBiquadFilter();
    nFilter.type = 'bandpass';
    nFilter.frequency.value = 1800;
    nFilter.Q.value = 0.8;
    const nGain = ac.createGain();
    env(nGain, t0, 1, 0.07);
    noise.connect(nFilter).connect(nGain).connect(master);
    noise.start(t0);

    // 中频体感（木头的"咚"）
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t0);
    osc.frequency.exponentialRampToValueAtTime(160, t0 + 0.09);
    const oGain = ac.createGain();
    env(oGain, t0, 0.9, 0.1);
    osc.connect(oGain).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.12);
  }

  /** 吃子：落子 + 更重的低频（厚度感） */
  function playCapture() {
    if (!enabled) return;
    // 真实音频方案：降一点速高（0.82）= 更沉，对应合成音方案里"吃子更厚"的设计
    if (playMoveFile(0.82, synthCapture)) return;
    synthCapture();
  }

  /** 吃子合成音（真实音频不可用时的回退路径） */
  function synthCapture() {
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER;
    master.connect(ac.destination);

    const dur = 0.08;
    const buffer = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.5);
    }
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const nFilter = ac.createBiquadFilter();
    nFilter.type = 'lowpass';
    nFilter.frequency.value = 900;
    const nGain = ac.createGain();
    env(nGain, t0, 1.1, 0.1);
    noise.connect(nFilter).connect(nGain).connect(master);
    noise.start(t0);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.12);
    const oGain = ac.createGain();
    env(oGain, t0, 1.0, 0.13);
    osc.connect(oGain).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  }

  /** 读秒滴答：高频短「嗒」（⚠️ 2026-10-08：读秒音从设置迁入装扮，可换文件方案） */
  let byoyomiVariant = 'default'; // 'default'（合成）/ 文件 URL

  /** 设置读秒音方案（装扮装备后调用） */
  function setByoyomiVariant(v) {
    byoyomiVariant = (v && String(v)) || 'default';
  }

  function playByoyomi() {
    if (!enabled) return;
    // 文件方案：sound/<名字>.mp3 或完整站内路径
    if (byoyomiVariant && byoyomiVariant !== 'default' && byoyomiVariant.indexOf('synth') !== 0) {
      const path = byoyomiVariant.charAt(0) === '/' ? byoyomiVariant : 'sound/' + byoyomiVariant + '.mp3';
      if (playFileSound(path, { volume: 0.9 }, synthByoyomi)) return;
    }
    synthByoyomi();
  }

  /** 读秒合成音（文件缺失时的回退） */
  function synthByoyomi() {
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.7;
    master.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 2200;
    const g = ac.createGain();
    env(g, t0, 0.6, 0.04);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.05);
  }

  /**
   * 整分钟提醒（PLAN §U1）：本时剩余每跨过一个整分钟响一次。
   *
   * 音色刻意与读秒「嗒」拉开距离——**低、长、圆润**（正弦，660→440Hz，0.35s）。
   * 这条音是「提示」而不是「催促」：玩家还有好几分钟，不该被高频短音打扰。
   */
  function playMinuteWarning() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.8;
    master.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(440, t0 + 0.18);
    const g = ac.createGain();
    env(g, t0, 0.9, 0.35); // 明显长于读秒音
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  }

  /**
   * 读秒报时（PLAN §U1）：读秒阶段每跨过 10 秒响一次（60/50/40/30/20）。
   *
   * 音色介于两者之间——**三角波双音「叮-咚」**（1100→880Hz，间隔 0.1s）：
   * 比整分钟提醒急促（时间更紧了），但比逐秒「嗒」舒缓（还不是最后关头）。
   */
  function playByoyomiMark() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.7;
    master.connect(ac.destination);

    [1100, 880].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      const t = t0 + i * 0.1;
      env(g, t, 0.55, 0.12);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.14);
    });
  }

  /**
   * 读取音色方案（PLAN §U4）。
   *
   * 取值：`default`（程序化合成）/ `file:<名字>`（真实音频文件）/ `off`（仅 bgm）。
   * Settings 未加载时一律回退 default（不抛错）。
   */
  function variant(key) {
    if (!global.Settings) return 'default';
    try { return global.Settings.get(key) || 'default'; } catch (_) { return 'default'; }
  }

  /**
   * 尝试播放一次真实音频文件（PLAN §U4 实装，2026-09-26）。
   *
   * ⚠️ 契约（Bug5 修）：**必须真的具备降级能力**——文件缺失（404）、格式不支持、
   * 自动播放被拦时，要让调用方回退合成音，而不是"装作播了"。
   * 旧实现的 `const p = a.play(); return true;` 破坏了这个契约：`.catch(()=>{})` 把
   * reject 吞掉又无条件返回 true，调用方 `if (playMoveFile(...)) return;` 于是**永不回退**，
   * 结果完全没声音（静默失败，最难查）。
   *
   * 回退触发（两条都要覆盖，不同浏览器走的不一样）：
   *  - `play()` 返回的 Promise reject（自动播放被拦 / 解码失败）；
   *  - 音频元素 `error` 事件（404 等加载错误常走这条）。
   * 同步构造 / `play()` 同步抛错 → 返回 false，由调用方**立刻**回退。
   *
   * @param {string} path
   * @param {{volume?:number, rate?:number}} [opts]
   * @param {Function} [onFail] 异步失败时的回退回调（合成音）
   * @returns {boolean} true=已顶上真实音频（失败会经 onFail 回退）；false=立刻失败，调用方自行回退
   */
  function playFileSound(path, opts, onFail) {
    let a;
    try {
      a = new global.Audio(encodeURI(path));
    } catch (_) {
      return false; // 连元素都建不出：交给调用方回退
    }
    a.volume = opts && opts.volume != null ? opts.volume : 1;
    if (opts && opts.rate) a.playbackRate = opts.rate;
    let settled = false;
    const fallback = () => {
      if (settled) return;   // 只回退一次（error 与 promise reject 可能都来）
      settled = true;
      if (typeof onFail === 'function') { try { onFail(); } catch (_) {} }
    };
    a.onerror = fallback;    // 404/格式不支持：多数浏览器走 error 事件
    let p;
    try {
      p = a.play();
    } catch (_) {
      settled = true;        // 同步抛：返回 false 让调用方立刻回退；标记已决，避免再触发 onerror 重复
      return false;
    }
    if (p && typeof p.catch === 'function') p.catch(fallback);
    return true;
  }

  /**
   * 落子/吃子的真实音频方案：`file:<名字>` → `sound/<名字>.mp3`。
   * @param {number} rate 播放速率（吃子 <1 = 更沉）
   * @param {Function} [onFail] 真实音频失败时的回退（合成音）
   * @returns {boolean} 是否已用真实音频顶上（false 时调用方需立刻回退合成音）
   */
  function playMoveFile(rate, onFail) {
    const v = variant('soundMove');
    if (typeof v !== 'string' || v.indexOf('file:') !== 0) return false;
    return playFileSound('sound/' + v.slice(5) + '.mp3', { volume: 0.9, rate: rate || 1 }, onFail);
  }

  // ==================================================================
  // BGM 三轨（2026-10-07）：菜单 / 开局 / 终盘
  //  - menu：没有对局时（大厅/个人页等）循环
  //  - game：对局进行中循环（玩家装备的 BGM 会覆盖这一轨）
  //  - endgame：进入读秒时切换循环
  // 全局音乐开关独立于行棋音效（右上角 🔊/🔇 控制，持久化在 Settings.music）。
  // 素材缺失仍自动降级合成 pad，绝不抛错。
  // ==================================================================
  const BGM_GAIN = 0.35;   // 与合成音 MASTER 平级，不盖过落子/读秒提示音

  let bgmEl = null;        // 当前 <audio>（素材路径）
  let bgmUrl = null;       // 当前素材 URL（切换/判等用）
  let bgmMode = null;      // 当前实际出声的路径：'file' | 'synth' | null
  let bgmSynthName = null; // 合成兜底所对应的曲名
  let bgmPhase = 'menu';   // 'menu' | 'game' | 'endgame'
  // ⚠️ 2026-10-08：初始即带默认三轨（loop / 静弈 / 制勝），首页在接口返回前也能起菜单曲。
  // 登录后 initFromServer 会用「已装备」覆盖。
  let bgmTracks = {
    menu: '/music/loop.mp3',
    game: '/music/静弈.mp3',
    endgame: '/music/制勝.mp3',
  };
  let bgmMusicOn = true;   // 全局音乐开关（独立于行棋音效 enabled；初始从 Settings 读）
  if (global.Settings) {
    try { bgmMusicOn = global.Settings.get('music') !== false; } catch (_) { /* 默认开 */ }
  }
  let bgmFailed = null;    // 最近一次确认缺失的素材 URL（避免每次同步都重试 404）
  let bgmGen = 0;          // 重建代数：迟到的失败回调不得误伤新曲

  // ⚠️ 2026-10-08：对局中「自己 + 对手」开局曲交替循环
  let bgmOpponentUrl = null;   // 对手开局曲 URL（state.players.opp.bgm）
  let bgmPlayOpponent = true;  // 设置项 playOpponentBgm
  let bgmAltIndex = 0;         // 0=自己的曲，1=对手的曲（game 轨交替）
  let bgmVolume = 0.5;         // 音量 0–1（Settings.musicVolume / 100）
  if (global.Settings) {
    try {
      const v = Number(global.Settings.get('musicVolume'));
      if (Number.isFinite(v)) bgmVolume = Math.min(1, Math.max(0, v / 100));
      bgmPlayOpponent = global.Settings.get('playOpponentBgm') !== false;
    } catch (_) { /* 默认 50% / 开 */ }
  }

  /** BGM 音量：0.7 × 用户百分比（50% → 0.35，与历史默认一致；100% → 0.7） */
  function bgmGain() {
    return 0.7 * bgmVolume;
  }

  /** 读全局音乐开关（内存态；由 setMusicOn / applyMusicOn 同步，初始从 Settings 读） */
  function musicOn() {
    return bgmMusicOn;
  }

  /**
   * 按曲名取一组和弦音（稳定哈希 → 同一曲名永远同一色彩）。
   * 让「循环 / 制勝 / 空弦 …」在无素材时听感各不相同，而不是同一段糊在一起。
   */
  const PAD_PALETTES = [
    [196.00, 293.66, 392.00], // G3 D4 G4
    [174.61, 261.63, 349.23], // F3 C4 F4
    [220.00, 329.63, 440.00], // A3 E4 A4
    [164.81, 246.94, 329.63], // E3 B3 E4
    [146.83, 220.00, 293.66], // D3 A3 D4
  ];
  function padPalette(name) {
    const s = String(name || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PAD_PALETTES[h % PAD_PALETTES.length];
  }

  let pad = null; // { ac, out, oscs, lfo }

  /** 停掉合成 pad（若仍有残留） */
  function synthPadStop() {
    if (!pad) return;
    const { ac, out, oscs, lfo } = pad;
    pad = null;
    try {
      const t = ac.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0.0001, t, 0.2);
      const end = t + 1.0;
      oscs.forEach((o) => { try { o.stop(end); } catch (_) {} });
      try { lfo.stop(end); } catch (_) {}
    } catch (_) {}
  }

  /**
   * 起合成 ambient pad（BGM 兜底）。
   * 无 AudioContext（单测环境 / 老浏览器）→ 静默返回，**绝不抛错**。
   */
  function synthPadStart(name) {
    synthPadStop();
    const ac = ensureCtx();
    if (!ac) return;
    try {
      const t = ac.currentTime;
      const out = ac.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.setTargetAtTime(bgmGain() * 0.6, t, 1.5);

      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.6;
      filter.connect(out);
      out.connect(ac.destination);

      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.06;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 240;
      lfo.connect(lfoGain).connect(filter.frequency);
      lfo.start(t);

      const oscs = padPalette(name).map((f, i) => {
        const o = ac.createOscillator();
        o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = (i - 1) * 5;
        const g = ac.createGain();
        g.gain.value = i === 0 ? 0.5 : 0.26;
        o.connect(g).connect(filter);
        o.start(t);
        return o;
      });
      pad = { ac, out, oscs, lfo };
    } catch (_) { pad = null; }
  }

  /** 停掉一切 BGM（素材与合成），并清空状态 */
  function bgmStopAudio() {
    if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
    bgmEl = null;
    bgmUrl = null;
    bgmMode = null;
    bgmSynthName = null;
    synthPadStop();
  }

  function bgmStartSynth() {
    // ⚠️ 2026-10-08 用户要求「去掉默认的合成电子音」：素材缺失/被拦时**静默**，
    // 不再起 ambient pad 兜底（那玩意儿听起来就是电子嗡鸣）。
    bgmMode = null;
    bgmSynthName = null;
  }

  function bgmStartFile(url, name) {
    const gen = ++bgmGen;
    let settled = false;
    /** permanent=true 表示素材确实坏了（404），记下来别反复重试 */
    const fail = (permanent) => {
      if (gen !== bgmGen || settled) return;
      settled = true;
      if (permanent) bgmFailed = url;
      if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
      bgmEl = null;
      bgmUrl = null;
      bgmMode = null;
      bgmStartSynth(); // 静默（不合成）
    };
    try {
      const a = new global.Audio(encodeURI(url));
      // ⚠️ 2026-10-08：game 轨可与对手曲交替 → 不 loop，用 onended 切下一轮
      const alt = bgmPhase === 'game' && bgmOpponentUrl && bgmPlayOpponent
        && bgmOpponentUrl !== bgmTracks.game;
      a.loop = !alt;
      a.volume = bgmGain();
      a.onerror = () => fail(true);
      // ⚠️ 2026-10-08：换页续播 —— 同一首曲从上次位置继续，不从头来
      // 立刻 seek（metadata 可能尚未就绪，失败无害），再用 canplay 兜底
      const savedT = restoreBgmPosition(url);
      const seekSaved = () => {
        try {
          if (savedT > 0 && Number.isFinite(a.duration) && savedT < a.duration - 1 && Math.abs(a.currentTime - savedT) > 0.5) {
            a.currentTime = savedT;
          }
        } catch (_) { /* ignore */ }
      };
      seekSaved();
      if (typeof a.addEventListener === 'function') {
        a.addEventListener('loadedmetadata', seekSaved);
        a.addEventListener('canplay', seekSaved, { once: true });
      }
      setTimeout(seekSaved, 300);
      if (alt) {
        a.onended = () => {
          if (gen !== bgmGen) return;
          bgmAltIndex = bgmAltIndex === 0 ? 1 : 0;
          bgmSync(true);
        };
      }
      let p;
      try { p = a.play(); } catch (_) { fail(true); return; }
      if (gen !== bgmGen || settled) return;
      // play() 被拒（多半是自动播放策略）：**不**记 bgmFailed —— 手势解锁后要能重试
      if (p && p.catch) p.catch(() => fail(false));
      bgmEl = a;
      bgmUrl = url;
      bgmMode = 'file';
    } catch (_) { fail(true); }
  }

  /** 当前轨应播的 URL（game 轨在「自己/对手」间交替） */
  function currentTrackUrl() {
    if (bgmPhase === 'game' && bgmOpponentUrl && bgmPlayOpponent
      && bgmOpponentUrl !== bgmTracks.game) {
      return bgmAltIndex === 1 ? bgmOpponentUrl : (bgmTracks.game || bgmOpponentUrl);
    }
    return bgmTracks[bgmPhase] || null;
  }

  /**
   * 同步当前轨播放（幂等）。全局音乐关 / 当前轨无曲 → 停。
   * @param {boolean} [force] 强制重建（换轨/换曲时 true）
   */
  function bgmSync(force) {
    const wantOn = musicOn();
    const url = wantOn ? currentTrackUrl() : null;
    const name = url ? url.split('/').pop().replace(/\.[^.]+$/, '') : bgmPhase;

    // ⚠️ 同一首曲已在播/暂停 → 只恢复，不重建（重建会丢失播放进度）
    if (url && bgmMode === 'file' && bgmUrl === url && bgmEl) {
      if (bgmEl.paused) {
        try { const p = bgmEl.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      }
      return;
    }

    bgmStopAudio();
    if (!url) return;
    // ⚠️ 2026-10-08：素材确认缺失 → 静默（不再合成电子音兜底）
    if (bgmFailed === url) return;
    bgmStartFile(url, name);
  }

  /**
   * 设置三轨曲目 URL（null = 该轨静音）。
   * @param {{menu?:string|null, game?:string|null, endgame?:string|null}} tracks
   */
  function setTracks(tracks) {
    if (!tracks || typeof tracks !== 'object') return;
    for (const k of ['menu', 'game', 'endgame']) {
      if (tracks[k] !== undefined) bgmTracks[k] = tracks[k] || null;
    }
    bgmSync(true);
  }

  /**
   * 切换播放阶段（换曲）。
   * @param {'menu'|'game'|'endgame'} phase
   */
  function setPhase(phase) {
    const p = phase === 'game' || phase === 'endgame' ? phase : 'menu';
    if (p === bgmPhase) { bgmSync(false); return; }
    bgmPhase = p;
    bgmAltIndex = 0; // 换阶段从自己的曲起播
    bgmSync(true);
  }

  /**
   * ⚠️ 2026-10-08：设置对手开局曲（对局中交替播放）。
   * @param {string|null} url
   */
  function setOpponentTrack(url) {
    const next = url || null;
    if (next === bgmOpponentUrl) return;
    bgmOpponentUrl = next;
    bgmAltIndex = 0;
    bgmSync(true);
  }

  /** 音量（0–100 百分比；由 Settings.musicVolume 同步） */
  function applyMusicVolume(pct) {
    const v = Number(pct);
    bgmVolume = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5;
    if (bgmEl) { try { bgmEl.volume = bgmGain(); } catch (_) {} }
  }

  function applyPlayOpponentBgm(on) {
    bgmPlayOpponent = !!on;
    bgmAltIndex = 0;
    bgmSync(true);
  }

  function getPhase() { return bgmPhase; }
  function getTracks() { return { ...bgmTracks }; }

  /** 全局音乐开关（写 Settings.music 并同步内部状态） */
  function setMusicOn(on) {
    const v = !!on;
    bgmMusicOn = v;
    if (global.Settings) {
      try { global.Settings.set('music', v); } catch (_) { /* 仅内存 */ }
    }
    bgmSync(true);
  }

  /** 仅同步内部状态（Settings.apply 调用）；不可回调 setMusicOn */
  function applyMusicOn(on) {
    bgmMusicOn = !!on;
    bgmSync(true);
  }

  function isMusicOn() { return musicOn(); }

  /** 调试/测试：当前 BGM 状态 */
  function bgmState() {
    return {
      phase: bgmPhase,
      tracks: { ...bgmTracks },
      opponent: bgmOpponentUrl,
      altIndex: bgmAltIndex,
      volume: bgmVolume,
      mode: bgmMode,
      url: bgmUrl,
      synth: bgmSynthName,
      musicOn: musicOn(),
    };
  }

  // 兼容旧 API：bgmStart = 进入对局；bgmStop = 回菜单
  function bgmStart() { setPhase('game'); }
  function bgmStop() { setPhase('menu'); }

  /**
   * 试听专用：临时暂停 BGM（不清状态，resume 时从暂停点继续）。
   * 2026-10-08 用户要求「试听时应该停止正在播放的 bgm」。
   */
  function bgmPauseForPreview() {
    if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
  }
  /** 试听结束：恢复 BGM（若全局音乐开） */
  function bgmResumeFromPreview() {
    if (!musicOn()) return;
    if (bgmEl && bgmMode === 'file' && bgmEl.paused) {
      try { const p = bgmEl.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
  }

  /**
   * 跨页面续播：把当前播放位置写入 sessionStorage。
   * 2026-10-08 用户要求「换页不重新从头播放」。
   */
  function saveBgmPosition() {
    try {
      if (bgmEl && bgmUrl) {
        global.sessionStorage.setItem('tdshogi_bgm_pos', JSON.stringify({
          url: bgmUrl, t: bgmEl.currentTime || 0, phase: bgmPhase,
        }));
      }
    } catch (_) { /* 隐私模式：忽略 */ }
  }
  /** 恢复续播位置（返回秒数，无记录返回 0） */
  function restoreBgmPosition(url) {
    try {
      const raw = global.sessionStorage.getItem('tdshogi_bgm_pos');
      if (!raw) return 0;
      const o = JSON.parse(raw);
      if (o && o.url === url && Number.isFinite(o.t)) return Math.max(0, o.t);
    } catch (_) { /* ignore */ }
    return 0;
  }

  /** 对局开始：上扬双音 */
  function playStart() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.8;
    master.connect(ac.destination);
    [523, 784].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      const t = t0 + i * 0.09;
      env(g, t, 0.7, 0.18);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  /** 对局结束：下行双音 */
  function playEnd() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.8;
    master.connect(ac.destination);
    [392, 262].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      const t = t0 + i * 0.12;
      env(g, t, 0.7, 0.22);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  }

  /**
   * 设置音效开关。持久化统一交给 Settings（§S1）——它变更后会回调 `applyEnabled()`
   * 同步这里的内部状态。Settings 未加载时退回旧键，保证单独打开 sound.js 也能用。
   */
  function setEnabled(on) {
    if (global.Settings) { global.Settings.set('sound', !!on); return; }
    enabled = !!on;
    try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch (_) {}
  }

  /**
   * 仅同步内部状态（由 Settings.apply 调用）。
   * ⚠️ 这里**不可**再调 setEnabled，否则会 set → apply → set 递归。
   * 注意：行棋音效开关**不再**联动 BGM（2026-10-07 音乐独立开关）。
   */
  function applyEnabled(on) {
    enabled = !!on;
  }

  function isEnabled() { return enabled; }

  // ==================================================================
  // 初始化（2026-10-07）：从服务端拉三轨配置 + 本机已装备的对局曲
  // ==================================================================
  const BGM_GAME_KEY = 'tdshogi_bgm_game_url';

  /**
   * 装备 BGM 后由装扮页调用：覆盖「开局」轨并记住（刷新后仍生效）。
   * @param {string|null} url 站内音频 URL；null = 恢复系统默认开局曲
   */
  function setGameTrackOverride(url) {
    try {
      if (url) localStorage.setItem(BGM_GAME_KEY, url);
      else localStorage.removeItem(BGM_GAME_KEY);
    } catch (_) { /* 隐私模式：忽略 */ }
    if (url) setTracks({ game: url });
    else {
      bgmTracks.game = null;
      initFromServer();
    }
  }

  function gameTrackOverride() {
    try { return localStorage.getItem(BGM_GAME_KEY) || null; } catch (_) { return null; }
  }

  /**
   * 页面加载后拉取 BGM 三轨并起菜单曲。
   * ⚠️ 2026-10-08：带上会话令牌 —— 登录玩家返回**装备的**三首（默认自带），
   * 游客走系统默认轨。
   */
  function initFromServer() {
    let token = null;
    try {
      const g = JSON.parse(localStorage.getItem('tdshogi_guest') || 'null');
      if (g && g.id && String(g.id).includes('.')) token = g.id;
    } catch (_) { /* ignore */ }

    const applyRoles = (roles) => {
      if (!roles || typeof roles !== 'object') return;
      setTracks({
        menu: roles.menu || null,
        game: roles.game || null,
        endgame: roles.endgame || null,
      });
      if (bgmPhase === 'menu') setPhase('menu');
    };

    /** 棋子图集 / 读秒音（装扮装备）——写入全局供 board.js / playByoyomi 使用 */
    const applyAppearance = (ap) => {
      if (!ap || typeof ap !== 'object') return;
      try {
        if (ap.atlas) global.PIECE_ATLAS_DEFAULT = ap.atlas;
        if (ap.byoyomi != null) setByoyomiVariant(ap.byoyomi);
        // 让已渲染的棋盘按新图集重画（play.js / review.js 监听此事件）
        if (global.document && global.document.dispatchEvent) {
          global.document.dispatchEvent(new global.CustomEvent('tdshogi-appearance'));
        }
      } catch (_) { /* 外观失败不影响 BGM */ }
    };

    try {
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      fetch('/api/items/bgm-roles' + qs)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || !d.ok) return;
          applyRoles(d.roles);
          if (d.appearance) applyAppearance(d.appearance);
        })
        .catch(() => {});
    } catch (_) { /* 无 fetch：保持默认 */ }
  }

  // ==================================================================
  // 自动播放解锁（浏览器策略）：首次用户手势后起 BGM / 恢复 AudioContext。
  // 首页等非对局页没有 play.js 的 pointerdown 钩子，必须在这里兜底。
  // ==================================================================
  function unlockAudio() {
    try { ensureCtx(); } catch (_) { /* 无 AudioContext */ }
    if (musicOn()) bgmSync(true);
  }
  try {
    if (global.document && global.document.addEventListener) {
      for (const ev of ['pointerdown', 'click', 'keydown', 'touchstart']) {
        global.document.addEventListener(ev, unlockAudio, { once: true, passive: true });
      }
      // ⚠️ 2026-10-08：换页前存播放位置（换页不从头播）
      global.addEventListener('pagehide', saveBgmPosition);
      global.addEventListener('beforeunload', saveBgmPosition);
      // 每 2 秒自动存一次（pagehide 在某些浏览器/SPA 导航时不触发）
      setInterval(saveBgmPosition, 2000);
    }
  } catch (_) { /* 测试环境 */ }

  // 页面加载后立即拉轨并尝试起菜单曲（可能被自动播放策略拦下，手势后再起）
  if (global.document && global.document.addEventListener) {
    const boot = () => { try { initFromServer(); bgmSync(false); } catch (_) {} };
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  global.Sound = {
    playMove, playCapture, playByoyomi, playStart, playEnd,
    playMinuteWarning, playByoyomiMark,
    variant, setByoyomiVariant,
    // BGM 三轨（2026-10-07）+ 音量 / 对手 BGM 交替（2026-10-08）
    setTracks, setPhase, getPhase, getTracks,
    setOpponentTrack, applyMusicVolume, applyPlayOpponentBgm,
    setMusicOn, applyMusicOn, isMusicOn,
    setGameTrackOverride, gameTrackOverride, initFromServer,
    bgmStart, bgmStop, bgmSync, bgmState,
    bgmPauseForPreview, bgmResumeFromPreview,
    saveBgmPosition, restoreBgmPosition,
    setEnabled, applyEnabled, isEnabled, ensureCtx,
  };
})(window);

/* ==== js/hovercard.js ==== */
/**
 * hovercard.js — 选手信息悬停小窗（PLAN §F3）
 *
 * 用法：渲染名字元素时加 data-player-id="<playerId>" 属性即可，
 * 本脚本用事件委托自动接管，无需逐页绑定。仅展示公开信息，
 * 后端 /api/player-card 永不返回手机号。
 *
 * 交互：悬停 ~400ms 弹出；移开 150ms 后关闭；移入小窗保持；
 * ESC 关闭；同一玩家 30s 内复用缓存；视口边界自动翻转。
 */
(function () {
  const HOVER_DELAY = 400;
  const HIDE_DELAY = 150;
  const CACHE_TTL = 30 * 1000;

  const cache = new Map(); // playerId -> { data, ts }
  let el = null;
  let showTimer = null;
  let hideTimer = null;
  let currentId = null;
  // ⚠️ 2026-10-02 体验修复（可用动作）：内联举报面板的状态。
  let pinned = false;          // 举报面板打开时"钉住"卡片——鼠标移开也不隐藏
  let categories = [];         // 举报类别（优先用服务端 `hello.reportCategories` 下发的，与对局页同源）
  let reportPending = false;   // 是否有一条举报在等回执（用于把 `error` 归因到举报）

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'hover-card';
    el.style.display = 'none';
    el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    el.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(el);
    return el;
  }

  function scheduleHide() {
    if (pinned) return; // ⚠️ 举报面板打开中：别顺手把卡片关了（鼠标离开卡片是常事）
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  function hide() {
    pinned = false;
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    currentId = null;
  }

  async function fetchCard(playerId) {
    const hit = cache.get(playerId);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
    const res = await fetch(`/api/player-card?id=${encodeURIComponent(playerId)}`);
    if (!res.ok) throw new Error('player not found');
    const data = await res.json();
    cache.set(playerId, { data, ts: Date.now() });
    return data;
  }

  function render(data, playerId) {
    const badge = data.isAccount ? '🔐 账号' : '👤 游客';
    const dots = (data.recent || []).map((r) =>
      r === 'win' ? '<span class="hc-dot win">●</span>'
        : r === 'loss' ? '<span class="hc-dot loss">●</span>'
          : '<span class="hc-dot draw">●</span>'
    ).join('') || '<span style="color:var(--text-dim);font-size:11px;">暂无对局</span>';
    const rows = [];
    rows.push(`<div class="hc-row"><span class="hc-name">${esc(data.name)}${data.title ? `（${esc(data.title)}）` : ''}</span><span class="hc-badge">${badge}</span></div>`);
    rows.push(`<div class="hc-row stats"><span>Lv.${data.level ?? 0} · ELO <b>${data.rating}</b></span><span>${data.games} 局</span><span>胜率 <b>${data.winRate}%</b></span></div>`);
    if (data.style) rows.push(`<div class="hc-row"><span>⚔️ 棋风</span><span style="color:var(--gold-light);">${esc(data.style)}</span></div>`);
    if (data.createdAt) rows.push(`<div class="hc-row"><span>📅 注册于</span><span>${I18N.fmtDate(data.createdAt)}</span></div>`);
    rows.push(`<div class="hc-row"><span>近 10 局</span><span class="hc-dots">${dots}</span></div>`);
    // ⚠️ 2026-10-02 体验修复（图例）：那串圆点原本没有任何说明，第一次看的人不知道颜色
    //    代表什么。补一行图例，明确「绿 ● = 胜 / 红 ● = 负 / 灰 ● = 和」。
    rows.push(`<div class="hc-row hc-legend" style="font-size:11px;color:var(--text-dim);">
      <span>图例</span>
      <span><span class="hc-dot win">●</span> 胜 <span class="hc-dot loss">●</span> 负 <span class="hc-dot draw">●</span> 和</span>
    </div>`);
    // 个人页入口（2026-09-20 用户要求："其他人查看的个人页界面没有入口"）。
    // ⚠️ 放在**这张卡片**里，全站凡是有 `data-player-id` 的地方就都有入口了 ——
    // 比在每个页面各加一个链接省事得多，也不会漏掉某个列表。
    // 卡片自身有 mouseenter 取消隐藏，所以移进去点得到（见 ensureEl）。
    if (playerId) {
      // ⚠️ 2026-10-02 体验修复（可用动作）：把「查看个人页 / 举报」收成一行动作区。
      //    举报**复用既有流程**（WS `report` 协议，与对局页同一套服务端处理），不新造协议。
      //    `data-hc-report` 存 playerId，点击后由下面的委托打开内联举报面板。
      rows.push(`<div class="hc-row" style="margin-top:4px;justify-content:flex-end;gap:12px;">
        <a href="profile.html?player=${encodeURIComponent(playerId)}"
           style="color:var(--gold-light);font-size:12px;text-decoration:none;">👤 查看个人页 →</a>
        <button type="button" data-hc-report="${encodeURIComponent(playerId)}"
           style="background:none;border:none;color:var(--red-light);font-size:12px;cursor:pointer;padding:0;">🚩 举报</button>
      </div>`);
    }
    return rows.join('');
  }

  /** 定位：优先锚点下方，放不下翻到上方；横向夹在视口内 */
  function place(anchor) {
    const card = ensureEl();
    card.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x = r.left + window.scrollX;
    let y = r.bottom + window.scrollY + 8;
    if (x + cw > window.scrollX + document.documentElement.clientWidth - 8) {
      x = window.scrollX + document.documentElement.clientWidth - cw - 8;
    }
    if (r.bottom + ch + 8 > window.innerHeight) {
      y = r.top + window.scrollY - ch - 8; // 翻转到上方
    }
    card.style.left = Math.max(8, x) + 'px';
    card.style.top = Math.max(8, y) + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-player-id]');
    if (!target) return;
    const playerId = target.getAttribute('data-player-id');
    if (!playerId) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = setTimeout(async () => {
      if (currentId === playerId && el && el.style.display === 'block') return;
      const card = ensureEl();
      card.innerHTML = '<div class="hc-loading">加载中…</div>';
      currentId = playerId;
      card.style.display = 'block';
      place(target);
      try {
        const data = await fetchCard(playerId);
        if (currentId !== playerId) return; // 已移开
        card.innerHTML = render(data, playerId);
        place(target);
      } catch (_) {
        hide(); // 未知玩家/网络失败静默
      }
    }, HOVER_DELAY);
  });

  // ==================================================================
  // 举报（2026-10-02 体验修复）：复用**既有** WS `report` 协议（与对局页同一套服务端流程），
  // 不新造任何服务端协议。类别清单优先取服务端 `hello.reportCategories`（源头是
  // src/reports.js 的 CATEGORIES），拿不到时退化为单个「其他」（也是服务端认的合法类别），
  // 避免"提交必定失败"。⚠️ 被举报人的**显示名由服务端自己查**，这里不传（见 `_hReport`）。
  // ==================================================================
  function openReportPanel(playerId) {
    const card = ensureEl();
    const list = categories.length ? categories : [{ id: 'other', label: '其他' }];
    card.innerHTML = `
      <div class="hc-row"><span class="hc-name">🚩 举报玩家</span></div>
      <div style="font-size:11px;color:var(--text-dim);margin:6px 0;">选择类别，提交后由管理员处理</div>
      <select id="hcReportCategory" style="width:100%;margin-bottom:8px;">
        ${list.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}
      </select>
      <textarea id="hcReportDetail" rows="2" placeholder="补充说明（可选）"
        style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:8px;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" id="hcReportCancel"
          style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:12px;padding:3px 10px;cursor:pointer;">取消</button>
        <button type="button" id="hcReportSubmit"
          style="background:none;border:1px solid var(--red-light);border-radius:6px;color:var(--red-light);font-size:12px;padding:3px 10px;cursor:pointer;">提交</button>
      </div>`;
    card.querySelector('#hcReportCancel').addEventListener('click', () => hide());
    card.querySelector('#hcReportSubmit').addEventListener('click', () => submitReport(playerId));
  }

  function submitReport(playerId) {
    const card = ensureEl();
    // 没连上时 `send` 只会进队列、永远等不到回执 → 明确告知，别让用户以为提交成功了
    if (!window.API || !window.API.send || !window.API.connected) {
      return window.UI.alert('提交举报', '连接尚未就绪，请稍后再试');
    }
    const catEl = card.querySelector('#hcReportCategory');
    const detailEl = card.querySelector('#hcReportDetail');
    reportPending = true;
    window.API.send({
      type: 'report',
      data: {
        targetId: playerId,
        category: catEl ? catEl.value : 'other',
        detail: detailEl ? detailEl.value : '',
      },
    });
    hide(); // 回执（reported / error）到了再提示，避免面板挡着看不见
  }

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-player-id]')) scheduleHide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  // 点「🚩 举报」→ 钉住卡片并展开内联面板。
  // ⚠️ 用事件委托：卡片元素是后建的，委托到 document 最稳，也不怕卡片被重建。
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-hc-report]');
    if (!btn) return;
    e.preventDefault();
    const pid = decodeURIComponent(btn.getAttribute('data-hc-report') || '');
    if (!pid) return;
    pinned = true; // 钉住：鼠标移到面板上时别把卡片先关了
    openReportPanel(pid);
  });

  // 举报回执：成功用 toast（轻量、全站一致），失败用 `UI.alert`（要看清原因）
  if (window.API && window.API.on) {
    window.API.on('hello', (d) => { if (d && d.reportCategories) categories = d.reportCategories; });
    window.API.on('reported', () => {
      if (!reportPending) return;
      reportPending = false;
      window.UI.toast('举报已提交，管理员会尽快处理');
    });
    window.API.on('error', (d) => {
      if (!reportPending) return; // 只认自己这条举报的错误，别抢别处的提示
      reportPending = false;
      window.UI.alert('提交举报', (d && d.message) || '请稍后再试');
    });
  }

  window.HoverCard = { hide };
})();

/* ==== js/freeboard-dnd.js ==== */
/**
 * freeboard-dnd.js — 棋盘**输入交互层**：点选 / 点击 / 拖拽（Pointer Events）
 *
 * §M5（2026-09-28）：从 `public/js/freeboard.js`（原 667 行）整段搬出，只做两处机械变换
 * （方法首行改成 function 声明、整体左移 2 格缩进），**逻辑一字未改**。
 *
 * 装配方式：本文件只暴露工厂 `window.FreeBoardDnd.make(deps)`，由 `freeboard.js` 在
 * 类定义之后把方法注入原型：
 *
 *     Object.assign(FreeBoard.prototype, window.FreeBoardDnd.make({ sqToRC, DROP_NAME, ... }));
 *
 * 走工厂注入而非直接读全局，是为了让依赖**显式**：搬出来的代码仍能用裸名 `sqToRC` /
 * `DROP_NAME` / `DRAG_THRESHOLD_*`（它们是工厂形参，被闭包捕获），但依赖关系一眼可见，
 * 不依赖脚本加载顺序时机的巧合。
 *
 * ⚠️ 本文件必须在 `freeboard.js` **之前**加载（`freeboard.js` 装配时会检查，缺失即抛错）。
 *
 * 覆盖：`_canPickHand` · `_dragEnabled` · `bindHands` · `clearSelection` · `_selectFrom` ·
 *       `_tryTarget` · `_pickHand` · `_handleClick` · `_handleDblClick` ·
 *       `_handlePointerDown` · `_ensureGhost` · `_handleDocMove` · `_handleHandPointerDown` ·
 *       `_handleDocUp` · `_removeGhost`
 */
(function (global) {
  'use strict';

  /**
   * @param {{sqToRC:Function, DROP_NAME:Object, DRAG_THRESHOLD_MOUSE:number, DRAG_THRESHOLD_TOUCH:number}} deps
   * @returns {Object} 注入 `FreeBoard.prototype` 的方法表
   */
  function make({ sqToRC, DROP_NAME, DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH }) {
  function _canPickHand(color) {
    if (this.mode === 'review') return false;
    return this.mode === 'free' || !this.turnColor || color === this.turnColor;
  }

  /**
   * 是否允许「按住拖拽」走子（PLAN §S3）。
   *
   * 触屏设备默认**关闭**：手机上「想滚动页面」与「拖拽走子」手势冲突，
   * 极易误走一步；改用「点棋子 → 点目标格」两步点选更可靠
   * （81Dojo 移动版同样以点选为主）。桌面鼠标拖拽不受此设置影响。
   *
   * 关闭拖拽只影响 pointerdown 链路，**点击走子（_handleClick）完全不受影响**。
   */
  function _dragEnabled() {
    if (!global.Settings) return true;
    if (global.Settings.get('dragToMove')) return true;
    return !(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
  }

  function bindHands(myEl, myColor, oppEl, oppColor) {
    this.handsEls = { my: myEl, myColor, opp: oppEl, oppColor };
    // 驹台容器绑定 pointerdown：支持从驹台拖拽打入/放置（PLAN §H）
    if (myEl) {
      myEl.dataset.fbColor = myColor;
      myEl.addEventListener('pointerdown', (e) => this._handleHandPointerDown(e, myColor));
    }
    if (oppEl) {
      oppEl.dataset.fbColor = oppColor;
      oppEl.addEventListener('pointerdown', (e) => this._handleHandPointerDown(e, oppColor));
    }
  }

  function clearSelection() { this.selectedSq = null; this.selectedHand = null; this.render(); }

  // ---------- 选中/出招核心（模式间共享） ----------
  function _selectFrom(sq) {
    const targets = this.legalTargetsBySq[sq];
    if (!targets) return false; // 该棋子当前不可动
    this.selectedSq = sq;
    this.selectedHand = null;
    this.render();
    return true;
  }

  function _tryTarget(fromSq, toSq) {
    const targets = this.legalTargetsBySq[fromSq] || [];
    const t = targets.find((x) => x.to === toSq);
    if (!t) return false;
    this.selectedSq = null;
    // ⚠️ 2026-10-02 体验修复：清选中必须把**两种**选中态都清掉。此前只清 selectedSq，
    // 而 render() 会用「selectedHand || selectedSq」重铺高亮：若玩家先点了驹台（selectedHand 仍在），
    // 弹层背后就会残留一片打点绿点。棋盘走子 / 拖拽两条路径都会走到这里，一次修好两处。
    this.selectedHand = null;
    const promote = targets.find((x) => x.to === toSq && x.promote);
    const non = targets.find((x) => x.to === toSq && !x.promote);
    if (promote && non && this.onPromoteChoice) {
      this.render(); // ⚠️ 2026-10-02 体验修复：弹层前先重绘，清掉上一手的落点/目标高亮
      this.onPromoteChoice({ to: toSq, usiMove: non.usi, usiPromote: promote.usi });
    } else if (this.onMove) {
      this.onMove(t.usi);
    }
    return true;
  }

  function _pickHand(color, piece, sym) {
    if (this.selectedHand && this.selectedHand.color === color && this.selectedHand.piece === piece) {
      this.selectedHand = null;
    } else {
      this.selectedHand = { color, piece, sym: sym || Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece) };
      this.selectedSq = null;
    }
    this.render();
  }

  // ---------- 点击流 ----------
  function _handleClick(e) {
    if (!this.model) return;
    // review 模式：只读浏览，不依赖 interactive——只把点击的格子回执给页面
    // （如复盘页点击上一步的落点跳到该手）
    if (this.mode === 'review') {
      const rc = e.target.closest('.cell');
      if (rc && rc.dataset.sq && this.onSqClick) this.onSqClick(rc.dataset.sq);
      return;
    }
    if (!this.interactive || this._drag) return;
    const hand = e.target.closest('.hand-piece');
    if (hand && hand.parentElement && hand.parentElement.dataset.fbColor) {
      const color = hand.parentElement.dataset.fbColor;
      if (!this._canPickHand(color)) return; // 非手番方持驹禁选
      const piece = hand.dataset.piece;
      if (this.mode === 'free') { this._pickHand(color, piece); return; }
      const sym = Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
      if (sym && this.legalTargetsBySq[sym]) { this._pickHand(color, piece, sym); return; }
      return; // 该棋子无合法打点
    }
    const cell = e.target.closest('.cell');
    // ⚠️ 2026-10-02 体验修复：点在棋盘容器的**空白区域**（格子之间的内边距/边框，closest 不到 .cell）
    // 时不能静默 return——否则已选中的棋子/持驹与高亮会一直挂着。这里改为清除当前选中。
    if (!cell || !cell.dataset.sq) {
      if (this.selectedSq || this.selectedHand) clearSelection.call(this);
      return;
    }
    this._activateSq(cell.dataset.sq);
  }

  /**
   * §6.3：给定格名，执行「点击该格」的全部逻辑。
   *
   * 抽出来的唯一理由：**键盘 Enter 与鼠标点击必须共用同一处走子逻辑**——
   * 各写一份必然渐渐分叉（一处修了另一处忘改），这正是本项目反复踩的坑。
   */
  function _activateSq(sq) {
    if (!this.model || !sq) return;
    if (this.mode === 'review') { if (this.onSqClick) this.onSqClick(sq); return; }
    if (!this.interactive || this._drag) return;
    const [r, c] = sqToRC(sq);
    const cellPiece = this.model.board[r][c];
    // ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 选中态回执（接线）。
    // free 模式下 `selectedSq` 只在本函数里变更（鼠标点击 `_handleClick` 与键盘 Enter
    // 都汇到 `_activateSq`，见上方注释「键盘与鼠标必须共用同一处逻辑」），所以
    // 处理完再回执一次就够覆盖两条路径。回调收到的永远是**已经定稿**的 selectedSq
    // （例如「双击升变」的第二次点击会把选中取消 → 回执 null）。
    if (this.mode === 'free') {
      this._freeClick(sq);
      if (this.onSqSelect) this.onSqSelect(this.selectedSq);
      return;
    }
    if (this.selectedHand) {
      // ⚠️ 2026-10-02 体验修复：打子未命中合法落点（点到空白格 / 无可走目标区域）时清除选中，
      // 此前直接 return → 选中态与打点高亮一直挂着，玩家以为"点了没反应"。
      if (this._tryTarget(this.selectedHand.sym, sq)) { this.selectedHand = null; this.render(); }
      else { this.selectedHand = null; this.selectedSq = null; this.render(); }
      return;
    }
    if (this.selectedSq && this.selectedSq !== sq) {
      if (this._tryTarget(this.selectedSq, sq)) { this.selectedSq = null; this.render(); return; }
      // 未命中合法目标：点的是可再选的己方棋子 → 改选；否则清除选中（不再残留高亮）
      if (cellPiece && cellPiece.piece && this._selectFrom(sq)) return;
      this.selectedSq = null;
      this.render();
      return;
    }
    if (this.selectedSq === sq) { this.selectedSq = null; this.render(); return; }
    if (cellPiece && cellPiece.piece && this._selectFrom(sq)) return;
    // 无选中 / 点到不可动的棋子：落到这里都清一次，确保空白格不残留旧高亮
    this.selectedSq = null;
    this.render();
  }

  // ---------- 键盘走子（§6.3） ----------
  /** 在**显示网格**里找某格名的 [r,c]（与视角翻转同口径） */
  function _findDisplayRC(sq) {
    const cells = this.board && this.board.cells;
    if (!cells) return null;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (cells[r][c] && cells[r][c].dataset.sq === sq) return [r, c];
      }
    }
    return null;
  }

  /** 默认活动格：棋盘正中心（5e 一带），保证第一次按方向键就有落点 */
  function _defaultKbSq() {
    const cells = this.board && this.board.cells;
    if (!cells || !cells[4] || !cells[4][4]) return null;
    return cells[4][4].dataset.sq;
  }

  /** 把「活动格」同步到 ARIA（aria-activedescendant）并加一个可视焦点类 */
  function _syncKbFocus() {
    const el = this.board && this.board.boardEl;
    if (!el || !this._kbSq) return;
    const pos = _findDisplayRC.call(this, this._kbSq);
    if (!pos) return;
    const cell = this.board.cells[pos[0]][pos[1]];
    if (cell && cell.id && el.setAttribute) el.setAttribute('aria-activedescendant', cell.id);
    if (el.querySelectorAll) el.querySelectorAll('.cell.kb-active').forEach((x) => x.classList.remove('kb-active'));
    if (cell && cell.classList) cell.classList.add('kb-active');
  }

  /**
   * 棋盘键盘操作：**方向键**在显示网格里移动「活动格」，**Enter/Space** 等价于点击该格，
   * **Esc** 取消当前选中。仅对可交互棋盘生效（review 模式只允许移动 + 回执点击）。
   */
  function _handleKeydown(e) {
    if (!this.model) return;
    const review = this.mode === 'review';
    if (!review && (!this.interactive || this._drag)) return;
    const key = e.key;
    if (key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      this._kbSq = null;
      clearSelection.call(this);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (e.preventDefault) e.preventDefault();
      if (!this._kbSq) this._kbSq = _defaultKbSq.call(this);
      if (!this._kbSq) return;
      this._activateSq(this._kbSq);
      _syncKbFocus.call(this);
      return;
    }
    const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
    if (!dir) return;
    if (e.preventDefault) e.preventDefault();
    if (!this._kbSq) this._kbSq = _defaultKbSq.call(this);
    const pos = _findDisplayRC.call(this, this._kbSq) || [4, 4];
    const dr = Math.max(0, Math.min(8, pos[0] + dir[0]));
    const dc = Math.max(0, Math.min(8, pos[1] + dir[1]));
    const cell = this.board.cells[dr][dc];
    if (!cell) return;
    this._kbSq = cell.dataset.sq;
    _syncKbFocus.call(this);
  }

  function _handleDblClick(e) {
    if (!this.interactive || !this.model || this.mode !== 'free') return;
    const cell = e.target.closest('.cell');
    if (!cell || !cell.dataset.sq) return;
    this.togglePromote(cell.dataset.sq);
  }

  // ---------- 拖拽行棋（Pointer Events：鼠标/触屏通用） ----------
  function _handlePointerDown(e) {
    if (!this.interactive || !this.model || (e.button !== undefined && e.button !== 0)) return;
    if (!this._dragEnabled()) return; // §S3：触屏默认不拖拽（点选两步走子）
    const hand = e.target.closest('.hand-piece');
    let drag = null;
    if (hand && hand.parentElement && hand.parentElement.dataset.fbColor) {
      const color = hand.parentElement.dataset.fbColor;
      if (!this._canPickHand(color)) return; // 非手番方持驹禁拖
      const piece = hand.dataset.piece;
      const sym = Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
      if (this.mode === 'free') drag = { kind: 'hand-free', color, piece };
      else if (sym && this.legalTargetsBySq[sym]) drag = { kind: 'hand', color, piece, sym, fromSq: sym };
      if (!drag) return;
      drag.ghostSrc = hand.innerHTML;
    } else {
      const cell = e.target.closest('.cell');
      if (!cell || !cell.dataset.sq) return;
      const sq = cell.dataset.sq;
      const [r, c] = sqToRC(sq);
      const cellPiece = this.model.board[r][c];
      if (!cellPiece || !cellPiece.piece) return;
      if (this.mode === 'free') drag = { kind: 'cell-free', fromSq: sq };
      else if (this.legalTargetsBySq[sq]) drag = { kind: 'cell', fromSq: sq };
      else return; // 不可动的棋子
      const pieceEl = cell.querySelector('span, img, div');
      drag.ghostSrc = pieceEl ? pieceEl.outerHTML : cell.innerHTML;
    }
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.pointerId = e.pointerId;
    drag.pointerType = e.pointerType || 'mouse';
    this._drag = drag;
    this._docMove = (ev) => this._handleDocMove(ev);
    this._docUp = (ev) => this._handleDocUp(ev);
    document.addEventListener('pointermove', this._docMove);
    document.addEventListener('pointerup', this._docUp);
    // 触屏不 preventDefault：保留页面滚动能力，改由 CSS touch-action 控制棋盘区域
    if (drag.pointerType !== 'touch') e.preventDefault();
  }

  function _ensureGhost() {
    if (this._drag.ghost) return this._drag.ghost;
    const g = document.createElement('div');
    g.className = 'fb-drag-ghost';
    g.innerHTML = this._drag.ghostSrc;
    document.body.appendChild(g);
    this._drag.ghost = g;
    return g;
  }

  function _handleDocMove(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    // 触屏阈值更宽：手指按下难免微动，太灵敏会把"点一下"误判成拖拽
    const threshold = drag.pointerType === 'touch' ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < threshold) return;
    drag.moved = true;
    const ghost = this._ensureGhost();
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    // 触屏时把幽灵抬到手指上方，避免被手指完全遮住
    if (drag.pointerType === 'touch') ghost.style.transform = 'translate(-50%, -125%)';
    // 悬停格高亮
    document.querySelectorAll('.cell.drag-over').forEach((c) => c.classList.remove('drag-over'));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.cell');
    if (cell) cell.classList.add('drag-over');
  }

  /** 驹台拖拽起点：按住驹台棋子拖到目标格（rules 校验合法打点；free 自由放置） */
  function _handleHandPointerDown(e, color) {
    if (!this.interactive || !this.model) return;
    if (!this._dragEnabled()) return; // §S3：触屏默认不拖拽（点选两步打入）
    // 视角翻转后，监听器闭包捕获的 color 会与当前左右驹台不符
    // （setViewpoint 只交换配色标记、不重建监听器）→ 以元素上的 dataset.fbColor 为准纠正，
    // 避免「拖下方驹台却按对面身份打子」。§S6 复盘翻转与 §R1 观战翻转共用此修正。
    const holder = e.currentTarget;
    if (holder && holder.dataset && holder.dataset.fbColor) color = holder.dataset.fbColor;
    if (!this._canPickHand(color)) return; // 非手番方持驹禁拖
    const wrap = e.target.closest('.hand-piece');
    if (!wrap) return;
    const piece = wrap.dataset.piece;
    const sym = Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
    if (this.mode !== 'free') {
      if (!sym || !(this.legalTargetsBySq[sym] || []).length) return; // 无合法打点不可拖
    }
    const touch = e.pointerType === 'touch';
    this._drag = {
      kind: this.mode === 'free' ? 'hand-free' : 'hand',
      color, piece, sym, fromSq: sym,
      startX: e.clientX, startY: e.clientY, pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      ghostSrc: wrap.innerHTML,
    };
    this._docMove = (ev) => this._handleDocMove(ev);
    this._docUp = (ev) => this._handleDocUp(ev);
    document.addEventListener('pointermove', this._docMove);
    document.addEventListener('pointerup', this._docUp);
    if (!touch) e.preventDefault();
  }

  function _handleDocUp(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    document.removeEventListener('pointermove', this._docMove);
    document.removeEventListener('pointerup', this._docUp);
    this._drag = null;
    if (drag.ghost) drag.ghost.remove();
    document.querySelectorAll('.cell.drag-over').forEach((c) => c.classList.remove('drag-over'));
    if (!drag.moved) return; // 未拖动 → 交给 click 流程
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.cell');
    const toSq = cell && cell.dataset.sq;
    if (!toSq) return;
    if (drag.kind === 'cell-free' || drag.kind === 'hand-free') {
      if (drag.kind === 'cell-free') this._move(drag.fromSq, toSq);
      else this._drop(drag.color, drag.piece, toSq);
      return;
    }
    // play / demo-rules：目标是合法落点才出招
    const fromSq = drag.fromSq;
    if (fromSq === toSq) return;
    if (!this._tryTarget(fromSq, toSq)) {
      // 非法落点：无操作（棋子由模型重绘归位）
      this.render();
    } else {
      this.selectedSq = null;
      this.selectedHand = null;
      this.render();
    }
  }

  function _removeGhost() {
    if (this._drag && this._drag.ghost) this._drag.ghost.remove();
    document.querySelectorAll('.fb-drag-ghost').forEach((g) => g.remove());
  }

    // 注入表：freeboard.js 用 Object.assign(FreeBoard.prototype, …) 装配
    return {
      _canPickHand, _dragEnabled, bindHands, clearSelection,
      _selectFrom, _tryTarget, _pickHand, _handleClick, _handleDblClick,
      _activateSq, _handleKeydown,
      _handlePointerDown, _ensureGhost, _handleDocMove, _handleHandPointerDown,
      _handleDocUp, _removeGhost,
    };
  }

  global.FreeBoardDnd = { make };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/freeboard.js ==== */
/**
 * freeboard.js — 统一棋盘组件（PLAN §G v6，2026-09-08 优化）
 *
 * 四种模式（一个组件，全站共用）：
 *   play       对战：高亮服务端合法落点，onMove(usi) 交页面发送（服务端权威）
 *   demo-rules 感想战：同规则行棋，本地模型乐观渲染（服务端 demo 校验 + 广播）
 *   free       自由摆棋：不校验规则，本地草稿（撤销/双击升变，不入谱）
 *   review     复盘浏览：只读（不可选子/不可拖），自动带上一步与王手高亮（PLAN §M6）
 *
 * 所有「查看棋谱」的场景（复盘页 / 历史页 / 棋谱广场 / 管理后台回放 / 对局页终局浏览）
 * 都应使用 review 模式，保证渲染链路唯一。
 *
 * 交互：点击流 + 拖拽行棋（鼠标/触屏 Pointer Events，参考 lishogi/81dojo）。
 * 吃子/打子归属按正常将棋规则（被吃子恢复原始棋种进吃方驹台）。
 *
 * 坐标策略：模型统一用服务端 r/c 坐标，渲染交给 ShogiBoard（内部处理视角镜像）。
 * 棋种映射统一取自 `piece-kinds.js`（单一来源，加载时自检互逆）。
 */
(function (global) {
  // 棋种映射：取自单一来源 piece-kinds.js（不存在时退回内联备份，保证旧页面不炸）
  const K = global.PieceKinds || {};
  const PROMOTE = K.PROMOTE || { '歩': 'と', '香': '成香', '桂': '成桂', '銀': '成銀', '角': '馬', '飛': '龍' };
  const DEMOTE = K.DEMOTE || { 'と': '歩', '成香': '香', '杏': '香', '成桂': '桂', '圭': '桂', '成銀': '銀', '全': '銀', '馬': '角', '龍': '飛' };
  const DROP_NAME = K.DROP_NAME || { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛' };
  const rawOf = K.rawOf || ((name) => DEMOTE[name] || name);

  const MODES = ['play', 'demo-rules', 'free', 'review'];
  // 拖拽阈值：手指比鼠标抖，触屏放宽一点，避免点一下被判成拖拽
  const DRAG_THRESHOLD_MOUSE = 6;
  const DRAG_THRESHOLD_TOUCH = 12;

  function sqToRC(sq) {
    const x = parseInt(sq[0], 10) - 1;
    const y = sq.charCodeAt(1) - 97;
    return [y, x];
  }

  class FreeBoard {
    constructor({ board, viewpoint = 'b', interactive = false, mode = 'play', hands, onChange, onMove, onPromoteChoice, onSqClick = null } = {}) {
      this.board = board;            // ShogiBoard 实例
      this.viewpoint = viewpoint;
      this.interactive = !!interactive;
      this.mode = MODES.includes(mode) ? mode : 'play';
      this.handsEls = hands || null; // { my: el, myColor, opp: el, oppColor }
      this.onChange = onChange || null;
      this.onMove = onMove || null;          // (usi) => void
      this.onPromoteChoice = onPromoteChoice || null; // ({ usiMove, usiPromote }) => void
      this.onSqClick = onSqClick || null;    // (sq) => void，仅 review 模式：点击格子回执（如跳转到该手）
      this.model = null;             // { board, hands }
      this.lastMove = null;
      this.checkSquares = [];        // 王手格（J2：此前 setModel 的第三参被丢弃，高亮丢失）
      this.legalTargetsBySq = {};    // { fromSq|dropSym: [{to, usi, promote}] }
      this.turnColor = null;         // 当前手番 'b'|'w'（非 free 模式下限制只能选手番方持驹）
      this.history = [];             // free 模式撤销栈
      this.selectedSq = null;
      this.selectedHand = null;      // { color, piece, sym }
      this.danger = false;           // §U2：读秒 ≤10 秒的红色外框（由 play.js 判定后设置）
      this._onClick = (e) => this._handleClick(e);
      this._onDbl = (e) => this._handleDblClick(e);
      this._onPointerDown = (e) => this._handlePointerDown(e);
      this._onKey = (e) => this._handleKeydown(e);
      this._drag = null;
      this._onViewport = null;
      this._bindViewport();
    }

    /**
     * 视口变化（横竖屏旋转 / 窗口缩放）后重绘棋盘（PLAN §D）。
     *
     * ⚠️ **为什么必须补这个监听**：`render()` 只在"走子 / 装载局面"时被调用，
     * 而**旋转屏幕并不会走子**——不补的话，手机上转屏后棋盘会停在旧尺寸
     *（表现为错位、溢出、格子大小不匀）。
     *
     * 节流到 150ms：`resize` 是连续事件，而每次 `render()` 都要重建整棵树。
     */
    _bindViewport() {
      const g = (typeof window !== 'undefined') ? window : null;
      if (!g || !g.addEventListener) return;
      let timer = null;
      this._onViewport = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (this.model) this.render();
        }, 150);
      };
      g.addEventListener('resize', this._onViewport);
      g.addEventListener('orientationchange', this._onViewport);
    }

    // ---------- 装载 ----------
    /**
     * 装载局面。
     * @param {{board:Array, hands:object}} modelLike
     * @param {string|null} lastMove 上一步**落点格**（如 '7f'），不是完整 USI
     */
    setModel(modelLike, lastMove = null) {
      this.model = {
        board: JSON.parse(JSON.stringify(modelLike.board)),
        hands: JSON.parse(JSON.stringify(modelLike.hands || { b: [], w: [] })),
      };
      this.lastMove = lastMove;
      this.selectedSq = null;
      this.selectedHand = null;
      this.render();
    }

    /** 王手格（数组，元素为格子名如 '5e'）；传空数组清除（§J2） */
    setCheck(squares) {
      this.checkSquares = Array.isArray(squares) ? squares.filter(Boolean) : [];
      this.render();
    }

    /**
     * 危险状态（PLAN §U2）：读秒 ≤10 秒时给棋盘**外框**加红。
     *
     * ⚠️ 只负责"贴不贴 class"，**不判断该不该红**——调用方必须自行排除观战者。
     * 需求明确要求观战者不显示红框，而本组件在观战与对局两种情形下长得完全一样，
     * 无从区分（`PlayClock.isDanger()` 的注释写了同一条边界）。
     *
     * 用 class 而非重建 DOM：外框是**静态容器**，重建会打断过渡动画；
     * 何况 `render()` 每次走子都会跑，重建外框纯属浪费。
     */
    setDanger(on) {
      this.danger = !!on;
      this._applyDanger();
    }

    /** 把危险态贴到容器上（`render()` 末尾也调一次，防止容器被重建后标记丢失） */
    _applyDanger() {
      if (this.board && this.board.boardEl) {
        this.board.boardEl.classList.toggle('fb-danger', !!this.danger);
      }
    }

    /** 单独更新上一步落点 */
    setLastMove(sq) {
      this.lastMove = sq || null;
      this.render();
    }

    /** 切换模式：'play' | 'demo-rules' | 'free' | 'review' */
    setMode(mode) {
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      this.selectedSq = null;
      this.selectedHand = null;
      this.ruleTargets = null;
      this.render();
    }

    startFrom(stateLike) {
      this.setModel(stateLike, stateLike.lastMove || null);
      this.history = [JSON.stringify(this.model)];
    }

    getSnapshot() {
      return { position: JSON.parse(JSON.stringify(this.model)), lastMove: this.lastMove };
    }

    /**
     * 读某格的棋子（返回**副本**；空格 / 越界返回 null）。
     *
     * ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 最小读取 API。
     * 面板需要「这一格现在是什么子、属于哪一方、成没成」，而不该自己去做 r/c 换算、
     * 也不该直接摸 `model.board`（此前外部若直接改模型，会绕过撤销栈与重绘）。
     * @param {string} sq 格名（如 '5e'）
     * @returns {{piece:string, color:string, promoted:boolean, sq:string}|null}
     */
    getSquare(sq) {
      if (!this.model || !sq) return null;
      const [r, c] = sqToRC(sq);
      const row = this.model.board[r];
      const p = row ? row[c] : null;
      if (!p || !p.piece) return null;
      return { piece: p.piece, color: p.color, promoted: !!p.promoted, sq: p.sq || sq };
    }

    /**
     * 就地写入某格的棋子（`null` = 清空该格），压撤销栈后重绘。
     *
     * ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 最小写入 API。
     * 面板的「换棋种 / 翻转归属 / 清空该格」三件事**全部**走这里，理由是它复用了
     * `_pushHistory` + `_afterOp`，与既有 `_move` / `_drop` / `togglePromote` 是同一条
     * 落库与重绘链路 —— 于是「撤销摆放」(Ctrl+Z) 自然能回退面板的编辑，也无需新增渲染逻辑。
     * `color` 是模型里真实存在的归属字段（`board.js` 渲染时按 `piece.color` 决定棋子朝向），
     * 所以调用方可以真的翻转先手/后手，而不是只做一个视觉假象。
     * @param {string} sq 格名
     * @param {{piece:string, color:'b'|'w', promoted:boolean}|null} piece
     * @returns {boolean} 是否写入成功
     */
    setSquare(sq, piece) {
      if (!this.model || !sq) return false;
      const [r, c] = sqToRC(sq);
      if (!this.model.board[r]) return false;
      this._pushHistory();
      this.model.board[r][c] = piece
        ? { piece: piece.piece, color: piece.color, promoted: !!piece.promoted, sq }
        : null;
      this.selectedSq = sq;  // 编辑后保持该格选中：#freePalette 面板继续作用在同一格
      this.lastMove = null;  // 手工编辑不是「上一步」，清掉落点高亮以免误读
      this._afterOp();
      return true;
    }

    // ---------- 模式/开关 ----------
    // setMode 见上方「装载」区（带 MODES 校验）
    setInteractive(v) {
      this.interactive = !!v;
      if (!this.interactive) { this.selectedSq = null; this.selectedHand = null; }
      this.render();
    }
    setLegalTargets(map) { this.legalTargetsBySq = map || {}; }
    setRuleContext(ctx) { this.setLegalTargets(ctx ? ctx.legalTargetsBySq || {} : {}); } // 兼容旧调用
    /** 设置当前手番（'b'|'w'）：非 free 模式下，非手番方的持驹不可选（打子符号与颜色无关，
     *  否则演示者/玩家可点对手驹台的同种棋子，视觉上像从对手驹台打入） */
    setTurn(color) { this.turnColor = (color === 'b' || color === 'w') ? color : null; }
    /**
     * 切换视角（'b'|'w'），PLAN §R1：观战者可在先手 / 后手视角间切换。
     *
     * 只翻转 `board.render` 的 viewpoint 与驹台配色——**不换 DOM、不重建监听**：
     * 下方驹台（`handsEls.my`）始终呈现“当前视角方”的持驹，所以只需交换
     * `myColor / oppColor` 两个标记（`render()` 用它们决定各自渲染谁的持驹）。
     * 若改为交换 DOM 元素，`bindHands` 闭包里捕获的 color 就会与元素错位。
     */
    setViewpoint(vp) {
      if (vp !== 'b' && vp !== 'w') return;
      if (this.viewpoint === vp) return;
      this.viewpoint = vp;
      if (this.handsEls) {
        const { my, myColor, opp, oppColor } = this.handsEls;
        this.handsEls = { my, myColor: oppColor, opp, oppColor: myColor };
        if (my) my.dataset.fbColor = oppColor;
        if (opp) opp.dataset.fbColor = myColor;
      }
      // 视角变了，选中状态必须清掉：否则残留的选中格/持驹属于另一视角
      this.selectedSq = null;
      this.selectedHand = null;
      if (this.model) this.render();
    }
    /** 卸载：解除 resize/orientationchange 监听、detach 棋盘事件、移除幽灵元素并清空局面。
     *  ⚠️ 2026-10-02 审查 P3：类内原有**两个** destroy()，后者覆盖前者 → 前者的
     *  resize/orientationchange 卸载逻辑成了死代码、监听永不解除。已把两部分合并进这份，
     *  并删除被覆盖的那份（此前约 :92），类内现仅此一个 destroy()。 */
    destroy() {
      const g = (typeof window !== 'undefined') ? window : null;
      if (g && g.removeEventListener && this._onViewport) {
        g.removeEventListener('resize', this._onViewport);
        g.removeEventListener('orientationchange', this._onViewport);
      }
      this._onViewport = null;
      this.detach();
      this._removeGhost();
      this.model = null;
    }
    attach() {
      // ⚠️ 2026-10-02 体验修复：加幂等保护。attach() 此前无任何状态标记，一旦被调用两次
      //（同一 FreeBoard 复用 / 重复装配），`keydown` 会被挂上两个**相同**处理器，
      // 于是按一次方向键或 Enter 就触发两次走子（等于走两步 / 选中被瞬间取消）。
      // 这里用 _attached 兜底，保证四种监听（click/dblclick/pointerdown/keydown）只绑一次。
      if (this._attached) return;
      this._attached = true;
      const el = this.board.boardEl;
      // §6.3：棋盘是**可聚焦的 grid 部件**——Tab 能进来，方向键移格、Enter 走子、Esc 取消。
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'grid');
      el.setAttribute('aria-label', '将棋盘：方向键移动，Enter 选择或落子，Esc 取消');
      el.addEventListener('click', this._onClick);
      el.addEventListener('dblclick', this._onDbl);
      el.addEventListener('pointerdown', this._onPointerDown);
      el.addEventListener('keydown', this._onKey);
    }
    detach() {
      this._attached = false; // 复位：允许 detach 后再次 attach（不残留半绑定状态）
      this.board.boardEl.removeEventListener('click', this._onClick);
      this.board.boardEl.removeEventListener('dblclick', this._onDbl);
      this.board.boardEl.removeEventListener('pointerdown', this._onPointerDown);
      this.board.boardEl.removeEventListener('keydown', this._onKey);
      document.removeEventListener('pointermove', this._onDocMove);
      document.removeEventListener('pointerup', this._onDocUp);
    }



    // ---------- free 模式操作 ----------
    _freeClick(sq) {
      const [r, c] = sqToRC(sq);
      const cell = this.model.board[r][c];
      if (this.selectedHand) {
        if (cell && cell.piece) return;
        this._drop(this.selectedHand.color, this.selectedHand.piece, sq);
        return;
      }
      if (this.selectedSq && this.selectedSq !== sq) { this._move(this.selectedSq, sq); return; }
      if (this.selectedSq === sq) { this.selectedSq = null; this.render(); return; }
      if (cell && cell.piece) { this.selectedSq = sq; this.render(); }
    }

    _move(fromSq, toSq) {
      const [fr, fc] = sqToRC(fromSq);
      const [tr, tc] = sqToRC(toSq);
      const piece = this.model.board[fr][fc];
      if (!piece) return;
      this._pushHistory();
      const target = this.model.board[tr][tc];
      if (target && target.piece) {
        // 被吃子还原为原始棋种（成駒 → 未成），统一走 rawOf（单一来源，防 J3 复发）
        this._addToHand(piece.color, rawOf(target.piece));
      }
      this.model.board[tr][tc] = { piece: piece.piece, color: piece.color, promoted: !!piece.promoted, sq: toSq };
      this.model.board[fr][fc] = null;
      this.selectedSq = null;
      this.lastMove = toSq;
      this._afterOp();
    }

    _drop(color, piece, sq) {
      const [r, c] = sqToRC(sq);
      if (this.model.board[r][c] && this.model.board[r][c].piece) return;
      this._pushHistory();
      const list = this.model.hands[color] || [];
      const idx = list.findIndex((h) => h.piece === piece);
      if (idx < 0) { this.history.pop(); return; }
      list[idx].count -= 1;
      if (list[idx].count <= 0) list.splice(idx, 1);
      this.model.board[r][c] = { piece, color, promoted: false, sq };
      this.selectedHand = null;
      this.lastMove = sq;
      this._afterOp();
    }

    togglePromote(sq) {
      const [r, c] = sqToRC(sq);
      const piece = this.model.board[r][c];
      if (!piece || !piece.piece) return;
      let next = null;
      if (PROMOTE[piece.piece]) next = { name: PROMOTE[piece.piece], promoted: true };
      else if (DEMOTE[piece.piece]) next = { name: DEMOTE[piece.piece], promoted: false };
      if (!next) return;
      this._pushHistory();
      piece.piece = next.name;
      piece.promoted = next.promoted;
      this._afterOp();
    }

    undo() {
      if (this.history.length <= 1) return false;
      this.history.pop();
      this.model = JSON.parse(this.history[this.history.length - 1]);
      this.selectedSq = null;
      this.selectedHand = null;
      this._afterOp();
      return true;
    }

    _pushHistory() {
      this.history.push(JSON.stringify(this.model));
      if (this.history.length > 200) this.history.shift();
    }

    _afterOp() {
      this.render();
      if (this.onChange) this.onChange(this.getSnapshot());
    }

    _addToHand(color, piece) {
      const list = this.model.hands[color] = this.model.hands[color] || [];
      const h = list.find((x) => x.piece === piece);
      if (h) h.count += 1;
      else list.push({ piece, count: 1 });
    }

    // ---------- 规则模式：合法 USI 应用到模型（推演乐观渲染/谱面重放） ----------
    applyUsi(usi, color) {
      if (!this.model) return;
      applyUsiOnModel(this.model, usi, color);
      const isDrop = /^([PLNSGBR])\*/.test(usi);
      this.lastMove = isDrop ? usi.slice(2) : usi.slice(2, 4);
    }

    // ---------- 渲染 ----------
    render() {
      if (!this.model) return;
      // §J2：check 此前从未传给 board.render，王手红格高亮一直不显示
      this.board.render(
        { board: this.model.board },
        { lastMove: this.lastMove, check: this.checkSquares },
        this.viewpoint
      );
      if (this.selectedSq) this.board.highlightSq(this.selectedSq, 'sel');
      const from = this.selectedHand ? this.selectedHand.sym : this.selectedSq;
      const targets = from ? (this.legalTargetsBySq[from] || []) : [];
      for (const t of targets) this.board.highlightSq(t.to, 'target');
      if (this.handsEls) {
        const pick = (color, sym) => (piece) => {
          if (!this.interactive) return;
          if (!this._canPickHand(color)) return; // 非手番方持驹禁选
          if (this.mode === 'free') { this._pickHand(color, piece); return; }
          const s = sym || Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
          if (!s || !this.legalTargetsBySq[s]) return; // 该棋子无合法打点
          // 驹台点击走这里（棋盘容器不含驹台，_handleClick 的 hand 分支不可达）：
          // 再次点击同种持驹 = 放下（取消选中）；点击其他种类 = 切换选中
          this._pickHand(color, piece, s);
        };
        const vp = this.viewpoint;
        if (this.handsEls.opp) global.renderHands(this.handsEls.opp, this.model.hands, this.handsEls.oppColor, this.interactive ? pick(this.handsEls.oppColor) : null, vp);
        if (this.handsEls.my) global.renderHands(this.handsEls.my, this.model.hands, this.handsEls.myColor, this.interactive ? pick(this.handsEls.myColor) : null, vp);
      }
      // ⚠️ 2026-10-02 体验修复：驹台（持驹）选中态高亮。此前 selectedHand 只用来点亮棋盘打点，
      // 驹台本身没有任何视觉反馈——玩家点了自己的持驹却看不出"已选中、接下来点棋盘落子"。
      // renderHands 每次都重建 .hand-piece 节点（内联样式随之清空），故在其后按选中信息补高亮。
      if (this.selectedHand) {
        const held = this.selectedHand;
        const container = (this.handsEls && this.handsEls.myColor === held.color) ? this.handsEls.my
          : (this.handsEls && this.handsEls.oppColor === held.color) ? this.handsEls.opp : null;
        if (container && container.querySelector) {
          const sel = container.querySelector('.hand-piece[data-piece="' + held.piece + '"]');
          if (sel) {
            sel.classList.add('hand-sel');
            sel.style.outline = '3px solid var(--gold, #c9a227)';
            sel.style.outlineOffset = '2px';
            sel.style.borderRadius = '6px';
            sel.style.background = 'rgba(201, 162, 39, 0.30)';
          }
        }
      }
      this._applyDanger(); // §U2：棋盘重建后重新贴危险外框
    }
  }

  // ==================================================================
  // §M5（2026-09-28）：输入交互层（点选/点击/拖拽）已拆到 freeboard-dnd.js
  // ==================================================================
  // ⚠️ 该文件必须在本文件**之前**加载（见 public/play.html、public/review.html 的
  // <script> 顺序）。缺了就当场抛错——否则症状会是"棋盘点了没反应"这种**静默**故障
  // （页面照常渲染、控制台连红字都没有），排查成本极高。
  if (!global.FreeBoardDnd) {
    throw new Error('freeboard-dnd.js 必须在 freeboard.js 之前加载（<script> 顺序错了）');
  }
  Object.assign(FreeBoard.prototype, global.FreeBoardDnd.make({
    sqToRC, DROP_NAME, DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH,
  }));

  /** 标准平手初始盘面模型（谱面浏览/重放用） */
  function initialModel() {
    const board = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => ({ piece: null, color: null, promoted: false, sq: `${c + 1}${String.fromCharCode(97 + r)}` })));
    const set = (r, c, piece, color) => { board[r][c] = { piece, color, promoted: false, sq: `${c + 1}${String.fromCharCode(97 + r)}` }; };
    const backW = ['香', '桂', '銀', '金', '玉', '金', '銀', '桂', '香'];
    for (let c = 0; c < 9; c++) { set(0, c, backW[c], 'w'); set(8, c, backW[c], 'b'); set(2, c, '歩', 'w'); set(6, c, '歩', 'b'); }
    set(1, 1, '角', 'w'); set(1, 7, '飛', 'w');
    set(7, 1, '飛', 'b'); set(7, 7, '角', 'b');
    return { board, hands: { b: [], w: [] } };
  }

  /**
   * 将一步合法 USI 应用到模型（纯结构变换：移动/吃子/打子/升变）。
   * color：该手的行棋方。规则已由服务端校验。
   */
  function applyUsiOnModel(model, usi, color) {
    const dropM = /^([PLNSGBR])\*([1-9])([a-i])$/.exec(usi);
    if (dropM) {
      const piece = DROP_NAME[dropM[1]];
      const sq = usi.slice(2);
      const [r, c] = sqToRC(sq);
      const list = model.hands[color] = model.hands[color] || [];
      const idx = list.findIndex((h) => h.piece === piece);
      if (idx >= 0) {
        list[idx].count -= 1;
        if (list[idx].count <= 0) list.splice(idx, 1);
      }
      model.board[r][c] = { piece, color, promoted: false, sq };
      return;
    }
    if (usi.length >= 4) {
      const fromSq = usi.slice(0, 2);
      const toSq = usi.slice(2, 4);
      const promote = usi[4] === '+';
      const [fr, fc] = sqToRC(fromSq);
      const [tr, tc] = sqToRC(toSq);
      const piece = model.board[fr][fc];
      if (!piece || !piece.piece) return;
      const target = model.board[tr][tc];
      if (target && target.piece) {
        const raw = rawOf(target.piece);
        const list = model.hands[color] = model.hands[color] || [];
        const h = list.find((x) => x.piece === raw);
        if (h) h.count += 1;
        else list.push({ piece: raw, count: 1 });
      }
      let name = piece.piece;
      let promoted = !!piece.promoted;
      if (promote) { name = PROMOTE[name] || name; promoted = true; }
      model.board[tr][tc] = { piece: name, color: piece.color, promoted, sq: toSq };
      model.board[fr][fc] = null;
    }
  }

  global.FreeBoard = FreeBoard;
  FreeBoard.initialModel = initialModel;
  FreeBoard.applyUsiOnModel = applyUsiOnModel;
  // 常量与纯函数导出：供单元测试直接加载断言（tests/，PLAN §P1）
  FreeBoard.MODES = MODES;
  FreeBoard.sqToRC = sqToRC;
  FreeBoard.PROMOTE = PROMOTE;
  FreeBoard.DEMOTE = DEMOTE;
  FreeBoard.DROP_NAME = DROP_NAME;
  FreeBoard.DRAG_THRESHOLD_MOUSE = DRAG_THRESHOLD_MOUSE;
  FreeBoard.DRAG_THRESHOLD_TOUCH = DRAG_THRESHOLD_TOUCH;
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/play-clock.js ==== */
/**
 * play-clock.js — 对局棋钟（本时倒计时 + 读秒）
 *
 * 从 `play.js` 抽出（PLAN §M5 前端拆分第一步）。**逻辑一字未改**，只把两处对外部
 * 状态的读取改成了注入的回调——因为它们在 play.js 里原本是 IIFE 的闭包变量：
 *   - `getState()`     取最新对局状态（原闭包变量 `state`）
 *   - `getViewpoint()` 取当前显示视角（原 `mySeat === 'w' ? 'w' : 'b'`）
 *
 * 对外接口（由 play.js 调用）：
 *   PlayClock.init({ getState, getViewpoint })  注入依赖并启动 tick
 *   PlayClock.syncFromState(state)              state 消息里的棋钟字段
 *   PlayClock.syncFromServer(data)              clock 消息（走子后以服务端校准）
 *   PlayClock.resetTick()                       以"此刻"为基准（收到服务端消息时）
 *   PlayClock.update()                          强制刷新显示
 *
 * 依赖：DOM 元素 `#topClock` / `#bottomClock`；读秒音效走 `window.Sound`。
 */
(function () {
  'use strict';

  let getState = function () { return null; };
  let getViewpoint = function () { return 'b'; };

  // 本时剩余 / 当前手读秒剩余 / 是否在读秒 / 秒读时长
  let localClocks = { b: 15 * 60 * 1000, w: 15 * 60 * 1000 };
  let localByoyomi = { b: 0, w: 0 };
  let inByoyomi = { b: false, w: false };
  let byoyomiDuration = 0;
  let lastTickTs = Date.now();
  let lastTickSecond = -1;  // 读秒音效：记录上次"嗒"的秒数（跨秒触发）
  // §U1 提醒边界：**按座位分别记**——用一个变量的话，换手时数值会从
  // "我方剩余"跳到"对方剩余"，表现为凭空跨过若干个整分钟，一口气连响好几声。
  let lastMinuteMark = { b: -1, w: -1 };   // 本时：上次已提醒的"剩余整分钟数"
  let lastByoyomiMark = { b: -1, w: -1 };  // 读秒：上次已报时的"剩余整十秒数"
  let timer = null;
  // §U2：每次刷新显示后的回调 (state) => void —— play.js 用它同步"危险外框"等派生 UI。
  // 挂在这里而不是让 play.js 自己开定时器：棋钟本来就每 500ms 在跑，没必要再来一个。
  let onTick = null;

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function $(id) { return window.UI.$(id); }

  function fmtClock(ms, isByoyomi) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    if (isByoyomi) return `读秒 ${sec}`; // 读秒：加「读秒」前缀，避免裸秒数被误读
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function displayFor(seat) {
    // 本时用尽且进入读秒 → 显示读秒剩余；否则显示本时
    if (inByoyomi[seat] && byoyomiDuration > 0) return fmtClock(localByoyomi[seat], true);
    return fmtClock(localClocks[seat], false);
  }

  function update() {
    const state = getState();
    const vp = getViewpoint() === 'w' ? 'w' : 'b';
    const oppSeat = vp === 'b' ? 'w' : 'b'; // 上方=对面
    const mySeatH = vp;                     // 下方=自己
    $('topClock').textContent = displayFor(oppSeat);
    $('bottomClock').textContent = displayFor(mySeatH);
    const lowOpp = inByoyomi[oppSeat] ? localByoyomi[oppSeat] <= 10000 : localClocks[oppSeat] <= 10000;
    const lowMe = inByoyomi[mySeatH] ? localByoyomi[mySeatH] <= 10000 : localClocks[mySeatH] <= 10000;
    $('topClock').classList.toggle('low', lowOpp && state && state.turn === oppSeat);
    $('bottomClock').classList.toggle('low', lowMe && state && state.turn === mySeatH);
    // §U2：把"该不该红框"交给 play.js —— 它才知道我是选手还是观战者。
    // 回调里做的是幂等的 class toggle，500ms 一次的开销可以忽略。
    if (onTick) { try { onTick(state); } catch (_) { /* 派生 UI 出错不该拖垮棋钟 */ } }
  }

  /**
   * 按当前手番推进 `dtMs` 毫秒（**纯扣减**，tick 与单测共用）。
   *
   * 把这段逻辑从 tick 里拎出来，是为了让它**不依赖定时器也能被验证**——
   * 时间算错是用户立刻能感知的错误，不能只靠"跑起来看着对"。
   * 非 PLAYING（未开局 / 已终局）不扣时，由本函数自行判断，调用方无需关心。
   *
   * §U1 在此加入**两级时间提醒**（三种音两两可区分）：
   *   - 本时每跨过一个整分钟 → `playMinuteWarning()`（低、长）
   *   - 读秒每跨过 10 秒（60/50/40/30/20）→ `playByoyomiMark()`（中频双音）
   *   - 读秒 ≤10 秒 → `playByoyomi()`（高频短「嗒」，原有）
   */
  function advance(dtMs) {
    const state = getState();
    if (!state || state.status !== 'PLAYING') return;
    const turn = state.turn;
    if (inByoyomi[turn] && byoyomiDuration > 0) {
      maybeEndgamePhase(); // 进读秒 ⇒ 终盘曲（幂等）
      localByoyomi[turn] = Math.max(0, localByoyomi[turn] - dtMs);

      // §U1：读秒每跨过 10 秒报时一次。
      // **刻意不含 10 秒**——那一拍交给下面的逐秒「嗒」，否则两个音会叠在一起。
      const mark = Math.ceil(localByoyomi[turn] / 10000);
      if (lastByoyomiMark[turn] === -1) {
        lastByoyomiMark[turn] = mark; // 首次只记录、不补响（进对局/换手瞬间不该出声）
      } else if (mark !== lastByoyomiMark[turn]) {
        if (mark >= 2 && mark <= 6 && window.Sound) window.Sound.playByoyomiMark();
        lastByoyomiMark[turn] = mark;
      }

      // 读秒 ≤10 秒：每秒「嗒」（跨秒边界触发，含 10 与 1）
      const sec = Math.ceil(localByoyomi[turn] / 1000);
      if (sec >= 1 && sec <= 10 && sec !== lastTickSecond) {
        if (window.Sound) window.Sound.playByoyomi();
        lastTickSecond = sec;
      }
      if (sec > 10) lastTickSecond = -1;
    } else {
      localClocks[turn] = Math.max(0, localClocks[turn] - dtMs);

      // §U1：本时每跨过一个整分钟提醒一次（mm = 剩余整分钟数）
      // ⚠️ 条件用 `mm >= 0` 而不是 `>= 1`：`Math.ceil` 使 mm=1 覆盖 (0, 60000]，
      // 从 1:00 走到 0:00 时 mm 由 1 变 0 —— 这一跨也是"跨过一个整分钟"，
      // 用 >=1 会把最后一分钟那条提醒吞掉。mm=0 之后不再变化，不会重复响。
      const mm = Math.ceil(localClocks[turn] / 60000);
      if (lastMinuteMark[turn] === -1) {
        lastMinuteMark[turn] = mm; // 首次只记录、不补响
      } else if (mm !== lastMinuteMark[turn]) {
        if (mm >= 0 && window.Sound) window.Sound.playMinuteWarning();
        lastMinuteMark[turn] = mm;
      }
    }
  }

  /**
   * 重置全部提醒边界为"下一条服务端消息到达时的值"。
   *
   * **收到任何时间校准后都必须调用**：本地与服务端时钟存在偏差，
   * 不重置就会表现为"凭空跨过几个整分钟"，一口气连响好几声。
   */
  function resetMarks() {
    lastMinuteMark = { b: -1, w: -1 };
    lastByoyomiMark = { b: -1, w: -1 };
    lastTickSecond = -1;
  }

  /**
   * 当前手番方是否处于「读秒 ≤10 秒」的危险状态（PLAN §U2，供棋盘红框使用）。
   *
   * ⚠️ 这里只回答**时间事实**，不判断"是不是自己"——那是调用方的责任：
   * 需求明确要求**观战者不显示红框**，而观战者（`mySeat === null`）只能由
   * `play.js` 排除。把这条判断挪进来，观战者也会跟着变红。
   */
  function isDanger() {
    const state = getState();
    if (!state || state.status !== 'PLAYING') return false;
    const turn = state.turn;
    return !!(inByoyomi[turn] && byoyomiDuration > 0 && localByoyomi[turn] <= 10000);
  }

  /** 本地棋钟 tick（每 500ms） */
  function tick() {
    const state = getState();
    // ⚠️ 非 PLAYING 时**不更新 lastTickTs**——保持抽出前的语义
    // （暂停期间不计入倒计时基准；恢复时服务端 state 消息会 resetTick 重新校准）
    if (!state || state.status !== 'PLAYING') { update(); return; }
    const now = Date.now();
    const dt = now - lastTickTs;
    lastTickTs = now;
    advance(dt);
    update();
  }

  /** state 消息里的棋钟字段（原 play.js `render()` 中的棋钟初始化） */
  function syncFromState(state) {
    if (state.clock) {
      localClocks.b = state.clock.b;
      localClocks.w = state.clock.w;
    }
    // ⚠️ 2026-10-04 修复：原来只在 `state.inByoyomi` 为真值时才更新读秒状态，
    // 而**包干局**（byoyomi=0）服务端下发的是 `null` → 上一局残留的 `inByoyomi=true`
    // 会一直留着，显示卡在「读秒 N」。改为按 `byoyomi` 判断：>0 才启用读秒，=0 显式清空。
    const by = state.byoyomi || 0;
    byoyomiDuration = by;
    if (by > 0) {
      inByoyomi = state.inByoyomi ? { ...state.inByoyomi } : { b: false, w: false };
      localByoyomi = state.curByoyomi ? { ...state.curByoyomi } : { b: 0, w: 0 };
    } else {
      inByoyomi = { b: false, w: false };
      localByoyomi = { b: 0, w: 0 };
    }
    lastAnchorTurn = state.turn || lastAnchorTurn;
    resetMarks(); // §U1：以服务端时间为新基准，避免时间跳变连响
    maybeEndgamePhase();
    update();
  }

  /**
   * ⚠️ 2026-10-07 BGM 三轨：任一方进入读秒 ⇒ 切「终盘」曲（制勝 等）。
   * 只从 game → endgame 单向切换（终盘不会退回开局曲），避免读秒边界反复横跳。
   */
  function maybeEndgamePhase() {
    if (!window.Sound || typeof window.Sound.setPhase !== 'function') return;
    const anyByo = !!(inByoyomi && (inByoyomi.b || inByoyomi.w));
    if (!anyByo) return;
    if (window.Sound.getPhase && window.Sound.getPhase() === 'endgame') return;
    window.Sound.setPhase('endgame');
  }

  // ⚠️ 2026-10-04 修复（棋钟与服务端不同步）：把"当前手番"记为锚点手番，
  // 用于判断 clock 消息（每秒广播）是否发生了**手番切换**——见下方 syncFromServer。
  let lastAnchorTurn = null;

  /**
   * clock 消息：服务端**每秒广播**（`src/rooms/clock.js` 的 `_tick`），是权威时间的锚点。
   *
   * ⚠️ 2026-10-04 修复（两处，同一根因导致的）：
   *  1. **载荷形状读错**：服务端发的是 `{ clock:{b,w}, byoyomi, curByoyomi, inByoyomi, turn }`，
   *     而这里原来读 **`data.b` / `data.w`**（扁平字段）——永远不是数字，于是每秒一次的
   *     校准被**静默丢弃**：本时只在收到 `state` 时才被纠正，中途本地计数的任何偏差都会
   *     一直累积，最终表现为「本地还显示有时间、服务端已判定时间切れ」。
   *     现在按真实形状读取（`data.clock`），并保留扁平写法兜底。
   *  2. **提醒边界被每秒清零**：原来每次消息都 `resetMarks()`，而标记的语义是
   *     「首次只记录、不补响」，于是分钟提醒与读秒「嗒」声**永远走不到"变化"分支 → 不响**。
   *     改为**仅在手番切换时**重置（同一手番内的每秒校准不动提醒状态）。
   */
  function syncFromServer(data) {
    if (!data) return;
    // 本时：优先服务端真实形状 `data.clock`；兼容历史/测试用的扁平 `data.b/w`
    const c = data.clock || (typeof data.b === 'number' ? { b: data.b, w: data.w } : null);
    if (c && typeof c.b === 'number' && typeof c.w === 'number') {
      localClocks.b = c.b;
      localClocks.w = c.w;
    }
    if (data.byoyomi != null) byoyomiDuration = data.byoyomi;
    // ⚠️ 2026-10-04 修复（同 syncFromState）：包干局服务端不下发 inByoyomi/curByoyomi
    // （为 null），此时必须**显式清空**，否则会沿用上一局残留的读秒状态、显示卡在「读秒 N」。
    if (data.curByoyomi) {
      localByoyomi = { ...data.curByoyomi };
    } else if (byoyomiDuration === 0) {
      localByoyomi = { b: 0, w: 0 };
    }
    if (data.inByoyomi) {
      inByoyomi = { ...data.inByoyomi };
    } else if (byoyomiDuration === 0) {
      inByoyomi = { b: false, w: false };
    }
    lastTickTs = Date.now();
    // 只在手番变化时重置提醒边界（每秒都重置会吞掉提醒音）
    if (data.turn && data.turn !== lastAnchorTurn) {
      lastAnchorTurn = data.turn;
      resetMarks();
    }
    maybeEndgamePhase();
    update();
  }

  /**
   * 以「此刻」为倒计时基准。
   * 收到任何服务端消息时调用，否则会把「等待对方思考」的时长也算进自己的倒计时。
   */
  function resetTick() { lastTickTs = Date.now(); }

  function start() { if (!timer) timer = setInterval(tick, 500); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function init(opts) {
    const o = opts || {};
    if (typeof o.getState === 'function') getState = o.getState;
    if (typeof o.getViewpoint === 'function') getViewpoint = o.getViewpoint;
    if (typeof o.onTick === 'function') onTick = o.onTick; // §U2：同步危险外框等派生 UI
    start();
  }

  window.PlayClock = {
    init, syncFromState, syncFromServer, resetTick, update, start, stop,
    advance,    // 单测用：不经定时器直接推进 dtMs
    isDanger,   // §U2 棋盘红框用：当前手番方是否读秒 ≤10 秒（调用方需自行排除观战者）
    resetMarks, // 单测用：重置提醒边界
  };
})();

/* ==== js/play-chat.js ==== */
/**
 * play-chat.js — 对局页「聊天 + 观众列表」（PLAN §M5 前端拆分第 2 步）
 *
 * 从 `play.js` 抽出（第一步是 `play-clock.js`）。选它先搬的原因：**与对局状态零耦合**——
 * 聊天记录、分区 tab、观众名单都是自成一体的（只碰 DOM 与 WS 事件），
 * 不像感想战那样要读写 `state` / `fb` / `cursor` 一堆闭包变量。**搬过来逻辑一字未改**。
 *
 * 对外接口（由 `play.js` 调用）：
 *   PlayChat.init()                  注册 WS 事件与 DOM 交互（在 `api.connect()` 之后调；幂等）
 *   PlayChat.renderSpectators(list)  state 快照里的观众名单（首屏初始化用——此前只有
 *                                    `spectator_update` 才渲染，导致刚进场的人一直看到「暂无观众」）
 *
 * 依赖：`window.API`、`window.UI`（`$` / `esc`）、`window.Settings`（观众进出提示开关）
 *       DOM：`#chatBox` `#chatInput` `#btnChatSend` `#chatTabs` `#spectatorList` `#spectatorCount`
 *
 * ⚠️ 加载顺序：必须在 `play.js` **之前**（play.js 会调它的接口）。
 */
(function () {
  'use strict';

  const api = window.API;
  const $ = (id) => window.UI.$(id);
  // 公共工具（PLAN §M5）：与全站同一份实现，此处只转发
  function escHtml(s) { return window.UI.esc(s); }

  // ==================================================================
  // 观众列表（PLAN §R）
  // ==================================================================
  /**
   * 兼容两种形态：字符串数组（旧）与 `{id,name,rating,level}`（新）。
   */
  function renderSpectators(list) {
    const countEl = $('spectatorCount');
    const el = $('spectatorList');
    if (!el) return;
    const items = (list || []).map((s) => (typeof s === 'string' ? { name: s } : (s || {})));
    if (countEl) countEl.textContent = items.length;
    el.innerHTML = items.length
      ? items.map((s) => {
        const attrs = s.id ? ` data-player-id="${escHtml(s.id)}"` : '';
        const lv = (s.level !== undefined && s.level !== null) ? ` <span style="color:var(--gold-light);font-size:11px;">Lv.${s.level}</span>` : '';
        return `<div style="padding:3px 0;">👤 <span${attrs} class="spectator-name">${escHtml(s.name || '观众')}</span>${lv}</div>`;
      }).join('')
      : '<div style="color:var(--text-dim);font-size:12px;">暂无观众</div>';
  }

  // ==================================================================
  // 聊天（§R2 kibitz 分区）
  // ==================================================================
  const chatBox = $('chatBox');
  const chatInput = $('chatInput');
  // §R2 kibitz 分区：保存全量消息，切 tab 时按当前筛选整体重渲染（否则切不回来）
  let chatLog = [];
  let chatTab = 'all'; // all | players | spectators

  /** 当前 tab 是否应显示该条 */
  function chatMatch(msg) {
    if (chatTab === 'all') return true;
    if (msg.sys) return true; // 系统消息在任何分区都可见
    if (chatTab === 'players') return msg.role === 'player-b' || msg.role === 'player-w';
    if (chatTab === 'spectators') return msg.role === 'spectator';
    return true;
  }

  function appendChatRow(msg) {
    if (!chatBox) return;
    const row = document.createElement('div');
    // §R2：玩家金色 / 观战者冷蓝 / 系统暗色斜体（配色见 style.css）
    const kind = msg.sys ? 'sys' : (msg.role === 'spectator' ? 'spectator' : 'player');
    row.className = `chat-msg ${kind}`;
    // 头像（2026-09-20）：系统消息没有发言者，不画占位圆
    if (!msg.sys) {
      const av = document.createElement('span');
      av.className = 'chat-avatar';
      if (window.UI && window.UI.setAvatarContent) window.UI.setAvatarContent(av, msg.avatar, msg.name);
      else av.textContent = window.UI.avatarGlyph(msg.avatar, msg.name);
      row.appendChild(av);
    }
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.name || '';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = msg.text;
    row.appendChild(who);
    row.appendChild(text);
    chatBox.appendChild(row);
  }

  function renderChat() {
    if (!chatBox) return;
    chatBox.innerHTML = '';
    for (const m of chatLog) if (chatMatch(m)) appendChatRow(m);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function appendChat(msg) {
    chatLog.push(msg);
    while (chatLog.length > 100) chatLog.shift();
    if (!chatMatch(msg)) return; // 当前分区不显示，但仍记入全量，切回来还在
    appendChatRow(msg);
    if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    api.send({ type: 'chat', data: { text } });
    chatInput.value = '';
  }

  /**
   * 快捷语（2026-09-20 用户要求）：高频寒暄点一下直接发，省去对局中打字。
   *
   * ⚠️ 只列**通用礼貌语**：这是"一键发出、没有二次确认"的通道，
   * 任何可能引战或被误读的措辞放进来都会直接变成事故（对局中打字本来就慢，误点更刺眼）。
   * 发送仍走同一条 `chat` 通道，**受服务端 2 秒节流约束**——连点第二下会被拒并提示。
   */
  const QUICK_PHRASES = [
    '你好，请多指教',
    '好棋！',
    '稍等我一下',
    '这手厉害',
    '谢谢指教',
    '再来一局？',
  ];

  /** 渲染快捷语胶囊（幂等：`init()` 可能被重复调用） */
  function renderQuick() {
    const box = $('chatQuick');
    if (!box || box.dataset.ready === '1') return;
    box.dataset.ready = '1';
    QUICK_PHRASES.forEach((text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-quick-btn';
      b.textContent = text;
      b.addEventListener('click', () => api.send({ type: 'chat', data: { text } }));
      box.appendChild(b);
    });
  }

  /** 注册 DOM 交互与 WS 事件（**幂等**：重复调用不会重复绑定/重复收消息） */
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;

    if ($('btnChatSend')) $('btnChatSend').addEventListener('click', sendChat);
    if (chatInput) chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    renderQuick(); // 快捷语胶囊

    // §R2 分区切换
    if ($('chatTabs')) {
      $('chatTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-tab');
        if (!btn) return;
        chatTab = btn.getAttribute('data-tab') || 'all';
        $('chatTabs').querySelectorAll('.chat-tab').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        renderChat();
      });
    }

    api.on('chat', (data) => {
      if (!data) return;
      // §R3：观众进出提示可关闭（人多时避免刷屏）；其余系统消息不受影响
      if (data.kind && data.kind.indexOf('spectate-') === 0
        && window.Settings && window.Settings.get('spectatorNotices') === false) return;
      const mark = data.role === 'spectator' ? '👁 ' : '';
      appendChat({
        name: mark + (data.name || ''),
        text: data.text,
        role: data.role || 'player',
        sys: !!data.sys,
        kind: data.kind || null,
        // ⚠️ 头像要一起存进 chatLog：切换分区会整段重绘（renderChat），
        // 不存就只有"刚收到的那条"有头像，一切 tab 就没了。
        avatar: data.avatar || null,
      });
    });

    // 观战者进入时系统提示（rebind=选手掉线重进回位，不算观战）
    api.on('spectating', (data) => {
      if (data && data.rebind) return;
      appendChat({ name: '系统', text: '你已进入观战，欢迎交流！', sys: true });
    });

    api.on('spectator_update', (d) => renderSpectators(d.spectators || []));
  }

  /**
   * 系统消息写入聊天区（PLAN §U3）。
   *
   * 背景：弹窗（toast）**2.5 秒就消失**，玩家低头看棋盘就错过了。
   * 需求要求重要提示**同时**进聊天区留痕。本函数只管"写进去"，
   * **什么时候该写由调用方决定**——有些提示（如"本页已断开"）进聊天毫无意义，
   * 那属于 play.js 的 `notify()` 的取舍，不在这里判断。
   */
  function system(text) {
    if (!text) return;
    appendChat({ name: '系统', text: String(text), sys: true });
  }

  window.PlayChat = { init, renderSpectators, system };
})();

/* ==== js/play-demo.js ==== */
/**
 * play-demo.js — 对局页「感想战」（PLAN §M5 前端拆分第 3 步）
 *
 * 从 `play.js` 抽出。感想战是终局后的推演玩法：同一棋盘组件切到 `demo-rules` 模式，
 * 双方（或观战者）轮流演示/推演，支持历史手回退与自由摆棋。
 *
 * 与 `play-chat.js` 不同，这块**与对局 core 是双向依赖**，所以拆法与 `play-clock.js` 一致
 * 用**回调注入**：
 *   注入进来（core → demo）：`getState` / `getFb` / `getSeat` / `getViewpoint` /
 *                            `ensureBoard` / `renderPlayerBars`
 *   暴露出去（demo → core）：`isActive` / `enter` / `exit` / `applyMode` / `updateUI` /
 *                            `sendMove` / `setPendingPromo` / `takePendingPromo`
 *
 * ⚠️ 迁移原则：**逻辑一字未改**，只把「读 core 的闭包变量」换成注入的回调调用
 * （`reviewActive`→`isActive()`、`state`→`getState()`、`mySeat/isPlayer`→`getSeat()`、
 *  `fb`→`getFb()`）。状态（推演谱 / 光标 / 自由摆棋 …）整体搬进本模块。
 *
 * 依赖：`window.API`、`window.UI`（`$` / `esc` / `toast`）、`window.FreeBoard`、`window.Sound`
 *       DOM：`#demoBar` `#demoStatus` `#btnDemo*` `#btnFreeMode` `#moveList` `#topPlayerBar` `#bottomPlayerBar`
 *
 * ⚠️ 加载顺序：必须在 `play.js` **之前**。
 */
(function () {
  'use strict';

  const api = window.API;
  const $ = (id) => window.UI.$(id);
  function escHtml(s) { return window.UI.esc(s); }
  function toast(msg) { return window.UI.toast(msg); }

  // ---- 注入的 core 依赖（init 时由 play.js 提供，先给安全默认值）----
  let getState = function () { return null; };
  let getFb = function () { return null; };
  let getSeat = function () { return { mySeat: null, isPlayer: false }; };
  let getViewpoint = function () { return 'b'; };
  let ensureBoard = function () {};
  let renderPlayerBars = function () {};
  let clearSelection = function () {};   // 进入感想战时清掉 core 的选中/目标高亮

  // ---- 本模块自己的状态（原 play.js 的闭包变量，整体搬入）----
  let reviewActive = false;       // 感想战模式中
  let demoInfo = null;            // 推演谱（服务端载荷）
  let demoCursor = 0;             // 联合谱浏览位置
  let originalPositions = null;   // 原谱各手局面缓存
  let pendingDemoPromo = null;    // 感想战升变选择
  let freeMode = false;           // 自由摆棋（本地草稿，不入谱不同步）
  let demoLegalCache = {};        // 历史手合法走法按需缓存（PLAN §H）

  function demoEdge() {
    return demoInfo ? demoInfo.baseIndex + demoInfo.moves.length : 0;
  }

  /**
   * 历史手合法走法的缓存键。
   * ⚠️ 审查 P3：写入（demo_legal 回调）与读取（requestDemoLegal）必须共用**同一个键形态**。
   * 此前写入用裸 `d.index`、读取用 `index:手数:基索引` → 永远不命中，浏览历史手会反复发 demo_legal。
   * 同一 index 在不同推演分支 / 手数下合法目标不同（服务端按 index 当时的谱面重算），
   * 所以要带手数与基索引，避免把旧分支的结果串到新分支。
   */
  function demoLegalKey(index) {
    return index + ':' + (demoInfo ? demoInfo.moves.length : 0) + ':' + (demoInfo ? demoInfo.baseIndex : 0);
  }

  function enterDemo(st) {
    // 终局分支会在 api.on('state') 里 enterDemo 后直接 return（不跑 render），
    // 所以玩家栏必须在这里补渲染一次，否则重进者永远看不到双方名字与 id
    renderPlayerBars(st);
    if (reviewActive && getFb()) { applyDemoMode(); updateDemoUI(); return; }
    reviewActive = true;
    freeMode = false;
    clearSelection(); // 原 core 里的 `selected = null; targets = [];`
    ensureBoard(getViewpoint());
    demoInfo = st.demo || { moves: [], kif: [], baseIndex: (getState().moves || []).length, baseCount: (getState().moves || []).length, legalTargetsBySq: {}, legalMoves: [], turn: 'b', demonstratorSeat: null, demonstratorName: null };
    demoCursor = demoEdge();
    $('demoBar').style.display = 'flex';
    applyDemoMode();
    updateDemoUI();
    if (window.Sound) window.Sound.playEnd();
  }

  function exitDemo() {
    reviewActive = false;
    freeMode = false;
    demoInfo = null;
    pendingDemoPromo = null;
    $('demoBar').style.display = 'none';
  }

  function ensureOriginalPositions() {
    if (originalPositions) return originalPositions;
    const arr = [window.FreeBoard.initialModel()];
    for (const usi of (getState().moves || [])) {
      const prev = arr[arr.length - 1];
      const model = { board: JSON.parse(JSON.stringify(prev.board)), hands: JSON.parse(JSON.stringify(prev.hands)) };
      const color = (arr.length - 1) % 2 === 0 ? 'b' : 'w';
      window.FreeBoard.applyUsiOnModel(model, usi, color);
      arr.push(model);
    }
    originalPositions = arr;
    return arr;
  }

  function applyDemoMode() {
    const fb = getFb();
    const state = getState();
    if (!fb) return;
    // 棋盘 = 联合谱 cursor 对应局面（原谱重放 + 推演叠加）
    const k = Math.min(demoCursor, demoEdge());
    const bi = demoInfo.baseIndex;
    const ops = ensureOriginalPositions();
    let model;
    if (k <= bi) model = ops[k];
    else {
      const basePos = ops[bi];
      model = { board: JSON.parse(JSON.stringify(basePos.board)), hands: JSON.parse(JSON.stringify(basePos.hands)) };
      for (let i = 0; i < k - bi; i++) {
        const color = (bi + i) % 2 === 0 ? 'b' : 'w';
        window.FreeBoard.applyUsiOnModel(model, demoInfo.moves[i], color);
      }
    }
    // §J4：光标停在「最新一手」时，改用**服务端下发的权威局面**覆盖本地重放结果。
    // 只在这一手覆盖的原因：服务端只维护推演终局这一个局面（历史手仍要本地重放——
    // 那是「任意手跳转」的必要代价），而最新一手恰恰是大家在看的、也最容易暴露
    // 持驹/盘面漂移的地方（J3「吃馬得角」就是这么潜伏到用户吃子才发现的）。
    // 深拷贝后再交给组件，避免自由摆棋等交互原地改动服务端载荷。
    if (k === demoEdge() && demoInfo.board && demoInfo.hands) {
      model = {
        board: JSON.parse(JSON.stringify(demoInfo.board)),
        hands: JSON.parse(JSON.stringify(demoInfo.hands)),
      };
    }
    let lastMove = null;
    if (k > 0) lastMove = k <= bi ? ((state.moves || [])[k - 1] || null) : (demoInfo.moves[k - bi - 1] || null);
    fb.setModel(model, lastMove);
    fb.setLegalTargets(demoInfo.legalTargetsBySq || {});
  }

  function renderDemoMoveList() {
    const state = getState();
    const el = $('moveList');
    if (!demoInfo) return;
    const bi = demoInfo.baseIndex;
    const base = demoInfo.baseCount;
    const kifAll = (state.movesKif || []);
    const html = [];
    for (let no = 1; no <= base; no++) {
      const mark = no % 2 === 1 ? '▲' : '△';
      const cur = demoCursor === no ? ' current' : '';
      const off = no > bi;
      const style = off ? ' style="color:var(--text-dim);text-decoration:line-through;opacity:.55;"' : '';
      const times = state.moveTimes || [];
      const spent = Number(times[no - 1]) || 0;
      let cum = 0; for (let k = 0; k <= no - 1; k++) cum += Number(times[k]) || 0;
      const timeTxt = (spent || cum) ? ' (' + Math.floor(spent / 60) + ':' + String(spent % 60).padStart(2, '0') + '/' + Math.floor(cum / 3600) + ':' + Math.floor((cum % 3600) / 60) + ':' + String(cum % 60).padStart(2, '0') + ')' : '';
      // ⚠️ 2026-10-02 审查 P3：div 不能把整段属性串 style="…" 拼进已有 style 里（会产出畸形
      // style="…" style="…"）；这里只拼「值」。span 那处本就是独立属性、可继续用 style 串。
      html.push('<div class="move-row' + cur + '" data-no="' + no + '" style="cursor:pointer;' + (off ? 'color:var(--text-dim);opacity:.55;' : '') + '"><span class="no">' + no + '</span><span' + (off ? style : '') + '>' + mark + ' ' + escHtml(kifAll[no - 1] || (state.moves || [])[no - 1] || '') + timeTxt + '</span></div>');
    }
    for (let i = 0; i < demoInfo.moves.length; i++) {
      const no = bi + i + 1;
      const mark = no % 2 === 1 ? '▲' : '△';
      const cur = demoCursor === no ? ' current' : '';
      const live = no === demoEdge() ? ' 🎤' : '';
      html.push('<div class="move-row' + cur + '" data-no="' + no + '" style="cursor:pointer;color:var(--gold-light);"><span class="no">' + no + '</span><span>' + mark + ' ' + escHtml(demoInfo.kif[i] || demoInfo.moves[i]) + live + '</span></div>');
    }
    el.innerHTML = html.join('');
    el.querySelectorAll('.move-row').forEach((row) => {
      row.addEventListener('click', () => {
        demoCursor = Math.min(parseInt(row.dataset.no, 10), demoEdge());
        applyDemoMode();
        updateDemoUI();
        const curEl = el.querySelector('.move-row.current');
        if (curEl) curEl.scrollIntoView({ block: 'nearest' });
      });
    });
    const curEl = el.querySelector('.move-row.current');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
  }

  function updateDemoUI() {
    const fb = getFb();
    const seatInfo = getSeat();
    const mySeat = seatInfo.mySeat;
    const isPlayer = seatInfo.isPlayer;
    const seat = demoInfo ? demoInfo.demonstratorSeat : null;
    const name = demoInfo ? demoInfo.demonstratorName : null;
    const amDemo = !!mySeat && seat === mySeat;
    let status;
    if (freeMode) status = '✋ 自由摆棋中（本地草稿，不入谱不同步）';
    else if (seat && amDemo) status = '🎤 正在由你演示（对方实时观看）';
    else if (seat) {
      // ⚠️ 这一句是**拼接**出来的，词典查不到整句 —— 必须在调用点用 `{name}` 模板来查，
      // 否则切到英/日后它永远停在中文（2026-09-23 补 i18n 时发现）。
      // 其余三句都是完整字面量，交给 i18n 的 DOM 观察器翻译，不必在这里手动查。
      const t = (s, v) => (window.I18N ? window.I18N.t(s, v) : s);
      status = t('🎤 正在由 {name} 演示', { name: name || t('对方') });
    }
    else status = '💤 演示暂停——点「我来演示」开始行棋';
    $('demoStatus').textContent = status;
    $('btnDemoClaim').style.display = (mySeat && !seat && !freeMode) ? 'inline-block' : 'none';
    [ $('btnDemoTransfer'), $('btnDemoUndo'), $('btnDemoClear') ]
      .forEach((b) => { b.style.display = (amDemo && !freeMode) ? 'inline-block' : 'none'; });
    // ⚠️ 2026-10-02 体验修复：只有**当前演示者**能开自由摆棋——此前按 mySeat 显示，
    // 非演示者点了会 toast「已开启」但棋盘不可交互（假成功）。
    $('btnFreeMode').style.display = amDemo ? 'inline-block' : 'none';
    $('btnFreeMode').textContent = freeMode ? '🧑‍🔧 退出自由摆棋' : '✋ 自由摆棋';
    $('btnDemoLatest').style.display = (demoCursor < demoEdge()) ? 'inline-block' : 'none';
    $('btnDemoRematch').style.display = isPlayer ? 'inline-block' : 'none';
    const turn = demoInfo ? (demoInfo.turn || 'b') : 'b';
    const turnHint = $('turnHint');
    if (turnHint) turnHint.textContent = turn === 'b' ? '当前轮到 先手▲' : '当前轮到 後手△';
    const topBar = $('topPlayerBar'), bottomBar = $('bottomPlayerBar');
    if (topBar) topBar.classList.toggle('active', turn === 'w');
    if (bottomBar) bottomBar.classList.toggle('active', turn === 'b');
    if (fb) {
      fb.setMode(freeMode ? 'free' : 'demo-rules');
      // 感想战不限制驹台：演示时两方持驹都要能选（手番合法性由服务端校验），
      // 清掉对战模式留下的手番限制
      fb.setTurn(null);
      // 合法走法表：最新一手用 demo_state 下发的；历史手按需向服务端请求（demo_legal）
      const atEdge = demoCursor === demoEdge();
      if (freeMode) fb.setLegalTargets({});
      else if (atEdge) fb.setLegalTargets(demoInfo.legalTargetsBySq || {});
      else requestDemoLegal(demoCursor);
      fb.setInteractive(amDemo && (freeMode || atEdge));
    }
  }

  function requestDemoLegal(index) {
    const key = demoLegalKey(index);
    if (demoLegalCache[key]) { getFb().setLegalTargets(demoLegalCache[key]); return; }
    api.send({ type: 'demo_legal', data: { index } });
  }

  /**
   * 在「推演谱中间位置」另走一手时，将被服务端丢掉的推演手数。
   *
   * 依据 `src/rooms/demo.js` `demoAction('move')`：当 `index !== baseIndex + moves.length` 时
   *   - index ≤ baseIndex      → `demo.moves = []`（清空全部推演手）
   *   - baseIndex < index < 边 → `demo.moves = demo.moves.slice(0, index - baseIndex)`
   * 即光标之后的推演手会被**静默丢弃**（无任何提示）。此函数把「将被丢弃的手数」算出来供二次确认。
   */
  function demoTruncatedCountOnBranch() {
    if (!demoInfo) return 0;
    if (demoCursor >= demoEdge()) return 0; // 在最新一手落子 = 正常续推，不截断
    return demoInfo.moves.length - Math.max(0, demoCursor - demoInfo.baseIndex);
  }

  /** 演示走子（带当前光标 index）——core 的棋盘 onMove 会调它 */
  function sendMove(usi) {
    // ⚠️ 2026-10-02 体验修复：在推演谱中间位置另走一手会**静默覆盖**此后的推演手
    // （服务端按 index 截断，见 demoTruncatedCountOnBranch 注释）。这里先弹确认，
    // 避免辛苦摆出的变化被无声抹掉；取消则原地不动、不发送。
    const cut = demoTruncatedCountOnBranch();
    if (cut > 0 && !window.confirm('在当前手另走一手会覆盖此后的 ' + cut + ' 手推演（服务端会丢弃它们），确定继续？')) return;
    api.send({ type: 'demo_move', data: { usi, index: demoCursor } });
  }

  function init(ctx) {
    const c = ctx || {};
    if (typeof c.getState === 'function') getState = c.getState;
    if (typeof c.getFb === 'function') getFb = c.getFb;
    if (typeof c.getSeat === 'function') getSeat = c.getSeat;
    if (typeof c.getViewpoint === 'function') getViewpoint = c.getViewpoint;
    if (typeof c.ensureBoard === 'function') ensureBoard = c.ensureBoard;
    if (typeof c.renderPlayerBars === 'function') renderPlayerBars = c.renderPlayerBars;
    if (typeof c.clearSelection === 'function') clearSelection = c.clearSelection;

    api.on('demo_legal', (d) => {
      demoLegalCache[demoLegalKey(d.index)] = d.legalTargetsBySq;
      const fb = getFb();
      if (fb && reviewActive && demoCursor === d.index) {
        fb.setLegalTargets(d.legalTargetsBySq);
        fb.render();
      }
    });

    $('btnDemoClaim').addEventListener('click', () => api.send({ type: 'demo_claim' }));
    $('btnDemoTransfer').addEventListener('click', () => api.send({ type: 'demo_transfer' }));
    $('btnDemoUndo').addEventListener('click', () => api.send({ type: 'demo_undo' }));
    $('btnDemoClear').addEventListener('click', () => { if (confirm('清空全部推演手，回到本谱终局局面？')) api.send({ type: 'demo_reset' }); });
    $('btnDemoLatest').addEventListener('click', () => { demoCursor = demoEdge(); applyDemoMode(); updateDemoUI(); });
    $('btnDemoRematch').addEventListener('click', () => { api.send({ type: 'rematch' }); toast('已请求再来一局，等待对方同意…'); });
    $('btnFreeMode').addEventListener('click', () => {
      if (!getFb()) return;
      freeMode = !freeMode;
      if (freeMode) {
        demoCursor = Math.min(demoCursor, demoEdge());
        applyDemoMode();
        toast('自由摆棋开启：任意移动/吃子/双击升变（本地草稿，不入谱不同步）');
      } else {
        demoCursor = demoEdge();
        applyDemoMode();
        toast('已退出自由摆棋，回到推演谱最新一手');
      }
      updateDemoUI();
    });

    api.on('demo_state', (d) => {
      if (!reviewActive) {
        const state = getState();
        if (state && state.status === 'FINISHED' && state.result) enterDemo(state);
        return;
      }
      // 光标自动跟随：之前在最新一手 → 跟进新一手；浏览历史则停留（可点「回到最新」）
      const prevEdge = demoEdge();
      demoInfo = d;
      if (demoCursor >= prevEdge || demoCursor > demoEdge()) demoCursor = demoEdge();
      applyDemoMode();
      renderDemoMoveList();
      updateDemoUI();
    });
  }

  window.PlayDemo = {
    init,
    isActive: function () { return reviewActive; },
    enter: enterDemo,
    exit: exitDemo,
    applyMode: applyDemoMode,
    updateUI: updateDemoUI,
    renderMoveList: renderDemoMoveList,
    sendMove,                                        // 棋盘 onMove（带光标 index）
    getCursor: function () { return demoCursor; },
    setPendingPromo: function (v) { pendingDemoPromo = v; },
    takePendingPromo: function () { const v = pendingDemoPromo; pendingDemoPromo = null; return v; },
  };
})();

/* ==== js/play-views.js ==== */
/**
 * play-views.js — 对局页**视图层**：把 state 画到 DOM 上（渲染 + 横幅 + 持驹 + 棋谱 + 举报弹层）
 *
 * §M5（2026-09-28）：从 `public/js/play.js`（原 748 行）整段搬出，逻辑一字未改，
 * 只做两处机械变换：① 整体左移 2 格缩进；② 读到 play.js 闭包里**可变变量**的地方
 * （state / mySeat / isPlayer / fb / spectatorViewpoint）改成读注入的 `ctx` 属性。
 *
 * ⚠️ 为什么 `ctx` 的属性必须是 **getter**：这些都是 `let`，会在对局过程中被重新赋值
 * （换座位、切视角、切自由摆棋）。若在 make() 时按值捕获，视图层就会永远看到初始值
 * （症状：切了视角棋盘不跟着翻）。
 *
 * 装配见 `play.js`：`const views = window.PlayViews.make({ ctx, ... });`
 * ⚠️ 本文件必须在 `play.js` **之前**加载（`play.js` 装配时会检查，缺失即抛错）。
 */
(function (global) {
  'use strict';

  function make(deps) {
    const ctx = deps.ctx;
    const $ = deps.$;
    const TIME_CONTROLS = deps.TIME_CONTROLS;
    const api = deps.api;
    const ensureBoard = deps.ensureBoard;
    const guest = deps.guest;
    const onSelectPiece = deps.onSelectPiece;
    const toast = deps.toast;

function currentViewpoint() {
  return ctx.isPlayer ? (ctx.mySeat === 'w' ? 'w' : 'b') : ctx.spectatorViewpoint;
}

/**
 * §R5 观战信息增强：玩家栏副标题 —— 等级 / ELO / 称号。
 * 只对确实存在的值做拼接，避免出现 "Lv.undefined" 这种占位。
 */
function playerMeta(p) {
  if (!p) return '';
  const parts = [];
  if (p.level != null) parts.push(`Lv.${p.level}`);
  if (p.rating != null) parts.push(`ELO ${p.rating}`);
  const meta = parts.join(' · ');
  return p.title ? `${meta} · ${p.title}` : meta;
}

/**
 * 玩家栏渲染（名字 / ELO / 悬停信息卡所需的 data-player-id）。
 *
 * ⚠️ 必须独立成函数：终局时 `api.on('state')` 走的是 `enterDemo(state); return;`
 * ——**跳过了 render()**。此前玩家栏只写在 render() 里，于是「重进到一个已结束的房间」
 * 的人（首个 state 就是 FINISHED）玩家栏从未被渲染：显示占位符，且双方
 * `data-player-id` 为空导致悬停信息卡失效。
 * 这正是「退出再进来后看不到双方 id」的根因，重进者才中招、一直在页面上的人不受影响。
 */
function renderPlayerBars(st) {
  const players = st.players || {};
  const viewpoint = currentViewpoint();
  // 视角布局：上方=对面，下方=自己
  const oppSeat = viewpoint === 'b' ? 'w' : 'b';
  const mySeatX = viewpoint === 'b' ? 'b' : 'w';

  // 上方（对面）玩家栏
  const opp = players[oppSeat];
  const oppDisconnected = opp && opp.connected === false && st.status === 'PLAYING';
  $('topName').textContent = (opp && opp.name) || (oppSeat === 'b' ? '先手' : '後手');
  $('topName').setAttribute('data-player-id', (opp && opp.id) || ''); // 悬停信息卡
  $('topRating').textContent = oppDisconnected
    ? '⚠️ 断线 · 60秒内未重连将判你获胜'
    : (opp ? playerMeta(opp) : '');
  $('topPlayerBar').classList.toggle('disconnected', !!oppDisconnected);
  $('topPlayerBar').classList.toggle('active', st.turn === oppSeat && !oppDisconnected);
  // 头像（2026-09-20）：来自 state.players[].avatar（服务端按 playerId 查会话）
  // ⚠️ 2026-10-07：支持图片头像（道具上传的 /uploads/...）
  const setAv = (id, avatar, name) => {
    const node = $(id);
    if (!node) return;
    if (window.UI && window.UI.setAvatarContent) window.UI.setAvatarContent(node, avatar, name);
    else node.textContent = window.UI.avatarGlyph(avatar, name);
  };
  setAv('topAvatar', opp && opp.avatar, (opp && opp.name) || '');

  // 下方（自己）玩家栏：名字优先显示自己账号名（localStorage），对手用服务端名
  const me = players[mySeatX];
  const myName = guest && guest.name ? guest.name : (me && me.name) || (mySeatX === 'b' ? '先手' : '後手');
  $('bottomName').textContent = myName;
  $('bottomName').setAttribute('data-player-id', (me && me.id) || '');
  $('bottomRating').textContent = me ? playerMeta(me) : '';
  $('bottomPlayerBar').classList.toggle('active', st.turn === mySeatX);
  // 自己的头像以服务端为准（换了头像 → 服务端推新 state），拿不到再退回本地记录
  setAv('bottomAvatar', (me && me.avatar) || (guest && guest.avatar), myName);
}

/**
 * 手机/平板端首次拿到局面后，把棋盘滚到视口内（PLAN §S2）。
 * 此前首屏停在顶部信息栏与侧栏，要往下滚才见到棋盘——对一个下棋应用来说主次颠倒。
 * 只用一次（后续走子不应打断用户正在看的内容），宽屏不执行。
 */
let boardScrolled = false;
function scrollBoardIntoViewOnce() {
  if (boardScrolled) return;
  boardScrolled = true;
  if (window.innerWidth > 900) return;
  const el = $('boardContainer');
  if (!el) return;
  setTimeout(() => {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
  }, 80);
}

function render(state) {
  const viewpoint = currentViewpoint();
  renderPlayerBars(state);

  // 房间信息 + 时间控制
  const tcName = TIME_CONTROLS[state.timeControl] ? TIME_CONTROLS[state.timeControl].name : '';
  $('roomCodeLabel').textContent = state.code ? `房间 ${state.code}` : '对局';
  if (tcName) $('roomCodeLabel').textContent += ` · ${tcName}`;
  // 駒落ち（让子）：**必须显眼**——让子局的先手是"上手"（少棋子的那一方，即房主），
  // 与平手局相反；不提示的话，玩家会以为"对手凭什么先走"或盘面少了棋子是程序出错。
  if (state.handicapLabel) {
    $('roomCodeLabel').textContent += ` · ${state.handicapLabel}（上手先手 · 不计 ELO）`;
  }

  // 观战标识
  const spectator = !ctx.isPlayer;
  $('spectatorTag').style.display = spectator ? 'inline' : 'none';
  $('btnResign').style.display = spectator ? 'none' : 'inline';
  // 入玉宣言（§P1 R-d）：**只在服务端判定「可宣言」时亮出按钮**。
  // 规则只实现一处（`game.canDeclareNyugyoku`），前端不自己算点数；
  // 条件不满足 → 按钮不存在 → 不存在「误点被判反则负」的风险。
  const declareBtn = $('btnDeclare');
  if (declareBtn) {
    const d = state.canDeclare;
    // ⚠️ 2026-10-02 体验修复：canDeclare 按「当前手番方」算，必须再校验「是不是我」——
    // 否则对手回合/对手满足条件时，我方屏幕也会亮出按钮，一点即报错（看得见用不了的假按钮）。
    const canDecl = !spectator && ctx.isPlayer && state.status === 'PLAYING'
      && ctx.mySeat === state.turn && !!(d && d.ok);
    declareBtn.style.display = canDecl ? 'inline' : 'none';
    if (canDecl) {
      declareBtn.title = `入玉宣言（当前 ${d.points} 点 · 敌阵内 ${d.count} 枚）→ 宣言方获胜`;
    }
  }
  // 举报（2026-09-20）：观战者没有"对手"，不给按钮；对局者任何时候都能举报
  //（对局结束后仍可能要举报——比如对面半路挂机/辱骂）
  const reportBtn = $('btnReport');
  if (reportBtn) {
    reportBtn.style.display = spectator ? 'none' : 'inline';
    if (spectator) $('reportPanel').style.display = 'none';
  }
  // §R1：视角切换按钮仅观战者可见，文字反映当前视角
  const vpBtn = $('btnViewpoint');
  if (vpBtn) {
    vpBtn.style.display = spectator ? 'inline' : 'none';
    vpBtn.textContent = viewpoint === 'b' ? '🔄 视角·先手' : '🔄 视角·後手';
  }

  // 棋钟初始 + 读秒（PLAN §M5：逻辑已抽到 play-clock.js）
  window.PlayClock.syncFromState(state);

  // 感想战中：棋盘由推演谱渲染（state 推送仅更新横幅/时钟等周边）
  // §M5：感想战逻辑已抽到 play-demo.js
  if (window.PlayDemo.isActive() && ctx.fb) {
    ctx.fb.setViewpoint(viewpoint); // §R1：观战者在感想战中也能切视角
    if (state.status === 'FINISHED') { window.PlayDemo.applyMode(); }
    window.PlayDemo.updateUI();
    // ⚠️ 2026-10-02 体验修复：终局必须显示胜负横幅——此分支此前直接 return，
    // 把下面的 showResult 吞掉了，导致「进入感想战」后看不到正式结果。
    if (state.result) {
      showResult(state);
      const isTournament = state.roomType === 'tournament';
      $('btnRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';
      $('bannerRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';
    }
    return;
  }

  // 棋盘渲染与交互统一交给 FreeBoard 组件（PLAN §G v6）
  ensureBoard(viewpoint);
  ctx.fb.setViewpoint(viewpoint); // §R1：切换观战视角（内部同视角则空转）
  ctx.fb.setModel({ board: state.board, hands: state.hands }, state.lastMove);
  // §J2：王手格此前作为第三个参数传给 setModel 被丢弃，改用专门的 setCheck
  ctx.fb.setCheck(state.check ? [findKingSq(state, state.turn)] : []);
  ctx.fb.setLegalTargets(state.legalTargetsBySq || {});
  ctx.fb.setTurn(state.turn); // 手番方持驹才可点选（打子符号与颜色无关，防误选对手驹台）
  const canMove = ctx.isPlayer && state.status === 'PLAYING' && ctx.mySeat === state.turn;
  ctx.fb.setInteractive(canMove);
  ctx.fb.render();
  renderMoveList(state);
  // 观众列表：进场时用 state 快照初始化（此前只有 spectator_update 才渲染，
  // 导致刚进入的观战者一直看到"暂无观众"，直到有人进出才更新）
  // §M5：渲染实现已抽到 play-chat.js
  if (state.spectators) window.PlayChat.renderSpectators(state.spectators);

  // 胜负横幅
  if (state.result) {
    showResult(state);
    const isTournament = state.roomType === 'tournament';
    $('btnRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';
    $('bannerRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';  // 观战者/赛事局不可点再来一局
  } else {
    $('banner').classList.remove('show');
    $('btnRematch').style.display = 'none';
  }
}

function findKingSq(st, color) {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = st.board[r][c];
      if (cell && cell.piece && cell.color === color && (cell.piece === '玉' || cell.piece === '王')) {
        return cell.sq;
      }
    }
  }
  return null;
}

function renderHands(st) {
  const vp = ctx.mySeat === 'w' ? 'w' : 'b';
  const oppSeat = vp === 'b' ? 'w' : 'b'; // 对手在左
  const mySeatH = vp;                       // 自己在右
  // 左侧 = 对手持驹（不可操作）；以自己视角渲染，对手棋子朝下
  window.renderHands($('oppHandPieces'), st.hands, oppSeat, null, vp);
  // 右侧 = 自己持驹（可操作打子）；以自己视角渲染，自己棋子正立
  window.renderHands($('myHandPieces'), st.hands, mySeatH, (piece) => onSelectPiece(piece, mySeatH), vp);
}

function renderMoveList(st) {
  const el = $('moveList');
  const moves = st.moves || [];
  const kif = st.movesKif || [];
  if (!moves.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">尚未走子</div>';
    return;
  }
  // 每手耗时（KIF 消費時間/累計時間样式）
  const times = st.moveTimes || [];
  let cum = 0;
  const fmt = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  el.innerHTML = moves.map((m, i) => {
    const player = i % 2 === 0 ? '▲' : '△';
    const label = kif[i] || m;
    const spent = Number(times[i]) || 0;
    cum += spent;
    const timeTxt = (spent || cum) ? ' <span style="color:var(--text-dim);font-size:11px;">(' + fmt(spent) + '/' + fmt(cum) + ')</span>' : '';
    // ⚠️ 2026-10-02 审查 P3：走子文本做防御性转义（同 play-demo.js 用 escHtml）——
    // 来源虽为服务端生成，仍应转义，避免将来引入用户可控内容时成为 XSS 面。
    const safeLabel = (typeof esc === 'function') ? esc(label) : String(label);
    return `<div class="move-row"><span class="no">${i + 1}</span><span>${player} ${safeLabel}${timeTxt}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}
function reportTarget() {
  if (!ctx.state || !ctx.state.players) return null;
  // ⚠️ 用 `currentViewpoint()` 而不是直接读 `viewpoint`——后者只是各渲染函数里的**局部**常量，
  // 在模块作用域读会直接 ReferenceError（本文件里 91/139/306 行都是各自声明的）。
  const oppSeat = currentViewpoint() === 'b' ? 'w' : 'b';
  const opp = ctx.state.players[oppSeat];
  return opp && opp.id ? opp : null;
}

function renderReportCategories(list) {
  const sel = $('reportCategory');
  if (!sel || !list || !list.length || sel.options.length) return; // 幂等：已填过就不再填
  sel.innerHTML = list.map((c) => `<option value="${window.UI.esc(c.id)}">${window.UI.esc(c.label)}</option>`).join('');
}

api.on('hello', (d) => { if (d) renderReportCategories(d.reportCategories); });

if ($('btnReport')) {
  $('btnReport').addEventListener('click', () => {
    const p = $('reportPanel');
    const show = p.style.display === 'none';
    p.style.display = show ? '' : 'none';
    // 按钮在顶部交互栏、表单在右侧「操作」卡里（2026-09-20 移动）——
    // 不滚过去的话，点完看着像"没反应"（尤其手机窄屏，表单在屏幕外）
    if (show) { try { p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {} }
  });
  $('btnReportCancel').addEventListener('click', () => { $('reportPanel').style.display = 'none'; });
  $('btnReportSubmit').addEventListener('click', () => {
    const t = reportTarget();
    if (!t) return toast('找不到可举报的对手');
    api.send({
      type: 'report',
      data: {
        targetId: t.id,
        targetName: t.name,
        category: $('reportCategory').value,
        detail: $('reportDetail').value,
        context: { roomId: (ctx.state && ctx.state.roomId) || null },
      },
    });
  });
  api.on('reported', () => {
    toast('举报已提交，管理员会尽快处理');
    $('reportPanel').style.display = 'none';
    $('reportDetail').value = '';
  });
}

// 「再来一局」：双方同意才重开。请求方此前无任何回执（服务端只通知对手），
// 玩家会以为没反应而连点——这里本地即时给「已请求，等待对方同意」并禁用按钮。
let rematchRequested = false;
function requestRematch(btn) {
  if (rematchRequested) return;
  rematchRequested = true;
  api.send({ type: 'rematch' });
  toast('已请求再来一局，等待对方同意…');
  if (btn) btn.disabled = true;
}
$('btnRematch').addEventListener('click', (e) => requestRematch(e.currentTarget));
$('bannerRematch').addEventListener('click', (e) => {
  requestRematch(e.currentTarget);
  $('banner').classList.remove('show');
});
api.on('game_start', () => { rematchRequested = false; }); // 对局重开 → 复位
$('btnLeave').addEventListener('click', () => {
  const inGame = ctx.isPlayer && ctx.state && ctx.state.status === 'PLAYING';
  // ⚠️ 2026-10-02 体验修复：对局中「退出对局」会被服务端判「接続切断」负，
  // 此前无任何确认、一点即判负并跳走（认输反有确认）——补一次确认。
  if (inGame && !window.confirm('退出将对局判负（相当于认输），确定退出吗？')) return;
  api.send({ type: 'leave' });
  // 赛事对局退出回赛事页，其余回大厅
  location.href = (ctx.state && ctx.state.roomType === 'tournament') ? 'tournaments.html' : 'lobby.html';
});
// §R1：观战视角切换（先手 ⇄ 后手）。仅观战者可用——对局者固定自己视角。
$('btnViewpoint').addEventListener('click', () => {
  if (ctx.isPlayer) return;
  ctx.spectatorViewpoint = ctx.spectatorViewpoint === 'b' ? 'w' : 'b';
  if (ctx.state) render(ctx.state);
  else if (ctx.fb) ctx.fb.setViewpoint(ctx.spectatorViewpoint);
});

function showResult(st) {
  const names = st.players || {};
  const bName = (names.b && names.b.name) || '先手';
  const wName = (names.w && names.w.name) || '後手';
  const winnerName = st.result === 'b' ? bName : st.result === 'w' ? wName : null;
  const loserName = st.result === 'b' ? wName : st.result === 'w' ? bName : null;
  // ⚠️ 2026-10-02 体验修复：统一中文 + 让「和棋」有明确注解，胜负方口径一致。
  let text;
  if (st.result === '-') {
    text = `和棋（${st.resultDetail || '和棋'}）`;
  } else if (!winnerName) {
    text = '对局结束';
  } else if (st.resultDetail === '投了') {
    text = `${loserName} 投了 · ${winnerName} 胜`;
  } else if (st.resultDetail === '接続切断') {
    text = `${loserName} 掉线 · ${winnerName} 胜`;
  } else if (st.resultDetail === '時間切れ') {
    text = `${winnerName} 胜（对手超时）`;
  } else if (st.resultDetail === '詰み') {
    text = `${winnerName} 胜（将死）`;
  } else if (st.resultDetail === '入玉宣言') {
    text = `${winnerName} 胜（入玉宣言）`;
  } else {
    text = `${winnerName} 胜`;
  }
  $('bannerText').textContent = text;
  $('banner').classList.add('show');
}

    return {
      boardScrolled,
      currentViewpoint,
      findKingSq,
      playerMeta,
      render,
      renderHands,
      renderMoveList,
      renderPlayerBars,
      renderReportCategories,
      reportTarget,
      scrollBoardIntoViewOnce,
      showResult,
    };
  }

  global.PlayViews = { make };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/play.js ==== */
/**
 * play.js — 对局页逻辑
 *
 *  - 状态同步（state 消息全量渲染）
 *  - 走子交互：点己方棋子/持驹 → 高亮合法目标 → 点目标格落子
 *  - 升变：存在成/不成两种走法时弹层选择
 *  - 棋钟：本地倒计时 + 服务端 clock 消息校准
 *  - 认输 / 再来一局 / 退出 / 观战模式
 */
(function () {
  const guest = window.NAV.renderNav('play');
  const api = window.API;
  api.connect(guest.id);
  // §M5：聊天与观众列表已抽到 play-chat.js——WS 事件与 DOM 交互由它自己注册。
  // 放在 connect 之后调用，保证与拆分前的注册时机一致。
  window.PlayChat.init();

  const board = new window.ShogiBoard(document.getElementById('boardContainer'), {});

  let state = null;       // 最新对局状态
  let mySeat = null;      // 'b' | 'w' | null（观战）
  let isPlayer = false;
  let selected = null;    // 当前选中的起点（格名或打子符号）
  let targets = [];       // 当前选中起点的合法目标
  let pendingPromote = null; // { usi, nonPromoteUsi, promoteUsi }
  // 棋钟状态与逻辑已抽到 play-clock.js（PLAN §M5）：本时剩余 / 读秒 / tick 都在那边
  // 统一棋盘组件（PLAN §G v6）：play 模式行棋 / 终局切感想战（demo-rules）/ 自由摆棋
  let fb = null;                  // FreeBoard 控制器（棋盘交互与拖拽）
  let spectatorViewpoint = 'b';   // 观战视角（PLAN §R1）：仅观战者生效，可切 'b' / 'w'
  // 感想战的状态（推演谱 / 光标 / 原谱缓存 / 自由摆棋 / 升变待选）已整体搬进
  // **play-demo.js**（PLAN §M5）——包括此前漏写声明、被 eslint 抓出的隐式全局
  // `window.freeMode`：现在它位于模块内部，跨脚本污染的隐患从根上消失。

  // 时间控制预设（与服务端 TIME_CONTROLS 对应）
  const TIME_CONTROLS = {
    '15+60': { name: '15分钟 + 60秒' },
    '10+30': { name: '10分钟 + 30秒' },
    '10:00': { name: '10分钟包干' },
    '10sec': { name: '10秒快棋' },
  };

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发，避免"抄多份、改一处漏九处"
  const $ = (id) => window.UI.$(id);
  function toast(msg) { return window.UI.toast(msg); }

  /**
   * 重要提示（PLAN §U3）：**弹窗 + 聊天区留痕**。
   *
   * 背景：弹窗 2.5 秒就消失，玩家低头看棋盘就错过了；聊天区能回看。
   * 所以**信息类**提示（对局开始 / 结束、对手请求再来一局、服务端报错）走这里；
   * **断线类**（"此身份已在其他窗口登录"）刻意仍用 `toast` ——
   * 页面都断了，往聊天区写一条没人会看的消息只会误导。
   */
  function notify(msg) {
    toast(msg);
    if (window.PlayChat) window.PlayChat.system(msg);
  }

  // ==================================================================
  // §M5（2026-09-28）：渲染/弹层视图层已拆到 play-views.js
  // ==================================================================
  // ⚠️ 该文件必须在本文件**之前**加载（见 public/play.html 的 <script> 顺序）。
  // 缺了就当场抛错——否则症状会是"界面不刷新"这种静默故障。
  if (!window.PlayViews) {
    throw new Error('play-views.js 必须在 play.js 之前加载（<script> 顺序错了）');
  }
  const views = window.PlayViews.make({
    $, toast, api, guest, TIME_CONTROLS, ensureBoard, onSelectPiece,
    // ⚠️ 必须是 **getter**：这些是会在对局中被重新赋值的 `let`，
    // 按值捕获会让视图层永远停在初始值（症状：切了视角棋盘不翻、换座位后按钮不变）。
    ctx: {
      get state() { return state; },
      get mySeat() { return mySeat; },
      get isPlayer() { return isPlayer; },
      get fb() { return fb; },
      get spectatorViewpoint() { return spectatorViewpoint; },
      // ⚠️ 写回也必须走 ctx：视图层里的 `ctx.spectatorViewpoint = ...`（切观战视角）
      // 若没有 setter，在 'use strict' 下会直接抛 TypeError —— 那是一个"点了没反应"的静默故障。
      set spectatorViewpoint(v) { spectatorViewpoint = v; },
    },
  });

  // 调试句柄：把视图层挂到 window，便于在浏览器控制台直接调用、排查渲染问题。
  // （⚠️ 审查 P3：原注释声称可让 `tests/play-views.test.js` 真跑一遍渲染，但仓库里
  //   并不存在该测试文件——已移除这句以免误导；现有前端测试仅 play-clock.test.js。）
  window.__playViews = views;


  // 棋钟已抽到 play-clock.js（PLAN §M5）：此处只做一次依赖注入。
  // 注入的是模块内读不到的两个"外部状态"——在 play.js 里它们是闭包变量：
  //   state → 最新对局状态（判断是否 PLAYING、谁的回合）
  //   视角  → 与棋盘**共用 `views.currentViewpoint()`**，保证两者永远同一口径
  //          （对局者固定自己视角；观战者跟随可切换的 spectatorViewpoint）
  window.PlayClock.init({
    getState: function () { return state; },
    getViewpoint: function () { return views.currentViewpoint(); },
    // §U2：每次棋钟刷新时同步「危险外框」。
    // ⚠️ 需求明确「观战者不显示」，而 PlayClock.isDanger() 只报告**时间事实**
    // （当前手番方是否读秒 ≤10 秒）——"必须是本人且轮到本人"这条判断必须在这里做：
    // 观战者 mySeat 为 null，天然被排除；若把判断挪进棋钟，观战者会跟着变红。
    onTick: function (st) {
      if (!fb) return;
      fb.setDanger(
        mySeat !== null && !!st && st.status === 'PLAYING'
        && st.turn === mySeat && window.PlayClock.isDanger()
      );
    },
  });

  // ==================================================================
  // 走子交互
  // ==================================================================
  function onSelectPiece(pieceName, color) {
    if (color !== mySeat) return;      // 只能操作自己持驹
    if (state.turn !== mySeat) return; // 未轮到自己
    const sym = window.DROP_SYMBOLS && Object.keys(window.DROP_SYMBOLS).find((k) => window.DROP_SYMBOLS[k] === pieceName);
    if (!sym) return;
    setSelection(sym);
  }

  function setSelection(from) {
    selected = from;
    const legalBySq = (state && state.legalTargetsBySq) || {};
    targets = legalBySq[from] || [];
    // 重绘高亮
    reapplySelection();
  }

  function reapplySelection() {
    const st = state;
    const checkSqs = st.check ? [views.findKingSq(st, st.turn)] : [];
    const viewpoint = mySeat === 'w' ? 'w' : 'b';
    board.render(st, {
      lastMove: st.lastMove,
      check: checkSqs,
    }, viewpoint);
    // 叠加选中与目标
    if (selected) board.highlightSq(selected, 'sel');
    targets.forEach((t) => {
      const cell = board._findCell(t.to);
      if (cell) {
        // 先清旧类再添加：避免残留 has-piece（方块）污染空格目标（应为绿点）
        cell.classList.remove('target', 'has-piece');
        cell.classList.add('target');
        // 有棋子的目标格 → 绿色方块；空位 → 绿点
        if (cell.innerHTML) cell.classList.add('has-piece');
      }
    });
  }

  // ⚠️ 审查 P3：原 `bindBoardClicks` / `handleTarget` 旧走子交互簇**经全仓 grep 确认无任何调用点**
  // （棋盘交互已统一由 FreeBoard 承担，见 play-demo.js / freeboard.js），属死代码，已删除。
  // 其中 `setSelection` / `reapplySelection` 仍被 `onSelectPiece`（持驹点选，被 play-views.js 引用）调用，保留。
  // `sendMove` 仍被升变/打子按钮复用，保留于此。
  function sendMove(usi) {
    api.send({ type: 'move', data: { usi } });
    selected = null;
    targets = [];
    // 立即移除本地高亮（否则走子后绿点/方块残留直到服务器推送）
    clearHighlights();
  }

  /** 清除棋盘上的选中/目标/方块高亮类 */
  function clearHighlights() {
    if (!board || !board.boardEl) return;
    board.boardEl.querySelectorAll('.cell.sel, .cell.target, .cell.has-piece').forEach((c) => {
      c.classList.remove('sel', 'target', 'has-piece');
    });
  }

  /** §6.3：升变弹层的显示/隐藏统一走这里——顺带把焦点管理交给 `A11y`。
   *  ⚠️ 2026-10-02 体验修复：注册 Esc/取消（此前 Esc 被刻意禁用、又没有取消按钮 →
   *  点到会升变的目标格就只能二选一、无法退出）。「成」已在 HTML 中置前并带 autofocus。 */
  function cancelPromote() {
    if (window.PlayDemo && window.PlayDemo.takePendingPromo) window.PlayDemo.takePendingPromo(); // 清掉感想战暂存
    pendingPromote = null;
    if (selected) { selected = null; targets = []; clearHighlights(); }
    hidePromoteOverlay();
  }
  function showPromoteOverlay() {
    const el = $('promoteOverlay');
    if (!el) return;
    el.classList.add('show');
    if (window.A11y) window.A11y.onDialogOpen(el, { onClose: cancelPromote });
  }
  function hidePromoteOverlay() {
    const el = $('promoteOverlay');
    if (!el) return;
    el.classList.remove('show');
    if (window.A11y) window.A11y.onDialogClose(el);
  }

  // 升变按钮（对局走子 / 感想战演示共用弹层）
  // 感想战分支必须走 demo_move 通道（带光标 index）；sendMove() 硬编码 type:'move' 不能复用
  $('btnPromote').addEventListener('click', () => {
    // §M5：感想战的升变选择存放在 play-demo.js，用 takePendingPromo() 取出并清空
    const demoPromo = window.PlayDemo.takePendingPromo();
    if (demoPromo) window.PlayDemo.sendMove(demoPromo.usiPromote);
    else if (pendingPromote) sendMove(pendingPromote.promoteUsi);
    hidePromoteOverlay();
    pendingPromote = null;
  });
  $('btnNoPromote').addEventListener('click', () => {
    const demoPromo = window.PlayDemo.takePendingPromo();
    if (demoPromo) window.PlayDemo.sendMove(demoPromo.usiMove);
    else if (pendingPromote) sendMove(pendingPromote.nonPromoteUsi);
    hidePromoteOverlay();
    pendingPromote = null;
  });
  if ($('btnPromoteCancel')) $('btnPromoteCancel').addEventListener('click', cancelPromote);

  // 认输 / 再来一局 / 退出
  // 结算横幅的「关闭」：原先写在 play.html 的 inline onclick 里，
  // 改为 data-act + 整页委托（2026-09-23，审查项 13f）。
  window.UI.onAction('banner-close', () => {
    const b = document.getElementById('banner');
    if (b) b.classList.remove('show');
  });

  $('btnResign').addEventListener('click', () => {
    if (confirm('确定认输吗？')) api.send({ type: 'resign' });
  });
  // 入玉宣言（§P1 R-d）：条件一律由服务端判定，成功即宣言方胜；失败会收到具体原因
  if ($('btnDeclare')) {
    $('btnDeclare').addEventListener('click', () => {
      api.send({ type: 'declare_nyugyoku' });
    });
  }
  // ==================================================================
  // 举报（2026-09-20 用户要求）
  //
  // ⚠️ 类别清单来自服务端（`hello.reportCategories`，源头是 `src/reports.js` 的 `CATEGORIES`），
  // 前端**不另抄一份**——抄了就会出现"前端能选、服务端不认"或反之。
  // ⚠️ 被举报人取**对面座位**的 id，而不是"当前视角那个人"写死成先手/后手；
  // 视角可翻转，取错就会举报到自己。
  // ⚠️ 服务端还会做去重与配额（同一目标 30 分钟内只收一条），这里只负责发起。
  // ==================================================================
  // ==================================================================
  // WS 事件
  // ==================================================================
  let lastMoveCount = 0;      // 上次已知手数（用于音效触发）
  let lastPieceCount = null;  // 上次棋盘棋子总数（吃子判定）；null = 尚未收到首帧
  function countPieces(st) {
    let n = 0;
    const b = st.board;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      if (b[r][c] && b[r][c].piece) n++;
    }
    return n;
  }
  // 首次交互解锁音频（浏览器自动播放策略）
  document.addEventListener('pointerdown', () => {
    if (window.Sound) window.Sound.ensureCtx();
  }, { once: true });

  // 音效开关
  const btnSound = $('btnSound');
  function refreshSoundBtn() {
    if (!btnSound) return;
    btnSound.textContent = (window.Sound && window.Sound.isEnabled()) ? '🔊 音效' : '🔇 静音';
  }
  if (btnSound) {
    btnSound.addEventListener('click', () => {
      if (!window.Sound) return;
      window.Sound.setEnabled(!window.Sound.isEnabled());
      refreshSoundBtn();
      if (window.Sound.isEnabled()) window.Sound.playMove();  // 反馈音
    });
    refreshSoundBtn();
  }

  api.on('state', (data) => {
    const prevMoves = lastMoveCount;
    lastMoveCount = (data.moves || []).length;
    // 走子音效：手数增加（自己或对手走子）。
    // ⚠️ 审查 P3：**首帧不发**。进入 / 重连时的第一条 state 可能一次性带着几十手历史，
    //   会被当成"刚走的一手"；且旧代码 lastPieceCount 初值 81 恒大于实际子数 → 必误播吃子音。
    //   这里以 lastPieceCount===null 标记"尚未收到首帧"：首帧只做基线初始化，之后才参与吃子判定。
    if (window.Sound && data.moves && data.moves.length > prevMoves && lastPieceCount !== null) {
      const pieces = countPieces(data);
      if (pieces < lastPieceCount) window.Sound.playCapture();  // 吃子
      else window.Sound.playMove();                             // 普通落子
    }
    lastPieceCount = countPieces(data);
    state = data;
    mySeat = data.seat || null;
    isPlayer = data.isPlayer === true;
    window.PlayClock.resetTick(); // 以"此刻"为倒计时基准（原 `lastTickTs = Date.now()`）
    views.scrollBoardIntoViewOnce(); // §S2：手机端首屏直接落到棋盘
    // §U4 对局 BGM：进行中开、终局停（刷新/中途进房也走这里）
    // ⚠️ 2026-10-08：把对手开局曲交给 Sound（设置里「播放对手 BGM」时交替循环）
    if (window.Sound) {
      if (window.Sound.setOpponentTrack) {
        const oppSeat = mySeat === 'b' ? 'w' : 'b';
        const opp = state.players && state.players[oppSeat];
        window.Sound.setOpponentTrack(opp && opp.bgm ? opp.bgm : null);
      }
      if (state.status === 'PLAYING') window.Sound.bgmStart();
      else if (state.status === 'FINISHED') window.Sound.bgmStop();
    }
    // 感想战路由（PLAN §G v6）：终局自动进入；新对局自动退出（§M5：实现在 play-demo.js）
    if (state.status === 'FINISHED' && state.result) {
      window.PlayDemo.enter(state);
      // ⚠️ 2026-10-02 体验修复：终局也必须渲染一次——胜负横幅在 render() 内，
      // 此前直接 return 导致「进入感想战」吞掉了正式结果呈现（只剩一闪而过的 toast）。
      views.render(state);
      return;
    }
    if (window.PlayDemo.isActive()) window.PlayDemo.exit();
    // 收到新状态时清空选中（如果对方走子则清）
    if (selected && mySeat !== state.turn) {
      selected = null;
      targets = [];
    }
    views.render(state);
  });

  // 棋钟校准（PLAN §M5：处理逻辑已抽到 play-clock.js）
  api.on('clock', (data) => window.PlayClock.syncFromServer(data));
  // 观众列表（PLAN §R）：渲染实现与 `spectator_update` 订阅均已抽到 play-chat.js（§M5），
  // 此处不再保留副本——避免"两份实现、改一处漏一处"。

  // ==================================================================
  // 感想战（PLAN §G v6 单页）：终局自动进入，同一棋盘组件切 demo-rules
  // ==================================================================
  // 整块（推演谱 / 光标浏览 / 演示权 / 自由摆棋 / 历史手合法走法）已抽到 **play-demo.js**（§M5）。
  // 下面的 `ensureBoard` 属于通用棋盘，**留在 core**——对战与感想战共用同一个 FreeBoard 实例；
  // 模块的依赖注入见本段末尾的 `PlayDemo.init(...)`。

  function ensureBoard(viewpoint) {
    if (fb) return;
    fb = new window.FreeBoard({
      board,
      viewpoint,
      interactive: false,
      mode: 'play',
      hands: {
        my: $('myHandPieces'), myColor: viewpoint,
        opp: $('oppHandPieces'), oppColor: viewpoint === 'b' ? 'w' : 'b',
      },
      onMove: (usi) => {
        // §M5：感想战走子（带光标 index）由 play-demo.js 负责
        if (window.PlayDemo.isActive()) window.PlayDemo.sendMove(usi);
        else api.send({ type: 'move', data: { usi } });
      },
      onPromoteChoice: ({ usiMove, usiPromote }) => {
        if (window.PlayDemo.isActive()) window.PlayDemo.setPendingPromo({ usiMove, usiPromote });
        else pendingPromote = { promoteUsi: usiPromote, nonPromoteUsi: usiMove };
        showPromoteOverlay();
      },
    });
    fb.attach();
    fb.bindHands($('myHandPieces'), viewpoint, $('oppHandPieces'), viewpoint === 'b' ? 'w' : 'b');
  }

  // `ensureOriginalPositions()`（原谱逐手局面缓存）与 `applyDemoMode()`（联合谱渲染 + §J4 权威覆盖）
  // 已搬到 **play-demo.js**（§M5）。其中 §J4 的「最新一手用服务端局面覆盖本地重放」逻辑原样保留。

  // `renderDemoMoveList()`（推演谱列表）与 `updateDemoUI()`（演示栏状态）已搬到 play-demo.js（§M5）。
  // core 里的 `escHtml` 也随之移除——原本只有这两处用它，两个模块各自持有一份转发。

  // 历史手合法走法（demo_legal）、demo 按钮交互、demo_state 订阅均已搬到 play-demo.js（§M5）。

  // ---- 依赖注入（与 play-clock.js 同一模式）----
  // 注入的是模块内读不到的 core 闭包状态与三个既有函数：
  //   getState / getFb / getSeat / getViewpoint   → 状态读取
  //   ensureBoard / renderPlayerBars / clearSelection → core 既有函数
  // 之后 core 只在「进入 / 退出 / 重绘」三个时机反向调用它（见 views.render() 与 api.on('state')）。
  window.PlayDemo.init({
    getState: function () { return state; },
    getFb: function () { return fb; },
    getSeat: function () { return { mySeat: mySeat, isPlayer: isPlayer }; },
    getViewpoint: function () { return views.currentViewpoint(); },
    ensureBoard: ensureBoard,
    renderPlayerBars: views.renderPlayerBars,
    clearSelection: function () { selected = null; targets = []; },
  });

  // ==================================================================
  // 对局事件
  // ==================================================================
  api.on('game_over', (data) => {
    notify('对局结束：' + (data.resultDetail || ''));
    if (window.Sound) { window.Sound.bgmStop(); } // §U4 终局停 BGM —— 终局音效统一由演示栏进入时播放（此前两处都播 → 双响）
    // 终局不跳页——state 推送（含 demo）会触发自动进入感想战模式
  });
  api.on('game_start', (data) => {
    notify('对局开始！');
    if (window.Sound) { window.Sound.playStart(); window.Sound.bgmStart(); } // §U4 开局起 BGM
  });
  // 对手请求再来一局：提示并高亮「再来一局」按钮
  api.on('rematch_requested', (data) => {
    const name = (data && data.requesterName) || '对手';
    notify(`${name} 请求再来一局，点击「再来一局」应战`);
    const btn = $('btnRematch');
    const bannerBtn = $('bannerRematch');
    btn.style.display = 'inline';
    btn.classList.add('pulse');
    if (bannerBtn) {
      bannerBtn.style.display = 'inline';
      bannerBtn.classList.add('pulse');
    }
    setTimeout(() => {
      btn.classList.remove('pulse');
      if (bannerBtn) bannerBtn.classList.remove('pulse');
    }, 4000);
  });
  api.on('error', (data) => {
    if (data && data.message) notify(data.message);
    // 私人房观战需要密码（PLAN §T2）：本页没有密码输入框 → 提示后回大厅的
    // 「👁 观战」入口补填密码（那里有房间码与密码框）。否则用户只会停在一片空白对局页。
    if (data && data.needPassword) {
      setTimeout(() => { location.href = 'lobby.html'; }, 1200);
    }
  });

  // 服务端明确回执「没有可进入的房间」（历史 bug 修复，2026-09-13）：
  // 从大厅点一张"自己是选手"的卡片时走的是 request_state（不带 spectate），
  // 若那局已结束 / 房间已销毁，服务端原先**静默不响应** → 页面一片白且没有任何提示。
  // 现在改为明确告知 + 送返大厅（与上面 needPassword 的处理风格一致）。
  api.on('no_room', () => {
    notify('该对局已结束或不存在，即将返回大厅');
    setTimeout(() => { location.href = 'lobby.html'; }, 1600);
  });
  // 同身份在别处登录：本页被顶替，提示并停止操作
  api.on('replaced', () => {
    toast('此身份已在其他窗口登录，本页已断开');
    board.setInteractive(false);
  });

  // ==================================================================
  // 聊天（§R2 分区 / §R3 观众进出提示）
  // ==================================================================
  // 整块已抽到 **play-chat.js**（PLAN §M5）：聊天记录、分区 tab、观众列表及其 WS 事件
  // 都在那边，由 `PlayChat.init()` 统一注册。此处不再保留副本。

  // 仅当显式带 spectate=1 参数时才进入观战（来自观战列表/随机观战入口）
  // 玩家（建房/加入/匹配/重连）跳转不带 spectate，走 request_state，由服务端按连接身份返回对应状态
  const params = new URLSearchParams(location.search);
  const isSpectate = !!params.get('spectate');
  const isTournamentJoin = !!params.get('join');
  const roomParam = params.get('room');
  function enterRoom() {
    if (isSpectate) {
      // 私人房间观战密码（PLAN §T2）：由大厅放进 sessionStorage，随本连接提交。
      // 取完即删——避免残留在会话里被下一次观战误用。
      let pw = '';
      try {
        pw = window.sessionStorage.getItem('tdshogi_spectate_pw') || '';
        if (pw) window.sessionStorage.removeItem('tdshogi_spectate_pw');
      } catch (_) { /* 隐私模式下 sessionStorage 可能不可用，忽略即可 */ }
      api.send({ type: 'spectate', data: { roomId: roomParam, password: pw } });
    } else if (isTournamentJoin) {
      // 赛事对局：玩家主动进入（建局时可能不在线）
      api.send({ type: 'join_tournament_match', data: { roomId: roomParam } });
    } else {
      // 请求当前状态（可能是重连，也可能是玩家跳转进来）；
      // 带 URL 里的 roomId：服务端回位优先绑定该房间（重新匹配后不被旧对局的
      // 复盘中座位按插入顺序劫持——幽灵房修复）
      api.send({ type: 'request_state', data: roomParam ? { roomId: roomParam } : {} });
    }
  }
  // WS 首次连接与断线重连统一在此进入房间；
  // 观战者重连后服务端不会主动重推 state，必须重新发起 spectate/request_state
  // 设置变更 → 重渲染棋盘（坐标 §S4 / 图集 §S5 / 上一步高亮，PLAN §S1）
  if (window.Settings) {
    window.Settings.subscribe((all, key) => {
      if (['showCoords', 'highlightLastMove'].indexOf(key) >= 0) {
        if (state) views.render(state);
        else if (fb) fb.render();
      }
    });
  }
  // ⚠️ 2026-10-08：棋子图集迁入装扮 —— 装备变化后按新图集重画
  document.addEventListener('tdshogi-appearance', () => {
    if (state) views.render(state);
    else if (fb) fb.render();
  });

  // ==================================================================
  // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 对局立绘渲染
  //
  // 独立处理器：**不改动既有的 state 渲染主逻辑**（play-views.js），只在本页额外
  // 挂一个 state 监听，把 `state.players[b|w].sprite` 画到棋盘两侧（见 DESIGN §9）。
  //   kind==='glyph' → 大号字形；kind==='image' → <img src=value>；空 → 容器留空（不占视觉）。
  // 视角无关：先手(b)恒在右、后手(w)恒在左（与各自持驹所在方位一致，不随观战视角翻转）。
  // 移动端（<900px，与 CSS 断点对齐）不展示，直接隐藏。
  // ==================================================================
  const escHtml = window.UI.esc;
  function renderSprites(st) {
    const boxes = { b: $('spriteB'), w: $('spriteW') };
    if (!boxes.b || !boxes.w) return; // HTML 里没插立绘容器就直接跳过
    const narrow = window.innerWidth < 900;
    for (const seat of ['b', 'w']) {
      const box = boxes[seat];
      const sp = st && st.players && st.players[seat] ? st.players[seat].sprite : null;
      if (narrow || !sp || !sp.value) { box.style.display = 'none'; box.innerHTML = ''; continue; }
      if (sp.kind === 'image') {
        box.innerHTML = `<img src="${escHtml(sp.value)}" alt="" style="max-height:220px;max-width:100%;object-fit:contain;">`;
      } else {
        // 字形（glyph）占位立绘：大号衬线字
        box.innerHTML = `<span style="font-size:72px;line-height:1;font-family:var(--font-serif);color:var(--gold-light);">${escHtml(sp.value)}</span>`;
      }
      box.style.display = 'flex';
    }
  }
  api.on('state', (data) => renderSprites(data));

  api.on('open', enterRoom);
})();
