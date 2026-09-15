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

  function genId() {
    let s = '';
    const hex = '0123456789abcdef';
    for (let i = 0; i < 24; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }

  function randomName() {
    const list = ['无名棋士', '一歩名人', '飛車使い', '銀将', '桂馬', '香車', '角行', '竜王', '棋聖', '玉将'];
    return list[Math.floor(Math.random() * list.length)];
  }

  const NAV = [
    { id: 'home', label: '首页', href: 'index.html' },
    { id: 'lobby', label: '对战', href: 'lobby.html' },
    { id: 'history', label: '棋谱', href: 'history.html' },
    // 棋谱广场**不再占顶部导航**（2026-09-13 用户要求：导航省空间），
    // 入口移到棋谱页标题右侧的角落按钮（见 history.html）。
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
    const btn = document.querySelector('.theme-toggle');
    if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }

  function renderNav(current) {
    const guest = getGuest();
    const isAccount = typeof guest.id === 'string' && guest.id.includes('.');
    const userBadge = isAccount ? '🔐' : '👤';
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
          ${NAV.map((n) => `<a href="${n.href}" class="${n.id === current ? 'active' : ''}" data-nav="${n.id}">${n.label}</a>`).join('')}
        </nav>
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="theme-toggle" title="切换主题" onclick="NAV.toggleTheme()">🌙</button>
          <button class="theme-toggle" title="设置" onclick="Settings.openPanel()">⚙️</button>
          ${adminEntryHtml()}
          <a class="nav-user" href="profile.html" title="个人页面/账号">
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
          ${NAV.map((x) => `<a href="${x.href}" class="${x.id === current ? 'active' : ''}">${x.label}</a>`).join('')}
        </nav>
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="theme-toggle" title="切换主题" onclick="NAV.toggleTheme()">🌙</button>
          <button class="theme-toggle" title="设置" onclick="Settings.openPanel()">⚙️</button>
          ${adminEntryHtml()}
        </div>
      `;
      document.body.insertBefore(n, document.body.firstChild);
    }
    applyTheme();
    return guest;
  }

  function toggleTheme() {
    const next = getTheme() === 'light' ? 'dark' : 'light';
    if (global.Settings) global.Settings.set('theme', next);
    else localStorage.setItem(THEME_KEY, next);
    applyTheme();
  }

  global.NAV = { renderNav, getGuest, saveGuest, updateUserName, randomName, genId, GUEST_KEY, THEME_KEY, ADMIN_KEY, isAdminSession, toggleTheme, getTheme, applyTheme };
})(window);
