/**
 * admin-tournaments.js — 赛事管理（admin 子模块）：审核队列、取消、存档
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.tournaments`）——加载本文件零副作用：
 *   mount(ctx)  → 导出 loadTournaments / 审核动作等到 ctx.hub（无静态 DOM 绑定，纯渲染函数）
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / pages / fmtTs）由 admin.js 的 mount 通过 `ctx` 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清；本模块目前无静态监听，预留一致性） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, pages, setToken, toast, hub, fmtTs } = ctx;
    const alive = () => ctx.isAlive();

    // ---- 赛事管理（PLAN §E：审核队列 / 取消）----
    let allTournaments = [];
    const TN_STATUS_LABEL = {
      pending_approval: '🕐 待审核',
      // T1 起「报名中」的状态名是 `registration`；保留 `open` 仅作兜底
      registration: '📌 报名中',
      open: '📌 报名中',
      playing: '⚔️ 比赛中',
      finished: '🏆 已结束',
      archived: '📦 已存档',
      rejected: '❌ 已拒绝',
      cancelled: '⛔ 已取消',
    };

    async function loadTournaments() {
      try {
        const data = await global.ApiUtils.get(`/api/admin/tournaments?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allTournaments = data.tournaments || [];
        // 赛事 tab **刻意不分页**：它内部已按「待审核 / 进行中 / 历史」分三块渲染，
        // 整体切片会打乱这个分组（比如某页只剩"历史"没有"待审核"）。
        // 历史块自带 max-height + 滚动，赛事数量级也远小于棋谱/用户，暂不需要。
        renderTournaments(allTournaments);
      } catch (e) {
        if (!alive()) return;
        if (e.message && e.message.includes('403')) setToken(null);
        if (hub.initUI) hub.initUI();
      }
    }

    /** 已确认参赛人数：开赛后看 players，报名阶段看 entrants 里 approved 的数量 */
    function tnJoinedCount(t) {
      const s = t.status;
      if (s === 'playing' || s === 'finished' || s === 'archived') return t.playerCount || 0;
      return (t.entrants || []).filter((e) => e.status === 'approved').length;
    }

    function renderTournaments(list) {
      const cnt = $('tnCount');
      if (cnt) cnt.textContent = list.length;
      const pending = list.filter((t) => t.status === 'pending_approval');
      // ⚠️ T1 起「报名中」的状态名是 `registration`（旧的 `open` 由服务端出口映射过来）
      const active = list.filter((t) => t.status === 'registration' || t.status === 'playing');
      // T1 起多了 `archived`（已存档）——与 finished 同属历史
      const history = list.filter((t) => ['finished', 'archived', 'rejected', 'cancelled'].includes(t.status));
      const stats = $('tnStats');
      if (stats) stats.textContent =
        `待审核 ${pending.length} · 进行中 ${active.length} · 累计 ${list.length}`;
      fillTnList('tnPendingList', 'tnPendingPager', 'tnPending', pending, '没有待审核的赛事申请');
      fillTnList('tnActiveList', 'tnActivePager', 'tnActive', active, '暂无进行中的赛事');
      fillTnList('tnHistoryList', 'tnHistoryPager', 'tnHistory', history, '暂无历史赛事');
    }

    /**
     * 渲染一个赛事列表 + 分页条（需求 13：**一页只显示 20 个**，避免数据库信息过多时爆炸）。
     * 三个列表各自独立记页码（共用 `pages`，键为 `tnPending` / `tnActive` / `tnHistory`）。
     */
    function fillTnList(listElId, pagerElId, key, fullList, emptyText) {
      const el = $(listElId);
      if (!el) return;
      if (!fullList.length) {
        el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${emptyText}</div>`;
        global.UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
        return;
      }
      const pg = global.UI.paginate({
        items: fullList,
        page: pages[key] || 1,
        size: 20,
        container: pagerElId,
        onPage: (n) => {
          pages[key] = n;
          // 只重画这一个列表：重新拉全量再整页重绘代价太大（管理员赛事数量本就不少）
          fillTnList(listElId, pagerElId, key, fullList, emptyText);
        },
      });
      pages[key] = pg.page;
      el.innerHTML = pg.slice.map((t) => {
        const approved = tnJoinedCount(t);
        const pendingN = (t.entrants || []).filter((e) => e.status === 'pending').length;
        const meta = [
          // 赛制要显示出来：T8 起有瑞士制，审核与排障时"这是哪种赛制"是首要信息
          t.formatLabel || (t.format === 'swiss' ? '瑞士制' : '单败淘汰'),
          `${approved}/${t.size} 人${pendingN ? `（待批准 ${pendingN}）` : ''}`,
          (t.format === 'swiss' && t.totalRounds)
            ? `第 ${t.currentRound || 0}/${t.totalRounds} 轮` : '',
          t.ownerName ? `主办 ${esc(t.ownerName)}` : '',
          global.I18N.fmt(t.createdAt),
        ].filter(Boolean).join(' · ');

        // ---- 申请表信息（T2）：审核时最需要看的就是"为什么办、什么时候办" ----
        const schedule = [
          (t.registerStart || t.registerEnd) ? `报名 ${fmtTs(t.registerStart)} ~ ${fmtTs(t.registerEnd)}` : '',
          (t.matchStart || t.matchEnd) ? `比赛 ${fmtTs(t.matchStart)} ~ ${fmtTs(t.matchEnd)}` : '',
          t.requireApproval === false ? '报名<b>免</b>审核' : '报名需审核',
        ].filter(Boolean).join(' · ');
        const applyInfo = `
      <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">📅 ${schedule}</div>
      ${t.reason ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">📝 理由：${esc(t.reason)}</div>` : ''}`;

        let actions = '';
        if (t.status === 'pending_approval') {
          actions = `
        <button class="btn btn-primary btn-sm" data-act="tn-approve" data-id="${esc(t.id)}">✓ 通过</button>
        <button class="btn btn-ghost btn-sm" data-act="tn-reject" data-id="${esc(t.id)}">✗ 拒绝</button>`;
        } else if (t.status === 'registration' || t.status === 'playing') {
          actions = `<button class="btn btn-ghost btn-sm" data-act="tn-cancel" data-id="${esc(t.id)}">⛔ 取消赛事</button>`;
        } else if (t.status === 'finished') {
          // T6：存档（存档后主办人只读，管理员仍可编辑）
          actions = `<button class="btn btn-ghost btn-sm" data-act="tn-archive" data-id="${esc(t.id)}">📦 存档</button>`;
        }
        // 所有状态都能进详情页（那里有对阵表、赛事棋谱、重赛与变更记录）
        actions += `<a class="btn btn-ghost btn-sm" href="tournament.html?id=${encodeURIComponent(t.id)}" target="_blank">详情 ↗</a>`;
        // ⚠️ `t.reason` 的语义在 T1 变了：旧数据里它才是"拒绝/取消原因"，
        // 现在是"举办理由"。拒绝原因读 `rejectReason`——服务端出口已按状态做过归位。
        const rejectReason = t.rejectReason
          ? `<div style="font-size:11px;color:var(--red-light);margin-top:3px;">原因：${esc(t.rejectReason)}</div>` : '';
        const champ = (t.status === 'finished' && t.championId && t.players)
          ? `<div style="font-size:12px;color:var(--gold-light);margin-top:3px;">🏆 冠军：${esc((t.players.find((p) => p.id === t.championId) || {}).name || '—')}</div>` : '';
        return `
      <div class="record-item">
        <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
          <span>${esc(t.name)}</span>
          <span style="color:var(--text-dim);font-size:12px;">${TN_STATUS_LABEL[t.status] || t.status}</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${meta}</div>
        ${applyInfo}${rejectReason}${champ}
        ${actions ? `<div style="display:flex;gap:6px;margin-top:8px;">${actions}</div>` : ''}
      </div>
    `;
      }).join('');
    }

    async function tnAction(id, action, reason) {
      try {
        const res = await fetch(`/api/admin/tournaments/${id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify({ reason: reason || '' }),
        });
        if (!alive()) return false;
        const data = await res.json();
        if (!alive()) return false;
        if (!res.ok || !data.ok) {
          toast((data && data.error) || '操作失败');
          return false;
        }
        const suffix = action === 'cancel' && data.dissolvedMatches ? `（已解散 ${data.dissolvedMatches} 场对局）` : '';
        toast(action === 'approve' ? '已通过审核' : action === 'reject' ? '已拒绝' : `已取消${suffix}`);
        loadTournaments();
        return true;
      } catch (_) {
        if (alive()) toast('网络错误');
        return false;
      }
    }
    hub.tnApprove = (id) => tnAction(id, 'approve');
    hub.tnReject = (id) => {
      const reason = prompt('拒绝原因（可留空）：');
      if (reason === null) return;
      tnAction(id, 'reject', reason);
    };
    hub.tnCancel = (id) => {
      const name = (allTournaments.find((t) => t.id === id) || {}).name || '';
      if (!confirm(`确定取消赛事「${name}」？进行中的对局将被解散。`)) return;
      const reason = prompt('取消原因（可留空）：');
      if (reason === null) return;
      tnAction(id, 'cancel', reason);
    };

    // 存档赛事（T6/需求 11）：复用 `tnAction`——同样是 `/api/admin/tournaments/:id/:action`
    // 的 POST + 审计落盘，没必要另写一份 fetch。
    hub.tnArchive = (id) => {
      const name = (allTournaments.find((t) => t.id === id) || {}).name || '';
      if (!confirm(`确定存档赛事「${name}」？\n存档后主办人转为只读，仅管理员可继续编辑。`)) return;
      tnAction(id, 'archive');
    };

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadTournaments = loadTournaments;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.tournaments = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);
