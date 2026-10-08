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
      // ⚠️ 2026-10-08：换页续播 —— 同一首曲从上次位置继续，不从头来
      const seekSaved = () => {
        try {
          const t = restoreBgmPosition(url);
          if (t > 0 && Number.isFinite(a.duration) && t < a.duration - 1) a.currentTime = t;
        } catch (_) { /* ignore */ }
      };
      if (typeof a.addEventListener === 'function') {
        a.addEventListener('loadedmetadata', seekSaved);
      }
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

    if (!force && url && ((bgmMode === 'file' && bgmUrl === url) || (bgmMode === 'synth' && bgmSynthName === name))) {
      if (bgmMode === 'file' && bgmEl && bgmEl.paused) {
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

/* ==== js/tournaments.js ==== */
﻿/**
 * tournaments.js — 赛事页：我要创建赛事（需登录正式账号）、报名、对阵表渲染
 *
 * 页面只分两段展示：进行中的赛事（open/playing）与往期赛事（finished）。
 * 创建入口为顶部按钮：游客 → 引导登录；正式账号 → 弹窗填写后提交。
 */
(function () {
  const guest = window.NAV.renderNav('tournaments');
  const api = window.API;
  api.connect(guest.id);
  // 我的对局玩家 id：账号的 guest.id 是会话令牌（含点），参赛名单存的是 accountId
  const myPlayerId = guest.id && String(guest.id).includes('.')
    ? String(guest.id).split('.')[0]
    : guest.id;
  // 本窗口刚提交、还在审核中的赛事（公共列表不返回 pending，仅本地展示）
  let myPending = [];

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }

  // ==================================================================
  // 视图切换：全部赛事 ⇄ 我的赛事（2026-09-13 用户要求）
  // 「我的赛事」按钮紧挨创建按钮；我的赛事 = 我主办的 + 我参赛/报名的
  // ==================================================================
  const mainSection = document.getElementById('mainSection');
  const mineSection = document.getElementById('mineSection');
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
  document.getElementById('btnMyTournaments').addEventListener('click', () => showMine(true));
  document.getElementById('btnBackFromMine').addEventListener('click', () => showMine(false));

  // ---- 创建赛事 ----
  const modalEl = document.getElementById('createModal');

  /** §6.3：弹窗开关统一走这两个函数——顺带做焦点管理（Esc 可关闭、关闭后焦点归还触发按钮） */
  const closeCreateModal = () => {
    modalEl.style.display = 'none';
    if (window.A11y) window.A11y.onDialogClose(modalEl);
  };
  const openCreateModal = () => {
    modalEl.style.display = 'flex';
    if (window.A11y) window.A11y.onDialogOpen(modalEl, { onClose: closeCreateModal });
  };

  document.getElementById('btnCreateTournament').addEventListener('click', () => {
    // 正式账号的 guest.id 是会话令牌（含点号）；游客是 24 hex 纯十六进制
    if (!guest.id || !String(guest.id).includes('.')) {
      toast('创建赛事需要登录正式账号，请先登录');
      setTimeout(() => { location.href = 'profile.html'; }, 800);
      return;
    }
    openCreateModal();
  });

  document.getElementById('btnCloseCreateModal').addEventListener('click', closeCreateModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeCreateModal();
  });

  // ==================================================================
  // 等级特权（2026-09-20 用户要求：等级 5 才能举办赛事）
  //
  // ⚠️ 门槛数值**不在前端写死**：服务端随 hello 下发
  // `privileges.create_tournament = { need, ok }`（由 `LEVEL_PRIVILEGES` 表推导）。
  // 前端抄一份，改门槛时就会出现"服务端放行了但按钮还是灰的"。
  // ⚠️ 这一层只是"别让用户点一个必然失败的按钮"；**真正的拦截在服务端**
  // （`tournaments.createTournament` 里的 `ratings.hasPrivilege`）——绕过前端照样建不了赛。
  // ==================================================================
  const btnCreate = document.getElementById('btnCreateTournament');
  const createHint = document.getElementById('createLevelHint');
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

  api.on('hello', (d) => {
    if (d && d.privileges) applyCreatePrivilege(d.privileges.create_tournament, d.level);
  });
  // hello 可能已经先到了（connect() 在本行之前调用），补判一次
  if (api.privileges) applyCreatePrivilege(api.privileges.create_tournament, api.level);

  /** `datetime-local` 的值 → 时间戳；留空 → null（视为"不限"） */
  function tsOf(id) {
    const v = document.getElementById(id).value;
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }

  // 赛制切换：轮数只对瑞士制有意义（淘汰赛的轮数是人数决定的）
  const formatSel = document.getElementById('tFormat');
  const roundsWrap = document.getElementById('tRoundsWrap');
  const swissHint = document.getElementById('tSwissHint');
  function syncFormatFields() {
    const isSwiss = formatSel.value === 'swiss';
    roundsWrap.style.display = isSwiss ? '' : 'none';
    swissHint.style.display = isSwiss ? '' : 'none';
  }
  formatSel.addEventListener('change', syncFormatFields);
  syncFormatFields();

  document.getElementById('btnSubmitCreate').addEventListener('click', () => {
    const name = document.getElementById('tName').value.trim();
    const size = parseInt(document.getElementById('tSize').value, 10);
    const format = document.getElementById('tFormat').value;
    const reason = document.getElementById('tReason').value.trim();
    const registerStart = tsOf('tRegStart');
    const registerEnd = tsOf('tRegEnd');
    const matchStart = tsOf('tMatchStart');
    const matchEnd = tsOf('tMatchEnd');
    const requireApproval = document.getElementById('tRequireApproval').checked;
    // 空字符串 = "按人数自动"，交给服务端给建议值（前端不重复实现那个公式）
    const roundsRaw = document.getElementById('tRounds').value;
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
  });

  api.on('tournament_created', (data) => {
    toast(`赛事「${data.name}」创建申请已提交，等待管理员审核`);
    modalEl.style.display = 'none';
    if (data.status === 'pending_approval') myPending.push(data);
    loadTournaments();
  });
  api.on('tournament_joined', (d) => {
    // T3：两段式报名——需审核时只是"申请已提交"，别给用户"已经参赛"的错觉
    if (d && d.pending) toast('报名已提交，等待主办人批准');
    else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
    else toast('报名成功');
    loadTournaments();
  });
  api.on('error', (data) => {
    if (data && data.message) toast(data.message);
  });

  // 赛事对局开始：在线参赛者自动进入对局页
  api.on('game_start', (data) => {
    if (data && data.roomId && !location.search.includes('room=')) {
      location.href = `play.html?room=${data.roomId}&join=1`;
    }
  });

  async function loadTournaments() {
    try {
      const data = await window.ApiUtils.get('/api/tournaments');
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
    const el = document.getElementById('mineList');
    const mine = all.filter(isMine);
    if (!mine.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">你还没有参与任何赛事。报名一场，或点「🏆 我要创建赛事」自己办一个吧！</div>';
      window.UI.paginate({ items: [], container: 'minePager' });
      return;
    }
    const pg = window.UI.paginate({
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
    const el = document.getElementById(listElId);
    if (!list.length) {
      el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${
        mode === 'row' ? '还没有结束的赛事。' : '暂无进行中的赛事，点右上角「🏆 我要创建赛事」开一个吧！'
      }</div>`;
      window.UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
      return;
    }
    const pg = window.UI.paginate({
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

  window.joinTournament = (id) => {
    api.send({ type: 'join_tournament', data: { id } });
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

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  // 「报名」按钮：从 inline onclick 改为 data-act 委托（2026-09-23，审查项 13f）。
  // 赛事 id 虽是服务端生成的，但**拼进属性**这件事本身就不该做 ——
  // 改属性文本后，即使哪天 id 里出现引号也逃不出属性（见 util.js 的 onAction 注释）。
  window.UI.onAction('join-tn', (el) => window.joinTournament(el.getAttribute('data-id')));

  loadTournaments();
  setInterval(loadTournaments, 5000);  // 轮询：检测新对局安排/对阵推进
})();
