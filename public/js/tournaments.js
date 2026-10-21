/**
 * tournaments.js — 赛事列表页 View：我要创建赛事（需登录正式账号）、报名、对阵表渲染
 *
 * 页面只分两段展示：进行中的赛事（open/playing）与往期赛事（finished）。
 * 创建入口为顶部按钮：游客 → 引导登录；正式账号 → 弹窗填写后提交。
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回原 tournaments.html 的主体（<main> + 创建赛事弹窗）
 *   mount(container, params)→ 原 IIFE 主体逻辑全部搬进来，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式与 home.js 一致：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / api.on / 监听，统一在 unmount 清理。
 *   - `window.joinTournament` 收敛到 `Views.tournaments._handlers`（跨页防串）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '赛事 · TDShogi',

    // 跨页句柄命名空间（供 data-act 委托 / 遗留 inline onclick 调用）。
    // unmount 时清空 → 离开页面后旧句柄不再被误调用。
    _handlers: {},
    _mounted: false,

    render() {
      // —— 原 tournaments.html 的主体：<main class="container"> 与创建赛事弹窗，逐字保留
      //   （toast / script / 导航在外壳里，不搬） ——
      return `
  <main class="container">
    <!-- 顶部：标题 + 入口（创建需登录正式账号，后端审核流程见 docs/PLAN.md 与 docs/TOURNAMENT.md） -->
    <div class="card" style="padding:24px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;">
      <div>
        <div class="section-title" style="margin-bottom:6px;">棋手赛事</div>
        <div style="font-size:13px;color:var(--text-dim);">单败淘汰 / 瑞士制 · 报名满员自动开赛 · 赛事对局不计 ELO</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
        <!-- 「我的赛事」紧挨创建按钮（2026-09-13 用户要求）：我的赛事 = 我主办的 + 我参赛/报名的 -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-lg" id="btnMyTournaments">📋 我的赛事</button>
          <button class="btn btn-primary btn-lg" id="btnCreateTournament">🏆 我要创建赛事</button>
        </div>
        <!-- 等级特权提示（2026-09-20）：等级不足时禁用创建按钮并说明差多少 -->
        <div id="createLevelHint" style="font-size:12px;color:var(--gold-light);display:none;max-width:320px;text-align:right;line-height:1.6;"></div>
      </div>
    </div>

    <!-- 我的赛事视图（点顶部按钮切换；默认隐藏） -->
    <div id="mineSection" style="display:none;">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>我的赛事</span>
        <button class="btn btn-ghost btn-sm" id="btnBackFromMine">← 返回全部赛事</button>
      </div>
      <div id="mineList"></div>
      <!-- 分页条（2026-09-13）：赛事列表每页 20 条，避免赛事一多把页面撑爆 -->
      <div id="minePager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
    </div>

    <!-- 主视图 -->
    <div id="mainSection">
      <!-- 进行中的赛事（报名中 / 比赛中 / 审核中） -->
      <div class="section-title">进行中的赛事</div>
      <div id="ongoingList"></div>
      <div id="ongoingPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin:10px 0 32px;flex-wrap:wrap;"></div>

      <!-- 往期赛事：**只列一行摘要**，不展开对阵图与参赛名单
           （2026-09-13 用户要求；赛事一多，每张卡片都铺开对阵表会把页面拉得很长） -->
      <div class="section-title">往期赛事</div>
      <div id="finishedList"></div>
      <div id="finishedPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
    </div>
  </main>

  <!-- 创建赛事弹窗（T2：完整申请表，需求 9） -->
  <div class="modal-overlay" id="createModal" role="dialog" aria-modal="true" aria-label="创建赛事" style="display:none;">
    <div class="card" style="width:540px;max-width:94vw;max-height:88vh;overflow-y:auto;padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:19px;font-weight:800;">赛事创建申请</div>
        <button class="btn btn-ghost btn-sm" id="btnCloseCreateModal">关闭</button>
      </div>

      <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">赛事名称</div>
      <input class="input" id="tName" placeholder="如：暑期棋王赛" maxlength="20" style="width:100%;">

      <div style="display:flex;gap:12px;margin-top:14px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">参赛人数</div>
          <select class="select" id="tSize" style="width:100%;">
            <option value="4">4 人</option>
            <option value="8">8 人</option>
            <option value="16" selected>16 人</option>
            <option value="32">32 人</option>
          </select>
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">赛制</div>
          <select class="select" id="tFormat" style="width:100%;">
            <option value="single-elimination" selected>单败淘汰</option>
            <option value="swiss">瑞士制（积分编排）</option>
            <option value="round-robin" disabled>循环赛（待实装）</option>
          </select>
        </div>
        <!-- 轮数（仅瑞士制）：不填则按人数自动给建议值 -->
        <div style="flex:1;" id="tRoundsWrap">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">轮数（瑞士制）</div>
          <select class="select" id="tRounds" style="width:100%;">
            <option value="">按人数自动（推荐）</option>
            <option value="3">3 轮</option>
            <option value="4">4 轮</option>
            <option value="5">5 轮</option>
            <option value="6">6 轮</option>
            <option value="7">7 轮</option>
            <option value="8">8 轮</option>
            <option value="9">9 轮</option>
          </select>
        </div>
      </div>
      <div id="tSwissHint" style="font-size:12px;color:var(--text-dim);margin-top:8px;display:none;">
        瑞士制按积分逐轮配对（强者遇强者、不重复对阵），没有淘汰——输一两场仍有机会。
        人数为奇数时，每轮积分最低且未轮空过的一人轮空（视同胜）。
      </div>

      <div style="font-size:12px;color:var(--text-dim);margin:14px 0 6px;">举办理由（10–200 字，管理员据此审核）</div>
      <textarea class="input" id="tReason" rows="3" maxlength="200" placeholder="说明办赛目的、面向人群、赛程安排等" style="width:100%;resize:vertical;font-family:inherit;"></textarea>

      <div style="display:flex;gap:12px;margin-top:14px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">报名开始</div>
          <input class="input" type="datetime-local" id="tRegStart" style="width:100%;">
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">报名结束</div>
          <input class="input" type="datetime-local" id="tRegEnd" style="width:100%;">
        </div>
      </div>

      <div style="display:flex;gap:12px;margin-top:12px;">
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">比赛开始</div>
          <input class="input" type="datetime-local" id="tMatchStart" style="width:100%;">
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">比赛结束</div>
          <input class="input" type="datetime-local" id="tMatchEnd" style="width:100%;">
        </div>
      </div>

      <label style="display:flex;align-items:center;gap:8px;margin-top:16px;font-size:13px;cursor:pointer;">
        <input type="checkbox" id="tRequireApproval" checked>
        <span>报名需我审核（关闭则报名即参赛）</span>
      </label>

      <div style="font-size:12px;color:var(--text-dim);margin-top:12px;line-height:1.7;">
        提交后进入<b>管理员审核</b>，通过后才开放报名。<br>
        <b>主办人不会自动参赛</b>——想下棋请另外报名。<br>
        时间未填写的项视为「不限」。
      </div>

      <button class="btn btn-primary" id="btnSubmitCreate" style="width:100%;margin-top:16px;">提交申请</button>
    </div>
  </div>`;
    },

    mount(container, params) {
      this._teardown = [];
      this._mounted = true;
      const guest = global.NAV.getGuest();
      const api = global.API;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      // 我的对局玩家 id：账号的 guest.id 是会话令牌（含点），参赛名单存的是 accountId
      const myPlayerId = guest.id && String(guest.id).includes('.')
        ? String(guest.id).split('.')[0]
        : guest.id;
      // 本窗口刚提交、还在审核中的赛事（公共列表不返回 pending，仅本地展示）
      let myPending = [];

      // ==================================================================
      // 视图切换：全部赛事 ⇄ 我的赛事（2026-09-13 用户要求）
      // 「我的赛事」按钮紧挨创建按钮；我的赛事 = 我主办的 + 我参赛/报名的
      // ==================================================================
      const mainSection = $('mainSection');
      const mineSection = $('mineSection');
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
      const onMyTournaments = () => showMine(true);
      const onBackFromMine = () => showMine(false);
      $('btnMyTournaments').addEventListener('click', onMyTournaments);
      $('btnBackFromMine').addEventListener('click', onBackFromMine);
      this._teardown.push(() => $('btnMyTournaments').removeEventListener('click', onMyTournaments));
      this._teardown.push(() => $('btnBackFromMine').removeEventListener('click', onBackFromMine));

      // ---- 创建赛事 ----
      const modalEl = $('createModal');

      /** §6.3：弹窗开关统一走这两个函数——顺带做焦点管理（Esc 可关闭、关闭后焦点归还触发按钮） */
      const closeCreateModal = () => {
        modalEl.style.display = 'none';
        if (global.A11y) global.A11y.onDialogClose(modalEl);
      };
      const openCreateModal = () => {
        modalEl.style.display = 'flex';
        if (global.A11y) global.A11y.onDialogOpen(modalEl, { onClose: closeCreateModal });
      };

      const onCreateClick = () => {
        // 正式账号的 guest.id 是会话令牌（含点号）；游客是 24 hex 纯十六进制
        if (!guest.id || !String(guest.id).includes('.')) {
          toast('创建赛事需要登录正式账号，请先登录');
          // SPA：整页跳转改路由（超时句柄记进 teardown，切页即取消）
          const goLogin = setTimeout(() => { global.Router.navigate('profile.html'); }, 800);
          this._teardown.push(() => clearTimeout(goLogin));
          return;
        }
        openCreateModal();
      };
      $('btnCreateTournament').addEventListener('click', onCreateClick);
      this._teardown.push(() => $('btnCreateTournament').removeEventListener('click', onCreateClick));

      const onCloseModalClick = () => closeCreateModal();
      $('btnCloseCreateModal').addEventListener('click', onCloseModalClick);
      this._teardown.push(() => $('btnCloseCreateModal').removeEventListener('click', onCloseModalClick));

      const onModalOverlay = (e) => {
        if (e.target === modalEl) closeCreateModal();
      };
      modalEl.addEventListener('click', onModalOverlay);
      this._teardown.push(() => modalEl.removeEventListener('click', onModalOverlay));

      // ==================================================================
      // 等级特权（2026-09-20 用户要求：等级 5 才能举办赛事）
      //
      // ⚠️ 门槛数值**不在前端写死**：服务端随 hello 下发
      // `privileges.create_tournament = { need, ok }`（由 `LEVEL_PRIVILEGES` 表推导）。
      // 前端抄一份，改门槛时就会出现"服务端放行了但按钮还是灰的"。
      // ⚠️ 这一层只是"别让用户点一个必然失败的按钮"；**真正的拦截在服务端**
      // （`tournaments.createTournament` 里的 `ratings.hasPrivilege`）——绕过前端照样建不了赛。
      // ==================================================================
      const btnCreate = $('btnCreateTournament');
      const createHint = $('createLevelHint');
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

      // WS 订阅（api.on 返回退订函数 → 记进 teardown）
      this._teardown.push(api.on('hello', (d) => {
        if (d && d.privileges) applyCreatePrivilege(d.privileges.create_tournament, d.level);
      }));
      // hello 可能已经先到了（外壳持有常驻 WS），补判一次
      if (api.privileges) applyCreatePrivilege(api.privileges.create_tournament, api.level);

      /** `datetime-local` 的值 → 时间戳；留空 → null（视为"不限"） */
      function tsOf(id) {
        const v = $(id).value;
        if (!v) return null;
        const t = new Date(v).getTime();
        return Number.isFinite(t) ? t : null;
      }

      // 赛制切换：轮数只对瑞士制有意义（淘汰赛的轮数是人数决定的）
      const formatSel = $('tFormat');
      const roundsWrap = $('tRoundsWrap');
      const swissHint = $('tSwissHint');
      function syncFormatFields() {
        const isSwiss = formatSel.value === 'swiss';
        roundsWrap.style.display = isSwiss ? '' : 'none';
        swissHint.style.display = isSwiss ? '' : 'none';
      }
      formatSel.addEventListener('change', syncFormatFields);
      this._teardown.push(() => formatSel.removeEventListener('change', syncFormatFields));
      syncFormatFields();

      const onSubmitCreate = () => {
        const name = $('tName').value.trim();
        const size = parseInt($('tSize').value, 10);
        const format = $('tFormat').value;
        const reason = $('tReason').value.trim();
        const registerStart = tsOf('tRegStart');
        const registerEnd = tsOf('tRegEnd');
        const matchStart = tsOf('tMatchStart');
        const matchEnd = tsOf('tMatchEnd');
        const requireApproval = $('tRequireApproval').checked;
        // 空字符串 = "按人数自动"，交给服务端给建议值（前端不重复实现那个公式）
        const roundsRaw = $('tRounds').value;
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
      };
      $('btnSubmitCreate').addEventListener('click', onSubmitCreate);
      this._teardown.push(() => $('btnSubmitCreate').removeEventListener('click', onSubmitCreate));

      this._teardown.push(api.on('tournament_created', (data) => {
        toast(`赛事「${data.name}」创建申请已提交，等待管理员审核`);
        modalEl.style.display = 'none';
        if (data.status === 'pending_approval') myPending.push(data);
        loadTournaments();
      }));
      this._teardown.push(api.on('tournament_joined', (d) => {
        // T3：两段式报名——需审核时只是"申请已提交"，别给用户"已经参赛"的错觉
        if (d && d.pending) toast('报名已提交，等待主办人批准');
        else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
        else toast('报名成功');
        loadTournaments();
      }));
      this._teardown.push(api.on('error', (data) => {
        if (data && data.message) toast(data.message);
      }));

      // 赛事对局开始：在线参赛者自动进入对局页
      this._teardown.push(api.on('game_start', (data) => {
        if (data && data.roomId && !location.search.includes('room=')) {
          // SPA：整页跳转改路由
          global.Router.navigate(`play.html?room=${data.roomId}&join=1`);
        }
      }));

      async function loadTournaments() {
        try {
          const data = await global.ApiUtils.get('/api/tournaments');
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
        const el = $('mineList');
        const mine = all.filter(isMine);
        if (!mine.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">你还没有参与任何赛事。报名一场，或点「🏆 我要创建赛事」自己办一个吧！</div>';
          UI.paginate({ items: [], container: 'minePager' });
          return;
        }
        const pg = UI.paginate({
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
        const el = $(listElId);
        if (!list.length) {
          el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${
            mode === 'row' ? '还没有结束的赛事。' : '暂无进行中的赛事，点右上角「🏆 我要创建赛事」开一个吧！'
          }</div>`;
          UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
          return;
        }
        const pg = UI.paginate({
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

      // ⚠️ 原 `window.joinTournament = (id) => {…}` 是跨页全局（inline onclick 用）：
      // 单文档下会互相覆盖 / 离开页面后旧句柄仍可被误调用。
      // 现收敛到 `Views.tournaments._handlers` 命名空间，unmount 清空即失效。
      this._handlers = {
        joinTournament: (id) => {
          if (!View._mounted) return; // 离开页面后旧句柄不再被误触发
          api.send({ type: 'join_tournament', data: { id } });
        },
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

      loadTournaments();
      const pollTimer = setInterval(loadTournaments, 5000); // 轮询：检测新对局安排/对阵推进
      this._teardown.push(() => clearInterval(pollTimer));
    },

    unmount() {
      this._mounted = false;
      this._handlers = {}; // 旧句柄失效：委托 / 遗留 inline 入口都调不到
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  // 「报名」按钮：从 inline onclick 改为 data-act 委托（2026-09-23，审查项 13f）。
  // 赛事 id 虽是服务端生成的，但**拼进属性**这件事本身就不该做 ——
  // 改属性文本后，即使哪天 id 里出现引号也逃不出属性（见 util.js 的 onAction 注释）。
  // util.js 的委托注册是**整页一份的全局表**（没有 off），故在模块级注册一次、
  // 逻辑经 `_handlers` 命名空间转发——unmount 清空 `_handlers` 后即不可达。
  UI.onAction('join-tn', (el) => {
    const h = View._handlers && View._handlers.joinTournament;
    if (h) h(el.getAttribute('data-id'));
  });

  global.Views.tournaments = View;
})(window);
