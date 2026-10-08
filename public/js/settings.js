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
