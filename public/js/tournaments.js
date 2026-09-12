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

  document.getElementById('btnSubmitCreate').addEventListener('click', () => {
    const name = document.getElementById('tName').value.trim();
    const size = parseInt(document.getElementById('tSize').value, 10);
    api.send({ type: 'create_tournament', data: { name: name || '未命名赛事', size } });
  });

  api.on('tournament_created', (data) => {
    toast(`赛事「${data.name}」创建申请已提交，等待管理员审核`);
    modalEl.style.display = 'none';
    if (data.status === 'pending_approval') myPending.push(data);
    loadTournaments();
  });
  api.on('tournament_joined', () => {
    toast('已加入赛事');
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
      renderList(data.tournaments || []);
    } catch (e) { console.error(e); }
  }

  function renderList(list) {
    // open=报名中 / playing=比赛中 都属于"进行中"；finished 为往期；
    // 本窗口刚提交的 pending_approval 合并显示为「审核中」（服务端审核通过后进入公共列表）
    const pendingLocal = myPending.filter((p) => !list.some((t) => t.id === p.id));
    const ongoing = [...pendingLocal, ...list.filter((t) => t.status !== 'finished')];
    const finished = list.filter((t) => t.status === 'finished');
    renderInto(document.getElementById('ongoingList'), ongoing, false);
    renderInto(document.getElementById('finishedList'), finished, true);
  }

  function renderInto(el, list, isPast) {
    if (!list.length) {
      el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${
        isPast ? '还没有结束的赛事。' : '暂无进行中的赛事，点击右上角「我要创建赛事」开一个吧！'
      }</div>`;
      return;
    }
    el.innerHTML = list.map((t) => {
      const statusText = t.status === 'pending_approval' ? '🕐 审核中'
        : t.status === 'open' ? '报名中'
        : t.status === 'playing' ? '进行中' : '已结束';
      const isIn = t.players.some((p) => p.id === myPlayerId);
      const joinBtn = t.status === 'open' && !isIn
        ? `<button class="btn btn-primary btn-sm" onclick="joinTournament('${t.id}')">加入</button>`
        : t.status === 'open' && isIn
          ? `<span style="color:var(--gold-light);font-size:13px;">已报名 (${t.players.length}/${t.size})</span>`
          : '';
      return `
        <div class="card tournament-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-weight:700;font-size:17px;">${esc(t.name)}</div>
            <div style="display:flex;gap:12px;align-items:center;">
              <span style="font-size:13px;color:var(--text-dim);">${statusText} · ${t.players.length}/${t.size} 人</span>
              ${joinBtn}
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">
            参赛者：${(t.players || []).map((p) => `<span data-player-id="${esc(p.id)}">${esc(p.name)}</span>`).join('、') || '暂无'}
          </div>
          ${t.bracket && t.bracket.length ? renderBracket(t) : ''}
          ${t.status === 'finished' && t.championId ? `<div style="margin-top:12px;color:var(--gold-light);font-weight:700;">🏆 冠军：${esc(getName(t, t.championId))}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function getName(t, id) {
    const p = (t.players || []).find((x) => x.id === id);
    return p ? p.name : '未知';
  }

  // 渲染对阵表（平铺树 → 分层）
  function renderBracket(t) {
    const bracket = t.bracket || [];
    if (!bracket.length) return '';
    // 按层级分组：满二叉树，叶子在最下层
    const depth = Math.log2(t.size);
    const levels = [];
    for (let d = 0; d <= depth; d++) {
      const start = Math.pow(2, d) - 1;
      const count = Math.pow(2, d);
      const nodes = bracket.slice(start, start + count);
      levels.push(nodes);
    }
    const myId = myPlayerId;
    return `
      <div class="bracket">
        ${levels.map((levelNodes, li) => `
          <div class="bracket-col">
            ${levelNodes.map((n) => {
              const isLeaf = !n.pair;
              const p1 = n.players && n.players[0] ? getName(t, n.players[0]) : null;
              const p2 = n.players && n.players[1] ? getName(t, n.players[1]) : null;
              const mine = n.matchId && n.players && n.players.includes(myId);
              const inMatch = n.matchId && n.players;
              const winnerName = n.winnerId ? getName(t, n.winnerId) : null;
              let body = '';
              if (winnerName) {
                body = `<div class="p winner">${esc(winnerName)} 晋级</div>`;
              } else if (inMatch) {
                const enter = mine
                  ? `<a class="btn btn-primary btn-sm" href="play.html?room=${n.matchId}&join=1" style="margin-top:6px;">进入对局</a>`
                  : `<div style="font-size:11px;color:var(--gold-light);margin-top:6px;">对局进行中</div>`;
                body = `<div class="p">${esc(p1 || '?')} vs ${esc(p2 || '?')}</div>${enter}`;
              } else if (isLeaf && n.name) {
                body = `<div class="p" ${n.playerId ? `data-player-id="${esc(n.playerId)}"` : ''}>${esc(n.name)}</div>`;
              } else {
                body = `<div class="p" style="color:var(--text-dim);">待定</div>`;
              }
              return `<div class="bracket-match" style="${n.winnerId ? 'border-color:var(--gold);' : ''}">${body}</div>`;
            }).join('')}
          </div>
        `).join('')}
      </div>
    `;
  }

  window.joinTournament = (id) => {
    api.send({ type: 'join_tournament', data: { id } });
  };

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  loadTournaments();
  setInterval(loadTournaments, 5000);  // 轮询：检测新对局安排/对阵推进
})();
