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
