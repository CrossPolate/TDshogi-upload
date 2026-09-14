/**
 * tournaments.js — 赛事页：我要创建赛事（需登录正式账号）、报名、对阵表渲染
 *
 * 页面只分两段展示：进行中的赛事（open/playing）与往期赛事（finished）。
 * 创建入口为顶部按钮：游客 → 引导登录；正式账号 → 弹窗填写后提交。
 */
(function () {
  const guest = window.NAV.renderNav('tournaments');
  const api = window.API;
  api.connect(guest.id);
  // 我的对局玩家 id：账号的 guest.id 是会话令牌（含点），参赛名单存的是 accountId
  const myPlayerId = guest.id && String(guest.id).includes('.')
    ? String(guest.id).split('.')[0]
    : guest.id;
  // 本窗口刚提交、还在审核中的赛事（公共列表不返回 pending，仅本地展示）
  let myPending = [];

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }

  // ==================================================================
  // 视图切换：全部赛事 ⇄ 我的赛事（2026-09-13 用户要求）
  // 「我的赛事」按钮紧挨创建按钮；我的赛事 = 我主办的 + 我参赛/报名的
  // ==================================================================
  const mainSection = document.getElementById('mainSection');
  const mineSection = document.getElementById('mineSection');
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
  document.getElementById('btnMyTournaments').addEventListener('click', () => showMine(true));
  document.getElementById('btnBackFromMine').addEventListener('click', () => showMine(false));

  // ---- 创建赛事 ----
  const modalEl = document.getElementById('createModal');

  document.getElementById('btnCreateTournament').addEventListener('click', () => {
    // 正式账号的 guest.id 是会话令牌（含点号）；游客是 24 hex 纯十六进制
    if (!guest.id || !String(guest.id).includes('.')) {
      toast('创建赛事需要登录正式账号，请先登录');
      setTimeout(() => { location.href = 'profile.html'; }, 800);
      return;
    }
    modalEl.style.display = 'flex';
  });

  document.getElementById('btnCloseCreateModal').addEventListener('click', () => {
    modalEl.style.display = 'none';
  });
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) modalEl.style.display = 'none';
  });

  /** `datetime-local` 的值 → 时间戳；留空 → null（视为"不限"） */
  function tsOf(id) {
    const v = document.getElementById(id).value;
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }

  document.getElementById('btnSubmitCreate').addEventListener('click', () => {
    const name = document.getElementById('tName').value.trim();
    const size = parseInt(document.getElementById('tSize').value, 10);
    const format = document.getElementById('tFormat').value;
    const reason = document.getElementById('tReason').value.trim();
    const registerStart = tsOf('tRegStart');
    const registerEnd = tsOf('tRegEnd');
    const matchStart = tsOf('tMatchStart');
    const matchEnd = tsOf('tMatchEnd');
    const requireApproval = document.getElementById('tRequireApproval').checked;

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
      },
    });
  });

  api.on('tournament_created', (data) => {
    toast(`赛事「${data.name}」创建申请已提交，等待管理员审核`);
    modalEl.style.display = 'none';
    if (data.status === 'pending_approval') myPending.push(data);
    loadTournaments();
  });
  api.on('tournament_joined', (d) => {
    // T3：两段式报名——需审核时只是"申请已提交"，别给用户"已经参赛"的错觉
    if (d && d.pending) toast('报名已提交，等待主办人批准');
    else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
    else toast('报名成功');
    loadTournaments();
  });
  api.on('error', (data) => {
    if (data && data.message) toast(data.message);
  });

  // 赛事对局开始：在线参赛者自动进入对局页
  api.on('game_start', (data) => {
    if (data && data.roomId && !location.search.includes('room=')) {
      location.href = `play.html?room=${data.roomId}&join=1`;
    }
  });

  async function loadTournaments() {
    try {
      const data = await window.ApiUtils.get('/api/tournaments');
      latestList = data.tournaments || [];
      renderAll();
    } catch (e) { console.error(e); }
  }

  /**
   * 状态文案（多处复用，收敛为一处，避免各写一套后互不一致）。
   * ⚠️ T1 起"报名中"的状态名是 `registration`（服务端出口已把旧的 `open` 映射过来）。
   */
  function statusText(t) {
    return t.status === 'pending_approval' ? '🕐 审核中'
      : t.status === 'registration' ? '报名中'
        : t.status === 'playing' ? '进行中'
          : t.status === 'archived' ? '已存档'
            : t.status === 'rejected' ? '已拒绝'
              : t.status === 'cancelled' ? '已取消' : '已结束';
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
    const el = document.getElementById('mineList');
    const mine = all.filter(isMine);
    if (!mine.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">你还没有参与任何赛事。报名一场，或点「🏆 我要创建赛事」自己办一个吧！</div>';
      window.UI.paginate({ items: [], container: 'minePager' });
      return;
    }
    const pg = window.UI.paginate({
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
          <span style="font-size:12px;color:var(--text-dim);">${statusText(t)} · ${joinedCount(t)}/${t.size} 人</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:12px;color:var(--gold-light);">${champ}</span>
          ${joinAreaOf(t)}
          <a class="btn btn-ghost btn-sm" href="tournament.html?id=${encodeURIComponent(t.id)}">详情</a>
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
    const el = document.getElementById(listElId);
    if (!list.length) {
      el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${
        mode === 'row' ? '还没有结束的赛事。' : '暂无进行中的赛事，点右上角「🏆 我要创建赛事」开一个吧！'
      }</div>`;
      window.UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
      return;
    }
    const pg = window.UI.paginate({
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

  /** 报名入口 / 当前报名状态（T3 两段式：可能是「待主办人批准」） */
  function joinAreaOf(t) {
    if (t.status !== 'registration') return '';
    const entrants = t.entrants || [];
    const mine = entrants.find((e) => e.id === myPlayerId);
    if (!mine) {
      return `<button class="btn btn-primary btn-sm" onclick="joinTournament('${t.id}')">报名</button>`;
    }
    const map = {
      pending: ['🕐 待主办人批准', 'var(--gold-light)'],
      approved: [`已报名 (${joinedCount(t)}/${t.size})`, 'var(--gold-light)'],
      rejected: ['报名被拒绝', 'var(--red-light)'],
      kicked: ['已被移出', 'var(--red-light)'],
    };
    const hit = map[mine.status];
    return hit ? `<span style="font-size:13px;color:${hit[1]};">${hit[0]}</span>` : '';
  }

  /**
   * 主办人操作面板（T3）：待批准列表 + 批准/拒绝 + 手动开赛。
   *
   * 只在**报名阶段**显示：开赛后名单就冻结了，再批人也没有位置可进（T4 的
   * 「取消选手成绩」才是那时的正确操作）。
   */
  function ownerPanelOf(t) {
    if (t.ownerId !== myPlayerId || t.status !== 'registration') return '';
    const entrants = t.entrants || [];
    const pending = entrants.filter((e) => e.status === 'pending');
    const approvedN = joinedCount(t);
    const rows = pending.map((e) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;margin-bottom:4px;">
        <span data-player-id="${esc(e.id)}">${esc(e.name)}</span>
        <span style="display:flex;gap:6px;">
          <button class="btn btn-primary btn-sm" onclick="tournamentDecide('${t.id}','${e.id}','approve')">批准</button>
          <button class="btn btn-ghost btn-sm" onclick="tournamentDecide('${t.id}','${e.id}','reject')">拒绝</button>
        </span>
      </div>`).join('');
    return `
      <div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">
          🎛 主办人操作 · 已批准 <b>${approvedN}/${t.size}</b>
          ${t.requireApproval ? '' : '（免审核：报名即参赛）'}
          ${pending.length ? `· <span style="color:var(--gold-light);">待批准 ${pending.length}</span>` : ''}
        </div>
        ${rows || '<div style="font-size:12px;color:var(--text-dim);">暂无待批准的报名。</div>'}
        <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="tournamentStart('${t.id}')">
          ▶️ 开始比赛（未满员也可，多出的位置自动轮空）
        </button>
      </div>`;
  }

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
            <span style="font-size:13px;color:var(--text-dim);">${statusText(t)} · ${joinedCount(t)}/${t.size} 人</span>
            ${joinAreaOf(t)}
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">
          参赛者：${names}${pendingN ? ` <span style="color:var(--gold-light);">（另有 ${pendingN} 人待批准）</span>` : ''}
        </div>
        ${t.championId ? `<div style="margin-top:12px;color:var(--gold-light);font-weight:700;">🏆 冠军：${esc(getName(t, t.championId))}${t.championManual ? '（人工裁定）' : ''}</div>` : ''}
        <div style="margin-top:10px;">
          <a class="btn btn-ghost btn-sm" href="tournament.html?id=${encodeURIComponent(t.id)}">查看详情 / 管理 →</a>
        </div>
        ${ownerPanelOf(t)}
      </div>
    `;
  }

  function getName(t, id) {
    const p = (t.players || []).find((x) => x.id === id);
    return p ? p.name : '未知';
  }

  // 对阵表渲染**已统一到 util.js 的 `UI.bracketHtml(t, opts)`**（2026-09-13）：
  // 列表页与详情页要画同一棵树，各写一份的结果必然是一边修了另一边没修。

  window.joinTournament = (id) => {
    api.send({ type: 'join_tournament', data: { id } });
  };

  // ==================================================================
  // 赛事管理（T3）：批准报名 / 踢人 / 手动开赛
  //
  // ⚠️ 身份走 **token 头**，不是 `?player=<id>` 查询参数——
  // 后者是公开查询用的宽松通道，任何人都能填别人的 id，拿它做管理鉴权等于没鉴权。
  // ⚠️ 权限判定的唯一实现在服务端 `tournaments.canManage()`；这里只负责发起请求。
  // ==================================================================

  // 带身份的提交**统一在 `ApiUtils.postAuthed`**（2026-09-13）：详情页也要用同一套，
  // 各写一份就会出现"一边改了 token 头、另一边没改"。
  function authedPost(path, body) {
    return window.ApiUtils.postAuthed(path, body, guest.id);
  }

  window.tournamentDecide = async (id, playerId, decision) => {
    try {
      const d = await authedPost(`/api/tournaments/${encodeURIComponent(id)}/entrants/${encodeURIComponent(playerId)}`,
        { decision });
      toast(decision === 'approve' ? '已批准报名' : '已拒绝报名');
      if (d && d.started) toast('名额已满，赛事自动开始！');
      loadTournaments();
    } catch (e) { toast(e.message); }
  };

  window.tournamentKick = async (id, playerId) => {
    try {
      await authedPost(`/api/tournaments/${encodeURIComponent(id)}/kick`, { playerId });
      toast('已移出该报名者');
      loadTournaments();
    } catch (e) { toast(e.message); }
  };

  window.tournamentStart = async (id) => {
    try {
      await authedPost(`/api/tournaments/${encodeURIComponent(id)}/start`, {});
      toast('赛事已开始');
      loadTournaments();
    } catch (e) { toast(e.message); }
  };

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  loadTournaments();
  setInterval(loadTournaments, 5000);  // 轮询：检测新对局安排/对阵推进
})();
