/**
 * tournament.js — 赛事详情页 View（T5，2026-09-13）
 *
 * **所有用户（含未登录游客）**都能看：基本信息 / 申请信息 / 参赛名单 / 对阵表 / 变更记录。
 * 不同身份额外看到不同操作：
 *
 * | 身份 | 操作 |
 * |---|---|
 * | 游客 / 普通用户 | 报名（创建与报名需登录正式账号） |
 * | 参赛者 | 进入自己的对局 |
 * | 主办人 | 批准·拒绝报名 · 踢出报名者 · 开始比赛 · 取消选手成绩 · 取消赛事 |
 * | 管理员 | 以上全部 + **设置冠军**（⚠️ 设冠军**仅管理员**） |
 *
 * ⚠️ **权限判定只有服务端一处**（`tournaments.canManage`）。
 * 页面里的按钮显隐由服务端下发的 `caps` 决定——它**只是描述，不是票据**，
 * 客户端改 `caps` 也越不了权：每个写接口都会重新判定一遍。
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 tournament.html 的主体）
 *   mount(container, params)→ 原 IIFE 主体逻辑全部搬进来，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（与 home.js 一致）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（本页 game_start 跳对局）。
 *   - 所有 api.on 订阅 → 返回的退订函数记进 this._teardown，unmount 统一清理。
 *   - 本页从 URL 读赛事 id：优先 `params.id`（router 解析），回退 `location.search`。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '赛事详情 · TDShogi',

    render() {
      // —— 原 tournament.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- 加载中 / 错误（赛事不存在、id 缺失）都走这里 -->
    <div id="tnLoading" style="color:var(--text-dim);font-size:13px;padding:20px 0;">加载中…</div>

    <div id="tnBody" style="display:none;">
      <!-- 头部：名称 / 状态 / 主办 / 赛制 / 人数 / 冠军 -->
      <div class="card" id="tnHead" style="padding:24px;margin-bottom:20px;"></div>

      <!-- 我的操作区：报名 / 我的报名状态 / 进入我的对局 -->
      <div id="tnMyArea" style="margin-bottom:20px;"></div>

      <!-- 管理区：主办人（批准报名 / 踢人 / 开赛 / 取消成绩 / 取消赛事）+ 管理员（设冠军） -->
      <div id="tnManageArea" style="margin-bottom:20px;"></div>

      <!-- 申请信息：举办理由与四个时间 -->
      <div class="card" id="tnInfo" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 参赛名单（含待批准的报名者，主办人可直接在此处置） -->
      <div class="card" id="tnRoster" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 对阵表 -->
      <div class="card" id="tnBracketCard" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 赛事棋谱（T6/需求 12）：强制公开，所有用户可看 -->
      <div class="card" id="tnRecordsCard" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 重赛申请（T6/需求 12）：参赛者可申请，主办人/管理员裁决 -->
      <div class="card" id="tnRematchCard" style="padding:20px;margin-bottom:20px;"></div>

      <!-- 变更记录：谁在什么时候做了什么（最近 50 条） -->
      <div class="card" id="tnLogs" style="padding:20px;"></div>
    </div>
  </main>
`;
    },

    mount(container, params) {
      this._teardown = [];
      this._handlers = {};
      this._mounted = true;
      // SPA 迁移：原 `NAV.renderNav('tournaments')` 删除——导航由外壳渲染一次，这里只取身份；
      // 原 `api.connect(guest.id)` 删除——外壳持有唯一 WS 连接，页面只 api.on / api.send。
      const guest = global.NAV.getGuest();
      const api = global.API;

      // SPA：切页竞态防护——unmount 后不再往已销毁的 DOM 写
      let alive = true;
      this._teardown.push(() => { alive = false; });
      // 页面内输入弹层登记表：切页（unmount）时强制关闭，避免残留在 body 上
      const openDialogs = new Set();
      this._teardown.push(() => { [...openDialogs].forEach((fn) => { try { fn(); } catch (_) {} }); });

      // 参赛名单里存的是 accountId；`guest.id` 是会话令牌（含点）时取点前部分
      const myPlayerId = guest.id && String(guest.id).includes('.')
        ? String(guest.id).split('.')[0]
        : guest.id;

      // SPA：赛事 id 优先用 router 解析的 params.id，回退读 location.search（router 用 pushState 保持同步）
      const tid = (params && params.id) || new URLSearchParams(location.search).get('id');

      let T = null;        // 赛事（publicInfo 形态）
      let caps = {};       // 服务端下发的"我能做什么"
      let isAdmin = false; // 是否带管理员令牌（仅用于文案提示）

      function esc(s) { return UI.esc(s); }
      function toast(m) { return UI.toast(m); }
      function el(id) { return UI.$(id); } // 铁律 5：DOM 查询走 window.UI 的 $（即 document.getElementById）

      /** 操作日志的中文名。未知 action 原样显示——不隐藏信息，方便排障 */
      const LOG_ACTION = {
        create: '提交创建申请', approve: '审核通过', reject: '审核拒绝',
        cancel: '取消赛事', archive: '存档', finish: '赛事结束',
        start: '开赛', join: '报名', bye: '轮空直接晋级',
        'entrant-approve': '批准报名', 'entrant-reject': '拒绝报名',
        'set-champion': '设置冠军', 'void-player': '取消选手成绩',
        'rematch-request': '申请重赛', 'rematch-approve': '批准重赛（该场重打）', 'rematch-reject': '驳回重赛',
      };

      // ⚠️ 2026-10-02 体验修复（问题 9 文案统一）：赛事状态文案收敛，并与列表页 `tournaments.js`
      // 的 `statusText` **逐字一致**（早前两页各写一套：详情页「待管理员审核」/ 列表页「审核中」）。
      const STATUS_TEXT = {
        pending_approval: '🕐 待审核',
        registration: '📌 报名中',
        playing: '⚔️ 比赛中',
        finished: '🏆 已结束',
        archived: '📦 已存档',
        rejected: '❌ 已拒绝',
        cancelled: '⛔ 已取消',
      };

      // ⚠️ 2026-10-02 体验修复（问题 1/9）：报名状态文案**唯一一份**，「我的报名状态」与
      // 「参赛名单」共用，避免同一状态在两处措辞不同（如「待批准」vs「报名已提交，等待主办人批准」）。
      const ENTRANT_TEXT = {
        pending:  { text: '🕐 待主办人批准', color: 'var(--gold-light)' },
        approved: { text: '✅ 已通过报名',   color: 'var(--gold-light)' },
        rejected: { text: '❌ 报名被拒绝',   color: 'var(--red-light)' },
        kicked:   { text: '🚫 已被移出',     color: 'var(--red-light)' },
      };

      // ⚠️ 2026-10-02 体验修复：页面内统一的输入弹层，替换裸 `window.prompt`。
      // 为什么必须换：原生 prompt 无法套用站内样式、移动端常被浏览器拦截、且会阻塞主线程，
      // 与站内 toast/模态体验割裂。这里用最小成本做一个页面内输入框，复用
      // `.modal-overlay/.card/.input` 样式，并接入 A11y 焦点管理（存在时）。
      // 返回 Promise<string|null>：确定 → 文本，取消 / 点遮罩 → null。
      function askInput(opts) {
        const o = opts || {};
        return new Promise((resolve) => {
          const root = document.createElement('div');
          root.className = 'modal-overlay';
          root.setAttribute('role', 'dialog');
          root.setAttribute('aria-modal', 'true');
          root.style.display = 'flex';
          const max = o.maxlength || 200;
          const field = o.multiline
            ? `<textarea class="input" id="uiAskField" rows="3" maxlength="${max}" style="width:100%;resize:vertical;font-family:inherit;"></textarea>`
            : `<input class="input" id="uiAskField" maxlength="${max}" style="width:100%;">`;
          root.innerHTML = `
            <div class="card" style="width:460px;max-width:94vw;padding:22px;">
              <div style="font-size:16px;font-weight:700;margin-bottom:10px;">${esc(o.title || '请输入')}</div>
              <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">${esc(o.label || '')}</div>
              ${field}
              <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
                <button class="btn btn-ghost btn-sm" id="uiAskCancel">取消</button>
                <button class="btn btn-primary btn-sm" id="uiAskOk">确定</button>
              </div>
            </div>`;
          document.body.appendChild(root);
          const fieldEl = root.querySelector('#uiAskField');
          if (fieldEl) fieldEl.value = o.value == null ? '' : String(o.value);
          const done = (val) => {
            openDialogs.delete(done); // SPA：弹层登记注销
            try { if (global.A11y) global.A11y.onDialogClose(root); } catch (_) { /* a11y 失败不阻塞关闭 */ }
            if (root.parentNode) root.parentNode.removeChild(root);
            resolve(val);
          };
          openDialogs.add(done); // SPA：登记打开的弹层，unmount 时统一强制关闭（等价用户点取消）
          root.querySelector('#uiAskOk').addEventListener('click', () => done(fieldEl ? fieldEl.value : ''));
          root.querySelector('#uiAskCancel').addEventListener('click', () => done(null));
          root.addEventListener('click', (e) => { if (e.target === root) done(null); });
          try { if (global.A11y) global.A11y.onDialogOpen(root, { onClose: () => done(null) }); } catch (_) { /* 同上 */ }
          if (fieldEl && fieldEl.focus) fieldEl.focus();
        });
      }

      // ⚠️ 2026-10-02 体验修复（问题 7）：记录服务端推送的赛事对局房间状态，用于判断「对手是否到场」。
      // 依据：开赛建房时服务端会把在线选手 bind 到房间并 `_pushState`（见 src/rooms/lifecycle.js
      // `createTournamentMatch` → `_pushState`），`state.players.<seat>.connected` 即在场状态。
      const roomPresence = {};

      /** @returns {boolean|null} true=对手在场；false=对手未到；null=尚无该房间快照（未知） */
      function isOpponentPresent(roomId, opponentId) {
        const p = roomPresence[roomId];
        if (!p || !opponentId) return null;
        const seat = p.b && p.b.id === opponentId ? 'b' : (p.w && p.w.id === opponentId ? 'w' : null);
        if (!seat) return null;
        return !!p[seat].connected;
      }

      /** 某条重赛申请是否牵涉本人（申请人 或 该场参赛者） */
      function rematchInvolvesMe(r) {
        if (!myPlayerId || !r) return false;
        if (r.byId && r.byId === myPlayerId) return true;
        const node = (T.bracket || []).find((x) => x.index === r.nodeIndex);
        if (node && (node.lastPlayers || node.players || []).indexOf(myPlayerId) >= 0) return true;
        return (T.rounds || []).some((rec) => {
          const mp = (rec.matchPairs || {})[r.matchId];
          if (mp && mp.indexOf(myPlayerId) >= 0) return true;
          return rec.lastMatchId === r.matchId && (rec.lastPair || []).indexOf(myPlayerId) >= 0;
        });
      }

      this._teardown.push(api.on('state', (d) => {
        if (!d || !d.roomId || !d.players) return;
        roomPresence[d.roomId] = d.players;
        // 对手进出房间会改变在场状态 → 立刻刷新「我的对局」区块（问题 7），
        // 不必等下一次主动操作才发现「对手已到场 / 尚未到场」。
        if (T && el('tnMyArea')) renderMyArea();
      }));

      /** 已确认参赛人数：开赛后看 players，报名阶段数 entrants 里 approved 的（与列表页口径一致） */
      function joinedCount(t) {
        const s = t.status;
        if (s === 'playing' || s === 'finished' || s === 'archived') return (t.players || []).length;
        return (t.entrants || []).filter((e) => e.status === 'approved').length;
      }

      function nameOf(id) {
        if (!id) return '未知';
        const p = (T.players || []).find((x) => x.id === id)
          || (T.entrants || []).find((x) => x.id === id);
        return p ? p.name : '未知';
      }

      function fmtTime(ts) {
        if (!ts) return '不限';
        return global.I18N.fmt(ts, {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        });
      }

      // ==================================================================
      // 加载
      // ==================================================================
      async function load() {
        if (!tid) return showError('链接里没有赛事 id，请从赛事列表进入。');
        try {
          const d = await global.ApiUtils.get(`/api/tournaments/${encodeURIComponent(tid)}`);
          if (!alive) return; // 已切页：不再触碰 DOM
          T = d.tournament;
          caps = d.caps || {};
          isAdmin = !!d.viewerIsAdmin;
        } catch (e) {
          if (!alive) return;
          return showError('赛事不存在，或已被删除。');
        }
        el('tnLoading').style.display = 'none';
        el('tnBody').style.display = '';
        renderAll();
      }

      function showError(msg) {
        el('tnLoading').textContent = msg;
        el('tnLoading').style.color = 'var(--red-light)';
      }

      /** 任何写操作成功后统一走这里：用服务端返回的最新赛事重绘（不自己改本地状态） */
      function afterMutate(res, okMsg) {
        if (res && res.tournament) T = res.tournament;
        if (okMsg) toast(okMsg);
        renderAll();
      }

      async function post(path, body, okMsg) {
        try {
          const res = await global.ApiUtils.postAuthed(path, body, guest.id);
          afterMutate(res, okMsg);
          return res;
        } catch (e) {
          toast(e.message);
          return null;
        }
      }

      function renderAll() {
        if (!alive) return; // 已切页：不再触碰 DOM
        renderHead();
        renderMyArea();
        renderManageArea();
        renderInfo();
        renderRoster();
        renderBracketCard();
        renderRematchCard();
        renderLogs();
        loadRecords(); // 独立异步：棋谱可能较多，不拖慢主渲染
      }

      // ==================================================================
      // 头部
      // ==================================================================
      function renderHead() {
        const isOwner = T.ownerId === myPlayerId;
        const champ = T.championId
          ? `<div style="margin-top:10px;font-size:15px;color:var(--gold-light);font-weight:700;">
               🏆 冠军：${esc(nameOf(T.championId))}${T.championManual ? '<span style="font-size:11px;color:var(--text-dim);font-weight:400;">（管理员裁定）</span>' : ''}
             </div>` : '';
        el('tnHead').innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">
            <div>
              <div style="font-size:24px;font-weight:700;margin-bottom:6px;">${esc(T.name)}</div>
              <div style="font-size:13px;color:var(--text-dim);">
                ${isOwner ? '<span style="color:var(--gold-light);">👑 我是主办人</span> · ' : ''}
                主办：<span data-player-id="${esc(T.ownerId || '')}">${esc(T.ownerName || '未知')}</span
                > · ${esc(T.formatLabel || '单败淘汰')} · ${joinedCount(T)}/${T.size} 人${
      // 瑞士制的"打到哪了"光看状态看不出来，把轮次一并显示
      (T.format === 'swiss' && T.totalRounds) ? ` · 第 ${T.currentRound || 0}/${T.totalRounds} 轮` : ''}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="tag" style="font-size:13px;">${STATUS_TEXT[T.status] || esc(T.status)}</span>
              <a class="btn btn-ghost btn-sm" href="tournaments.html">← 赛事列表</a>
            </div>
          </div>
          ${champ}`;
      }

      // ==================================================================
      // 我的操作区（报名 / 我的报名状态 / 进入我的对局）
      // ==================================================================
      function renderMyArea() {
        const box = el('tnMyArea');
        const parts = [];

        // ⚠️ 2026-10-02 体验修复（问题 1）：本人的报名/参赛状态**在任何赛事状态下都展示**。
        // 原实现把这一块锁死在 `registration` 里 —— 赛事一开赛/结束/取消，被拒、被踢、
        // 已被取消的人就再也看不到「我的报名到底怎么了」，只能看到头部一个笼统的赛事状态。
        const mine = (T.entrants || []).find((e) => e.id === myPlayerId);
        if (myPlayerId && (mine || T.status === 'rejected' || T.status === 'cancelled')) {
          parts.push(myStatusCard(mine));
        }

        // 未登录：给一句登录引导
        if (T.status === 'registration' && !myPlayerId) {
          parts.push(notice('登录后可报名参加本赛事。'));
        }

        // ---- 报名（仅报名阶段且本人还没报过）----
        if (T.status === 'registration' && myPlayerId && !mine) {
          const approvedN = joinedCount(T);
          const full = approvedN >= T.size;
          parts.push(`
            <div class="card" style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
              <div style="font-size:13px;color:var(--text-dim);">
                ${full ? '名额已满。' : `已有 ${approvedN}/${T.size} 人通过报名${T.requireApproval ? '，报名需主办人审核' : ''}。`}
              </div>
              <button class="btn btn-primary" id="btnJoinTn" ${full ? 'disabled' : ''}>${full ? '名额已满' : '报名'}</button>
            </div>`);
        }

        // ---- 我参与的对局（进行中 / 等待对手到场）----
        const matchBlock = myMatchBlock();
        if (matchBlock) parts.push(matchBlock);

        // ---- 改判 / 裁定通知（问题 6）----
        const adjBlock = myAdjudicationNotices();
        if (adjBlock) parts.push(adjBlock);

        box.innerHTML = parts.join('');

        const joinBtn = el('btnJoinTn');
        if (joinBtn) {
          joinBtn.addEventListener('click', () => {
            // 报名走 WS：身份由连接握手时绑定，客户端无从伪造（见 history.js 顶部同源注释）
            api.send({ type: 'join_tournament', data: { id: T.id } });
          });
        }
        const howBtn = el('btnHowWithdraw');
        if (howBtn) {
          howBtn.addEventListener('click', () => {
            // ⚠️ 站内没有独立输入层时用 UI.alert 做只读说明（UI 暴露的键名是 `alert`，见 util.js 的 global.UI）
            UI.alert('如何退赛 / 取消报名？',
              '当前版本暂未提供选手自助退赛接口（前端不伪造请求）。'
              + '报名阶段：请联系主办人，请其在本页「参赛名单」里把你移出（移出后状态显示为「已被移出」）；'
              + '赛事开赛后：如需退出，请告知主办人或管理员，由「取消选手成绩」处理（该选手所有对局判对手胜）。');
          });
        }
      }

      /**
       * 我的报名/参赛状态卡（问题 1）。
       *
       * ⚠️ 服务端**没有**为单条报名记录保存处理理由：`entrants` 项只有 `{id,name,at,status}`，
       * 理由只存在于**赛事级** `rejectReason`（审核拒绝 / 取消赛事时写入）。所以这里：
       *  - 有 `rejectReason` 就展示；
       *  - 没有就如实说明「服务端未记录个人理由」，并指向主办人 —— 前端不臆造原因。
       */
      function myStatusCard(mine) {
        if (!mine) {
          // 只有赛事被拒 / 被取消才会走到这里（本人没有报名记录）
          const label = T.status === 'cancelled' ? '⛔ 本赛事已取消' : '❌ 本赛事未通过审核';
          const reason = T.rejectReason ? `：${esc(T.rejectReason)}` : '';
          return `<div class="card" style="padding:16px 20px;font-size:13px;color:var(--red-light);">${label}${reason}</div>`;
        }

        const hit = ENTRANT_TEXT[mine.status] || { text: esc(mine.status), color: 'var(--text-dim)' };
        const lines = [`<span style="color:${hit.color};">${hit.text}</span>`];
        if (mine.status === 'approved') lines.push(` · 已确认 ${joinedCount(T)}/${T.size} 人`);
        if (mine.status === 'pending') lines.push(' · 主办人批准后即计入参赛名单');
        if ((mine.status === 'rejected' || mine.status === 'kicked') && !T.rejectReason) {
          lines.push(' <span style="color:var(--text-dim);">（服务端未记录个人处理理由，如有疑问请联系主办人）</span>');
        }

        let footer = '';
        if (T.status === 'cancelled') footer = `<div style="margin-top:6px;color:var(--red-light);">⛔ 本赛事已取消${T.rejectReason ? `：${esc(T.rejectReason)}` : ''}</div>`;
        else if (T.status === 'rejected' && T.rejectReason) footer = `<div style="margin-top:6px;color:var(--red-light);">处理原因：${esc(T.rejectReason)}</div>`;

        // ⚠️ 2026-10-02 体验修复（问题 2）：选手「退赛 / 取消报名」入口。
        // 现状：服务端**没有**自助退赛接口（写接口只有 报名/审批/踢人/开赛/取消成绩/取消赛事，
        // 见 src/http/routes/tournaments.js；entrant 状态只有 pending/approved/rejected/kicked）。
        // 因此前端不硬造请求，改为给出「如何退赛」的明确说明（主办人可在报名阶段把你移出）。
        let withdraw = '';
        if (T.status === 'registration' && (mine.status === 'pending' || mine.status === 'approved')) {
          withdraw = '<button class="btn btn-ghost btn-sm" id="btnHowWithdraw" style="margin-top:10px;">如何退赛 / 取消报名？</button>';
        }

        return `<div class="card" style="padding:16px 20px;font-size:13px;line-height:1.7;">
          <div><span style="color:var(--text-dim);">我的报名状态：</span>${lines.join('')}</div>
          ${footer}${withdraw}
        </div>`;
      }

      /**
       * 「我的对局」区块（问题 3/7）：列出本人已安排的对局（淘汰赛节点 + 瑞士制本轮），
       * 并根据服务端推送的房间快照标注**对手是否到场**，给一句「进入对局」。
       */
      function myMatchBlock() {
        if (!myPlayerId) return '';
        const rows = [];

        (T.bracket || []).forEach((n) => {
          if (!n.matchId || !n.players || n.players.indexOf(myPlayerId) < 0) return;
          rows.push(matchRow(n.matchId, (n.players || []).find((id) => id !== myPlayerId), null));
        });
        (T.rounds || []).forEach((r) => {
          (r.pairs || []).forEach((p, i) => {
            const roomId = (r.matchIds || [])[i];
            if (!roomId || p.indexOf(myPlayerId) < 0) return;
            rows.push(matchRow(roomId, p[0] === myPlayerId ? p[1] : p[0], r.round));
          });
        });

        if (!rows.length) return '';
        return `<div class="card" style="padding:16px 20px;">
          <div style="font-size:13px;color:var(--gold-light);margin-bottom:8px;">⚔️ 你的对局已安排</div>
          ${rows.join('')}
          <div style="font-size:12px;color:var(--text-dim);margin-top:6px;">对手未到场时可在房内等待；对局开始后离开页面可能被判负。</div>
        </div>`;
      }

      function matchRow(roomId, opponentId, round) {
        // ⚠️ 问题 7：对手是否到场取自服务端推送的 `state`（players.<seat>.connected）；
        // 没有该房间快照时（例如对局在本人不在线时创建）如实显示「以房间内状态为准」。
        const present = isOpponentPresent(roomId, opponentId);
        const hint = present === false
          ? '<span style="color:var(--red-light);">⚠️ 对手尚未到场</span>'
          : present === true
            ? '<span style="color:var(--text-dim);">对手已到场</span>'
            : '<span style="color:var(--text-dim);">以房间内状态为准</span>';
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 0;font-size:13px;">
          <span>${round ? `第 ${round} 轮 · ` : ''}对手：<span data-player-id="${esc(opponentId || '')}">${esc(nameOf(opponentId))}</span> ${hint}</span>
          <a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&join=1">进入对局</a>
        </div>`;
      }

      /**
       * 改判 / 裁定通知（问题 6）：把**牵涉本人**且已裁决的重赛申请显式提示出来，
       * 展示服务端已有字段（status / reason / note），选手不必翻到最底下的重赛卡片才发现自己被改判。
       */
      function myAdjudicationNotices() {
        if (!myPlayerId) return '';
        const decided = (T.rematches || []).filter((r) => r.status !== 'pending' && rematchInvolvesMe(r));
        if (!decided.length) return '';
        const rows = decided.map((r) => {
          const st = r.status === 'approved'
            ? ['✅ 已批准重赛（该场重打）', 'var(--gold-light)']
            : ['❌ 已驳回', 'var(--red-light)'];
          return `<div style="font-size:13px;padding:4px 0;">
            <span style="color:${st[1]};">${st[0]}</span>
            ${r.reason ? ` · 申请理由：${esc(r.reason)}` : ''}
            ${r.note ? ` · 处理备注：${esc(r.note)}` : ''}
          </div>`;
        }).join('');
        return `<div class="card" style="padding:16px 20px;border:1px solid var(--gold);">
          <div style="font-size:13px;font-weight:700;color:var(--gold-light);margin-bottom:6px;">🔔 改判 / 裁定通知</div>
          ${rows}
        </div>`;
      }

      function notice(text) {
        return `<div class="card" style="padding:16px 20px;font-size:13px;color:var(--text-dim);">${text}</div>`;
      }

      // ==================================================================
      // 管理区（主办人 / 管理员）
      //
      // ⚠️ 每个按钮都对应一个服务端写接口，且服务端会**再判一次权限**。
      // 这里用 `caps` 决定显隐，只是不让用户看到"点了必然失败"的按钮。
      // ==================================================================
      function renderManageArea() {
        const box = el('tnManageArea');
        // ⚠️ 2026-10-02 审查 P3：canAny 必须涵盖下方实际会渲染的动作（archive/edit_archived），
        // 否则仅具这两项权限时会把整块管理面板清空（当前权限模型下不可达，属一致性加固）。
        const canAny = caps.decide_entrant || caps.kick_player || caps.assign_round
          || caps.void_player || caps.cancel || caps.set_champion
          || caps.archive || caps.edit_archived;
        if (!canAny) { box.innerHTML = ''; return; }

        const s = T.status;
        const pendingList = (T.entrants || []).filter((e) => e.status === 'pending');
        const approvedN = joinedCount(T);
        const actions = [];

        // ⚠️ 「开始比赛」必须限定在**报名阶段**：`caps.assign_round` 只表示"这个角色有权开赛"，
        // 与当前状态无关——不判状态的话，比赛已经开始（甚至结束）了按钮还在，
        // 点下去必然撞到状态机报错。
        if (caps.assign_round && s === 'registration') {
          actions.push(`<button class="btn btn-primary btn-sm" id="btnStartTn">
            ▶️ 开始比赛${approvedN < T.size ? `（未满员也可，${T.size - approvedN} 个位置自动轮空）` : ''}</button>`);
        }
        if (caps.cancel) {
          actions.push('<button class="btn btn-ghost btn-sm" id="btnCancelTn" style="color:var(--red-light);">⛔ 取消赛事</button>');
        }
        if (caps.archive) {
          actions.push('<button class="btn btn-ghost btn-sm" id="btnArchiveTn">📦 存档赛事</button>');
        }
        if (caps.edit_archived) {
          actions.push('<button class="btn btn-ghost btn-sm" id="btnEditNoteTn">✏️ 编辑备注</button>');
        }

        // ---- 待批准报名（T3）----
        // ⚠️ 这块**直接放在管理面板里**，而不是只在下方名单里放按钮：
        // 早先面板上只写一句"见下方名单"，主办人得往下滚动去找——
        // 而"批准报名"恰恰是报名阶段最高频的操作，应该伸手就能点到。
        const approveBox = (caps.decide_entrant && pendingList.length) ? `
            <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;">
                <div style="font-size:13px;color:var(--gold-light);">🕐 待批准报名（${pendingList.length}）</div>
                <button class="btn btn-primary btn-sm" id="btnApproveAll">全部批准</button>
              </div>
              ${pendingList.map((e) => `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:13px;">
                  <span data-player-id="${esc(e.id)}">${esc(e.name)}</span>
                  <span style="display:flex;gap:6px;">
                    <button class="btn btn-primary btn-sm" data-act="approve" data-pid="${esc(e.id)}">批准</button>
                    <button class="btn btn-ghost btn-sm" data-act="reject" data-pid="${esc(e.id)}">拒绝</button>
                  </span>
                </div>`).join('')}
            </div>` : '';

        const tips = [];
        if (caps.void_player && s === 'playing') tips.push('取消选手成绩：该选手所有对局判对手胜，并重算后续轮次');
        if (caps.set_champion && s !== 'archived') tips.push('设置冠军为<b>管理员专属</b>操作');
        if (caps.archive) tips.push('存档后主办人只读；系统也会在结束后 24 小时自动存档');
        if (caps.edit_archived) tips.push('已存档赛事仅管理员可编辑，且每次编辑都会留痕');

        box.innerHTML = `
          <div class="card" style="padding:18px 20px;border:1px solid var(--gold);">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
              <div style="font-size:14px;font-weight:700;color:var(--gold-light);">
                🎛 ${isAdmin && caps.set_champion ? '管理员' : '主办人'}管理面板
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">${actions.join('')}</div>
            </div>
            ${tips.length ? `<div style="font-size:12px;color:var(--text-dim);margin-top:8px;line-height:1.7;">${tips.join('<br>')}</div>` : ''}
            ${approveBox}
          </div>`;

        const startBtn = el('btnStartTn');
        if (startBtn) {
          startBtn.addEventListener('click', () => {
            if (!confirm('确定开始比赛？开始后报名名单将被冻结。')) return;
            post(`/api/tournaments/${encodeURIComponent(T.id)}/start`, {}, '赛事已开始');
          });
        }
        const cancelBtn = el('btnCancelTn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', async () => {
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const reason = await askInput({ title: '取消赛事', label: '取消原因（可留空）', multiline: true });
            if (reason === null) return; // 用户取消
            post(`/api/tournaments/${encodeURIComponent(T.id)}/cancel`, { reason }, '赛事已取消');
          });
        }
        // 「批准 / 拒绝」按钮**不再在这里逐个绑定**（2026-09-23，审查项 13f）：
        // 已改走 util.js 的**整页委托**（见文件末尾的注册）。
        // ⚠️ 原注释记录的坑是真的：两处面板各写一次 `querySelectorAll('button[data-act]')`
        // 会把回调同时绑到对方的按钮上（点一下发两次请求）。委托只有一份监听，从结构上不会再犯。
        const allBtn = el('btnApproveAll');
        if (allBtn) {
          allBtn.addEventListener('click', () => approveAll(pendingList.map((e) => e.id)));
        }

        const archiveBtn = el('btnArchiveTn');
        if (archiveBtn) {
          archiveBtn.addEventListener('click', () => {
            if (!confirm('确定存档本赛事？\n存档后主办人将转为只读，仅管理员可继续编辑。')) return;
            // 存档是管理员专属，走 admin 路由（同一个 adminOnly + 审计落盘）
            global.ApiUtils.postAuthed(`/api/admin/tournaments/${encodeURIComponent(T.id)}/archive`, {}, guest.id)
              .then((res) => afterMutate(res, '赛事已存档'))
              .catch((e) => toast(e.message));
          });
        }
        const noteBtn = el('btnEditNoteTn');
        if (noteBtn) {
          noteBtn.addEventListener('click', async () => {
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const note = await askInput({
              title: '编辑赛事备注',
              label: '赛事备注（仅管理员可编辑，会记入编辑历史）',
              value: T.note || '',
              multiline: true,
            });
            if (note === null) return;
            global.ApiUtils.postAuthed(`/api/admin/tournaments/${encodeURIComponent(T.id)}/edit`,
              { field: 'note', value: note }, guest.id)
              .then((res) => afterMutate(res, '备注已更新'))
              .catch((e) => toast(e.message));
          });
        }
      }

      // ==================================================================
      // 申请信息（需求 9：申请表内容公开可查）
      // ==================================================================
      function renderInfo() {
        const rows = [
          // ⚠️ 别再写死"单败淘汰制"：T8 起有瑞士制了，赛制必须取服务端下发的标签
          ['赛制', T.formatLabel || '单败淘汰'],
          ['人数档位', `${T.size} 人`],
          // ⚠️ 2026-10-02 体验修复（问题 5）：这些时间只是**计划/参考**，不是硬性开赛时刻。
          // 服务端只做自洽校验（validateSchedule），**不会按时间自动开赛**——开赛由「报名满员」
          // 或主办人手动触发。标题改写作「参考…」，避免被当成准点开赛。
          ['参考报名时间', `${fmtTime(T.registerStart)} ~ ${fmtTime(T.registerEnd)}`],
          ['参考比赛时间', `${fmtTime(T.matchStart)} ~ ${fmtTime(T.matchEnd)}`],
          ['报名审核', T.requireApproval ? '需主办人审核' : '免审核（报名即参赛）'],
          ['提交时间', fmtTime(T.createdAt)],
        ];
        if (T.format === 'swiss' && T.totalRounds) {
          rows.splice(1, 0, ['轮次', `共 ${T.totalRounds} 轮${T.currentRound ? `（已进行到第 ${T.currentRound} 轮）` : ''}`]);
        }
        const reason = T.reason
          ? `<div style="margin-top:12px;font-size:13px;line-height:1.8;"><span style="color:var(--text-dim);">举办理由：</span><br>${esc(T.reason)}</div>`
          : '';
        const reject = T.rejectReason
          ? `<div style="margin-top:12px;font-size:13px;color:var(--red-light);">处理原因：${esc(T.rejectReason)}</div>`
          : '';
        el('tnInfo').innerHTML = `
          <div class="section-title" style="margin-bottom:14px;">赛事信息</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;font-size:13px;">
            ${rows.map(([k, v]) => `<div><span style="color:var(--text-dim);">${k}：</span>${esc(v)}</div>`).join('')}
          </div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-dim);line-height:1.7;">
            ⏱ 以上时间仅供规划参考，不会自动开赛：实际以「报名满员自动开赛」或主办人手动开赛为准。
          </div>
          ${reason}${reject}`;
      }

      // ==================================================================
      // 参赛名单（报名池 + 参赛者；主办人可直接在此批准/拒绝/踢人）
      // ==================================================================
      function renderRoster() {
        const entrants = T.entrants || [];
        const isPlaying = T.status === 'playing' || T.status === 'finished' || T.status === 'archived';

        // ⚠️ 2026-10-02 体验修复（问题 9 文案统一）：报名状态文案复用 `ENTRANT_TEXT`
        //（与「我的报名状态」同一份），不再各写一套（原为「待批准 / 已通过 / 已拒绝 / 已移出」）。
        const label = {};
        Object.keys(ENTRANT_TEXT).forEach((k) => { label[k] = [ENTRANT_TEXT[k].text, ENTRANT_TEXT[k].color]; });

        let body;
        if (entrants.length) {
          body = entrants.map((e) => {
            const hit = label[e.status] || [esc(e.status), 'var(--text-dim)'];
            // 名单里的操作 = **针对某个人"事后"的动作**（踢出 / 取消成绩 / 设冠军）。
            // ⚠️「批准 / 拒绝」刻意**不在这里**——它们属于"待办队列"，统一放在上方的管理面板。
            // 两处都摆同一组按钮，页面上就会同时出现两个相邻的「批准」，纯属干扰。
            const btns = [];
            if (caps.kick_player && !isPlaying && e.status !== 'kicked') {
              btns.push(`<button class="btn btn-ghost btn-sm" data-act="kick" data-pid="${esc(e.id)}" style="color:var(--red-light);">踢出</button>`);
            }
            if (caps.void_player && isPlaying && e.status === 'approved') {
              btns.push(`<button class="btn btn-ghost btn-sm" data-act="void" data-pid="${esc(e.id)}" style="color:var(--red-light);">取消成绩</button>`);
            }
            if (caps.set_champion && e.status === 'approved' && T.championId !== e.id) {
              btns.push(`<button class="btn btn-ghost btn-sm" data-act="champion" data-pid="${esc(e.id)}">设为冠军</button>`);
            }
            return `
              <div class="record-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span data-player-id="${esc(e.id)}" style="font-size:13px;">${esc(e.name)}</span>
                  <span style="font-size:11px;color:${hit[1]};">${hit[0]}</span>
                  ${e.id === T.ownerId ? '<span style="font-size:11px;color:var(--gold-light);">主办</span>' : ''}
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">${btns.join('')}</div>
              </div>`;
          }).join('');
        } else {
          body = '<div style="color:var(--text-dim);font-size:13px;">还没有人报名。</div>';
        }

        el('tnRoster').innerHTML = `
          <div class="section-title" style="margin-bottom:14px;">
            报名与参赛名单（${joinedCount(T)}/${T.size} 已通过${entrants.length !== joinedCount(T) ? ` · 共 ${entrants.length} 条报名` : ''}）
          </div>
          ${body}`;

        // 名单里的操作按钮同样走**整页委托**（2026-09-23，审查项 13f）：这里不再逐个绑定。
      }

      /**
       * 批量批准报名（管理面板上的「全部批准」）。
       *
       * ⚠️ **逐个发请求**，不做"一次批一批"的服务端接口：名额与权限判定必须每次都真的走一遍
       * （批准到最后一个可能正好满员、自动开赛，后面几个就该被服务端正常拒绝）。
       * 在前端做"批量捷径"等于绕开这些判定。
       */
      async function approveAll(ids) {
        if (!ids.length) return;
        if (!confirm(`确定批准这 ${ids.length} 人的报名？`)) return;
        let ok = 0;
        for (const pid of ids) {
          // okMsg 传空串：逐条弹提示会刷屏，最后统一报一次结果
          const res = await post(
            `/api/tournaments/${encodeURIComponent(T.id)}/entrants/${encodeURIComponent(pid)}`,
            { decision: 'approve' }, '');
          if (res) ok++;
        }
        if (ok < ids.length) {
          toast(`已批准 ${ok} 人，其余 ${ids.length - ok} 人未成功（可能名额已满或赛事已开始）`);
        } else {
          toast(`已批准 ${ok} 人`);
        }
      }

      async function rosterAction(act, playerId) {
        const id = encodeURIComponent(T.id);
        if (act === 'approve' || act === 'reject') {
          return post(`/api/tournaments/${id}/entrants/${encodeURIComponent(playerId)}`,
            { decision: act }, act === 'approve' ? '已批准报名' : '已拒绝报名');
        }
        if (act === 'kick') {
          if (!confirm(`确定把 ${nameOf(playerId)} 移出本赛事？`)) return;
          return post(`/api/tournaments/${id}/kick`, { playerId }, '已移出该报名者');
        }
        if (act === 'void') {
          if (!confirm(`确定取消 ${nameOf(playerId)} 的成绩？\n该选手所有对局将判对手胜，后续轮次会重新计算。`)) return;
          return post(`/api/tournaments/${id}/void`, { playerId }, '已取消该选手成绩');
        }
        if (act === 'champion') {
          if (!confirm(`确定把 ${nameOf(playerId)} 设为冠军？\n这是管理员专属操作，会被记入变更记录。`)) return;
          return post(`/api/tournaments/${encodeURIComponent(T.id)}/champion`, { playerId }, '已设置冠军');
        }
      }

      // ==================================================================
      // 对阵表
      // ==================================================================
      /** 与后端 `swiss.pairKey` 同构：一对选手的稳定键（与先后顺序无关） */
      function pairKey(a, b) {
        return String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`;
      }

      function renderBracketCard() {
        const card = el('tnBracketCard');
        // T8：瑞士制没有淘汰树，用"轮次列表 + 名次表"呈现
        if (T.format === 'swiss') { renderSwissCard(card); return; }
        if (!(T.bracket || []).length) {
          card.style.display = 'none';
          return;
        }
        card.style.display = '';
        const nodes = T.bracket || [];
        // ⚠️ 2026-10-02 体验修复（问题 3）：进行中的对局提供**观战**入口（跳到 play.html?...&spectate=1）。
        const live = nodes.filter((n) => n.matchId && n.players);
        // ⚠️ 问题 4：淘汰赛和棋（服务端置 `node.draw = true`，见 src/tournaments/bracket.js）。
        const draws = nodes.filter((n) => n.draw);
        // ⚠️ 问题 8：建房失败（有对阵双方，却既没建出房间、也没有结果）——不再静默成「待定」。
        const failed = nodes.filter((n) => n.players && !n.matchId && !n.winnerId && !n.draw);
        card.innerHTML = `
          <div class="section-title" style="margin-bottom:4px;">对阵表</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
            金色边框 = 已分出胜负；「空位」= 该位置无人（报名不足时会出现，对手自动轮空晋级）
          </div>
          ${UI.bracketHtml(T, { myId: myPlayerId, detail: true })}
          ${draws.length ? `<div style="margin-top:10px;font-size:12px;color:var(--red-light);">🤝 和棋待裁决：${draws.map((n) => esc((n.lastPlayers || []).map(nameOf).join(' vs '))).join('、')}（淘汰赛和棋无法自动晋级，需主办人 / 管理员安排重赛）</div>` : ''}
          ${failed.length ? `<div style="margin-top:10px;font-size:12px;color:var(--red-light);">⚠️ 有 ${failed.length} 场对局未能创建房间：${failed.map((n) => esc((n.players || []).map(nameOf).join(' vs '))).join('、')}（需主办人 / 管理员重试或安排重赛）</div>` : ''}
          ${live.length ? `<div style="margin-top:12px;">
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">进行中的对局（可进入 / 观战）：</div>
            ${live.map((n) => {
              const mine = (n.players || []).indexOf(myPlayerId) >= 0;
              const label = (n.players || []).map(nameOf).join(' vs ');
              const href = mine
                ? `play.html?room=${encodeURIComponent(n.matchId)}&join=1`
                : `play.html?room=${encodeURIComponent(n.matchId)}&spectate=1`;
              return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;padding:3px 0;">
                <span>${esc(label)}</span>
                <a class="btn ${mine ? 'btn-primary' : 'btn-ghost'} btn-sm" href="${href}">${mine ? '进入对局' : '观战'}</a>
              </div>`;
            }).join('')}
          </div>` : ''}`;
      }

      /**
       * 瑞士制赛程视图（T8）：**轮次列表 + 名次表**。
       *
       * ⚠️ 刻意不复用 `UI.bracketHtml`：那是淘汰树的画法（按满二叉树分层），
       * 而瑞士制每轮按积分重新配对，压根没有树——套上去只会画出一堆"待定"。
       */
      function renderSwissCard(card) {
        const rounds = T.rounds || [];
        if (!rounds.length) {
          card.style.display = '';
          card.innerHTML = `
            <div class="section-title" style="margin-bottom:10px;">赛程（${esc(T.formatLabel || '瑞士制')}）</div>
            <div style="color:var(--text-dim);font-size:13px;">
              尚未开赛。共 ${T.totalRounds || 0} 轮，开赛后每轮按积分重新配对。
            </div>`;
          return;
        }
        card.style.display = '';

        const roundsHtml = rounds.map((r) => {
          const isCur = r.round === T.currentRound && T.status === 'playing';
          let failedN = 0;
          const rows = (r.pairs || []).map(([a, b], i) => {
            const w = (r.results || {})[pairKey(a, b)];
            const mine = !!myPlayerId && (a === myPlayerId || b === myPlayerId);
            const roomId = (r.matchIds || [])[i];
            let tag;
            if (w === '-') {
              // ⚠️ 2026-10-02 体验修复（问题 4）：瑞士制 `results` 用 `'-'` 表示和棋
              //（见 src/swiss.js：和棋各得 0.5 分）。原实现只判 `if (w)`，会把 '-' 当选手 id
              // 去查名字 → 显示成「未知 胜」，把和棋误报成有人获胜。
              tag = '<span style="color:var(--gold-light);">🤝 和棋（各得 0.5 分）</span>';
            } else if (w) {
              tag = `<span style="color:var(--gold-light);">${esc(nameOf(w))} 胜</span>`;
            } else if (roomId) {
              // ⚠️ 问题 3：非本人对局给「观战」入口（本人仍是「进入对局」）。
              tag = mine
                ? `<a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&join=1">进入对局</a>`
                : `<a class="btn btn-ghost btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&spectate=1">观战</a>`;
            } else {
              // ⚠️ 问题 8：既无结果、又没有房间 id = 建房失败（startSwissRound 建房失败时 matchIds[i]=null）。
              // 原实现只显示「—」，把「这轮有一场根本没打起来」静默掉了。
              failedN++;
              tag = '<span style="color:var(--red-light);" title="该场未能创建房间，需主办人 / 管理员重试或安排重赛">⚠️ 未能开局</span>';
            }
            const voided = (r.voided || []).some((v) => v === a || v === b);
            return `
              <div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:12px;${mine ? 'font-weight:700;' : ''}">
                <span>${esc(nameOf(a))} vs ${esc(nameOf(b))}${voided ? ' <span style="color:var(--red-light);font-size:11px;">（成绩取消）</span>' : ''}</span>
                <span>${tag}</span>
              </div>`;
          }).join('');
          const byes = (r.byes || []).length
            ? `<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">轮空：${(r.byes || []).map((id) => esc(nameOf(id))).join('、')}（视同胜，得 1 分）</div>`
            : '';
          // ⚠️ 问题 8：轮次级告警（退让原因 / 建房失败）显式呈现，避免「静默卡住一轮」。
          const roundWarn = [];
          if (r.degraded) roundWarn.push(`配对经过退让${r.reason ? `：${esc(r.reason)}` : ''}，可能有重复对阵`);
          if (failedN) roundWarn.push(`有 ${failedN} 场未能创建房间，需主办人 / 管理员处理`);
          return `
            <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;${isCur ? 'border-color:var(--gold);' : ''}">
              <div style="font-size:13px;font-weight:700;margin-bottom:6px;">
                第 ${r.round} 轮${isCur ? ' <span style="font-size:11px;color:var(--gold-light);">进行中</span>' : ''}
              </div>
              ${roundWarn.length ? `<div style="font-size:11px;color:var(--red-light);margin-bottom:4px;">⚠️ ${roundWarn.join('；')}</div>` : ''}
              ${rows}${byes}
            </div>`;
        }).join('');

        const standings = T.standings || [];
        const rankRows = standings.map((s) => `
          <div style="display:grid;grid-template-columns:34px 1fr 56px 56px 50px;gap:6px;font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);${s.id === myPlayerId ? 'font-weight:700;' : ''}">
            <span style="color:var(--gold-light);">${s.rank}</span>
            <span data-player-id="${esc(s.id)}">${esc(s.name || '—')}</span>
            <span>${s.score} 分</span>
            <span style="color:var(--text-dim);">${s.sos}</span>
            <span style="color:var(--text-dim);">${s.wins}-${s.draws}-${s.losses}</span>
          </div>`).join('');

        card.innerHTML = `
          <div class="section-title" style="margin-bottom:4px;">赛程（${esc(T.formatLabel || '瑞士制')} · 共 ${T.totalRounds} 轮）</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
            每轮按积分重新配对：强者遇强者、不重复对阵（没有淘汰，输一两场仍有机会）。
            当前第 ${T.currentRound || 0} 轮${T.status === 'playing' ? '' : '（已结束）'}。
          </div>
          ${roundsHtml}
          <div class="section-title" style="margin:16px 0 4px;">名次表</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
            排序：积分 → 对手分（SOS）→ 参赛顺序。胜 1 分、和 0.5 分、轮空 1 分。
            ${T.championTie ? '<span style="color:var(--gold-light);">⚠️ 与第二名同分，按对手分裁定</span>' : ''}
          </div>
          <div style="display:grid;grid-template-columns:34px 1fr 56px 56px 50px;gap:6px;font-size:11px;color:var(--text-dim);padding-bottom:4px;border-bottom:1px solid var(--border);">
            <span>名次</span><span>选手</span><span>积分</span><span>对手分</span><span>胜-和-负</span>
          </div>
          ${rankRows || '<div style="color:var(--text-dim);font-size:13px;">暂无数据。</div>'}`;
      }

      // ==================================================================
      // 赛事棋谱（T6/需求 12）
      //
      // 赛事对局在**落盘时就被强制设为公开**（见 `src/rooms/gameplay.js`），
      // 所以这里对**所有人**（含未登录游客）展示，不做任何可见性判断。
      // ==================================================================
      let allRecords = [];
      let recPage = 1;

      async function loadRecords() {
        const card = el('tnRecordsCard');
        try {
          const d = await global.ApiUtils.get(`/api/tournaments/${encodeURIComponent(tid)}/records`);
          allRecords = d.records || [];
        } catch (e) {
          card.innerHTML = '<div class="section-title" style="margin-bottom:10px;">赛事棋谱</div>'
            + '<div style="color:var(--red-light);font-size:13px;">棋谱加载失败，请稍后重试。</div>';
          return;
        }
        renderRecordsCard();
      }

      function renderRecordsCard() {
        const card = el('tnRecordsCard');
        if (!allRecords.length) {
          card.innerHTML = `
            <div class="section-title" style="margin-bottom:10px;">赛事棋谱（0）</div>
            <div style="color:var(--text-dim);font-size:13px;">还没有赛事对局棋谱。对局结束后会自动出现在这里（赛事棋谱默认公开）。</div>`;
          return;
        }
        // 先铺好容器，再交给分页工具切片 + 画分页条（每页 20 条，与其他列表口径一致）
        card.innerHTML = `
          <div class="section-title" style="margin-bottom:10px;">赛事棋谱（${allRecords.length}）</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">赛事对局棋谱**默认公开**，所有人均可查看与复盘。</div>
          <div id="tnRecordsList"></div>
          <div id="tnRecordsPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>`;

        const pg = UI.paginate({
          items: allRecords,
          page: recPage,
          size: 20,
          container: 'tnRecordsPager',
          onPage: (n) => { recPage = n; renderRecordsCard(); },
        });
        recPage = pg.page;

        el('tnRecordsList').innerHTML = pg.slice.map((r) => {
          const names = r.names || ['先手', '後手'];
          const res = UI.resultText(r, { withClass: true });
          return `
            <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
              <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])}</div>
              <div class="r-result ${res.cls}">${esc(res.text)}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${r.moveCount || 0} 手 · ${fmtTime(r.createdAt)} · 进入复盘 →</div>
            </div>`;
        }).join('');
      }

      // ==================================================================
      // 重赛申请（T6/需求 12）
      //
      //  - 所有人都能看到申请与裁决结果（办赛透明）；
      //  - **本场选手**可以对自己那场提申请（"我能不能申诉这一场"由服务端核对 `lastPlayers`）；
      //  - 主办人 / 管理员对 pending 的申请裁决。
      // ==================================================================
      function renderRematchCard() {
        const card = el('tnRematchCard');
        const list = (T.rematches || []).slice().reverse();
        const pending = list.filter((r) => r.status === 'pending');
        const canDecide = !!caps.decide_rematch;

        // 我能申请重赛的场次：我打过、且该场还没有待裁决的申请
        const applicable = [];
        if (T.status === 'playing' && myPlayerId) {
          (T.bracket || []).forEach((n) => {
            const both = n.lastPlayers || n.players || [];
            if (!n.lastMatchId || both.indexOf(myPlayerId) < 0) return;
            if ((T.rematches || []).some((r) => r.matchId === n.lastMatchId && r.status === 'pending')) return;
            applicable.push(n);
          });
        }

        const rows = list.map((r) => {
          const node = (T.bracket || []).find((x) => x.index === r.nodeIndex) || {};
          const both = (node.lastPlayers || node.players || []).map((id) => nameOf(id)).join(' vs ');
          const st = {
            pending: ['🕐 待裁决', 'var(--gold-light)'],
            approved: ['✅ 已批准（该场重打）', 'var(--gold-light)'],
            rejected: ['❌ 已驳回', 'var(--red-light)'],
          }[r.status] || [esc(r.status), 'var(--text-dim)'];
          const btns = (canDecide && r.status === 'pending')
            ? `<button class="btn btn-primary btn-sm" data-rm="${esc(r.id)}" data-rmact="approve">批准重赛</button>
               <button class="btn btn-ghost btn-sm" data-rm="${esc(r.id)}" data-rmact="reject">驳回</button>`
            : '';
          return `
            <div class="record-item" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <div>
                <div style="font-size:13px;">${esc(both || '（对阵已重算）')} <span style="font-size:11px;color:${st[1]};">${st[0]}</span></div>
                <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
                  申请人 ${esc(r.byName || nameOf(r.byId))} · ${fmtTime(r.at)}${r.reason ? ` · 理由：${esc(r.reason)}` : ''}${r.note ? ` · 处理备注：${esc(r.note)}` : ''}
                </div>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">${btns}</div>
            </div>`;
        }).join('');

        const applyRows = applicable.map((n) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;margin-bottom:6px;">
            <span style="color:var(--text-dim);">我参与的一场（${esc((n.lastPlayers || []).map((id) => nameOf(id)).join(' vs '))}）</span>
            <button class="btn btn-ghost btn-sm" data-rm-apply="${esc(n.lastMatchId)}">申请重赛</button>
          </div>`).join('');

        card.innerHTML = `
          <div class="section-title" style="margin-bottom:10px;">重赛申请${list.length ? `（${list.length}）` : ''}</div>
          ${pending.length ? `<div style="font-size:12px;color:var(--gold-light);margin-bottom:8px;">有 ${pending.length} 条待裁决</div>` : ''}
          ${applyRows}
          ${rows || '<div style="color:var(--text-dim);font-size:13px;">暂无重赛申请。对局结束后，本场选手可在此申请重赛。</div>'}`;

        card.querySelectorAll('button[data-rm]').forEach((b) => {
          b.addEventListener('click', async () => {
            const act = b.getAttribute('data-rmact');
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const note = await askInput({
              title: act === 'approve' ? '批准重赛' : '驳回重赛',
              label: act === 'approve' ? '批准说明（可留空）' : '驳回理由（可留空）',
              multiline: true,
            });
            if (note === null) return; // 用户取消
            post(`/api/tournaments/${encodeURIComponent(T.id)}/rematch/${encodeURIComponent(b.getAttribute('data-rm'))}`,
              { decision: act, note },
              act === 'approve' ? '已批准重赛，该场将重打' : '已驳回重赛申请');
          });
        });
        card.querySelectorAll('button[data-rm-apply]').forEach((b) => {
          b.addEventListener('click', async () => {
            // ⚠️ 2026-10-02 体验修复：裸 window.prompt → 站内统一输入弹层（askInput）
            const reason = await askInput({ title: '申请重赛', label: '申请理由', multiline: true });
            if (reason === null) return;
            // `name` 传自己的名字，方便日志与列表显示（服务端只信 `x-account-token` 里的 id）
            post(`/api/tournaments/${encodeURIComponent(T.id)}/rematch`,
              { matchId: b.getAttribute('data-rm-apply'), reason, name: nameOf(myPlayerId) },
              '重赛申请已提交，等待主办人裁决');
          });
        });
      }

      // ==================================================================
      // 变更记录（最近 50 条，服务端已截断）
      // ==================================================================
      function renderLogs() {
        const logs = (T.logs || []).slice().reverse(); // 最新在上
        const rows = logs.map((l) => {
          const who = l.byName ? `${esc(l.byName)}` : (l.byRole === 'system' ? '系统' : '—');
          const roleTag = { admin: '管理员', owner: '主办人', player: '选手', system: '系统' }[l.byRole] || '';
          return `<div style="font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
              <span style="color:var(--text-dim);">${fmtTime(l.at)}</span>
              · <span style="color:var(--gold-light);">${LOG_ACTION[l.action] || esc(l.action || '')}</span>
              · ${who}${roleTag ? `（${roleTag}）` : ''}
            </div>`;
        }).join('');

        // 管理员编辑历史（T6/需求 11）：**只有管理员能拿到这个字段**
        // （HTTP 出口按是否管理员决定下发，见 src/http/routes/tournaments.js）
        const edits = (T.adminEditLog || []).slice().reverse();
        const editRows = edits.map((e) => `
          <div style="font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-dim);">${fmtTime(e.at)}</span>
            · <span style="color:var(--red-light);">管理员编辑 ${esc(e.field)}</span>
            · ${esc(String(e.from == null ? '—' : e.from))} → ${esc(String(e.to == null ? '—' : e.to))}
            ${e.note ? ` · ${esc(e.note)}` : ''}
          </div>`).join('');

        el('tnLogs').innerHTML = `
          <div class="section-title" style="margin-bottom:12px;">变更记录${logs.length ? `（最近 ${logs.length} 条）` : ''}</div>
          ${rows || '<div style="color:var(--text-dim);font-size:13px;">暂无记录。</div>'}
          ${edits.length ? `
            <div class="section-title" style="margin:18px 0 12px;font-size:14px;color:var(--red-light);">管理员编辑历史（赛后改动留痕）</div>
            ${editRows}` : ''}`;
      }

      // ==================================================================
      // 事件
      // ==================================================================
      this._teardown.push(api.on('tournament_joined', (d) => {
        if (d && d.pending) toast('报名已提交，等待主办人批准');
        else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
        else toast('报名成功');
        load(); // 重新拉取（含新的 caps 与名单）
      }));
      this._teardown.push(api.on('error', (d) => {
        if (d && d.message) toast(d.message);
      }));
      // ⚠️ 2026-10-02 体验修复：详情页此前不监听 game_start → 「轮到你了」页面不跳对局
      //（列表页有该监听 + 5 秒轮询，详情页没有，导致玩家最可能停留的页面反而"死屏"）。
      this._teardown.push(api.on('game_start', (d) => {
        if (d && d.roomId && !location.search.includes('room')) {
          // SPA：整页跳转改路由（原为 location.href 跳转 play.html?room=…）
          global.Router.navigate(`play.html?room=${encodeURIComponent(d.roomId)}`);
        }
      }));

      // 名单/待办队列里的操作按钮（2026-09-23，审查项 13f）：
      // 从"两处各自 querySelectorAll + 逐个绑定"改为**一处注册 + 整页委托**。
      // ⚠️ 这几个动作名（approve / reject / kick / void / champion）起得比较泛，只在本页使用。
      // SPA：util.js 的委托注册表是整页一份的全局表（没有 off），故在**模块级只注册一次**、
      // 逻辑经 `View._handlers` 命名空间转发——unmount 清空 `_handlers` 后旧句柄即不可达。
      this._handlers = { rosterAction };

      load();
    },

    unmount() {
      this._mounted = false;
      this._handlers = {}; // 旧句柄失效：data-act 委托经 _handlers 转发，清空后调不到
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  // 「批准 / 拒绝 / 踢出 / 取消成绩 / 设冠军」按钮：data-act 委托（2026-09-23，审查项 13f）。
  // util.js 的委托注册表是**整页一份的全局表**（没有 off），故在模块级注册一次、
  // 逻辑经 `View._handlers` 命名空间转发——unmount 清空 `_handlers` 后旧句柄即不可达。
  ['approve', 'reject', 'kick', 'void', 'champion'].forEach((act) => {
    UI.onAction(act, (btn) => {
      const h = View._handlers && View._handlers.rosterAction;
      if (h) h(act, btn.getAttribute('data-pid'));
    });
  });

  global.Views.tournament = View;
})(window);
