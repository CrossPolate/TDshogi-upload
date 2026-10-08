/* global loadAnnouncements, loadAudit, loadIpBans, loadOverview, loadRecords, loadReports, loadRooms, loadTournaments, loadUsers */
/**
   * admin-shell.js — 页面外壳：登录/登出、标签切换、`data-act` 分派
   *
   * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**，
   * 逻辑一字未改，只整体左移 2 格缩进。共用工具（token / $ / esc / maskIp / 分页）仍由
   * `admin.js` 装配时注入（见下方 `make(deps)`）。
   *
   * ⚠️ 本文件必须在 `admin.js` **之前**加载（见 public/admin.html 的 <script> 顺序）；
   * `admin.js` 装配时会检查，缺失即抛错——不然症状是"某个 tab 点了没反应"这种静默故障。
   */
  (function (global) {
    'use strict';

    function make(deps) {
      // 共用工具（由 admin.js 装配时注入）
    const { api, getToken, setToken, toast } = deps;
  // 初始化：检测是否已登录
function initUI() {
  const isAdmin = !!getToken();
  document.getElementById('adminLoginCard').style.display = isAdmin ? 'none' : 'block';
  document.getElementById('adminPanel').style.display = isAdmin ? 'block' : 'none';
  // ⚠️ 2026-10-02 体验修复：退出按钮已移入 #adminPanel（随面板显隐），不再单独控制 display
  //（原写法把按钮留在登录卡片内、又单独设 inline-block，父容器隐藏 → 按钮永远不可见）。
  if (isAdmin) {
    // 只加载默认 tab（总览）。其余 tab 切过去再拉——
    // 原先进后台会把四个重查询（棋谱/用户/赛事/审计）全跑一遍，首屏白等很久，
    // 而多数时候管理员只看其中一两个。
    loadOverview();
  }
}

// ---- 登录 / 登出 ----
document.getElementById('btnAdminLogin').addEventListener('click', () => {
  const password = document.getElementById('adminPassword').value;
  if (!password) return toast('请输入管理密码');
  api.send({ type: 'admin_login', data: { password } });
});
api.on('admin_logged_in', (data) => {
  setToken(data.token);
  toast('管理员登录成功');
  initUI();
  window.NAV.renderNav(null); // 重渲染导航：登录后显示管理入口（PLAN §J5）
});
api.on('error', (data) => {
  if (data && data.message) toast(data.message);
});
document.getElementById('btnAdminLogout').addEventListener('click', () => {
  setToken(null);
  toast('已退出管理员');
  initUI();
  window.NAV.renderNav(null); // 重渲染导航：登出后隐藏管理入口（PLAN §J5）
});

// ---- 标签切换 ----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.classList.toggle('btn-ghost', b !== btn);
    });
    // ⚠️ 2026-10-02 审查 P1-7：必须含 'rooms'/'reports'，否则这两页（初始 display:none）永不被置为 block。
    ['overview', 'records', 'users', 'tournaments', 'rooms', 'reports', 'announcements', 'audit', 'ipbans', 'items'].forEach((t) => {
      const el = document.getElementById('tab-' + t);
      if (el) el.style.display = t === btn.dataset.tab ? 'block' : 'none';
    });
    // 切到该 tab 才拉数据（避免进后台就把所有接口白跑一遍）
    if (btn.dataset.tab === 'ipbans') loadIpBans();
    else if (btn.dataset.tab === 'announcements') loadAnnouncements();
    else if (btn.dataset.tab === 'rooms') loadRooms();
    else if (btn.dataset.tab === 'overview') loadOverview();
    else if (btn.dataset.tab === 'records') loadRecords();
    else if (btn.dataset.tab === 'users') loadUsers();
    else if (btn.dataset.tab === 'tournaments') loadTournaments();
    else if (btn.dataset.tab === 'audit') loadAudit();
    else if (btn.dataset.tab === 'reports') loadReports();
    // 道具（2026-10-03 新功能）：走 window. 前缀调用，避免动本文件顶部的 /* global */ 清单
    else if (btn.dataset.tab === 'items' && window.loadItemsAdmin) window.loadItemsAdmin();
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
// ⚠️ 处理器一律写成 `window.xxx`：本页的处理函数都是 `window.xxx = …` 赋的，
// 直接写裸名既是未定义标识符、也会被 eslint 的 `no-undef` 拦下。
// ==================================================================
{
  const at = (el, k) => el.getAttribute(k);
  window.UI.onAction('rb-playback', (el) => window.adminPlayback(at(el, 'data-id')));
  window.UI.onAction('rb-export', (el) => window.adminExport(at(el, 'data-id'), at(el, 'data-fmt')));
  window.UI.onAction('reveal-ip', (el) => {
    el.textContent = at(el, 'data-text');
    el.removeAttribute('title');
    el.style.cursor = 'default';
  });
  window.UI.onAction('user-view', (el) => window.viewUser(at(el, 'data-id')));
  window.UI.onAction('user-ban', (el) => window.adminBan(at(el, 'data-id'), at(el, 'data-name')));
  window.UI.onAction('user-unban', (el) => window.adminUnban(at(el, 'data-id'), at(el, 'data-name')));
  window.UI.onAction('user-save-profile', (el) => window.adminSaveProfile(at(el, 'data-id')));
  window.UI.onAction('user-save-elo', (el) => window.adminSaveElo(at(el, 'data-id')));
  window.UI.onAction('user-rename', (el) => window.adminRename(at(el, 'data-id'), at(el, 'data-name')));
  window.UI.onAction('user-reset-rating', (el) => window.adminResetRating(at(el, 'data-id'), at(el, 'data-name')));
  window.UI.onAction('user-reset-pwd', (el) => window.adminResetPassword(at(el, 'data-id'), at(el, 'data-name')));
  window.UI.onAction('user-delete', (el) => window.adminDeleteAccount(at(el, 'data-id'), at(el, 'data-name')));
  window.UI.onAction('tn-approve', (el) => window.tnApprove(at(el, 'data-id')));
  window.UI.onAction('tn-reject', (el) => window.tnReject(at(el, 'data-id')));
  window.UI.onAction('tn-cancel', (el) => window.tnCancel(at(el, 'data-id')));
  window.UI.onAction('tn-archive', (el) => window.tnArchive(at(el, 'data-id')));
  // 用户详情弹窗的「关闭」（原先写在 admin.html 的 inline onclick 里）
  window.UI.onAction('modal-close', () => {
    const m = document.getElementById('userDetailModal');
    if (m) {
      m.style.display = 'none';
      if (window.A11y) window.A11y.onDialogClose(m); // §6.3：焦点归还触发者
    }
  });

  // ⚠️ 2026-10-02 体验修复（棋谱就地编辑入口）：列表里新增的「✏️ 编辑」按钮改走
  // 这里的分派（data-act）→ admin-records.js 的 window.adminRecordEdit，就地展开表单，
  // 不再需要"跳去另一个页面再回来"。三条动作（展开 / 取消 / 保存）都走委托，
  // 列表整块重渲染也不会丢监听——与文件顶部 13f 的其余动作同一套机制。
  window.UI.onAction('record-edit', (el) => window.adminRecordEdit(at(el, 'data-id')));
  window.UI.onAction('record-edit-cancel', (el) => window.adminRecordEditCancel(at(el, 'data-id')));
  window.UI.onAction('record-edit-save', (el) => window.adminRecordSave(at(el, 'data-id')));
  // ⚠️ 2026-10-02 体验修复（举报 id 可点）：举报列表里的目标 id 走与「查看详情」同一处理，
  // 点击即打开用户详情弹层（复用 user-view，不新造一条跳转逻辑）。
  window.UI.onAction('report-target-view', (el) => window.viewUser(at(el, 'data-id')));
}

    // ⚠️ 2026-10-02 体验修复（空状态/加载态统一）：此前每个 tab 各写各的话术——
    // 「暂无棋谱」/「没有符合条件的举报。」/「当前没有在线房间。」有的带句号有的不带，
    // "加载中"更是各页皆无（点开 tab 先是一片空白，看起来像坏了）。这里集中一份，
    // 由各模块在渲染时取用，保证全后台两句话一个样。定义放在 make() 里、且在其它
    // 模块之前执行（admin.js 的 MODULES 顺序把 AdminShell 排在首位），所以各 tab
    // 渲染时 global.AdminUI 已经就绪。
    global.AdminUI = {
      /** 统一空状态（各模块传入更具体的说明） */
      empty(text) {
        return `<div class="admin-empty" style="color:var(--text-dim);font-size:13px;padding:6px 2px;">${window.UI.esc(text || '暂无数据')}</div>`;
      },
      /** 统一加载态占位 */
      loading(text) {
        return `<div class="admin-loading" style="color:var(--text-dim);font-size:13px;padding:6px 2px;">${window.UI.esc(text || '加载中…')}</div>`;
      },
    };

    // ---- 供其它模块调用（admin.js 装配时按依赖顺序执行，见该文件）----
    global.initUI = initUI;

      return {
        initUI,
      };
    }

    global.AdminShell = { make };
  })(typeof window !== 'undefined' ? window : globalThis);
  