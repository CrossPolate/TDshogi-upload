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
      // ⚠️ 2026-10-08（SPA 迁移）：文档不再随切页销毁，`<audio>` 常驻于外壳，
      // 同一首曲自然从当前时间点继续 —— 无需再把 currentTime 写 sessionStorage、
      // 换页重建后再 seek 回去（那套「停止→重开→快进」必有静音间隙 + metadata 竞态）。
      // 这里保留「同曲不重建」的幂等（见 bgmSync），它才是真正有效的防重建。
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

  // ⚠️ 2026-10-08（SPA 迁移）：跨页续播不再走 sessionStorage。
  // 单文档常驻后 `bgmEl` 自始至终是同一个 <audio>，切页自然连续；
  // 原 saveBgmPosition / restoreBgmPosition 已删除（那是「整页跳转销毁文档」的补丁）。

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
      // ⚠️ 2026-10-08（SPA 迁移）：不再需要 pagehide/beforeunload 存续播位置，
      // 也不再需要每 2 秒定时写 sessionStorage —— 文档常驻，<audio> 不销毁。
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
    setEnabled, applyEnabled, isEnabled, ensureCtx,
  };
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
      if (href) {
        e.preventDefault();
        // SPA：站内页面交给路由接管（文档不销毁、BGM 常驻）；下载 / 外链 / API 导出才整页跳。
        if (global.Router && global.Router.isInternalPage && global.Router.isInternalPage(href)) {
          global.Router.navigate(href);
        } else {
          global.location.href = href;
        }
      }
      // data-href 归本处理器独占（util.js 先于 router 注册），避免 a[href] / data-act 重复处理
      e.stopImmediatePropagation();
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
    // 身份换人了（登录 / 登出 / 换号）：SPA 下**不再整页 reload**（会销毁文档、打断 BGM）。
    // 身份变化的「关旧连接 → 用新身份重连 → 重挂当前 View」由 boot.js 的 storage 监听统一处理；
    // 这里只就地刷一下徽章占位。
    renderedIdentityId = next.id;
    refreshBadge();
  }
  try { global.addEventListener('storage', onStorageSync); } catch (_) { /* 极老浏览器没有 storage 事件：忽略 */ }

  function renderNav(current) {
    const guest = getGuest();
    // SPA 幂等：导航已渲染过就绝不整块重建（重建会闪烁、丢监听、换掉正在点的按钮）。
    // 只就地更新 active 态与徽章即可；这也让「迁移期某个还没转 View 的页面误调 renderNav」无害化。
    if (renderedIdentityId != null && document.querySelector('.nav-links')) {
      if (current != null) setActive(current);
      refreshBadge();
      return guest;
    }
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

  // ==================================================================
  // SPA 增量（2026-10-09）：导航只渲染一次，切页仅就地更新 active / 徽章。
  // 整块 innerHTML 重建会把用户正在点的按钮换掉、并让音乐按钮等状态闪烁。
  // ==================================================================

  /** 视图名 → 顶部导航项 id（没有对应项则为 null，表示不高亮任何项） */
  const VIEW_TO_NAV = {
    home: 'home', lobby: 'lobby', gallery: null,
    tournaments: 'tournaments', tournament: 'tournaments',
    profile: 'profile', review: null, play: null, admin: null,
  };

  /** 切页时就地更新导航 active 态（不重建元素） */
  function setActive(viewName) {
    const navId = VIEW_TO_NAV[viewName];
    document.querySelectorAll('.nav-links a[data-nav]').forEach((a) => {
      a.classList.toggle('active', navId != null && a.getAttribute('data-nav') === navId);
    });
  }

  /** 就地刷新用户徽章（名字 / 头像），不重建导航 */
  function refreshBadge() {
    const g = getGuest();
    renderedIdentityId = g.id;
    const badge = document.querySelector('.nav-user span');
    if (badge) badge.textContent = g.name || '载入中…';
    const av = document.querySelector('.nav-user .nav-avatar');
    if (av && global.UI) {
      if (global.UI.setAvatarContent) global.UI.setAvatarContent(av, g.avatar, g.name);
      else if (global.UI.avatarGlyph) av.textContent = global.UI.avatarGlyph(g.avatar, g.name);
    }
    // 管理员入口可见性随身份变化
    const entry = document.querySelector('.admin-entry');
    if (isAdminSession() && !entry) {
      // 已是管理员但没入口 → 需要重建导航才能加回（罕见，安全兜底）
      renderNav(null); setActive(global.Router && global.Router.current);
    } else if (!isAdminSession() && entry) {
      entry.remove();
    }
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

  global.NAV = { renderNav, setActive, refreshBadge, applyLocale, toggleLocale, getGuest, saveGuest, updateUserName, updateAvatar, randomName, genId, genKey, GUEST_KEY, THEME_KEY, ADMIN_KEY, isAdminSession, toggleTheme, getTheme, applyTheme };
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
      // 单例连接：已在连接中 / 已连上则不重复开（SPA 下 connect 由 boot 调一次，
      // 各页面只 `on`/`send`；这里做幂等保护，迁移期误调也无害）。
      if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) {
        this.guestId = guestId;
        return;
      }
      this.guestId = guestId;
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

    /**
     * SPA 身份变更：关旧连接 → 用新身份重连（不整页刷新，BGM 不断）。
     * 处理器（`on` 注册的）全部保留，重连后页面无需重新订阅。
     */
    reconnectAs(guestId) {
      clearTimeout(this.reconnectTimer);
      this.reconnectAttempts = 0;
      if (this.ws) {
        try {
          this.ws.onclose = null; // 手动重连，避免旧句柄再触发自动重连
          this.ws.onmessage = null;
          this.ws.onerror = null;
          this.ws.close();
        } catch (_) { /* ignore */ }
        this.ws = null;
      }
      this.connected = false;
      this.connect(guestId);
    }

    /** 显式断开（退出 / 测试用） */
    disconnect() {
      clearTimeout(this.reconnectTimer);
      if (this.ws) {
        try { this.ws.onclose = null; this.ws.close(); } catch (_) {}
        this.ws = null;
      }
      this.connected = false;
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

/* ==== js/router.js ==== */
/**
 * router.js — SPA 路由（History API）与 View 注册表
 *
 * 铁律（对应指导方案 §1）：
 *   1. 单文档常驻：切页只换 `#view` 的内容，文档不销毁 → BGM 常驻（bug 在此根修）。
 *   2. 页面是有生命周期的 View：`{ render(params), mount(container, params), unmount() }`。
 *      定时器 / 事件 / WS 订阅在 mount 建、unmount 清。
 *   3. 深链兼容：老 URL（`play.html?room=X`、`review.html?id=Y`、`history.html→profile#records`）
 *      一律映射到对应 View，保证收藏夹 / 外部链接不 404。
 *
 * 导航入口统一走 `Router.navigate(url)`；`util.js` 的 `data-href` 委托、nav 的 `<a>` 点击
 * 都被本模块的全局点击拦截接管，页内不必手写 `pushState`。
 */
(function (global) {
  'use strict';

  const views = (global.Views = global.Views || {});

  // ------------------------------------------------------------------
  // 路由表：path（`location.pathname`）→ View 名
  //   /history 是老「棋谱检索」页，已并入个人页棋谱标签
  // ------------------------------------------------------------------
  const ROUTES = {
    '/': 'home',
    '/index': 'home',
    '/index.html': 'home',
    '/lobby': 'lobby',
    '/lobby.html': 'lobby',
    '/gallery': 'gallery',
    '/gallery.html': 'gallery',
    '/tournaments': 'tournaments',
    '/tournaments.html': 'tournaments',
    '/tournament': 'tournament',
    '/tournament.html': 'tournament',
    '/profile': 'profile',
    '/profile.html': 'profile',
    '/history': 'profile',
    '/history.html': 'profile',
    '/review': 'review',
    '/review.html': 'review',
    '/play': 'play',
    '/play.html': 'play',
    '/admin': 'admin',
    '/admin.html': 'admin',
    '/app.html': 'home',
    '/app': 'home',
  };

  // 老 `.html` 文件名 → SPA 干净路径（导航与深链统一映射）
  const HTML_TO_PATH = {
    'index.html': '/', 'home.html': '/',
    'lobby.html': '/lobby',
    'gallery.html': '/gallery',
    'tournaments.html': '/tournaments',
    'tournament.html': '/tournament',
    'profile.html': '/profile',
    'history.html': '/profile',
    'review.html': '/review',
    'play.html': '/play',
    'admin.html': '/admin',
    'app.html': '/',
  };

  /** `/play.html?room=1` → `/play?room=1`；已是干净路径则原样返回 */
  function normalizePath(pathname) {
    const base = pathname.split('/').pop();
    if (base && HTML_TO_PATH[base]) {
      const mapped = HTML_TO_PATH[base];
      return mapped === '/' ? '/' : mapped;
    }
    return pathname;
  }

  /** 解析当前 / 目标 URL → { viewName, params, hash, path } */
  function resolve(url) {
    let u;
    try { u = new URL(url, location.origin); } catch (_) { u = new URL(location.href); }
    const rawPath = u.pathname;
    const path = normalizePath(rawPath);
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    const hash = u.hash ? u.hash.slice(1) : '';
    // history.html 的「records」意图 → 默认打开个人页棋谱标签
    if (rawPath.endsWith('history.html') || rawPath === '/history') {
      if (!params.tab) params.tab = 'records';
    }
    if (hash === 'records' && !params.tab) params.tab = 'records';
    const viewName = ROUTES[path] || ROUTES[rawPath] || 'home';
    return { viewName, params, hash, path };
  }

  // ------------------------------------------------------------------
  // 状态
  // ------------------------------------------------------------------
  let currentView = null;      // 当前挂载的 View 对象
  let currentName = null;
  let currentUrl = location.pathname + location.search + location.hash;
  let outlet = null;           // #view 容器
  let started = false;

  /**
   * 离开守卫：View 可选实现 `confirmLeave()`（返回 false 则**阻断**本次导航）。
   * 典型用途——对局进行中的 play 页，离开前弹确认框，用户取消就留在原地（指导方案 §3「play 强状态」）。
   */
  function allowLeave() {
    if (currentView && typeof currentView.confirmLeave === 'function') {
      try { return currentView.confirmLeave() !== false; } catch (_) { return true; }
    }
    return true;
  }

  function getOutlet() {
    if (!outlet) outlet = document.getElementById('view');
    return outlet;
  }

  /** 统一的 unmount：先跑 View 自己的清理，再清空容器 */
  function teardown() {
    if (currentView && typeof currentView.unmount === 'function') {
      try { currentView.unmount(); } catch (e) { console.error('[router] unmount 出错', currentName, e); }
    }
    currentView = null;
    const box = getOutlet();
    if (box) box.innerHTML = '';
  }

  /** 滚动位置记忆（返回上一页恢复到原位） */
  const scrollMemo = new Map();
  function saveScroll() {
    if (currentName) scrollMemo.set(currentName + location.search, window.scrollY || 0);
  }

  /** 渲染目标 View */
  function render(target, { restoreScroll = false } = {}) {
    const { viewName, params, hash, path } = target;
    const view = views[viewName];
    const box = getOutlet();
    if (!box) return;

    teardown();
    if (!view) {
      box.innerHTML = '<main class="container"><div class="card pad-card">页面加载失败：未注册视图 “'
        + String(viewName) + '”</div></main>';
      return;
    }

    // 1) 渲染 DOM
    let html = '';
    try {
      html = typeof view.render === 'function' ? (view.render(params) || '') : '';
    } catch (e) { console.error('[router] render 出错', viewName, e); }
    box.innerHTML = html;

    // 2) 挂载行为
    currentView = view;
    currentName = viewName;
    currentUrl = location.pathname + location.search + location.hash;
    if (typeof view.mount === 'function') {
      try { view.mount(box, params); } catch (e) { console.error('[router] mount 出错', viewName, e); }
    }

    // 3) 标题
    const title = typeof view.title === 'function' ? view.title(params) : view.title;
    if (title) document.title = title;

    // 4) 导航 active 态（不重建导航）
    if (global.NAV && global.NAV.setActive) {
      try { global.NAV.setActive(viewName); } catch (_) {}
    }

    // 5) 滚动
    if (restoreScroll) {
      const y = scrollMemo.get(viewName + location.search);
      window.scrollTo(0, y || 0);
    } else {
      window.scrollTo(0, 0);
    }

    // 6) 锚点定位（如 #records）
    if (hash) {
      requestAnimationFrame(() => {
        const el = document.getElementById(hash);
        if (el && el.scrollIntoView) el.scrollIntoView();
      });
    }
  }

  /**
   * 导航到目标 URL。
   * @param {string} url 目标（可为 `play.html?room=1` 或 `/play?room=1`）
   * @param {{replace?:boolean, force?:boolean}} [opts]
   */
  function navigate(url, opts) {
    opts = opts || {};
    let target;
    try { target = new URL(url, location.origin); } catch (_) { return; }
    const targetPath = target.pathname + target.search + target.hash;
    // 同址且未强制 → 不重挂（避免打断进行中的对局 / 重复请求）
    const same = targetPath === (location.pathname + location.search + location.hash);
    if (same && !opts.force) return;

    // 离开守卫：当前 View 不放行（如对局进行中被取消）→ 留在原地，不动地址栏
    if (!allowLeave()) return;

    saveScroll();
    const resolved = resolve(targetPath);
    // 地址栏统一为干净路径（老 .html → 干净），便于分享
    const clean = normalizePath(target.pathname) + target.search + target.hash;
    if (opts.replace) history.replaceState({ viewName: resolved.viewName }, '', clean);
    else history.pushState({ viewName: resolved.viewName }, '', clean);

    render(resolved, { restoreScroll: !!opts.restoreScroll });
  }

  /** 重挂当前 View（身份变更 / 数据刷新时用） */
  function reload() {
    render(resolve(location.pathname + location.search + location.hash), { restoreScroll: true });
  }

  // ------------------------------------------------------------------
  // 全局点击拦截：`<a href>` 与 `[data-href]` 的站内跳转都走 SPA
  // ------------------------------------------------------------------
  /**
   * 判断一个 href 是否「站内页面跳转」（应由 SPA 路由接管，而非整页加载）。
   * 外链 / mailto / 纯锚点 / API / WS / 真实静态资源（带扩展名的非 .html）都算「非页面」。
   */
  function isInternalPage(href) {
    if (!href) return false;
    if (/^(https?:)?\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('javascript:')) return false;
    if (href.startsWith('#')) return false;
    let url;
    try { url = new URL(href, location.origin); } catch (_) { return false; }
    const p = url.pathname;
    if (p.startsWith('/api') || p === '/ws') return false;
    const base = p.split('/').pop() || '';
    return p.endsWith('.html') || base === '' || !base.includes('.');
  }

  // 只拦截 `a[href]`；`[data-href]` 由 util.js 的事件委托独占处理（避免重复导航）。
  function findInternalAnchor(el) {
    const a = el.closest && el.closest('a[href]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    if (a.hasAttribute && a.hasAttribute('download')) return null;
    if (!isInternalPage(href)) return null;
    return { a, href };
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const found = findInternalAnchor(e.target);
    if (!found) return;
    e.preventDefault();
    navigate(found.href);
  }

  function onPopState() {
    // 离开守卫：浏览器已后退到新 URL，若当前 View 不放行（如对局进行中取消离开），
    // 就把地址栏推回当前视图，保持原地不动。
    if (!allowLeave()) {
      try { history.pushState({ viewName: currentName }, '', currentUrl); } catch (_) {}
      return;
    }
    render(resolve(location.pathname + location.search + location.hash), { restoreScroll: true });
  }

  /** 启动：渲染首屏 + 挂监听。由 boot.js 在所有 View 注册后调用。 */
  function start() {
    if (started) return;
    started = true;
    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('beforeunload', saveScroll);
    // 老 .html 深链：地址栏规范化为干净路径（replaceState，不新增历史）
    const resolved = resolve(location.pathname + location.search + location.hash);
    const clean = normalizePath(location.pathname) + location.search + location.hash;
    if (clean !== location.pathname + location.search + location.hash) {
      history.replaceState({ viewName: resolved.viewName }, '', clean);
    }
    render(resolved);
  }

  global.Router = {
    start, navigate, reload, resolve, normalizePath, isInternalPage,
    get current() { return currentName; },
    get currentView() { return currentView; },
    views,
  };
})(window);

/* ==== js/home.js ==== */
/**
 * home.js — 首页 View：随机观战、平台数据条、系统公告、ELO 排行榜、最新对局战报
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 index.html 的主体）
 *   mount(container, params)→ 绑定事件 / 订阅 WS / 起轮询，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（其余页面照此转换）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / api.on / document 监听，统一在 unmount 清理。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: 'TDShogi · 在线将棋对战平台',

    render() {
      // —— 原 index.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- Hero 区 -->
    <section class="hero">
      <h1 class="hero-title">天锻将棋 道场</h1>
      <p class="hero-sub">日本将棋 · 在线实时对战 · 免注册即刻对局</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="lobby.html">⚔️ 开始对局</a>
        <button class="btn btn-ghost btn-lg" id="btnRandomWatch">🎲 随机观战</button>
      </div>
    </section>

    <!-- 平台数据条 -->
    <section class="live-strip" id="statStrip" aria-label="平台实时数据">
      <div class="live-pill"><span class="dot"></span>在线<span class="num" id="statOnline">–</span></div>
      <div class="live-pill">⚔️ 对局中<span class="num" id="statPlaying">–</span></div>
      <div class="live-pill">🕐 等待对局<span class="num" id="statWaiting">–</span></div>
      <div class="live-pill">🎤 复盘中<span class="num" id="statReviewing">–</span></div>
      <div class="live-pill">📜 累计棋谱<span class="num" id="statRecords">–</span></div>
    </section>

    <!-- 主内容 + 侧栏 两栏 Dashboard -->
    <div class="dash-grid">
      <!-- 左：主内容 -->
      <div class="dash-main">
        <!-- 新手三步引导 -->
        <section class="section-block" aria-label="三步开始">
          <div class="section-title">三步开始你的将棋之旅</div>
          <div class="steps-grid">
            <a class="card step-card" href="lobby.html">
              <span class="step-no">STEP 1</span>
              <div class="step-emoji">⚔️</div>
              <div class="step-title">立即开局</div>
              <div class="step-desc">无需注册，打开就能玩。快速匹配在线对手，或生成房间码邀请好友来一局。</div>
            </a>
            <a class="card step-card" href="profile.html">
              <span class="step-no">STEP 2</span>
              <div class="step-emoji">🔐</div>
              <div class="step-title">登记账号</div>
              <div class="step-desc">注册正式账号，ELO 评级、胜绩与全部棋谱永久保存，游客数据可一键升级迁移。</div>
            </a>
            <a class="card step-card" href="profile.html#records">
              <span class="step-no">STEP 3</span>
              <div class="step-emoji">📈</div>
              <div class="step-title">复盘精进</div>
              <div class="step-desc">每局自动存为标准 KIF/CSA 棋谱，复盘器支持书签、评论与变着研究。</div>
            </a>
          </div>
        </section>

        <!-- 最新对局战报 -->
        <section class="card pad-card">
          <div class="section-title">
            <span>最新对局战报</span>
            <span class="spacer"></span>
            <a class="section-link" href="profile.html#records">查看我的棋谱 →</a>
          </div>
          <div id="recentBattles"></div>
        </section>
      </div>

      <!-- 右：侧栏 -->
      <aside class="dash-side">
        <!-- 系统公告 -->
        <section class="card pad-card">
          <div class="section-title">系统公告</div>
          <div id="announcements"></div>
        </section>

        <!-- ELO 排行榜 -->
        <section class="card pad-card">
          <div class="section-title">ELO 排行榜</div>
          <div id="leaderboard"></div>
        </section>
      </aside>
    </div>

    <!-- 将棋规则速查 -->
    <section class="card rule-card pad-card">
      <div class="section-title">将棋规则速查</div>
      <details>
        <summary>🎯 目标：将死对方的王（玉将）</summary>
        <div class="rule-body">轮流走子，攻击对方的王使其无路可逃即为「詰み」（将死）获胜。被将军时必须应将；本平台服务端自动判定王手与将死。</div>
      </details>
      <details>
        <summary>⬆️ 升变：进入敌阵可强化棋子</summary>
        <div class="rule-body">棋子进入、离开或在对方三段阵地内移动时可以选择升变（翻面）：飞车→龙王、角行→龙马、银将/桂马/香车/步兵均获得金将走法。玉与金不能升变。</div>
      </details>
      <details>
        <summary>🖐️ 打入：吃掉的棋子归你使用</summary>
        <div class="rule-body">吃掉的对方棋子放入自己的驹台，之后可在任意空格「打入」重新上战场——这是将棋最独特的规则（二步、打步詰等禁手已由服务端校验）。</div>
      </details>
      <details>
        <summary>⏱ 持钟：包干与本手持读秒</summary>
        <div class="rule-body">常规时制为每方「10+0」包干用时；快棋采用「0+10」形式——不设总时长，每手棋 10 秒读秒，超时即负。时间耗尽前留意读秒提示音。</div>
      </details>
    </section>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      const guest = global.NAV.getGuest();
      // 对局玩家 id：账号的 guest.id 是会话令牌，榜单/名单里存的是 accountId
      const myPlayerId = guest.id && String(guest.id).includes('.')
        ? String(guest.id).split('.')[0]
        : guest.id;

      const api = global.API;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 随机观战
      const btnWatch = $('btnRandomWatch');
      const onWatch = () => api.send({ type: 'random_spectate' });
      if (btnWatch) btnWatch.addEventListener('click', onWatch);

      // WS 订阅（api.on 返回退订函数 → 记进 teardown）
      this._teardown.push(api.on('spectating', (data) => {
        global.Router.navigate(`play.html?room=${data.roomId}&spectate=1`);
      }));
      this._teardown.push(api.on('error', (data) => {
        if (data && data.message) toast(data.message);
      }));
      if (btnWatch) this._teardown.push(() => btnWatch.removeEventListener('click', onWatch));

      // 加载首页数据（5s 轮询：数据条/公告/排行/战报）
      const loadHome = async () => {
        try {
          const data = await global.ApiUtils.get('/api/home');
          renderStats(data.stats, data.recordsTotal);
          renderAnnouncements(data.announcements);
          renderLeaderboard(data.leaderboard, myPlayerId);
          renderRecent(data.recentBattles || []);
        } catch (e) {
          console.error('load home failed', e);
        }
      };

      // ---- 平台数据条 ----
      function renderStats(stats, recordsTotal) {
        const s = stats || {};
        $('statOnline').textContent = s.online != null ? s.online : '–';
        $('statPlaying').textContent = s.playing != null ? s.playing : '–';
        $('statWaiting').textContent = (s.waiting || 0) + (s.matching || 0);
        $('statReviewing').textContent = s.reviewing != null ? s.reviewing : '–';
        $('statRecords').textContent = recordsTotal != null ? recordsTotal : '–';
      }

      // ---- 公告 ----
      function renderAnnouncements(list) {
        const el = $('announcements');
        if (!el) return;
        if (!list || !list.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无公告</div>';
          return;
        }
        el.innerHTML = list.slice(0, 5).map((a) => `
      <div class="announce-card">
        <div class="announce-title">${esc(a.title)}</div>
        <div class="announce-content">${esc(a.content)}</div>
        <div class="announce-date">${global.I18N.fmtDate(a.createdAt)}</div>
      </div>
    `).join('');
      }

      // ---- ELO 排行榜 ----
      function renderLeaderboard(lb, myId) {
        const el = $('leaderboard');
        if (!el) return;
        const list = (lb && lb.list) || [];
        if (!list.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无对局记录</div>';
          return;
        }
        el.innerHTML = list.map((r, i) => `
      <div class="rank-row ${r.id === myId ? 'self' : ''}">
        <span class="rank-no ${i < 3 ? `top${i + 1}` : ''}">${i + 1}</span>
        <span class="rank-name" data-player-id="${esc(r.id)}">${esc(r.id === myId ? '我 (' + (guest.name) + ')' : r.name || r.id)}</span>
        <span class="rank-rating">${r.rating}</span>
      </div>
    `).join('');
        if (lb && lb.self && !list.find((r) => r.id === myId)) {
          el.insertAdjacentHTML('beforeend', `
        <div class="rank-row self">
          <span class="rank-no">${lb.self.rank}</span>
          <span class="rank-name">我 (${esc(guest.name)})</span>
          <span class="rank-rating">${lb.self.rating}</span>
        </div>
      `);
        }
      }

      // ---- 最新对局战报 ----
      function renderRecent(list) {
        const el = $('recentBattles');
        if (!el) return;
        if (!list.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">还没有完成的对局 —— 第一局就等你来下！</div>';
          return;
        }
        el.innerHTML = list.map((r) => {
          const names = r.names && r.names.length === 2 ? r.names : ['先手', '後手'];
          let resText;
          if (r.result === 'b') resText = `${names[0]} 胜`;
          else if (r.result === 'w') resText = `${names[1]} 胜`;
          else resText = r.resultDetail || '和棋';
          return `
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
            <span>
              <span data-player-id="${esc((r.playerIds && r.playerIds.b) || '')}">${esc(names[0])}</span>
              vs
              <span data-player-id="${esc((r.playerIds && r.playerIds.w) || '')}">${esc(names[1])}</span>
            </span>
            ${r.rated ? '<span style="font-size:11px;color:var(--gold-light);">ELO 战</span>' : ''}
          </div>
          <div class="r-result result-win">${esc(resText)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${r.moveCount} 手 · ${global.I18N.fmt(r.createdAt)} · 点击复盘 →</div>
        </div>
      `;
        }).join('');
      }

      loadHome();
      const pollTimer = setInterval(loadHome, 5000); // 数据条/排行/公告/战报定时刷新
      this._teardown.push(() => clearInterval(pollTimer));
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.home = View;
})(window);

/* ==== js/lobby.js ==== */
/**
 * lobby.js — 对战大厅 View：快速匹配、创建/加入房间、观战列表
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 lobby.html 的主体，逐字保留）
 *   mount(container, params)→ 绑定事件 / 订阅 WS / 起轮询，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（照 home.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / setTimeout / api.on / MutationObserver / 元素监听，统一在 unmount 清理。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '对战 · TDShogi',

    render() {
      // —— 原 lobby.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <header class="page-head">
      <h1 class="page-title">对战大厅</h1>
      <p class="page-sub">快速匹配在线对手，或创建房间邀请好友 —— 免注册即刻开局</p>
    </header>

    <div class="lobby-grid">
      <!-- 快速匹配 -->
      <div class="card lobby-card">
        <h3>⚔️ 快速匹配</h3>
        <p>一键匹配在线对手，两人即开，实时对局。</p>
        <div style="font-size:12px;color:var(--text-dim);margin:10px 0 14px;">⏱ 10 分钟包干（标准比赛）</div>
        <div id="matchControls">
          <button class="btn btn-primary btn-lg" id="btnQuickMatch" style="width:100%;">开始匹配</button>
        </div>
        <div class="match-wait" id="matchWait">
          <div class="spinner"></div>
          <div>正在寻找对手…<br><span style="font-size:12px;color:var(--text-dim);">点击下方按钮取消</span></div>
          <button class="btn btn-ghost" id="btnCancelMatch" style="margin-top:12px;">取消匹配</button>
        </div>
      </div>

      <!-- 创建房间 -->
      <div class="card lobby-card">
        <h3>🏠 创建房间</h3>
        <p>生成 6 位房间码，邀请好友加入对局。</p>
        <div style="margin:14px 0;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">比赛时间</div>
          <select class="select" id="roomTimeControl" style="width:100%;">
            <option value="10:00">10 分钟包干（标准比赛）</option>
            <option value="15+60">15 分钟 + 60 秒读秒</option>
            <option value="10+30">10 分钟 + 30 秒读秒</option>
            <option value="10sec">10 秒快棋</option>
          </select>
        </div>
        <!-- 手合割（駒落ち让子）：选项由服务端 \`hello.handicaps\` 下发，前端不抄那张表 -->
        <div style="margin:0 0 14px;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">手合割（让子）</div>
          <select class="select" id="roomHandicap" style="width:100%;">
            <option value="even">平手（标准开局）</option>
          </select>
          <div id="handicapHint" style="font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.7;">平手：双方对等开局；选择让子则由上手（先手）少若干枚棋子。</div>
        </div>
        <!-- 私人房间（PLAN §T2）：休闲模式——不计 ELO，经验值照常加。
             ⚠️ 2026-10-02 文案修正：留空密码时房间仍可凭码加入/观战，原「不开放观战」承诺不成立。 -->
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:8px;">
          <input type="checkbox" id="roomPrivate" style="width:16px;height:16px;cursor:pointer;">
          <span>🔒 私人房间 <span style="color:var(--text-dim);font-size:12px;">（不计 ELO · 设了密码才需密码加入）</span></span>
        </label>
        <div id="roomPasswordWrap" style="display:none;margin:0 0 14px;">
          <input class="input" id="roomPassword" type="password" placeholder="房间密码（4-8 位，可留空表示不设密码）" maxlength="8" style="width:100%;">
        </div>

        <button class="btn btn-ghost btn-lg" id="btnCreateRoom" style="width:100%;">创建房间</button>
        <div id="roomCreated" style="display:none;margin-top:16px;text-align:center;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">房间码</div>
          <div id="roomCode" style="font-size:34px;font-weight:900;letter-spacing:6px;color:var(--gold-light);font-family:var(--font-serif);"></div>
          <button class="btn btn-sm btn-ghost" id="btnCopyCode" style="margin-top:10px;">复制房间码</button>
          <div style="font-size:12px;color:var(--text-dim);margin-top:10px;">等待对手加入后自动开局…</div>
        </div>
      </div>

      <!-- 加入房间 -->
      <div class="card lobby-card">
        <h3>🔑 加入房间</h3>
        <p>输入好友提供的 6 位房间码加入对局。</p>
        <input class="input" id="joinCode" placeholder="输入房间码，如 AB3X7Q" maxlength="6" style="width:100%;text-transform:uppercase;letter-spacing:4px;margin-bottom:12px;">
        <!-- 私人房间密码：仅在服务端回「需要密码」后出现（PLAN §T2），平时不占版面 -->
        <div id="joinPasswordWrap" style="display:none;margin-bottom:12px;">
          <input class="input" id="joinPassword" type="password" placeholder="该房间需要密码" maxlength="8" style="width:100%;">
        </div>
        <button class="btn btn-primary btn-lg" id="btnJoinRoom" style="width:100%;">加入房间</button>
        <!-- 凭房间码观战（PLAN §T2）：私人房观战需密码；赛事房/普通房直接进 -->
        <button class="btn btn-ghost" id="btnSpectateRoom" style="width:100%;margin-top:8px;">👁 观战（用房间码）</button>
      </div>
    </div>

    <!-- 进行中对局（观战） -->
    <section class="card pad-card">
      <div class="section-title">进行中的对局（观战）</div>
      <div id="activeGames"></div>
    </section>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav('lobby')（导航由外壳渲染）
      const api = global.API;                // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        this._teardown.push(() => el.removeEventListener(ev, fn));
      };

      // ---- 快速匹配 ----
      on($('btnQuickMatch'), 'click', () => {
        api.send({ type: 'quick_match' });
        $('matchControls').style.display = 'none';
        const wait = $('matchWait');
        wait.classList.add('show');
        // ⚠️ 2026-10-02 体验修复：显示已等待时长（此前只有 spinner，用户无法判断是否卡死）
        let tip = $('matchWaitTimer');
        if (!tip) {
          tip = document.createElement('div');
          tip.id = 'matchWaitTimer';
          tip.style.cssText = 'margin-top:8px;font-size:13px;color:var(--text-dim);';
          wait.appendChild(tip);
        }
        let sec = 0;
        tip.textContent = '已等待 0 秒…';
        const iv = setInterval(() => {
          sec += 1;
          tip.textContent = `已等待 ${sec} 秒…（超过 30 秒仍未匹配可点取消后重试）`;
        }, 1000);
        // 等待 UI 一旦被隐藏（匹配成功 / 失败 / 取消），自动停表
        const obs = new MutationObserver(() => {
          if (!wait.classList.contains('show')) { clearInterval(iv); obs.disconnect(); }
        });
        obs.observe(wait, { attributes: true, attributeFilter: ['class'] });
        // SPA：切页时也要停表/断观察（否则计时器泄漏到别的页面）
        this._teardown.push(() => {
          clearInterval(iv);
          try { obs.disconnect(); } catch (_) {}
        });
      });
      on($('btnCancelMatch'), 'click', () => {
        api.send({ type: 'cancel_match' });
        $('matchWait').classList.remove('show');
        $('matchControls').style.display = 'block';
      });

      // ---- 手合割（駒落ち让子）----
      // 选项来自服务端 `hello.handicaps`（本项目的既有分工：表只在服务端维护一份）。
      // ⚠️ 两头都取：立即读一次缓存（`hello` 可能早于本页注册监听器就到了），
      //    再注册监听器兜住"还没到"的情况——只做一头就会出现"下拉框偶尔是空的"。
      let handicaps = [];
      function fillHandicaps(list) {
        if (list && list.length) handicaps = list;
        const sel = $('roomHandicap');
        if (!sel || !handicaps.length) return;
        const keep = sel.value;
        sel.innerHTML = handicaps.map((h) => `<option value="${esc(h.id)}">${esc(h.label)}</option>`).join('');
        if (keep && handicaps.some((h) => h.id === keep)) sel.value = keep;
        syncHandicapHint();
      }
      function syncHandicapHint() {
        const sel = $('roomHandicap');
        const box = $('handicapHint');
        if (!sel || !box) return;
        const cur = handicaps.find((h) => h.id === sel.value);
        const isEven = !sel.value || sel.value === 'even';
        box.innerHTML = (cur && !isEven)
          ? `${esc(cur.hint || '')}<br>⚠️ 让子局：<b>房主执上手（少子的那一方）并先走</b>，不计 ELO。`
          : '不让子：双方各 20 枚，房主随机执先手，计入 ELO。';
      }
      fillHandicaps(api.handicaps);
      this._teardown.push(api.on('hello', (d) => fillHandicaps(d && d.handicaps)));
      on($('roomHandicap'), 'change', syncHandicapHint);

      // ---- 创建房间 ----
      // 私人房间（PLAN §T2）：休闲模式（不计 ELO，经验照常加）+ 可选密码；
      // 勾选后才显示密码框，密码留空 = 不设门禁（只是休闲局）
      let lastCreatedPrivate = false;
      on($('roomPrivate'), 'change', (e) => {
        $('roomPasswordWrap').style.display = e.target.checked ? 'block' : 'none';
      });
      on($('btnCreateRoom'), 'click', () => {
        const timeControl = $('roomTimeControl').value || '10:00';
        const isPrivate = $('roomPrivate').checked;
        const password = $('roomPassword').value.trim();
        if (isPrivate && password && (password.length < 4 || password.length > 8)) {
          return toast('房间密码需 4-8 位');
        }
        lastCreatedPrivate = isPrivate;
        api.send({
          type: 'create_room',
          data: {
            timeControl, isPrivate, password,
            // 手合割（駒落ち让子）：空 = 平手。服务端会拒绝未知 id
            handicap: $('roomHandicap').value || null,
          },
        });
      });

      // ---- 加入房间 ----
      on($('btnJoinRoom'), 'click', () => {
        const code = $('joinCode').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入 6 位有效房间码');
        const password = $('joinPassword').value.trim();
        api.send({ type: 'join_room', data: { code, password } });
      });

      // ---- 凭房间码观战（PLAN §T2）----
      // 私人房：房间码 + 密码 = 房主的邀请；赛事房/普通房：直接进
      on($('btnSpectateRoom'), 'click', () => {
        const code = $('joinCode').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入 6 位有效房间码');
        const password = $('joinPassword').value.trim();
        // 密码必须随「跳到 play 页的那个新连接」一起过去（授权不跨连接）。
        // 放 sessionStorage 而非 URL：避免密码留在浏览器历史与服务端访问日志里。
        if (password) window.sessionStorage.setItem('tdshogi_spectate_pw', password);
        else window.sessionStorage.removeItem('tdshogi_spectate_pw');
        api.send({ type: 'spectate', data: { code, password } });
      });
      // 回车直接加入（房间码 / 密码框内均可）
      ['joinCode', 'joinPassword'].forEach((id) => {
        on($(id), 'keydown', (e) => {
          if (e.key === 'Enter') $('btnJoinRoom').click();
        });
      });

      // ---- WS 事件（api.on 返回退订函数 → 直接记进 teardown）----
      this._teardown.push(api.on('room_created', (data) => {
        $('roomCode').textContent = data.code;
        $('roomCreated').style.display = 'block';
        toast(lastCreatedPrivate
          ? '私人房间已创建，把房间码与密码发给好友'
          : '房间已创建，等待对手加入');
      }));
      this._teardown.push(api.on('room_joined', (data) => {
        toast('加入成功，对局开始！');
        const t = setTimeout(() => global.Router.navigate(`play.html?room=${data.roomId}`), 400);
        this._teardown.push(() => clearTimeout(t));
      }));
      this._teardown.push(api.on('matched', (data) => {
        toast('匹配成功！对局开始');
        const t = setTimeout(() => global.Router.navigate(`play.html?room=${data.roomId}`), 400);
        this._teardown.push(() => clearTimeout(t));
      }));
      this._teardown.push(api.on('game_start', (data) => {
        if (location.search.includes('room')) return;
        global.Router.navigate(`play.html?room=${data.roomId}`);
      }));
      this._teardown.push(api.on('spectating', (data) => {
        // ⚠️ 2026-10-02 体验修复：观战跳转必须带 &spectate=1（与首页随机观战同口径）。
        // 否则 play 页会走 request_state → 非选手/未绑定 → 服务端回 no_room
        // → 被弹回大厅并谎报「该对局已结束或不存在」。
        global.Router.navigate(`play.html?room=${data.roomId}&spectate=1`);
      }));
      this._teardown.push(api.on('error', (data) => {
        if (!data || !data.message) return;
        toast(data.message);
        // ⚠️ 2026-10-02 体验修复：匹配失败一律复位等待 UI（此前靠 message 含「匹配」才复位，
        // 而「你正在对局中」/「同一身份不能自己和自己对弈」等文案不含「匹配」→ spinner 永远转）。
        $('matchWait').classList.remove('show');
        $('matchControls').style.display = 'block';
        // 私人房间需要密码（PLAN §T2）：服务端回的是**结构化标志** → 亮出密码框并聚焦。
        if (data.needPassword) {
          $('joinPasswordWrap').style.display = 'block';
          $('joinPassword').focus();
        }
        // 在局中被禁止观战：服务端回了 backRoomId → 引导回自己的对局（此前前端从不使用）
        if (data.backRoomId) {
          global.Router.navigate(`play.html?room=${encodeURIComponent(data.backRoomId)}`);
        }
      }));

      // ---- 观战列表 ----
      let lastGamesSig = '';
      async function loadGames() {
        try {
          const data = await global.ApiUtils.get('/api/lobby');
          renderGames(data.games);
        } catch (e) { console.error(e); }
      }
      function renderGames(games) {
        const el = $('activeGames');
        if (!el) return;
        if (!games || !games.length) {
          if (lastGamesSig === 'empty') return;
          lastGamesSig = 'empty';
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">当前没有进行中的对局</div>';
          return;
        }
        // ⚠️ 2026-10-02 体验修复：列表每 5s 全量重排，光标下的卡片会突然换位置导致误点；
        // 内容无变化时直接跳过重绘（用 roomId+走子数+观战数做指纹）。
        const sig = games.map((g) => `${g.roomId}:${g.moveCount}:${g.spectatorCount || 0}`).join('|');
        if (sig === lastGamesSig) return;
        lastGamesSig = sig;
        // §R4 热门优先：观众多的排前面（Array.sort 稳定，同人数保持服务端原序）。
        // 注意：渲染与点击绑定必须共用同一个数组（list），否则点击会张冠李戴。
        const list = [...games].sort((a, b) => (b.spectatorCount || 0) - (a.spectatorCount || 0));
        // 显示房间码 + 对局类型 + 走子数 + 观战人数，便于区分重名玩家；名字带悬停信息卡
        el.innerHTML = list.map((g) => {
          const typeName = g.type === 'reviewing' ? '🎤 复盘中' : g.type === 'quick' ? '快速匹配' : g.type === 'tournament' ? '赛事' : '房间对局';
          const pid = g.playerIds || {};
          const sc = g.spectatorCount || 0;
          const spec = sc > 0 ? ` · 👁 <b style="color:var(--gold-light);">${sc}</b> 人观战` : ' · 观战';
          // 让子局必须标出来：不标的话，点进去观战的人看到"棋盘少了几枚棋子"会以为是坏了
          const hd = g.handicapLabel ? ` · ♟ ${esc(g.handicapLabel)}` : '';
          // ⚠️ 2026-10-02 体验修复：卡片显示时制（服务端已下发 timeControl，此前前端丢弃 → 要进房才知道节奏）
          const tc = g.timeControl ? ` · ⏱ ${esc(g.timeControl)}` : '';
          return `
      <div class="game-card" data-room="${esc(g.roomId)}">
        <div class="players">
          <span data-player-id="${esc(pid.b || '')}">${esc(g.players.b || '先手')}</span>
          <span class="vs">vs</span>
          <span data-player-id="${esc(pid.w || '')}">${esc(g.players.w || '後手')}</span>
        </div>
        <div class="meta">房间 ${esc(g.code)} · ${typeName}${tc} · ${g.moveCount} 手${hd}${spec}</div>
      </div>
    `;
        }).join('');
        // 点击卡片进入对局：自己是该局选手 → 不带 spectate（走 request_state 由服务端按
        // playerId 回位到选手座位）；否则才以观战身份进入。playerId 在 hello 时由服务端下发。
        el.querySelectorAll('.game-card').forEach((card, i) => {
          const g = list[i];
          on(card, 'click', () => {
            const mine = api.playerId && g.playerIds && (g.playerIds.b === api.playerId || g.playerIds.w === api.playerId);
            global.Router.navigate(`play.html?room=${encodeURIComponent(g.roomId)}${mine ? '' : '&spectate=1'}`);
          });
        });
      }

      loadGames();
      const pollTimer = setInterval(loadGames, 5000);
      this._teardown.push(() => clearInterval(pollTimer));
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.lobby = View;
})(window);

/* ==== js/gallery.js ==== */
/**
 * gallery.js — 棋谱广场 View（PLAN §L5）
 *
 * 公开棋谱列表：关键词/标签筛选 + 分页，点击进入复盘页（review.html）。
 * 数据源 GET /api/gallery（服务端只返回 visibility=public 的棋谱）。
 *
 * SPA 迁移：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 gallery.html 的主体，逐字保留）
 *   mount(container, params)→ 原 IIFE 主体逻辑：筛选/分页/列表渲染，监听记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 遵循 home.js 范式：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改用 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（本页无 /api/… 导出下载链接）。
 *   - 所有事件监听统一在 unmount 清理。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '棋谱广场 · TDShogi',

    render() {
      // —— 原 gallery.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <div class="section-title" style="font-size:24px;">🏆 棋谱广场</div>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px;">
      管理员精选的公开棋谱（赛事名局、经典对局）。点击任一局进入复盘。
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center;">
      <input class="input" id="q" placeholder="搜索双方名 / 标题 / 赛事" style="max-width:280px;">
      <select class="input" id="tagSel" style="max-width:180px;">
        <option value="">全部标签</option>
      </select>
      <button class="btn btn-primary btn-sm" id="btnSearch">搜索</button>
      <span id="totalTip" style="color:var(--text-dim);font-size:12px;"></span>
    </div>

    <div id="list"></div>

    <div id="pager" style="display:flex;gap:10px;justify-content:center;align-items:center;margin-top:18px;"></div>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      const guest = global.NAV.getGuest(); // 替代原 NAV.renderNav('gallery')
      const api = global.API;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      const PAGE_SIZE = 20;
      let page = 1;
      let total = 0;

      const qEl = $('q');
      const tagEl = $('tagSel');

      async function load() {
        const q = (qEl.value || '').trim();
        const tag = tagEl.value || '';
        try {
          const data = await global.ApiUtils.get(
            `/api/gallery?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}&page=${page}&limit=${PAGE_SIZE}`
          );
          total = data.total || 0;
          renderList(data.records || []);
          renderPager();
        } catch (e) {
          toast('加载失败');
        }
      }

      function renderList(records) {
        $('totalTip').textContent = `共 ${total} 局`;
        const el = $('list');
        if (!el) return;
        if (!records.length) {
          // ⚠️ 2026-10-02 体验修复：空结果给引导（此前只有干巴巴一句「暂无公开棋谱」，
          // 分不清是「本来没有」还是「被筛选条件滤空了」）
          const hasFilter = !!(qEl.value || '').trim() || !!tagEl.value;
          el.innerHTML = hasFilter
            ? '<div style="color:var(--text-dim);font-size:13px;">没有符合条件的棋谱。可<a href="gallery.html" data-act="gallery-clear">清除筛选</a>后重试，或换更短的关键词。</div>'
            : '<div style="color:var(--text-dim);font-size:13px;">暂无公开棋谱。对局结束后在复盘页把棋谱设为「公开」，就会出现在这里。</div>';
          return;
        }
        el.innerHTML = records.map((r) => {
          const m = r.meta || {};
          // 名称：管理员可覆盖展示名
          const names = (m.nameOverrides && (m.nameOverrides.b || m.nameOverrides.w))
            ? [m.nameOverrides.b || r.names[0], m.nameOverrides.w || r.names[1]]
            : (r.names || ['先手', '後手']);
          const res = r.result === 'b' ? `${names[0]} 胜`
            : r.result === 'w' ? `${names[1]} 胜`
              : (r.resultDetail || '和棋');
          const title = m.title
            ? `<div style="font-size:15px;font-weight:800;margin-bottom:4px;">⭐ ${esc(m.title)}</div>`
            : '';
          const eventLine = [m.event, m.round, m.playedOn].filter(Boolean).join(' · ');
          const tags = (m.tags || []).length
            ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${m.tags.map((t) => `<span style="font-size:11px;color:var(--gold-light);background:rgba(201,162,39,0.12);border-radius:6px;padding:2px 8px;">${esc(t)}</span>`).join('')}</div>`
            : '';
          const desc = m.description
            ? `<div style="font-size:12px;color:var(--text-dim);margin-top:6px;line-height:1.6;">${esc(m.description)}</div>`
            : '';
          return `
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          ${title}
          <div style="font-size:14px;">${esc(names[0])} <span style="color:var(--text-dim);font-size:12px;">vs</span> ${esc(names[1])}</div>
          <div class="r-result ${r.result === 'b' || r.result === 'w' ? 'result-win' : 'result-draw'}">${esc(res)} <span style="color:var(--text-dim);font-size:12px;">（${r.moveCount} 手）</span></div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${eventLine ? esc(eventLine) + ' · ' : ''}${global.I18N.fmtDate(r.createdAt)}</div>
          ${desc}${tags}
        </div>
      `;
        }).join('');

        // 用首屏数据补齐标签下拉（无专门接口，够用）
        const seen = new Set();
        records.forEach((r) => ((r.meta && r.meta.tags) || []).forEach((t) => seen.add(t)));
        if (seen.size) {
          const cur = tagEl.value;
          seen.forEach((t) => {
            if (![...tagEl.options].some((o) => o.value === t)) {
              const op = document.createElement('option');
              op.value = t;
              op.textContent = t;
              tagEl.appendChild(op);
            }
          });
          tagEl.value = cur;
        }
      }

      function renderPager() {
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const el = $('pager');
        if (!el) return;
        if (pages <= 1) { el.innerHTML = ''; return; }
        el.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="prevPage" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span style="font-size:13px;color:var(--text-dim);">${page} / ${pages}</span>
      <button class="btn btn-ghost btn-sm" id="nextPage" ${page >= pages ? 'disabled' : ''}>下一页</button>
    `;
        $('prevPage').onclick = () => { page -= 1; load(); };
        $('nextPage').onclick = () => { page += 1; load(); };
      }

      // —— 事件绑定（句柄记进 _teardown，unmount 全部解绑）——
      const btnSearch = $('btnSearch');
      const onSearch = () => { page = 1; load(); };
      if (btnSearch) {
        btnSearch.addEventListener('click', onSearch);
        this._teardown.push(() => btnSearch.removeEventListener('click', onSearch));
      }

      const onQKeydown = (e) => { if (e.key === 'Enter') { page = 1; load(); } };
      if (qEl) {
        qEl.addEventListener('keydown', onQKeydown);
        this._teardown.push(() => qEl.removeEventListener('keydown', onQKeydown));
      }

      const onTagChange = () => { page = 1; load(); };
      if (tagEl) {
        tagEl.addEventListener('change', onTagChange);
        this._teardown.push(() => tagEl.removeEventListener('change', onTagChange));
      }

      // 空结果里的「清除筛选」链接：SPA 下 Router.navigate('gallery.html') 与当前同址
      // 不会重挂（筛选是输入框里的客户端状态，不进 URL），需就地清空筛选重查。
      const listEl = $('list');
      const onListClick = (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[data-act="gallery-clear"]');
        if (!a) return;
        e.preventDefault();
        if (qEl) qEl.value = '';
        if (tagEl) tagEl.value = '';
        page = 1;
        load();
      };
      if (listEl) {
        listEl.addEventListener('click', onListClick);
        this._teardown.push(() => listEl.removeEventListener('click', onListClick));
      }

      load();
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.gallery = View;
})(window);

/* ==== js/tournaments.js ==== */
/**
 * tournaments.js — 赛事列表页 View：我要创建赛事（需登录正式账号）、报名、对阵表渲染
 *
 * 页面只分两段展示：进行中的赛事（open/playing）与往期赛事（finished）。
 * 创建入口为顶部按钮：游客 → 引导登录；正式账号 → 弹窗填写后提交。
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回原 tournaments.html 的主体（<main> + 创建赛事弹窗）
 *   mount(container, params)→ 原 IIFE 主体逻辑全部搬进来，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式与 home.js 一致：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / api.on / 监听，统一在 unmount 清理。
 *   - `window.joinTournament` 收敛到 `Views.tournaments._handlers`（跨页防串）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '赛事 · TDShogi',

    // 跨页句柄命名空间（供 data-act 委托 / 遗留 inline onclick 调用）。
    // unmount 时清空 → 离开页面后旧句柄不再被误调用。
    _handlers: {},
    _mounted: false,

    render() {
      // —— 原 tournaments.html 的主体：<main class="container"> 与创建赛事弹窗，逐字保留
      //   （toast / script / 导航在外壳里，不搬） ——
      return `
  <main class="container">
    <!-- 顶部：标题 + 入口（创建需登录正式账号，后端审核流程见 docs/PLAN.md 与 docs/TOURNAMENT.md） -->
    <div class="card" style="padding:24px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;">
      <div>
        <div class="section-title" style="margin-bottom:6px;">棋手赛事</div>
        <div style="font-size:13px;color:var(--text-dim);">单败淘汰 / 瑞士制 · 报名满员自动开赛 · 赛事对局不计 ELO</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
        <!-- 「我的赛事」紧挨创建按钮（2026-09-13 用户要求）：我的赛事 = 我主办的 + 我参赛/报名的 -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-lg" id="btnMyTournaments">📋 我的赛事</button>
          <button class="btn btn-primary btn-lg" id="btnCreateTournament">🏆 我要创建赛事</button>
        </div>
        <!-- 等级特权提示（2026-09-20）：等级不足时禁用创建按钮并说明差多少 -->
        <div id="createLevelHint" style="font-size:12px;color:var(--gold-light);display:none;max-width:320px;text-align:right;line-height:1.6;"></div>
      </div>
    </div>

    <!-- 我的赛事视图（点顶部按钮切换；默认隐藏） -->
    <div id="mineSection" style="display:none;">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>我的赛事</span>
        <button class="btn btn-ghost btn-sm" id="btnBackFromMine">← 返回全部赛事</button>
      </div>
      <div id="mineList"></div>
      <!-- 分页条（2026-09-13）：赛事列表每页 20 条，避免赛事一多把页面撑爆 -->
      <div id="minePager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
    </div>

    <!-- 主视图 -->
    <div id="mainSection">
      <!-- 进行中的赛事（报名中 / 比赛中 / 审核中） -->
      <div class="section-title">进行中的赛事</div>
      <div id="ongoingList"></div>
      <div id="ongoingPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin:10px 0 32px;flex-wrap:wrap;"></div>

      <!-- 往期赛事：**只列一行摘要**，不展开对阵图与参赛名单
           （2026-09-13 用户要求；赛事一多，每张卡片都铺开对阵表会把页面拉得很长） -->
      <div class="section-title">往期赛事</div>
      <div id="finishedList"></div>
      <div id="finishedPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
    </div>
  </main>

  <!-- 创建赛事弹窗（T2：完整申请表，需求 9） -->
  <div class="modal-overlay" id="createModal" role="dialog" aria-modal="true" aria-label="创建赛事" style="display:none;">
    <div class="card" style="width:540px;max-width:94vw;max-height:88vh;overflow-y:auto;padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:19px;font-weight:800;">赛事创建申请</div>
        <button class="btn btn-ghost btn-sm" id="btnCloseCreateModal">关闭</button>
      </div>

      <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">赛事名称</div>
      <input class="input" id="tName" placeholder="如：暑期棋王赛" maxlength="20" style="width:100%;">

      <div style="display:flex;gap:12px;margin-top:14px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">参赛人数</div>
          <select class="select" id="tSize" style="width:100%;">
            <option value="4">4 人</option>
            <option value="8">8 人</option>
            <option value="16" selected>16 人</option>
            <option value="32">32 人</option>
          </select>
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">赛制</div>
          <select class="select" id="tFormat" style="width:100%;">
            <option value="single-elimination" selected>单败淘汰</option>
            <option value="swiss">瑞士制（积分编排）</option>
            <option value="round-robin" disabled>循环赛（待实装）</option>
          </select>
        </div>
        <!-- 轮数（仅瑞士制）：不填则按人数自动给建议值 -->
        <div style="flex:1;" id="tRoundsWrap">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">轮数（瑞士制）</div>
          <select class="select" id="tRounds" style="width:100%;">
            <option value="">按人数自动（推荐）</option>
            <option value="3">3 轮</option>
            <option value="4">4 轮</option>
            <option value="5">5 轮</option>
            <option value="6">6 轮</option>
            <option value="7">7 轮</option>
            <option value="8">8 轮</option>
            <option value="9">9 轮</option>
          </select>
        </div>
      </div>
      <div id="tSwissHint" style="font-size:12px;color:var(--text-dim);margin-top:8px;display:none;">
        瑞士制按积分逐轮配对（强者遇强者、不重复对阵），没有淘汰——输一两场仍有机会。
        人数为奇数时，每轮积分最低且未轮空过的一人轮空（视同胜）。
      </div>

      <div style="font-size:12px;color:var(--text-dim);margin:14px 0 6px;">举办理由（10–200 字，管理员据此审核）</div>
      <textarea class="input" id="tReason" rows="3" maxlength="200" placeholder="说明办赛目的、面向人群、赛程安排等" style="width:100%;resize:vertical;font-family:inherit;"></textarea>

      <div style="display:flex;gap:12px;margin-top:14px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">报名开始</div>
          <input class="input" type="datetime-local" id="tRegStart" style="width:100%;">
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">报名结束</div>
          <input class="input" type="datetime-local" id="tRegEnd" style="width:100%;">
        </div>
      </div>

      <div style="display:flex;gap:12px;margin-top:12px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">比赛开始</div>
          <input class="input" type="datetime-local" id="tMatchStart" style="width:100%;">
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">比赛结束</div>
          <input class="input" type="datetime-local" id="tMatchEnd" style="width:100%;">
        </div>
      </div>

      <label style="display:flex;align-items:center;gap:8px;margin-top:16px;font-size:13px;cursor:pointer;">
        <input type="checkbox" id="tRequireApproval" checked>
        <span>报名需我审核（关闭则报名即参赛）</span>
      </label>

      <div style="font-size:12px;color:var(--text-dim);margin-top:12px;line-height:1.7;">
        提交后进入<b>管理员审核</b>，通过后才开放报名。<br>
        <b>主办人不会自动参赛</b>——想下棋请另外报名。<br>
        时间未填写的项视为「不限」。
      </div>

      <button class="btn btn-primary" id="btnSubmitCreate" style="width:100%;margin-top:16px;">提交申请</button>
    </div>
  </div>`;
    },

    mount(container, params) {
      this._teardown = [];
      this._mounted = true;
      const guest = global.NAV.getGuest();
      const api = global.API;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      // 我的对局玩家 id：账号的 guest.id 是会话令牌（含点），参赛名单存的是 accountId
      const myPlayerId = guest.id && String(guest.id).includes('.')
        ? String(guest.id).split('.')[0]
        : guest.id;
      // 本窗口刚提交、还在审核中的赛事（公共列表不返回 pending，仅本地展示）
      let myPending = [];

      // ==================================================================
      // 视图切换：全部赛事 ⇄ 我的赛事（2026-09-13 用户要求）
      // 「我的赛事」按钮紧挨创建按钮；我的赛事 = 我主办的 + 我参赛/报名的
      // ==================================================================
      const mainSection = $('mainSection');
      const mineSection = $('mineSection');
      let showingMine = false;
      let latestList = []; // 最近一次拉取的列表——切换视图时直接复用，不必重新请求

      /** 是不是"我的"赛事：主办人，或我有报名/参赛 */
      function isMine(t) {
        if (!myPlayerId) return false;
        if (t.ownerId === myPlayerId) return true;
        if ((t.players || []).some((p) => p.id === myPlayerId)) return true;
        // ⚠️ T3 起必查 `entrants`：`players` 要到**开赛才冻结**，
        // 光看 players 会让"我刚报名、还没开赛"的赛事**不出现在「我的赛事」里**
        // （表现为"报完名找不到了"）。被踢的人不算我的。
        return (t.entrants || []).some((e) => e.id === myPlayerId && e.status !== 'kicked');
      }

      function showMine(on) {
        showingMine = !!on;
        mainSection.style.display = showingMine ? 'none' : '';
        mineSection.style.display = showingMine ? '' : 'none';
        renderAll();
      }
      const onMyTournaments = () => showMine(true);
      const onBackFromMine = () => showMine(false);
      $('btnMyTournaments').addEventListener('click', onMyTournaments);
      $('btnBackFromMine').addEventListener('click', onBackFromMine);
      this._teardown.push(() => $('btnMyTournaments').removeEventListener('click', onMyTournaments));
      this._teardown.push(() => $('btnBackFromMine').removeEventListener('click', onBackFromMine));

      // ---- 创建赛事 ----
      const modalEl = $('createModal');

      /** §6.3：弹窗开关统一走这两个函数——顺带做焦点管理（Esc 可关闭、关闭后焦点归还触发按钮） */
      const closeCreateModal = () => {
        modalEl.style.display = 'none';
        if (global.A11y) global.A11y.onDialogClose(modalEl);
      };
      const openCreateModal = () => {
        modalEl.style.display = 'flex';
        if (global.A11y) global.A11y.onDialogOpen(modalEl, { onClose: closeCreateModal });
      };

      const onCreateClick = () => {
        // 正式账号的 guest.id 是会话令牌（含点号）；游客是 24 hex 纯十六进制
        if (!guest.id || !String(guest.id).includes('.')) {
          toast('创建赛事需要登录正式账号，请先登录');
          // SPA：整页跳转改路由（超时句柄记进 teardown，切页即取消）
          const goLogin = setTimeout(() => { global.Router.navigate('profile.html'); }, 800);
          this._teardown.push(() => clearTimeout(goLogin));
          return;
        }
        openCreateModal();
      };
      $('btnCreateTournament').addEventListener('click', onCreateClick);
      this._teardown.push(() => $('btnCreateTournament').removeEventListener('click', onCreateClick));

      const onCloseModalClick = () => closeCreateModal();
      $('btnCloseCreateModal').addEventListener('click', onCloseModalClick);
      this._teardown.push(() => $('btnCloseCreateModal').removeEventListener('click', onCloseModalClick));

      const onModalOverlay = (e) => {
        if (e.target === modalEl) closeCreateModal();
      };
      modalEl.addEventListener('click', onModalOverlay);
      this._teardown.push(() => modalEl.removeEventListener('click', onModalOverlay));

      // ==================================================================
      // 等级特权（2026-09-20 用户要求：等级 5 才能举办赛事）
      //
      // ⚠️ 门槛数值**不在前端写死**：服务端随 hello 下发
      // `privileges.create_tournament = { need, ok }`（由 `LEVEL_PRIVILEGES` 表推导）。
      // 前端抄一份，改门槛时就会出现"服务端放行了但按钮还是灰的"。
      // ⚠️ 这一层只是"别让用户点一个必然失败的按钮"；**真正的拦截在服务端**
      // （`tournaments.createTournament` 里的 `ratings.hasPrivilege`）——绕过前端照样建不了赛。
      // ==================================================================
      const btnCreate = $('btnCreateTournament');
      const createHint = $('createLevelHint');
      const isAccount = !!guest.id && String(guest.id).includes('.');

      function applyCreatePrivilege(priv, level) {
        // 游客真正的阻碍是"没登录"——按等级提示反而误导，让点击时给登录引导
        if (!isAccount || !priv) {
          btnCreate.disabled = false;
          btnCreate.title = '';
          createHint.style.display = 'none';
          return;
        }
        if (priv.ok) {
          btnCreate.disabled = false;
          btnCreate.title = '';
          createHint.style.display = 'none';
          return;
        }
        btnCreate.disabled = true;
        btnCreate.title = `需要 Lv.${priv.need}`;
        createHint.style.display = '';
        createHint.textContent =
          `🏆 举办赛事需要 Lv.${priv.need}（你当前 Lv.${level == null ? 0 : level}）—— 多下几局攒经验即可解锁。`;
      }

      // WS 订阅（api.on 返回退订函数 → 记进 teardown）
      this._teardown.push(api.on('hello', (d) => {
        if (d && d.privileges) applyCreatePrivilege(d.privileges.create_tournament, d.level);
      }));
      // hello 可能已经先到了（外壳持有常驻 WS），补判一次
      if (api.privileges) applyCreatePrivilege(api.privileges.create_tournament, api.level);

      /** `datetime-local` 的值 → 时间戳；留空 → null（视为"不限"） */
      function tsOf(id) {
        const v = $(id).value;
        if (!v) return null;
        const t = new Date(v).getTime();
        return Number.isFinite(t) ? t : null;
      }

      // 赛制切换：轮数只对瑞士制有意义（淘汰赛的轮数是人数决定的）
      const formatSel = $('tFormat');
      const roundsWrap = $('tRoundsWrap');
      const swissHint = $('tSwissHint');
      function syncFormatFields() {
        const isSwiss = formatSel.value === 'swiss';
        roundsWrap.style.display = isSwiss ? '' : 'none';
        swissHint.style.display = isSwiss ? '' : 'none';
      }
      formatSel.addEventListener('change', syncFormatFields);
      this._teardown.push(() => formatSel.removeEventListener('change', syncFormatFields));
      syncFormatFields();

      const onSubmitCreate = () => {
        const name = $('tName').value.trim();
        const size = parseInt($('tSize').value, 10);
        const format = $('tFormat').value;
        const reason = $('tReason').value.trim();
        const registerStart = tsOf('tRegStart');
        const registerEnd = tsOf('tRegEnd');
        const matchStart = tsOf('tMatchStart');
        const matchEnd = tsOf('tMatchEnd');
        const requireApproval = $('tRequireApproval').checked;
        // 空字符串 = "按人数自动"，交给服务端给建议值（前端不重复实现那个公式）
        const roundsRaw = $('tRounds').value;
        const totalRounds = roundsRaw ? parseInt(roundsRaw, 10) : null;

        // 前端校验只防手滑——服务端会再验一遍（`createTournament` 里的 validateSchedule），
        // 因为前端校验拦不住"直接构造 WS 消息"的人。
        if (!name) return toast('请填写赛事名称');
        if (reason.length < 10) return toast('举办理由至少 10 个字（管理员据此审核）');
        if (registerStart && registerEnd && registerStart >= registerEnd) return toast('报名结束时间必须晚于报名开始时间');
        if (matchStart && matchEnd && matchStart >= matchEnd) return toast('比赛结束时间必须晚于比赛开始时间');
        if (registerEnd && matchStart && matchStart < registerEnd) return toast('比赛开始时间不能早于报名结束时间');

        api.send({
          type: 'create_tournament',
          data: {
            name, size, format, reason,
            registerStart, registerEnd, matchStart, matchEnd, requireApproval,
            // 只有瑞士制才带轮数；淘汰赛服务端会忽略它
            totalRounds: format === 'swiss' ? totalRounds : null,
          },
        });
      };
      $('btnSubmitCreate').addEventListener('click', onSubmitCreate);
      this._teardown.push(() => $('btnSubmitCreate').removeEventListener('click', onSubmitCreate));

      this._teardown.push(api.on('tournament_created', (data) => {
        toast(`赛事「${data.name}」创建申请已提交，等待管理员审核`);
        modalEl.style.display = 'none';
        if (data.status === 'pending_approval') myPending.push(data);
        loadTournaments();
      }));
      this._teardown.push(api.on('tournament_joined', (d) => {
        // T3：两段式报名——需审核时只是"申请已提交"，别给用户"已经参赛"的错觉
        if (d && d.pending) toast('报名已提交，等待主办人批准');
        else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
        else toast('报名成功');
        loadTournaments();
      }));
      this._teardown.push(api.on('error', (data) => {
        if (data && data.message) toast(data.message);
      }));

      // 赛事对局开始：在线参赛者自动进入对局页
      this._teardown.push(api.on('game_start', (data) => {
        if (data && data.roomId && !location.search.includes('room=')) {
          // SPA：整页跳转改路由
          global.Router.navigate(`play.html?room=${data.roomId}&join=1`);
        }
      }));

      async function loadTournaments() {
        try {
          const data = await global.ApiUtils.get('/api/tournaments');
          latestList = data.tournaments || [];
          renderAll();
        } catch (e) { console.error(e); }
      }

      /**
       * 状态文案（多处复用，收敛为一处，避免各写一套后互不一致）。
       * ⚠️ T1 起"报名中"的状态名是 `registration`（服务端出口已把旧的 `open` 映射过来）。
       */
      // ⚠️ 2026-10-02 体验修复（问题 9 文案统一）：状态文案与详情页 `tournament.js` 的
      // `STATUS_TEXT` **逐字一致**，避免同一状态在列表页叫「审核中」、在详情页叫「待管理员审核」。
      function statusText(t) {
        const map = {
          pending_approval: '🕐 待审核',
          registration: '📌 报名中',
          playing: '⚔️ 比赛中',
          finished: '🏆 已结束',
          archived: '📦 已存档',
          rejected: '❌ 已拒绝',
          cancelled: '⛔ 已取消',
        };
        return map[t.status] || '已结束';
      }

      /**
       * 状态行：状态 · 人数 [· 轮次]。
       *
       * ⚠️ 瑞士制必须带上轮次：光看"进行中"看不出打到哪了，
       * 而"第 3/5 轮"才是参赛者关心的信息。
       */
      function metaLine(t) {
        const parts = [statusText(t), `${joinedCount(t)}/${t.size} 人`];
        if (t.format === 'swiss' && t.totalRounds) {
          parts.push(`第 ${t.currentRound || 0}/${t.totalRounds} 轮`);
        }
        // ⚠️ 2026-10-02 体验修复（问题 4）：列表也要能看出「有和棋 / 有待裁决」，
        // 否则只能进详情页才发现结果异常。
        if (hasDraw(t)) parts.push('🤝 有和棋');
        if ((t.rematches || []).some((r) => r.status === 'pending')) parts.push('⚠️ 待裁决');
        return parts.join(' · ');
      }

      /**
       * 赛事里是否出现和棋（问题 4）。依据服务端已有字段：
       *  - 单败淘汰：`node.draw = true`（见 src/tournaments/bracket.js，和棋无法自动晋级 → 待裁决）；
       *  - 瑞士制：该轮 `results` 里值为 `'-'`（见 src/swiss.js，和棋各得 0.5 分）。
       */
      function hasDraw(t) {
        if ((t.bracket || []).some((n) => n.draw)) return true;
        return (t.rounds || []).some((r) => Object.values(r.results || {}).some((v) => v === '-'));
      }

      // 各列表的当前页（2026-09-13 分页：每页 20 条，避免赛事一多把页面撑爆）
      const pages = { ongoing: 1, finished: 1, mine: 1 };

      function renderAll() {
        const list = latestList;
        // 本窗口刚提交、还在审核中的赛事：并入"进行中"（服务端公共列表不返回 pending_approval）
        const pendingLocal = myPending.filter((p) => !list.some((t) => t.id === p.id));
        // T1：`archived`（已存档）与 `finished` 同属"往期"；其余（registration/playing 等）算进行中
        const ongoing = [...pendingLocal, ...list.filter((t) => t.status !== 'finished' && t.status !== 'archived')];
        const finished = list.filter((t) => t.status === 'finished' || t.status === 'archived');

        renderInto('ongoingList', 'ongoingPager', 'ongoing', ongoing, 'card');
        // 往期：**只列摘要行**，不展开对阵图与参赛名单（2026-09-13 用户要求）
        renderInto('finishedList', 'finishedPager', 'finished', finished, 'row');

        if (showingMine) renderMine([...pendingLocal, ...list]);
      }

      /**
       * 我的赛事：**把"我主办的"和"我参加的"分开列**。
       *
       * 分开的理由：这两类人的诉求完全不同——主办人盯的是报名进度与待办，
       * 参赛者只关心轮到谁了。混排在一起，两边都不好用。
       *
       * ⚠️ 分页是对**整个"我的赛事"**做的，所以某一页里可能只有「我参加的」——
       * 分组标题会跟着当前页的数据出现/消失，这是分页的固有代价，换取的是"不会爆炸"。
       */
      function renderMine(all) {
        const el = $('mineList');
        const mine = all.filter(isMine);
        if (!mine.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">你还没有参与任何赛事。报名一场，或点「🏆 我要创建赛事」自己办一个吧！</div>';
          UI.paginate({ items: [], container: 'minePager' });
          return;
        }
        const pg = UI.paginate({
          items: mine,
          page: pages.mine,
          size: 20,
          container: 'minePager',
          onPage: (n) => { pages.mine = n; renderAll(); },
        });
        pages.mine = pg.page;

        const hosted = pg.slice.filter((t) => t.ownerId === myPlayerId);
        const joined = pg.slice.filter((t) => t.ownerId !== myPlayerId);

        let html = '';
        if (hosted.length) {
          html += `<div style="font-size:13px;color:var(--text-dim);margin:6px 0 8px;">我主办的（${hosted.length}）</div>`;
          html += hosted.map(renderRow).join('');
        }
        if (joined.length) {
          html += `<div style="font-size:13px;color:var(--text-dim);margin:18px 0 8px;">我参加的（${joined.length}）</div>`;
          html += joined.map(renderRow).join('');
        }
        el.innerHTML = html;
      }

      /**
       * 一行摘要（往期赛事 / 我的赛事用）。
       *
       * **刻意不展开对阵图与参赛名单**：赛事一多，每张卡都铺开对阵表会把页面拉得极长，
       * 而这两种场景下用户多半只是扫一眼"办过哪些、结果如何"（2026-09-13 用户要求）。
       */
      function renderRow(t) {
        const champ = t.status === 'finished' && t.championId ? `🏆 ${esc(getName(t, t.championId))}` : '';
        const hostedTag = t.ownerId === myPlayerId ? '<span style="font-size:11px;color:var(--gold-light);">主办</span>' : '';
        return `
      <div class="card tournament-card" style="padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-weight:700;">${esc(t.name)}</span>
          ${hostedTag}
          <span style="font-size:12px;color:var(--text-dim);">${metaLine(t)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:12px;color:var(--gold-light);">${champ}</span>
          ${joinAreaOf(t)}
          <a class="btn btn-ghost btn-sm" href="tournament.html?id=${encodeURIComponent(t.id)}">查看详情 →</a>
        </div>
      </div>`;
      }

      /**
       * 渲染一个列表 + 它的分页条。
       *
       * @param {string} listElId  列表容器 id
       * @param {string} pagerElId 分页条容器 id
       * @param {string} key       `pages` 的键（记当前页）
       * @param {Array}  list      全量数据
       * @param {'card'|'row'} mode card = 完整卡片（含对阵图）；row = 一行摘要
       */
      function renderInto(listElId, pagerElId, key, list, mode) {
        const el = $(listElId);
        if (!list.length) {
          el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${
            mode === 'row' ? '还没有结束的赛事。' : '暂无进行中的赛事，点右上角「🏆 我要创建赛事」开一个吧！'
          }</div>`;
          UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
          return;
        }
        const pg = UI.paginate({
          items: list,
          page: pages[key],
          size: 20,
          container: pagerElId,
          onPage: (n) => { pages[key] = n; renderAll(); },
        });
        pages[key] = pg.page; // 页码被夹回时同步回来

        el.innerHTML = pg.slice.map(mode === 'row' ? renderRow : renderCard).join('');
      }

      /**
       * 赛事卡片（「进行中」列表用）：含参赛名单与对阵图。
       *
       * 与 `renderRow` 的分工是**信息密度**，不是赛事类型：
       * 进行中的赛事需要看阵容与进度，往期/我的赛事通常只是扫一眼"办过哪些、结果如何"。
       */
      /**
       * 当前"已确认参赛"的人数。
       *
       * ⚠️ **不能直接看 `players.length`**：T1 起 `players` 是**开赛时才冻结**的名单，
       * 报名阶段它是空的——直接用它会让"报名中 3/8 人"永远显示成 0/8。
       * 报名阶段要数的是 `entrants` 里已批准的数量。
       */
      function joinedCount(t) {
        const st = t.status;
        if (st === 'playing' || st === 'finished' || st === 'archived') return (t.players || []).length;
        return (t.entrants || []).filter((e) => e.status === 'approved').length;
      }

      /**
       * 报名入口 / 本人报名状态。
       *
       * ⚠️ 2026-10-02 体验修复（问题 1）：本人的报名状态**不再只在报名阶段显示** ——
       * 被拒 / 被踢 / 已通过的人，在赛事进入进行中 / 结束后同样要能一眼看到结果
       * （原实现 `t.status !== 'registration'` 直接 return ''，状态就这么「消失」了）。
       */
      function joinAreaOf(t) {
        const entrants = t.entrants || [];
        const mine = entrants.find((e) => e.id === myPlayerId);
        if (mine) {
          const hit = entrantChip(mine.status);
          if (hit) return `<span style="font-size:13px;color:${hit[1]};">${hit[0]}</span>`;
          if (t.status !== 'registration') return '';
        }
        if (t.status !== 'registration') return '';
        if (!mine) {
          return `<button class="btn btn-primary btn-sm" data-act="join-tn" data-id="${esc(t.id)}">报名</button>`;
        }
        return '';
      }

      // 报名状态文案（问题 9 统一）：与详情页 `tournament.js` 的 `ENTRANT_TEXT` 保持一致。
      function entrantChip(status) {
        const map = {
          pending: ['🕐 待主办人批准', 'var(--gold-light)'],
          approved: ['✅ 已通过报名', 'var(--gold-light)'],
          rejected: ['❌ 报名被拒绝', 'var(--red-light)'],
          kicked: ['🚫 已被移出', 'var(--red-light)'],
        };
        return map[status] || null;
      }

      // ⚠️ 主办人的管理操作（批准/拒绝/踢人/开始比赛）**只在赛事详情页**
      //（`tournament.html` → `js/tournament.js` 的管理面板）。
      // 这里曾经也有一份 `ownerPanelOf()`：列表页每张卡片都挂一套审批按钮，
      // 于是"办赛管理"散落在两个页面，改一处忘一处，用户也说不清该去哪儿操作。
      // 列表页现在只负责"看"——要管理就点「查看详情 →」进详情页（管理面板在那里）。

      function renderCard(t) {
        const entrants = t.entrants || [];
        const approvedList = entrants.filter((e) => e.status === 'approved');
        const shown = (t.status === 'playing' || t.status === 'finished' || t.status === 'archived')
          ? (t.players || [])
          : approvedList;
        const names = shown.map((p) => `<span data-player-id="${esc(p.id)}">${esc(p.name)}</span>`).join('、') || '暂无';
        const pendingN = entrants.filter((e) => e.status === 'pending').length;

        return `
      <div class="card tournament-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div style="font-weight:700;font-size:17px;">${esc(t.name)}</div>
          <div style="display:flex;gap:12px;align-items:center;">
            <span style="font-size:13px;color:var(--text-dim);">${metaLine(t)}</span>
            ${joinAreaOf(t)}
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">
          参赛者：${names}${pendingN ? ` <span style="color:var(--gold-light);">（另有 ${pendingN} 人待批准）</span>` : ''}
        </div>
        ${t.championId ? `<div style="margin-top:12px;color:var(--gold-light);font-weight:700;">🏆 冠军：${esc(getName(t, t.championId))}${t.championManual ? '（管理员裁定）' : ''}</div>` : ''}
        <div style="margin-top:10px;">
          <!-- 用户 2026-09-20：按钮只写「查看详情」即可（管理入口在详情页里，不必在这里提示） -->
          <a class="btn btn-ghost btn-sm" href="tournament.html?id=${encodeURIComponent(t.id)}">查看详情 →</a>
        </div>
      </div>
    `;
      }

      function getName(t, id) {
        const p = (t.players || []).find((x) => x.id === id);
        return p ? p.name : '未知';
      }

      // 对阵表渲染**已统一到 util.js 的 `UI.bracketHtml(t, opts)`**（2026-09-13）：
      // 列表页与详情页要画同一棵树，各写一份的结果必然是一边修了另一边没修。

      // ⚠️ 原 `window.joinTournament = (id) => {…}` 是跨页全局（inline onclick 用）：
      // 单文档下会互相覆盖 / 离开页面后旧句柄仍可被误调用。
      // 现收敛到 `Views.tournaments._handlers` 命名空间，unmount 清空即失效。
      this._handlers = {
        joinTournament: (id) => {
          if (!View._mounted) return; // 离开页面后旧句柄不再被误触发
          api.send({ type: 'join_tournament', data: { id } });
        },
      };

      // ==================================================================
      // 赛事管理（T3）**已整体移到详情页**
      //
      // 早先这里还有 `authedPost()` 与 `tournamentDecide/Kick/Start` 三个全局函数，
      // 供列表页卡片上的审批按钮用。现在列表页不再承担管理职责，这几个函数
      // **已随 `ownerPanelOf()` 一起删除**——留着就是"两份管理入口"，
      // 迟早出现"一边改了 token 头、另一边没改"。
      // 详情页的实现见 `public/js/tournament.js`（统一走 `ApiUtils.postAuthed`）。
      // ==================================================================

      loadTournaments();
      const pollTimer = setInterval(loadTournaments, 5000); // 轮询：检测新对局安排/对阵推进
      this._teardown.push(() => clearInterval(pollTimer));
    },

    unmount() {
      this._mounted = false;
      this._handlers = {}; // 旧句柄失效：委托 / 遗留 inline 入口都调不到
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  // 「报名」按钮：从 inline onclick 改为 data-act 委托（2026-09-23，审查项 13f）。
  // 赛事 id 虽是服务端生成的，但**拼进属性**这件事本身就不该做 ——
  // 改属性文本后，即使哪天 id 里出现引号也逃不出属性（见 util.js 的 onAction 注释）。
  // util.js 的委托注册是**整页一份的全局表**（没有 off），故在模块级注册一次、
  // 逻辑经 `_handlers` 命名空间转发——unmount 清空 `_handlers` 后即不可达。
  UI.onAction('join-tn', (el) => {
    const h = View._handlers && View._handlers.joinTournament;
    if (h) h(el.getAttribute('data-id'));
  });

  global.Views.tournaments = View;
})(window);

/* ==== js/tournament.js ==== */
/**
 * tournament.js — 赛事详情页 View（T5，2026-09-13）
 *
 * **所有用户（含未登录游客）**都能看：基本信息 / 申请信息 / 参赛名单 / 对阵表 / 变更记录。
 * 不同身份额外看到不同操作：
 *
 * | 身份 | 操作 |
 * |---|---|
 * | 游客 / 普通用户 | 报名（创建与报名需登录正式账号） |
 * | 参赛者 | 进入自己的对局 |
 * | 主办人 | 批准·拒绝报名 · 踢出报名者 · 开始比赛 · 取消选手成绩 · 取消赛事 |
 * | 管理员 | 以上全部 + **设置冠军**（⚠️ 设冠军**仅管理员**） |
 *
 * ⚠️ **权限判定只有服务端一处**（`tournaments.canManage`）。
 * 页面里的按钮显隐由服务端下发的 `caps` 决定——它**只是描述，不是票据**，
 * 客户端改 `caps` 也越不了权：每个写接口都会重新判定一遍。
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 tournament.html 的主体）
 *   mount(container, params)→ 原 IIFE 主体逻辑全部搬进来，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（与 home.js 一致）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（本页 game_start 跳对局）。
 *   - 所有 api.on 订阅 → 返回的退订函数记进 this._teardown，unmount 统一清理。
 *   - 本页从 URL 读赛事 id：优先 `params.id`（router 解析），回退 `location.search`。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '赛事详情 · TDShogi',

    render() {
      // —— 原 tournament.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- 加载中 / 错误（赛事不存在、id 缺失）都走这里 -->
    <div id="tnLoading" style="color:var(--text-dim);font-size:13px;padding:20px 0;">加载中…</div>

    <div id="tnBody" style="display:none;">
      <!-- 头部：名称 / 状态 / 主办 / 赛制 / 人数 / 冠军 -->
      <div class="card" id="tnHead" style="padding:24px;margin-bottom:20px;"></div>

      <!-- 我的操作区：报名 / 我的报名状态 / 进入我的对局 -->
      <div id="tnMyArea" style="margin-bottom:20px;"></div>

      <!-- 管理区：主办人（批准报名 / 踢人 / 开赛 / 取消成绩 / 取消赛事）+ 管理员（设冠军） -->
      <div id="tnManageArea" style="margin-bottom:20px;"></div>

      <!-- 申请信息：举办理由与四个时间 -->
      <div class="card" id="tnInfo" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 参赛名单（含待批准的报名者，主办人可直接在此处置） -->
      <div class="card" id="tnRoster" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 对阵表 -->
      <div class="card" id="tnBracketCard" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 赛事棋谱（T6/需求 12）：强制公开，所有用户可看 -->
      <div class="card" id="tnRecordsCard" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 重赛申请（T6/需求 12）：参赛者可申请，主办人/管理员裁决 -->
      <div class="card" id="tnRematchCard" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 变更记录：谁在什么时候做了什么（最近 50 条） -->
      <div class="card" id="tnLogs" style="padding:20px;"></div>
    </div>
  </main>
`;
    },

    mount(container, params) {
      this._teardown = [];
      this._handlers = {};
      this._mounted = true;
      // SPA 迁移：原 `NAV.renderNav('tournaments')` 删除——导航由外壳渲染一次，这里只取身份；
      // 原 `api.connect(guest.id)` 删除——外壳持有唯一 WS 连接，页面只 api.on / api.send。
      const guest = global.NAV.getGuest();
      const api = global.API;

      // SPA：切页竞态防护——unmount 后不再往已销毁的 DOM 写
      let alive = true;
      this._teardown.push(() => { alive = false; });
      // 页面内输入弹层登记表：切页（unmount）时强制关闭，避免残留在 body 上
      const openDialogs = new Set();
      this._teardown.push(() => { [...openDialogs].forEach((fn) => { try { fn(); } catch (_) {} }); });

      // 参赛名单里存的是 accountId；`guest.id` 是会话令牌（含点）时取点前部分
      const myPlayerId = guest.id && String(guest.id).includes('.')
        ? String(guest.id).split('.')[0]
        : guest.id;

      // SPA：赛事 id 优先用 router 解析的 params.id，回退读 location.search（router 用 pushState 保持同步）
      const tid = (params && params.id) || new URLSearchParams(location.search).get('id');

      let T = null;        // 赛事（publicInfo 形态）
      let caps = {};       // 服务端下发的"我能做什么"
      let isAdmin = false; // 是否带管理员令牌（仅用于文案提示）

      function esc(s) { return UI.esc(s); }
      function toast(m) { return UI.toast(m); }
      function el(id) { return UI.$(id); } // 铁律 5：DOM 查询走 window.UI 的 $（即 document.getElementById）

      /** 操作日志的中文名。未知 action 原样显示——不隐藏信息，方便排障 */
      const LOG_ACTION = {
        create: '提交创建申请', approve: '审核通过', reject: '审核拒绝',
        cancel: '取消赛事', archive: '存档', finish: '赛事结束',
        start: '开赛', join: '报名', bye: '轮空直接晋级',
        'entrant-approve': '批准报名', 'entrant-reject': '拒绝报名',
        'set-champion': '设置冠军', 'void-player': '取消选手成绩',
        'rematch-request': '申请重赛', 'rematch-approve': '批准重赛（该场重打）', 'rematch-reject': '驳回重赛',
      };

      // ⚠️ 2026-10-02 体验修复（问题 9 文案统一）：赛事状态文案收敛，并与列表页 `tournaments.js`
      // 的 `statusText` **逐字一致**（早前两页各写一套：详情页「待管理员审核」/ 列表页「审核中」）。
      const STATUS_TEXT = {
        pending_approval: '🕐 待审核',
        registration: '📌 报名中',
        playing: '⚔️ 比赛中',
        finished: '🏆 已结束',
        archived: '📦 已存档',
        rejected: '❌ 已拒绝',
        cancelled: '⛔ 已取消',
      };

      // ⚠️ 2026-10-02 体验修复（问题 1/9）：报名状态文案**唯一一份**，「我的报名状态」与
      // 「参赛名单」共用，避免同一状态在两处措辞不同（如「待批准」vs「报名已提交，等待主办人批准」）。
      const ENTRANT_TEXT = {
        pending:  { text: '🕐 待主办人批准', color: 'var(--gold-light)' },
        approved: { text: '✅ 已通过报名',   color: 'var(--gold-light)' },
        rejected: { text: '❌ 报名被拒绝',   color: 'var(--red-light)' },
        kicked:   { text: '🚫 已被移出',     color: 'var(--red-light)' },
      };

      // ⚠️ 2026-10-02 体验修复：页面内统一的输入弹层，替换裸 `window.prompt`。
      // 为什么必须换：原生 prompt 无法套用站内样式、移动端常被浏览器拦截、且会阻塞主线程，
      // 与站内 toast/模态体验割裂。这里用最小成本做一个页面内输入框，复用
      // `.modal-overlay/.card/.input` 样式，并接入 A11y 焦点管理（存在时）。
      // 返回 Promise<string|null>：确定 → 文本，取消 / 点遮罩 → null。
      function askInput(opts) {
        const o = opts || {};
        return new Promise((resolve) => {
          const root = document.createElement('div');
          root.className = 'modal-overlay';
          root.setAttribute('role', 'dialog');
          root.setAttribute('aria-modal', 'true');
          root.style.display = 'flex';
          const max = o.maxlength || 200;
          const field = o.multiline
            ? `<textarea class="input" id="uiAskField" rows="3" maxlength="${max}" style="width:100%;resize:vertical;font-family:inherit;"></textarea>`
            : `<input class="input" id="uiAskField" maxlength="${max}" style="width:100%;">`;
          root.innerHTML = `
            <div class="card" style="width:460px;max-width:94vw;padding:22px;">
              <div style="font-size:16px;font-weight:700;margin-bottom:10px;">${esc(o.title || '请输入')}</div>
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">${esc(o.label || '')}</div>
              ${field}
              <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
                <button class="btn btn-ghost btn-sm" id="uiAskCancel">取消</button>
                <button class="btn btn-primary btn-sm" id="uiAskOk">确定</button>
              </div>
            </div>`;
          document.body.appendChild(root);
          const fieldEl = root.querySelector('#uiAskField');
          if (fieldEl) fieldEl.value = o.value == null ? '' : String(o.value);
          const done = (val) => {
            openDialogs.delete(done); // SPA：弹层登记注销
            try { if (global.A11y) global.A11y.onDialogClose(root); } catch (_) { /* a11y 失败不阻塞关闭 */ }
            if (root.parentNode) root.parentNode.removeChild(root);
            resolve(val);
          };
          openDialogs.add(done); // SPA：登记打开的弹层，unmount 时统一强制关闭（等价用户点取消）
          root.querySelector('#uiAskOk').addEventListener('click', () => done(fieldEl ? fieldEl.value : ''));
          root.querySelector('#uiAskCancel').addEventListener('click', () => done(null));
          root.addEventListener('click', (e) => { if (e.target === root) done(null); });
          try { if (global.A11y) global.A11y.onDialogOpen(root, { onClose: () => done(null) }); } catch (_) { /* 同上 */ }
          if (fieldEl && fieldEl.focus) fieldEl.focus();
        });
      }

      // ⚠️ 2026-10-02 体验修复（问题 7）：记录服务端推送的赛事对局房间状态，用于判断「对手是否到场」。
      // 依据：开赛建房时服务端会把在线选手 bind 到房间并 `_pushState`（见 src/rooms/lifecycle.js
      // `createTournamentMatch` → `_pushState`），`state.players.<seat>.connected` 即在场状态。
      const roomPresence = {};

      /** @returns {boolean|null} true=对手在场；false=对手未到；null=尚无该房间快照（未知） */
      function isOpponentPresent(roomId, opponentId) {
        const p = roomPresence[roomId];
        if (!p || !opponentId) return null;
        const seat = p.b && p.b.id === opponentId ? 'b' : (p.w && p.w.id === opponentId ? 'w' : null);
        if (!seat) return null;
        return !!p[seat].connected;
      }

      /** 某条重赛申请是否牵涉本人（申请人 或 该场参赛者） */
      function rematchInvolvesMe(r) {
        if (!myPlayerId || !r) return false;
        if (r.byId && r.byId === myPlayerId) return true;
        const node = (T.bracket || []).find((x) => x.index === r.nodeIndex);
        if (node && (node.lastPlayers || node.players || []).indexOf(myPlayerId) >= 0) return true;
        return (T.rounds || []).some((rec) => {
          const mp = (rec.matchPairs || {})[r.matchId];
          if (mp && mp.indexOf(myPlayerId) >= 0) return true;
          return rec.lastMatchId === r.matchId && (rec.lastPair || []).indexOf(myPlayerId) >= 0;
        });
      }

      this._teardown.push(api.on('state', (d) => {
        if (!d || !d.roomId || !d.players) return;
        roomPresence[d.roomId] = d.players;
        // 对手进出房间会改变在场状态 → 立刻刷新「我的对局」区块（问题 7），
        // 不必等下一次主动操作才发现「对手已到场 / 尚未到场」。
        if (T && el('tnMyArea')) renderMyArea();
      }));

      /** 已确认参赛人数：开赛后看 players，报名阶段数 entrants 里 approved 的（与列表页口径一致） */
      function joinedCount(t) {
        const s = t.status;
        if (s === 'playing' || s === 'finished' || s === 'archived') return (t.players || []).length;
        return (t.entrants || []).filter((e) => e.status === 'approved').length;
      }

      function nameOf(id) {
        if (!id) return '未知';
        const p = (T.players || []).find((x) => x.id === id)
          || (T.entrants || []).find((x) => x.id === id);
        return p ? p.name : '未知';
      }

      function fmtTime(ts) {
        if (!ts) return '不限';
        return global.I18N.fmt(ts, {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        });
      }

      // ==================================================================
      // 加载
      // ==================================================================
      async function load() {
        if (!tid) return showError('链接里没有赛事 id，请从赛事列表进入。');
        try {
          const d = await global.ApiUtils.get(`/api/tournaments/${encodeURIComponent(tid)}`);
          if (!alive) return; // 已切页：不再触碰 DOM
          T = d.tournament;
          caps = d.caps || {};
          isAdmin = !!d.viewerIsAdmin;
        } catch (e) {
          if (!alive) return;
          return showError('赛事不存在，或已被删除。');
        }
        el('tnLoading').style.display = 'none';
        el('tnBody').style.display = '';
        renderAll();
      }

      function showError(msg) {
        el('tnLoading').textContent = msg;
        el('tnLoading').style.color = 'var(--red-light)';
      }

      /** 任何写操作成功后统一走这里：用服务端返回的最新赛事重绘（不自己改本地状态） */
      function afterMutate(res, okMsg) {
        if (res && res.tournament) T = res.tournament;
        if (okMsg) toast(okMsg);
        renderAll();
      }

      async function post(path, body, okMsg) {
        try {
          const res = await global.ApiUtils.postAuthed(path, body, guest.id);
          afterMutate(res, okMsg);
          return res;
        } catch (e) {
          toast(e.message);
          return null;
        }
      }

      function renderAll() {
        if (!alive) return; // 已切页：不再触碰 DOM
        renderHead();
        renderMyArea();
        renderManageArea();
        renderInfo();
        renderRoster();
        renderBracketCard();
        renderRematchCard();
        renderLogs();
        loadRecords(); // 独立异步：棋谱可能较多，不拖慢主渲染
      }

      // ==================================================================
      // 头部
      // ==================================================================
      function renderHead() {
        const isOwner = T.ownerId === myPlayerId;
        const champ = T.championId
          ? `<div style="margin-top:10px;font-size:15px;color:var(--gold-light);font-weight:700;">
               🏆 冠军：${esc(nameOf(T.championId))}${T.championManual ? '<span style="font-size:11px;color:var(--text-dim);font-weight:400;">（管理员裁定）</span>' : ''}
             </div>` : '';
        el('tnHead').innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">
            <div>
              <div style="font-size:24px;font-weight:700;margin-bottom:6px;">${esc(T.name)}</div>
              <div style="font-size:13px;color:var(--text-dim);">
                ${isOwner ? '<span style="color:var(--gold-light);">👑 我是主办人</span> · ' : ''}
                主办：<span data-player-id="${esc(T.ownerId || '')}">${esc(T.ownerName || '未知')}</span
                > · ${esc(T.formatLabel || '单败淘汰')} · ${joinedCount(T)}/${T.size} 人${
      // 瑞士制的"打到哪了"光看状态看不出来，把轮次一并显示
      (T.format === 'swiss' && T.totalRounds) ? ` · 第 ${T.currentRound || 0}/${T.totalRounds} 轮` : ''}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="tag" style="font-size:13px;">${STATUS_TEXT[T.status] || esc(T.status)}</span>
              <a class="btn btn-ghost btn-sm" href="tournaments.html">← 赛事列表</a>
            </div>
          </div>
          ${champ}`;
      }

      // ==================================================================
      // 我的操作区（报名 / 我的报名状态 / 进入我的对局）
      // ==================================================================
      function renderMyArea() {
        const box = el('tnMyArea');
        const parts = [];

        // ⚠️ 2026-10-02 体验修复（问题 1）：本人的报名/参赛状态**在任何赛事状态下都展示**。
        // 原实现把这一块锁死在 `registration` 里 —— 赛事一开赛/结束/取消，被拒、被踢、
        // 已被取消的人就再也看不到「我的报名到底怎么了」，只能看到头部一个笼统的赛事状态。
        const mine = (T.entrants || []).find((e) => e.id === myPlayerId);
        if (myPlayerId && (mine || T.status === 'rejected' || T.status === 'cancelled')) {
          parts.push(myStatusCard(mine));
        }

        // 未登录：给一句登录引导
        if (T.status === 'registration' && !myPlayerId) {
          parts.push(notice('登录后可报名参加本赛事。'));
        }

        // ---- 报名（仅报名阶段且本人还没报过）----
        if (T.status === 'registration' && myPlayerId && !mine) {
          const approvedN = joinedCount(T);
          const full = approvedN >= T.size;
          parts.push(`
            <div class="card" style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
              <div style="font-size:13px;color:var(--text-dim);">
                ${full ? '名额已满。' : `已有 ${approvedN}/${T.size} 人通过报名${T.requireApproval ? '，报名需主办人审核' : ''}。`}
              </div>
              <button class="btn btn-primary" id="btnJoinTn" ${full ? 'disabled' : ''}>${full ? '名额已满' : '报名'}</button>
            </div>`);
        }

        // ---- 我参与的对局（进行中 / 等待对手到场）----
        const matchBlock = myMatchBlock();
        if (matchBlock) parts.push(matchBlock);

        // ---- 改判 / 裁定通知（问题 6）----
        const adjBlock = myAdjudicationNotices();
        if (adjBlock) parts.push(adjBlock);

        box.innerHTML = parts.join('');

        const joinBtn = el('btnJoinTn');
        if (joinBtn) {
          joinBtn.addEventListener('click', () => {
            // 报名走 WS：身份由连接握手时绑定，客户端无从伪造（见 history.js 顶部同源注释）
            api.send({ type: 'join_tournament', data: { id: T.id } });
          });
        }
        const howBtn = el('btnHowWithdraw');
        if (howBtn) {
          howBtn.addEventListener('click', () => {
            // ⚠️ 站内没有独立输入层时用 UI.alert 做只读说明（UI 暴露的键名是 `alert`，见 util.js 的 global.UI）
            UI.alert('如何退赛 / 取消报名？',
              '当前版本暂未提供选手自助退赛接口（前端不伪造请求）。'
              + '报名阶段：请联系主办人，请其在本页「参赛名单」里把你移出（移出后状态显示为「已被移出」）；'
              + '赛事开赛后：如需退出，请告知主办人或管理员，由「取消选手成绩」处理（该选手所有对局判对手胜）。');
          });
        }
      }

      /**
       * 我的报名/参赛状态卡（问题 1）。
       *
       * ⚠️ 服务端**没有**为单条报名记录保存处理理由：`entrants` 项只有 `{id,name,at,status}`，
       * 理由只存在于**赛事级** `rejectReason`（审核拒绝 / 取消赛事时写入）。所以这里：
       *  - 有 `rejectReason` 就展示；
       *  - 没有就如实说明「服务端未记录个人理由」，并指向主办人 —— 前端不臆造原因。
       */
      function myStatusCard(mine) {
        if (!mine) {
          // 只有赛事被拒 / 被取消才会走到这里（本人没有报名记录）
          const label = T.status === 'cancelled' ? '⛔ 本赛事已取消' : '❌ 本赛事未通过审核';
          const reason = T.rejectReason ? `：${esc(T.rejectReason)}` : '';
          return `<div class="card" style="padding:16px 20px;font-size:13px;color:var(--red-light);">${label}${reason}</div>`;
        }

        const hit = ENTRANT_TEXT[mine.status] || { text: esc(mine.status), color: 'var(--text-dim)' };
        const lines = [`<span style="color:${hit.color};">${hit.text}</span>`];
        if (mine.status === 'approved') lines.push(` · 已确认 ${joinedCount(T)}/${T.size} 人`);
        if (mine.status === 'pending') lines.push(' · 主办人批准后即计入参赛名单');
        if ((mine.status === 'rejected' || mine.status === 'kicked') && !T.rejectReason) {
          lines.push(' <span style="color:var(--text-dim);">（服务端未记录个人处理理由，如有疑问请联系主办人）</span>');
        }

        let footer = '';
        if (T.status === 'cancelled') footer = `<div style="margin-top:6px;color:var(--red-light);">⛔ 本赛事已取消${T.rejectReason ? `：${esc(T.rejectReason)}` : ''}</div>`;
        else if (T.status === 'rejected' && T.rejectReason) footer = `<div style="margin-top:6px;color:var(--red-light);">处理原因：${esc(T.rejectReason)}</div>`;

        // ⚠️ 2026-10-02 体验修复（问题 2）：选手「退赛 / 取消报名」入口。
        // 现状：服务端**没有**自助退赛接口（写接口只有 报名/审批/踢人/开赛/取消成绩/取消赛事，
        // 见 src/http/routes/tournaments.js；entrant 状态只有 pending/approved/rejected/kicked）。
        // 因此前端不硬造请求，改为给出「如何退赛」的明确说明（主办人可在报名阶段把你移出）。
        let withdraw = '';
        if (T.status === 'registration' && (mine.status === 'pending' || mine.status === 'approved')) {
          withdraw = '<button class="btn btn-ghost btn-sm" id="btnHowWithdraw" style="margin-top:10px;">如何退赛 / 取消报名？</button>';
        }

        return `<div class="card" style="padding:16px 20px;font-size:13px;line-height:1.7;">
          <div><span style="color:var(--text-dim);">我的报名状态：</span>${lines.join('')}</div>
          ${footer}${withdraw}
        </div>`;
      }

      /**
       * 「我的对局」区块（问题 3/7）：列出本人已安排的对局（淘汰赛节点 + 瑞士制本轮），
       * 并根据服务端推送的房间快照标注**对手是否到场**，给一句「进入对局」。
       */
      function myMatchBlock() {
        if (!myPlayerId) return '';
        const rows = [];

        (T.bracket || []).forEach((n) => {
          if (!n.matchId || !n.players || n.players.indexOf(myPlayerId) < 0) return;
          rows.push(matchRow(n.matchId, (n.players || []).find((id) => id !== myPlayerId), null));
        });
        (T.rounds || []).forEach((r) => {
          (r.pairs || []).forEach((p, i) => {
            const roomId = (r.matchIds || [])[i];
            if (!roomId || p.indexOf(myPlayerId) < 0) return;
            rows.push(matchRow(roomId, p[0] === myPlayerId ? p[1] : p[0], r.round));
          });
        });

        if (!rows.length) return '';
        return `<div class="card" style="padding:16px 20px;">
          <div style="font-size:13px;color:var(--gold-light);margin-bottom:8px;">⚔️ 你的对局已安排</div>
          ${rows.join('')}
          <div style="font-size:12px;color:var(--text-dim);margin-top:6px;">对手未到场时可在房内等待；对局开始后离开页面可能被判负。</div>
        </div>`;
      }

      function matchRow(roomId, opponentId, round) {
        // ⚠️ 问题 7：对手是否到场取自服务端推送的 `state`（players.<seat>.connected）；
        // 没有该房间快照时（例如对局在本人不在线时创建）如实显示「以房间内状态为准」。
        const present = isOpponentPresent(roomId, opponentId);
        const hint = present === false
          ? '<span style="color:var(--red-light);">⚠️ 对手尚未到场</span>'
          : present === true
            ? '<span style="color:var(--text-dim);">对手已到场</span>'
            : '<span style="color:var(--text-dim);">以房间内状态为准</span>';
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 0;font-size:13px;">
          <span>${round ? `第 ${round} 轮 · ` : ''}对手：<span data-player-id="${esc(opponentId || '')}">${esc(nameOf(opponentId))}</span> ${hint}</span>
          <a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&join=1">进入对局</a>
        </div>`;
      }

      /**
       * 改判 / 裁定通知（问题 6）：把**牵涉本人**且已裁决的重赛申请显式提示出来，
       * 展示服务端已有字段（status / reason / note），选手不必翻到最底下的重赛卡片才发现自己被改判。
       */
      function myAdjudicationNotices() {
        if (!myPlayerId) return '';
        const decided = (T.rematches || []).filter((r) => r.status !== 'pending' && rematchInvolvesMe(r));
        if (!decided.length) return '';
        const rows = decided.map((r) => {
          const st = r.status === 'approved'
            ? ['✅ 已批准重赛（该场重打）', 'var(--gold-light)']
            : ['❌ 已驳回', 'var(--red-light)'];
          return `<div style="font-size:13px;padding:4px 0;">
            <span style="color:${st[1]};">${st[0]}</span>
            ${r.reason ? ` · 申请理由：${esc(r.reason)}` : ''}
            ${r.note ? ` · 处理备注：${esc(r.note)}` : ''}
          </div>`;
        }).join('');
        return `<div class="card" style="padding:16px 20px;border:1px solid var(--gold);">
          <div style="font-size:13px;font-weight:700;color:var(--gold-light);margin-bottom:6px;">🔔 改判 / 裁定通知</div>
          ${rows}
        </div>`;
      }

      function notice(text) {
        return `<div class="card" style="padding:16px 20px;font-size:13px;color:var(--text-dim);">${text}</div>`;
      }

      // ==================================================================
      // 管理区（主办人 / 管理员）
      //
      // ⚠️ 每个按钮都对应一个服务端写接口，且服务端会**再判一次权限**。
      // 这里用 `caps` 决定显隐，只是不让用户看到"点了必然失败"的按钮。
      // ==================================================================
      function renderManageArea() {
        const box = el('tnManageArea');
        // ⚠️ 2026-10-02 审查 P3：canAny 必须涵盖下方实际会渲染的动作（archive/edit_archived），
        // 否则仅具这两项权限时会把整块管理面板清空（当前权限模型下不可达，属一致性加固）。
        const canAny = caps.decide_entrant || caps.kick_player || caps.assign_round
          || caps.void_player || caps.cancel || caps.set_champion
          || caps.archive || caps.edit_archived;
        if (!canAny) { box.innerHTML = ''; return; }

        const s = T.status;
        const pendingList = (T.entrants || []).filter((e) => e.status === 'pending');
        const approvedN = joinedCount(T);
        const actions = [];

        // ⚠️ 「开始比赛」必须限定在**报名阶段**：`caps.assign_round` 只表示"这个角色有权开赛"，
        // 与当前状态无关——不判状态的话，比赛已经开始（甚至结束）了按钮还在，
        // 点下去必然撞到状态机报错。
        if (caps.assign_round && s === 'registration') {
          actions.push(`<button class="btn btn-primary btn-sm" id="btnStartTn">
            ▶️ 开始比赛${approvedN < T.size ? `（未满员也可，${T.size - approvedN} 个位置自动轮空）` : ''}</button>`);
        }
        if (caps.cancel) {
          actions.push('<button class="btn btn-ghost btn-sm" id="btnCancelTn" style="color:var(--red-light);">⛔ 取消赛事</button>');
        }
        if (caps.archive) {
          actions.push('<button class="btn btn-ghost btn-sm" id="btnArchiveTn">📦 存档赛事</button>');
        }
        if (caps.edit_archived) {
          actions.push('<button class="btn btn-ghost btn-sm" id="btnEditNoteTn">✏️ 编辑备注</button>');
        }

        // ---- 待批准报名（T3）----
        // ⚠️ 这块**直接放在管理面板里**，而不是只在下方名单里放按钮：
        // 早先面板上只写一句"见下方名单"，主办人得往下滚动去找——
        // 而"批准报名"恰恰是报名阶段最高频的操作，应该伸手就能点到。
        const approveBox = (caps.decide_entrant && pendingList.length) ? `
            <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;">
                <div style="font-size:13px;color:var(--gold-light);">🕐 待批准报名（${pendingList.length}）</div>
                <button class="btn btn-primary btn-sm" id="btnApproveAll">全部批准</button>
              </div>
              ${pendingList.map((e) => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:13px;">
                  <span data-player-id="${esc(e.id)}">${esc(e.name)}</span>
                  <span style="display:flex;gap:6px;">
                    <button class="btn btn-primary btn-sm" data-act="approve" data-pid="${esc(e.id)}">批准</button>
                    <button class="btn btn-ghost btn-sm" data-act="reject" data-pid="${esc(e.id)}">拒绝</button>
                  </span>
                </div>`).join('')}
            </div>` : '';

        const tips = [];
        if (caps.void_player && s === 'playing') tips.push('取消选手成绩：该选手所有对局判对手胜，并重算后续轮次');
        if (caps.set_champion && s !== 'archived') tips.push('设置冠军为<b>管理员专属</b>操作');
        if (caps.archive) tips.push('存档后主办人只读；系统也会在结束后 24 小时自动存档');
        if (caps.edit_archived) tips.push('已存档赛事仅管理员可编辑，且每次编辑都会留痕');

        box.innerHTML = `
          <div class="card" style="padding:18px 20px;border:1px solid var(--gold);">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
              <div style="font-size:14px;font-weight:700;color:var(--gold-light);">
                🎛 ${isAdmin && caps.set_champion ? '管理员' : '主办人'}管理面板
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">${actions.join('')}</div>
            </div>
            ${tips.length ? `<div style="font-size:12px;color:var(--text-dim);margin-top:8px;line-height:1.7;">${tips.join('<br>')}</div>` : ''}
            ${approveBox}
          </div>`;

        const startBtn = el('btnStartTn');
        if (startBtn) {
          startBtn.addEventListener('click', () => {
            if (!confirm('确定开始比赛？开始后报名名单将被冻结。')) return;
            post(`/api/tournaments/${encodeURIComponent(T.id)}/start`, {}, '赛事已开始');
          });
        }
        const cancelBtn = el('btnCancelTn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', async () => {
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const reason = await askInput({ title: '取消赛事', label: '取消原因（可留空）', multiline: true });
            if (reason === null) return; // 用户取消
            post(`/api/tournaments/${encodeURIComponent(T.id)}/cancel`, { reason }, '赛事已取消');
          });
        }
        // 「批准 / 拒绝」按钮**不再在这里逐个绑定**（2026-09-23，审查项 13f）：
        // 已改走 util.js 的**整页委托**（见文件末尾的注册）。
        // ⚠️ 原注释记录的坑是真的：两处面板各写一次 `querySelectorAll('button[data-act]')`
        // 会把回调同时绑到对方的按钮上（点一下发两次请求）。委托只有一份监听，从结构上不会再犯。
        const allBtn = el('btnApproveAll');
        if (allBtn) {
          allBtn.addEventListener('click', () => approveAll(pendingList.map((e) => e.id)));
        }

        const archiveBtn = el('btnArchiveTn');
        if (archiveBtn) {
          archiveBtn.addEventListener('click', () => {
            if (!confirm('确定存档本赛事？\n存档后主办人将转为只读，仅管理员可继续编辑。')) return;
            // 存档是管理员专属，走 admin 路由（同一个 adminOnly + 审计落盘）
            global.ApiUtils.postAuthed(`/api/admin/tournaments/${encodeURIComponent(T.id)}/archive`, {}, guest.id)
              .then((res) => afterMutate(res, '赛事已存档'))
              .catch((e) => toast(e.message));
          });
        }
        const noteBtn = el('btnEditNoteTn');
        if (noteBtn) {
          noteBtn.addEventListener('click', async () => {
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const note = await askInput({
              title: '编辑赛事备注',
              label: '赛事备注（仅管理员可编辑，会记入编辑历史）',
              value: T.note || '',
              multiline: true,
            });
            if (note === null) return;
            global.ApiUtils.postAuthed(`/api/admin/tournaments/${encodeURIComponent(T.id)}/edit`,
              { field: 'note', value: note }, guest.id)
              .then((res) => afterMutate(res, '备注已更新'))
              .catch((e) => toast(e.message));
          });
        }
      }

      // ==================================================================
      // 申请信息（需求 9：申请表内容公开可查）
      // ==================================================================
      function renderInfo() {
        const rows = [
          // ⚠️ 别再写死"单败淘汰制"：T8 起有瑞士制了，赛制必须取服务端下发的标签
          ['赛制', T.formatLabel || '单败淘汰'],
          ['人数档位', `${T.size} 人`],
          // ⚠️ 2026-10-02 体验修复（问题 5）：这些时间只是**计划/参考**，不是硬性开赛时刻。
          // 服务端只做自洽校验（validateSchedule），**不会按时间自动开赛**——开赛由「报名满员」
          // 或主办人手动触发。标题改写作「参考…」，避免被当成准点开赛。
          ['参考报名时间', `${fmtTime(T.registerStart)} ~ ${fmtTime(T.registerEnd)}`],
          ['参考比赛时间', `${fmtTime(T.matchStart)} ~ ${fmtTime(T.matchEnd)}`],
          ['报名审核', T.requireApproval ? '需主办人审核' : '免审核（报名即参赛）'],
          ['提交时间', fmtTime(T.createdAt)],
        ];
        if (T.format === 'swiss' && T.totalRounds) {
          rows.splice(1, 0, ['轮次', `共 ${T.totalRounds} 轮${T.currentRound ? `（已进行到第 ${T.currentRound} 轮）` : ''}`]);
        }
        const reason = T.reason
          ? `<div style="margin-top:12px;font-size:13px;line-height:1.8;"><span style="color:var(--text-dim);">举办理由：</span><br>${esc(T.reason)}</div>`
          : '';
        const reject = T.rejectReason
          ? `<div style="margin-top:12px;font-size:13px;color:var(--red-light);">处理原因：${esc(T.rejectReason)}</div>`
          : '';
        el('tnInfo').innerHTML = `
          <div class="section-title" style="margin-bottom:14px;">赛事信息</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;font-size:13px;">
            ${rows.map(([k, v]) => `<div><span style="color:var(--text-dim);">${k}：</span>${esc(v)}</div>`).join('')}
          </div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-dim);line-height:1.7;">
            ⏱ 以上时间仅供规划参考，不会自动开赛：实际以「报名满员自动开赛」或主办人手动开赛为准。
          </div>
          ${reason}${reject}`;
      }

      // ==================================================================
      // 参赛名单（报名池 + 参赛者；主办人可直接在此批准/拒绝/踢人）
      // ==================================================================
      function renderRoster() {
        const entrants = T.entrants || [];
        const isPlaying = T.status === 'playing' || T.status === 'finished' || T.status === 'archived';

        // ⚠️ 2026-10-02 体验修复（问题 9 文案统一）：报名状态文案复用 `ENTRANT_TEXT`
        //（与「我的报名状态」同一份），不再各写一套（原为「待批准 / 已通过 / 已拒绝 / 已移出」）。
        const label = {};
        Object.keys(ENTRANT_TEXT).forEach((k) => { label[k] = [ENTRANT_TEXT[k].text, ENTRANT_TEXT[k].color]; });

        let body;
        if (entrants.length) {
          body = entrants.map((e) => {
            const hit = label[e.status] || [esc(e.status), 'var(--text-dim)'];
            // 名单里的操作 = **针对某个人"事后"的动作**（踢出 / 取消成绩 / 设冠军）。
            // ⚠️「批准 / 拒绝」刻意**不在这里**——它们属于"待办队列"，统一放在上方的管理面板。
            // 两处都摆同一组按钮，页面上就会同时出现两个相邻的「批准」，纯属干扰。
            const btns = [];
            if (caps.kick_player && !isPlaying && e.status !== 'kicked') {
              btns.push(`<button class="btn btn-ghost btn-sm" data-act="kick" data-pid="${esc(e.id)}" style="color:var(--red-light);">踢出</button>`);
            }
            if (caps.void_player && isPlaying && e.status === 'approved') {
              btns.push(`<button class="btn btn-ghost btn-sm" data-act="void" data-pid="${esc(e.id)}" style="color:var(--red-light);">取消成绩</button>`);
            }
            if (caps.set_champion && e.status === 'approved' && T.championId !== e.id) {
              btns.push(`<button class="btn btn-ghost btn-sm" data-act="champion" data-pid="${esc(e.id)}">设为冠军</button>`);
            }
            return `
              <div class="record-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span data-player-id="${esc(e.id)}" style="font-size:13px;">${esc(e.name)}</span>
                  <span style="font-size:11px;color:${hit[1]};">${hit[0]}</span>
                  ${e.id === T.ownerId ? '<span style="font-size:11px;color:var(--gold-light);">主办</span>' : ''}
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">${btns.join('')}</div>
              </div>`;
          }).join('');
        } else {
          body = '<div style="color:var(--text-dim);font-size:13px;">还没有人报名。</div>';
        }

        el('tnRoster').innerHTML = `
          <div class="section-title" style="margin-bottom:14px;">
            报名与参赛名单（${joinedCount(T)}/${T.size} 已通过${entrants.length !== joinedCount(T) ? ` · 共 ${entrants.length} 条报名` : ''}）
          </div>
          ${body}`;

        // 名单里的操作按钮同样走**整页委托**（2026-09-23，审查项 13f）：这里不再逐个绑定。
      }

      /**
       * 批量批准报名（管理面板上的「全部批准」）。
       *
       * ⚠️ **逐个发请求**，不做"一次批一批"的服务端接口：名额与权限判定必须每次都真的走一遍
       * （批准到最后一个可能正好满员、自动开赛，后面几个就该被服务端正常拒绝）。
       * 在前端做"批量捷径"等于绕开这些判定。
       */
      async function approveAll(ids) {
        if (!ids.length) return;
        if (!confirm(`确定批准这 ${ids.length} 人的报名？`)) return;
        let ok = 0;
        for (const pid of ids) {
          // okMsg 传空串：逐条弹提示会刷屏，最后统一报一次结果
          const res = await post(
            `/api/tournaments/${encodeURIComponent(T.id)}/entrants/${encodeURIComponent(pid)}`,
            { decision: 'approve' }, '');
          if (res) ok++;
        }
        if (ok < ids.length) {
          toast(`已批准 ${ok} 人，其余 ${ids.length - ok} 人未成功（可能名额已满或赛事已开始）`);
        } else {
          toast(`已批准 ${ok} 人`);
        }
      }

      async function rosterAction(act, playerId) {
        const id = encodeURIComponent(T.id);
        if (act === 'approve' || act === 'reject') {
          return post(`/api/tournaments/${id}/entrants/${encodeURIComponent(playerId)}`,
            { decision: act }, act === 'approve' ? '已批准报名' : '已拒绝报名');
        }
        if (act === 'kick') {
          if (!confirm(`确定把 ${nameOf(playerId)} 移出本赛事？`)) return;
          return post(`/api/tournaments/${id}/kick`, { playerId }, '已移出该报名者');
        }
        if (act === 'void') {
          if (!confirm(`确定取消 ${nameOf(playerId)} 的成绩？\n该选手所有对局将判对手胜，后续轮次会重新计算。`)) return;
          return post(`/api/tournaments/${id}/void`, { playerId }, '已取消该选手成绩');
        }
        if (act === 'champion') {
          if (!confirm(`确定把 ${nameOf(playerId)} 设为冠军？\n这是管理员专属操作，会被记入变更记录。`)) return;
          return post(`/api/tournaments/${encodeURIComponent(T.id)}/champion`, { playerId }, '已设置冠军');
        }
      }

      // ==================================================================
      // 对阵表
      // ==================================================================
      /** 与后端 `swiss.pairKey` 同构：一对选手的稳定键（与先后顺序无关） */
      function pairKey(a, b) {
        return String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`;
      }

      function renderBracketCard() {
        const card = el('tnBracketCard');
        // T8：瑞士制没有淘汰树，用"轮次列表 + 名次表"呈现
        if (T.format === 'swiss') { renderSwissCard(card); return; }
        if (!(T.bracket || []).length) {
          card.style.display = 'none';
          return;
        }
        card.style.display = '';
        const nodes = T.bracket || [];
        // ⚠️ 2026-10-02 体验修复（问题 3）：进行中的对局提供**观战**入口（跳到 play.html?...&spectate=1）。
        const live = nodes.filter((n) => n.matchId && n.players);
        // ⚠️ 问题 4：淘汰赛和棋（服务端置 `node.draw = true`，见 src/tournaments/bracket.js）。
        const draws = nodes.filter((n) => n.draw);
        // ⚠️ 问题 8：建房失败（有对阵双方，却既没建出房间、也没有结果）——不再静默成「待定」。
        const failed = nodes.filter((n) => n.players && !n.matchId && !n.winnerId && !n.draw);
        card.innerHTML = `
          <div class="section-title" style="margin-bottom:4px;">对阵表</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
            金色边框 = 已分出胜负；「空位」= 该位置无人（报名不足时会出现，对手自动轮空晋级）
          </div>
          ${UI.bracketHtml(T, { myId: myPlayerId, detail: true })}
          ${draws.length ? `<div style="margin-top:10px;font-size:12px;color:var(--red-light);">🤝 和棋待裁决：${draws.map((n) => esc((n.lastPlayers || []).map(nameOf).join(' vs '))).join('、')}（淘汰赛和棋无法自动晋级，需主办人 / 管理员安排重赛）</div>` : ''}
          ${failed.length ? `<div style="margin-top:10px;font-size:12px;color:var(--red-light);">⚠️ 有 ${failed.length} 场对局未能创建房间：${failed.map((n) => esc((n.players || []).map(nameOf).join(' vs '))).join('、')}（需主办人 / 管理员重试或安排重赛）</div>` : ''}
          ${live.length ? `<div style="margin-top:12px;">
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">进行中的对局（可进入 / 观战）：</div>
            ${live.map((n) => {
              const mine = (n.players || []).indexOf(myPlayerId) >= 0;
              const label = (n.players || []).map(nameOf).join(' vs ');
              const href = mine
                ? `play.html?room=${encodeURIComponent(n.matchId)}&join=1`
                : `play.html?room=${encodeURIComponent(n.matchId)}&spectate=1`;
              return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;padding:3px 0;">
                <span>${esc(label)}</span>
                <a class="btn ${mine ? 'btn-primary' : 'btn-ghost'} btn-sm" href="${href}">${mine ? '进入对局' : '观战'}</a>
              </div>`;
            }).join('')}
          </div>` : ''}`;
      }

      /**
       * 瑞士制赛程视图（T8）：**轮次列表 + 名次表**。
       *
       * ⚠️ 刻意不复用 `UI.bracketHtml`：那是淘汰树的画法（按满二叉树分层），
       * 而瑞士制每轮按积分重新配对，压根没有树——套上去只会画出一堆"待定"。
       */
      function renderSwissCard(card) {
        const rounds = T.rounds || [];
        if (!rounds.length) {
          card.style.display = '';
          card.innerHTML = `
            <div class="section-title" style="margin-bottom:10px;">赛程（${esc(T.formatLabel || '瑞士制')}）</div>
            <div style="color:var(--text-dim);font-size:13px;">
              尚未开赛。共 ${T.totalRounds || 0} 轮，开赛后每轮按积分重新配对。
            </div>`;
          return;
        }
        card.style.display = '';

        const roundsHtml = rounds.map((r) => {
          const isCur = r.round === T.currentRound && T.status === 'playing';
          let failedN = 0;
          const rows = (r.pairs || []).map(([a, b], i) => {
            const w = (r.results || {})[pairKey(a, b)];
            const mine = !!myPlayerId && (a === myPlayerId || b === myPlayerId);
            const roomId = (r.matchIds || [])[i];
            let tag;
            if (w === '-') {
              // ⚠️ 2026-10-02 体验修复（问题 4）：瑞士制 `results` 用 `'-'` 表示和棋
              //（见 src/swiss.js：和棋各得 0.5 分）。原实现只判 `if (w)`，会把 '-' 当选手 id
              // 去查名字 → 显示成「未知 胜」，把和棋误报成有人获胜。
              tag = '<span style="color:var(--gold-light);">🤝 和棋（各得 0.5 分）</span>';
            } else if (w) {
              tag = `<span style="color:var(--gold-light);">${esc(nameOf(w))} 胜</span>`;
            } else if (roomId) {
              // ⚠️ 问题 3：非本人对局给「观战」入口（本人仍是「进入对局」）。
              tag = mine
                ? `<a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&join=1">进入对局</a>`
                : `<a class="btn btn-ghost btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&spectate=1">观战</a>`;
            } else {
              // ⚠️ 问题 8：既无结果、又没有房间 id = 建房失败（startSwissRound 建房失败时 matchIds[i]=null）。
              // 原实现只显示「—」，把「这轮有一场根本没打起来」静默掉了。
              failedN++;
              tag = '<span style="color:var(--red-light);" title="该场未能创建房间，需主办人 / 管理员重试或安排重赛">⚠️ 未能开局</span>';
            }
            const voided = (r.voided || []).some((v) => v === a || v === b);
            return `
              <div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:12px;${mine ? 'font-weight:700;' : ''}">
                <span>${esc(nameOf(a))} vs ${esc(nameOf(b))}${voided ? ' <span style="color:var(--red-light);font-size:11px;">（成绩取消）</span>' : ''}</span>
                <span>${tag}</span>
              </div>`;
          }).join('');
          const byes = (r.byes || []).length
            ? `<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">轮空：${(r.byes || []).map((id) => esc(nameOf(id))).join('、')}（视同胜，得 1 分）</div>`
            : '';
          // ⚠️ 问题 8：轮次级告警（退让原因 / 建房失败）显式呈现，避免「静默卡住一轮」。
          const roundWarn = [];
          if (r.degraded) roundWarn.push(`配对经过退让${r.reason ? `：${esc(r.reason)}` : ''}，可能有重复对阵`);
          if (failedN) roundWarn.push(`有 ${failedN} 场未能创建房间，需主办人 / 管理员处理`);
          return `
            <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;${isCur ? 'border-color:var(--gold);' : ''}">
              <div style="font-size:13px;font-weight:700;margin-bottom:6px;">
                第 ${r.round} 轮${isCur ? ' <span style="font-size:11px;color:var(--gold-light);">进行中</span>' : ''}
              </div>
              ${roundWarn.length ? `<div style="font-size:11px;color:var(--red-light);margin-bottom:4px;">⚠️ ${roundWarn.join('；')}</div>` : ''}
              ${rows}${byes}
            </div>`;
        }).join('');

        const standings = T.standings || [];
        const rankRows = standings.map((s) => `
          <div style="display:grid;grid-template-columns:34px 1fr 56px 56px 50px;gap:6px;font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);${s.id === myPlayerId ? 'font-weight:700;' : ''}">
            <span style="color:var(--gold-light);">${s.rank}</span>
            <span data-player-id="${esc(s.id)}">${esc(s.name || '—')}</span>
            <span>${s.score} 分</span>
            <span style="color:var(--text-dim);">${s.sos}</span>
            <span style="color:var(--text-dim);">${s.wins}-${s.draws}-${s.losses}</span>
          </div>`).join('');

        card.innerHTML = `
          <div class="section-title" style="margin-bottom:4px;">赛程（${esc(T.formatLabel || '瑞士制')} · 共 ${T.totalRounds} 轮）</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
            每轮按积分重新配对：强者遇强者、不重复对阵（没有淘汰，输一两场仍有机会）。
            当前第 ${T.currentRound || 0} 轮${T.status === 'playing' ? '' : '（已结束）'}。
          </div>
          ${roundsHtml}
          <div class="section-title" style="margin:16px 0 4px;">名次表</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
            排序：积分 → 对手分（SOS）→ 参赛顺序。胜 1 分、和 0.5 分、轮空 1 分。
            ${T.championTie ? '<span style="color:var(--gold-light);">⚠️ 与第二名同分，按对手分裁定</span>' : ''}
          </div>
          <div style="display:grid;grid-template-columns:34px 1fr 56px 56px 50px;gap:6px;font-size:11px;color:var(--text-dim);padding-bottom:4px;border-bottom:1px solid var(--border);">
            <span>名次</span><span>选手</span><span>积分</span><span>对手分</span><span>胜-和-负</span>
          </div>
          ${rankRows || '<div style="color:var(--text-dim);font-size:13px;">暂无数据。</div>'}`;
      }

      // ==================================================================
      // 赛事棋谱（T6/需求 12）
      //
      // 赛事对局在**落盘时就被强制设为公开**（见 `src/rooms/gameplay.js`），
      // 所以这里对**所有人**（含未登录游客）展示，不做任何可见性判断。
      // ==================================================================
      let allRecords = [];
      let recPage = 1;

      async function loadRecords() {
        const card = el('tnRecordsCard');
        try {
          const d = await global.ApiUtils.get(`/api/tournaments/${encodeURIComponent(tid)}/records`);
          allRecords = d.records || [];
        } catch (e) {
          card.innerHTML = '<div class="section-title" style="margin-bottom:10px;">赛事棋谱</div>'
            + '<div style="color:var(--red-light);font-size:13px;">棋谱加载失败，请稍后重试。</div>';
          return;
        }
        renderRecordsCard();
      }

      function renderRecordsCard() {
        const card = el('tnRecordsCard');
        if (!allRecords.length) {
          card.innerHTML = `
            <div class="section-title" style="margin-bottom:10px;">赛事棋谱（0）</div>
            <div style="color:var(--text-dim);font-size:13px;">还没有赛事对局棋谱。对局结束后会自动出现在这里（赛事棋谱默认公开）。</div>`;
          return;
        }
        // 先铺好容器，再交给分页工具切片 + 画分页条（每页 20 条，与其他列表口径一致）
        card.innerHTML = `
          <div class="section-title" style="margin-bottom:10px;">赛事棋谱（${allRecords.length}）</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">赛事对局棋谱**默认公开**，所有人均可查看与复盘。</div>
          <div id="tnRecordsList"></div>
          <div id="tnRecordsPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>`;

        const pg = UI.paginate({
          items: allRecords,
          page: recPage,
          size: 20,
          container: 'tnRecordsPager',
          onPage: (n) => { recPage = n; renderRecordsCard(); },
        });
        recPage = pg.page;

        el('tnRecordsList').innerHTML = pg.slice.map((r) => {
          const names = r.names || ['先手', '後手'];
          const res = UI.resultText(r, { withClass: true });
          return `
            <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
              <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])}</div>
              <div class="r-result ${res.cls}">${esc(res.text)}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${r.moveCount || 0} 手 · ${fmtTime(r.createdAt)} · 进入复盘 →</div>
            </div>`;
        }).join('');
      }

      // ==================================================================
      // 重赛申请（T6/需求 12）
      //
      //  - 所有人都能看到申请与裁决结果（办赛透明）；
      //  - **本场选手**可以对自己那场提申请（"我能不能申诉这一场"由服务端核对 `lastPlayers`）；
      //  - 主办人 / 管理员对 pending 的申请裁决。
      // ==================================================================
      function renderRematchCard() {
        const card = el('tnRematchCard');
        const list = (T.rematches || []).slice().reverse();
        const pending = list.filter((r) => r.status === 'pending');
        const canDecide = !!caps.decide_rematch;

        // 我能申请重赛的场次：我打过、且该场还没有待裁决的申请
        const applicable = [];
        if (T.status === 'playing' && myPlayerId) {
          (T.bracket || []).forEach((n) => {
            const both = n.lastPlayers || n.players || [];
            if (!n.lastMatchId || both.indexOf(myPlayerId) < 0) return;
            if ((T.rematches || []).some((r) => r.matchId === n.lastMatchId && r.status === 'pending')) return;
            applicable.push(n);
          });
        }

        const rows = list.map((r) => {
          const node = (T.bracket || []).find((x) => x.index === r.nodeIndex) || {};
          const both = (node.lastPlayers || node.players || []).map((id) => nameOf(id)).join(' vs ');
          const st = {
            pending: ['🕐 待裁决', 'var(--gold-light)'],
            approved: ['✅ 已批准（该场重打）', 'var(--gold-light)'],
            rejected: ['❌ 已驳回', 'var(--red-light)'],
          }[r.status] || [esc(r.status), 'var(--text-dim)'];
          const btns = (canDecide && r.status === 'pending')
            ? `<button class="btn btn-primary btn-sm" data-rm="${esc(r.id)}" data-rmact="approve">批准重赛</button>
               <button class="btn btn-ghost btn-sm" data-rm="${esc(r.id)}" data-rmact="reject">驳回</button>`
            : '';
          return `
            <div class="record-item" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <div>
                <div style="font-size:13px;">${esc(both || '（对阵已重算）')} <span style="font-size:11px;color:${st[1]};">${st[0]}</span></div>
                <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
                  申请人 ${esc(r.byName || nameOf(r.byId))} · ${fmtTime(r.at)}${r.reason ? ` · 理由：${esc(r.reason)}` : ''}${r.note ? ` · 处理备注：${esc(r.note)}` : ''}
                </div>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">${btns}</div>
            </div>`;
        }).join('');

        const applyRows = applicable.map((n) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;margin-bottom:6px;">
            <span style="color:var(--text-dim);">我参与的一场（${esc((n.lastPlayers || []).map((id) => nameOf(id)).join(' vs '))}）</span>
            <button class="btn btn-ghost btn-sm" data-rm-apply="${esc(n.lastMatchId)}">申请重赛</button>
          </div>`).join('');

        card.innerHTML = `
          <div class="section-title" style="margin-bottom:10px;">重赛申请${list.length ? `（${list.length}）` : ''}</div>
          ${pending.length ? `<div style="font-size:12px;color:var(--gold-light);margin-bottom:8px;">有 ${pending.length} 条待裁决</div>` : ''}
          ${applyRows}
          ${rows || '<div style="color:var(--text-dim);font-size:13px;">暂无重赛申请。对局结束后，本场选手可在此申请重赛。</div>'}`;

        card.querySelectorAll('button[data-rm]').forEach((b) => {
          b.addEventListener('click', async () => {
            const act = b.getAttribute('data-rmact');
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const note = await askInput({
              title: act === 'approve' ? '批准重赛' : '驳回重赛',
              label: act === 'approve' ? '批准说明（可留空）' : '驳回理由（可留空）',
              multiline: true,
            });
            if (note === null) return; // 用户取消
            post(`/api/tournaments/${encodeURIComponent(T.id)}/rematch/${encodeURIComponent(b.getAttribute('data-rm'))}`,
              { decision: act, note },
              act === 'approve' ? '已批准重赛，该场将重打' : '已驳回重赛申请');
          });
        });
        card.querySelectorAll('button[data-rm-apply]').forEach((b) => {
          b.addEventListener('click', async () => {
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const reason = await askInput({ title: '申请重赛', label: '申请理由', multiline: true });
            if (reason === null) return;
            // `name` 传自己的名字，方便日志与列表显示（服务端只信 `x-account-token` 里的 id）
            post(`/api/tournaments/${encodeURIComponent(T.id)}/rematch`,
              { matchId: b.getAttribute('data-rm-apply'), reason, name: nameOf(myPlayerId) },
              '重赛申请已提交，等待主办人裁决');
          });
        });
      }

      // ==================================================================
      // 变更记录（最近 50 条，服务端已截断）
      // ==================================================================
      function renderLogs() {
        const logs = (T.logs || []).slice().reverse(); // 最新在上
        const rows = logs.map((l) => {
          const who = l.byName ? `${esc(l.byName)}` : (l.byRole === 'system' ? '系统' : '—');
          const roleTag = { admin: '管理员', owner: '主办人', player: '选手', system: '系统' }[l.byRole] || '';
          return `<div style="font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
              <span style="color:var(--text-dim);">${fmtTime(l.at)}</span>
              · <span style="color:var(--gold-light);">${LOG_ACTION[l.action] || esc(l.action || '')}</span>
              · ${who}${roleTag ? `（${roleTag}）` : ''}
            </div>`;
        }).join('');

        // 管理员编辑历史（T6/需求 11）：**只有管理员能拿到这个字段**
        // （HTTP 出口按是否管理员决定下发，见 src/http/routes/tournaments.js）
        const edits = (T.adminEditLog || []).slice().reverse();
        const editRows = edits.map((e) => `
          <div style="font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-dim);">${fmtTime(e.at)}</span>
            · <span style="color:var(--red-light);">管理员编辑 ${esc(e.field)}</span>
            · ${esc(String(e.from == null ? '—' : e.from))} → ${esc(String(e.to == null ? '—' : e.to))}
            ${e.note ? ` · ${esc(e.note)}` : ''}
          </div>`).join('');

        el('tnLogs').innerHTML = `
          <div class="section-title" style="margin-bottom:12px;">变更记录${logs.length ? `（最近 ${logs.length} 条）` : ''}</div>
          ${rows || '<div style="color:var(--text-dim);font-size:13px;">暂无记录。</div>'}
          ${edits.length ? `
            <div class="section-title" style="margin:18px 0 12px;font-size:14px;color:var(--red-light);">管理员编辑历史（赛后改动留痕）</div>
            ${editRows}` : ''}`;
      }

      // ==================================================================
      // 事件
      // ==================================================================
      this._teardown.push(api.on('tournament_joined', (d) => {
        if (d && d.pending) toast('报名已提交，等待主办人批准');
        else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
        else toast('报名成功');
        load(); // 重新拉取（含新的 caps 与名单）
      }));
      this._teardown.push(api.on('error', (d) => {
        if (d && d.message) toast(d.message);
      }));
      // ⚠️ 2026-10-02 体验修复：详情页此前不监听 game_start → 「轮到你了」页面不跳对局
      //（列表页有该监听 + 5 秒轮询，详情页没有，导致玩家最可能停留的页面反而"死屏"）。
      this._teardown.push(api.on('game_start', (d) => {
        if (d && d.roomId && !location.search.includes('room')) {
          // SPA：整页跳转改路由（原为 location.href 跳转 play.html?room=…）
          global.Router.navigate(`play.html?room=${encodeURIComponent(d.roomId)}`);
        }
      }));

      // 名单/待办队列里的操作按钮（2026-09-23，审查项 13f）：
      // 从"两处各自 querySelectorAll + 逐个绑定"改为**一处注册 + 整页委托**。
      // ⚠️ 这几个动作名（approve / reject / kick / void / champion）起得比较泛，只在本页使用。
      // SPA：util.js 的委托注册表是整页一份的全局表（没有 off），故在**模块级只注册一次**、
      // 逻辑经 `View._handlers` 命名空间转发——unmount 清空 `_handlers` 后旧句柄即不可达。
      this._handlers = { rosterAction };

      load();
    },

    unmount() {
      this._mounted = false;
      this._handlers = {}; // 旧句柄失效：data-act 委托经 _handlers 转发，清空后调不到
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  // 「批准 / 拒绝 / 踢出 / 取消成绩 / 设冠军」按钮：data-act 委托（2026-09-23，审查项 13f）。
  // util.js 的委托注册表是**整页一份的全局表**（没有 off），故在模块级注册一次、
  // 逻辑经 `View._handlers` 命名空间转发——unmount 清空 `_handlers` 后旧句柄即不可达。
  ['approve', 'reject', 'kick', 'void', 'champion'].forEach((act) => {
    UI.onAction(act, (btn) => {
      const h = View._handlers && View._handlers.rosterAction;
      if (h) h(act, btn.getAttribute('data-pid'));
    });
  });

  global.Views.tournament = View;
})(window);

/* ==== js/profile.js ==== */
/**
 * profile.js — 个人页 View：账号注册/登录、改名、评级与战绩统计、ELO 走势、最近对局
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 profile.html 的主体，逐字保留）
 *   mount(container, params)→ 原 IIFE 主体逻辑：账号/头像/资料/战绩/道具/装扮，句柄记进 this._teardown
 *   unmount()               → 统一清理（含子模块 Tabs / RecordsConsole 的 destroy），切页零泄漏
 *
 * 范式（照 home.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - 整页跳转改 `Router.navigate`（本页自身无 location.href 跳转；棋谱/赛事链接走
 *     `data-href` 委托与 `<a href>` 拦截，均被 router 接管）。
 *   - 注册 / 登录 / 登出的 `location.reload()`（2026-10-09）改为「api.reconnectAs +
 *     Router.reload」——与 boot.js 身份变更同款：以新身份重连 WS 后重挂当前 View，
 *     不整页刷新（干净路径下整页 reload 会 404，且 BGM/文档被销毁）。
 *   - 所有元素监听 / WS 订阅 / 试听音频，统一在 unmount 清理。
 *
 * 子模块（2026-10-09：去掉「加载即自启」，由本页 mount/unmount 调用/驱动）：
 *   - tabs.js            → window.ProfileParts.Tabs：mount({ initial, hooks }) / destroy()
 *   - records-console.js → window.ProfileParts.RecordsConsole：mount()（棋谱标签懒挂载）/ destroy()
 *   初始标签支持 params.tab（router 已把 history.html 与 #records 映射为 tab=records），
 *   回退读 location.hash / location.search。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '个人 · TDShogi',

    render() {
      // —— 原 profile.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- Tab 切换（tabs.js）：概览 / 棋谱 / 装扮 -->
    <nav class="tabs" data-tabs aria-label="个人页分区">
      <button class="tab active" data-tab="overview" type="button">概览</button>
      <button class="tab" data-tab="records" type="button">棋谱</button>
      <button class="tab" data-tab="items" type="button">装扮</button>
    </nav>

    <!-- ============ Tab：概览 ============ -->
    <div class="tab-panel active" data-tab="overview">
      <!-- 账号区：未登录 → 注册/登录表单；已登录 → 账号信息 + 登出 -->
      <div class="card" id="accountCard" style="padding:24px;margin-bottom:24px;">
        <div class="section-title" style="font-size:18px;">🔐 账号</div>

        <!-- 未登录 -->
        <div id="accountNotLogged">
          <div style="font-size:13px;color:var(--text-dim);margin-bottom:14px;">
            当前为游客身份。注册账号后，你的对局、积分与棋谱将绑定到账号，可在任意浏览器登录继续。注册会保留当前游客的全部数据。
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;" class="account-grid">
            <!-- 注册 -->
            <div>
              <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--gold-light);">注册新账号</div>
              <input class="input" id="regUsername" placeholder="用户名（2-16 字符）" style="margin-bottom:8px;">
              <input type="password" class="input" id="regPassword" placeholder="密码（至少 8 位）" style="margin-bottom:8px;">
              <input type="password" class="input" id="regPassword2" placeholder="确认密码" style="margin-bottom:8px;">
              <button class="btn btn-primary" id="btnRegister" style="width:100%;">注册并保留游客数据</button>
            </div>
            <!-- 登录 -->
            <div>
              <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--gold-light);">已有账号登录</div>
              <input class="input" id="loginUsername" placeholder="用户名" style="margin-bottom:8px;">
              <input type="password" class="input" id="loginPassword" placeholder="密码" style="margin-bottom:8px;">
              <button class="btn btn-ghost" id="btnLogin" style="width:100%;">登录</button>
            </div>
          </div>
        </div>

        <!-- 已登录 -->
        <div id="accountLogged" style="display:none;">
          <div style="display:flex;align-items:center;gap:14px;">
            <div class="profile-avatar" id="accountAvatar" style="width:56px;height:56px;font-size:24px;">棋</div>
            <div style="flex:1;">
              <div style="font-size:20px;font-weight:800;font-family:var(--font-serif);" id="accountName">—</div>
              <div style="color:var(--text-dim);font-size:12px;margin-top:2px;">已登录账号 · ID: <span id="accountId"></span></div>
            </div>
            <button class="btn btn-ghost btn-sm" id="btnLogout">退出登录</button>
          </div>
        </div>
      </div>

      <!-- 身份卡 -->
      <div class="card profile-head">
        <div class="profile-avatar" id="avatar" title="点击更换头像" style="cursor:pointer;">棋</div>
        <div style="flex:1;">
          <div style="font-size:24px;font-weight:800;font-family:var(--font-serif);" id="pName">无名棋士</div>
          <div style="color:var(--text-dim);font-size:13px;margin-top:4px;" id="pRoleLabel">游客账号 · ID: <span id="pId"></span></div>
          <div style="display:flex;gap:8px;margin-top:12px;" id="renameRow">
            <input class="input" id="renameInput" placeholder="修改名字（12 字内）" style="max-width:220px;">
            <button class="btn btn-ghost btn-sm" id="btnRename">改名</button>
          </div>
          <!-- ⚠️ 2026-10-02 体验修复：账号登录后**不把改名区藏成空白**——给一句明确说明。 -->
          <div id="accountNameNote" style="display:none;margin-top:12px;font-size:12px;color:var(--text-dim);">
            账号名不可更改（与注册用户名一致）；如需更换请联系管理员。
          </div>
          <!-- 头像（2026-09-20）：单独一行，游客/账号都能换 -->
          <div style="margin-top:12px;">
            <button class="btn btn-ghost btn-sm" id="btnPickAvatar">🎨 换头像</button>
            <div id="avatarPicker" style="display:none;margin-top:10px;">
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">选一个头像（点击即生效）</div>
              <div id="avatarOptions" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
            </div>
          </div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:40px;font-weight:900;color:var(--gold-light);font-family:var(--font-serif);" id="pRating">1500</div>
          <div style="color:var(--text-dim);font-size:13px;">ELO 积分</div>
          <div style="margin-top:6px;font-size:14px;font-weight:700;color:var(--gold-light);" id="pLevel">Lv.0</div>
          <div style="color:var(--text-dim);font-size:12px;" id="pExp">经验 0</div>
        </div>
      </div>

      <!-- 我的资料（仅登录账号；PLAN §F） -->
      <div class="card" id="myProfileCard" style="padding:22px;margin-bottom:28px;display:none;">
        <div class="section-title">📋 我的资料</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;" class="profile-edit-grid">
          <div>
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">
              手机号 <span style="color:var(--gold-light);">（不公开显示，仅管理员可见）</span>
            </div>
            <input class="input" id="editPhone" placeholder="11 位手机号，留空清除" maxlength="11">
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">棋风（公开显示）</div>
            <select class="select" id="editStyle" style="width:100%;">
              <option>不设定</option>
              <option>居飞车·急战</option>
              <option>居飞车·持久战</option>
              <option>振飞车</option>
              <option>力战型</option>
              <option>奇袭型</option>
              <option>接受型</option>
            </select>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:12px;">
          注册日期：<span id="createdAtLabel" style="color:var(--text);">—</span>
        </div>
        <button class="btn btn-primary" id="btnSaveProfile" style="margin-top:14px;">保存资料</button>
      </div>

      <!-- 数据统计 -->
      <div class="stat-grid">
        <div class="card stat-card"><div class="num" id="sGames">0</div><div class="label">对局数</div></div>
        <div class="card stat-card"><div class="num" id="sWins">0</div><div class="label">胜</div></div>
        <div class="card stat-card"><div class="num" id="sLosses">0</div><div class="label">负</div></div>
        <div class="card stat-card"><div class="num" id="sDraws">0</div><div class="label">平</div></div>
        <div class="card stat-card"><div class="num" id="sPoints">0</div><div class="label" title="每完成一局 +1 的累计值，与 ELO 评分相互独立">累计积分</div></div>
      </div>

      <!-- 赛事荣誉（2026-09-15 用户要求）：只统计**已结束**的赛事 -->
      <div class="card" id="honorsCard" style="padding:22px;margin-bottom:28px;">
        <div class="section-title">🏆 赛事荣誉</div>
        <div id="honorsStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:10px;"></div>
        <div id="honorsList" style="margin-top:6px;"></div>
      </div>

      <!-- ELO 走势 -->
      <div class="card" style="padding:22px;margin-bottom:28px;">
        <div class="section-title">ELO 走势</div>
        <div style="height:120px;display:flex;align-items:flex-end;gap:3px;" id="eloChart"></div>
      </div>
    </div>

    <!-- ============ Tab：棋谱（原独立棋谱页，已并入） ============ -->
    <div class="tab-panel" data-tab="records">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
        <div class="section-title" style="font-size:20px;margin:0;">对局记录与检索</div>
        <a class="btn btn-ghost btn-sm" href="gallery.html" title="浏览公开棋谱">🌐 棋谱广场 →</a>
      </div>

      <!-- 最近对局（概览式预览；完整检索在下方控制台） -->
      <div class="card pad-card" style="margin-bottom:24px;">
        <div class="section-title" style="font-size:18px;">最近对局</div>
        <div id="recentRecords"></div>
      </div>

      <!-- 检索台（records-console.js） -->
      <div class="card pad-card">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>全部棋谱</span>
          <span style="font-size:12px;color:var(--text-dim);font-weight:400;" id="recordCount"></span>
        </div>
        <!-- 检索栏 -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;" class="search-grid">
          <input class="input" id="searchQuery" placeholder="关键词（选手名）" style="padding:7px 10px;font-size:13px;">
          <input class="input" id="searchOpening" placeholder="开局（如 7g7f,3c3d）" style="padding:7px 10px;font-size:13px;">
          <input class="input" id="searchMoves" placeholder="手数范围（如 20-80）" style="padding:7px 10px;font-size:13px;">
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
          <select class="select" id="searchResult" style="padding:7px 10px;font-size:13px;">
            <option value="">全部结果</option>
            <option value="b">先手胜</option>
            <option value="w">后手胜</option>
            <option value="-">和棋</option>
          </select>
          <button class="btn btn-primary btn-sm" id="btnSearch">检索</button>
          <button class="btn btn-ghost btn-sm" id="btnResetSearch">重置</button>
        </div>
        <div id="recordList" style="max-height:60vh;overflow-y:auto;"></div>
        <!-- 分页条：列表最多 20 条/页 -->
        <div id="recordPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:10px;">
          点击任意棋谱进入「复盘器」，可前进/后退、加书签、写评论、保存变着，并导出 KIF/CSA。
        </div>
      </div>
    </div>

    <!-- ============ Tab：装扮 / 商店 ============ -->
    <div class="tab-panel" data-tab="items">
      <!-- ⚠️ 2026-10-07 商店现代网游化：装备栏 + 分类商店 + 兑换。
           仅登录账号可用：游客只显示引导、不发请求。 -->
      <div class="card shop-shell" id="itemsCard" style="padding:0;overflow:hidden;">

        <!-- 未登录：引导（不发任何请求） -->
        <div id="itemsGuest" style="display:none;padding:28px 24px;font-size:13px;color:var(--text-dim);line-height:1.9;">
          登录后可用道具 / 装扮：头像、BGM、对战立绘、棋子与棋盘皮肤。
          请在上方「🔐 账号」处注册或登录（游客无道具）。
        </div>

        <!-- 已登录区 -->
        <div id="itemsBody" style="display:none;">
          <!-- 顶栏：标题 + 金币 + 兑换 -->
          <div class="shop-top">
            <div>
              <div class="shop-title">装扮商店</div>
              <div class="shop-sub">装备会实时同步到对局与个人名片</div>
            </div>
            <div class="shop-top-right">
              <div class="shop-coin" title="金币">
                <span class="shop-coin-icon">💰</span>
                <span id="itemsCoin">0</span>
              </div>
              <div class="shop-redeem">
                <input class="input" id="itemsCode" placeholder="兑换码" autocomplete="off">
                <button class="btn btn-primary btn-sm" id="btnRedeem" type="button">兑换</button>
              </div>
            </div>
          </div>

          <!-- 当前装备（loadout） -->
          <div class="shop-section">
            <div class="shop-section-head">
              <span>当前装备</span>
              <span class="shop-section-hint">点击槽位可快速卸下</span>
            </div>
            <div id="itemsSlots" class="shop-slots"></div>
          </div>

          <!-- 分类页签 + 搜索 -->
          <div class="shop-section">
            <div class="shop-toolbar">
              <div class="shop-tabs" id="itemsCatTabs">
                <button class="shop-tab active" data-cat="all" type="button">全部</button>
                <button class="shop-tab" data-cat="avatar" type="button">头像</button>
                <button class="shop-tab" data-cat="bgm" type="button">BGM</button>
                <button class="shop-tab" data-cat="sprite" type="button">立绘</button>
                <button class="shop-tab" data-cat="pieces" type="button">棋子</button>
                <button class="shop-tab" data-cat="board" type="button">棋盘</button>
                <button class="shop-tab" data-cat="byoyomi" type="button">读秒音</button>
              </div>
              <input class="input shop-search" id="itemsSearch" placeholder="搜索商品…" autocomplete="off">
            </div>
            <div class="shop-grid" id="itemsShopGrid"></div>
          </div>

          <!-- 可见提示位（加载失败 / 401 / 操作结果，绝不静默） -->
          <div id="itemsMsg" class="shop-msg"></div>
        </div>
      </div>
    </div>
  </main>
`;
    },

    mount(container, params) {
      this._teardown = [];
      const td = this._teardown;
      params = params || {};
      let guest = global.NAV.getGuest();  // 铁律1：替代原 NAV.renderNav('profile')（导航由外壳渲染）
      const api = global.API;             // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      /** 翻译（PLAN §Z5）：`i18n.js` 万一没加载就原样显示中文 */
      const tr = (s, v) => (global.I18N ? global.I18N.t(s, v) : s);
      const I18N = global.I18N;

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        td.push(() => el.removeEventListener(ev, fn));
      };
      // WS 订阅（api.on 返回退订函数 → 直接记进 teardown，unmount 一并退订）
      const sub = (type, fn) => { td.push(api.on(type, fn)); };

      // ⚠️ 2026-10-02 体验修复：消费「跨刷新保留」的提示——注册 / 登录 / 登出的成功提示
      // 在 reload 后展示（此前先 toast 再 reload，消息被刷新吞掉）。约定：`MIGFAIL:` 前缀
      // 用弹窗展示长文案（游客资料迁移失败详情），其余用 toast。
      // SPA：`Router.reload()` 重挂后同样经 mount 走这里，机制不变。
      (function consumeFlash() {
        let msg = null;
        try { msg = window.sessionStorage.getItem('tdshogi_flash'); } catch (_) {}
        if (!msg) return;
        try { window.sessionStorage.removeItem('tdshogi_flash'); } catch (_) {}
        if (msg.indexOf('MIGFAIL:') === 0) UI.alert('账号已创建，但游客资料未迁移', msg.slice(8));
        else toast(msg);
      })();

      // ==================================================================
      // 账号：会话令牌检测（令牌以 '.' 分隔，游客 id 为 24 hex）
      // ==================================================================
      const SESSION_KEY = 'tdshogi_session_token';
      const isLoggedIn = (id) => typeof id === 'string' && id.includes('.');
      const sessionToken = () => isLoggedIn(guest.id) ? guest.id : localStorage.getItem(SESSION_KEY);

      // ==================================================================
      // 查看他人（2026-09-20 用户要求："其他人查看的个人页界面没有入口"）
      //
      // `profile.html?player=<id>` → **只读视图**：隐藏注册/登录/改名/头像/资料编辑
      // （这些只对本人有意义），等级/战绩/荣誉/走势/最近对局照常显示。
      // 入口由「玩家名字的去重卡片」（hovercard）提供 —— 全站凡是有 `data-player-id`
      // 的地方都能点到，不必给每个页面各加一个入口。
      //
      // ⚠️ 这段必须放在 `isLoggedIn` 声明**之后**：`const` 有 TDZ，写在前面会直接抛
      // "Cannot access before initialization"。
      //
      // SPA：`player` 优先取路由 params（router 把 query 灌进 params），
      // location.search 作回退（旧书签 / 手动输入）。
      // ==================================================================
      const viewPlayerId = params.player || new URLSearchParams(location.search).get('player');
      const myId = isLoggedIn(guest.id) ? guest.id.split('.')[0] : guest.id;
      const isSelf = !viewPlayerId || viewPlayerId === myId || viewPlayerId === guest.id;
      const viewedId = isSelf ? myId : viewPlayerId;

      // 已登录状态渲染（gate 只看当前页身份 guest.id 是否为账号令牌——
      // 不读共享存储里的旧令牌，避免「本标签是游客却显示账号资料卡」）
      function renderAccountUI() {
        const logged = isLoggedIn(guest.id);
        $('accountNotLogged').style.display = logged ? 'none' : 'block';
        $('accountLogged').style.display = logged ? 'flex' : 'none';
        $('myProfileCard').style.display = logged ? 'block' : 'none';
        // ⚠️ 2026-10-02 体验修复：账号登录后**不再把改名区藏成空白**（这是本次要修的"找不到入口"）。
        // 查证服务端（src/auth.js `rename` / src/protocol/handlers/social.js `_hRename`）：WS `rename`
        // 确实支持改**会话显示名**，但它改的是会话文件；而账号每次登录都有
        // `src/accounts.js` 的 `login → auth.markAccountSession(id, username)` 用**用户名重置显示名**，
        // 因此账号的显示名恒等于登录用户名，改名对账号不可持久 → 属于「账号名不可更改」。
        // 于是：隐藏输入行，改为显示一句明确说明（`#accountNameNote`），不留空白让用户找不到。
        const renameRow = $('renameRow');
        if (renameRow) renameRow.style.display = logged ? 'none' : 'flex';
        const nameNote = $('accountNameNote');
        if (nameNote) nameNote.style.display = logged ? 'block' : 'none';
        if (logged) {
          $('accountName').textContent = guest.name;
          $('accountId').textContent = guest.id.split('.')[0];
          renderAvatars(); // 头像（2026-09-20）：统一走这一处，别再直接写 textContent
          $('pRoleLabel').innerHTML = '正式账号 · ID: <span id="pId"></span>';
          $('pId').textContent = guest.id.split('.')[0];
          loadMyProfile();
        }
      }

      // ---- 我的资料（PLAN §F：手机号私密/棋风/注册日期） ----
      async function loadMyProfile() {
        try {
          const data = await global.ApiUtils.get(`/api/account/profile?token=${encodeURIComponent(sessionToken())}`);
          const a = data.account;
          if (!a) return;
          if (!$('editPhone')) return; // SPA：已切页，回调回来时 DOM 已销毁 → 放弃写入
          $('editPhone').value = a.profile.phone || '';
          $('editStyle').value = a.profile.style || '不设定';
          $('createdAtLabel').textContent = I18N.fmtDate(a.createdAt);
          // 身份卡补充棋风与注册日期
          const role = $('pRoleLabel');
          if (role && !$('profileMeta')) {
            const meta = document.createElement('div');
            meta.id = 'profileMeta';
            meta.style.cssText = 'font-size:12px;color:var(--text-dim);margin-top:6px;';
            role.parentNode.insertBefore(meta, role.nextSibling);
          }
          const meta = $('profileMeta');
          if (meta) {
            meta.innerHTML = `⚔️ 棋风：<span style="color:var(--gold-light);">${esc(a.profile.style || '不设定')}</span>` +
              ` · 📅 注册于 ${I18N.fmtDate(a.createdAt)}`;
          }
        } catch (_) { /* 令牌失效等情况静默 */ }
      }

      on($('btnSaveProfile'), 'click', async () => {
        const phone = $('editPhone').value.trim();
        const style = $('editStyle').value;
        try {
          const res = await global.ApiUtils.post('/api/account/profile', {
            token: sessionToken(),
            phone,
            style,
          });
          if (res.ok) {
            toast('资料已保存');
            loadMyProfile();
          } else {
            // ⚠️ 2026-10-02 体验修复（提示风格统一）：保存失败改用 `UI.alert`
            // （与注册 / 登录失败同一种方式），别再用一闪而过的 toast。
            UI.alert('保存失败', res.error || '保存失败，请重试');
          }
        } catch (e) {
          UI.alert('保存失败', '保存失败，请重试');
        }
      });

      function applySession(token, name, flash) {
        localStorage.setItem(SESSION_KEY, token);
        guest = { id: token, name };
        global.NAV.saveGuest(guest);
        renderAccountUI();
        // ⚠️ 2026-10-02 体验修复：成功提示改为 reload 后展示（此前先 toast 再 reload，
        // 消息被刷新立刻吞掉，用户以为没成功）。用 sessionStorage 跨越重挂传递。
        if (flash) window.sessionStorage.setItem('tdshogi_flash', flash);
        // 用令牌重连 WS，使对局/评级绑定账号。
        // SPA（2026-10-09）：不再 `location.reload()` 整页刷新，改与 boot.js 身份变更同款——
        // 「关旧连接 → 以新身份重连 → 重挂当前 View」；flash 提示由重挂后的 mount 展示。
        if (api.reconnectAs) api.reconnectAs(guest.id);
        if (global.NAV.refreshBadge) global.NAV.refreshBadge();
        global.Router.reload();
      }

      // ---- 注册 ----
      // 失败原因用 `UI.alert` 弹窗展示（toast 2.5s 就没，用户读不到「密码至少 8 位」这类文案）
      on($('btnRegister'), 'click', async () => {
        const username = $('regUsername').value.trim();
        const password = $('regPassword').value;
        const password2 = $('regPassword2').value;
        if (!username || !password) return UI.alert('注册失败', '请填写用户名和密码');
        if (password !== password2) return UI.alert('注册失败', '两次输入的密码不一致');
        try {
          const res = await global.ApiUtils.post('/api/register', {
            username, password,
            guestId: isLoggedIn(guest.id) ? null : guest.id, // 游客升级：迁移数据
            // B2 迁移凭据：携带本机游客持有证明；服务端校验通过才迁移，防止他人拿公开 id 劫持数据
            migrationKey: isLoggedIn(guest.id) ? null : (guest.key || null),
          });
          if (res.ok) {
            const triedMigrate = !isLoggedIn(guest.id) && !!guest.id;
            if (triedMigrate && res.migrated === false) {
              applySession(res.token, res.account.username,
                'MIGFAIL:本次注册未能把你当前的游客资料（ELO / 战绩 / 棋谱）迁移到新账号。\n'
                + '常见原因：本机游客身份未与服务器完成绑定（例如刚清过缓存）。\n'
                + '可退出后用原浏览器重新进入再试。');
            } else {
              applySession(res.token, res.account.username, `注册成功，欢迎 ${res.account.username}！`);
            }
          } else {
            UI.alert('注册失败', res.error || '未知原因，请稍后再试');
          }
        } catch (e) {
          // ApiUtils.post 失败时抛出的 message 即服务端 `{error}`（如「用户名已被占用」）
          UI.alert('注册失败', (e && e.message) || '请稍后再试');
        }
      });

      // ---- 登录 ----
      on($('btnLogin'), 'click', async () => {
        const username = $('loginUsername').value.trim();
        const password = $('loginPassword').value;
        if (!username || !password) return UI.alert('登录失败', '请填写用户名和密码');
        try {
          const res = await global.ApiUtils.post('/api/login', { username, password });
          if (res.ok) {
            applySession(res.token, res.account.username, `欢迎回来，${res.account.username}！`);
          } else {
            UI.alert('登录失败', res.error || '未知原因，请稍后再试');
          }
        } catch (e) {
          UI.alert('登录失败', (e && e.message) || '请稍后再试');
        }
      });

      // ---- 登出 ----
      // ⚠️ 2026-10-02 体验修复（登出语义 + 可见提示，本次的确认项）：
      // 1) **身份切换必须彻底**：先清令牌，再**重建一个全新的游客身份**（新 id + 新名字）并写回
      //    localStorage —— 否则残留的账号令牌会让"退出"变成"还是账号"。
      // 2) **一定要有可见提示**：重挂会把 toast 冲掉，所以用 sessionStorage 的 flash
      //    机制（与注册 / 登录同款）跨重挂传递，由 `consumeFlash()` 展示。
      // 3) 其它标签页由 nav.js 的 `storage` 监听同步（各自提示并重载）。
      on($('btnLogout'), 'click', () => {
        localStorage.removeItem(SESSION_KEY);
        // 重置为新的游客身份（**新 id** 才会让 nav.js 的 storage 同步判定为"身份变更"）
        const fresh = { id: global.NAV.genId(), name: global.NAV.randomName() };
        global.NAV.saveGuest(fresh);
        // ⚠️ 登出提示同样跨重挂保留（否则「已退出登录」永远看不到）；文案点明已切回游客身份
        window.sessionStorage.setItem('tdshogi_flash', '已退出登录，已切换为游客身份');
        // SPA：同 applySession——以新游客身份重连 WS 后重挂当前 View，不整页 reload
        guest = fresh;
        if (api.reconnectAs) api.reconnectAs(fresh.id);
        if (global.NAV.refreshBadge) global.NAV.refreshBadge();
        global.Router.reload();
      });

      $('pName').textContent = guest.name;
      $('pId').textContent = isLoggedIn(guest.id) ? guest.id.split('.')[0] : guest.id;

      // ==================================================================
      // 头像（2026-09-20）
      //
      // ⚠️ 候选列表**由服务端下发**（`hello.avatars`，源头是 `src/auth.js` 的 `AVATARS`），
      // 前端不另抄一份 —— 抄了就会出现"服务端认、前端画不出"或反过来。
      //
      // ⚠️ `myAvatar` 必须**在 `renderAccountUI()` 之前**声明：后者会调 `renderAvatars()`，
      // 而 `let` 有 TDZ——先调用就会抛 "Cannot access before initialization"。
      // ==================================================================
      let myAvatar = null;

      /** 把头像写进两个头像位（账号卡 + 身份卡）；支持字形与图片 URL */
      function paintAvatar(avatarOrGlyph) {
        for (const id of ['avatar', 'accountAvatar']) {
          const el = $(id);
          if (!el) continue;
          if (UI && UI.setAvatarContent) UI.setAvatarContent(el, avatarOrGlyph, guest.name);
          else el.textContent = avatarOrGlyph;
        }
      }

      /**
       * 把「**我**的头像」刷到界面上。
       *
       * ⚠️ 看别人的个人页时**必须直接返回**（2026-09-20 用户报的 bug）：
       * 这两个头像位在只读视图里显示的是**被查看者**，用我的字形去写就等于"把对方头像改了"。
       * 服务端其实改的是我自己（`set_avatar` 只认连接身份，没有越权），
       * 但界面上一眼看去就是篡改了别人 —— 这比真漏洞更让人困惑。
       * 被查看者的头像由 `loadProfile()` 用接口下发的 `avatar` 单独画。
       */
      function renderAvatars() {
        if (!isSelf) return;
        paintAvatar(myAvatar);
      }

      function renderAvatarOptions() {
        const box = $('avatarOptions');
        if (!box) return;
        const list = api.avatars || [];
        if (!list.length) return; // 白名单还没到（hello 未回）：宁可为空，也别画一份猜的
        box.innerHTML = list.map((a) => {
          const pickOn = a === myAvatar ? ' avatar-pick-on' : '';
          const isImg = typeof a === 'string' && a.charAt(0) === '/';
          const face = isImg
            ? `<img src="${esc(a)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
            : esc(a);
          return `<button type="button" class="avatar-pick${pickOn}" data-avatar="${esc(a)}">${face}</button>`;
        }).join('');
      }

      function togglePicker() {
        const p = $('avatarPicker');
        if (!p) return;
        p.style.display = p.style.display === 'none' ? '' : 'none';
      }

      on($('btnPickAvatar'), 'click', togglePicker);
      // ⚠️ 身份卡上的大头像**也**带着换头像入口，只读视图必须拦住：
      // `setupViewMode()` 藏的是按钮与选择器本身，而点这个头像能把选择器**重新打开** ——
      // 这正是用户看到"我能改别人头像"的那个入口（2026-09-20 修）。
      on($('avatar'), 'click', () => { if (isSelf) togglePicker(); });
      // ⚠️ 2026-10-02 体验修复（头像选择器确认）：把选中态挪到刚点的那个，用户点完立刻看到反馈；
      // 服务端确认（`avatar_updated`）后再用真实值重绘一次，避免乐观态与实际不符。
      function markPickedAvatar(avatar) {
        const box = $('avatarOptions');
        if (!box) return;
        box.querySelectorAll('.avatar-pick').forEach((btn) => {
          btn.classList.toggle('avatar-pick-on', btn.getAttribute('data-avatar') === avatar);
        });
      }

      on($('avatarOptions'), 'click', (e) => {
        if (!isSelf) return; // 只读视图：双保险，连消息都不发（真正改的其实是我自己）
        const b = e.target.closest('.avatar-pick');
        if (!b) return;
        const pick = b.getAttribute('data-avatar');
        // ⚠️ 2026-10-02 体验修复（"点了没反应"的错觉）：三步都要有反馈——
        // 1) 立刻把选中态挪到这一格（`avatar-pick-on`），先给视觉确认；
        // 2) WS 还没连上时 `api.send` 只会进队列、永远等不到回执 → 明确告知，别静默丢弃；
        // 3) 成功由 `avatar_updated` 收尾（重绘 + toast 提示），失败由 `error` 回滚选中态。
        markPickedAvatar(pick);
        if (!api.connected) return UI.alert('操作失败', '连接尚未就绪，请稍后再试');
        api.send({ type: 'set_avatar', data: { avatar: pick } });
      });
      sub('hello', (d) => {
        if (!d) return;
        if (d.avatar) myAvatar = d.avatar;
        renderAvatars();
        renderAvatarOptions();
      });
      sub('avatar_updated', (d) => {
        if (!d || !d.avatar) return;
        myAvatar = d.avatar;
        renderAvatars();
        renderAvatarOptions(); // 用服务端确认过的值重绘，消除乐观选中态的偏差
        if (global.NAV && global.NAV.updateAvatar) global.NAV.updateAvatar(d.avatar);
        toast('头像已更新'); // 明确成功提示（词典已有该词条）
      });

      // 放在头像块之后：`renderAccountUI()` 会经 `renderAvatars()` 读 `myAvatar`
      renderAccountUI();

      // 改名（游客可见；账号身份下这一行会被 `renderAccountUI` 换成"账号名不可更改"的说明）
      on($('btnRename'), 'click', () => {
        const name = $('renameInput').value.trim();
        // ⚠️ 2026-10-02 体验修复（提示风格统一）：校验失败与注册 / 登录失败同款走 `UI.alert`
        // （可读、可关闭），不再用 2.5 秒就消失的 toast。
        if (!name) return UI.alert('改名', '请输入名字');
        if (!api.connected) return UI.alert('改名', '连接尚未就绪，请稍后再试');
        api.send({ type: 'rename', data: { name } });
      });
      sub('renamed', (data) => {
        guest.name = data.name;
        global.NAV.saveGuest(guest);
        $('pName').textContent = data.name;
        renderAvatars(); // 名字变了，兜底字形（无头像时用名字首字）也要跟着变
        toast('改名成功'); // 成功类提示保持轻量 toast（与全站"成功用 toast"一致）
      });
      sub('error', (data) => {
        if (!data || !data.message) return;
        // ⚠️ 2026-10-02 体验修复（提示风格统一）：本页 WS 错误只来自改名 / 换头像这类
        // **用户操作失败**，统一走 `UI.alert`（与注册 / 登录失败同一种提示方式）。
        // 顺带重绘头像选项，回滚刚才可能留下的乐观选中态。
        renderAvatarOptions();
        UI.alert('操作失败', data.message);
      });

      // 加载个人数据（账号令牌 → 解析账号 id 查询）
      async function loadProfile() {
        try {
          const data = await global.ApiUtils.get(`/api/profile?player=${encodeURIComponent(viewedId)}`);
          const p = data.profile;
          if (!$('pRating')) return; // SPA：已切页，回调回来时 DOM 已销毁 → 放弃写入
          $('pRating').textContent = p.rating;
          // 等级系统（PLAN §K7）：显示等级与当前经验，及距下一级的差额
          const lvEl = $('pLevel');
          const expEl = $('pExp');
          if (lvEl) {
            lvEl.textContent = 'Lv.' + (p.level || 0);
            // ⚠️ 2026-10-02 体验修复：等级规则给出说明（此前只显示 Lv.N，用户不知道经验从哪来、怎么升级）
            lvEl.title = '等级由对局累积的经验决定（每局结束获得经验）；升到下一级所需经验约为 2^(等级+1)-2，满级 64。';
          }
          if (expEl) {
            const need = Math.pow(2, Math.min((p.level || 0) + 1, 64) + 1) - 2;
            expEl.textContent = p.level >= 64 ? `满级 · 经验 ${p.exp}` : `经验 ${p.exp} / ${need}`;
          }
          $('sGames').textContent = p.games;
          $('sWins').textContent = p.wins;
          $('sLosses').textContent = p.losses;
          $('sDraws').textContent = p.draws;
          // 积分（F1）：与 ELO 独立的累计值，服务端每完成一局 +1，前端只显示
          const ptsEl = $('sPoints');
          if (ptsEl) ptsEl.textContent = p.points || 0;
          renderEloChart(p.history || []);
          renderRecords(data.records || []);
          renderHonors(data.honors);
          if (!isSelf) {
            // 看别人时，头部显示的必须是被查看者的名字（页面初始渲染的是"我"的名字）
            const name = data.name || '无名棋士';
            // 头像同理：画**他**的字形（服务端下发 `avatar`；没有则按名字稳定派生一个）。
            // ⚠️ 这一步必须在 `renderAvatars()` 之外——后者只负责"我"的头像，且只读视图里直接返回。
            paintAvatar(data.avatar);
            const nameEl = $('pName');
            if (nameEl) nameEl.textContent = name;
            const barName = $('viewedName');
            if (barName) barName.textContent = name;
            const roleEl = $('pRoleLabel');
            if (roleEl) roleEl.textContent = tr('玩家 · ID: {id}', { id: viewedId });
          }
        } catch (e) {
          console.error(e);
        }
      }

      function renderEloChart(history) {
        const el = $('eloChart');
        if (!history.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;align-self:center;width:100%;text-align:center;">完成对局后显示走势</div>';
          return;
        }
        const min = Math.min(...history.map((h) => h.rating));
        const max = Math.max(...history.map((h) => h.rating));
        const range = max - min || 1;
        const maxBar = 100;
        el.innerHTML = history.slice(-30).map((h) => {
          const hgt = 20 + ((h.rating - min) / range) * (maxBar - 20);
          const color = h.rating >= 1500 ? 'var(--gold)' : 'var(--text-dim)';
          return `<div style="flex:1;height:${hgt}%;background:${color};border-radius:3px 3px 0 0;min-width:4px;" title="${h.rating}"></div>`;
        }).join('');
      }

      /**
       * 赛事荣誉（2026-09-15）。
       *
       * ⚠️ 数据由**服务端算好**（`tournaments.honorsOf`），这里只负责画。
       * "什么算荣誉"（名次判定、只统计已结束、并列如何处理）是业务规则——
       * 放前端会与赛事模块各写一套，迟早对不上（同一份逻辑抄两处的老教训）。
       */
      function renderHonors(honors) {
        const statBox = $('honorsStats');
        const listBox = $('honorsList');
        if (!statBox || !listBox) return;

        const s = (honors && honors.stats) || {};
        const items = (honors && honors.items) || [];

        const cells = [
          ['夺冠', s.titles || 0, 'var(--gold-light)'],
          ['亚军', s.runnerUps || 0, ''],
          ['四强', s.top4 || 0, ''],
          ['参赛赛事', s.joined || 0, ''],
          ['夺冠率', `${s.winRate || 0}%`, ''],
        ];
        statBox.innerHTML = cells.map(([label, num, color]) => `
      <div style="text-align:center;padding:10px 6px;border:1px solid var(--border);border-radius:8px;">
        <div style="font-size:20px;font-weight:800;font-family:var(--font-serif);${color ? `color:${color};` : ''}">${esc(String(num))}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">${esc(label)}</div>
      </div>`).join('');

        if (!items.length) {
          // 明细现在**包含所有打完的赛事**，所以"没有明细"只剩一种情况：报了名但还没打完
          listBox.innerHTML = `<div style="color:var(--text-dim);font-size:13px;margin-top:14px;">${
            s.joined ? '已报名赛事，等这届赛程结束后会出现在这里。'
              : '还没有参加过赛事。去「赛事」页报名，或自己办一场吧！'
          }</div>`;
          return;
        }

        const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
        listBox.innerHTML = items.map((it) => `
      <a href="tournament.html?id=${encodeURIComponent(it.tournamentId)}"
         style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--border);text-decoration:none;color:inherit;">
        <span style="display:flex;align-items:center;gap:8px;min-width:0;">
          <span style="font-size:15px;">${medal[it.place] || '·'}</span>
          <span style="font-size:13px;font-weight:700;color:var(--gold-light);">${esc(it.placeLabel)}${
  // 夺冠的条目后面加个冠军表情（2026-09-20 用户要求）——一眼能认出哪几届是冠军
  it.place === 1 ? ' 🏆' : ''}</span>
          <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(it.name)}</span>
        </span>
        <span style="font-size:11px;color:var(--text-dim);white-space:nowrap;">
          ${esc(it.formatLabel || '')} · ${it.playerCount}/${it.size} 人${
  it.manual ? ' · 人工裁定' : ''}${it.endedAt ? ` · ${I18N.fmtDate(it.endedAt)}` : ''}
        </span>
      </a>`).join('');
      }

      function renderRecords(records) {
        const el = $('recentRecords');
        if (!records.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无对局</div>';
          return;
        }
        // 只显示最近 10 局（2026-09-13 用户要求）：这里是**概览式预览**，
        // 完整检索与分页在同一「棋谱」标签下方的控制台（records-console.js）。
        // 这里自己按时间倒序再截取，**不依赖服务端返回顺序**（否则换个排序就悄悄显示成最旧的 10 局）。
        const list = records.slice()
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, 10);
        el.innerHTML = list.map((r) => {
          const names = r.names || ['先手', '後手'];
          // ⚠️ 必须比对**解析后的身份 id**：账号的 `guest.id` 是会话令牌（`<accountId>.<ts>.<sig>`），
          // 而棋谱 `playerIds` 存的是 accountId，用 `guest.id` 比对恒 false → 胜/负着色全错（Bug3）。
          // 用 `viewedId`：本人视图下等于 myId，看他人视图下等于被查看者 id —— 两种情形都正确。
          const mineIsB = r.playerIds && r.playerIds.b === viewedId;
          const result = r.result === 'b' ? '先手胜' : r.result === 'w' ? '后手胜' : (r.resultDetail || '和棋');
          const iWon = mineIsB ? r.result === 'b' : r.result === 'w';
          const cls = iWon ? 'result-win' : 'result-lose';
          return `
        <div class="record-item"${r.id ? ` data-href="review.html?id=${encodeURIComponent(r.id)}"` : ''}>
          <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])} <span style="color:var(--text-dim);font-size:11px;">（我执${mineIsB ? '先' : '后'}手）</span></div>
          <div class="r-result ${cls}">${iWon ? '胜' : (r.result === '-' ? '和' : '负')} · ${esc(result)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${(r.moves || []).length} 手 · ${I18N.fmt(r.createdAt)}</div>
        </div>
      `;
        }).join('');
      }

      // ⚠️ 这里曾**重复声明**了一个 `esc()`（文件上方已有）。函数声明在同一作用域里
      // 会**静默覆盖**（不报错、不警告），两份实现一旦漂移，就只有后者生效——
      // 排查时会看到"改了没反应"。已删除，只保留文件上方那一处。

      /**
       * 只读视图（看别人的个人页）。
       *
       * ⚠️ 只隐藏**只对本人有意义**的东西：账号卡（注册/登录/退出）、资料编辑卡（手机号等）、
       * 改名与换头像入口。**等级/战绩/荣誉/走势/最近对局必须保留** —— 那正是"看别人"想看的。
       * ⚠️ 必须在本页最后一处 `renderAccountUI()` 之后调用，否则会被它重新显示出来。
       */
      function setupViewMode() {
        if (isSelf) return;
        for (const id of ['accountCard', 'myProfileCard', 'btnPickAvatar', 'avatarPicker', 'renameRow', 'btnRename', 'renameInput', 'accountNameNote']) {
          const el = $(id);
          if (el) el.style.display = 'none';
        }
        // 身份卡的大头像：只读视图里要去掉"可点换头像"的样子（手型光标 + title 提示），
        // 否则用户仍会以为能改对方的头像（点了还会弹出选择器）。
        const face = $('avatar');
        if (face) {
          face.style.cursor = 'default';
          face.removeAttribute('title');
        }
        const main = container.querySelector('main.container');
        if (!main) return;
        const bar = document.createElement('div');
        bar.className = 'card';
        bar.style.cssText = 'padding:12px 16px;margin-bottom:24px;border:1px solid var(--gold);font-size:13px;';
        // ⚠️ 标签与名字之间那个空格**写在标记里**，不要塞进译文末尾：
        //    "译文首尾带空白"曾经是切语言卡死浏览器的燃料（见 i18n.js 的 `nodeContent()`）
        bar.innerHTML = `👤 ${tr('正在查看个人页：')} <b id="viewedName">…</b>`
          + ` · <a href="profile.html" style="color:var(--gold-light);">${tr('返回我的个人页')}</a>`;
        main.insertBefore(bar, main.firstChild);
      }

      // ==================================================================
      // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 个人页「🎒 我的装扮」区块
      //
      // 见 design/tdshogi-items/DESIGN.md §9 前端落点；REST 契约见 §6。
      // - 仅登录账号可用：游客（guest.id 不含 '.'）只显示引导、**不发任何请求**。
      // - 渲染遵循「服务端下发为准」：目录/拥有/装备/钱包全部来自 `GET /api/items`，
      //   前端不另抄一份规则（槽位顺序与 src/items/catalog.js 的 SLOTS 对齐）。
      // - 所有写操作（装备/购买/兑换）成功后用**返回数据局部刷新**并 toast；
      //   失败（含 401）在卡片内的 `#itemsMsg` 显示可见提示，绝不静默。
      // 说明：本段自包含，不改动本页既有逻辑；放在 `setupViewMode()` 之前，
      // 并在只读视图（看别人的个人页）自行隐藏整卡。
      // SPA：由 mount 调用（不再在模块加载时自启）；元素监听经 on() 记进 teardown，
      // 试听音频在 unmount 时停掉（td.push(stopPreview)）。
      // ==================================================================
      function initItemsCard() {
        const card = $('itemsCard');
        if (!card) return;
        // 只读视图：我的装扮与「被查看者」无关 → 整卡隐藏
        if (!isSelf) { card.style.display = 'none'; return; }

        const SLOT_LABELS = {
          avatar: '头像',
          'bgm-menu': '菜单BGM',
          'bgm-game': '开局BGM',
          'bgm-endgame': '终盘BGM',
          sprite: '立绘',
          pieces: '棋子',
          board: '棋盘',
          byoyomi: '读秒音',
        };
        // 与 src/items/catalog.js 的 SLOTS 顺序一致
        const SLOTS = ['avatar', 'bgm-menu', 'bgm-game', 'bgm-endgame', 'sprite', 'pieces', 'board', 'byoyomi'];
        const el = (id) => $(id);

        // 本地快照：接口返回值合并后整体重渲染（局部刷新，不再整页拉取）
        let snap = { wallet: { coin: 0 }, owned: [], equipped: {}, catalog: [] };
        let catFilter = 'all';
        let searchQ = '';

        const isOwned = (id) => (snap.owned || []).indexOf(id) >= 0;
        const catById = (id) => (snap.catalog || []).find((c) => c.id === id) || null;

        function artOf(it) {
          if (!it || !it.asset) return '<span class="glyph">❔</span>';
          const a = it.asset;
          // ⚠️ 2026-10-08：棋子图集商品只显示**一枚**棋子（玉将 cell），不铺整张图集
          if (it.type === 'pieces' && a.kind === 'image' && a.value) {
            const size = 64;
            return `<div class="piece-img shop-piece-cell" style="width:${size}px;height:${size}px;`
              + `background-image:url('${esc(a.value)}');background-position:0 0;`
              + `background-size:${8 * size}px auto;"></div>`;
          }
          if (a.kind === 'image' && a.value) {
            return `<img src="${esc(a.value)}" alt="" loading="lazy">`;
          }
          if (a.kind === 'audio') return '<span class="glyph">🎵</span>';
          return `<span class="glyph">${esc(a.value)}</span>`;
        }
        function unlockHint(it) {
          const u = it && it.unlock;
          if (!u) return '';
          return u.type === 'level' ? `需 Lv.${u.value}` : u.type === 'games' ? `需 ${u.value} 局` : '';
        }
        // 卡片内可见提示（成功金色 / 失败红色）；空字符串 → 收起
        function note(msg, isErr) {
          const box = el('itemsMsg');
          if (!box) return;
          if (!msg) {
            box.style.display = 'none';
            box.className = 'shop-msg';
            box.textContent = '';
            return;
          }
          box.className = 'shop-msg ' + (isErr ? 'err' : 'ok');
          box.textContent = msg;
        }

        // ---- 渲染 ----
        function renderSlots() {
          el('itemsSlots').innerHTML = SLOTS.map((slot) => {
            const eqId = snap.equipped ? snap.equipped[slot] : null;
            const it = eqId ? catById(eqId) : null;
            const name = it ? esc(it.name) : '未装备';
            return `<div class="shop-slot${it ? '' : ' empty'}" data-unequip="${slot}" title="${it ? '点击卸下' + esc(it.name) : SLOT_LABELS[slot]}">`
              + `<div class="shop-slot-label">${SLOT_LABELS[slot]}</div>`
              + `<div class="shop-slot-name">${it ? artOf(it) + ' ' : ''}${name}</div>`
              + (it ? `<button class="btn btn-ghost btn-sm shop-slot-unequip" data-unequip="${slot}" type="button">卸下</button>` : '')
              + `</div>`;
          }).join('');
        }

        function filteredCatalog() {
          const q = searchQ.trim().toLowerCase();
          return (snap.catalog || []).filter((it) => {
            if (catFilter !== 'all' && it.type !== catFilter) return false;
            if (q) {
              const hay = ((it.name || '') + (it.desc || '') + (it.id || '')).toLowerCase();
              if (hay.indexOf(q) < 0) return false;
            }
            return true;
          });
        }

        function itemCard(it) {
          const owned = isOwned(it.id);
          const free = it.price === null;
          // BGM 有唯一使用场景（role→bgm-menu/game/endgame）；其余按 type 匹配槽位
          const isBgm = it.type === 'bgm';
          const equipSlot = isBgm && it.role ? 'bgm-' + it.role : it.type;
          const equippedSlot = snap.equipped && snap.equipped[equipSlot] === it.id ? equipSlot : null;
          const rarity = it.rarity || 'N';
          const unlocked = unlockHint(it);
          const audioSrc = it.asset && it.asset.kind === 'audio' && it.asset.value ? it.asset.value : null;
          const previewBtn = audioSrc
            ? `<button class="btn btn-ghost btn-sm shop-preview" data-preview="${esc(audioSrc)}" type="button" title="试听">▶ 试听</button>`
            : '';
          let action;
          if (equippedSlot) {
            action = `<button class="btn btn-ghost btn-sm" disabled type="button">已装备</button>`;
          } else if (isBgm && owned && it.role) {
            const roleLabel = { menu: '菜单', game: '开局', endgame: '终盘' }[it.role] || it.role;
            action = `<button class="btn btn-primary btn-sm" data-equip="${esc(it.id)}" data-slot="${esc(equipSlot)}" type="button">装备到${roleLabel}</button>`;
          } else if (owned || free) {
            action = `<button class="btn btn-primary btn-sm" data-equip="${esc(it.id)}" data-slot="${esc(equipSlot)}" type="button">装备</button>`;
          } else {
            action = `<button class="btn btn-primary btn-sm" data-buy="${esc(it.id)}" type="button">购买</button>`;
          }
          const priceHtml = free
            ? `<span class="shop-price free">自带</span>`
            : `<span class="shop-price">💰 ${esc(String(it.price))}</span>`;
          return `<div class="shop-card rarity-${esc(rarity)}${equippedSlot ? ' equipped' : ''}">`
            + `<div class="shop-card-badge rarity-${esc(rarity)}">${esc(rarity)}</div>`
            + (equippedSlot
              ? `<div class="shop-card-badge equipped-tag">装备中</div>`
              : owned ? `<div class="shop-card-badge owned">已拥有</div>` : '')
            + `<div class="shop-card-art">${artOf(it)}</div>`
            + `<div class="shop-card-body">`
            + `<div class="shop-card-name">${esc(it.name)}</div>`
            + `<div class="shop-card-desc">${esc(it.desc || SLOT_LABELS[it.type] || it.type)}${unlocked ? ' · ' + unlocked : ''}</div>`
            + `<div class="shop-card-foot">${priceHtml}<span class="shop-actions">${previewBtn}${action}</span></div>`
            + `</div></div>`;
        }

        function renderShop() {
          const list = filteredCatalog();
          el('itemsShopGrid').innerHTML = list.map(itemCard).join('')
            || '<div class="shop-empty">没有符合条件的商品</div>';
        }

        function render() {
          el('itemsCoin').textContent = (snap.wallet && snap.wallet.coin) || 0;
          renderSlots();
          renderShop();
        }

        // ---- 接口操作（成功后局部刷新 + toast；失败可见提示） ----
        const token = () => sessionToken();

        async function loadSnapshot() {
          try {
            const data = await global.ApiUtils.get(`/api/items?token=${encodeURIComponent(token())}`);
            if (!data || !data.ok) { note((data && data.error) || '道具数据加载失败', true); return; }
            if (!$('itemsCoin')) return; // SPA：已切页，回调回来时 DOM 已销毁 → 放弃写入
            snap = {
              wallet: data.wallet || { coin: 0 },
              owned: data.owned || [],
              equipped: data.equipped || {},
              catalog: data.catalog || [],
            };
            note(''); // 成功后收起提示
            applyAppearanceFromEquipped();
            render();
          } catch (e) {
            // ⚠️ `ApiUtils.get` 失败只抛 `HTTP <status>`（不像 post 会带服务端 {error}）→
            // 401 补一句可读文案；其它失败同样可见，不静默。
            const msg = (e && e.message) || '';
            note('道具加载失败：' + (/401/.test(msg) ? '登录状态已失效，请重新登录' : (msg || '请稍后重试')), true);
          }
        }

        async function doEquip(slot, itemId) {
          try {
            const res = await global.ApiUtils.post('/api/items/equip', { token: token(), slot, itemId });
            if (res && res.ok) {
              // ⚠️ 2026-10-08 修复：res.equipped 是原始 store 数据（不含 DEFAULT_EQUIP 回落），
              // 直接覆盖会丢掉默认装备 → 改用 loadSnapshot 重刷完整快照。
              await loadSnapshot();
              if (slot.indexOf('bgm-') === 0 && window.Sound && window.Sound.initFromServer) {
                window.Sound.initFromServer();
              }
              toast(itemId === null ? '已卸下装扮（BGM 回落默认曲）' : '已更新装备');
            } else {
              note((res && res.error) || '装备失败', true);
            }
          } catch (e) { note('装备失败：' + ((e && e.message) || '请稍后重试'), true); }
        }

        /**
         * 按当前 equipped 写入棋子图集 / 读秒音（board.js / Sound 读全局）。
         * ⚠️ `window.PIECE_ATLAS_DEFAULT` 是**棋盘栈共享的装扮配置**（board.js / pieces.js /
         * sound.js 都读写它），不是本页句柄——保留跨页生效，**不在 unmount 清理**
         * （清了会导致离开个人页后棋子皮肤丢失）。
         */
        function applyAppearanceFromEquipped() {
          const eq = snap.equipped || {};
          const cat = (id) => (id ? catById(id) : null);
          const pieces = cat(eq.pieces);
          if (pieces && pieces.asset && pieces.asset.value) {
            window.PIECE_ATLAS_DEFAULT = pieces.asset.value;
            try { document.dispatchEvent(new CustomEvent('tdshogi-appearance')); } catch (_) {}
          }
          const byo = cat(eq.byoyomi);
          if (window.Sound && window.Sound.setByoyomiVariant) {
            window.Sound.setByoyomiVariant(byo && byo.asset ? byo.asset.value : 'default');
          }
        }

        // ---- 试听（BGM 小按钮） ----
        let previewEl = null;
        function stopPreview() {
          if (previewEl) { try { previewEl.pause(); } catch (_) {} previewEl = null; }
          container.querySelectorAll('.shop-preview.playing').forEach((b) => {
            b.classList.remove('playing');
            b.textContent = '▶ 试听';
          });
          // 试听结束 → 恢复 BGM（2026-10-08：试听时停 BGM）
          if (window.Sound && window.Sound.bgmResumeFromPreview) window.Sound.bgmResumeFromPreview();
        }
        function togglePreview(btn, src) {
          if (previewEl && previewEl.dataset && previewEl.dataset.src === src) { stopPreview(); return; }
          stopPreview();
          // 2026-10-08：试听前先停 BGM，避免叠音
          if (window.Sound && window.Sound.bgmPauseForPreview) window.Sound.bgmPauseForPreview();
          try {
            const a = new Audio(encodeURI(src));
            a.dataset = a.dataset || {};
            a.dataset.src = src;
            a.volume = 0.7;
            a.onended = stopPreview;
            a.onerror = () => { stopPreview(); note('试听失败：音频不可用', true); };
            const p = a.play();
            if (p && p.catch) p.catch(() => { stopPreview(); note('试听被浏览器拦截，请再点一次', true); });
            previewEl = a;
            btn.classList.add('playing');
            btn.textContent = '■ 停止';
          } catch (_) { note('试听失败', true); stopPreview(); }
        }
        // SPA：切页时停掉试听、恢复 BGM（否则音频会跟到别的页面继续响）
        td.push(stopPreview);

        async function doBuy(itemId) {
          const it = catById(itemId);
          try {
            const res = await global.ApiUtils.post('/api/items/buy', { token: token(), itemId });
            if (res && res.ok) {
              if (res.wallet) snap.wallet = res.wallet; // 局部刷新：钱包
              if (res.owned) snap.owned = res.owned;    // 局部刷新：拥有清单
              render();
              toast(`已购买「${it ? it.name : itemId}」`);
            } else {
              note((res && res.error) || '购买失败', true);
            }
          } catch (e) { note('购买失败：' + ((e && e.message) || '请稍后重试'), true); }
        }

        async function doRedeem() {
          const input = el('itemsCode');
          const code = (input.value || '').trim();
          if (!code) { note('请输入兑换码', true); return; }
          try {
            const res = await global.ApiUtils.post('/api/items/redeem', { token: token(), code });
            if (res && res.ok) {
              if (res.wallet) snap.wallet = res.wallet;
              if (res.owned) snap.owned = res.owned;
              input.value = '';
              render();
              toast('兑换成功');
              note('兑换成功', false);
            } else {
              note((res && res.error) || '兑换失败', true);
            }
          } catch (e) { note('兑换失败：' + ((e && e.message) || '请稍后重试'), true); }
        }

        // ---- 事件委托（列表可整体重渲染也不丢监听） ----
        function onGridClick(e) {
          const pv = e.target.closest('[data-preview]');
          if (pv) return togglePreview(pv, pv.getAttribute('data-preview'));
          const eq = e.target.closest('[data-equip]');
          if (eq) return doEquip(eq.getAttribute('data-slot'), eq.getAttribute('data-equip'));
          const buy = e.target.closest('[data-buy]');
          if (buy) return doBuy(buy.getAttribute('data-buy'));
          return undefined;
        }
        on(el('itemsSlots'), 'click', (e) => {
          const b = e.target.closest('[data-unequip]');
          if (b) doEquip(b.getAttribute('data-unequip'), null);
        });
        on(el('itemsShopGrid'), 'click', onGridClick);
        on(el('btnRedeem'), 'click', doRedeem);
        on(el('itemsCode'), 'keydown', (e) => { if (e.key === 'Enter') doRedeem(); });
        // 分类页签
        const tabsBox = el('itemsCatTabs');
        if (tabsBox) {
          on(tabsBox, 'click', (e) => {
            const b = e.target.closest('[data-cat]');
            if (!b) return;
            catFilter = b.getAttribute('data-cat') || 'all';
            tabsBox.querySelectorAll('.shop-tab').forEach((t) => {
              t.classList.toggle('active', t.getAttribute('data-cat') === catFilter);
            });
            renderShop();
          });
        }
        // 搜索
        const searchInput = el('itemsSearch');
        if (searchInput) {
          on(searchInput, 'input', () => {
            searchQ = searchInput.value || '';
            renderShop();
          });
        }

        // ---- 初始化：按登录态分流 ----
        if (!isLoggedIn(guest.id)) {
          el('itemsGuest').style.display = 'block';
          el('itemsBody').style.display = 'none';
          return; // 游客：不发请求
        }
        el('itemsGuest').style.display = 'none';
        el('itemsBody').style.display = 'block';
        render();        // 先用空快照画骨架（目录显示"加载中"占位）
        loadSnapshot();  // 拉取真实数据后重渲染
      }

      initItemsCard();
      setupViewMode();
      loadProfile();

      // ==================================================================
      // 子模块驱动（2026-10-09）：标签页（tabs.js）+ 棋谱检索台（records-console.js）
      // 初始标签：params.tab 优先（router 已把 history.html 与 #records 映射为 tab=records），
      // 回退读 location.hash / location.search（旧书签 / 手动输入）。
      // 「棋谱」标签激活时才懒挂载 RecordsConsole；全部由 unmount → destroy 一并清理。
      // ==================================================================
      const hashTab = decodeURIComponent((location.hash || '').replace(/^#/, ''));
      const searchTab = new URLSearchParams(location.search).get('tab');
      const initialTab = params.tab || hashTab || searchTab;
      const parts = global.ProfileParts || {};
      if (parts.Tabs && parts.Tabs.mount) {
        parts.Tabs.mount({
          initial: initialTab || 'overview',
          hooks: {
            records: function () {
              const rc = global.ProfileParts && global.ProfileParts.RecordsConsole;
              if (rc && rc.mount) rc.mount();
            },
          },
        });
      }
    },

    unmount() {
      // 子模块先拆：它们自己的 WS 订阅 / 元素监听由各自 destroy 清理
      const parts = global.ProfileParts || {};
      if (parts.Tabs && parts.Tabs.destroy) { try { parts.Tabs.destroy(); } catch (_) {} }
      if (parts.RecordsConsole && parts.RecordsConsole.destroy) { try { parts.RecordsConsole.destroy(); } catch (_) {} }
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.profile = View;
})(window);

/* ==== js/records-console.js ==== */
/**
 * records-console.js — 棋谱检索台（profile 页子模块，可从任意容器 mount 的可复用模块）
 *
 * 2026-10-04：由原 `history.js` 抽出。原实现自带 `NAV.renderNav('history')` +
 * `API.connect()` 的**页面引导**逻辑，直接塞进个人页会与 `profile.js` 双重初始化
 * 导航与 WS 连接，故改造成「只负责绑定元素 id + 收发 record_search」的可复用件。
 *
 * SPA 迁移（2026-10-09）：再去掉「加载即自启」——改为被 profile 的 mount/unmount
 * **调用/驱动**的函数集合（导出 `window.ProfileParts.RecordsConsole`）：
 *   - `mount()`   由 profile 激活「棋谱」标签时**懒调用**（只挂一次）：绑元素、
 *     订阅 `record_search_result`（退订句柄记进内部 teardown）、发起首次检索。
 *   - `destroy()` 由 profile.unmount 调用：退订 WS、解绑全部监听、复位状态，零残留。
 *
 * 检索走 WS 而非 REST 的理由见原 history.js 头注（PLAN §Q7 越权修复）：
 * 身份由连接握手时绑定并**强制过滤**，客户端不传 playerId（传了也无效）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  let mounted = false;
  let records = [];
  let listPage = 1; // 列表当前页（每页 20 条，见 renderList）
  let teardown = [];

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  const $ = (id) => UI.$(id);
  const esc = (s) => UI.esc(s);
  const resultText = (r, names) => UI.resultText(r, { names, withClass: true });

  // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
  function on(el, ev, fn) {
    if (!el) return;
    el.addEventListener(ev, fn);
    teardown.push(() => el.removeEventListener(ev, fn));
  }

  // 检索条件（不含 player —— 身份由服务端按 WS 连接绑定，客户端无从指定）
  function buildQuery() {
    const q = {};
    const query = $('searchQuery').value.trim();
    const opening = $('searchOpening').value.trim();
    const moves = $('searchMoves').value.trim();
    const result = $('searchResult').value;
    if (query) q.query = query;
    if (opening) q.opening = opening;
    if (moves) {
      const m = moves.match(/^(\d+)\s*[-~]\s*(\d+)$/);
      if (m) { q.movesMin = m[1]; q.movesMax = m[2]; }
    }
    if (result) q.result = result;
    return q;
  }

  // 检索请求：走 WS（离线时 api 会入队，连上后自动发出）
  function loadRecords() {
    global.API.send({ type: 'record_search', data: buildQuery() });
  }

  // 结果由服务端按本连接身份过滤后下发
  function onResult(d) {
    records = (d && d.records) || [];
    listPage = 1; // 新结果 → 回到第 1 页（否则会停在上次页码上，看起来像"检索没生效"）
    const count = $('recordCount');
    if (count) count.textContent = records.length ? global.I18N.t('{n} 局', { n: records.length }) : '';
    renderList();
  }

  function renderList() {
    const el = $('recordList');
    if (!el) return;
    if (!records.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无匹配的对局。完成对局后可在此检索与复盘。</div>';
      // 空结果也要清掉分页条，否则会留着上一次的「第 1 / 5 页」
      UI.paginate({ items: [], container: 'recordPager' });
      return;
    }
    // 分页（2026-09-13）：棋谱可能上千条，全量渲染会把页面与滚动条一起撑爆
    const pg = UI.paginate({
      items: records,
      page: listPage,
      size: 20,
      container: 'recordPager',
      onPage: (n) => { listPage = n; renderList(); },
    });
    listPage = pg.page; // 页码被夹回时（检索后条数变少）同步回来
    // ⚠️ 词表按「整段文本节点精确匹配」翻译，动态拼接的句子匹配不到：
    //   - 能整段匹配的（🌐 公开 / 🔒 私有 / 空结果提示）交给 i18n 的 DOM 扫描自动翻译；
    //   - 拼接出来的（开局 / N 手 / N 局 / 进入复盘 →）在下方显式走 I18N.t()。
    el.innerHTML = pg.slice.map((r) => {
      const names = r.names || ['先手', '後手'];
      const myResult = resultText(r, names);
      const opening = r.opening ? `<span style="color:var(--gold-light);font-size:11px;">${global.I18N.t('开局 ')}${esc(r.opening)}</span>` : '';
      // 标出棋谱公开状态（私有/公开长得一样，打完一局看不出该谱有没有公开出去）
      const vis = r.visibility === 'public' ? '<span style="color:var(--gold-light);font-size:11px;">🌐 公开</span>'
        : (r.visibility ? '<span style="color:var(--text-dim);font-size:11px;">🔒 私有</span>' : '');
      return `
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])} ${vis}</div>
          <div class="r-result ${myResult.cls}">${esc(myResult.text)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${global.I18N.t('{n} 手', { n: r.moveCount || 0 })} · ${global.I18N.fmt(r.createdAt)} · ${opening} · ${global.I18N.t('进入复盘 →')}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * 挂载检索台。幂等：重复调用只生效一次；容器不在则静默不做。
   * 由 profile 在「棋谱」标签激活时调用（懒挂载），**不在模块加载时自启**。
   */
  function mount() {
    if (mounted) return;
    if (!$('recordList')) return; // 容器不在（非棋谱页 / 未渲染）
    mounted = true;

    // api.on 返回退订函数 → 记进 teardown（profile.unmount 经 destroy 一并清理）
    teardown.push(global.API.on('record_search_result', onResult));
    on($('btnSearch'), 'click', loadRecords);
    on($('btnResetSearch'), 'click', () => {
      $('searchQuery').value = '';
      $('searchOpening').value = '';
      $('searchMoves').value = '';
      $('searchResult').value = '';
      loadRecords();
    });
    // 回车触发检索
    ['searchQuery', 'searchOpening', 'searchMoves'].forEach((id) => {
      on($(id), 'keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
    });

    loadRecords();
  }

  /** 拆除：由 profile.unmount 调用（退订 WS、解绑监听、复位状态） */
  function destroy() {
    teardown.forEach((fn) => { try { fn(); } catch (_) {} });
    teardown = [];
    mounted = false;
    records = [];
    listPage = 1;
  }

  global.ProfileParts = global.ProfileParts || {};
  global.ProfileParts.RecordsConsole = { mount, destroy };
})(window);

/* ==== js/tabs.js ==== */
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

/* ==== js/review.js ==== */
/**
 * review.js — 复盘器 View：棋谱回放、书签、评论、本地变着、自由摆放、导出 KIF/CSA
 *
 * 参考参考项目（参考 app.js 复盘分块）：
 *  - 棋谱对子布局（▲/△，先手/後手）
 *  - 日式/USI 切换
 *  - 前进/后退/跳首/跳末 + 当前手滚动居中
 *  - 书签（toggle）
 *  - 评论（写/删）
 *  - 变着（在指定手数下保存备选走法）
 *  - 仅 owner / 管理员可访问（服务端校验）
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 review.html 的主体，逐字保留）
 *   mount(container, params)→ 绑定事件 / 起异步加载 / 挂全局句柄，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（照 home.js / lobby.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再 `api.connect`（外壳持有唯一 WS；本页纯 REST，不碰 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（本页无整页跳转；导出走 fetch+blob）。
 *   - 所有 setTimeout / document 监听 / Settings 订阅 / 棋盘拖拽观察，统一在 unmount 清理。
 *   - 异步回调返回处做存活判断（局部 alive，unmount 置 false），避免向已销毁 DOM 写入。
 *
 * ⚠️ 棋盘栈（board.js / pieces.js / piece-kinds.js / freeboard.js / freeboard-dnd.js）是
 *    play 与 review **共用的纯库**（window.ShogiBoard / window.FreeBoard / window.PieceKinds …），
 *    保持不动；本页只调用它们的 API，一个字都不改那些文件。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '复盘 · TDShogi',

    render() {
      // —— 原 review.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- 加载中 -->
    <div id="loading" class="card" style="padding:40px;text-align:center;">
      加载棋谱中…
    </div>

    <!-- 无权限/未找到 -->
    <div id="error" class="card" style="padding:40px;text-align:center;display:none;color:var(--red-light);">
      <div id="errorText"></div>
      <button class="btn btn-ghost" style="margin-top:16px;" data-href="profile.html#records">返回棋谱列表</button>
    </div>

    <!-- 复盘器主体 -->
    <div id="review" style="display:none;">
      <!-- 顶部元信息 -->
      <div class="card" style="padding:18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:18px;font-weight:800;">
              <span id="rvNameB">先手</span>
              <span style="margin:0 10px;color:var(--text-dim);font-weight:400;">vs</span>
              <span id="rvNameW">後手</span>
            </div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">
              <span id="rvResult"></span>
              <span style="margin:0 8px;">·</span>
              <span id="rvMoves"></span>
              <span style="margin:0 8px;">·</span>
              <span id="rvDate"></span>
            </div>
          </div>
          <!-- 按钮组样式在 review.css 的 \`.rv-meta-actions\`（手机端要等分两列，
               所以不能写 inline 的 display/gap——inline 会盖掉媒体查询） -->
          <div class="rv-meta-actions">
            <button class="btn btn-ghost btn-sm" id="btnFlipView" title="切换先手 / 后手视角">🔄 翻转视角</button>
            <button class="btn btn-ghost btn-sm" id="btnExportKif">导出 KIF</button>
            <button class="btn btn-ghost btn-sm" id="btnExportCsa">导出 CSA</button>
            <button class="btn btn-ghost btn-sm" data-href="profile.html#records">返回</button>
          </div>
        </div>
      </div>

      <!-- 管理员：对局信息与展示设置（PLAN §L5） -->
      <div class="card" id="adminPanel" style="padding:18px;margin-bottom:16px;display:none;">
        <h3 style="margin:0 0 12px;font-size:15px;color:var(--gold-light);">🛡️ 管理员：对局信息与展示设置</h3>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;">
          <div><div style="font-size:11px;color:var(--text-dim);">标题</div>
            <input class="input" id="adTitle" maxlength="120" style="width:180px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">赛事</div>
            <input class="input" id="adEvent" maxlength="120" style="width:140px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">轮次</div>
            <input class="input" id="adRound" maxlength="120" style="width:100px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">对局日期</div>
            <input class="input" id="adPlayedOn" maxlength="40" placeholder="2026-09-06" style="width:130px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">标签（逗号分隔）</div>
            <input class="input" id="adTags" style="width:180px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">先手展示名</div>
            <input class="input" id="adNameB" maxlength="120" style="width:130px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">後手展示名</div>
            <input class="input" id="adNameW" maxlength="120" style="width:130px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">结果说明</div>
            <input class="input" id="adResultNote" maxlength="120" style="width:150px;"></div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
            <input type="checkbox" id="adFeatured"> 广场置顶
          </label>
        </div>
        <div style="margin-top:10px;">
          <div style="font-size:11px;color:var(--text-dim);">简介</div>
          <textarea class="input" id="adDesc" rows="2" maxlength="200" placeholder="展示在广场卡片上的一句话说明"></textarea>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" id="btnSaveMeta">保存对局信息</button>
          <select class="input" id="adVisibility" style="max-width:160px;">
            <option value="private">私有（仅谱主可见）</option>
            <option value="public">公开（广场可见）</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="btnSaveVisibility">应用可见性</button>
          <span id="adTip" style="font-size:12px;color:var(--text-dim);"></span>
        </div>
      </div>

      <div class="review-layout">
        <!-- 中央棋盘（对战页同款布局：玩家栏 + 棋盘区含持驹） -->
        <div>
          <div class="card" style="padding:18px;">
            <div class="play-main">
              <!-- 上方玩家栏（对面，复盘默认先手视角） -->
              <div class="player-bar" id="topPlayerBar">
                <div>
                  <div class="name" id="topName">—</div>
                  <div class="rating" id="topRating"></div>
                </div>
                <div class="player-clock" id="topClock">—</div>
              </div>
              <div class="board-area">
                <div class="hand-row" id="oppHand">
                  <span class="hand-label">持驹</span>
                  <div class="hand-pieces" id="oppHandPieces"></div>
                </div>
                <div class="board-wrap" id="boardContainer"></div>
                <!-- ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 空容器（真按钮由 review.js
                     动态创建后填充；样式一律 inline，不改 CSS 文件）。仅在自由摆放且棋盘上
                     选中了某格时由 review.js 显示，其余时刻 display:none。 -->
                <div id="freePalette" style="display:none;"></div>
                <div class="hand-row" id="myHand">
                  <span class="hand-label">持驹</span>
                  <div class="hand-pieces" id="myHandPieces"></div>
                </div>
              </div>
              <!-- 下方玩家栏 -->
              <div class="player-bar" id="bottomPlayerBar">
                <div>
                  <div class="name" id="bottomName">—</div>
                  <div class="rating" id="bottomRating"></div>
                </div>
                <div class="player-clock" id="bottomClock">—</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：棋谱 + 操作 -->
        <div class="review-side">
          <!-- 棋谱面板 -->
          <div class="card" style="padding:18px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <h3 style="margin:0;font-size:15px;color:var(--gold-light);">走子记录</h3>
              <div style="display:flex;gap:8px;align-items:center;">
                <label style="font-size:12px;color:var(--text-dim);">显示：</label>
                <select class="select" id="rvDisplayMode" style="font-size:12px;padding:4px 8px;">
                  <option value="jp" selected>日式</option>
                  <option value="usi">USI</option>
                </select>
              </div>
            </div>
            <div class="rv-nav-actions">
              <button class="btn btn-ghost btn-sm" id="btnFirst">⏮ 首手</button>
              <button class="btn btn-ghost btn-sm" id="btnPrev">◀ 上一手</button>
              <button class="btn btn-ghost btn-sm" id="btnNext">下一手 ▶</button>
              <button class="btn btn-ghost btn-sm" id="btnLast">末手 ⏭</button>
              <button class="btn btn-ghost btn-sm" id="btnFreePlace" title="在当前局面上自由摆放棋子（草稿，不入谱）">✋ 自由摆放</button>
              <button class="btn btn-ghost btn-sm" id="btnUndoFree" style="display:none;">↩️ 撤销摆放</button>
            </div>
            <div id="rvMoveList" class="rv-move-list"></div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:8px;text-align:right;" id="rvCursor">0 / 0</div>
          </div>

          <!-- 当前手详情 -->
          <div class="card" style="padding:18px;">
            <h3 style="margin:0 0 10px;font-size:15px;color:var(--gold-light);">当前手</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" id="btnBookmark">🔖 书签</button>
              <button class="btn btn-ghost btn-sm" id="btnComment">💬 评论</button>
              <button class="btn btn-ghost btn-sm" id="btnVariation">↪ 添加变着</button>
            </div>
            <div id="rvVariations" style="margin-top:12px;"></div>
            <div id="rvComments" style="margin-top:14px;display:none;">
              <textarea class="input" id="rvCommentInput" placeholder="评论当前手…" rows="3"></textarea>
              <div style="display:flex;gap:6px;margin-top:6px;">
                <button class="btn btn-primary btn-sm" id="btnSaveComment">保存</button>
                <button class="btn btn-ghost btn-sm" id="btnCancelComment">取消</button>
              </div>
            </div>
            <div id="rvVariationPanel" style="margin-top:14px;display:none;">
              <input class="input" id="rvVariationInput" placeholder="走法 USI，如 7g7f 或 P*5e">
              <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">💾 变着保存在本机浏览器，仅自己可见，不会写入服务器或影响他人。</div>
              <div style="display:flex;gap:6px;margin-top:6px;">
                <button class="btn btn-primary btn-sm" id="btnSaveVariation">保存到本地</button>
                <button class="btn btn-ghost btn-sm" id="btnCancelVariation">取消</button>
              </div>
            </div>
            <div id="rvHasVariation" style="margin-top:8px;font-size:12px;color:var(--text-dim);display:none;">
              本手已存在变着
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>`;
    },

    mount(container, params) {
      this._teardown = [];
      const teardown = this._teardown;  // 副作用句柄统一收集（unmount 逐个清）
      let alive = true;                 // 存活标志（切页竞态防护）：unmount 置 false，
                                        // 异步回调返回处据此放弃写 DOM
      teardown.push(() => { alive = false; });

      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav('profile')（导航由外壳渲染）
      // 棋谱 id / 管理员令牌：优先 router 下发的 params，回退 location.search（原 `?id=` 读取逻辑等价保留）
      const qs = new URLSearchParams(global.location.search);
      const recordId = (params && params.id) || qs.get('id');
      // 管理员访问他人棋谱：携带 adminToken（服务端校验通过则放行）
      const adminToken = (params && params.adminToken) || qs.get('adminToken') || '';
      // 管理员可编辑对局信息、公开设置与任意评论（真正的鉴权在服务端 admin.verify）
      const isAdmin = !!adminToken;
      let editingCommentId = null;   // 正在编辑的评论 id（null = 新增）

      /** 统一请求头：管理员带上 x-admin-token */
      function authHeaders() {
        const h = { 'Content-Type': 'application/json' };
        if (adminToken) h['x-admin-token'] = adminToken;
        return h;
      }

      // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        teardown.push(() => el.removeEventListener(ev, fn));
      };
      // document / window 级监听：必须在 unmount 解绑（SPA 文档不销毁，不解就泄漏到别的页面）
      const onDoc = (ev, fn) => {
        document.addEventListener(ev, fn);
        teardown.push(() => document.removeEventListener(ev, fn));
      };

      if (!recordId) {
        $('loading').style.display = 'none';
        $('error').style.display = 'block';
        $('errorText').textContent = '缺少棋谱 ID';
        return;
      }

      // ---- 棋盘栈调用（纯库 API，保持原样）----
      const board = new window.ShogiBoard($('boardContainer'), { readonly: true });
      let review = null;     // 完整复盘数据
      let positions = [];    // 中间局面（来自 playback 或本地重放）
      let cursor = 0;        // 当前手（0=初始）
      let displayMode = 'jp';// 'jp' | 'usi'
      let navFromList = false; // 抑制自动滚动
      // 自由摆放（PLAN §G）：本地草稿，不入谱
      let fb = null;
      let freeMode = false;
      // 复盘视角（PLAN §S6）：默认先手，可翻转。与对局页观战视角共用 FreeBoard.setViewpoint
      let viewpoint = 'b';

      async function load() {
        const authQ = `guest=${encodeURIComponent(guest.id)}${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`;
        const url = `/api/records/${recordId}/review?${authQ}`;
        try {
          const r = await fetch(url);
          if (!alive) return;
          if (r.status === 403) throw new Error('只能复盘自己的棋谱');
          if (r.status === 404) throw new Error('棋谱不存在');
          if (!r.ok) throw new Error('加载失败');
          review = await r.json();
          if (!alive) return;
        } catch (e) {
          if (!alive) return;
          $('loading').style.display = 'none';
          $('error').style.display = 'block';
          $('errorText').textContent = e.message;
          return;
        }
        // 加载回放中间局面
        const pb = await fetch(`/api/records/${recordId}/playback?${authQ}`).then((r) => r.json());
        if (!alive) return;
        positions = pb.positions || [];
        cursor = 0;
        render();
        initPermissionUI();
        $('loading').style.display = 'none';
        $('review').style.display = 'block';
      }

      /**
       * §M6：统一的棋盘组件（review 只读模式）。
       * 浏览时渲染局面与上一步高亮；自由摆放时切 free 模式，不再重建实例。
       */
      function ensureFb() {
        if (fb) return fb;
        fb = new window.FreeBoard({
          board,
          viewpoint: 'b',
          interactive: false,
          mode: 'review',
          hands: {
            my: $('myHandPieces'), myColor: 'b',
            opp: $('oppHandPieces'), oppColor: 'w',
          },
          // ⚠️ 2026-10-02 体验修复：点击棋盘落点跳到该手（此前 onSqClick 从未接线 → 点棋盘毫无反应）
          onSqClick: (sq) => {
            if (freeMode || !review || !sq) return;
            let target = -1;
            (review.moves || []).forEach((usi, i) => {
              const to = /^[PLNSGBR]\*/.test(usi) ? usi.slice(2, 4) : usi.slice(2, 4);
              if (to === sq) target = i + 1;
            });
            if (target > 0) { navFromList = true; navigate(target); }
          },
        });
        fb.attach();
        // 绑定一次驹台拖拽（interactive=false 时不会触发，自由摆放开启后生效）
        fb.bindHands($('myHandPieces'), 'b', $('oppHandPieces'), 'w');
        return fb;
      }

      // 棋盘拖拽的 document 级 pointermove/pointerup 只在拖拽中挂载（freeboard-dnd），
      // 切页时若恰好拖到一半，一并兜底解除 + 移除拖拽幽灵 / 悬停高亮（棋盘相关观察器清理）
      teardown.push(() => {
        try {
          if (fb && fb._docMove) document.removeEventListener('pointermove', fb._docMove);
          if (fb && fb._docUp) document.removeEventListener('pointerup', fb._docUp);
          if (fb && fb._drag && fb._drag.ghost) fb._drag.ghost.remove();
          document.querySelectorAll('.cell.drag-over').forEach((c) => c.classList.remove('drag-over'));
        } catch (_) {}
      });

      /** 当前手的落点格（用于上一步高亮）：打子取落点，普通走子取 to */
      function lastMoveSq() {
        if (!cursor) return null;
        const usi = review.moves[cursor - 1];
        if (!usi) return null;
        return /^[PLNSGBR]\*/.test(usi) ? usi.slice(2) : usi.slice(2, 4);
      }

      /**
       * §L：权限相关的 UI 呈现
       *  - 公开棋谱 + 非管理员 → 只读（隐藏书签/评论/变着/自由摆放）
       *  - 管理员 → 显示「对局信息与展示设置」面板
       */
      function initPermissionUI() {
        const isPub = review.visibility === 'public';
        const readonly = isPub && !isAdmin;
        // ⚠️ 2026-10-03 需求变更（变着＝本地草稿）：变着不再写服务端、任何人都能加，
        // 因此**不再随只读隐藏**（此前隐藏 → 非谱主连入口都看不到，与「可本地添加」相矛盾）。
        // 书签 / 评论 / 自由摆放仍按原权限隐藏。
        ['btnBookmark', 'btnComment', 'btnFreePlace'].forEach((id) => {
          const el = $(id);
          if (el) el.style.display = readonly ? 'none' : '';
        });
        const varBtn = $('btnVariation');
        if (varBtn) varBtn.style.display = ''; // 变着入口任何情况下都可用（本地草稿）
        // ⚠️ 2026-10-02 体验修复：只读时给出明确标识（此前按钮凭空消失，用户分不清"没权限"还是"加载失败"）
        if (readonly) {
          const anchor = $('boardContainer');
          if (anchor && anchor.parentNode && !$('readonlyTag')) {
            const tag = document.createElement('div');
            tag.id = 'readonlyTag';
            tag.style.cssText = 'margin:8px 0;padding:6px 10px;border-radius:8px;background:rgba(201,162,39,0.12);color:var(--gold-light);font-size:12px;';
            tag.textContent = '🔒 只读浏览（非谱主）——可回放 / 导出 / 添加本地变着（仅自己可见），但不能评论或修改棋谱';
            anchor.parentNode.insertBefore(tag, anchor);
          }
        }
        if (isAdmin) {
          const p = $('adminPanel');
          p.style.display = 'block';
          fillAdminForm();
        }
      }

      function fillAdminForm() {
        const m = review.meta || {};
        $('adTitle').value = m.title || '';
        $('adEvent').value = m.event || '';
        $('adRound').value = m.round || '';
        $('adPlayedOn').value = m.playedOn || '';
        $('adTags').value = (m.tags || []).join(', ');
        $('adNameB').value = (m.nameOverrides && m.nameOverrides.b) || '';
        $('adNameW').value = (m.nameOverrides && m.nameOverrides.w) || '';
        $('adResultNote').value = m.resultNote || '';
        $('adDesc').value = m.description || '';
        $('adFeatured').checked = !!m.featured;
        $('adVisibility').value = review.visibility || 'private';
      }

      // 保存对局信息（管理员）
      on($('btnSaveMeta'), 'click', async () => {
        const val = (id) => $(id).value.trim();
        const body = {
          title: val('adTitle'),
          event: val('adEvent'),
          round: val('adRound'),
          playedOn: val('adPlayedOn'),
          tags: val('adTags').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean),
          description: val('adDesc'),
          nameOverrides: { b: val('adNameB'), w: val('adNameW') },
          resultNote: val('adResultNote'),
          featured: $('adFeatured').checked,
        };
        try {
          const r = await fetch(`/api/admin/records/${recordId}/meta`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
          }).then((res) => res.json());
          if (!alive) return;
          if (r.ok) {
            review.meta = r.meta;
            toast('对局信息已保存');
            render();
          } else toast(r.error || '保存失败');
        } catch (_) { if (alive) toast('网络错误'); }
      });

      // 应用可见性（管理员）
      on($('btnSaveVisibility'), 'click', async () => {
        const visibility = $('adVisibility').value;
        try {
          const r = await fetch(`/api/admin/records/${recordId}/visibility`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ visibility }),
          }).then((res) => res.json());
          if (!alive) return;
          if (r.ok) {
            review.visibility = r.visibility;
            $('adTip').textContent = r.visibility === 'public' ? '已公开（广场可见）' : '已设为私有';
            toast(r.visibility === 'public' ? '已公开到棋谱广场' : '已设为私有');
            initPermissionUI();
            render();
          } else {
            $('adTip').textContent = r.error || '操作失败';
          }
        } catch (_) { if (alive) toast('网络错误'); }
      });

      // 对局结果文案（PLAN §M5）：实现统一在 util.js，此处只转发
      // （原先与 history.js 各有一份，加新结果说明时很容易只改一边）
      function resultText(r) { return UI.resultText(r); }

      // 评论「编辑 / 删除」按钮：从 inline onclick 改为 `data-act` 委托（2026-09-23，审查项 13f）。
      // 这两个值（手数 + 评论 id）原先被拼进 `onclick="rvEditComment(3, 'abc')"` 里 ——
      // 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态。现在值为**属性文本**，逃不出属性。
      // SPA：`UI.onAction('cm-edit'/'cm-del')` 的委托注册在文件末尾（模块级只注册一次），
      // 统一派发进 `window.Views.review._handlers`（mount 挂、unmount 置空）——
      // 原 `window.rvEditComment / window.rvDeleteComment` 收敛进该命名空间，离开页面后旧句柄不再被误调用。

      /**
       * 跳到第 n 手（翻页 / 跳首尾 / 键盘 / 列表与棋盘点击统一走这里）。
       * ⚠️ 审查 P3：自由摆放（freeMode）下翻页此前直接 `cursor = n; render()`，而 render() 在
       * freeMode 分支里只 `fb.render()` 保持草稿 → 既不刷新到新局面、也不丢弃改动，与「翻页会
       * 丢弃改动」的提示自相矛盾。这里统一在翻页前退出自由摆放（stopFreePlace 会重渲染回只读
       * 局面），使行为与文案一致。
       */
      function navigate(n) {
        if (freeMode) stopFreePlace();
        cursor = n;
        render();
      }

      function render() {
        if (!alive) return; // 切页竞态防护：unmount 后不再写 DOM
        // ⚠️ 2026-10-02 体验修复：翻页/任意重绘都会把棋盘复位到当前手，此前的「变着预览」随之中止——
        // 这里统一清掉预览标记，避免变着列表里的「退出预览」按钮与现实不一致。
        varPreview = null;
        // 顶部元信息（§L：管理员可为展示覆盖双方名/结果说明，与广场卡片保持一致）
        const ov = (review.meta && review.meta.nameOverrides) || null;
        $('rvNameB').textContent = (ov && ov.b) || (review.names || ['先手'])[0];
        $('rvNameW').textContent = (ov && ov.w) || (review.names || ['先手', '後手'])[1];
        const title = (review.meta && review.meta.title) || '';
        const extra = [(review.meta && review.meta.event) || '', (review.meta && review.meta.round) || ''].filter(Boolean).join(' ');
        $('rvResult').textContent = [resultText(review), (review.meta && review.meta.resultNote) ? `（${review.meta.resultNote}）` : ''].filter(Boolean).join('');
        $('rvMoves').textContent = `${review.moves.length} 手`;
        $('rvDate').textContent = [extra, global.I18N.fmt(review.createdAt)].filter(Boolean).join(' · ');
        document.title = title ? `${title} · 复盘 · TDShogi` : '复盘 · TDShogi';
        $('rvCursor').textContent = `${cursor} / ${review.moves.length}`;

        // 玩家栏：按当前视角排布（上方=对面、下方=自己）——PLAN §S6 复盘支持翻转
        // §F3 悬停信息卡：**必须设置 data-player-id**（reviewData 已返回 playerIds）。
        // 此前只设了 textContent，复盘页的悬停卡从未生效——与对局页「重进看不到 id」是两个独立缺陷。
        const names = review.names || ['先手', '後手'];
        const pids = review.playerIds || {};
        const topIdx = viewpoint === 'b' ? 1 : 0;     // 先手视角：上方 = 后手
        const bottomIdx = viewpoint === 'b' ? 0 : 1;  // 先手视角：下方 = 先手
        $('topName').textContent = names[topIdx] || (topIdx === 0 ? '先手' : '後手');
        $('topName').setAttribute('data-player-id', (topIdx === 0 ? pids.b : pids.w) || '');
        $('topRating').textContent = '';
        $('bottomName').textContent = names[bottomIdx] || (bottomIdx === 0 ? '先手' : '後手');
        $('bottomName').setAttribute('data-player-id', (bottomIdx === 0 ? pids.b : pids.w) || '');
        $('bottomRating').textContent = '';
        $('topClock').textContent = '';
        $('bottomClock').textContent = '';

        // 棋盘：§M6 —— 浏览与自由摆放都走 FreeBoard，
        // 浏览用 review 只读模式（自动带上一步高亮与统一持驹渲染），不再走裸 board.render。
        // §S6：视角统一由 setViewpoint 设置（会一并交换驹台配色并触发重渲染）；切勿直接改 fb.viewpoint
        const pos = positions[cursor];
        if (pos) {
          ensureFb();
          fb.setViewpoint(viewpoint);
          if (freeMode && fb) {
            fb.render();
          } else {
            fb.setModel({ board: pos.board, hands: pos.hands || {} }, lastMoveSq());
          }
        }

        // 棋谱对子列表
        renderMoveList();
        renderAnnotations();
        renderVariations();
      }

      function renderMoveList() {
        // 一编号 = 一手棋，与 KIF 文件手数顺序一致（此前为对子布局，一号两手）
        const el = $('rvMoveList');
        const moves = review.moves;
        const times = review.moveTimes || [];
        let cum = 0;
        const html = [];
        for (let no = 1; no <= moves.length; no++) {
          // 每手的走子前局面：positions[0]=初始，positions[k]=第 k 手后
          const before = positions[no - 1];
          const text = formatMove(moves[no - 1], before);
          const mark = no % 2 === 1 ? '▲' : '△';
          const spent = Number(times[no - 1]) || 0;
          cum += spent;
          const timeTxt = spent ? ` <span style="color:var(--text-dim);font-size:11px;">(${Math.floor(spent / 60)}:${String(spent % 60).padStart(2, '0')}/${Math.floor(cum / 3600)}:${String(Math.floor((cum % 3600) / 60)).padStart(2, '0')}:${String(cum % 60).padStart(2, '0')})</span>` : '';
          html.push(`<div class="rv-move-row${cursor === no ? ' current' : ''}">
        <span class="rv-no">${no}</span>
        <span class="rv-mv${cursor === no ? ' cursor' : ''}${isBookmarked(no) ? ' bookmark' : ''}${hasComment(no) ? ' has-comment' : ''}${hasVariation(no) ? ' has-var' : ''}" data-no="${no}">${mark} ${text}${timeTxt}</span>
      </div>`);
          // §L：评论直接展示在手数下方（旧格式位置），管理员可就地编辑/删除
          const cs = (review.comments && review.comments[no]) || [];
          if (cs.length) {
            html.push(`<div class="rv-comments">${cs.map((c) => `
          <div class="rv-comment">
            <span class="rv-comment-who">💬 ${esc(c.authorName || '解说')}</span>
            <span class="rv-comment-text">${esc(c.text)}</span>
            ${c.editedAt ? '<span class="rv-comment-edited">（已编辑）</span>' : ''}
            ${isAdmin ? `<span class="rv-comment-ops">
              <button class="btn btn-ghost btn-sm" data-act="cm-edit" data-no="${no}" data-id="${esc(c.id)}" title="编辑">✏️</button>
              <button class="btn btn-ghost btn-sm" data-act="cm-del" data-no="${no}" data-id="${esc(c.id)}" title="删除">🗑</button>
            </span>` : ''}
          </div>`).join('')}</div>`);
          }
        }
        el.innerHTML = html.join('');
        el.querySelectorAll('.rv-mv').forEach((node) => {
          node.addEventListener('click', () => {
            const no = parseInt(node.dataset.no, 10);
            if (!no || no > review.moves.length) return;
            navFromList = true;
            navigate(no);
          });
        });
        scrollMoveListToCurrent();
      }

      function formatMove(usi, beforePos) {
        if (!usi) return '—';
        if (displayMode === 'jp') return usiToJp(usi, beforePos ? beforePos.board : null);
        return usi;
      }

      // 从走子前局面查找 from 格的棋子中文名（服务端 KIND_NAME 格式）
      function pieceNameAtBoard(board, fromUsi) {
        if (!board) return '';
        for (let r = 0; r < board.length; r++) {
          const row = board[r];
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            if (cell && cell.sq === fromUsi && cell.piece) return cell.piece;
          }
        }
        return '';
      }

      const KIND_JP = {
        '歩': '歩', '香': '香', '桂': '桂', '銀': '銀', '金': '金', '角': '角', '飛': '飛', '玉': '玉',
        'と': 'と', '成香': '杏', '成桂': '圭', '成銀': '全', '馬': '馬', '龍': '龍',
      };

      function usiToJp(usi, beforeBoard) {
        const full = ['０','１','２','３','４','５','６','７','８','９'];
        const kanji = ['一','二','三','四','五','六','七','八','九'];
        // 打子 P*5e → ５五歩打（此前落进普通走子分支渲染错乱）
        const dropM = /^([PLNSGBR])\*([1-9])([a-i])$/.exec(usi);
        if (dropM) {
          const sym = (window.DROP_SYMBOLS || {})[dropM[1]] || '歩';
          return `${full[parseInt(dropM[2], 10) - 1]}${kanji[dropM[3].charCodeAt(0) - 97]}${sym}打`;
        }
        if (usi.length === 4 || usi.length === 5) {
          const toFile = usi[2];
          const toY = usi.charCodeAt(3) - 96;
          // 升变标记
          const promote = usi.length === 5 ? '成' : '';
          // 从走子前局面推导棋子名
          const fromUsi = usi.slice(0, 2);
          const rawPiece = pieceNameAtBoard(beforeBoard, fromUsi);
          const pieceName = KIND_JP[rawPiece] || rawPiece || '';
          return `${full[parseInt(toFile, 10)]}${kanji[toY - 1]}${pieceName}${promote}`;
        }
        // 其他未识别形式，保留 USI
        return usi;
      }

      function scrollMoveListToCurrent() {
        const el = $('rvMoveList');
        const cur = el.querySelector('.rv-mv.cursor');
        if (!cur) return;
        if (navFromList) { navFromList = false; return; }
        const target = cur.offsetTop;
        el.scrollTop = Math.max(0, target - el.clientHeight / 2 + cur.clientHeight / 2);
      }

      function isBookmarked(no) { return (review.bookmarks || []).includes(no); }
      // §L3：comments 已升级为数组形态（旧字符串由服务端 normalizeComments 兼容）
      function commentsAt(no) { return (review.comments && review.comments[no]) || []; }
      function hasComment(no) { return commentsAt(no).length > 0; }
      // ---- 变着：本地草稿（需求 A，2026-10-03）----
      // 变着不再写服务端：`POST /api/records/:id/variation` 只允许「谱主/管理员」，普通浏览者必 403
      //（这正是此前「保存不了、只能本地看」的根因）。按需求改为**纯本地草稿**——存在本浏览器，
      // 刷新/重进仍在，别人看不到，也不影响主棋谱或服务器数据。
      // 存储：localStorage['tdshogi_variations'] = { [recordId]: { [parent手数]: [{ move }] } }
      const VARIATION_LS_KEY = 'tdshogi_variations';

      /** 读某手数的本地草稿（每次现读，避免与其他标签/页面不同步） */
      function localVariations(no) {
        try {
          const all = JSON.parse(localStorage.getItem(VARIATION_LS_KEY) || '{}') || {};
          const mine = (all[recordId] && all[recordId][no]) || [];
          return Array.isArray(mine) ? mine.filter((v) => v && typeof v.move === 'string') : [];
        } catch (_) { return []; }
      }

      /** 写回某手数的本地草稿；空数组则顺手清理，避免残留空记录。返回是否写入成功。 */
      function writeLocalVariations(no, list) {
        try {
          const all = JSON.parse(localStorage.getItem(VARIATION_LS_KEY) || '{}') || {};
          const mine = all[recordId] || {};
          if (list.length) mine[no] = list;
          else delete mine[no];
          if (Object.keys(mine).length) all[recordId] = mine;
          else delete all[recordId];
          localStorage.setItem(VARIATION_LS_KEY, JSON.stringify(all));
          return true;
        } catch (_) { return false; } // 隐私模式 / 存储被禁用
      }

      /**
       * 合并展示：服务端已有变着（谱主/管理员保存的，只读）+ 本地草稿（可删除）。
       * 同一手数同一步以本地为准（本地项标记为可删）。
       */
      function variationsFor(no) {
        const srv = ((review.variations || {})[no] || []).map((v) => ({ move: v.move, local: false }));
        const loc = localVariations(no).map((v) => ({ move: v.move, local: true }));
        const localMoves = new Set(loc.map((v) => v.move));
        return srv.filter((v) => !localMoves.has(v.move)).concat(loc);
      }

      function hasVariation(no) { return variationsFor(no).length > 0; }

      function renderAnnotations() {
        const no = cursor;
        $('btnBookmark').classList.toggle('active', isBookmarked(no));
        $('btnComment').classList.toggle('active', hasComment(no));
        $('rvHasVariation').style.display = hasVariation(no) ? 'block' : 'none';
        // 评论展示
        const cm = $('rvComments');
        const cmInput = $('rvCommentInput');
        // 编辑态才回填内容；新增态保持为空（comments 现在是数组，不能当字符串用）
        if (cm.style.display !== 'none' && editingCommentId) {
          const hit = commentsAt(no).find((c) => c.id === editingCommentId);
          cmInput.value = hit ? hit.text : '';
        }
      }

      // 变着预览状态：{ parent, usi } | null —— 本地试走，不入谱、不写回服务端
      let varPreview = null;

      /**
       * 变着列表（含交互）。
       *
       * ⚠️ 2026-10-02 体验修复：变着此前**只能看、不能用**，补上「载入」试走与「退出预览」。
       * ⚠️ 2026-10-03 需求变更（本地草稿）：变着一律存本机浏览器——所有人都能加（不再受
       *    服务端「仅谱主/管理员」限制），本地项可删除；服务端已有的变着照常只读展示。
       */
      function renderVariations() {
        const el = $('rvVariations');
        const list = variationsFor(cursor);
        if (!list.length) { el.innerHTML = ''; return; }
        const rows = list.map((v, i) => {
          const on = !!(varPreview && varPreview.parent === cursor && varPreview.usi === v.move);
          const badge = v.local
            ? '<span style="color:var(--gold-light);font-size:11px;" title="保存在本机浏览器，仅自己可见，不入服务器">💾 本地</span>'
            : '';
          const del = v.local ? `<button class="btn btn-ghost btn-sm" data-var-del="${i}" title="删除这条本地变着">🗑</button>` : '';
          return `<div style="font-size:13px;margin-top:4px;padding:6px 10px;background:var(--bg-3);border-radius:6px;display:flex;align-items:center;gap:8px;">
        <span style="flex:1;">↪ ${esc(formatMove(v.move))} <span style="color:var(--text-dim);font-size:11px;">(${esc(v.move)})</span> ${badge}</span>
        <button class="btn btn-ghost btn-sm" data-var-idx="${i}">${on ? '✕ 退出预览' : '▶ 载入'}</button>
        ${del}
      </div>`;
        });
        el.innerHTML = `<div style="font-size:12px;color:var(--text-dim);">变着（参考，不影响主棋谱；「载入」为本地试走；💾 本地项保存在本机、仅自己可见）：</div>` + rows.join('');
        // 交互用委托之外的直接绑定：列表每次重建，绑在节点上不会泄漏（与 .rv-mv 同一做法）
        el.querySelectorAll('[data-var-idx]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const v = list[Number(btn.getAttribute('data-var-idx'))];
            if (!v) return;
            const on = !!(varPreview && varPreview.parent === cursor && varPreview.usi === v.move);
            if (on) clearVariationPreview();
            else loadVariation(cursor, v.move);
          });
        });
        el.querySelectorAll('[data-var-del]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const v = list[Number(btn.getAttribute('data-var-del'))];
            if (!v || !v.local) return;
            const rest = localVariations(cursor).filter((x) => x.move !== v.move);
            if (!writeLocalVariations(cursor, rest)) return toast('无法写入本地存储（浏览器隐私模式？）');
            if (varPreview && varPreview.usi === v.move) varPreview = null;
            render();
            toast('已删除本地变着');
          });
        });
      }

      /** 载入某变着到棋盘做本地试走（把变着走法应用到 parent 手后的局面，不改主谱） */
      function loadVariation(parent, usi) {
        const base = positions[parent];
        if (!base) return toast('局面尚未加载，无法载入变着');
        ensureFb();
        const model = {
          board: JSON.parse(JSON.stringify(base.board)),
          hands: JSON.parse(JSON.stringify(base.hands || { b: [], w: [] })),
        };
        const color = parent % 2 === 0 ? 'b' : 'w'; // positions[k] 之后轮到的一方
        try {
          window.FreeBoard.applyUsiOnModel(model, usi, color);
        } catch (_) {
          return toast('该变着无法应用到当前局面（走法或局面不匹配）');
        }
        const to = /^[PLNSGBR]\*/.test(usi) ? usi.slice(2) : usi.slice(2, 4);
        fb.setViewpoint(viewpoint);
        fb.setModel(model, to);
        varPreview = { parent, usi };
        renderVariations();
        toast('已载入变着（本地预览，未写回棋谱）');
      }

      /** 退出变着预览：棋盘回到当前手（render() 会清 varPreview） */
      function clearVariationPreview() {
        varPreview = null;
        render();
        toast('已退出变着预览');
      }

      // ---- 操作 ----
      // ⚠️ 2026-10-02 审查 P3：review 初始为 null、load() 异步——加载完成前按键/点击读 review.moves 会 TypeError。
      on($('btnFirst'), 'click', () => { if (!review) return; navigate(0); });
      on($('btnPrev'), 'click', () => { if (!review) return; if (cursor > 0) navigate(cursor - 1); });
      on($('btnNext'), 'click', () => { if (!review) return; if (cursor < review.moves.length) navigate(cursor + 1); });
      on($('btnLast'), 'click', () => { if (!review) return; navigate(review.moves.length); });
      onDoc('keydown', (e) => {
        if (!review) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft') { if (cursor > 0) navigate(cursor - 1); }
        else if (e.key === 'ArrowRight') { if (cursor < review.moves.length) navigate(cursor + 1); }
        else if (e.key === 'Home') navigate(0);
        else if (e.key === 'End') navigate(review.moves.length);
      });

      on($('rvDisplayMode'), 'change', (e) => {
        displayMode = e.target.value;
        renderMoveList();
      });

      // 书签
      on($('btnBookmark'), 'click', async () => {
        if (!cursor) return toast('初始局面无法加书签');
        const onBm = !isBookmarked(cursor);
        const r = await fetch(`/api/records/${recordId}/bookmark`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guest: guest.id, moveNo: cursor, on: onBm }),
        }).then((res) => res.json());
        if (!alive) return;
        if (r.ok) {
          review.bookmarks = r.bookmarks;
          render();
          toast(onBm ? '已加书签' : '已取消书签');
        } else toast(r.error || '操作失败');
      });

      // ---- 评论（§L3）：展示在手数下方，新增/编辑/删除统一走 /api/records/:id/comment ----
      const commentPanel = $('rvComments');
      const commentInput = $('rvCommentInput');

      /** 打开评论面板：commentId 为空 = 新增 */
      function openCommentPanel(no, commentId = null) {
        if (!no) return toast('初始局面无法评论');
        cursor = no;
        editingCommentId = commentId;
        const hit = commentId ? commentsAt(no).find((c) => c.id === commentId) : null;
        commentInput.value = hit ? hit.text : '';
        commentPanel.style.display = 'block';
        commentPanel.scrollIntoView({ block: 'nearest' });
        commentInput.focus();
        render();
      }

      // 管理员就地编辑 / 删除（手数列表里的按钮）——句柄挂 Views.review._handlers（见文件末尾 onAction 派发）

      on($('btnComment'), 'click', () => {
        if (!cursor) return toast('初始局面无法评论');
        if (commentPanel.style.display === 'block' && !editingCommentId) {
          commentPanel.style.display = 'none';
          return;
        }
        openCommentPanel(cursor, null);
      });
      on($('btnCancelComment'), 'click', () => {
        commentPanel.style.display = 'none';
        editingCommentId = null;
      });

      async function postComment(moveNo, text, commentId = null) {
        const body = { guest: guest.id, moveNo, text };
        if (commentId) body.commentId = commentId;
        try {
          const r = await fetch(`/api/records/${recordId}/comment`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
          }).then((res) => res.json());
          if (!alive) return;
          if (r.ok) {
            review.comments = r.comments;
            commentPanel.style.display = 'none';
            editingCommentId = null;
            render();
            toast(commentId ? (String(text).trim() ? '评论已更新' : '评论已删除') : '评论已保存');
          } else toast(r.error || '操作失败');
        } catch (_) { if (alive) toast('网络错误'); }
      }

      on($('btnSaveComment'), 'click', () => {
        postComment(cursor, commentInput.value, editingCommentId);
      });

      // 变着
      const varPanel = $('rvVariationPanel');
      on($('btnVariation'), 'click', () => {
        if (!cursor) return toast('初始局面无法添加变着');
        varPanel.style.display = varPanel.style.display === 'none' ? 'block' : 'none';
        if (varPanel.style.display === 'block') {
          $('rvVariationInput').focus();
        }
      });
      on($('btnCancelVariation'), 'click', () => { varPanel.style.display = 'none'; });
      // ⚠️ 2026-10-02 体验修复：变着此前**不做任何前端校验**——写错要等服务端回一句「变着走法非法」。
      // 这里沿用服务端同一正则（`src/records.js` addVariation）先做本地校验并给中文提示。
      // ⚠️ 2026-10-03 需求变更（本地草稿）：保存**不再发请求**（`POST .../variation` 仅谱主/管理员，
      // 非谱主必 403 → 这就是「保存不了」的根因），改为写入本机 localStorage，仅自己可见。
      const VARIATION_USI = /^([1-9][a-i])([1-9][a-i])\+?$|^[PLNSGBR]\*[1-9][a-i]$/;
      on($('btnSaveVariation'), 'click', () => {
        const input = $('rvVariationInput');
        const move = input.value.trim();
        if (!move) return toast('请输入变着走法（USI）');
        if (!cursor) return toast('初始局面无法添加变着');
        if (!VARIATION_USI.test(move)) {
          return toast('走法格式不正确：应为 USI，如 7g7f、7g7f+（升变）或 P*5e（打子）');
        }
        const cur = localVariations(cursor);
        if (cur.some((v) => v.move === move)
          || ((review.variations || {})[cursor] || []).some((v) => v.move === move)) {
          return toast('该变着已存在，无需重复添加');
        }
        if (!writeLocalVariations(cursor, cur.concat([{ move }]))) {
          return toast('无法写入本地存储（浏览器隐私模式？）');
        }
        varPanel.style.display = 'none';
        input.value = '';
        render();
        toast('已保存到本地（仅本机可见，不影响他人与服务器）');
      });

      // ---- 自由摆放（PLAN §G）：本地草稿，不入谱；导航/关闭即丢弃 ----
      function startFreePlace() {
        const pos = positions[cursor];
        if (!pos) return toast('局面尚未加载');
        // §M6：复用同一个 FreeBoard 实例，切模式即可（不再 destroy + new，避免双实例与重复绑定）
        ensureFb();
        fb.setMode('free');
        fb.setInteractive(true);
        fb.startFrom({ board: pos.board, hands: pos.hands || { b: [], w: [] } });
        freeMode = true;
        $('btnFreePlace').classList.add('active');
        $('btnUndoFree').style.display = 'inline-block';
        toast('自由摆放已开启：可移动棋子 / 从驹台放入 / 双击升变；再次点击「自由摆放」退出（翻页会丢弃改动）');
      }

      function stopFreePlace() {
        freeMode = false;
        // 回到 review 只读模式（保留实例，翻页继续用）
        if (fb) {
          fb.setMode('review');
          fb.setInteractive(false);
        }
        $('btnFreePlace').classList.remove('active');
        $('btnUndoFree').style.display = 'none';
        render();
      }

      on($('btnFreePlace'), 'click', () => {
        if (freeMode) stopFreePlace();
        else startFreePlace();
      });

      function undoFreePlace() {
        if (!freeMode || !fb) return toast('自由摆放未开启');
        if (!fb.undo()) toast('没有可撤销的操作');
      }
      on($('btnUndoFree'), 'click', undoFreePlace);
      onDoc('keydown', (e) => {
        if (!freeMode) return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoFreePlace(); }
      });

      // ==================================================================
      // ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 面板逻辑与插入点
      // ------------------------------------------------------------------
      // 规格：自由摆放（freeMode）下单击选中棋盘一格后，在棋盘下方（#boardContainer
      // 之后，即 review.html 里的 #freePalette 空容器）显示面板，提供
      //   ① 棋种选择（基本 8 种 / 成駒 6 种）→ 就地替换该格棋种
      //   ② 成 / 不成 切换（等价于原双击升变，只是多了一个显式按钮）
      //   ③ 翻转归属（先手 ⇄ 后手）——**真的改数据**：free 模型 cell 本就有 color 字段，
      //      board.js 渲染时按 piece.color 决定棋子朝向，翻转后视觉朝向随之改变；
      //      若模型无法表达归属才该禁用此按钮，本仓库并不属于那种情况。
      //   ④ 清空该格 / 关闭面板（Esc 亦可）
      // 写入一律经 FreeBoard.getSquare / setSquare（复用 _pushHistory + _afterOp，
      // 故 Ctrl+Z 同样能回退面板的编辑）；仍遵守自由摆放原语义：不入谱，
      // 翻页 / 退出自由摆放时由 render() 重装局面丢弃。
      // 按钮全部是真 <button>（Tab 可达、Enter/空格触发），样式全 inline（禁止改 CSS）。
      // ==================================================================
      const PALETTE_BASE = ['歩', '香', '桂', '銀', '金', '角', '飛', '玉'];
      const PALETTE_PROMO = ['と', '杏', '圭', '全', '馬', '龍'];
      const PK = window.PieceKinds || {}; // 棋种映射的单一来源（promoteOf / DEMOTE / isPromoted）
      let paletteSq = null;               // 面板当前作用的格名（跟随 fb.selectedSq）

      /** 面板宿主：优先用 review.html 的 #freePalette，缺失时兜底动态插到 #boardContainer 之后 */
      function paletteHost() {
        let host = $('freePalette');
        if (host) return host;
        const bc = $('boardContainer');
        if (!bc || !bc.parentNode) return null;
        host = document.createElement('div');
        host.id = 'freePalette';
        bc.parentNode.insertBefore(host, bc.nextSibling);
        return host;
      }

      /** 面板当前是否可见（Esc 用它判断这次按键要不要处理） */
      function paletteVisible() {
        const host = $('freePalette');
        return !!host && host.style.display !== 'none';
      }

      /** 创建面板骨架：幂等（按钮只建一次，之后靠 refreshPalette 改状态） */
      function buildPalette() {
        const host = paletteHost();
        if (!host || host.dataset.fpBuilt === '1') return host;
        host.dataset.fpBuilt = '1';
        host.style.cssText = 'display:none;margin-top:10px;padding:10px 12px;'
          + 'border:1px solid var(--border, #3a3f47);border-radius:10px;'
          + 'background:rgba(255,255,255,0.03);font-size:13px;';

        const mkRow = () => {
          const d = document.createElement('div');
          d.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;';
          return d;
        };
        const mkLabel = (text) => {
          const s = document.createElement('span');
          s.textContent = text;
          s.style.cssText = 'font-size:12px;color:var(--text-dim, #999);';
          return s;
        };
        const mkBtn = (label, title) => {
          const b = document.createElement('button');
          b.type = 'button'; // 真按钮：可 Tab 聚焦、Enter/空格触发
          b.className = 'btn btn-ghost btn-sm';
          b.textContent = label;
          b.style.minWidth = '38px';
          if (title) b.title = title;
          return b;
        };

        // 标题行：作用格 + 当前棋子状态（翻归属 / 升变后立刻反馈）
        const head = mkRow();
        const headTxt = mkLabel('');
        headTxt.id = 'fpHead';
        headTxt.style.cssText = 'font-weight:700;font-size:13px;color:var(--gold-light, #e0c46c);';
        head.appendChild(headTxt);
        const closeBtn = mkBtn('✕ 关闭', '关闭面板（Esc 亦可）');
        closeBtn.id = 'fpClose';
        closeBtn.style.marginLeft = 'auto';
        closeBtn.addEventListener('click', () => hidePalette());
        head.appendChild(closeBtn);
        host.appendChild(head);

        // 棋种行（上）：基本 8 种
        const rowBase = mkRow();
        rowBase.style.marginTop = '8px';
        rowBase.appendChild(mkLabel('基本：'));
        PALETTE_BASE.forEach((name) => {
          const b = mkBtn(name, `替换为「${name}」（保留原归属与成 / 不成）`);
          b.dataset.piece = name;
          b.addEventListener('click', () => applyPieceSel(name));
          rowBase.appendChild(b);
        });
        host.appendChild(rowBase);

        // 棋种行（下）：成駒 6 种
        const rowPromo = mkRow();
        rowPromo.style.marginTop = '6px';
        rowPromo.appendChild(mkLabel('成駒：'));
        PALETTE_PROMO.forEach((name) => {
          const b = mkBtn(name, `替换为「${name}」（保留原归属）`);
          b.dataset.piece = name;
          b.addEventListener('click', () => applyPieceSel(name));
          rowPromo.appendChild(b);
        });
        host.appendChild(rowPromo);

        // 操作行：成 / 不成 · 翻转归属 · 清空该格
        const rowOps = mkRow();
        rowOps.style.marginTop = '10px';
        const tgBtn = mkBtn('成 / 不成', '切换该格棋子的升变状态（金、玉不可成）');
        tgBtn.id = 'fpPromote';
        tgBtn.addEventListener('click', togglePromoteSel);
        rowOps.appendChild(tgBtn);
        const flipBtn = mkBtn('翻转（先手↔后手）', '把该格棋子的所属方取反，棋子朝向随之翻转');
        flipBtn.id = 'fpFlip';
        flipBtn.addEventListener('click', flipOwnerSel);
        rowOps.appendChild(flipBtn);
        const clrBtn = mkBtn('清空该格', '移除该格棋子（可继续用上方棋种按钮放新子）');
        clrBtn.id = 'fpClear';
        clrBtn.addEventListener('click', clearSquareSel);
        rowOps.appendChild(clrBtn);
        host.appendChild(rowOps);

        const hint = mkLabel('自由摆放是本地草稿，不入谱；翻页 / 退出自由摆放即丢弃。');
        hint.style.cssText = 'display:block;margin-top:8px;font-size:11px;color:var(--text-dim, #999);';
        host.appendChild(hint);
        return host;
      }

      /** 刷新面板状态：标题（格 / 归属 / 成不成）+ 成不成按钮可用性 + 棋种按钮高亮 */
      function refreshPalette() {
        if (!paletteSq || !fb) return;
        const p = fb.getSquare(paletteSq);
        const host = $('freePalette');
        const head = $('fpHead');
        if (head) {
          head.textContent = (p && p.piece)
            ? `${paletteSq} · ${p.color === 'b' ? '先手 ▲' : '后手 △'} ${p.piece}${p.promoted ? '（成）' : '（不成）'}`
            : `${paletteSq} · 空格（点上方棋种放置；归属默认当前视角方）`;
        }
        const tg = $('fpPromote');
        if (tg) {
          tg.disabled = !(p && p.piece);
          tg.style.opacity = tg.disabled ? '0.5' : '';
        }
        if (host && host.querySelectorAll) {
          host.querySelectorAll('button[data-piece]').forEach((b) => {
            b.style.outline = (p && p.piece && p.piece === b.dataset.piece) ? '2px solid var(--gold, #c9a227)' : '';
          });
        }
      }

      /** 显示面板并绑定作用格 */
      function showPalette(sq) {
        const host = buildPalette();
        if (!host || !sq) return;
        paletteSq = sq;
        host.style.display = 'block';
        refreshPalette();
      }

      /** 隐藏面板（不动棋盘选中态） */
      function hidePalette() {
        const host = $('freePalette');
        paletteSq = null;
        if (host) host.style.display = 'none';
      }

      /**
       * 显隐同步：只有「自由摆放中 + 棋盘上选中了某格」才显示。两个触发源覆盖全部路径：
       *   1) 棋盘点击 / 键盘 Enter 选格 → freeboard-dnd 的 _activateSq 回执 fb.onSqSelect；
       *   2) 页面其它点击（点驹台、点棋盘空白、点工具按钮）→ 本监听（冒泡在 freeboard 的
       *      处理器之后，读到的 fb.selectedSq 已是最终值）。
       */
      function syncPalette() {
        if (fb && fb.onSqSelect !== syncPalette) fb.onSqSelect = syncPalette; // 幂等接线
        if (!freeMode || !fb || !fb.selectedSq) { hidePalette(); return; }
        showPalette(fb.selectedSq);
      }
      onDoc('click', syncPalette);

      /** 棋种按钮：就地替换该格棋种（保留原归属）；空格则以当前视角方归属放一枚 */
      function applyPieceSel(name) {
        if (!freeMode || !fb || !paletteSq) return;
        const cur = fb.getSquare(paletteSq);
        const promoted = typeof PK.isPromoted === 'function'
          ? PK.isPromoted(name)
          : /^(と|成香|杏|成桂|圭|成銀|全|馬|龍)$/.test(name);
        fb.setSquare(paletteSq, {
          piece: name,
          color: (cur && cur.color) ? cur.color : viewpoint, // 空格：归属取当前视角方
          promoted,
        });
        refreshPalette();
      }

      /** 成 / 不成：复用 freeboard.togglePromote（与双击升变同一条路径，归属不变） */
      function togglePromoteSel() {
        if (!freeMode || !fb || !paletteSq) return;
        const p = fb.getSquare(paletteSq);
        if (!p || !p.piece) return toast('该格没有棋子，无法升变');
        // 可成判定：未成駒查 PROMOTE，成駒查 DEMOTE；金 / 玉两边都查不到 → 不可成
        const can = !!((PK.promoteOf && PK.promoteOf(p.piece)) || (PK.DEMOTE && PK.DEMOTE[p.piece]));
        if (!can) return toast(`「${p.piece}」不能升变 / 降级（金、玉没有成駒形态）`);
        fb.togglePromote(paletteSq);
        refreshPalette();
      }

      /** 翻转归属：真的把模型里的 color 取反（先手 ⇄ 后手），重绘后朝向随之翻转 */
      function flipOwnerSel() {
        if (!freeMode || !fb || !paletteSq) return;
        const p = fb.getSquare(paletteSq);
        if (!p || !p.piece) return toast('该格没有棋子，无法翻转归属');
        const next = p.color === 'b' ? 'w' : 'b';
        fb.setSquare(paletteSq, { piece: p.piece, color: next, promoted: p.promoted });
        refreshPalette();
        toast(`已翻转归属：${next === 'b' ? '先手 ▲' : '后手 △'}`);
      }

      /** 清空该格（面板保留，紧接着可用棋种按钮放新子） */
      function clearSquareSel() {
        if (!freeMode || !fb || !paletteSq) return;
        if (!fb.getSquare(paletteSq)) return toast('该格已是空格');
        fb.setSquare(paletteSq, null);
        refreshPalette();
      }

      // Esc 关闭面板（沿用页面「Esc 取消」的习惯，同时清掉棋盘上的选中态）
      onDoc('keydown', (e) => {
        if (e.key !== 'Escape' || !paletteVisible()) return;
        if (freeMode && fb && fb.clearSelection) fb.clearSelection();
        hidePalette();
      });

      // 导出棋谱（KIF / CSA）
      //
      // ⚠️ 2026-10-02 体验修复：此前直接 `window.location.href = url`——失败时（403 无权 / 404 不存在）
      // 浏览器会整页跳到一段 JSON 上，既没有下载、也没有任何提示。改为 fetch 取 blob 再触发下载：
      //   1) 失败时能读服务端 `{ error }` 用 toast 说明（不是无声无息或跳走）；
      //   2) 文件名优先用服务端 Content-Disposition 的 `filename*`（"先手_后手_日期.kif"，RFC 5987），
      //      拿不到再退回本地拼的默认名，保证「另存为」有可读文件名。
      async function doExport(fmt) {
        const q = `fmt=${fmt}&guest=${encodeURIComponent(guest.id)}${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`;
        try {
          const res = await fetch(`/api/records/${recordId}/export?${q}`);
          if (!alive) return;
          if (!res.ok) {
            let msg = `导出失败（${res.status}）`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
            return toast(msg);
          }
          const blob = await res.blob();
          if (!alive) return;
          let name = `record_${recordId}.${fmt}`;
          const cd = res.headers.get('Content-Disposition') || '';
          const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const mPlain = /filename="?([^";]+)"?/i.exec(cd);
          if (mStar) { try { name = decodeURIComponent(mStar[1]); } catch (_) {} }
          else if (mPlain) name = mPlain[1];
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objUrl;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          const revokeTimer = setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
          teardown.push(() => clearTimeout(revokeTimer)); // 定时器记入 teardown（铁律4）
          toast(`已导出 ${fmt.toUpperCase()}：${name}`);
        } catch (_) {
          if (alive) toast('网络错误，导出失败');
        }
      }
      on($('btnExportKif'), 'click', () => doExport('kif'));
      on($('btnExportCsa'), 'click', () => doExport('csa'));

      // §S6：复盘视角翻转（先手 ⇄ 后手）——与对局页观战视角同一套 FreeBoard.setViewpoint
      on($('btnFlipView'), 'click', () => {
        viewpoint = viewpoint === 'b' ? 'w' : 'b';
        render();
      });

      // 设置变更 → 重渲染棋盘（坐标 §S4；图集 2026-10-08 迁入装扮，走 tdshogi-appearance）
      if (window.Settings) {
        teardown.push(window.Settings.subscribe((all, key) => {
          if (['showCoords', 'highlightLastMove'].indexOf(key) < 0) return;
          if (alive && review) render();
        }));
      }
      const onAppearance = () => { if (alive && review) render(); };
      document.addEventListener('tdshogi-appearance', onAppearance);
      teardown.push(() => document.removeEventListener('tdshogi-appearance', onAppearance));

      // ---- 跨页全局句柄收敛（原 window.rvEditComment / window.rvDeleteComment）----
      // 挂到 window.Views.review._handlers 命名空间：mount 挂载、unmount 置空。
      // 离开复盘页后 _handlers 为 null，cm-edit / cm-del 委托静默忽略，旧句柄不会被误调用。
      this._handlers = {
        rvEditComment: (no, cid) => { if (alive) openCommentPanel(no, cid); },
        rvDeleteComment: async (no, cid) => {
          if (!alive) return;
          if (!confirm('删除这条评论？')) return;
          await postComment(no, '', cid);
        },
      };

      load();
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
      // 旧句柄失效：离开页面后 cm-edit / cm-del 委托不再派发到本页逻辑
      this._handlers = null;
    },
  };

  // 评论「编辑 / 删除」按钮：从 inline onclick 改为 `data-act` 委托（2026-09-23，审查项 13f）。
  // 这两个值（手数 + 评论 id）原先被拼进 `onclick="rvEditComment(3, 'abc')"` 里 ——
  // 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态。现在值为**属性文本**，逃不出属性。
  // SPA：委托注册在模块级只做一次，处理器经 `Views.review._handlers` 中转——
  // 未挂载 / 已离开复盘页时 _handlers 为空，静默忽略（不误调用、不报错）。
  UI.onAction('cm-edit', (el) => {
    const H = View._handlers;
    if (H && H.rvEditComment) {
      H.rvEditComment(Number(el.getAttribute('data-no')), el.getAttribute('data-id'));
    }
  });
  UI.onAction('cm-del', (el) => {
    const H = View._handlers;
    if (H && H.rvDeleteComment) {
      H.rvDeleteComment(Number(el.getAttribute('data-no')), el.getAttribute('data-id'));
    }
  });

  global.Views.review = View;
})(window);

/* ==== js/play-clock.js ==== */
/**
 * play-clock.js — 对局棋钟（本时倒计时 + 读秒）
 *
 * 从 `play.js` 抽出（PLAN §M5 前端拆分第一步）。**逻辑一字未改**，只把两处对外部
 * 状态的读取改成了注入的回调——因为它们在 play.js 里原本是 IIFE 的闭包变量：
 *   - `getState()`     取最新对局状态（原闭包变量 `state`）
 *   - `getViewpoint()` 取当前显示视角（原 `mySeat === 'w' ? 'w' : 'b'`）
 *
 * 对外接口（由 play.js 的 View 生命周期驱动）：
 *   PlayClock.init({ getState, getViewpoint })  注入依赖并启动 tick（play.mount 调）
 *   PlayClock.destroy()                         停表并复位模块状态（play.unmount 调）
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

  /**
   * SPA 生命周期（2026-10-09）：`play.unmount` 调用——停掉 500ms tick 定时器，
   * 并把模块状态复位到「刚加载」的样子（含注入回调），保证下一次 `init` 不残留上一局的
   * 读秒/提醒边界/闭包引用（否则切走再进会看到旧棋钟数字、或 tick 摸到已销毁的 DOM）。
   */
  function destroy() {
    stop();
    getState = function () { return null; };
    getViewpoint = function () { return 'b'; };
    onTick = null;
    localClocks = { b: 15 * 60 * 1000, w: 15 * 60 * 1000 };
    localByoyomi = { b: 0, w: 0 };
    inByoyomi = { b: false, w: false };
    byoyomiDuration = 0;
    lastTickTs = Date.now();
    lastAnchorTurn = null;
    resetMarks();
  }

  window.PlayClock = {
    init, destroy, syncFromState, syncFromServer, resetTick, update, start, stop,
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
 * 不像感想战那样要读写 `state` / `fb` / `cursor` 一堆闭包变量。
 *
 * SPA 迁移（2026-10-09）：本模块**绝不自启**，由 `play.js` 的 View 生命周期驱动：
 *   PlayChat.mount()     注册 WS 事件与 DOM 交互（play.mount 调；可重复，先 destroy 旧的）
 *   PlayChat.destroy()   退订 WS / 解绑 DOM / 清空聊天记录（play.unmount 调）
 *   PlayChat.init()      = mount（兼容旧名）
 *   PlayChat.system(text)               重要提示写入聊天区留痕
 *   PlayChat.renderSpectators(list)     state 快照里的观众名单（首屏初始化用）
 *
 * ⚠️ 旧版在**模块顶层**捕获 `#chatBox` / `#chatInput` —— 多页应用下脚本执行时 DOM 已就绪
 * 没问题，但 SPA 单文档里脚本在 `#view` 渲染**之前**就加载了，顶层拿到的永远是 null。
 * 现在所有 DOM 都在用的时候经 `UI.$` 现查。
 *
 * 依赖：`window.API`、`window.UI`（`$` / `esc`）、`window.Settings`（观众进出提示开关）
 *       DOM：`#chatBox` `#chatInput` `#btnChatSend` `#chatTabs` `#spectatorList` `#spectatorCount`
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
    const chatBox = $('chatBox');
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
    const chatBox = $('chatBox');
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
    const chatBox = $('chatBox');
    if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
  }

  function sendChat() {
    const chatInput = $('chatInput');
    if (!chatInput) return;
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

  /** 渲染快捷语胶囊（幂等：`mount()` 可能被重复调用） */
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

  // ==================================================================
  // 生命周期（SPA）：mount 注册、destroy 全清——由 play.js 的 mount/unmount 驱动
  // ==================================================================
  let teardown = [];   // 副作用句柄（api.on 退订函数 + DOM 解绑函数）
  let mounted = false;

  /** 注册 DOM 交互与 WS 事件（play.mount 调；重复调用先清旧的，不会重复收消息） */
  function mount() {
    if (mounted) destroy();
    mounted = true;
    teardown = [];
    chatLog = [];      // 新一局不残留上一局的聊天
    chatTab = 'all';

    const on = (el, ev, fn) => {
      if (!el) return;
      el.addEventListener(ev, fn);
      teardown.push(() => el.removeEventListener(ev, fn));
    };

    on($('btnChatSend'), 'click', sendChat);
    on($('chatInput'), 'keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    renderQuick(); // 快捷语胶囊

    // §R2 分区切换
    const tabs = $('chatTabs');
    if (tabs) {
      on(tabs, 'click', (e) => {
        const btn = e.target.closest('.chat-tab');
        if (!btn) return;
        chatTab = btn.getAttribute('data-tab') || 'all';
        tabs.querySelectorAll('.chat-tab').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        renderChat();
      });
    }

    teardown.push(api.on('chat', (data) => {
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
    }));

    // 观战者进入时系统提示（rebind=选手掉线重进回位，不算观战）
    teardown.push(api.on('spectating', (data) => {
      if (data && data.rebind) return;
      appendChat({ name: '系统', text: '你已进入观战，欢迎交流！', sys: true });
    }));

    teardown.push(api.on('spectator_update', (d) => renderSpectators(d.spectators || [])));
  }

  /** play.unmount 调用：退订 WS、解绑 DOM、清空聊天状态，切页零残留 */
  function destroy() {
    teardown.forEach((fn) => { try { fn(); } catch (_) {} });
    teardown = [];
    mounted = false;
    chatLog = [];
    chatTab = 'all';
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

  window.PlayChat = { init: mount, mount, destroy, renderSpectators, system };
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
 *                            `sendMove` / `setPendingPromo` / `takePendingPromo` / `destroy`
 *
 * SPA 迁移（2026-10-09）：本模块**绝不自启**——`init(ctx)` 由 `play.js` 的 mount 调用
 * （注入依赖 + 注册订阅/监听，句柄记内部 teardown），`destroy()` 由 unmount 调用全清。
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
  let teardown = [];              // SPA：本模块的副作用句柄（api.on 退订 + DOM 解绑），destroy 全清

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
    // SPA：重复 mount 先清上一轮的订阅/监听（幂等接线，不会双收消息）
    destroy();
    const c = ctx || {};
    if (typeof c.getState === 'function') getState = c.getState;
    if (typeof c.getFb === 'function') getFb = c.getFb;
    if (typeof c.getSeat === 'function') getSeat = c.getSeat;
    if (typeof c.getViewpoint === 'function') getViewpoint = c.getViewpoint;
    if (typeof c.ensureBoard === 'function') ensureBoard = c.ensureBoard;
    if (typeof c.renderPlayerBars === 'function') renderPlayerBars = c.renderPlayerBars;
    if (typeof c.clearSelection === 'function') clearSelection = c.clearSelection;

    teardown.push(api.on('demo_legal', (d) => {
      demoLegalCache[demoLegalKey(d.index)] = d.legalTargetsBySq;
      const fb = getFb();
      if (fb && reviewActive && demoCursor === d.index) {
        fb.setLegalTargets(d.legalTargetsBySq);
        fb.render();
      }
    }));

    // DOM 监听统一经 bind() 登记（unmount/destroy 一并解绑，双保险）
    const bind = (el, fn) => {
      if (!el) return;
      el.addEventListener('click', fn);
      teardown.push(() => el.removeEventListener('click', fn));
    };
    bind($('btnDemoClaim'), () => api.send({ type: 'demo_claim' }));
    bind($('btnDemoTransfer'), () => api.send({ type: 'demo_transfer' }));
    bind($('btnDemoUndo'), () => api.send({ type: 'demo_undo' }));
    bind($('btnDemoClear'), () => { if (confirm('清空全部推演手，回到本谱终局局面？')) api.send({ type: 'demo_reset' }); });
    bind($('btnDemoLatest'), () => { demoCursor = demoEdge(); applyDemoMode(); updateDemoUI(); });
    bind($('btnDemoRematch'), () => { api.send({ type: 'rematch' }); toast('已请求再来一局，等待对方同意…'); });
    bind($('btnFreeMode'), () => {
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

    teardown.push(api.on('demo_state', (d) => {
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
    }));
  }

  /**
   * SPA 生命周期（2026-10-09）：`play.unmount` 调用——退订 WS（demo_legal / demo_state）、
   * 解绑演示栏按钮，并把感想战状态（推演谱 / 光标 / 自由摆棋 / 缓存 / 注入回调）全部复位，
   * 保证下次进对局页是干净的初始态。
   */
  function destroy() {
    teardown.forEach((fn) => { try { fn(); } catch (_) {} });
    teardown = [];
    reviewActive = false;
    demoInfo = null;
    demoCursor = 0;
    originalPositions = null;
    pendingDemoPromo = null;
    freeMode = false;
    demoLegalCache = {};
    // 注入回调复位为安全默认值（避免 destroy 后仍摸到旧页面的 DOM / 闭包）
    getState = function () { return null; };
    getFb = function () { return null; };
    getSeat = function () { return { mySeat: null, isPlayer: false }; };
    getViewpoint = function () { return 'b'; };
    ensureBoard = function () {};
    renderPlayerBars = function () {};
    clearSelection = function () {};
  }

  window.PlayDemo = {
    init,
    destroy,                                       // SPA：play.unmount 调（清订阅/监听/状态）
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
 * SPA 迁移（2026-10-09）：本文件**绝不自启**——`make()` 由 `play.js` 的 mount 调用，
 * 每次装配把自己的 WS 订阅 / DOM 监听 / setTimeout 记入内部 teardown，由返回对象的
 * `destroy()` 全清（play.unmount 调）。`location.href` 跳页一律改经 `Router.navigate`
 * （btnLeave 的跳转改为调用注入的 `deps.leaveGame()`，与 View 的 confirmLeave 离开守卫协同）。
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
    // 「退出对局」按钮的跳转（确认 + 发 leave + 路由）统一由 play.js 注入——
    // 它还要置 confirmLeave 放行标志，避免离开守卫二次弹确认。
    const leaveGame = typeof deps.leaveGame === 'function'
      ? deps.leaveGame
      : () => { global.Router.navigate('lobby.html'); };

    // SPA：本次装配的副作用句柄（api.on 退订函数 + DOM 解绑 + clearTimeout）
    const teardown = [];
    const bind = (el, ev, fn) => {
      if (!el) return;
      el.addEventListener(ev, fn);
      teardown.push(() => el.removeEventListener(ev, fn));
    };

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
  const t = setTimeout(() => {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
  }, 80);
  teardown.push(() => clearTimeout(t)); // SPA：切页清掉未触发的滚动
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

teardown.push(api.on('hello', (d) => { if (d) renderReportCategories(d.reportCategories); }));

if ($('btnReport')) {
  bind($('btnReport'), 'click', () => {
    const p = $('reportPanel');
    const show = p.style.display === 'none';
    p.style.display = show ? '' : 'none';
    // 按钮在顶部交互栏、表单在右侧「操作」卡里（2026-09-20 移动）——
    // 不滚过去的话，点完看着像"没反应"（尤其手机窄屏，表单在屏幕外）
    if (show) { try { p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {} }
  });
  bind($('btnReportCancel'), 'click', () => { $('reportPanel').style.display = 'none'; });
  bind($('btnReportSubmit'), 'click', () => {
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
  teardown.push(api.on('reported', () => {
    toast('举报已提交，管理员会尽快处理');
    $('reportPanel').style.display = 'none';
    $('reportDetail').value = '';
  }));
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
bind($('btnRematch'), 'click', (e) => requestRematch(e.currentTarget));
bind($('bannerRematch'), 'click', (e) => {
  requestRematch(e.currentTarget);
  $('banner').classList.remove('show');
});
teardown.push(api.on('game_start', () => { rematchRequested = false; })); // 对局重开 → 复位
bind($('btnLeave'), 'click', () => leaveGame());
// §R1：观战视角切换（先手 ⇄ 后手）。仅观战者可用——对局者固定自己视角。
bind($('btnViewpoint'), 'click', () => {
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
      /** SPA：play.unmount 调用——退订 hello/reported/game_start、解绑全部按钮监听、清未触发滚动 */
      destroy() {
        teardown.forEach((fn) => { try { fn(); } catch (_) {} });
        teardown.length = 0;
        rematchRequested = false;
      },
    };
  }

  global.PlayViews = { make };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/play.js ==== */
/**
 * play.js — 对局页 View：状态同步 / 走子交互 / 升变 / 棋钟 / 认输 / 再来一局 / 观战 / 感想战
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回原 play.html 的主体（<main> + 升变弹层 + 胜负横幅，逐字保留）
 *   mount(container, params)→ 组装棋盘/子模块、订阅 WS、绑事件，句柄记进 this._teardown
 *   confirmLeave()          → ★离开守卫：对局进行中弹确认，取消则阻断导航（router 契约）
 *   unmount()               → 统一清理（含 4 个子模块与 FreeBoard），切页零泄漏
 *
 * 范式（照 home.js / lobby.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）；`api.on('open', enterRoom)` 只管断线重连
 *     后重进房间，mount 时**主动** enterRoom() 一次（WS 可能早已建立，open 不会再触发）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / setTimeout / api.on / Settings 订阅 / document|window 监听 /
 *     棋盘观察器（FreeBoard.destroy），统一在 unmount 清理。
 *
 * 子模块（play-clock / play-chat / play-demo / play-views）：**绝不自启**，由本 View 的
 * mount/unmount 驱动 init/mount ↔ destroy；棋盘栈（board/pieces/piece-kinds/freeboard/
 * freeboard-dnd）是 play 与 review 共用的纯库，一字未改。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  // 时间控制预设（与服务端 TIME_CONTROLS 对应）
  const TIME_CONTROLS = {
    '15+60': { name: '15分钟 + 60秒' },
    '10+30': { name: '10分钟 + 30秒' },
    '10:00': { name: '10分钟包干' },
    '10sec': { name: '10秒快棋' },
  };

  const View = {
    title: '对局 · TDShogi',

    render() {
      // —— 原 play.html 的主体（<header class="nav"> 之后到 </footer> 之前）：逐字保留 ——
      // <main class="container"> + 升变弹层 + 胜负横幅；导航/页脚/toast 由外壳承载。
      return `
  <main class="container">
    <div id="roomTop" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div style="font-size:14px;color:var(--text-dim);">
        <span id="roomCodeLabel"></span>
        <span id="spectatorTag" style="display:none;margin-left:12px;background:var(--bg-3);padding:3px 10px;border-radius:6px;color:var(--gold-light);font-size:12px;">👁 观战中</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" id="btnViewpoint" style="display:none;" title="切换观战视角（先手 / 后手）">🔄 视角·先手</button>
        <button class="btn btn-ghost btn-sm" id="btnSound" title="音效开关">🔊 音效</button>
        <!-- 举报（2026-09-20）：移到顶部交互栏（原先埋在右侧「操作」卡里，要滚动才看得到）。
             只在对局中、对面确实有人时出现；类别清单由服务端在 hello 里下发（src/reports.js）。 -->
        <button class="btn btn-ghost btn-sm" id="btnReport" style="display:none;"
          title="举报对手：作弊 / 辱骂 / 恶意挂机等">🚩 举报</button>
        <!-- ⚠️ 2026-10-02 体验修复：补 tooltip（此前退出对局按钮无任何说明，易与「认输」混淆） -->
        <button class="btn btn-ghost btn-sm" id="btnLeave" title="退出对局并返回大厅（不影响已开始的棋局）">退出对局</button>
      </div>
    </div>

    <div class="play-layout">
      <div class="play-main">
        <!-- 感想战工具条（终局自动进入，PLAN §G v6） -->
        <div id="demoBar" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;margin-bottom:10px;background:var(--bg-2);border:1px solid rgba(201,162,39,0.35);border-radius:10px;">
          <span id="demoStatus" style="font-size:13px;font-weight:700;color:var(--gold-light);">🎤 感想战中</span>
          <span id="turnHint" style="font-size:12px;color:var(--text-dim);"></span>
          <!-- ⚠️ 2026-10-02 体验修复：演示工具条若干按钮补 tooltip（此前只有「撤销」有说明） -->
          <button class="btn btn-primary btn-sm" id="btnDemoClaim" style="display:none;" title="取得演示权：由你按规则走棋演示（不入正式棋谱）">🙋 我来演示</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoTransfer" style="display:none;" title="把演示权交给对方">🤝 交给对方</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoUndo" style="display:none;" title="撤销一手（推演谱为空时回退原谱一手）">↩️ 撤销</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoClear" style="display:none;" title="清空当前推演，回到原谱">🗑 清空推演</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoLatest" style="display:none;" title="跳到推演谱最新一手">⏭ 回到最新</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoRematch" style="display:none;" title="向对手发起再来一局">🔁 再来一局</button>
          <button class="btn btn-ghost btn-sm" id="btnFreeMode" style="display:none;" title="自由摆棋：不校验规则、不入谱，可随意摆放棋子">✋ 自由摆棋</button>
          <span style="font-size:11px;color:var(--text-dim);margin-left:auto;">按规则行棋 · 不计入棋谱</span>
        </div>

        <!-- 上方玩家栏（对面）—— 由 play.js 按视角动态渲染 -->
        <div class="player-bar" id="topPlayerBar">
          <!-- 头像（2026-09-20）：由 play.js 从 state.players[].avatar 填充 -->
          <span class="player-avatar" id="topAvatar"></span>
          <div>
            <div class="name" id="topName">—</div>
            <div class="rating" id="topRating"></div>
          </div>
          <div class="player-clock" id="topClock">10:00</div>
        </div>

        <!-- ⚠️ 2026-10-03 新功能：道具系统骨架 —— 立绘舞台（相对定位容器，供棋盘两侧的立绘绝对定位，不改动现有布局） -->
        <div id="spriteStage" style="position:relative;width:100%;display:flex;justify-content:center;">
        <!-- 棋盘区：左=对手持驹，中=棋盘，右=自己持驹（由 play.js 按视角摆放） -->
        <div class="board-area">
          <div class="hand-row" id="oppHand">
            <span class="hand-label">持驹</span>
            <div class="hand-pieces" id="oppHandPieces"></div>
          </div>
          <div class="board-wrap" id="boardContainer"></div>
          <div class="hand-row" id="myHand">
            <span class="hand-label">持驹</span>
            <div class="hand-pieces" id="myHandPieces"></div>
          </div>
        </div>
        <!-- ⚠️ 2026-10-03 新功能：道具系统骨架 —— 左右立绘（b=先手方 / w=后手方，由 play.js 按视角填充；空则隐藏） -->
        <div id="spriteB" style="position:absolute;left:0;top:50%;transform:translateY(-50%);width:150px;display:none;align-items:center;pointer-events:none;"></div>
        <div id="spriteW" style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:150px;display:none;align-items:center;justify-content:flex-end;pointer-events:none;"></div>
        </div>

        <!-- 下方玩家栏（自己） -->
        <div class="player-bar" id="bottomPlayerBar">
          <span class="player-avatar" id="bottomAvatar"></span>
          <div>
            <div class="name" id="bottomName">—</div>
            <div class="rating" id="bottomRating"></div>
          </div>
          <div class="player-clock" id="bottomClock">10:00</div>
        </div>
      </div>

      <!-- 右侧面板 -->
      <div class="play-side">
        <div class="panel">
          <h3>走子记录</h3>
          <div class="move-list" id="moveList"></div>
        </div>
        <div class="panel">
          <h3>观众（<span id="spectatorCount">0</span>）</h3>
          <div id="spectatorList" style="font-size:13px;min-height:20px;color:var(--text);"><div style="color:var(--text-dim);font-size:12px;">暂无观众</div></div>
        </div>
        <div class="panel">
          <h3>操作</h3>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <!-- ⚠️ 2026-10-02 体验修复：认输 / 再来一局补 tooltip（此前无说明） -->
            <button class="btn btn-danger" id="btnResign" title="认输：本局立即判负并结束">认输</button>
            <button class="btn btn-ghost" id="btnDeclare" style="display:none;"
              title="入玉宣言：玉在敌阵 + 敌阵内 10 枚以上 + 点数先手 28 / 后手 27 以上，且自己手番、未被王手 → 宣言方胜（AJSA 规则）">🏯 入玉宣言</button>
            <button class="btn btn-primary" id="btnRematch" style="display:none;" title="向对手发起再来一局">再来一局</button>
          </div>
          <div id="reportPanel" style="display:none;margin-top:10px;">
            <select class="input" id="reportCategory" style="font-size:12px;padding:5px 8px;"></select>
            <input class="input" id="reportDetail" maxlength="200" placeholder="补充说明（可选）"
              style="margin-top:6px;font-size:12px;padding:5px 8px;">
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button class="btn btn-primary btn-sm" id="btnReportSubmit" title="把举报提交给管理员审核">提交举报</button>
              <button class="btn btn-ghost btn-sm" id="btnReportCancel" title="取消并收起举报表单">取消</button>
            </div>
          </div>
        </div>
        <!-- 聊天：§R2 kibitz 分区（全部 / 对局 / 观战），并按发言者身份配色区分 -->
        <div class="panel">
          <h3>聊天</h3>
          <div class="chat-tabs" id="chatTabs">
            <button class="chat-tab active" data-tab="all">全部</button>
            <button class="chat-tab" data-tab="players">对局</button>
            <button class="chat-tab" data-tab="spectators">观战</button>
          </div>
          <div class="chat-box" id="chatBox"></div>
          <!-- 快捷语（2026-09-20）：高频寒暄点一下直接发，省去对局中打字。
               内容与渲染见 js/play-chat.js 的 QUICK_PHRASES -->
          <div class="chat-quick" id="chatQuick"></div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <input class="input" id="chatInput" placeholder="说点什么…" style="padding:6px 10px;font-size:13px;">
            <button class="btn btn-primary btn-sm" id="btnChatSend" style="flex-shrink:0;">发送</button>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- 升变弹层 -->
  <div class="promote-overlay" id="promoteOverlay" role="dialog" aria-modal="true" aria-label="选择是否升变">
    <div class="promote-box">
      <h3>是否升变？</h3>
      <div class="promote-actions">
        <!-- ⚠️ 2026-10-02 体验修复：「成」放前（成为默认焦点/主按钮），并加「取消」——
             此前「不成」在前导致回车默认选「不成」，且弹层无法取消、误触即强制落子。 -->
        <button class="btn btn-primary btn-lg" id="btnPromote">成</button>
        <button class="btn btn-ghost btn-lg" id="btnNoPromote">不成</button>
      </div>
      <div style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="btnPromoteCancel">取消</button>
      </div>
    </div>
  </div>

  <!-- 胜负横幅 -->
  <div class="banner" id="banner">
    <div id="bannerText" style="font-size:28px;font-weight:900;margin-bottom:16px;font-family:var(--font-serif);"></div>
    <div style="display:flex;gap:12px;justify-content:center;">
      <button class="btn btn-primary" id="bannerRematch" title="向对手发起再来一局">再来一局</button>
      <button class="btn btn-ghost" data-act="banner-close">关闭</button>
    </div>
  </div>`;
    },

    mount(container, params) {
      this._teardown = [];
      const teardown = this._teardown;
      const self = this;
      self._forceLeave = false;   // 「退出对局」等已确认离开 → confirmLeave 直接放行
      self._handlers = null;

      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav('play')（导航由外壳渲染）
      const api = global.API;                // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 元素事件统一登记（unmount 一并解绑，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        teardown.push(() => el.removeEventListener(ev, fn));
      };

      // ==================================================================
      // 页面级状态（原 IIFE 闭包变量）
      // ==================================================================
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
      let lastMoveCount = 0;          // 上次已知手数（用于音效触发）
      let lastPieceCount = null;      // 上次棋盘棋子总数（吃子判定）；null = 尚未收到首帧

      // confirmLeave / unmount 在闭包外也要读到这几个关键状态 → 镜像到实例属性
      self._state = null;
      self._isPlayer = false;
      self._fb = null;

      // 感想战的状态（推演谱 / 光标 / 原谱缓存 / 自由摆棋 / 升变待选）已整体搬进
      // **play-demo.js**（PLAN §M5）——包括此前漏写声明、被 eslint 抓出的隐式全局
      // `window.freeMode`：现在它位于模块内部，跨脚本污染的隐患从根上消失。

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
        if (global.PlayChat) global.PlayChat.system(msg);
      }

      // ==================================================================
      // §M5（2026-09-28）：渲染/弹层视图层已拆到 play-views.js
      // ==================================================================
      // ⚠️ 该文件必须在本文件**之前**加载（bundle 顺序，见 scripts/pack.js）。
      // 缺了就当场抛错——否则症状会是"界面不刷新"这种静默故障。
      if (!global.PlayViews) {
        throw new Error('play-views.js 必须在 play.js 之前加载（脚本顺序错了）');
      }
      const board = new global.ShogiBoard($('boardContainer'), {});

      /** 「退出对局」按钮：确认 → 发 leave → 路由回大厅/赛事页（原 btnLeave 内联逻辑搬入）。 */
      function leaveGame() {
        const inGame = isPlayer && state && state.status === 'PLAYING';
        // ⚠️ 2026-10-02 体验修复：对局中「退出对局」会被服务端判「接続切断」负，
        // 此前无任何确认、一点即判负并跳走（认输反有确认）——补一次确认。
        if (inGame && !global.confirm('退出将对局判负（相当于认输），确定退出吗？')) return;
        self._forceLeave = true; // 已确认过 → 放行 confirmLeave，避免离开守卫二次弹窗
        api.send({ type: 'leave' });
        // 赛事对局退出回赛事页，其余回大厅（铁律3：整页跳转改路由）
        global.Router.navigate((state && state.roomType === 'tournament') ? 'tournaments.html' : 'lobby.html');
      }

      const views = global.PlayViews.make({
        $, toast, api, guest, TIME_CONTROLS, ensureBoard, onSelectPiece, leaveGame,
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
      self._views = views;

      // 调试句柄：收敛到 `window.PlayParts` 命名空间（mount 挂、unmount 删）。
      // 原 `window.__playViews` 跨页全局不再创建，避免单文档下互相覆盖。
      global.PlayParts = {
        clock: global.PlayClock,
        chat: global.PlayChat,
        demo: global.PlayDemo,
        views,
      };

      // 棋钟已抽到 play-clock.js（PLAN §M5）：此处只做一次依赖注入。
      // 注入的是模块内读不到的两个"外部状态"——在 play.js 里它们是闭包变量：
      //   state → 最新对局状态（判断是否 PLAYING、谁的回合）
      //   视角  → 与棋盘**共用 `views.currentViewpoint()`**，保证两者永远同一口径
      //          （对局者固定自己视角；观战者跟随可切换的 spectatorViewpoint）
      global.PlayClock.init({
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
            && st.turn === mySeat && global.PlayClock.isDanger()
          );
        },
      });

      // ==================================================================
      // 走子交互
      // ==================================================================
      function onSelectPiece(pieceName, color) {
        if (color !== mySeat) return;      // 只能操作自己持驹
        if (state.turn !== mySeat) return; // 未轮到自己
        const sym = global.DROP_SYMBOLS && Object.keys(global.DROP_SYMBOLS).find((k) => global.DROP_SYMBOLS[k] === pieceName);
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
        if (global.PlayDemo && global.PlayDemo.takePendingPromo) global.PlayDemo.takePendingPromo(); // 清掉感想战暂存
        pendingPromote = null;
        if (selected) { selected = null; targets = []; clearHighlights(); }
        hidePromoteOverlay();
      }
      function showPromoteOverlay() {
        const el = $('promoteOverlay');
        if (!el) return;
        el.classList.add('show');
        if (global.A11y) global.A11y.onDialogOpen(el, { onClose: cancelPromote });
      }
      function hidePromoteOverlay() {
        const el = $('promoteOverlay');
        if (!el) return;
        el.classList.remove('show');
        if (global.A11y) global.A11y.onDialogClose(el);
      }

      // 升变按钮（对局走子 / 感想战演示共用弹层）
      // 感想战分支必须走 demo_move 通道（带光标 index）；sendMove() 硬编码 type:'move' 不能复用
      on($('btnPromote'), 'click', () => {
        // §M5：感想战的升变选择存放在 play-demo.js，用 takePendingPromo() 取出并清空
        const demoPromo = global.PlayDemo.takePendingPromo();
        if (demoPromo) global.PlayDemo.sendMove(demoPromo.usiPromote);
        else if (pendingPromote) sendMove(pendingPromote.promoteUsi);
        hidePromoteOverlay();
        pendingPromote = null;
      });
      on($('btnNoPromote'), 'click', () => {
        const demoPromo = global.PlayDemo.takePendingPromo();
        if (demoPromo) global.PlayDemo.sendMove(demoPromo.usiMove);
        else if (pendingPromote) sendMove(pendingPromote.nonPromoteUsi);
        hidePromoteOverlay();
        pendingPromote = null;
      });
      on($('btnPromoteCancel'), 'click', cancelPromote);

      // 认输 / 再来一局 / 退出
      // 结算横幅的「关闭」：原先写在 play.html 的 inline onclick 里，
      // 改为 data-act + 整页委托（2026-09-23，审查项 13f）。
      // SPA：`UI.onAction` 是**全局单槽**委托（模块级只注册一次，见文件末尾），
      // 处理器经 `Views.play._handlers` 中转——mount 挂、unmount 置空，旧句柄不被误调用。
      self._handlers = {
        bannerClose() {
          const b = $('banner');
          if (b) b.classList.remove('show');
        },
      };

      on($('btnResign'), 'click', () => {
        if (confirm('确定认输吗？')) api.send({ type: 'resign' });
      });
      // 入玉宣言（§P1 R-d）：条件一律由服务端判定，成功即宣言方胜；失败会收到具体原因
      on($('btnDeclare'), 'click', () => {
        api.send({ type: 'declare_nyugyoku' });
      });

      // ==================================================================
      // 举报（2026-09-20 用户要求）
      //
      // ⚠️ 类别清单来自服务端（`hello.reportCategories`，源头是 `src/reports.js` 的 `CATEGORIES`），
      // 前端**不另抄一份**——抄了就会出现"前端能选、服务端不认"或反之。
      // ⚠️ 被举报人取**对面座位**的 id，而不是"当前视角那个人"写死成先手/后手；
      // 视角可翻转，取错就会举报到自己。
      // ⚠️ 服务端还会做去重与配额（同一目标 30 分钟内只收一条），这里只负责发起。
      // → 表单交互与提交已整体在 play-views.js（make 装配，destroy 全清）。
      // ==================================================================

      // ==================================================================
      // WS 事件
      // ==================================================================
      function countPieces(st) {
        let n = 0;
        const b = st.board;
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
          if (b[r][c] && b[r][c].piece) n++;
        }
        return n;
      }
      // 首次交互解锁音频（浏览器自动播放策略）
      const unlockAudio = () => { if (global.Sound) global.Sound.ensureCtx(); };
      document.addEventListener('pointerdown', unlockAudio, { once: true });
      teardown.push(() => document.removeEventListener('pointerdown', unlockAudio));

      // 音效开关
      const btnSound = $('btnSound');
      function refreshSoundBtn() {
        if (!btnSound) return;
        btnSound.textContent = (global.Sound && global.Sound.isEnabled()) ? '🔊 音效' : '🔇 静音';
      }
      on(btnSound, 'click', () => {
        if (!global.Sound) return;
        global.Sound.setEnabled(!global.Sound.isEnabled());
        refreshSoundBtn();
        if (global.Sound.isEnabled()) global.Sound.playMove();  // 反馈音
      });
      refreshSoundBtn();

      teardown.push(api.on('state', (data) => {
        const prevMoves = lastMoveCount;
        lastMoveCount = (data.moves || []).length;
        // 走子音效：手数增加（自己或对手走子）。
        // ⚠️ 审查 P3：**首帧不发**。进入 / 重连时的第一条 state 可能一次性带着几十手历史，
        //   会被当成"刚走的一手"；且旧代码 lastPieceCount 初值 81 恒大于实际子数 → 必误播吃子音。
        //   这里以 lastPieceCount===null 标记"尚未收到首帧"：首帧只做基线初始化，之后才参与吃子判定。
        if (global.Sound && data.moves && data.moves.length > prevMoves && lastPieceCount !== null) {
          const pieces = countPieces(data);
          if (pieces < lastPieceCount) global.Sound.playCapture();  // 吃子
          else global.Sound.playMove();                             // 普通落子
        }
        lastPieceCount = countPieces(data);
        state = data;
        mySeat = data.seat || null;
        isPlayer = data.isPlayer === true;
        // confirmLeave / unmount 在闭包外读取 → 同步镜像
        self._state = data;
        self._isPlayer = isPlayer;
        global.PlayClock.resetTick(); // 以"此刻"为倒计时基准（原 `lastTickTs = Date.now()`）
        views.scrollBoardIntoViewOnce(); // §S2：手机端首屏直接落到棋盘
        // §U4 对局 BGM：进行中开、终局停（刷新/中途进房也走这里）
        // ⚠️ 2026-10-08：把对手开局曲交给 Sound（设置里「播放对手 BGM」时交替循环）
        if (global.Sound) {
          if (global.Sound.setOpponentTrack) {
            const oppSeat = mySeat === 'b' ? 'w' : 'b';
            const opp = state.players && state.players[oppSeat];
            global.Sound.setOpponentTrack(opp && opp.bgm ? opp.bgm : null);
          }
          if (state.status === 'PLAYING') global.Sound.bgmStart();
          else if (state.status === 'FINISHED') global.Sound.bgmStop();
        }
        // 感想战路由（PLAN §G v6）：终局自动进入；新对局自动退出（§M5：实现在 play-demo.js）
        if (state.status === 'FINISHED' && state.result) {
          global.PlayDemo.enter(state);
          // ⚠️ 2026-10-02 体验修复：终局也必须渲染一次——胜负横幅在 render() 内，
          // 此前直接 return 导致「进入感想战」吞掉了正式结果呈现（只剩一闪而过的 toast）。
          views.render(state);
          return;
        }
        if (global.PlayDemo.isActive()) global.PlayDemo.exit();
        // 收到新状态时清空选中（如果对方走子则清）
        if (selected && mySeat !== state.turn) {
          selected = null;
          targets = [];
        }
        views.render(state);
      }));

      // 棋钟校准（PLAN §M5：处理逻辑已抽到 play-clock.js）
      teardown.push(api.on('clock', (data) => global.PlayClock.syncFromServer(data)));
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
        fb = new global.FreeBoard({
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
            if (global.PlayDemo.isActive()) global.PlayDemo.sendMove(usi);
            else api.send({ type: 'move', data: { usi } });
          },
          onPromoteChoice: ({ usiMove, usiPromote }) => {
            if (global.PlayDemo.isActive()) global.PlayDemo.setPendingPromo({ usiMove, usiPromote });
            else pendingPromote = { promoteUsi: usiPromote, nonPromoteUsi: usiMove };
            showPromoteOverlay();
          },
        });
        fb.attach();
        fb.bindHands($('myHandPieces'), viewpoint, $('oppHandPieces'), viewpoint === 'b' ? 'w' : 'b');
        self._fb = fb;   // unmount 要 fb.destroy()（解除 resize/orientationchange/拖拽监听）
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
      // SPA：init 里注册的订阅/监听由 PlayDemo.destroy() 清（unmount 调）。
      global.PlayDemo.init({
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
      teardown.push(api.on('game_over', (data) => {
        notify('对局结束：' + (data.resultDetail || ''));
        if (global.Sound) { global.Sound.bgmStop(); } // §U4 终局停 BGM —— 终局音效统一由演示栏进入时播放（此前两处都播 → 双响）
        // 终局不跳页——state 推送（含 demo）会触发自动进入感想战模式
      }));
      teardown.push(api.on('game_start', (data) => {
        notify('对局开始！');
        if (global.Sound) { global.Sound.playStart(); global.Sound.bgmStart(); } // §U4 开局起 BGM
      }));
      // 对手请求再来一局：提示并高亮「再来一局」按钮
      teardown.push(api.on('rematch_requested', (data) => {
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
        const t = setTimeout(() => {
          btn.classList.remove('pulse');
          if (bannerBtn) bannerBtn.classList.remove('pulse');
        }, 4000);
        teardown.push(() => clearTimeout(t));
      }));
      teardown.push(api.on('error', (data) => {
        if (data && data.message) notify(data.message);
        // 私人房观战需要密码（PLAN §T2）：本页没有密码输入框 → 提示后回大厅的
        // 「👁 观战」入口补填密码（那里有房间码与密码框）。否则用户只会停在一片空白对局页。
        if (data && data.needPassword) {
          self._forceLeave = true; // 服务端权威指示离开 → 不再弹离开确认
          const t = setTimeout(() => { global.Router.navigate('lobby.html'); }, 1200);
          teardown.push(() => clearTimeout(t));
        }
      }));

      // 服务端明确回执「没有可进入的房间」（历史 bug 修复，2026-09-13）：
      // 从大厅点一张"自己是选手"的卡片时走的是 request_state（不带 spectate），
      // 若那局已结束 / 房间已销毁，服务端原先**静默不响应** → 页面一片白且没有任何提示。
      // 现在改为明确告知 + 送返大厅（与上面 needPassword 的处理风格一致）。
      teardown.push(api.on('no_room', () => {
        notify('该对局已结束或不存在，即将返回大厅');
        self._forceLeave = true; // 房间已没了 → 自动跳转不弹离开确认
        const t = setTimeout(() => { global.Router.navigate('lobby.html'); }, 1600);
        teardown.push(() => clearTimeout(t));
      }));
      // 同身份在别处登录：本页被顶替，提示并停止操作
      teardown.push(api.on('replaced', () => {
        toast('此身份已在其他窗口登录，本页已断开');
        board.setInteractive(false);
      }));

      // ==================================================================
      // 聊天（§R2 分区 / §R3 观众进出提示）
      // ==================================================================
      // 整块已抽到 **play-chat.js**（PLAN §M5）：聊天记录、分区 tab、观众名单及其 WS 事件
      // 都在那边，由 `PlayChat.mount()` 统一注册（destroy 在 unmount 一并清）。
      global.PlayChat.mount();

      // 仅当显式带 spectate=1 参数时才进入观战（来自观战列表/随机观战入口）
      // 玩家（建房/加入/匹配/重连）跳转不带 spectate，走 request_state，由服务端按连接身份返回对应状态
      // URL 参数：优先 router 传入的 params，回退 location.search（两者同源、必然一致）
      const qs = new URLSearchParams(location.search);
      const pick = (k) => (params && params[k] != null && params[k] !== '') ? String(params[k]) : qs.get(k);
      const isSpectate = !!pick('spectate');
      const isTournamentJoin = !!pick('join');
      const roomParam = pick('room');
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
      // 观战者重连后服务端不会主动重推 state，必须重新发起 spectate/request_state。
      // ⚠️ SPA：外壳持有唯一 WS，本页挂载时连接**早已建立**（open 不会再触发）→
      // mount 主动 enterRoom() 一次；`api.on('open')` 专管断线重连后的重新进房（重拉状态）。
      teardown.push(api.on('open', enterRoom));
      enterRoom();
      // 设置变更 → 重渲染棋盘（坐标 §S4 / 图集 §S5 / 上一步高亮，PLAN §S1）
      if (global.Settings) {
        teardown.push(global.Settings.subscribe((all, key) => {
          if (['showCoords', 'highlightLastMove'].indexOf(key) >= 0) {
            if (state) views.render(state);
            else if (fb) fb.render();
          }
        }));
      }
      // ⚠️ 2026-10-08：棋子图集迁入装扮 —— 装备变化后按新图集重画
      const onAppearance = () => {
        if (state) views.render(state);
        else if (fb) fb.render();
      };
      document.addEventListener('tdshogi-appearance', onAppearance);
      teardown.push(() => document.removeEventListener('tdshogi-appearance', onAppearance));

      // ==================================================================
      // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 对局立绘渲染
      //
      // 独立处理器：**不改动既有的 state 渲染主逻辑**（play-views.js），只在本页额外
      // 挂一个 state 监听，把 `state.players[b|w].sprite` 画到棋盘两侧（见 DESIGN §9）。
      //   kind==='glyph' → 大号字形；kind==='image' → <img src=value>；空 → 容器留空（不占视觉）。
      // 视角无关：先手(b)恒在右、后手(w)恒在左（与各自持驹所在方位一致，不随观战视角翻转）。
      // 移动端（<900px，与 CSS 断点对齐）不展示，直接隐藏。
      // ==================================================================
      const escHtml = UI.esc;
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
      teardown.push(api.on('state', (data) => renderSprites(data)));

      // ==================================================================
      // ★离开拦截（SPA）：对局进行中离开要提醒「离开即判负」
      //   - confirmLeave()：router 的 navigate / onPopState 在离开前调用，取消则阻断导航；
      //   - beforeunload：浏览器关闭 / 刷新时的原生提示，unmount 时解绑。
      // ==================================================================
      const onBeforeUnload = (e) => {
        if (!(isPlayer && state && state.status === 'PLAYING')) return;
        e.preventDefault();
        e.returnValue = '对局进行中，离开/刷新将判负（相当于认输）'; // 旧浏览器需要赋值才弹
        return '对局进行中，离开/刷新将判负（相当于认输）';
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      teardown.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
    },

    /**
     * ★离开守卫（router 契约）：返回 false 则**阻断**本次导航。
     * 对局进行中（有自己在下的、未结束的对局）→ 弹确认框，用户取消则留在原地；
     * 对局已结束 / 观战 / 非进行中 / 用户已通过「退出对局」确认过 → 直接放行。
     */
    confirmLeave() {
      if (this._forceLeave) return true;
      const st = this._state;
      const ongoing = this._isPlayer && st && st.status === 'PLAYING';
      if (!ongoing) return true;
      // UI.alert 是异步模态、拿不到"确定/取消"结果；离开守卫需要同步布尔 → 用原生 confirm
      return global.confirm('对局进行中，离开本页将被判负（相当于认输）。确定离开吗？') === true;
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
      this._handlers = null;
      // 子模块（4 个）：退订 WS / 解绑 DOM / 停定时器 / 复位内部状态
      if (global.PlayDemo && global.PlayDemo.destroy) { try { global.PlayDemo.destroy(); } catch (_) {} }
      if (global.PlayChat && global.PlayChat.destroy) { try { global.PlayChat.destroy(); } catch (_) {} }
      if (global.PlayClock && global.PlayClock.destroy) { try { global.PlayClock.destroy(); } catch (_) {} }
      if (this._views && this._views.destroy) { try { this._views.destroy(); } catch (_) {} }
      this._views = null;
      // 棋盘观察器：FreeBoard.destroy() 解除 resize/orientationchange 与 document 拖拽监听
      if (this._fb && this._fb.destroy) { try { this._fb.destroy(); } catch (_) {} }
      this._fb = null;
      // 对局 BGM：离开对局页即回菜单曲（原多页跳转时页面销毁自然停，SPA 文档常驻需手动停）
      if (global.Sound && global.Sound.bgmStop) { try { global.Sound.bgmStop(); } catch (_) {} }
      // 收敛命名空间：mount 挂的调试句柄一并清掉
      delete global.PlayParts;
      this._state = null;
      this._isPlayer = false;
      this._forceLeave = false;
    },
  };

  global.Views.play = View;

  // SPA：`UI.onAction` 是全局单槽委托（整页一个 click 监听），**模块级只注册一次**；
  // 处理器经 `Views.play._handlers` 中转——未挂载 / 已离开对局页时为空，静默忽略。
  UI.onAction('banner-close', () => {
    const H = View._handlers;
    if (H && typeof H.bannerClose === 'function') H.bannerClose();
  });
})(window);

/* ==== js/admin-shell.js ==== */
/**
 * admin-shell.js — 页面外壳（admin 子模块）：登录/登出、标签切换、`data-act` 分派
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：从「make(deps) 装配即自启」改为**被 admin View 的 mount/unmount
 * 驱动**的函数集合（`window.AdminParts.shell`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定 DOM 事件 / api.on 订阅 / 注册 data-act 委托，句柄记内部 teardown
 *   unmount()   → 统一清理；`UI.onAction` 的全局委托表注册项覆盖为 noop，
 *                 保证离开后台后旧处理器不再被误调用（util.js 的委托是全局单表）。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI）由 admin.js 的 mount 通过 `ctx` 注入；
 * 跨模块函数（loadOverview / viewUser / …）走 `ctx.hub`，不再挂 `window`。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];
  /** 注册进 `UI.onAction` 的 data-act 名（unmount 覆盖为 noop） */
  let _acts = [];

  function mount(ctx) {
    const { api, $, getToken, setToken, toast, hub } = ctx;
    const UI = ctx.UI || global.UI;
    const on = ctx.on;

    // 登录态检测（原 initUI）：显示登录卡或面板，已登录则拉首屏「总览」
    function initUI() {
      const isAdmin = !!getToken();
      const loginCard = $('adminLoginCard');
      if (loginCard) loginCard.style.display = isAdmin ? 'none' : 'block';
      const panel = $('adminPanel');
      if (panel) panel.style.display = isAdmin ? 'block' : 'none';
      // ⚠️ 2026-10-02 体验修复：退出按钮已移入 #adminPanel（随面板显隐），不再单独控制 display
      //（原写法把按钮留在登录卡片内、又单独设 inline-block，父容器隐藏 → 按钮永远不可见）。
      if (isAdmin) {
        // 只加载默认 tab（总览）。其余 tab 切过去再拉——
        // 原先进后台会把四个重查询（棋谱/用户/赛事/审计）全跑一遍，首屏白等很久，
        // 而多数时候管理员只看其中一两个。
        if (hub.loadOverview) hub.loadOverview();
      }
    }

    // ---- 登录 / 登出 ----
    on($('btnAdminLogin'), 'click', () => {
      const pwEl = $('adminPassword');
      const password = pwEl ? pwEl.value : '';
      if (!password) return toast('请输入管理密码');
      api.send({ type: 'admin_login', data: { password } });
    });
    _td.push(api.on('admin_logged_in', (data) => {
      if (!ctx.isAlive()) return;
      setToken(data.token);
      toast('管理员登录成功');
      initUI();
      // 铁律1：不再 `NAV.renderNav(null)` 整块重建导航 —— SPA 用增量刷新，
      // 让「管理入口」随登录态增删（见 nav.js 的 refreshBadge）。
      if (global.NAV && global.NAV.refreshBadge) global.NAV.refreshBadge();
    }));
    _td.push(api.on('error', (data) => {
      if (!ctx.isAlive()) return;
      if (data && data.message) toast(data.message);
    }));
    on($('btnAdminLogout'), 'click', () => {
      setToken(null);
      toast('已退出管理员');
      initUI();
      if (global.NAV && global.NAV.refreshBadge) global.NAV.refreshBadge(); // 登出后隐藏管理入口
    });

    // ---- 标签切换 ----
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach((btn) => {
      on(btn, 'click', () => {
        tabBtns.forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.classList.toggle('btn-ghost', b !== btn);
        });
        // ⚠️ 2026-10-02 审查 P1-7：必须含 'rooms'/'reports'，否则这两页（初始 display:none）永不被置为 block。
        ['overview', 'records', 'users', 'tournaments', 'rooms', 'reports', 'announcements', 'audit', 'ipbans', 'items'].forEach((t) => {
          const el = $('tab-' + t);
          if (el) el.style.display = t === btn.dataset.tab ? 'block' : 'none';
        });
        // 切到该 tab 才拉数据（避免进后台就把所有接口白跑一遍）
        const tab = btn.dataset.tab;
        if (tab === 'ipbans' && hub.loadIpBans) hub.loadIpBans();
        else if (tab === 'announcements' && hub.loadAnnouncements) hub.loadAnnouncements();
        else if (tab === 'rooms' && hub.loadRooms) hub.loadRooms();
        else if (tab === 'overview' && hub.loadOverview) hub.loadOverview();
        else if (tab === 'records' && hub.loadRecords) hub.loadRecords();
        else if (tab === 'users' && hub.loadUsers) hub.loadUsers();
        else if (tab === 'tournaments' && hub.loadTournaments) hub.loadTournaments();
        else if (tab === 'audit' && hub.loadAudit) hub.loadAudit();
        else if (tab === 'reports' && hub.loadReports) hub.loadReports();
        // 道具（2026-10-03 新功能）：走 hub，不再挂 window.loadItemsAdmin
        else if (tab === 'items' && hub.loadItemsAdmin) hub.loadItemsAdmin();
      });
    });

    // ==================================================================
    // `data-act` 分派（2026-09-23，安全审查遗留项 13f）
    //
    // 本页原先有 **19 处** inline `onclick`，且多处把用户可控的值（玩家名、赛事名）
    // 拼进属性里 —— 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态：
    // 游客把名字改成 `');alert()//`，管理员点该用户任一按钮即以管理员身份执行。
    // `esc` 补上单引号转义只是**止血**；改成 `data-act` + 属性值之后，
    // 引号逃不出属性、更不会被当代码执行，而且**事件走 util.js 的整页委托** ——
    // 列表整块重渲染也不会丢监听（逐个绑定要做到这点，得每次渲染后重新绑一遍）。
    //
    // ⚠️ SPA 迁移：处理器一律经 `hub.xxx` 分派（原 `window.xxx`），离开后台后
    // hub 由 admin.unmount 清空、data-act 委托覆盖为 noop，旧句柄不再被误调用。
    // ==================================================================
    {
      const at = (el, k) => el.getAttribute(k);
      const act = (name, fn) => { UI.onAction(name, fn); _acts.push(name); };
      act('rb-playback', (el) => hub.adminPlayback && hub.adminPlayback(at(el, 'data-id')));
      act('rb-export', (el) => hub.adminExport && hub.adminExport(at(el, 'data-id'), at(el, 'data-fmt')));
      act('reveal-ip', (el) => {
        el.textContent = at(el, 'data-text');
        el.removeAttribute('title');
        el.style.cursor = 'default';
      });
      act('user-view', (el) => hub.viewUser && hub.viewUser(at(el, 'data-id')));
      act('user-ban', (el) => hub.adminBan && hub.adminBan(at(el, 'data-id'), at(el, 'data-name')));
      act('user-unban', (el) => hub.adminUnban && hub.adminUnban(at(el, 'data-id'), at(el, 'data-name')));
      act('user-save-profile', (el) => hub.adminSaveProfile && hub.adminSaveProfile(at(el, 'data-id')));
      act('user-save-elo', (el) => hub.adminSaveElo && hub.adminSaveElo(at(el, 'data-id')));
      act('user-rename', (el) => hub.adminRename && hub.adminRename(at(el, 'data-id'), at(el, 'data-name')));
      act('user-reset-rating', (el) => hub.adminResetRating && hub.adminResetRating(at(el, 'data-id'), at(el, 'data-name')));
      act('user-reset-pwd', (el) => hub.adminResetPassword && hub.adminResetPassword(at(el, 'data-id'), at(el, 'data-name')));
      act('user-delete', (el) => hub.adminDeleteAccount && hub.adminDeleteAccount(at(el, 'data-id'), at(el, 'data-name')));
      act('tn-approve', (el) => hub.tnApprove && hub.tnApprove(at(el, 'data-id')));
      act('tn-reject', (el) => hub.tnReject && hub.tnReject(at(el, 'data-id')));
      act('tn-cancel', (el) => hub.tnCancel && hub.tnCancel(at(el, 'data-id')));
      act('tn-archive', (el) => hub.tnArchive && hub.tnArchive(at(el, 'data-id')));
      // 用户详情弹窗的「关闭」（原先写在 admin.html 的 inline onclick 里）
      act('modal-close', () => {
        const m = $('userDetailModal');
        if (m) {
          m.style.display = 'none';
          if (global.A11y) global.A11y.onDialogClose(m); // §6.3：焦点归还触发者
        }
      });

      // ⚠️ 2026-10-02 体验修复（棋谱就地编辑入口）：列表里新增的「✏️ 编辑」按钮改走
      // 这里的分派（data-act）→ admin-records.js 的 hub.adminRecordEdit，就地展开表单，
      // 不再需要"跳去另一个页面再回来"。三条动作（展开 / 取消 / 保存）都走委托，
      // 列表整块重渲染也不会丢监听——与文件顶部 13f 的其余动作同一套机制。
      act('record-edit', (el) => hub.adminRecordEdit && hub.adminRecordEdit(at(el, 'data-id')));
      act('record-edit-cancel', (el) => hub.adminRecordEditCancel && hub.adminRecordEditCancel(at(el, 'data-id')));
      act('record-edit-save', (el) => hub.adminRecordSave && hub.adminRecordSave(at(el, 'data-id')));
      // ⚠️ 2026-10-02 体验修复（举报 id 可点）：举报列表里的目标 id 走与「查看详情」同一处理，
      // 点击即打开用户详情弹层（复用 user-view，不新造一条跳转逻辑）。
      act('report-target-view', (el) => hub.viewUser && hub.viewUser(at(el, 'data-id')));
    }

    // ---- 供其它模块调用（admin.js 装配完毕后调用，见该文件）----
    hub.initUI = initUI;
  }

  function unmount() {
    // DOM / api.on 副作用全清
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
    // data-act 是 util.js 的**全局**委托表：覆盖为 noop，保证切走后台后
    // 其它页面的同名 data-act（若将来出现）不会误触发后台处理器。
    const UI = global.UI;
    _acts.forEach((name) => { try { UI.onAction(name, () => {}); } catch (_) {} });
    _acts = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.shell = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-records.js ==== */
/**
 * admin-records.js — 全部棋谱（admin 子模块）：KIF 导入、列表、搜索、回放/导出、就地编辑展示信息
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.records`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定 DOM 事件、导出 loadRecords / 就地编辑等到 ctx.hub，句柄记内部 teardown
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI）由 admin.js 的 mount 通过 `ctx` 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, renderPaged, setToken, toast, hub } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ---- 导入 KIF ----
    on($('btnImportKif'), 'click', () => {
      const fi = $('kifFileInput');
      if (fi) fi.click();
    });
    on($('kifFileInput'), 'change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      let okCount = 0, failCount = 0;
      const resultEl = $('importResult');
      if (resultEl) resultEl.textContent = `正在导入 ${files.length} 个棋谱...`;
      for (const file of files) {
        const text = await file.text();
        if (!alive()) return;
        try {
          const res = await fetch('/api/admin/records/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
            body: JSON.stringify({ text }),
          });
          if (!alive()) return;
          const data = await res.json();
          if (res.ok && data.ok) okCount++;
          else failCount++;
        } catch (_) { failCount++; }
      }
      if (!alive()) return;
      if (resultEl) resultEl.textContent = `导入完成：成功 ${okCount}，失败 ${failCount}`;
      e.target.value = '';
      loadRecords();
      if (failCount === 0 && okCount > 0) toast(`成功导入 ${okCount} 个棋谱`);
      else if (failCount > 0) toast(`导入完成：${okCount} 成功 / ${failCount} 失败`);
    });

    // ---- 全部棋谱 ----
    let allRecords = [];

    // ⚠️ 2026-10-02 体验修复（刷新按钮）：棋谱列表此前**没有**手动刷新入口——
    // 导完 KIF 或别处改了数据后，只能切走再切回来。这里补一个（每次 mount 绑一次）。
    on($('btnRefreshRecords'), 'click', () => loadRecords());

    async function loadRecords() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位，别让点开 tab 的头几百毫秒是空白
      const box = $('adminRecordList');
      if (box) box.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载棋谱…') : '';
      try {
        const data = await global.ApiUtils.get(`/api/history?adminToken=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allRecords = data.records || [];
        renderPaged('records', allRecords, 'recordPager', renderRecords);
      } catch (e) {
        if (!alive()) return;
        // token 失效则回到登录
        if (e.message && e.message.includes('403')) setToken(null);
        toast('加载棋谱失败');
        if (box) box.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty('加载棋谱失败，请确认登录状态后点「刷新」重试') : '';
        if (hub.initUI) hub.initUI();
      }
    }

    function renderRecords(records) {
      // ⚠️ 2026-10-02 体验修复：标题用**总数**（此前用当页条数，恒 ≤20）
      const cnt = $('recordCount');
      if (cnt) cnt.textContent = allRecords.length;
      const el = $('adminRecordList');
      if (!el) return;
      if (!records.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来没有"与"被搜索筛空"
        const q = ($('recordSearch') || {}).value || '';
        const msg = q.trim() ? '没有匹配关键词的棋谱（清空搜索框可看全部）' : '暂无棋谱';
        el.innerHTML = ctx.AdminUI ? ctx.AdminUI.empty(msg) : '';
        return;
      }
      el.innerHTML = records.map((r) => {
        const names = r.names || ['先手', '後手'];
        const res = r.result === 'b' ? `${names[0]} 胜` : r.result === 'w' ? `${names[1]} 胜` : (r.resultDetail || '和棋');
        // ⚠️ 2026-10-02 体验修复（"点完没有可见变化"）：把**可编辑的展示信息渲染出来**。
        // 此前列表只显示双方名与结果——管理员改完标题/标签/置顶后刷新列表，行内容一字不变，
        // 看起来就像"编辑没生效"。现在保存后这一行会立刻出现新标题/标签/📌。
        const m = r.meta || {};
        const metaBits = [];
        if (m.title) metaBits.push(esc(m.title));
        if (m.event) metaBits.push(esc(m.event));
        if (m.tags && m.tags.length) metaBits.push(m.tags.map((t) => `#${esc(t)}`).join(' '));
        const metaHtml = (m.featured || metaBits.length)
          ? `<div style="font-size:11px;color:var(--gold-light);margin-top:2px;">${m.featured ? '📌 ' : ''}${metaBits.join(' · ')}</div>` : '';
        return `
          <div class="record-item" data-rec-item="${esc(r.id)}">
            <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])} <span style="color:var(--text-dim);font-size:11px;">（${r.moveCount || 0}手）</span></div>
            <div class="r-result result-win">${esc(res)}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${global.I18N.fmt(r.createdAt)}</div>
            ${metaHtml}
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" data-act="rb-playback" data-id="${esc(r.id)}">回放</button>
              <button class="btn btn-ghost btn-sm" data-act="rb-export" data-id="${esc(r.id)}" data-fmt="kif">KIF</button>
              <button class="btn btn-ghost btn-sm" data-act="rb-export" data-id="${esc(r.id)}" data-fmt="csa">CSA</button>
              <button class="btn btn-ghost btn-sm" data-act="record-edit" data-id="${esc(r.id)}">✏️ 编辑</button>
            </div>
            <div data-rec-edit="${esc(r.id)}" style="display:none;margin-top:8px;"></div>
          </div>
        `;
      }).join('');
    }

    // ==================================================================
    // ⚠️ 2026-10-02 体验修复（棋谱就地编辑入口）
    //
    // 后端 `/api/admin/records/:id/meta`（写标题/赛事/轮次/日期/标签/简介/结果说明/置顶）
    // 早就存在并带审计，但管理端**完全没有入口**——只有靠手调 API。这里补一个就地表单：
    // 点「✏️ 编辑」在本行展开，保存后 toast + 重拉列表（改动能当场看见）。
    //
    // ⚠️ 关于「editArchived 无变化」：那是**赛事**的归档编辑（前端入口在
    // `public/js/tournament.js` 的 btnEditNoteTn → `/api/admin/tournaments/:id/edit`），
    // 不在本次改动的文件白名单内，故未改动；本条只负责棋谱（records）一侧的编辑入口与反馈，
    // 并把"保存后可见变化 + 成功/失败提示 + 列表刷新"这套反馈范式落实到本页。
    // ==================================================================
    const REC_META_FIELDS = [
      ['title', '标题'],
      ['event', '赛事'],
      ['round', '轮次'],
      ['playedOn', '日期'],
      ['description', '简介'],
      ['resultNote', '结果说明'],
    ];

    /** 按 data-rec-edit 精确找容器（不用属性选择器拼 id，避免 id 里出现特殊字符时选择器报错） */
    function findEditBox(id) {
      const boxes = document.querySelectorAll('[data-rec-edit]');
      for (const b of boxes) if (b.getAttribute('data-rec-edit') === String(id)) return b;
      return null;
    }

    function findRecord(id) {
      return allRecords.find((r) => String(r.id) === String(id)) || null;
    }

    /** 展开 / 收起某一行的就地编辑表单 */
    hub.adminRecordEdit = (id) => {
      const box = findEditBox(id);
      if (!box) return;
      if (box.style.display !== 'none' && box.innerHTML.trim()) { box.style.display = 'none'; return; }
      const r = findRecord(id);
      if (!r) return toast('未找到该棋谱（列表可能已刷新，请重试）');
      const m = r.meta || {};
      const fields = REC_META_FIELDS.map(([k, label]) =>
        `<label style="font-size:11px;color:var(--text-dim);display:block;">${label}
          <input class="input" data-rec-field="${k}" value="${esc(m[k] || '')}" style="width:100%;padding:5px 8px;font-size:12px;margin-top:2px;"></label>`).join('');
      box.innerHTML = `
        <div class="card" style="padding:12px;background:var(--bg-2);">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
            编辑展示信息（仅管理员；保存会记入审计日志）。留空即清除该字段。
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;">${fields}</div>
          <label style="font-size:11px;color:var(--text-dim);display:block;margin-top:8px;">标签（逗号分隔，最多 10 个）
            <input class="input" data-rec-field="tags" value="${esc((m.tags || []).join(', '))}" style="width:100%;padding:5px 8px;font-size:12px;margin-top:2px;"></label>
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin:8px 0 10px;">
            <input type="checkbox" data-rec-field="featured" ${m.featured ? 'checked' : ''}> 置顶（广场优先展示）
          </label>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary btn-sm" data-act="record-edit-save" data-id="${esc(id)}">保存</button>
            <button class="btn btn-ghost btn-sm" data-act="record-edit-cancel" data-id="${esc(id)}">取消</button>
          </div>
        </div>`;
      box.style.display = 'block';
      if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    };

    /** 取消编辑：收起表单即可（不改数据） */
    hub.adminRecordEditCancel = (id) => {
      const box = findEditBox(id);
      if (box) box.style.display = 'none';
    };

    /** 读表单 → 组装 patch（仅允许字段；字段名与 src/records.js 的 META_FIELDS 对齐） */
    function readEditBox(box) {
      const patch = {};
      box.querySelectorAll('[data-rec-field]').forEach((el) => {
        const k = el.getAttribute('data-rec-field');
        if (k === 'featured') patch.featured = el.checked;
        else if (k === 'tags') patch.tags = el.value.split(',').map((s) => s.trim()).filter(Boolean);
        else patch[k] = el.value;
      });
      return patch;
    }

    hub.adminRecordSave = async (id) => {
      const box = findEditBox(id);
      if (!box) return;
      const r = findRecord(id);
      const who = (r && r.names ? r.names.join(' vs ') : id);
      // ⚠️ 2026-10-02 体验修复（危险操作确认）：保存会**覆盖**既有展示信息（且影响公开广场），
      // 先给一次二次确认；确认框里带上"改的是哪盘"避免看错行。
      if (!confirm(`确定保存对棋谱「${who}」的展示信息修改？`)) return;
      try {
        const res = await fetch(`/api/admin/records/${encodeURIComponent(id)}/meta`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify(readEditBox(box)),
        });
        if (!alive()) return;
        const data = await res.json().catch(() => ({}));
        if (!alive()) return;
        if (res.status === 403 || res.status === 401) {
          setToken(null);
          toast('登录已过期，请重新登录');
          if (hub.initUI) hub.initUI();
          return;
        }
        if (!res.ok || data.ok === false) {
          // 失败也要说清楚（含后端返回的原因，如"棋谱不存在"）
          toast((data && data.error) || `保存失败（HTTP ${res.status}）`);
          return;
        }
        // 成功：toast + 收起表单 + 重拉列表（列表里会出现新标题/标签/📌，肉眼可见）
        toast('棋谱展示信息已保存');
        box.style.display = 'none';
        await loadRecords();
      } catch (e) {
        if (!alive()) return;
        toast('保存失败：' + e.message);
      }
    };

    // 回放/导出必须携带管理员 token（否则 403）
    hub.adminPlayback = (id) => {
      // 站内整页跳转 → SPA 路由（铁律3）
      global.Router.navigate(`review.html?id=${id}&adminToken=${encodeURIComponent(getToken() || '')}`);
    };
    hub.adminExport = (id, fmt) => {
      // ⚠️ 例外（铁律3）：指向 /api/... 的导出/下载链接保留 location.href（那是下载不是跳页）
      location.href = `/api/records/${id}/export?fmt=${fmt}&token=${encodeURIComponent(getToken() || '')}`;
    };

    // 棋谱搜索（按选手名/ID）
    on($('recordSearch'), 'input', (e) => {
      const q = (e.target.value || '').trim().toLowerCase();
      if (!q) return renderPaged('records', allRecords, 'recordPager', renderRecords, true);
      renderPaged('records', allRecords.filter((r) => {
        const names = (r.names || []).join(' ').toLowerCase();
        const ids = [r.playerIds && r.playerIds.b, r.playerIds && r.playerIds.w].filter(Boolean).join(' ').toLowerCase();
        return names.includes(q) || ids.includes(q);
      }), 'recordPager', renderRecords, true);
    });

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadRecords = loadRecords;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.records = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-users.js ==== */
/**
 * admin-users.js — 全部用户（admin 子模块）：列表、搜索、用户详情弹层与管理操作
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.users`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定 DOM 事件、导出 loadUsers / viewUser / 管理操作等到 ctx.hub
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI / fmtTime）由 admin.js 的 mount 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, maskIp, renderPaged, setToken, toast, hub, fmtTime } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ---- 全部用户 ----
    let allUsers = [];

    // ⚠️ 2026-10-02 体验修复（刷新按钮）：用户列表此前**没有**手动刷新入口——
    // 看到某个用户状态变了（封禁/改名），只能切走再切回来才能重新拉。这里补一个。
    on($('btnRefreshUsers'), 'click', () => loadUsers());

    async function loadUsers() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位，避免点开 tab 先看到空白
      const box = $('adminUserList');
      if (box) box.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载用户…') : '';
      try {
        const data = await global.ApiUtils.get(`/api/admin/users?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allUsers = data.users || [];
        renderPaged('users', allUsers, 'userPager', renderUsers);
      } catch (e) {
        if (!alive()) return;
        if (e.message && e.message.includes('403')) setToken(null);
        toast('加载用户失败');
        if (box) box.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty('加载用户失败，请确认登录状态后点「刷新」重试') : '';
        if (hub.initUI) hub.initUI();
      }
    }

    function renderUsers(users) {
      // ⚠️ 2026-10-02 体验修复：标题用**总数**（此前用当页条数，恒 ≤20）
      const cnt = $('userCount');
      if (cnt) cnt.textContent = allUsers.length;
      const el = $('adminUserList');
      if (!el) return;
      if (!users.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来没用户"与"被搜索筛空"
        const q = ($('userSearch') || {}).value || '';
        el.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty(q.trim() ? '没有匹配关键词的用户（清空搜索框可看全部）' : '暂无用户') : '';
        return;
      }
      el.innerHTML = users.map((u) => `
    <div class="record-item">
      <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
        <span>${u.isAccount ? '<span title="正式账号">🔐</span>' : '<span title="游客">👤</span>'} ${esc(u.name)}${u.title ? `（${esc(u.title)}）` : ''} <span style="color:var(--text-dim);font-size:11px;">(${u.id})</span></span>
        <span style="font-size:11px;">${u.banned ? '<span style="color:var(--red-light);">⛔ 封禁中</span>' : ''}</span>
      </div>
      <div class="r-result result-win">Lv.${u.level || 0} · ELO ${u.rating}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${u.games} 局 · 胜 ${u.wins} / 负 ${u.losses} / 平 ${u.draws} · 胜率 ${u.winRate}% · 经验 ${u.exp || 0} · 积分 ${u.points || 0}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">🌐 最近 IP：${u.lastIp ? `<span title="点击展开完整 IP" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="reveal-ip" data-text="${esc(u.lastIp)}">${esc(maskIp(u.lastIp))}</span>` : '—'}${u.lastSeen ? ` · <span title="最后活跃时间">${global.I18N.fmt(u.lastSeen)}</span>` : ''}</div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn btn-ghost btn-sm" data-act="user-view" data-id="${esc(u.id)}">查看详情</button>
        ${u.banned
          ? `<button class="btn btn-ghost btn-sm" data-act="user-unban" data-id="${esc(u.id)}" data-name="${esc(u.name)}">解封</button>`
          : `<button class="btn btn-ghost btn-sm" data-act="user-ban" data-id="${esc(u.id)}" data-name="${esc(u.name)}">封禁</button>`}
      </div>
    </div>
  `).join('');
    }

    // 用户搜索
    on($('userSearch'), 'input', (e) => {
      const q = (e.target.value || '').trim().toLowerCase();
      if (!q) return renderPaged('users', allUsers, 'userPager', renderUsers, true);
      renderPaged('users', allUsers.filter((u) =>
        (u.name || '').toLowerCase().includes(q) || (u.id || '').toLowerCase().includes(q)), 'userPager', renderUsers, true);
    });

    // ---- 用户详情 + 管理操作（PLAN §K4）----
    const STYLE_OPTIONS = ['不设定', '居飞车·急战', '居飞车·持久战', '振飞车', '力战型', '奇袭型', '接受型'];
    const VIEWED_ID = { v: null }; // 详情弹层当前用户（编辑资料保存时用）

    async function adminPost(path, body = {}, method = 'POST') {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      // 非 JSON 响应（如 404 HTML）多半是服务端没重启跑的旧代码——把状态码亮出来便于判断
      if (!res.ok || data.ok === false) {
        throw new Error((data && data.error) || `请求失败（HTTP ${res.status}，若为 404 请确认服务进程已重启）`);
      }
      return data;
    }

    hub.viewUser = async (id) => {
      try {
        const data = await global.ApiUtils.get(`/api/admin/users/${id}?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        VIEWED_ID.v = id;
        const nameEl = $('detailUserName');
        if (nameEl) nameEl.textContent = data.title ? `${data.name}（${data.title}）` : data.name;
        const p = data.profile;
        const recs = data.records || [];
        const net = data.net || null;
        const banned = data.banned || null;
        const events = data.events || [];
        const styleOpts = STYLE_OPTIONS.map((s) =>
          `<option value="${s}" ${s === (data.style || '不设定') ? 'selected' : ''}>${s}</option>`).join('');
        const bodyEl = $('detailBody');
        if (!bodyEl) return;
        bodyEl.innerHTML = `
      ${banned ? `<div style="background:rgba(176,58,46,0.15);border:1px solid var(--red-light);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;">
        ⛔ <b>封禁中</b>${banned.reason ? '：' + esc(banned.reason) : ''}${banned.until ? `（至 ${fmtTime(banned.until)}）` : '（永久）'}
      </div>` : ''}
      <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px;">
        <div class="card stat-card"><div class="num">${p.rating}</div><div class="label">ELO</div></div>
        <div class="card stat-card"><div class="num">${p.games}</div><div class="label">对局</div></div>
        <div class="card stat-card"><div class="num">${p.wins}</div><div class="label">胜</div></div>
        <div class="card stat-card"><div class="num">${p.losses}</div><div class="label">负</div></div>
      </div>
      ${data.phone ? `<div style="font-size:13px;margin-bottom:10px;">📱 手机号：<span style="color:var(--gold-light);">${esc(data.phone)}</span> <span style="color:var(--text-dim);font-size:11px;">（私密字段，仅管理员可见）</span></div>` : ''}
      <div style="font-size:14px;font-weight:700;margin:8px 0;">🌐 登录信息 <span style="font-size:11px;color:var(--text-dim);font-weight:400;">（隐私，仅管理员可见）</span></div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
        ${net
          ? `首次：${esc(net.firstIp || '—')}（${fmtTime(net.firstSeenAt)}）<br>最近：${esc(net.lastIp || '—')}（${fmtTime(net.lastSeenAt)}）<br>UA：${esc(net.lastUa || '—')}`
          : '暂无网络记录（旧会话或尚未连接过）'}
      </div>
      <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">✏️ 编辑资料</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:6px;">
        <div><div style="font-size:11px;color:var(--text-dim);">手机号（私密）</div>
          <input class="input" id="editPhone" value="${esc(data.phone || '')}" placeholder="11 位，留空清除" maxlength="11" style="width:150px;"></div>
        <div><div style="font-size:11px;color:var(--text-dim);">棋风</div>
          <select class="input" id="editStyle" style="width:150px;">${styleOpts}</select></div>
        <div style="flex:1;min-width:200px;"><div style="font-size:11px;color:var(--text-dim);">用户称号（展示为「名称（称号）」，留空清除）</div>
          <input class="input" id="editTitle" value="${esc(data.title || '')}" maxlength="12" style="width:100%;"></div>
        <button class="btn btn-primary btn-sm" data-act="user-save-profile" data-id="${esc(id)}">保存资料</button>
      </div>
      <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">📊 等级与 ELO <span style="font-size:11px;color:var(--text-dim);font-weight:400;">（Lv.${p.level} · 经验 ${p.exp} · 积分 ${p.points || 0}；等级随经验自动推导）</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:6px;">
        <div><div style="font-size:11px;color:var(--text-dim);">ELO（100-5000）</div>
          <input class="input" id="editElo" value="${p.rating}" style="width:110px;"></div>
        <div><div style="font-size:11px;color:var(--text-dim);">经验（≥0）</div>
          <input class="input" id="editExp" value="${p.exp || 0}" style="width:110px;"></div>
        <button class="btn btn-primary btn-sm" data-act="user-save-elo" data-id="${esc(id)}">保存 ELO/经验</button>
      </div>
      <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">🛠️ 管理操作</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        <button class="btn btn-ghost btn-sm" data-act="user-rename" data-id="${esc(id)}" data-name="${esc(data.name)}">✏️ 改名</button>
        <button class="btn btn-ghost btn-sm" data-act="user-reset-rating" data-id="${esc(id)}" data-name="${esc(data.name)}">♻️ 重置 ELO</button>
        <button class="btn btn-ghost btn-sm" data-act="user-reset-pwd" data-id="${esc(id)}" data-name="${esc(data.name)}">🔑 重置密码</button>
        ${banned
          ? `<button class="btn btn-primary btn-sm" data-act="user-unban" data-id="${esc(id)}" data-name="${esc(data.name)}">✅ 解封</button>`
          : `<button class="btn btn-ghost btn-sm" data-act="user-ban" data-id="${esc(id)}" data-name="${esc(data.name)}">⛔ 封禁</button>`}
        ${data.isAccount ? `<button class="btn btn-ghost btn-sm" data-act="user-delete" data-id="${esc(id)}" data-name="${esc(data.name)}" style="color:var(--red-light);">🗑 删除账号</button>` : ''}
      </div>
      <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">🕘 最近登录记录（${events.length}）</div>
      ${events.length ? `<div style="max-height:180px;overflow-y:auto;margin-bottom:10px;">${events.map((e) => `
        <div style="font-size:11px;padding:3px 0;border-bottom:1px solid rgba(128,128,128,0.12);color:var(--text-dim);">
          ${fmtTime(e.ts)} · <span style="color:var(--gold-light);">${esc(e.ip || '—')}</span> · ${esc(e.ua || '—')}
        </div>`).join('')}</div>` : '<div style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">暂无记录</div>'}
      <div style="font-size:14px;font-weight:700;margin:8px 0;">对局记录（${recs.length}）</div>
      ${recs.length ? recs.map((r) => {
        const names = r.names || ['先手', '後手'];
        const res = r.result === 'b' ? `${names[0]}胜` : r.result === 'w' ? `${names[1]}胜` : (r.resultDetail || '和棋');
        return `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,0.15);">${esc(names[0])} vs ${esc(names[1])} — ${esc(res)}（${r.moveCount || 0}手）</div>`;
      }).join('') : '<div style="color:var(--text-dim);font-size:12px;">暂无对局</div>'}
    `;
        const detailModal = $('userDetailModal');
        if (!detailModal) return;
        detailModal.style.display = 'flex';
        if (global.A11y) global.A11y.onDialogOpen(detailModal, {
          onClose: () => { detailModal.style.display = 'none'; if (global.A11y) global.A11y.onDialogClose(detailModal); },
        });
      } catch (e) {
        if (!alive()) return;
        toast('加载用户详情失败');
      }
    };

    hub.adminSaveProfile = async (id) => {
      const phone = $('editPhone') ? $('editPhone').value.trim() : '';
      const style = $('editStyle') ? $('editStyle').value : '';
      const title = $('editTitle') ? $('editTitle').value.trim() : '';
      try {
        await adminPost(`/api/admin/users/${id}/profile`, { phone, style, title });
        if (!alive()) return;
        toast('资料已保存');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminSaveElo = async (id) => {
      const rating = parseInt($('editElo') && $('editElo').value, 10);
      const exp = parseInt($('editExp') && $('editExp').value, 10);
      if (!Number.isFinite(rating) || !Number.isFinite(exp)) return toast('ELO 与经验需为整数');
      try {
        await adminPost(`/api/admin/users/${id}/elo`, { rating, exp });
        if (!alive()) return;
        toast('ELO/经验已保存');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminRename = async (id, oldName) => {
      const name = prompt(`修改「${oldName}」的显示名（≤16 字，不改账号登录用户名）：`, oldName);
      if (name === null || !name.trim()) return;
      // ⚠️ 2026-10-02 体验修复（危险操作确认）：改名会**即时**改变对局内双方看到的名字，
      // 且存在"改成与他人类似的名字冒充"的风险——按封禁/重置/删除同一口径补一次二次确认。
      if (!confirm(`确定把显示名「${oldName}」改为「${name.trim()}」？\n改后对手在对局内会立即看到新名字。`)) return;
      try {
        await adminPost(`/api/admin/users/${id}/rename`, { name: name.trim() });
        if (!alive()) return;
        toast('已改名（对局内对手即时可见）');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminResetRating = async (id, name) => {
      if (!confirm(`确定重置「${name}」的 ELO 与战绩？不可恢复。`)) return;
      try {
        await adminPost(`/api/admin/users/${id}/reset-rating`, {});
        if (!alive()) return;
        toast('已重置评级与战绩');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminResetPassword = async (id, name) => {
      if (!confirm(`确定重置「${name}」的密码？其全部已登录会话将被强制失效。`)) return;
      try {
        const r = await adminPost(`/api/admin/users/${id}/reset-password`, {});
        if (!alive()) return;
        prompt('新密码（仅此一次显示，请转交用户）：', r.password || '');
        toast('密码已重置');
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminBan = async (id, name) => {
      const reason = prompt(`封禁「${name}」的原因（可留空）：`);
      if (reason === null) return;
      const daysStr = prompt('封禁天数（留空或 0 = 永久）：', '');
      if (daysStr === null) return;
      const days = parseFloat(daysStr) || 0;
      if (!confirm(`确定封禁「${name}」${days > 0 ? days + ' 天' : '（永久）'}？该用户将被强制下线。`)) return;
      try {
        const r = await adminPost(`/api/admin/users/${id}/ban`, { reason, days });
        if (!alive()) return;
        toast(`已封禁${r.kicked ? `（踢下线 ${r.kicked} 个连接）` : ''}`);
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminUnban = async (id, name) => {
      if (!confirm(`确定解封「${name}」？`)) return;
      try {
        await adminPost(`/api/admin/users/${id}/unban`, {});
        if (!alive()) return;
        toast('已解封');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminDeleteAccount = async (id, name) => {
      const c = prompt(`⚠️ 删除账号「${name}」不可恢复（棋谱保留、评级清空）。\n输入 DELETE 确认：`);
      if (c === null) return;
      if (c !== 'DELETE' && c !== name) return toast('确认输入不正确，未删除');
      try {
        await adminPost(`/api/admin/users/${id}`, { confirm: c }, 'DELETE');
        if (!alive()) return;
        toast('账号已删除');
        const dmClose = $('userDetailModal');
        if (dmClose) {
          dmClose.style.display = 'none';
          if (global.A11y) global.A11y.onDialogClose(dmClose);
        }
        loadUsers();
      } catch (e) { if (alive()) toast(e.message); }
    };

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadUsers = loadUsers;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.users = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-audit.js ==== */
/**
 * admin-audit.js — 操作审计（admin 子模块）
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.audit`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定筛选控件、导出 loadAudit 到 ctx.hub，句柄记内部 teardown
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI / fmtTime）由 admin.js 的 mount 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, maskIp, renderPaged, setToken, toast, hub, fmtTime } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ---- 操作审计（PLAN §K4）----
    let allAudit = [];

    // ⚠️ 2026-10-02 体验修复（审计筛选 + 分页）：分页此前已有（renderPaged + auditPager），
    // 但只能从头一页页翻着找记录；这里补上「动作 / 结果 / 时间」三维筛选——
    // 三者都在**前端**对已下载的这批记录（接口一次最多 200 条）做过滤，不额外打服务端。
    // 筛选变化时回到第 1 页（否则筛选后停在旧页码上会看到"空列表"，与举报页同款取巧）。
    const auditFilter = { action: '', ok: '', hours: '' };
    let auditFilterReady = false;

    /** 统一取列表容器 */
    function auditListEl() { return $('auditList'); }

    async function loadAudit() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位——此前是上一轮的残留/一片空白，
      // 点开 tab 的头几百毫秒看起来像页面坏了（尤其这条接口是 heavy 限流档）。
      const box = auditListEl();
      if (box) box.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载审计记录…') : '';
      try {
        const data = await global.ApiUtils.get(`/api/admin/audit?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allAudit = data.events || [];
        initAuditFilters();
        renderAuditFiltered(false);
      } catch (e) {
        if (!alive()) return;
        if (e.message && (e.message.includes('403') || e.message.includes('401'))) {
          setToken(null);
          // ⚠️ 2026-10-02 体验修复：令牌过期/失效时回退到登录态（此前只清 token，
          // 页面仍停在后台样式 → 后续每个请求继续 403，看起来像后台彻底坏了）。
          // 铁律3：整页 location.reload() → SPA 路由重挂当前视图（回到登录卡片）。
          global.Router.reload();
          return;
        }
        toast('加载审计记录失败');
        if (box) box.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty(`加载审计记录失败：${(e && e.message) || '网络错误'}`) : '';
      }
    }

    /** 时间范围（小时）→ 起始时间戳；未选则返回 0（不过滤） */
    function auditSince() {
      const h = parseFloat(auditFilter.hours);
      return Number.isFinite(h) && h > 0 ? Date.now() - h * 3600 * 1000 : 0;
    }

    /** 按当前筛选条件过滤全量记录 */
    function filteredAudit() {
      const since = auditSince();
      return allAudit.filter((e) => {
        if (auditFilter.action && String(e.action || '') !== auditFilter.action) return false;
        if (auditFilter.ok === '1' && !e.ok) return false;   // 仅成功
        if (auditFilter.ok === '0' && e.ok) return false;    // 仅失败
        if (since && !(Number(e.ts) >= since)) return false; // 时间窗
        return true;
      });
    }

    /**
     * 用当前筛选结果重画列表。
     * @param {boolean} reset 仅**筛选条件变化**时传 true（回到第 1 页）；
     *   翻页路径（adminPage → loadAudit）必须传 false，否则每次翻页都被重置回第 1 页。
     */
    function renderAuditFiltered(reset) {
      const list = filteredAudit();
      renderPaged('audit', list, 'auditPager', renderAudit, !!reset);
      const hint = $('auditFilterHint');
      if (hint) {
        const active = !!(auditFilter.action || auditFilter.ok || auditFilter.hours);
        hint.textContent = active
          ? `已筛选：命中 ${list.length} / 共 ${allAudit.length} 条`
          : `共 ${allAudit.length} 条`;
      }
    }

    /**
     * 初始化筛选控件：动作下拉按**实际出现过的动作**填充；三个控件与"清除筛选"每次 mount 绑一次。
     *（控件是 render() 里的静态元素，不像列表那样整块重建；unmount 统一解绑。）
     */
    function initAuditFilters() {
      const actSel = $('auditAction');
      const okSel = $('auditOk');
      const rngSel = $('auditRange');
      if (actSel) {
        const acts = [...new Set(allAudit.map((e) => String(e.action || '')).filter(Boolean))].sort();
        const keep = auditFilter.action;
        actSel.innerHTML = '<option value="">全部</option>'
          + acts.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
        actSel.value = acts.includes(keep) ? keep : '';
        auditFilter.action = actSel.value;
      }
      if (auditFilterReady) return;
      auditFilterReady = true;
      if (actSel) on(actSel, 'change', () => { auditFilter.action = actSel.value; renderAuditFiltered(true); });
      if (okSel) on(okSel, 'change', () => { auditFilter.ok = okSel.value; renderAuditFiltered(true); });
      if (rngSel) on(rngSel, 'change', () => { auditFilter.hours = rngSel.value; renderAuditFiltered(true); });
      const resetBtn = $('btnAuditReset');
      if (resetBtn) on(resetBtn, 'click', () => {
        auditFilter.action = '';
        auditFilter.ok = '';
        auditFilter.hours = '';
        if (actSel) actSel.value = '';
        if (okSel) okSel.value = '';
        if (rngSel) rngSel.value = '';
        renderAuditFiltered(true);
      });
    }

    /**
     * ⚠️ 2026-10-02 体验修复（审计 IP 掩码）：来源 IP 默认只显示到**网段**（maskIp），
     * 点击可展开完整地址。IP 属隐私数据，审计页又最容易被整屏截图——默认掩码挡掉
     * "随手截图外流"；保留网段则不牺牲可核对性（同一网段的操作仍能对上号）。
     * 复用与用户列表 / IP 封禁页同一个 `reveal-ip` 动作（admin-shell.js 已注册还原逻辑）。
     */
    function auditIpHtml(ip) {
      if (!ip) return '—';
      return `<span title="点击展开完整 IP" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="reveal-ip" data-text="${esc(ip)}">${esc(maskIp(ip))}</span>`;
    }

    function renderAudit(events) {
      // ⚠️ 2026-10-02 体验修复：标题数字用**总数**（此前用当页条数，恒 ≤20，管理员会误判量级）
      const cnt = $('auditCount');
      if (cnt) cnt.textContent = allAudit.length;
      const el = $('auditList');
      if (!el) return;
      if (!events.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来就空"与"被筛空"，
        // 免得筛完没结果时让人以为审计坏了。
        const filtered = !!(auditFilter.action || auditFilter.ok || auditFilter.hours);
        const msg = filtered ? '没有符合当前筛选的操作记录（可点「清除筛选」）' : '暂无管理员操作记录';
        el.innerHTML = ctx.AdminUI ? ctx.AdminUI.empty(msg) : '';
        return;
      }
      el.innerHTML = events.map((e) => `
        <div class="record-item">
          <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
            <span>${esc(e.action)} ${e.targetId ? `<span style="color:var(--text-dim);font-size:11px;">→ ${esc(e.targetId)}</span>` : ''}</span>
            <span style="font-size:11px;color:${e.ok ? 'var(--green)' : 'var(--red-light)'};">${e.ok ? '成功' : '失败'}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
            ${fmtTime(e.ts)} · 来源 IP：${auditIpHtml(e.adminIp)}${e.detail ? ` · ${esc(JSON.stringify(e.detail))}` : ''}
          </div>
        </div>
      `).join('');
    }

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadAudit = loadAudit;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.audit = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-tournaments.js ==== */
/**
 * admin-tournaments.js — 赛事管理（admin 子模块）：审核队列、取消、存档
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.tournaments`）——加载本文件零副作用：
 *   mount(ctx)  → 导出 loadTournaments / 审核动作等到 ctx.hub（无静态 DOM 绑定，纯渲染函数）
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / pages / fmtTs）由 admin.js 的 mount 通过 `ctx` 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清；本模块目前无静态监听，预留一致性） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, pages, setToken, toast, hub, fmtTs } = ctx;
    const alive = () => ctx.isAlive();

    // ---- 赛事管理（PLAN §E：审核队列 / 取消）----
    let allTournaments = [];
    const TN_STATUS_LABEL = {
      pending_approval: '🕐 待审核',
      // T1 起「报名中」的状态名是 `registration`；保留 `open` 仅作兜底
      registration: '📌 报名中',
      open: '📌 报名中',
      playing: '⚔️ 比赛中',
      finished: '🏆 已结束',
      archived: '📦 已存档',
      rejected: '❌ 已拒绝',
      cancelled: '⛔ 已取消',
    };

    async function loadTournaments() {
      try {
        const data = await global.ApiUtils.get(`/api/admin/tournaments?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allTournaments = data.tournaments || [];
        // 赛事 tab **刻意不分页**：它内部已按「待审核 / 进行中 / 历史」分三块渲染，
        // 整体切片会打乱这个分组（比如某页只剩"历史"没有"待审核"）。
        // 历史块自带 max-height + 滚动，赛事数量级也远小于棋谱/用户，暂不需要。
        renderTournaments(allTournaments);
      } catch (e) {
        if (!alive()) return;
        if (e.message && e.message.includes('403')) setToken(null);
        if (hub.initUI) hub.initUI();
      }
    }

    /** 已确认参赛人数：开赛后看 players，报名阶段看 entrants 里 approved 的数量 */
    function tnJoinedCount(t) {
      const s = t.status;
      if (s === 'playing' || s === 'finished' || s === 'archived') return t.playerCount || 0;
      return (t.entrants || []).filter((e) => e.status === 'approved').length;
    }

    function renderTournaments(list) {
      const cnt = $('tnCount');
      if (cnt) cnt.textContent = list.length;
      const pending = list.filter((t) => t.status === 'pending_approval');
      // ⚠️ T1 起「报名中」的状态名是 `registration`（旧的 `open` 由服务端出口映射过来）
      const active = list.filter((t) => t.status === 'registration' || t.status === 'playing');
      // T1 起多了 `archived`（已存档）——与 finished 同属历史
      const history = list.filter((t) => ['finished', 'archived', 'rejected', 'cancelled'].includes(t.status));
      const stats = $('tnStats');
      if (stats) stats.textContent =
        `待审核 ${pending.length} · 进行中 ${active.length} · 累计 ${list.length}`;
      fillTnList('tnPendingList', 'tnPendingPager', 'tnPending', pending, '没有待审核的赛事申请');
      fillTnList('tnActiveList', 'tnActivePager', 'tnActive', active, '暂无进行中的赛事');
      fillTnList('tnHistoryList', 'tnHistoryPager', 'tnHistory', history, '暂无历史赛事');
    }

    /**
     * 渲染一个赛事列表 + 分页条（需求 13：**一页只显示 20 个**，避免数据库信息过多时爆炸）。
     * 三个列表各自独立记页码（共用 `pages`，键为 `tnPending` / `tnActive` / `tnHistory`）。
     */
    function fillTnList(listElId, pagerElId, key, fullList, emptyText) {
      const el = $(listElId);
      if (!el) return;
      if (!fullList.length) {
        el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${emptyText}</div>`;
        global.UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
        return;
      }
      const pg = global.UI.paginate({
        items: fullList,
        page: pages[key] || 1,
        size: 20,
        container: pagerElId,
        onPage: (n) => {
          pages[key] = n;
          // 只重画这一个列表：重新拉全量再整页重绘代价太大（管理员赛事数量本就不少）
          fillTnList(listElId, pagerElId, key, fullList, emptyText);
        },
      });
      pages[key] = pg.page;
      el.innerHTML = pg.slice.map((t) => {
        const approved = tnJoinedCount(t);
        const pendingN = (t.entrants || []).filter((e) => e.status === 'pending').length;
        const meta = [
          // 赛制要显示出来：T8 起有瑞士制，审核与排障时"这是哪种赛制"是首要信息
          t.formatLabel || (t.format === 'swiss' ? '瑞士制' : '单败淘汰'),
          `${approved}/${t.size} 人${pendingN ? `（待批准 ${pendingN}）` : ''}`,
          (t.format === 'swiss' && t.totalRounds)
            ? `第 ${t.currentRound || 0}/${t.totalRounds} 轮` : '',
          t.ownerName ? `主办 ${esc(t.ownerName)}` : '',
          global.I18N.fmt(t.createdAt),
        ].filter(Boolean).join(' · ');

        // ---- 申请表信息（T2）：审核时最需要看的就是"为什么办、什么时候办" ----
        const schedule = [
          (t.registerStart || t.registerEnd) ? `报名 ${fmtTs(t.registerStart)} ~ ${fmtTs(t.registerEnd)}` : '',
          (t.matchStart || t.matchEnd) ? `比赛 ${fmtTs(t.matchStart)} ~ ${fmtTs(t.matchEnd)}` : '',
          t.requireApproval === false ? '报名<b>免</b>审核' : '报名需审核',
        ].filter(Boolean).join(' · ');
        const applyInfo = `
      <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">📅 ${schedule}</div>
      ${t.reason ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">📝 理由：${esc(t.reason)}</div>` : ''}`;

        let actions = '';
        if (t.status === 'pending_approval') {
          actions = `
        <button class="btn btn-primary btn-sm" data-act="tn-approve" data-id="${esc(t.id)}">✓ 通过</button>
        <button class="btn btn-ghost btn-sm" data-act="tn-reject" data-id="${esc(t.id)}">✗ 拒绝</button>`;
        } else if (t.status === 'registration' || t.status === 'playing') {
          actions = `<button class="btn btn-ghost btn-sm" data-act="tn-cancel" data-id="${esc(t.id)}">⛔ 取消赛事</button>`;
        } else if (t.status === 'finished') {
          // T6：存档（存档后主办人只读，管理员仍可编辑）
          actions = `<button class="btn btn-ghost btn-sm" data-act="tn-archive" data-id="${esc(t.id)}">📦 存档</button>`;
        }
        // 所有状态都能进详情页（那里有对阵表、赛事棋谱、重赛与变更记录）
        actions += `<a class="btn btn-ghost btn-sm" href="tournament.html?id=${encodeURIComponent(t.id)}" target="_blank">详情 ↗</a>`;
        // ⚠️ `t.reason` 的语义在 T1 变了：旧数据里它才是"拒绝/取消原因"，
        // 现在是"举办理由"。拒绝原因读 `rejectReason`——服务端出口已按状态做过归位。
        const rejectReason = t.rejectReason
          ? `<div style="font-size:11px;color:var(--red-light);margin-top:3px;">原因：${esc(t.rejectReason)}</div>` : '';
        const champ = (t.status === 'finished' && t.championId && t.players)
          ? `<div style="font-size:12px;color:var(--gold-light);margin-top:3px;">🏆 冠军：${esc((t.players.find((p) => p.id === t.championId) || {}).name || '—')}</div>` : '';
        return `
      <div class="record-item">
        <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
          <span>${esc(t.name)}</span>
          <span style="color:var(--text-dim);font-size:12px;">${TN_STATUS_LABEL[t.status] || t.status}</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${meta}</div>
        ${applyInfo}${rejectReason}${champ}
        ${actions ? `<div style="display:flex;gap:6px;margin-top:8px;">${actions}</div>` : ''}
      </div>
    `;
      }).join('');
    }

    async function tnAction(id, action, reason) {
      try {
        const res = await fetch(`/api/admin/tournaments/${id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify({ reason: reason || '' }),
        });
        if (!alive()) return false;
        const data = await res.json();
        if (!alive()) return false;
        if (!res.ok || !data.ok) {
          toast((data && data.error) || '操作失败');
          return false;
        }
        const suffix = action === 'cancel' && data.dissolvedMatches ? `（已解散 ${data.dissolvedMatches} 场对局）` : '';
        toast(action === 'approve' ? '已通过审核' : action === 'reject' ? '已拒绝' : `已取消${suffix}`);
        loadTournaments();
        return true;
      } catch (_) {
        if (alive()) toast('网络错误');
        return false;
      }
    }
    hub.tnApprove = (id) => tnAction(id, 'approve');
    hub.tnReject = (id) => {
      const reason = prompt('拒绝原因（可留空）：');
      if (reason === null) return;
      tnAction(id, 'reject', reason);
    };
    hub.tnCancel = (id) => {
      const name = (allTournaments.find((t) => t.id === id) || {}).name || '';
      if (!confirm(`确定取消赛事「${name}」？进行中的对局将被解散。`)) return;
      const reason = prompt('取消原因（可留空）：');
      if (reason === null) return;
      tnAction(id, 'cancel', reason);
    };

    // 存档赛事（T6/需求 11）：复用 `tnAction`——同样是 `/api/admin/tournaments/:id/:action`
    // 的 POST + 审计落盘，没必要另写一份 fetch。
    hub.tnArchive = (id) => {
      const name = (allTournaments.find((t) => t.id === id) || {}).name || '';
      if (!confirm(`确定存档赛事「${name}」？\n存档后主办人转为只读，仅管理员可继续编辑。`)) return;
      tnAction(id, 'archive');
    };

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadTournaments = loadTournaments;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.tournaments = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-moderation.js ==== */
/**
 * admin-moderation.js — 违规处理（admin 子模块）：IP 封禁 + 举报
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.moderation`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定筛选/表单事件、导出 loadIpBans / loadReports 到 ctx.hub
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / pages / 分页 / AdminUI / fmtTs）由 admin.js 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, maskIp, pages, renderPaged, toast, hub, fmtTs } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ==================================================================
    // IP 封禁（PLAN §X）
    //
    // ⚠️ 服务端会**再判一次"不能封自己"**（见 `src/http/routes/admin.js`）——
    // 前端这里只是提前提示，判定以后端为准（前端判定可被绕过）。
    // ==================================================================
    let allBans = [];
    let ipbMyIp = null;
    let ipbDurations = [];
    let ipbFormReady = false;

    async function loadIpBans() {
      try {
        const res = await fetch('/api/admin/ipbans', { headers: { 'x-admin-token': getToken() } });
        if (!alive()) return;
        const data = await res.json();
        if (!alive()) return;
        if (!res.ok) { toast((data && data.error) || '加载失败'); return; }
        allBans = data.bans || [];
        ipbMyIp = data.myIp || null;
        ipbDurations = data.durations || [];
        initIpBanForm();
        renderIpBans();
      } catch (e) { if (alive()) toast('加载失败：' + e.message); }
    }

    // ==================================================================
    // 举报处理（2026-09-20）
    // ==================================================================
    let allReports = [];
    // ⚠️ 声明必须在 `renderReports` 之前：虽然调用发生在加载完成之后、运行时踩不到 TDZ，
    // 但"先用后声明"读起来就像 bug，下一个改这里的人会先愣一下。
    let reportCategories = [];

    async function loadReports() {
      const rpFilter = $('rpFilter');
      const status = rpFilter ? rpFilter.value : '';
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位，别让切过来先看到一片空白
      const rpBox = $('rpList');
      if (rpBox) rpBox.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载举报…') : '';
      try {
        const res = await fetch(`/api/admin/reports?status=${encodeURIComponent(status)}`, {
          headers: { 'x-admin-token': getToken() },
        });
        if (!alive()) return;
        const data = await res.json();
        if (!alive()) return;
        if (!res.ok) { toast((data && data.error) || '加载失败'); return; }
        allReports = data.reports || [];
        reportCategories = data.categories || reportCategories;
        const pendEl = $('rpPending');
        if (pendEl) pendEl.textContent = data.pending || 0;
        const cntEl = $('rpCount');
        if (cntEl) cntEl.textContent = allReports.length;
        // 与其余 tab 一致走统一分页（PLAN §W1 / 需求 13：后台每个列表最多 20 条）。
        // ⚠️ 新加的 tab 容易漏掉这一步——列表一长就把整页撑爆，而"共 N 条"还显示着全量。
        renderPaged('reports', allReports, 'rpPager', renderReports);
      } catch (e) { if (alive()) toast('加载失败：' + e.message); }
    }

    /** @param {Array} slice 本页的举报（全量在 `allReports`） */
    function renderReports(slice) {
      const box = $('rpList');
      if (!box) return;
      if (!slice.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来没有"与"被状态筛选筛空"
        const filtered = !!(($('rpFilter') || {}).value);
        box.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty(filtered ? '当前筛选下没有举报（切换「全部」可查看历史）' : '暂无举报记录') : '';
        return;
      }
      const catLabel = (id) => {
        const c = reportCategories.find((x) => x.id === id);
        return c ? c.label : id;
      };
      const statusMeta = {
        pending: ['🕐 待处理', 'var(--gold-light)'],
        handled: ['✅ 已处理', 'var(--text-dim)'],
        rejected: ['↩️ 已驳回', 'var(--text-dim)'],
      };
      box.innerHTML = slice.map((r) => {
        const st = statusMeta[r.status] || [r.status, 'var(--text-dim)'];
        const ops = r.status === 'pending'
          ? `<button class="btn btn-primary btn-sm" data-rp="handled" data-id="${esc(r.id)}">标记已处理</button>
         <button class="btn btn-ghost btn-sm" data-rp="rejected" data-id="${esc(r.id)}">驳回</button>`
          : '';
        const ctxHtml = r.context && (r.context.roomId || r.context.recordId)
          ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">上下文：${
            [r.context.roomId ? `房间 ${esc(r.context.roomId)}` : '', r.context.recordId ? `棋谱 ${esc(r.context.recordId)}` : '']
              .filter(Boolean).join(' · ')}</div>`
          : '';
        return `
      <div class="record-item">
        <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
          <span><span data-player-id="${esc(r.targetId)}">${esc(r.targetName)}</span>
            <!-- ⚠️ 2026-10-02 体验修复（举报 id 可点）：把目标 id 显示出来并做成可点链接，
                 点击即打开该玩家的详情弹层（走到 admin-shell.js 的 report-target-view →
                 hub.viewUser，与用户列表里的「查看详情」同一处理），不必再手动去用户页搜 id。 -->
            <span style="color:var(--text-dim);font-size:11px;">（<span title="点击查看该玩家详情" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="report-target-view" data-id="${esc(r.targetId)}">${esc(r.targetId)}</span>）</span>
            <span style="color:var(--text-dim);font-size:12px;">被 ${esc(r.byName)} 举报</span></span>
          <span style="color:${st[1]};font-size:12px;">${st[0]}</span>
        </div>
        <div style="font-size:12px;margin-top:4px;">类别：${esc(catLabel(r.category))}${
r.detail ? `<br>说明：${esc(r.detail)}` : ''}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${global.I18N.fmt(r.at)}</div>
        ${ctxHtml}
        ${r.note ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">处理备注：${esc(r.note)}</div>` : ''}
        ${ops ? `<div style="display:flex;gap:6px;margin-top:8px;">${
          ops}</div>` : ''}
      </div>`;
      }).join('');
    }

    on($('btnRefreshReports'), 'click', () => loadReports());
    // 换了筛选条件 = 数据来源变了 → 回到第 1 页（否则筛选后停在旧页码上会看到"空列表"）
    on($('rpFilter'), 'change', () => {
      pages.reports = 1;
      loadReports();
    });
    on($('rpList'), 'click', async (e) => {
      const btn = e.target.closest && e.target.closest('button[data-rp]');
      if (!btn) return;
      const status = btn.getAttribute('data-rp');
      const id = btn.getAttribute('data-id');
      const note = prompt(status === 'handled' ? '处理备注（可留空）：' : '驳回理由（可留空）：');
      if (note === null) return;
      try {
        const res = await fetch(`/api/admin/reports/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify({ status, note }),
        });
        if (!alive()) return;
        const data = await res.json();
        if (!alive()) return;
        if (!res.ok || !data.ok) { toast((data && data.error) || '处理失败'); return; }
        toast(status === 'handled' ? '已标记为处理' : '已驳回');
        loadReports();
      } catch (err) { if (alive()) toast('处理失败：' + err.message); }
    });

    /** 表单与按钮每次 mount 绑一次（列表每次刷新会重建，重复绑定会累积监听器） */
    function initIpBanForm() {
      if (ipbFormReady || !ipbDurations.length) return;
      const hoursSel = $('ipbHours');
      if (hoursSel) hoursSel.innerHTML = ipbDurations
        .map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
      on($('btnIpBan'), 'click', () => submitIpBan());
      on($('btnRefreshIpBan'), 'click', () => loadIpBans());
      // 多填一个 IP 就点一次封禁：回车提交比找按钮顺手
      on($('ipbReason'), 'keydown', (e) => {
        if (e.key === 'Enter') submitIpBan();
      });
      ipbFormReady = true;
    }

    function renderIpBans() {
      const cnt = $('ipbCount');
      if (cnt) cnt.textContent = allBans.length;
      const myEl = $('ipbMyIp');
      if (myEl) myEl.innerHTML = ipbMyIp
        ? `你当前的 IP：<b>${esc(maskIp(ipbMyIp))}</b> —— 不能封禁会把你自己也圈进去的规则`
        : '';
      renderPaged('ipbans', allBans, 'ipbPager', renderIpBanPage);
    }

    function renderIpBanPage(slice) {
      const el = $('ipbList');
      if (!el) return;
      if (!slice.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：与其余 tab 统一走 AdminUI.empty
        el.innerHTML = ctx.AdminUI ? ctx.AdminUI.empty('暂无封禁记录') : '';
        return;
      }
      const now = Date.now();
      el.innerHTML = slice.map((b) => {
        const st = b.permanent
          ? '<span style="color:var(--red-light);">永久</span>'
          : (b.active
            ? `<span style="color:var(--gold-light);">剩余 ${fmtLeft(b.expiresAt - now)}</span>`
            : '<span style="color:var(--text-dim);">已过期</span>');
        const hit = b.hits
          ? ` · 已命中 ${b.hits} 次${b.lastHitAt ? `（最近 ${fmtTs(b.lastHitAt)}）` : ''}`
          : ' · 尚未命中';
        return `
      <div class="record-item">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-size:13px;">
              <span class="ipb-mask" data-ip="${esc(b.ip)}" data-shown="0" style="cursor:pointer;"
                    title="点击展开完整地址">${esc(maskIp(b.ip))}</span>
              &nbsp;${st}
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
              ${esc(b.reason || '')} · 操作人 ${esc(b.bannedById || '—')} · ${fmtTs(b.bannedAt)}${hit}
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            ${b.permanent ? '' : `<button class="btn btn-ghost btn-sm" data-ipb-ext="${esc(b.ip)}">延长 24h</button>`}
            <button class="btn btn-ghost btn-sm" data-ipb-unban="${esc(b.ip)}" style="color:var(--red-light);">解封</button>
          </div>
        </div>
      </div>`;
      }).join('');

      // 掩码点击展开（IP 属隐私数据，与 §U6 同一口径：默认只见网段）
      //（绑在刚生成的列表元素上，DOM 整块替换即失效；unmount 后 DOM 已销毁）
      el.querySelectorAll('.ipb-mask').forEach((s) => s.addEventListener('click', () => {
        const ip = s.getAttribute('data-ip');
        const shown = s.getAttribute('data-shown') === '1';
        s.textContent = shown ? maskIp(ip) : ip;
        s.setAttribute('data-shown', shown ? '0' : '1');
      }));
      el.querySelectorAll('button[data-ipb-unban]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const ip = btn.getAttribute('data-ipb-unban');
          if (!confirm(`确定解封 ${ip}？`)) return;
          ipbPost('/api/admin/ipbans/unban', { ip }, '已解封');
        });
      });
      el.querySelectorAll('button[data-ipb-ext]').forEach((btn) => {
        btn.addEventListener('click', () => {
          ipbPost('/api/admin/ipbans/extend', { ip: btn.getAttribute('data-ipb-ext'), hours: 24 }, '已延长 24 小时');
        });
      });
    }

    function submitIpBan() {
      const ipEl = $('ipbIp');
      const reasonEl = $('ipbReason');
      const hoursEl = $('ipbHours');
      const ip = ipEl ? ipEl.value.trim() : '';
      const reason = reasonEl ? reasonEl.value.trim() : '';
      const durId = hoursEl ? hoursEl.value : '';
      const dur = ipbDurations.find((d) => d.id === durId) || {};

      if (!ip) return toast('请填写 IP 或网段');
      if (!reason) return toast('必须填写封禁理由');

      // 永久封禁单独再确认一次：它是 NAT 共享出口误伤面最大的一档，且不会自动解除
      if (dur.hours === null && !confirm(`确定对 ${ip} 做【永久】封禁？\n共享出口 IP 可能影响很多人，且不会自动解除。`)) return;
      if (!confirm(`确定封禁 ${ip}？\n理由：${reason}\n时长：${dur.label || durId}`)) return;

      ipbPost('/api/admin/ipbans', { ip, reason, hours: dur.hours }, '已封禁').then((ok) => {
        if (ok) {
          if (ipEl) ipEl.value = '';
          if (reasonEl) reasonEl.value = '';
        }
      });
    }

    /** 三个写操作共用：POST + 错误提示 + 成功后刷新列表 */
    async function ipbPost(path, body, okMsg) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify(body || {}),
        });
        if (!alive()) return false;
        const data = await res.json();
        if (!alive()) return false;
        if (!res.ok || !data.ok) { toast((data && data.error) || '操作失败'); return false; }
        toast(okMsg);
        loadIpBans();
        return true;
      } catch (e) { if (alive()) toast('操作失败：' + e.message); return false; }
    }

    /** 剩余时长文案 */
    function fmtLeft(ms) {
      if (ms <= 0) return '已过期';
      const m = Math.ceil(ms / 60000);
      if (m < 60) return `${m} 分钟`;
      const h = Math.floor(m / 60);
      if (h < 48) return `${h} 小时`;
      return `${Math.floor(h / 24)} 天`;
    }

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadIpBans = loadIpBans;
    hub.loadReports = loadReports;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.moderation = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-console.js ==== */
/**
 * admin-console.js — 总览仪表盘 + 公告管理 + 实时干预（房间）（admin 子模块）
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.console`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定表单/刷新按钮、导出 loadOverview / loadAnnouncements / loadRooms 到 ctx.hub
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI / fmtTs）由 admin.js 的 mount 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, maskIp, renderPaged, toast, hub, fmtTs } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ==================================================================
    // §C1 总览仪表盘
    // ==================================================================
    async function loadOverview() {
      try {
        const res = await fetch('/api/admin/overview', { headers: { 'x-admin-token': getToken() } });
        if (!alive()) return;
        const d = await res.json();
        if (!alive()) return;
        if (!res.ok) { toast((d && d.error) || '加载失败'); return; }
        renderOverview(d);
      } catch (e) { if (alive()) toast('加载失败：' + e.message); }
    }

    function renderOverview(d) {
      const cards = [
        ['在线人数', d.stats.online, 'var(--gold-light)'],
        ['进行中对局', d.stats.playing],
        ['等待中', d.stats.waiting],
        ['棋谱总数', d.recordsTotal],
        ['用户数', d.userCount],
        ['赛事数', d.tournamentCount],
        ['公告数', d.announcementCount],
        ['生效中的 IP 封禁', d.activeBanCount],
      ];
      const statsEl = $('ovStats');
      if (statsEl) statsEl.innerHTML = cards.map(([label, val, color]) => `
    <div class="card" style="padding:14px 16px;background:var(--bg-2);">
      <div style="font-size:12px;color:var(--text-dim);">${label}</div>
      <div style="font-size:24px;font-weight:800;margin-top:4px;${color ? `color:${color};` : ''}">${val == null ? '—' : val}</div>
    </div>`).join('');

      const au = (d.recentAudit || []).slice().reverse(); // 最新在上
      const auditEl = $('ovAudit');
      if (auditEl) auditEl.innerHTML = au.length ? au.map((e) => `
    <div style="font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <span style="color:var(--text-dim);">${fmtTs(e.ts)}</span>
      · <span style="color:var(--gold-light);">${esc(e.action || '')}</span>
      · ${esc(maskIp(e.ip || ''))}
      ${e.ok === false ? ' · <span style="color:var(--red-light);">失败</span>' : ''}
    </div>`).join('') : '<div style="color:var(--text-dim);font-size:13px;">暂无记录。</div>';

      const bt = d.recentBattles || [];
      const battleEl = $('ovBattles');
      if (battleEl) battleEl.innerHTML = bt.length ? bt.map((r) => {
        const names = r.names || ['先手', '後手'];
        const res = global.UI.resultText(r, { withClass: true });
        return `<div style="font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      ${esc(names[0])} vs ${esc(names[1])}
      <span class="${res.cls}" style="font-size:11px;">${esc(res.text)}</span>
      <span style="color:var(--text-dim);"> · ${r.moveCount || 0} 手 · ${fmtTs(r.createdAt)}</span>
    </div>`;
      }).join('') : '<div style="color:var(--text-dim);font-size:13px;">暂无对局。</div>';
    }

    // 总览「刷新」按钮（原 loadOverview 内惰性绑定；现每次 mount 绑一次）
    on($('btnRefreshOverview'), 'click', () => loadOverview());

    // ==================================================================
    // §C5 公告管理
    //
    // ⚠️ 公告删空后**不会**退回默认公告（旧实现会，表现为"删不掉"）——
    // 由服务端 `listAnnouncements()` 只用「是不是数组」判断来保证。
    // ==================================================================
    let allAnn = [];
    let anEditingId = null;
    let anFormReady = false;

    async function loadAnnouncements() {
      initAnnForm();
      // ⚠️ 2026-10-02 体验修复（加载态统一）：公告属"切过去才拉"的懒加载 tab，
      // 此前首次切过去是一段空白；先铺"正在加载"占位（与棋谱/用户/审计/举报同一写法）。
      const anBox = $('anList');
      if (anBox) anBox.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载公告…') : '';
      try {
        const res = await fetch('/api/admin/announcements', { headers: { 'x-admin-token': getToken() } });
        if (!alive()) return;
        const d = await res.json();
        if (!alive()) return;
        if (!res.ok) { toast((d && d.error) || '加载失败'); return; }
        allAnn = d.announcements || [];
        renderAnnouncements();
      } catch (e) { if (alive()) toast('加载失败：' + e.message); }
    }

    function initAnnForm() {
      if (anFormReady) return;
      on($('btnAnnAdd'), 'click', () => submitAnnouncement());
      on($('btnAnnCancelEdit'), 'click', () => cancelAnEdit());
      on($('btnRefreshAnn'), 'click', () => loadAnnouncements());
      anFormReady = true;
    }

    function cancelAnEdit() {
      anEditingId = null;
      const t = $('anTitle'); if (t) t.value = '';
      const c = $('anContent'); if (c) c.value = '';
      const p = $('anPinned'); if (p) p.checked = false;
      const add = $('btnAnnAdd'); if (add) add.textContent = '＋ 发布公告';
      const cancel = $('btnAnnCancelEdit'); if (cancel) cancel.style.display = 'none';
      const hint = $('anEditHint'); if (hint) hint.style.display = 'none';
    }

    async function submitAnnouncement() {
      const title = $('anTitle') ? $('anTitle').value.trim() : '';
      const content = $('anContent') ? $('anContent').value.trim() : '';
      const pinned = $('anPinned') ? $('anPinned').checked : false;
      if (!title) return toast('请填写标题');
      if (!content) return toast('请填写内容');

      if (anEditingId != null) {
        const ok = await anPost(`/api/admin/announcements/${anEditingId}/update`, { title, content, pinned }, '公告已更新');
        if (ok) cancelAnEdit();
      } else {
        const ok = await anPost('/api/admin/announcements', { title, content, pinned }, '公告已发布');
        if (ok) cancelAnEdit();
      }
    }

    function renderAnnouncements() {
      const cnt = $('anCount');
      if (cnt) cnt.textContent = allAnn.length;
      renderPaged('announcements', allAnn, 'anPager', renderAnnPage);
    }

    function renderAnnPage(slice) {
      const el = $('anList');
      if (!el) return;
      if (!slice.length) {
        el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无公告。用上方表单发一条吧。</div>';
        return;
      }
      el.innerHTML = slice.map((a) => `
    <div class="record-item">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:240px;">
          <div style="font-size:13px;font-weight:700;">
            ${a.pinned ? '<span style="color:var(--gold-light);">📌</span> ' : ''}${esc(a.title)}
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:4px;white-space:pre-wrap;">${esc(a.content)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">
            #${a.id} · 发布于 ${fmtTs(a.createdAt)}${a.updatedAt ? ` · 修改于 ${fmtTs(a.updatedAt)}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" data-an-pin="${a.id}" data-an-pinned="${a.pinned ? 1 : 0}">${a.pinned ? '取消置顶' : '置顶'}</button>
          <button class="btn btn-ghost btn-sm" data-an-edit="${a.id}">编辑</button>
          <button class="btn btn-ghost btn-sm" data-an-del="${a.id}" style="color:var(--red-light);">删除</button>
        </div>
      </div>
    </div>`).join('');

      //（绑在刚生成的列表元素上，DOM 整块替换即失效；unmount 后 DOM 已销毁）
      el.querySelectorAll('button[data-an-pin]').forEach((b) => {
        b.addEventListener('click', () => {
          anPost(`/api/admin/announcements/${encodeURIComponent(b.getAttribute('data-an-pin'))}/update`,
            { pinned: b.getAttribute('data-an-pinned') !== '1' }, '已更新');
        });
      });
      el.querySelectorAll('button[data-an-edit]').forEach((b) => {
        b.addEventListener('click', () => {
          const a = allAnn.find((x) => String(x.id) === b.getAttribute('data-an-edit'));
          if (!a) return;
          anEditingId = a.id;
          const t = $('anTitle'); if (t) t.value = a.title;
          const c = $('anContent'); if (c) c.value = a.content;
          const p = $('anPinned'); if (p) p.checked = !!a.pinned;
          const add = $('btnAnnAdd'); if (add) add.textContent = '保存修改';
          const cancel = $('btnAnnCancelEdit'); if (cancel) cancel.style.display = '';
          const hint = $('anEditHint');
          if (hint) {
            hint.style.display = '';
            hint.textContent = `正在编辑 #${a.id}「${a.title}」`;
          }
          if (t) t.focus();
        });
      });
      el.querySelectorAll('button[data-an-del]').forEach((b) => {
        b.addEventListener('click', () => {
          const id = b.getAttribute('data-an-del');
          const a = allAnn.find((x) => String(x.id) === String(id));
          if (!confirm(`确定删除公告「${a ? a.title : id}」？`)) return;
          anPost(`/api/admin/announcements/${encodeURIComponent(id)}/delete`, {}, '已删除').then((ok) => {
            if (ok && String(anEditingId) === String(id)) cancelAnEdit();
          });
        });
      });
    }

    // ==================================================================
    // §C6 实时干预：在线房间列表 + 强制解散 / 强制下线
    //
    // ⚠️ 强制解散是**破坏性**操作：对局会立刻中断。所以每个按钮都带二次确认，
    // 并且确认框里写出"房间里有谁"——避免管理员看错行、解散错房间。
    // ==================================================================
    let allRooms = [];

    async function loadRooms() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：房间列表也是懒加载 tab，先铺"正在加载"占位
      const rmBox = $('rmList');
      if (rmBox) rmBox.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载房间…') : '';
      try {
        const res = await fetch('/api/admin/rooms', { headers: { 'x-admin-token': getToken() } });
        if (!alive()) return;
        const d = await res.json();
        if (!alive()) return;
        if (!res.ok) { toast((d && d.error) || '加载失败'); return; }
        allRooms = d.rooms || [];
        renderRooms();
      } catch (e) { if (alive()) toast('加载失败：' + e.message); }
    }

    function renderRooms() {
      const cnt = $('rmCount');
      if (cnt) cnt.textContent = allRooms.length;
      const el = $('rmList');
      if (!el) return;
      if (!allRooms.length) {
        el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">当前没有在线房间。</div>';
        return;
      }
      el.innerHTML = allRooms.map((r) => {
        const who = (r.players || []).map((p) => `
      <span data-player-id="${esc(p.id || '')}" style="margin-right:6px;">
        ${p.seat === 'b' ? '▲' : '△'} ${esc(p.name || '—')}
        ${p.connected ? '' : '<span style="color:var(--red-light);font-size:11px;">（已断线）</span>'}
        <button class="btn btn-ghost btn-sm" data-rm-kick="${esc(p.id || '')}" style="padding:1px 6px;font-size:11px;">下线</button>
      </span>`).join('') || '<span style="color:var(--text-dim);">无人</span>';
        const tags = [
          r.status,
          r.isPrivate ? '<span style="color:var(--gold-light);">私人房</span>' : '',
          r.tournamentId ? '赛事对局' : '',
          r.rated ? '计分' : '不计分',
          r.spectators ? `观众 ${r.spectators}` : '',
        ].filter(Boolean).join(' · ');
        return `
      <div class="record-item">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;min-width:260px;">
            <div style="font-size:13px;">${who}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">
              ${esc(tags)}${r.code ? ` · 房号 ${esc(r.code)}` : ''} · ${r.moveCount} 手 · 建于 ${fmtTs(r.createdAt)}
            </div>
          </div>
          <div>
            <button class="btn btn-ghost btn-sm" data-rm-close="${esc(r.roomId)}" style="color:var(--red-light);">强制解散</button>
          </div>
        </div>
      </div>`;
      }).join('');

      //（绑在刚生成的列表元素上，DOM 整块替换即失效；unmount 后 DOM 已销毁）
      el.querySelectorAll('button[data-rm-close]').forEach((b) => {
        b.addEventListener('click', () => {
          const roomId = b.getAttribute('data-rm-close');
          const r = allRooms.find((x) => x.roomId === roomId);
          const who = r ? (r.players || []).map((p) => p.name || '—').join(' vs ') : '';
          if (!confirm(`确定强制解散房间？\n房内：${who}\n\n对局会立刻中断。`)) return;
          roomPost(`/api/admin/rooms/${encodeURIComponent(roomId)}/close`, {}, '已解散房间');
        });
      });
      el.querySelectorAll('button[data-rm-kick]').forEach((b) => {
        b.addEventListener('click', () => {
          const pid = b.getAttribute('data-rm-kick');
          if (!pid) return toast('该座位没有可下线的玩家');
          if (!confirm('确定把该玩家强制下线？\n（对局中会走断线判负流程）')) return;
          roomPost('/api/admin/kick', { playerId: pid }, '已强制下线');
        });
      });
    }

    // 房间「刷新」按钮（原 loadRooms 内惰性绑定；现每次 mount 绑一次）
    on($('btnRefreshRooms'), 'click', () => loadRooms());

    async function roomPost(path, body, okMsg) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify(body || {}),
        });
        if (!alive()) return false;
        const data = await res.json();
        if (!alive()) return false;
        if (!res.ok || !data.ok) { toast((data && data.error) || '操作失败'); return false; }
        toast(okMsg);
        loadRooms();
        return true;
      } catch (e) { if (alive()) toast('操作失败：' + e.message); return false; }
    }

    /** 公告的三个写操作共用：POST + 错误提示 + 成功后刷新 */
    async function anPost(path, body, okMsg) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify(body || {}),
        });
        if (!alive()) return false;
        const data = await res.json();
        if (!alive()) return false;
        if (!res.ok || !data.ok) { toast((data && data.error) || '操作失败'); return false; }
        toast(okMsg);
        loadAnnouncements();
        return true;
      } catch (e) { if (alive()) toast('操作失败：' + e.message); return false; }
    }

    // 审计 tab 的「刷新」按钮（原在 make 顶层绑定）
    on($('btnRefreshAudit'), 'click', () => { if (hub.loadAudit) hub.loadAudit(); });

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadAnnouncements = loadAnnouncements;
    hub.loadOverview = loadOverview;
    hub.loadRooms = loadRooms;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.console = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin-items.js ==== */
/**
 * admin-items.js — 「道具发放」tab（admin 子模块）（2026-10-03 新功能：道具系统）
 *
 * 一期没有独立的道具后台：把 `tools/item-admin.js` 的三个动作搬到这里——
 *   1. 查目录（拿 itemId / 价格 / 稀有度）
 *   2. 按账号查「钱包 / 拥有 / 装备」
 *   3. 发道具（grant）/ 加减货币（coin）/ 定义兑换码（code）
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.items`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定表单按钮、导出 loadItemsAdmin 到 ctx.hub，句柄记内部 teardown
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * ⚠️ 共用工具（esc / getToken / setToken / toast / AdminUI）由 `admin.js` 的 mount 注入；
 * 鉴权走 `x-admin-token` 头（POST）与 `?token=`（GET），与 admin-users.js 一致。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, setToken, toast, hub } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();
    // 空/加载态统一走 admin.js 注入的 AdminUI
    const empty = (t) => (ctx.AdminUI ? ctx.AdminUI.empty(t) : '');
    const loading = (t) => (ctx.AdminUI ? ctx.AdminUI.loading(t) : '');

    let CATALOG = [];
    let ASSETS = [];
    const BY_ID = new Map();

    function authHeaders() {
      return { 'Content-Type': 'application/json', 'x-admin-token': getToken() };
    }

    async function apiGet(path) {
      const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken() || '')}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
      return data;
    }
    async function apiPost(path, body) {
      const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
      return data;
    }
    // 令牌失效 → 退回登录态（与 admin-users/admin-audit 同一处理）
    function onErr(e) {
      if (!alive()) return;
      const msg = (e && e.message) || '操作失败';
      if (/40[13]|无权|令牌|登录/.test(msg)) {
        setToken(null);
        toast('管理员登录已失效，请重新登录');
        if (hub.initUI) hub.initUI();
        return;
      }
      toast(msg);
    }

    // ---------------- 目录 ----------------

    async function loadItemsAdmin() {
      const box = $('itemsCatalogList');
      if (box) box.innerHTML = loading('正在加载道具目录…');
      try {
        const data = await apiGet('/api/admin/items/catalog');
        if (!alive()) return;
        CATALOG = data.catalog || [];
        BY_ID.clear();
        for (const it of CATALOG) BY_ID.set(it.id, it);
        renderCatalog();
        fillItemSelect();
        loadAssets();
        loadBgmRoles();
      } catch (e) {
        if (!alive()) return;
        if (box) box.innerHTML = empty('加载道具目录失败');
        onErr(e);
      }
    }

    function renderCatalog() {
      const box = $('itemsCatalogList');
      if (!box) return;
      if (!CATALOG.length) { box.innerHTML = empty('目录为空'); return; }
      const cnt = $('itemsCatalogCount');
      if (cnt) cnt.textContent = CATALOG.length;
      const rows = CATALOG.map((it) => `
        <div class="record-item" style="font-size:13px;display:flex;gap:10px;align-items:center;">
          <span style="flex:1;">${esc(it.name || it.id)}
            <span style="color:var(--text-dim);font-size:11px;">${esc(it.id)} · ${esc(it.type)}${it.rarity ? ' · ' + esc(it.rarity) : ''}</span></span>
          <span style="color:${it.price === null ? 'var(--green)' : 'var(--gold-light)'};font-size:12px;">${it.price === null ? '免费' : esc(String(it.price)) + ' 币'}</span>
          <button class="btn btn-ghost btn-sm" data-edit-item="${esc(it.id)}" type="button">编辑</button>
          <button class="btn btn-ghost btn-sm" data-del-item="${esc(it.id)}" type="button">删除</button>
        </div>`).join('');
      box.innerHTML = rows;
      // 目录列表整块重建、容器是静态元素 —— 用 onclick 赋值（每次覆盖，不累积监听器）
      box.onclick = (e) => {
        const ed = e.target.closest && e.target.closest('[data-edit-item]');
        if (ed) return fillItemForm(ed.getAttribute('data-edit-item'));
        const del = e.target.closest && e.target.closest('[data-del-item]');
        if (del) return deleteItem(del.getAttribute('data-del-item'));
      };
    }

    function fillItemForm(id) {
      const it = BY_ID.get(id);
      if (!it) return;
      const setv = (fid, v) => { const n = $(fid); if (n) n.value = v == null ? '' : String(v); };
      setv('itemEditId', it.id);
      setv('itemEditType', it.type);
      setv('itemEditName', it.name);
      setv('itemEditDesc', it.desc);
      setv('itemEditRarity', it.rarity || 'N');
      setv('itemEditPrice', it.price === null || it.price === undefined ? '' : it.price);
      setv('itemEditAsset', it.asset && it.asset.value);
      // BGM 场景选择
      const roleEl = $('itemEditBgmRole');
      if (roleEl) {
        roleEl.style.display = it.type === 'bgm' ? '' : 'none';
        roleEl.value = it.role || '';
      }
    }

    async function upsertItem() {
      const id = (($('itemEditId') && $('itemEditId').value) || '').trim();
      const type = $('itemEditType') && $('itemEditType').value;
      const name = (($('itemEditName') && $('itemEditName').value) || '').trim();
      const desc = (($('itemEditDesc') && $('itemEditDesc').value) || '').trim();
      const rarity = $('itemEditRarity') && $('itemEditRarity').value;
      const priceRaw = (($('itemEditPrice') && $('itemEditPrice').value) || '').trim();
      const assetVal = (($('itemEditAsset') && $('itemEditAsset').value) || '').trim();

      if (!id || !type || !assetVal) return toast('请填写 id / 类型 / 素材 URL');
      const price = priceRaw === '' ? null : Number(priceRaw);
      if (price !== null && !Number.isFinite(price)) return toast('价格必须是数字或留空（免费）');
      const kind = type === 'bgm' ? 'audio' : (assetVal.charAt(0) === '/' ? 'image' : 'glyph');
      const roleVal = type === 'bgm' && $('itemEditBgmRole') ? (($('itemEditBgmRole').value) || '').trim() : '';
      try {
        const body = {
          id, type: type === 'bgm' ? 'bgm' : type, name: name || id, desc, rarity, price,
          asset: { kind, value: assetVal },
        };
        if (type === 'bgm' && roleVal) body.role = roleVal;
        const r = await apiPost('/api/admin/items/catalog', body);
        if (!alive()) return;
        toast(`已保存商品「${(r.item && r.item.name) || id}」`);
        loadItemsAdmin();
      } catch (e) { onErr(e); }
    }

    async function deleteItem(id) {
      if (!confirm(`确认删除商品 ${id}？（内置项会提示不可删）`)) return;
      try {
        await apiPost(`/api/admin/items/catalog/${encodeURIComponent(id)}/delete`, {});
        if (!alive()) return;
        toast('已删除');
        loadItemsAdmin();
      } catch (e) { onErr(e); }
    }

    // ---------------- 素材上传 ----------------

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || '');
          const i = s.indexOf(',');
          resolve(i >= 0 ? s.slice(i + 1) : s);
        };
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
    }

    async function doUpload() {
      const kind = $('uploadKind') && $('uploadKind').value;
      const name = (($('uploadName') && $('uploadName').value) || '').trim();
      const input = $('uploadFile');
      const file = input && input.files && input.files[0];
      const out = $('uploadResult');
      if (!file) return toast('请选择文件');
      if (out) out.textContent = '上传中…';
      try {
        const data = await fileToBase64(file);
        const r = await apiPost('/api/admin/items/upload', {
          kind, filename: name || file.name, data,
        });
        if (!alive()) return;
        const a = r.asset || {};
        if (out) {
          out.innerHTML = `<span style="color:var(--green);">上传成功</span> `
            + `素材 URL：<code>${esc(a.url || '')}</code>`
            + (a.width ? ` · ${a.width}×${a.height}` : '')
            + ` · ${a.id}`;
        }
        // 回填到商品表单
        const assetInput = $('itemEditAsset');
        if (assetInput) assetInput.value = a.url || '';
        const typeSel = $('itemEditType');
        if (typeSel) typeSel.value = kind === 'bgm' ? 'bgm' : kind === 'sprite' ? 'sprite' : 'avatar';
        const nameInput = $('itemEditName');
        if (nameInput && !nameInput.value) nameInput.value = a.name || '';
        loadAssetOptions();
        toast('素材已上传');
      } catch (e) {
        if (!alive()) return;
        if (out) out.innerHTML = `<span style="color:var(--danger);">${esc(e.message || '上传失败')}</span>`;
        onErr(e);
      }
    }

    // ---------------- BGM 三轨 ----------------

    /** 内置 OST + 已上传音频，灌进三个下拉 */
    function loadAssetOptions() {
      const builtin = [
        ['/music/loop.mp3', 'loop（内置）'],
        ['/music/静弈.mp3', '静弈（内置）'],
        ['/music/制勝.mp3', '制勝（内置）'],
        ['/music/深层沉浸.mp3', '深层沉浸（内置）'],
        ['/music/空弦.mp3', '空弦（内置）'],
      ];
      const uploaded = (ASSETS || []).filter((a) => a.kind === 'bgm').map((a) => [a.url, `${a.name || a.id}（上传）`]);
      const opts = [['', '（静音）']].concat(builtin, uploaded);
      for (const id of ['bgmMenu', 'bgmGame', 'bgmEndgame']) {
        const sel = $(id);
        if (!sel) continue;
        const keep = sel.value;
        sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
        if (keep) sel.value = keep;
      }
    }

    async function loadBgmRoles() {
      try {
        const d = await apiGet('/api/admin/items/bgm-roles');
        if (!alive()) return;
        const r = d.roles || {};
        if ($('bgmMenu')) $('bgmMenu').value = r.menu || '';
        if ($('bgmGame')) $('bgmGame').value = r.game || '';
        if ($('bgmEndgame')) $('bgmEndgame').value = r.endgame || '';
      } catch (e) { onErr(e); }
    }

    async function saveBgmRoles() {
      const menu = ($('bgmMenu') && $('bgmMenu').value) || '';
      const game = ($('bgmGame') && $('bgmGame').value) || '';
      const endgame = ($('bgmEndgame') && $('bgmEndgame').value) || '';
      try {
        await apiPost('/api/admin/items/bgm-roles', { menu, game, endgame });
        if (!alive()) return;
        toast('BGM 三轨已保存');
      } catch (e) { onErr(e); }
    }

    async function loadAssets() {
      try {
        const d = await apiGet('/api/admin/items/assets');
        if (!alive()) return;
        ASSETS = d.assets || [];
        loadAssetOptions();
      } catch (_) { /* 素材列表失败不阻断目录 */ }
    }

    /** 把目录灌进「发道具 / 兑换码」两个下拉 */
    function fillItemSelect() {
      for (const id of ['itemGrantId', 'itemCodeId']) {
        const sel = $(id);
        if (!sel) continue;
        const keep = sel.value;
        sel.innerHTML = (id === 'itemCodeId' ? '<option value="">（仅发币，不发道具）</option>' : '')
          + CATALOG.map((it) => `<option value="${esc(it.id)}">${esc(it.name || it.id)}（${esc(it.type)}）</option>`).join('');
        if (keep && BY_ID.has(keep)) sel.value = keep;
      }
    }

    // ---------------- 查账号 ----------------

    async function lookupAccount() {
      const raw = (($('itemAccountId') && $('itemAccountId').value) || '').trim();
      const box = $('itemAccountResult');
      if (!raw) { if (box) box.innerHTML = empty('请填写账号 id'); return null; }
      if (box) box.innerHTML = loading('正在查询…');
      try {
        const data = await apiGet(`/api/admin/items/account/${encodeURIComponent(raw)}`);
        if (!alive()) return null;
        renderAccount(data);
        return data;
      } catch (e) {
        if (!alive()) return null;
        if (box) box.innerHTML = empty(e.message || '查询失败');
        return null;
      }
    }

    function renderAccount(data) {
      const box = $('itemAccountResult');
      if (!box) return;
      const owned = (data.owned || []).map((id) => {
        const it = BY_ID.get(id);
        return `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:6px;background:var(--bg-3);font-size:12px;">${esc(it ? (it.name || id) : id)}</span>`;
      }).join('') || '<span style="color:var(--text-dim);font-size:12px;">（无）</span>';
      const eq = Object.entries(data.equipped || {}).filter(([, v]) => v)
        .map(([k, v]) => {
          const it = BY_ID.get(v);
          return `${esc(k)} = ${esc(it ? (it.name || v) : v)}`;
        }).join('、') || '（无）';
      box.innerHTML = `
        <div style="font-size:13px;line-height:1.9;">
          <div>账号：<b>${esc(data.accountId)}</b></div>
          <div>💰 货币：<b style="color:var(--gold-light);">${esc(String(data.wallet && data.wallet.coin || 0))}</b></div>
          <div>拥有（${(data.owned || []).length} 件）：${owned}</div>
          <div style="color:var(--text-dim);font-size:12px;">已装备：${eq}</div>
        </div>`;
    }

    // ---------------- 发放动作 ----------------

    async function doGrant() {
      const raw = (($('itemAccountId') && $('itemAccountId').value) || '').trim();
      const itemId = $('itemGrantId') && $('itemGrantId').value;
      if (!raw || !itemId) return toast('请先填写账号并选择道具');
      if (!confirm(`确认给 ${raw} 发放「${(BY_ID.get(itemId) || {}).name || itemId}」？`)) return;
      try {
        const r = await apiPost(`/api/admin/items/account/${encodeURIComponent(raw)}/grant`, { itemId });
        if (!alive()) return;
        toast(`已发放（该账号现拥有 ${r.owned.length} 件）`);
        lookupAccount();
      } catch (e) { onErr(e); }
    }

    async function doCoin() {
      const raw = (($('itemAccountId') && $('itemAccountId').value) || '').trim();
      const amount = Number((($('itemCoinAmount') && $('itemCoinAmount').value) || '').trim());
      if (!raw || !Number.isFinite(amount) || amount === 0) return toast('请填写账号与非零整数金额');
      if (!confirm(`确认给 ${raw} ${amount > 0 ? '增加' : '扣减'} ${Math.abs(amount)} 货币？`)) return;
      try {
        const r = await apiPost(`/api/admin/items/account/${encodeURIComponent(raw)}/coin`, { amount });
        if (!alive()) return;
        toast(`已处理，该账号货币现为 ${r.wallet.coin}`);
        lookupAccount();
      } catch (e) { onErr(e); }
    }

    async function doCode() {
      const code = (($('itemCode') && $('itemCode').value) || '').trim();
      const itemId = (($('itemCodeId') && $('itemCodeId').value)) || '';
      const coin = Number((($('itemCodeCoin') && $('itemCodeCoin').value) || '').trim()) || 0;
      const maxUses = Number((($('itemCodeMax') && $('itemCodeMax').value) || '').trim()) || 1;
      if (!code) return toast('请填写兑换码');
      if (!itemId && !coin) return toast('兑换码至少要发一件道具或一些货币');
      try {
        const r = await apiPost('/api/admin/items/code', { code, itemId: itemId || null, coin, maxUses });
        if (!alive()) return;
        toast(`兑换码已定义：道具=${(BY_ID.get(itemId) || {}).name || '（无）'} 币=${r.code.coin} 上限=${r.code.maxUses}`);
      } catch (e) { onErr(e); }
    }

    // ---------------- 事件绑定（本模块自己绑，句柄记 teardown 由 unmount 全清）----------------
    const bind = (id, fn) => { on($(id), 'click', fn); };
    bind('btnItemsRefresh', () => loadItemsAdmin());
    bind('btnItemLookup', () => lookupAccount());
    bind('btnItemGrant', () => doGrant());
    bind('btnItemCoin', () => doCoin());
    bind('btnItemCode', () => doCode());
    bind('btnUpload', () => doUpload());
    bind('btnItemUpsert', () => upsertItem());
    bind('btnBgmRoles', () => saveBgmRoles());

    // 类型切换时显示/隐藏 BGM 场景选择器
    const typeEl = $('itemEditType');
    if (typeEl) on(typeEl, 'change', () => {
      const roleEl = $('itemEditBgmRole');
      if (roleEl) roleEl.style.display = typeEl.value === 'bgm' ? '' : 'none';
    });

    // 供 admin-shell 的 tab 派发调用（走 hub，不再挂 window.loadItemsAdmin）
    hub.loadItemsAdmin = loadItemsAdmin;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.items = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/admin.js ==== */
/**
 * admin.js — 管理后台 View：管理员登录、全部棋谱 / 用户 / 赛事 / 审计 / 审核 / 道具管理
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render()                → 返回 `<main class="container">…`（原 admin.html 的主体，逐字保留）
 *   mount(container, params)→ 装配 8 个 admin-* 子模块、绑事件 / 订阅 WS，句柄记 this._teardown
 *   unmount()               → 统一清理（含各子模块 unmount 与 hub 清空），切页零泄漏
 *
 * 范式（照 home.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（指向 /api/... 的导出/下载除外）。
 *   - 所有 setInterval / setTimeout / api.on / document|window 监听，统一在 unmount 清理。
 *
 * 子模块（§M5：admin-shell / admin-records / admin-users / admin-audit / admin-tournaments /
 * admin-moderation / admin-console / admin-items）不再是「加载即自启」的 IIFE：各自导出
 * `window.AdminParts.<name> = { mount(ctx), unmount() }`，由本 View 的 mount/unmount 驱动；
 * 跨模块函数统一走 `ctx.hub`（原 `window.adminPage` / `window.loadXxx` / `window.viewUser`
 * 等全局名收敛到 `this._handlers` 命名空间，unmount 清空，单文档下不再跨页冲突）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;
  // 与 nav.js 的 ADMIN_KEY 保持一致（后台鉴权走 localStorage）
  const ADMIN_KEY = (global.NAV && global.NAV.ADMIN_KEY) || 'tdshogi_admin_token';

  function getToken() {
    try { return localStorage.getItem(ADMIN_KEY); } catch (_) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(ADMIN_KEY, t);
      else localStorage.removeItem(ADMIN_KEY);
    } catch (_) {}
  }

  /**
   * IP 掩码（PLAN §U6）：后台**默认**只显示到网段，点击才展开完整地址。
   *
   * 原始 IP 属隐私数据，后台又是最容易被截图的页面——
   * 默认掩码能挡掉"随手截图外流"这类低级泄露，同时不影响管理员排查（点一下就能看全）。
   */
  function maskIp(ip) {
    const s = String(ip || '');
    if (!s) return '';
    if (s.includes(':')) {                            // IPv6：保留前两组
      return s.split(':').slice(0, 2).join(':') + ':*';
    }
    const seg = s.split('.');
    if (seg.length === 4) return `${seg[0]}.${seg[1]}.${seg[2]}.*`;
    return s;                                         // 非预期格式：原样返回（显示出来总比留空好）
  }

  // ==================================================================
  // 分页（PLAN §W1 / 需求 13）：后台每个列表最多显示 20 条
  // ==================================================================
  const PAGE_SIZE = 20;

  const View = {
    title: '管理后台 · TDShogi',

    render() {
      // —— 原 admin.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <div class="section-title" style="font-size:24px;">🛡️ 管理后台</div>
    <!--
      ⚠️ 2026-10-02 体验修复（入口带 ?k=）：本页是**后台入口页**，关于进入参数的现有约定说明如下——
        1. 服务端入口门禁：设置环境变量 ADMIN_ENTRY_KEY 后，\`/admin.html\` 必须带 \`?k=<key>\`
           才放行，否则直接 404（见 src/http/middleware.js 的 adminEntryGate）。没设该变量时保持开放。
        2. 页面内的鉴权 token 走 **localStorage**（键 \`tdshogi_admin_token\`，见 public/js/admin.js 的
           ADMIN_KEY 与 nav.js 的 isAdminSession）——即"先进得来页面、再由本页向服务端证明身份"。
        因此这里**不硬改鉴权**：?k= 只负责"能不能打开这个页面"，token 负责"是不是管理员"，两者不要混。
      📌 待办（不在本次改动范围）：渲染后台入口链接的是 public/js/nav.js 的 adminEntryHtml()，
        目前写作 \`href="admin.html"\`（未带 k）。若生产启用了 ADMIN_ENTRY_KEY，入口需要改为带上
        \`?k=<key>\`；但该 key 是服务端环境变量、不应下发到前端页面，正确做法是让服务端渲染入口，
        或在 nav.js 里从一个"前端可得的入口标识"拼参数。nav.js 不在本次修复的文件白名单内，未改。
    -->

    <!-- 管理员未登录时 -->
    <div class="card" id="adminLoginCard" style="max-width:420px;padding:28px;">
      <div class="section-title">管理员登录</div>
      <div style="font-size:13px;color:var(--text-dim);margin:10px 0 16px;">请输入管理密码以访问全部棋谱与用户数据</div>
      <input type="password" class="input" id="adminPassword" placeholder="管理密码" style="width:100%;">
      <button class="btn btn-primary" id="btnAdminLogin" style="margin-top:14px;width:100%;">登录</button>
    </div>

    <!-- 管理员已登录 -->
    <div id="adminPanel" style="display:none;">
      <!-- ⚠️ 2026-10-02 体验修复：退出按钮原在登录卡片内（登录后整卡隐藏 → 永远点不到），移到面板顶部 -->
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
        <button class="btn btn-ghost btn-sm" id="btnAdminLogout">退出管理员</button>
      </div>
      <!-- 标签切换 -->
      <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm tab-btn active" data-tab="overview">📊 总览</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="records">全部棋谱</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="users">全部用户</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="tournaments">赛事管理</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="announcements">📢 公告</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="rooms">🕹 对局干预</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="audit">操作审计</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="ipbans">🚫 IP 封禁</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="reports">🚩 举报</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="items">🎒 道具</button>
      </div>

      <!-- 总览仪表盘（§C1）：进后台第一眼看到全局 -->
      <div class="card" id="tab-overview" style="padding:20px;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>平台总览</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshOverview">刷新</button>
        </div>
        <div id="ovStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;">
          <div>
            <div style="font-size:13px;font-weight:700;margin-bottom:8px;">🕒 最近管理操作</div>
            <div id="ovAudit"></div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;margin-bottom:8px;">⚔️ 最新对局</div>
            <div id="ovBattles"></div>
          </div>
        </div>
      </div>

      <!-- 全部棋谱 -->
      <div class="card" id="tab-records" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>全部棋谱（<span id="recordCount">0</span>）</span>
          <div style="display:flex;gap:8px;">
            <input class="input" id="recordSearch" placeholder="按选手名/ID 搜索棋谱" style="width:220px;padding:6px 10px;font-size:13px;">
            <input type="file" id="kifFileInput" accept=".kif,.txt" style="display:none;" multiple>
            <button class="btn btn-ghost btn-sm" id="btnImportKif">📥 导入 KIF</button>
            <!-- ⚠️ 2026-10-02 体验修复：补手动刷新按钮（原先只能重进页面/切 tab 才能刷新） -->
            <button class="btn btn-ghost btn-sm" id="btnRefreshRecords">刷新</button>
          </div>
        </div>
        <div id="importResult" style="font-size:12px;color:var(--green);margin:6px 0;"></div>
        <div id="adminRecordList" style="max-height:70vh;overflow-y:auto;"></div>
        <!-- 分页条（PLAN §W1 / 需求 13）：内容由 admin.js 的 renderPaged 填充 -->
        <div id="recordPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 全部用户 -->
      <div class="card" id="tab-users" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>全部用户（<span id="userCount">0</span>）</span>
          <span style="display:flex;gap:8px;align-items:center;">
            <input class="input" id="userSearch" placeholder="按名字/ID 搜索用户" style="width:220px;padding:6px 10px;font-size:13px;">
            <!-- ⚠️ 2026-10-02 体验修复：补手动刷新按钮 -->
            <button class="btn btn-ghost btn-sm" id="btnRefreshUsers">刷新</button>
          </span>
        </div>
        <div id="adminUserList" style="max-height:70vh;overflow-y:auto;"></div>
        <div id="userPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 赛事管理 -->
      <div class="card" id="tab-tournaments" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>赛事管理（<span id="tnCount">0</span>）</span>
          <span id="tnStats" style="font-size:12px;color:var(--text-dim);"></span>
        </div>
        <div style="margin-bottom:18px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">🕐 待审核</div>
          <div id="tnPendingList"></div>
          <div id="tnPendingPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:8px;flex-wrap:wrap;"></div>
        </div>
        <div style="margin-bottom:18px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">▶️ 进行中</div>
          <div id="tnActiveList"></div>
          <div id="tnActivePager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:8px;flex-wrap:wrap;"></div>
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">📜 历史</div>
          <!-- 分页后不需要长滚动条（需求 13：一页只显示 20 个） -->
          <div id="tnHistoryList"></div>
          <div id="tnHistoryPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:8px;flex-wrap:wrap;"></div>
        </div>
      </div>

      <!-- 道具发放（2026-10-03 新功能：道具系统） + 商品管理（2026-10-07） -->
      <div class="card" id="tab-items" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>🎒 商品与道具（目录 <span id="itemsCatalogCount">0</span> 件）</span>
          <button class="btn btn-ghost btn-sm" id="btnItemsRefresh">刷新目录</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.7;">
          管理商品目录、上传素材（头像 256×256 / 立绘 / BGM）、调整 BGM 三轨，并给账号发道具 / 加减货币 / 定义兑换码。
          所有操作都会记入「操作审计」（含操作人）。
        </div>

        <!-- A. BGM 三轨 -->
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px;">🎵 BGM 三轨（菜单 / 开局 / 终盘）</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <label style="font-size:12px;">菜单（无对局）<br>
              <select class="input" id="bgmMenu" style="min-width:180px;"></select></label>
            <label style="font-size:12px;">开局（对局中循环）<br>
              <select class="input" id="bgmGame" style="min-width:180px;"></select></label>
            <label style="font-size:12px;">终盘（进入读秒）<br>
              <select class="input" id="bgmEndgame" style="min-width:180px;"></select></label>
            <button class="btn btn-primary btn-sm" id="btnBgmRoles">保存三轨</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">
            玩家在「装扮」装备的 BGM 会覆盖「开局」轨；菜单 / 终盘轨全局生效。下拉里含 OST 内置曲与已上传音频。
          </div>
        </div>

        <!-- B. 上传素材 -->
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px;">📤 上传素材</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <select class="input" id="uploadKind" style="width:140px;">
              <option value="avatar">头像（256×256）</option>
              <option value="sprite">立绘</option>
              <option value="bgm">BGM 音频</option>
            </select>
            <input class="input" id="uploadName" placeholder="显示名（可选）" style="width:160px;">
            <input type="file" id="uploadFile" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/ogg,audio/wav" style="font-size:12px;">
            <button class="btn btn-primary btn-sm" id="btnUpload">上传</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.7;">
            格式：头像 png/jpg/webp 且必须 <b>256×256</b>；立绘 png/jpg/webp（64–2048）；BGM mp3/ogg/wav（≤12MB）。
            上传后在下方「新建商品」里引用素材 URL。
          </div>
          <div id="uploadResult" style="margin-top:8px;font-size:12px;"></div>
        </div>

        <!-- C. 新建 / 编辑商品 -->
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px;">🛒 新建 / 覆盖商品</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input class="input" id="itemEditId" placeholder="id（唯一，如 bgm-custom-1）" style="width:180px;">
            <select class="input" id="itemEditType" style="width:110px;">
              <option value="avatar">头像</option>
              <option value="bgm">BGM</option>
              <option value="sprite">立绘</option>
              <option value="pieces">棋子</option>
              <option value="board">棋盘</option>
              <option value="byoyomi">读秒音</option>
            </select>
            <select class="input" id="itemEditBgmRole" style="width:110px;display:none;" title="BGM 使用场景（每首曲对应唯一场景）">
              <option value="">— 选场景 —</option>
              <option value="menu">菜单曲</option>
              <option value="game">开局曲</option>
              <option value="endgame">终盘曲</option>
            </select>
            <input class="input" id="itemEditName" placeholder="名称" style="width:140px;">
            <input class="input" id="itemEditDesc" placeholder="描述" style="width:180px;">
            <select class="input" id="itemEditRarity" style="width:90px;">
              <option value="N">N</option>
              <option value="R">R</option>
              <option value="SR">SR</option>
            </select>
            <input class="input" id="itemEditPrice" placeholder="价格（空=免费）" style="width:130px;">
            <input class="input" id="itemEditAsset" placeholder="素材 URL，如 /uploads/items/xxx.png" style="width:240px;">
            <button class="btn btn-primary btn-sm" id="btnItemUpsert">保存商品</button>
          </div>
        </div>

        <!-- ① 查账号 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <input class="input" id="itemAccountId" placeholder="账号 id" style="min-width:260px;">
          <button class="btn btn-ghost btn-sm" id="btnItemLookup">查询该账号</button>
        </div>
        <div id="itemAccountResult" style="margin-bottom:14px;"></div>

        <!-- ② 发道具 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <span style="font-size:12px;color:var(--text-dim);">发道具</span>
          <select class="input" id="itemGrantId" style="min-width:220px;"></select>
          <button class="btn btn-primary btn-sm" id="btnItemGrant">发放</button>
        </div>

        <!-- ③ 加减货币 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <span style="font-size:12px;color:var(--text-dim);">货币</span>
          <input class="input" id="itemCoinAmount" placeholder="±整数，如 500 / -100" style="width:200px;">
          <button class="btn btn-ghost btn-sm" id="btnItemCoin">执行</button>
        </div>

        <!-- ④ 定义兑换码 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;color:var(--text-dim);">兑换码</span>
          <input class="input" id="itemCode" placeholder="码，如 WELCOME2026" style="width:180px;">
          <select class="input" id="itemCodeId" style="min-width:200px;"></select>
          <input class="input" id="itemCodeCoin" placeholder="赠币(可选)" style="width:120px;">
          <input class="input" id="itemCodeMax" placeholder="可用次数(默认1)" style="width:150px;">
          <button class="btn btn-primary btn-sm" id="btnItemCode">定义</button>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:14px;">兑换码由用户在自己的「我的装扮」页兑换；同码可重复定义（覆盖）。</div>

        <!-- ⑤ 目录 -->
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">道具目录（点「编辑」回填上方表单；内置项只能覆盖不能删）</div>
        <div id="itemsCatalogList" style="max-height:42vh;overflow-y:auto;"></div>
      </div>

      <!-- 操作审计（PLAN §K4） -->
      <div class="card" id="tab-audit" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>操作审计（<span id="auditCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshAudit">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">管理员的全部写操作记录（最近 200 条）：封禁/解封、改名、重置、资料修改、删除等</div>
        <!-- ⚠️ 2026-10-02 体验修复：补「动作 / 结果 / 时间」筛选（此前只能从头翻到第 N 页人工找） -->
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <label style="font-size:12px;color:var(--text-dim);">动作
            <select class="input" id="auditAction" style="font-size:12px;padding:5px 8px;margin-left:4px;">
              <option value="">全部</option>
            </select></label>
          <label style="font-size:12px;color:var(--text-dim);">结果
            <select class="input" id="auditOk" style="font-size:12px;padding:5px 8px;margin-left:4px;">
              <option value="">全部</option>
              <option value="1">仅成功</option>
              <option value="0">仅失败</option>
            </select></label>
          <label style="font-size:12px;color:var(--text-dim);">时间
            <select class="input" id="auditRange" style="font-size:12px;padding:5px 8px;margin-left:4px;">
              <option value="">全部</option>
              <option value="1">近 1 小时</option>
              <option value="24">近 24 小时</option>
              <option value="168">近 7 天</option>
            </select></label>
          <button class="btn btn-ghost btn-sm" id="btnAuditReset">清除筛选</button>
          <span id="auditFilterHint" style="font-size:11px;color:var(--text-dim);"></span>
        </div>
        <div id="auditList" style="max-height:70vh;overflow-y:auto;"></div>
        <div id="auditPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- IP 封禁（PLAN §X） -->
      <div class="card" id="tab-ipbans" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>IP 封禁（<span id="ipbCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshIpBan">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.7;">
          封禁同时作用于<b>网页</b>与 <b>WebSocket（对局通道）</b>。
          ⚠️ 家庭 / 学校 / 公司常共用出口 IP，封一个可能误伤一大片——
          建议<b>优先封账号</b>，其次才用短时 IP 封禁。
        </div>
        <div id="ipbMyIp" style="font-size:12px;color:var(--text-dim);margin-bottom:10px;"></div>
        <div class="card" style="padding:14px;margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;background:var(--bg-2);">
          <label style="font-size:12px;">IP 或网段<br>
            <input class="input" id="ipbIp" placeholder="203.0.113.7 或 203.0.113.0/24" style="width:230px;padding:6px 10px;font-size:13px;"></label>
          <label style="font-size:12px;">理由（必填）<br>
            <input class="input" id="ipbReason" placeholder="如：刷接口 / 开小号" style="width:210px;padding:6px 10px;font-size:13px;"></label>
          <label style="font-size:12px;">时长<br>
            <select class="input" id="ipbHours" style="padding:6px 10px;font-size:13px;"></select></label>
          <button class="btn btn-primary btn-sm" id="btnIpBan">🚫 封禁</button>
        </div>
        <div id="ipbList" style="max-height:60vh;overflow-y:auto;"></div>
        <div id="ipbPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 举报处理（2026-09-20）：玩家在对局页提交，这里处理 -->
      <div class="card" id="tab-reports" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>举报处理（<span id="rpPending">0</span> 待处理 / 共 <span id="rpCount">0</span>）</span>
          <span style="display:flex;gap:8px;">
            <select class="input" id="rpFilter" style="font-size:12px;padding:5px 8px;">
              <option value="pending">仅待处理</option>
              <option value="">全部</option>
              <option value="handled">已处理</option>
              <option value="rejected">已驳回</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="btnRefreshReports">刷新</button>
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.7;">
          被举报人的名字由<b>服务端查会话</b>写入（不接受客户端传的名字），所以记录里的对象是可信的。
          ⚠️ 处理请以<b>证据</b>为准：这里的记录本身不是证据，棋谱才是（可从对局页导出）。
        </div>
        <div id="rpList" style="max-height:60vh;overflow-y:auto;"></div>
        <!-- 分页条：与其余 tab 一致（20 条/页） -->
        <div id="rpPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 公告管理（§C5）：此前只能手改 data/announcements.json -->
      <div class="card" id="tab-announcements" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>公告管理（<span id="anCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshAnn">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
          公告展示在首页与大厅。置顶的排在最前，其余按发布时间倒序。
        </div>
        <div class="card" style="padding:14px;margin-bottom:16px;background:var(--bg-2);">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <label style="font-size:12px;">标题<br>
              <input class="input" id="anTitle" placeholder="公告标题" style="width:240px;padding:6px 10px;font-size:13px;"></label>
            <label style="font-size:12px;display:flex;align-items:center;gap:6px;padding-bottom:6px;">
              <input type="checkbox" id="anPinned"> 置顶
            </label>
            <button class="btn btn-primary btn-sm" id="btnAnnAdd">＋ 发布公告</button>
            <button class="btn btn-ghost btn-sm" id="btnAnnCancelEdit" style="display:none;">取消编辑</button>
          </div>
          <label style="font-size:12px;display:block;margin-top:10px;">内容<br>
            <textarea class="input" id="anContent" rows="3" placeholder="公告内容" style="width:100%;padding:8px 10px;font-size:13px;resize:vertical;"></textarea></label>
          <div id="anEditHint" style="font-size:12px;color:var(--gold-light);margin-top:6px;display:none;"></div>
        </div>
        <div id="anList"></div>
        <div id="anPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 对局干预（§C6）：看在线房间并强制解散 / 强制下线 -->
      <div class="card" id="tab-rooms" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>在线房间（<span id="rmCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshRooms">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
          含私人房（大厅看不到的那种）。⚠️ 强制解散会立刻中断对局，房内的人会收到提示。
        </div>
        <div id="rmList" style="max-height:65vh;overflow-y:auto;"></div>
      </div>

      <!-- 用户详情弹层 -->
      <div class="modal-overlay" id="userDetailModal" role="dialog" aria-modal="true" aria-label="用户详情" style="display:none;">
        <div class="card" style="width:720px;max-width:94vw;max-height:86vh;overflow:auto;padding:24px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-size:20px;font-weight:800;" id="detailUserName"></div>
            <button class="btn btn-ghost btn-sm" data-act="modal-close">关闭</button>
          </div>
          <div id="detailBody"></div>
        </div>
      </div>
    </div>
  </main>`;
    },

    mount(container, params) {
      this._teardown = [];
      // 存活标志：所有异步回调恢复处先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入
      let alive = true;
      this._teardown.push(() => { alive = false; });

      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav(null)（导航由外壳渲染）
      const api = global.API;                // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 管理令牌（PLAN §J5）：`mount(container, params)` 的 params.adminToken 优先，
      // 回退 URL `?adminToken=`，均无则沿用 localStorage 里的 `tdshogi_admin_token`。
      // URL 里带 token 时回填 localStorage（原多页版「?adminToken= 或 localStorage 取 token」的约定）。
      try {
        const urlToken = (params && params.adminToken)
          || new URLSearchParams(global.location.search).get('adminToken');
        if (urlToken) setToken(urlToken);
      } catch (_) {}

      // 各列表的当前页。赛事那三个（待审核/进行中/历史）也在这里，**不要再另起一个 tnPages**
      // ——两套页码状态并存时，翻页行为会出现"这个列表记住了、那个列表没记住"的怪象（2026-09-14 归并）。
      //（每次 mount 重置：重新进入后台回到第 1 页，避免沿用旧页码停在空页。）
      const pages = {
        records: 1, users: 1, audit: 1, tournaments: 1,
        tnPending: 1, tnActive: 1, tnHistory: 1, ipbans: 1, announcements: 1, reports: 1,
      };

      // 跨模块函数表（原 window.adminPage / window.loadXxx / window.viewUser 等全局名）：
      // 单文档下挂 window 会跨页互相覆盖 → 收敛到本 View 的 _handlers 命名空间，unmount 清空。
      const hub = (this._handlers = this._handlers || {});

      /** 时间戳 → 「—」/本地时间（原 admin-users.js 的 fmtTime，audit / 用户详情弹层共用） */
      const fmtTime = (ts) => (ts ? global.I18N.fmt(ts) : '—');
      /** 时间戳 → 本地短格式；空值显示「不限」（申请表允许不填时间）（原 admin-tournaments.js 的 fmtTs） */
      function fmtTs(ts) {
        if (!ts) return '不限';
        return global.I18N.fmt(ts, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      }

      // 空/加载态统一（原 admin-shell.js 里的 global.AdminUI）：
      // ⚠️ 2026-10-02 体验修复（空状态/加载态统一）：此前每个 tab 各写各的话术——
      // 「暂无棋谱」/「没有符合条件的举报。」/「当前没有在线房间。」有的带句号有的不带，
      // "加载中"更是各页皆无（点开 tab 先是一片空白，看起来像坏了）。这里集中一份，
      // 由各子模块在渲染时取用，保证全后台两句话一个样。
      const AdminUI = {
        /** 统一空状态（各模块传入更具体的说明） */
        empty(text) {
          return `<div class="admin-empty" style="color:var(--text-dim);font-size:13px;padding:6px 2px;">${esc(text || '暂无数据')}</div>`;
        },
        /** 统一加载态占位 */
        loading(text) {
          return `<div class="admin-loading" style="color:var(--text-dim);font-size:13px;padding:6px 2px;">${esc(text || '加载中…')}</div>`;
        },
      };

      /**
       * 把"全量数据 → 列表渲染"包成分页渲染。
       *
       * **四个 tab 共用这一个函数**——同一份翻页逻辑抄四遍，迟早只改三处。
       * 刻意做成"包裹"而不是改各 render 函数内部：这样 render 只管画一页，
       * 分页状态集中在这里，两边职责不混。
       * 服务端目前仍全量下发；真到十万级数据时再改服务端分页，那时也只需动这一处。
       *
       * @param {string} key         tab 标识（用来记当前页码）
       * @param {Array}  items       全量数据
       * @param {string} pagerElId   分页条容器 id
       * @param {(slice:Array)=>void} render 只负责渲染传入的这一页
       * @param {boolean} [reset]    数据来源变了（如搜索）→ 回到第 1 页
       */
      function renderPaged(key, items, pagerElId, render, reset) {
        if (reset) pages[key] = 1;
        // 统一到 `UI.paginate`（2026-09-14）：admin 原先自己实现了一份分页条，
        // 与前台三处 + 赛事详情页那份并存——两边的按钮风格与边界行为（单页时显不显"共 N 条"、
        // 页码越界怎么夹）迟早会不一致。现在这里只是它的薄封装，只负责"用已有 items 重画"。
        const pg = UI.paginate({
          items,
          page: pages[key],
          size: PAGE_SIZE,
          container: pagerElId,
          onPage: (n) => adminPage(key, n), // 翻页走统一入口（会重拉数据，保持与刷新一致）
        });
        pages[key] = pg.page; // 页码被夹回时同步回来，避免停在空页
        render(pg.slice);
      }

      /**
       * 翻页：更新页码后重跑该 tab 的加载（保持与刷新一致的数据来源）。
       *（原 `window.adminPage` —— 现收敛进 hub，不再挂 window，unmount 后不可被误调用。）
       */
      function adminPage(key, page) {
        pages[key] = page;
        const load = {
          records: hub.loadRecords,
          users: hub.loadUsers,
          audit: hub.loadAudit,
          tournaments: hub.loadTournaments,
          ipbans: hub.loadIpBans,
          announcements: hub.loadAnnouncements,
          reports: hub.loadReports,
        }[key];
        if (load) load();
      }
      hub.adminPage = adminPage;

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        this._teardown.push(() => el.removeEventListener(ev, fn));
      };

      // `target="_blank"` 的「详情 ↗」链接：保留原行为——**新标签**打开赛事详情、管理员留在后台。
      //（router 会把 a[href] 站内跳转接管为 SPA 导航，这里在容器上先行拦截并 window.open。）
      const onBlankLink = (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[target="_blank"][href]');
        if (!a) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        try { global.open(a.getAttribute('href'), '_blank'); } catch (_) {}
      };
      container.addEventListener('click', onBlankLink);
      this._teardown.push(() => container.removeEventListener('click', onBlankLink));

      // ==================================================================
      // §M5（2026-09-28）：管理后台按 tab 拆到 admin-*.js
      // ==================================================================
      // 共用工具（token / esc / maskIp / toast / 分页 / AdminUI）在此注入各子模块；
      // 子模块只导出 `{ mount, unmount }`，由本 View 的生命周期驱动，**绝不自启**。
      const ctx = {
        api, UI, $, esc, toast,
        getToken, setToken, maskIp,
        pages, renderPaged, fmtTime, fmtTs, AdminUI,
        hub, guest,
        isAlive: () => alive,
        on,
      };
      const PARTS = ['shell', 'records', 'users', 'audit', 'tournaments', 'moderation', 'console', 'items'];
      for (const name of PARTS) {
        const part = global.AdminParts && global.AdminParts[name];
        if (!part || typeof part.mount !== 'function') {
          throw new Error('admin-' + name + '.js 必须在 admin.js 之前加载（<script> 顺序错了）');
        }
        part.mount(ctx);
        // 子模块自己的定时器 / 监听 / api.on 在其 unmount 内清 —— 一并记进本 View 的 teardown
        this._teardown.push(() => { try { part.unmount(); } catch (_) {} });
      }

      // 底部初始化（原文件末尾的 initUI()）：此时各模块已装配完毕，
      // 登录态检测 / 标签切换 / data-act 分派都由 AdminParts.shell 注册好了。
      if (hub.initUI) hub.initUI();
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
      // 跨模块句柄清空：离开后台后，原 window.xxx 风格的旧句柄不再可被误调用
      this._handlers = {};
    },
  };

  global.Views = global.Views || {};
  global.Views.admin = View;
})(typeof window !== 'undefined' ? window : globalThis);

/* ==== js/boot.js ==== */
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
