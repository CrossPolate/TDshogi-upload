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
          if (previewEl && previewEl._pvSrc === src) { stopPreview(); return; }
          stopPreview();
          // 2026-10-08：试听前先停 BGM，避免叠音
          if (window.Sound && window.Sound.bgmPauseForPreview) window.Sound.bgmPauseForPreview();
          try {
            const a = new Audio(encodeURI(src));
            a._pvSrc = src;
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
