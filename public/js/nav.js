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
