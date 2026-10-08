/* global loadAnnouncements, loadAudit, loadIpBans, loadRecords, loadReports, loadTournaments, loadUsers */
/**
 * admin.js — 管理后台：管理员登录、查看全部棋谱与用户数据
 */
(function () {
  const guest = window.NAV.renderNav(null);
  const ADMIN_KEY = 'tdshogi_admin_token';
  const api = window.API;
  api.connect(guest.id);

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }

  function getToken() {
    return localStorage.getItem(ADMIN_KEY);
  }
  function setToken(t) {
    if (t) localStorage.setItem(ADMIN_KEY, t);
    else localStorage.removeItem(ADMIN_KEY);
  }

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

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
  // 各列表的当前页。赛事那三个（待审核/进行中/历史）也在这里，**不要再另起一个 tnPages**
  // ——两套页码状态并存时，翻页行为会出现"这个列表记住了、那个列表没记住"的怪象（2026-09-14 归并）。
  const pages = {
    records: 1, users: 1, audit: 1, tournaments: 1,
    tnPending: 1, tnActive: 1, tnHistory: 1, ipbans: 1, announcements: 1, reports: 1,
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
    const pg = window.UI.paginate({
      items,
      page: pages[key],
      size: PAGE_SIZE,
      container: pagerElId,
      onPage: (n) => window.adminPage(key, n), // 翻页走统一入口（会重拉数据，保持与刷新一致）
    });
    pages[key] = pg.page; // 页码被夹回时同步回来，避免停在空页
    render(pg.slice);
  }

  /** 翻页：更新页码后重跑该 tab 的加载（保持与刷新一致的数据来源） */
  window.adminPage = function (key, page) {
    pages[key] = page;
    if (key === 'records') loadRecords();
    else if (key === 'users') loadUsers();
    else if (key === 'audit') loadAudit();
    else if (key === 'tournaments') loadTournaments();
    else if (key === 'ipbans') loadIpBans();
    else if (key === 'announcements') loadAnnouncements();
    else if (key === 'reports') loadReports();
  };

  // ==================================================================
  // §M5（2026-09-28）：管理后台按 tab 拆到 admin-*.js
  // ==================================================================
  // 共用工具（token / esc / maskIp / toast / 分页）留在本文件，装配时注入各模块；
  // ⚠️ 各模块必须在本文件**之前**加载（见 public/admin.html 的 <script> 顺序）。
  const deps = {
    api,
    esc,
    getToken,
    maskIp,
    pages,
    renderPaged,
    setToken,
    toast,
  };
  const MODULES = ['AdminShell', 'AdminRecords', 'AdminUsers', 'AdminAudit', 'AdminTournaments', 'AdminModeration', 'AdminConsole', 'AdminItems'];
  for (const m of MODULES) {
    if (!window[m]) throw new Error(m + '.js 必须在 admin.js 之前加载（<script> 顺序错了）');
    window[m].make(deps);
  }

  // 底部初始化（原文件末尾的 initUI()）：此时各模块已装配完毕，
  // 登录态检测 / 标签切换 / data-act 分派都由 AdminShell 注册好了。
  window.initUI();
})();
