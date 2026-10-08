/**
 * home.js — 首页逻辑：随机观战、平台数据条、系统公告、ELO 排行榜、最新对局战报
 */
(function () {
  const guest = window.NAV.renderNav('home');
  // 对局玩家 id：账号的 guest.id 是会话令牌，榜单/名单里存的是 accountId
  const myPlayerId = guest.id && String(guest.id).includes('.')
    ? String(guest.id).split('.')[0]
    : guest.id;

  // 初始化 WS
  const api = window.API;
  api.connect(guest.id);

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发，避免"抄多份、改一处漏九处"
  const $ = (id) => window.UI.$(id);
  function toast(msg) { return window.UI.toast(msg); }

  // 随机观战
  $('btnRandomWatch').addEventListener('click', () => {
    api.send({ type: 'random_spectate' });
  });
  api.on('spectating', (data) => {
    location.href = `play.html?room=${data.roomId}&spectate=1`;
  });
  api.on('error', (data) => {
    if (data && data.message) toast(data.message);
  });

  // 加载首页数据（5s 轮询：数据条/公告/排行/战报）
  async function loadHome() {
    try {
      const data = await window.ApiUtils.get('/api/home');
      renderStats(data.stats, data.recordsTotal);
      renderAnnouncements(data.announcements);
      renderLeaderboard(data.leaderboard, myPlayerId);
      renderRecent(data.recentBattles || []);
    } catch (e) {
      console.error('load home failed', e);
    }
  }

  // ---- 平台数据条 ----
  function renderStats(stats, recordsTotal) {
    const s = stats || {};
    $('statOnline').textContent = s.online != null ? s.online : '–';
    $('statPlaying').textContent = s.playing != null ? s.playing : '–';
    // 等待对局 = 房间等待中 + 匹配队列中
    $('statWaiting').textContent = (s.waiting || 0) + (s.matching || 0);
    $('statReviewing').textContent = s.reviewing != null ? s.reviewing : '–';
    $('statRecords').textContent = recordsTotal != null ? recordsTotal : '–';
  }

  // ---- 公告 ----
  function renderAnnouncements(list) {
    const el = $('announcements');
    if (!list || !list.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无公告</div>';
      return;
    }
    el.innerHTML = list.slice(0, 5).map((a) => `
      <div class="announce-card">
        <div class="announce-title">${esc(a.title)}</div>
        <div class="announce-content">${esc(a.content)}</div>
        <div class="announce-date">${I18N.fmtDate(a.createdAt)}</div>
      </div>
    `).join('');
  }

  // ---- ELO 排行榜 ----
  function renderLeaderboard(lb, myId) {
    const el = $('leaderboard');
    const list = lb.list || [];
    if (!list.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无对局记录</div>';
      return;
    }
    el.innerHTML = list.map((r, i) => `
      <div class="rank-row ${r.id === myId ? 'self' : ''}">
        <span class="rank-no ${i < 3 ? `top${i + 1}` : ''}">${i + 1}</span>
        <span class="rank-name" data-player-id="${esc(r.id)}">${esc(r.id === myId ? '我 (' + (guest.name) + ')' : r.name || r.id)}</span>
        <span class="rank-rating">${r.rating}</span>
      </div>
    `).join('');
    if (lb.self && !list.find((r) => r.id === myId)) {
      el.insertAdjacentHTML('beforeend', `
        <div class="rank-row self">
          <span class="rank-no">${lb.self.rank}</span>
          <span class="rank-name">我 (${esc(guest.name)})</span>
          <span class="rank-rating">${lb.self.rating}</span>
        </div>
      `);
    }
  }

  // ---- 最新对局战报 ----
  function renderRecent(list) {
    const el = $('recentBattles');
    if (!list.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">还没有完成的对局 —— 第一局就等你来下！</div>';
      return;
    }
    el.innerHTML = list.map((r) => {
      const names = r.names && r.names.length === 2 ? r.names : ['先手', '後手'];
      let resText;
      if (r.result === 'b') resText = `${names[0]} 胜`;
      else if (r.result === 'w') resText = `${names[1]} 胜`;
      else resText = r.resultDetail || '和棋';
      return `
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
            <span>
              <span data-player-id="${esc((r.playerIds && r.playerIds.b) || '')}">${esc(names[0])}</span>
              vs
              <span data-player-id="${esc((r.playerIds && r.playerIds.w) || '')}">${esc(names[1])}</span>
            </span>
            ${r.rated ? '<span style="font-size:11px;color:var(--gold-light);">ELO 战</span>' : ''}
          </div>
          <div class="r-result result-win">${esc(resText)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${r.moveCount} 手 · ${I18N.fmt(r.createdAt)} · 点击复盘 →</div>
        </div>
      `;
    }).join('');
  }

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  loadHome();
  setInterval(loadHome, 5000);  // 数据条/排行/公告/战报定时刷新
})();
