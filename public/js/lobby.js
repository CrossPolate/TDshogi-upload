/**
 * lobby.js — 对战页逻辑：快速匹配、创建/加入房间、观战列表
 */
(function () {
  const guest = window.NAV.renderNav('lobby');
  const api = window.API;
  api.connect(guest.id);

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }

  // ---- 快速匹配 ----
  document.getElementById('btnQuickMatch').addEventListener('click', () => {
    api.send({ type: 'quick_match' });
    document.getElementById('matchControls').style.display = 'none';
    document.getElementById('matchWait').classList.add('show');
  });
  document.getElementById('btnCancelMatch').addEventListener('click', () => {
    api.send({ type: 'cancel_match' });
    document.getElementById('matchWait').classList.remove('show');
    document.getElementById('matchControls').style.display = 'block';
  });

  // ---- 创建房间 ----
  // 私人房间（PLAN §T2）：休闲模式（不计 ELO，经验照常加）+ 可选密码；
  // 勾选后才显示密码框，密码留空 = 不设门禁（只是休闲局）
  let lastCreatedPrivate = false;
  document.getElementById('roomPrivate').addEventListener('change', (e) => {
    document.getElementById('roomPasswordWrap').style.display = e.target.checked ? 'block' : 'none';
  });
  document.getElementById('btnCreateRoom').addEventListener('click', () => {
    const timeControl = document.getElementById('roomTimeControl').value || '10:00';
    const isPrivate = document.getElementById('roomPrivate').checked;
    const password = document.getElementById('roomPassword').value.trim();
    if (isPrivate && password && (password.length < 4 || password.length > 8)) {
      return toast('房间密码需 4-8 位');
    }
    lastCreatedPrivate = isPrivate;
    api.send({ type: 'create_room', data: { timeControl, isPrivate, password } });
  });

  // ---- 加入房间 ----
  document.getElementById('btnJoinRoom').addEventListener('click', () => {
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入 6 位有效房间码');
    const password = document.getElementById('joinPassword').value.trim();
    api.send({ type: 'join_room', data: { code, password } });
  });

  // ---- 凭房间码观战（PLAN §T2）----
  // 私人房：房间码 + 密码 = 房主的邀请；赛事房/普通房：直接进
  document.getElementById('btnSpectateRoom').addEventListener('click', () => {
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入 6 位有效房间码');
    const password = document.getElementById('joinPassword').value.trim();
    // 密码必须随「跳到 play 页的那个新连接」一起过去（授权不跨连接）。
    // 放 sessionStorage 而非 URL：避免密码留在浏览器历史与服务端访问日志里。
    if (password) window.sessionStorage.setItem('tdshogi_spectate_pw', password);
    else window.sessionStorage.removeItem('tdshogi_spectate_pw');
    api.send({ type: 'spectate', data: { code, password } });
  });
  // 回车直接加入（房间码 / 密码框内均可）
  ['joinCode', 'joinPassword'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnJoinRoom').click();
    });
  });

  // ---- WS 事件 ----
  api.on('room_created', (data) => {
    document.getElementById('roomCode').textContent = data.code;
    document.getElementById('roomCreated').style.display = 'block';
    toast(lastCreatedPrivate
      ? '私人房间已创建，把房间码与密码发给好友'
      : '房间已创建，等待对手加入');
  });
  api.on('room_joined', (data) => {
    toast('加入成功，对局开始！');
    setTimeout(() => (location.href = `play.html?room=${data.roomId}`), 400);
  });
  api.on('matched', (data) => {
    toast('匹配成功！对局开始');
    setTimeout(() => (location.href = `play.html?room=${data.roomId}`), 400);
  });
  api.on('game_start', (data) => {
    if (location.search.includes('room')) return;
    location.href = `play.html?room=${data.roomId}`;
  });
  api.on('spectating', (data) => {
    location.href = `play.html?room=${data.roomId}`;
  });
  api.on('error', (data) => {
    if (!data || !data.message) return;
    toast(data.message);
    // 私人房间需要密码（PLAN §T2）：服务端回的是**结构化标志** → 亮出密码框并聚焦。
    // 比弹 prompt() 好：不打断操作，移动端也不会被浏览器拦截。
    if (data.needPassword) {
      document.getElementById('joinPasswordWrap').style.display = 'block';
      document.getElementById('joinPassword').focus();
    }
    if (data.message.includes('匹配')) {
      document.getElementById('matchWait').classList.remove('show');
      document.getElementById('matchControls').style.display = 'block';
    }
  });

  // ---- 观战列表 ----
  async function loadGames() {
    try {
      const data = await window.ApiUtils.get('/api/lobby');
      renderGames(data.games);
    } catch (e) { console.error(e); }
  }
  function renderGames(games) {
    const el = document.getElementById('activeGames');
    if (!games || !games.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">当前没有进行中的对局</div>';
      return;
    }
    // §R4 热门优先：观众多的排前面（Array.sort 稳定，同人数保持服务端原序）。
    // 注意：渲染与点击绑定必须共用同一个数组（list），否则点击会张冠李戴。
    const list = [...games].sort((a, b) => (b.spectatorCount || 0) - (a.spectatorCount || 0));
    // 显示房间码 + 对局类型 + 走子数 + 观战人数，便于区分重名玩家；名字带悬停信息卡
    el.innerHTML = list.map((g) => {
      const typeName = g.type === 'reviewing' ? '🎤 复盘中' : g.type === 'quick' ? '快速匹配' : g.type === 'tournament' ? '赛事' : '房间对局';
      const pid = g.playerIds || {};
      const sc = g.spectatorCount || 0;
      const spec = sc > 0 ? ` · 👁 <b style="color:var(--gold-light);">${sc}</b> 人观战` : ' · 观战';
      return `
      <div class="game-card" data-room="${esc(g.roomId)}">
        <div class="players">
          <span data-player-id="${esc(pid.b || '')}">${esc(g.players.b || '先手')}</span>
          <span class="vs">vs</span>
          <span data-player-id="${esc(pid.w || '')}">${esc(g.players.w || '後手')}</span>
        </div>
        <div class="meta">房间 ${esc(g.code)} · ${typeName} · ${g.moveCount} 手${spec}</div>
      </div>
    `;
    }).join('');
    // 点击卡片进入对局：自己是该局选手 → 不带 spectate（走 request_state 由服务端按
    // playerId 回位到选手座位）；否则才以观战身份进入。playerId 在 hello 时由服务端下发。
    el.querySelectorAll('.game-card').forEach((card, i) => {
      const g = list[i];
      card.addEventListener('click', () => {
        const mine = api.playerId && g.playerIds && (g.playerIds.b === api.playerId || g.playerIds.w === api.playerId);
        location.href = `play.html?room=${encodeURIComponent(g.roomId)}${mine ? '' : '&spectate=1'}`;
      });
    });
  }
  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  loadGames();
  setInterval(loadGames, 5000);
})();
