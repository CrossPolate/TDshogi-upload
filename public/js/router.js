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
   * 离开守卫：View 可选实现 `confirmLeave(target)`（返回 false 则**阻断**本次导航）。
   * 典型用途——对局进行中的 play 页，离开前弹确认框，用户取消就留在原地（指导方案 §3「play 强状态」）。
   * `target` 是即将进入的 `{ viewName, params, hash, path }`；大厅用它区分
   * “用户切去别的页面”和“服务端开局自动跳 play”（后者绝不能退出等待房）。
   */
  function allowLeave(target) {
    if (currentView && typeof currentView.confirmLeave === 'function') {
      try { return currentView.confirmLeave(target) !== false; } catch (_) { return true; }
    }
    return true;
  }

  /**
   * 离开通知：确认放行之后、unmount 之前调用。
   *
   * ⚠️ 与 `confirmLeave()` 分开的原因：`confirmLeave()` 只回答“能不能走”，
   * 而 `onLeave()` 负责**告诉服务端“我走了”**（取消匹配 / 退出等待房 / 对局判负 / 结束观战）。
   * SPA 文档常驻、WebSocket 不会因切页断开——没有这一步，服务端会一直把玩家算在
   * 匹配队列 / 房间里（幽灵房、看不见的对局、观战人数虚高，都是这个根因）。
   *
   * 只在 `navigate` / `popstate`（用户真正离开当前页）调用；
   * `reload()`（身份变更重挂）**不调用**，否则会把正在进行的一局误判负。
   */
  function notifyLeave(target) {
    if (currentView && typeof currentView.onLeave === 'function') {
      try { currentView.onLeave(target); } catch (e) { console.error('[router] onLeave 出错', currentName, e); }
    }
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

  /** 渲染失败时的可见兜底（不再只 console.error 留一张空白页） */
  function renderErrorPage(title, detail) {
    const main = document.createElement('main');
    main.className = 'container';
    const card = document.createElement('div');
    card.className = 'card pad-card';
    card.style.cssText = 'padding:28px;text-align:center;';
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:16px;font-weight:800;margin-bottom:8px;';
    const p = document.createElement('div');
    p.textContent = detail || '';
    p.style.cssText = 'font-size:13px;color:var(--text-dim);margin-bottom:18px;line-height:1.8;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.dataset.routerRetry = '1';
    btn.textContent = '刷新页面';
    card.appendChild(h); card.appendChild(p); card.appendChild(btn);
    main.appendChild(card);
    return main;
  }

  /** 挂载失败时在页面顶部插入可见告警（页面结构通常已渲染，可刷新重试） */
  function mountErrorBar(viewName) {
    const bar = document.createElement('div');
    bar.className = 'card';
    bar.style.cssText = 'margin:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;'
      + 'border:1px solid rgba(201,162,39,0.35);font-size:13px;';
    const text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = `⚠️ 页面交互加载失败（${viewName}），部分按钮可能无响应。`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.dataset.routerRetry = '1';
    btn.textContent = '刷新页面';
    bar.appendChild(text); bar.appendChild(btn);
    return bar;
  }

  function bindRetryButtons(box) {
    if (!box || !box.querySelectorAll) return;
    box.querySelectorAll('[data-router-retry]').forEach((btn) => {
      btn.addEventListener('click', () => window.location.reload());
    });
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
    let renderErr = null;
    try {
      html = typeof view.render === 'function' ? (view.render(params) || '') : '';
    } catch (e) {
      renderErr = e;
      console.error('[router] render 出错', viewName, e);
    }
    if (renderErr) {
      box.innerHTML = '';
      box.appendChild(renderErrorPage('页面加载失败', '渲染这个页面时出错，请刷新重试。若反复出现，请反馈给管理员。'));
      bindRetryButtons(box);
      // 渲染失败的 View 没有 mount 过，不能登记为 currentView——否则下一次 teardown
      // 会对一个未初始化的 View 调 unmount。currentName 仍更新，供导航高亮/全局事件判断。
      currentView = null;
      currentName = viewName;
      currentUrl = location.pathname + location.search + location.hash;
      return;
    }
    box.innerHTML = html;

    // 2) 挂载行为
    currentView = view;
    currentName = viewName;
    currentUrl = location.pathname + location.search + location.hash;
    if (typeof view.mount === 'function') {
      try {
        view.mount(box, params);
      } catch (e) {
        console.error('[router] mount 出错', viewName, e);
        box.insertBefore(mountErrorBar(viewName), box.firstChild);
        bindRetryButtons(box);
      }
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

    // 先解析目标：离开守卫 / onLeave 需要知道“要去哪个页面”
    // （大厅据此区分“用户切走”与“服务端开局自动跳 play”，后者不能退出等待房）。
    const resolved = resolve(targetPath);

    // 离开守卫：当前 View 不放行（如对局进行中被取消）→ 留在原地，不动地址栏
    if (!allowLeave(resolved)) return;

    // 确认放行后再通知服务端（取消匹配 / 退出房间 / 对局判负 / 结束观战）
    notifyLeave(resolved);

    saveScroll();
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
    const resolved = resolve(location.pathname + location.search + location.hash);
    // 离开守卫：浏览器已后退到新 URL，若当前 View 不放行（如对局进行中取消离开），
    // 就把地址栏推回当前视图，保持原地不动。
    if (!allowLeave(resolved)) {
      try { history.pushState({ viewName: currentName }, '', currentUrl); } catch (_) {}
      return;
    }
    notifyLeave(resolved);
    render(resolved, { restoreScroll: true });
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
