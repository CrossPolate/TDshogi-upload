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
