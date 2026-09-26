/**
 * tournament.js — 赛事详情页（T5，2026-09-13）
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
 */
(function () {
  const guest = window.NAV.renderNav('tournaments');
  const api = window.API;
  api.connect(guest.id);

  // 参赛名单里存的是 accountId；`guest.id` 是会话令牌（含点）时取点前部分
  const myPlayerId = guest.id && String(guest.id).includes('.')
    ? String(guest.id).split('.')[0]
    : guest.id;

  const tid = new URLSearchParams(location.search).get('id');

  let T = null;        // 赛事（publicInfo 形态）
  let caps = {};       // 服务端下发的"我能做什么"
  let isAdmin = false; // 是否带管理员令牌（仅用于文案提示）

  function esc(s) { return window.UI.esc(s); }
  function toast(m) { return window.UI.toast(m); }
  function el(id) { return document.getElementById(id); }

  /** 操作日志的中文名。未知 action 原样显示——不隐藏信息，方便排障 */
  const LOG_ACTION = {
    create: '提交创建申请', approve: '审核通过', reject: '审核拒绝',
    cancel: '取消赛事', archive: '存档', finish: '赛事结束',
    start: '开赛', join: '报名', bye: '轮空直接晋级',
    'entrant-approve': '批准报名', 'entrant-reject': '拒绝报名',
    'set-champion': '设置冠军', 'void-player': '取消选手成绩',
    'rematch-request': '申请重赛', 'rematch-approve': '批准重赛（该场重打）', 'rematch-reject': '驳回重赛',
  };

  const STATUS_TEXT = {
    pending_approval: '🕐 待管理员审核',
    registration: '📌 报名中',
    playing: '⚔️ 比赛中',
    finished: '🏆 已结束',
    archived: '📦 已存档',
    rejected: '❌ 已拒绝',
    cancelled: '⛔ 已取消',
  };

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
    return I18N.fmt(ts, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  // ==================================================================
  // 加载
  // ==================================================================
  async function load() {
    if (!tid) return showError('链接里没有赛事 id，请从赛事列表进入。');
    try {
      const d = await window.ApiUtils.get(`/api/tournaments/${encodeURIComponent(tid)}`);
      T = d.tournament;
      caps = d.caps || {};
      isAdmin = !!d.viewerIsAdmin;
    } catch (e) {
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
      const res = await window.ApiUtils.postAuthed(path, body, guest.id);
      afterMutate(res, okMsg);
      return res;
    } catch (e) {
      toast(e.message);
      return null;
    }
  }

  function renderAll() {
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

    // ---- 报名（仅报名阶段）----
    if (T.status === 'registration') {
      const mine = (T.entrants || []).find((e) => e.id === myPlayerId);
      const approvedN = joinedCount(T);
      if (!myPlayerId) {
        parts.push(notice('登录后可报名参加本赛事。', 'ghost'));
      } else if (!mine) {
        const full = approvedN >= T.size;
        parts.push(`
          <div class="card" style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <div style="font-size:13px;color:var(--text-dim);">
              ${full ? '名额已满。' : `已有 ${approvedN}/${T.size} 人通过报名${T.requireApproval ? '，报名需主办人审核' : ''}。`}
            </div>
            <button class="btn btn-primary" id="btnJoinTn" ${full ? 'disabled' : ''}>${full ? '名额已满' : '报名参加'}</button>
          </div>`);
      } else {
        const map = {
          pending: ['🕐 报名已提交，等待主办人批准', 'var(--gold-light)'],
          approved: ['✅ 已报名（' + approvedN + '/' + T.size + ' 人）', 'var(--gold-light)'],
          rejected: ['❌ 你的报名被主办人拒绝', 'var(--red-light)'],
          kicked: ['🚫 你已被主办人移出本赛事', 'var(--red-light)'],
        };
        const hit = map[mine.status] || ['已报名', 'var(--text-dim)'];
        parts.push(`<div class="card" style="padding:16px 20px;font-size:13px;color:${hit[1]};">${hit[0]}</div>`);
      }
    }

    // ---- 我参与的对局（进行中）----
    if (myPlayerId) {
      const myNodes = (T.bracket || []).filter(
        (n) => n.matchId && n.players && n.players.indexOf(myPlayerId) >= 0
      );
      if (myNodes.length) {
        parts.push(`
          <div class="card" style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <div style="font-size:13px;color:var(--gold-light);">⚔️ 你有对局正在进行中</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${myNodes.map((n) => `<a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(n.matchId)}&join=1">进入对局</a>`).join('')}
            </div>
          </div>`);
      }
    }

    box.innerHTML = parts.join('');

    const joinBtn = el('btnJoinTn');
    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        // 报名走 WS：身份由连接握手时绑定，客户端无从伪造（见 history.js 顶部同源注释）
        api.send({ type: 'join_tournament', data: { id: T.id } });
      });
    }
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
    const canAny = caps.decide_entrant || caps.kick_player || caps.assign_round
      || caps.void_player || caps.cancel || caps.set_champion;
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
      cancelBtn.addEventListener('click', () => {
        const reason = prompt('取消赛事的原因（可留空）：');
        if (reason === null) return; // 用户按了取消
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
        window.ApiUtils.postAuthed(`/api/admin/tournaments/${encodeURIComponent(T.id)}/archive`, {}, guest.id)
          .then((res) => afterMutate(res, '赛事已存档'))
          .catch((e) => toast(e.message));
      });
    }
    const noteBtn = el('btnEditNoteTn');
    if (noteBtn) {
      noteBtn.addEventListener('click', () => {
        const note = prompt('赛事备注（仅管理员可编辑，会记入编辑历史）：', T.note || '');
        if (note === null) return;
        window.ApiUtils.postAuthed(`/api/admin/tournaments/${encodeURIComponent(T.id)}/edit`,
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
      ['报名时间', `${fmtTime(T.registerStart)} ~ ${fmtTime(T.registerEnd)}`],
      ['比赛时间', `${fmtTime(T.matchStart)} ~ ${fmtTime(T.matchEnd)}`],
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
      ${reason}${reject}`;
  }

  // ==================================================================
  // 参赛名单（报名池 + 参赛者；主办人可直接在此批准/拒绝/踢人）
  // ==================================================================
  function renderRoster() {
    const entrants = T.entrants || [];
    const isPlaying = T.status === 'playing' || T.status === 'finished' || T.status === 'archived';

    const label = {
      pending: ['🕐 待批准', 'var(--gold-light)'],
      approved: ['✅ 已通过', 'var(--gold-light)'],
      rejected: ['❌ 已拒绝', 'var(--red-light)'],
      kicked: ['🚫 已移出', 'var(--red-light)'],
    };

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
    card.innerHTML = `
      <div class="section-title" style="margin-bottom:4px;">对阵表</div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
        金色边框 = 已分出胜负；「空位」= 该位置无人（报名不足时会出现，对手自动轮空晋级）
      </div>
      ${window.UI.bracketHtml(T, { myId: myPlayerId, detail: true })}`;
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
      const rows = (r.pairs || []).map(([a, b], i) => {
        const w = (r.results || {})[pairKey(a, b)];
        const mine = !!myPlayerId && (a === myPlayerId || b === myPlayerId);
        const roomId = (r.matchIds || [])[i];
        let tag;
        if (w) {
          tag = `<span style="color:var(--gold-light);">${esc(nameOf(w))} 胜</span>`;
        } else if (roomId) {
          tag = mine
            ? `<a class="btn btn-primary btn-sm" href="play.html?room=${encodeURIComponent(roomId)}&join=1">进入对局</a>`
            : '<span style="color:var(--text-dim);">进行中</span>';
        } else {
          tag = '<span style="color:var(--text-dim);">—</span>';
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
      return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;${isCur ? 'border-color:var(--gold);' : ''}">
          <div style="font-size:13px;font-weight:700;margin-bottom:6px;">
            第 ${r.round} 轮${isCur ? ' <span style="font-size:11px;color:var(--gold-light);">进行中</span>' : ''}
            ${r.degraded ? '<span style="font-size:11px;color:var(--red-light);">（配对经过退让，可能有重复对阵）</span>' : ''}
          </div>
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
      const d = await window.ApiUtils.get(`/api/tournaments/${encodeURIComponent(tid)}/records`);
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

    const pg = window.UI.paginate({
      items: allRecords,
      page: recPage,
      size: 20,
      container: 'tnRecordsPager',
      onPage: (n) => { recPage = n; renderRecordsCard(); },
    });
    recPage = pg.page;

    el('tnRecordsList').innerHTML = pg.slice.map((r) => {
      const names = r.names || ['先手', '後手'];
      const res = window.UI.resultText(r, { withClass: true });
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
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-rmact');
        const note = prompt(act === 'approve' ? '批准说明（可留空）：' : '驳回理由（可留空）：');
        if (note === null) return; // 用户取消
        post(`/api/tournaments/${encodeURIComponent(T.id)}/rematch/${encodeURIComponent(b.getAttribute('data-rm'))}`,
          { decision: act, note },
          act === 'approve' ? '已批准重赛，该场将重打' : '已驳回重赛申请');
      });
    });
    card.querySelectorAll('button[data-rm-apply]').forEach((b) => {
      b.addEventListener('click', () => {
        const reason = prompt('申请重赛的理由：');
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
  api.on('tournament_joined', (d) => {
    if (d && d.pending) toast('报名已提交，等待主办人批准');
    else if (d && d.started) toast('报名成功！名额已满，赛事自动开始');
    else toast('报名成功');
    load(); // 重新拉取（含新的 caps 与名单）
  });
  api.on('error', (d) => {
    if (d && d.message) toast(d.message);
  });

  // 名单/待办队列里的操作按钮（2026-09-23，审查项 13f）：
  // 从"两处各自 querySelectorAll + 逐个绑定"改为**一处注册 + 整页委托**。
  // ⚠️ 这几个动作名（approve / reject / kick / void / champion）起得比较泛，
  // 只在本页使用、且本页不与 admin.html 共存，故不改名（改用 data-pid 传参赛者 id）。
  window.UI.onAction('approve', (btn) => rosterAction('approve', btn.getAttribute('data-pid')));
  window.UI.onAction('reject', (btn) => rosterAction('reject', btn.getAttribute('data-pid')));
  window.UI.onAction('kick', (btn) => rosterAction('kick', btn.getAttribute('data-pid')));
  window.UI.onAction('void', (btn) => rosterAction('void', btn.getAttribute('data-pid')));
  window.UI.onAction('champion', (btn) => rosterAction('champion', btn.getAttribute('data-pid')));

  load();
})();
