/**
 * profile.js — 个人页：账号注册/登录、改名、评级与战绩统计、ELO 走势、最近对局
 */
(function () {
  window.NAV.renderNav('profile');
  let guest = window.NAV.getGuest();
  const api = window.API;
  api.connect(guest.id);

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }
  /** 翻译（PLAN §Z5）：`i18n.js` 万一没加载就原样显示中文 */
  const tr = (s, v) => (window.I18N ? window.I18N.t(s, v) : s);

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
  // ==================================================================
  const viewPlayerId = new URLSearchParams(location.search).get('player');
  const myId = isLoggedIn(guest.id) ? guest.id.split('.')[0] : guest.id;
  const isSelf = !viewPlayerId || viewPlayerId === myId || viewPlayerId === guest.id;
  const viewedId = isSelf ? myId : viewPlayerId;

  // 已登录状态渲染（gate 只看当前页身份 guest.id 是否为账号令牌——
  // 不读共享存储里的旧令牌，避免「本标签是游客却显示账号资料卡」）
  function renderAccountUI() {
    const logged = isLoggedIn(guest.id);
    document.getElementById('accountNotLogged').style.display = logged ? 'none' : 'block';
    document.getElementById('accountLogged').style.display = logged ? 'flex' : 'none';
    document.getElementById('myProfileCard').style.display = logged ? 'block' : 'none';
    // 账号登录后隐藏游客改名区（账号名由注册决定）
    const renameWrap = document.querySelector('.profile-head input, .profile-head #btnRename')?.closest('div');
    if (renameWrap) renameWrap.style.display = logged ? 'none' : 'flex';
    if (logged) {
      document.getElementById('accountName').textContent = guest.name;
      document.getElementById('accountId').textContent = guest.id.split('.')[0];
      renderAvatars(); // 头像（2026-09-20）：统一走这一处，别再直接写 textContent
      document.getElementById('pRoleLabel').innerHTML = '正式账号 · ID: <span id="pId"></span>';
      document.getElementById('pId').textContent = guest.id.split('.')[0];
      loadMyProfile();
    }
  }

  // ---- 我的资料（PLAN §F：手机号私密/棋风/注册日期） ----
  async function loadMyProfile() {
    try {
      const data = await window.ApiUtils.get(`/api/account/profile?token=${encodeURIComponent(sessionToken())}`);
      const a = data.account;
      if (!a) return;
      document.getElementById('editPhone').value = a.profile.phone || '';
      document.getElementById('editStyle').value = a.profile.style || '不设定';
      document.getElementById('createdAtLabel').textContent = I18N.fmtDate(a.createdAt);
      // 身份卡补充棋风与注册日期
      const role = document.getElementById('pRoleLabel');
      if (role && !document.getElementById('profileMeta')) {
        const meta = document.createElement('div');
        meta.id = 'profileMeta';
        meta.style.cssText = 'font-size:12px;color:var(--text-dim);margin-top:6px;';
        role.parentNode.insertBefore(meta, role.nextSibling);
      }
      const meta = document.getElementById('profileMeta');
      if (meta) {
        meta.innerHTML = `⚔️ 棋风：<span style="color:var(--gold-light);">${esc(a.profile.style || '不设定')}</span>` +
          ` · 📅 注册于 ${I18N.fmtDate(a.createdAt)}`;
      }
    } catch (_) { /* 令牌失效等情况静默 */ }
  }

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  document.getElementById('btnSaveProfile').addEventListener('click', async () => {
    const phone = document.getElementById('editPhone').value.trim();
    const style = document.getElementById('editStyle').value;
    try {
      const res = await window.ApiUtils.post('/api/account/profile', {
        token: sessionToken(),
        phone,
        style,
      });
      if (res.ok) {
        toast('资料已保存');
        loadMyProfile();
      } else {
        toast(res.error || '保存失败');
      }
    } catch (e) {
      toast('保存失败，请重试');
    }
  });

  function applySession(token, name) {
    localStorage.setItem(SESSION_KEY, token);
    guest = { id: token, name };
    window.NAV.saveGuest(guest);
    renderAccountUI();
    // 用令牌重连 WS，使对局/评级绑定账号
    location.reload();
  }

  // ---- 注册 ----
  document.getElementById('btnRegister').addEventListener('click', async () => {
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;
    const password2 = document.getElementById('regPassword2').value;
    if (!username || !password) return toast('请填写用户名和密码');
    if (password !== password2) return toast('两次输入的密码不一致');
    try {
      const res = await window.ApiUtils.post('/api/register', {
        username, password,
        guestId: isLoggedIn(guest.id) ? null : guest.id, // 游客升级：迁移数据
      });
      if (res.ok) {
        toast(`注册成功，欢迎 ${res.account.username}！`);
        applySession(res.token, res.account.username);
      } else {
        toast(res.error || '注册失败');
      }
    } catch (e) { toast('注册失败，请重试'); }
  });

  // ---- 登录 ----
  document.getElementById('btnLogin').addEventListener('click', async () => {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) return toast('请填写用户名和密码');
    try {
      const res = await window.ApiUtils.post('/api/login', { username, password });
      if (res.ok) {
        toast(`欢迎回来，${res.account.username}！`);
        applySession(res.token, res.account.username);
      } else {
        toast(res.error || '登录失败');
      }
    } catch (e) { toast('登录失败，请重试'); }
  });

  // ---- 登出 ----
  document.getElementById('btnLogout').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    // 重置为新的游客身份
    const fresh = { id: window.NAV.genId(), name: window.NAV.randomName() };
    window.NAV.saveGuest(fresh);
    toast('已退出登录');
    location.reload();
  });

  document.getElementById('pName').textContent = guest.name;
  document.getElementById('pId').textContent = isLoggedIn(guest.id) ? guest.id.split('.')[0] : guest.id;

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

  /** 把字形写进两个头像位（账号卡 + 身份卡） */
  function paintAvatar(glyph) {
    for (const id of ['avatar', 'accountAvatar']) {
      const el = document.getElementById(id);
      if (el) el.textContent = glyph;
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
    paintAvatar(window.UI.avatarGlyph(myAvatar, guest.name));
  }

  function renderAvatarOptions() {
    const box = document.getElementById('avatarOptions');
    if (!box) return;
    const list = api.avatars || [];
    if (!list.length) return; // 白名单还没到（hello 未回）：宁可为空，也别画一份猜的
    box.innerHTML = list.map((a) => {
      const on = a === myAvatar ? ' avatar-pick-on' : '';
      return `<button type="button" class="avatar-pick${on}" data-avatar="${esc(a)}">${esc(a)}</button>`;
    }).join('');
  }

  function togglePicker() {
    const p = document.getElementById('avatarPicker');
    if (!p) return;
    p.style.display = p.style.display === 'none' ? '' : 'none';
  }

  document.getElementById('btnPickAvatar').addEventListener('click', togglePicker);
  // ⚠️ 身份卡上的大头像**也**带着换头像入口，只读视图必须拦住：
  // `setupViewMode()` 藏的是按钮与选择器本身，而点这个头像能把选择器**重新打开** ——
  // 这正是用户看到"我能改别人头像"的那个入口（2026-09-20 修）。
  document.getElementById('avatar').addEventListener('click', () => { if (isSelf) togglePicker(); });
  document.getElementById('avatarOptions').addEventListener('click', (e) => {
    if (!isSelf) return; // 只读视图：双保险，连消息都不发（真正改的其实是我自己）
    const b = e.target.closest('.avatar-pick');
    if (!b) return;
    api.send({ type: 'set_avatar', data: { avatar: b.getAttribute('data-avatar') } });
  });
  api.on('hello', (d) => {
    if (!d) return;
    if (d.avatar) myAvatar = d.avatar;
    renderAvatars();
    renderAvatarOptions();
  });
  api.on('avatar_updated', (d) => {
    if (!d || !d.avatar) return;
    myAvatar = d.avatar;
    renderAvatars();
    renderAvatarOptions();
    if (window.NAV && window.NAV.updateAvatar) window.NAV.updateAvatar(d.avatar);
    toast('头像已更新');
  });

  // 放在头像块之后：`renderAccountUI()` 会经 `renderAvatars()` 读 `myAvatar`
  renderAccountUI();

  // 改名
  document.getElementById('btnRename').addEventListener('click', () => {
    const name = document.getElementById('renameInput').value.trim();
    if (!name) return toast('请输入名字');
    api.send({ type: 'rename', data: { name } });
  });
  api.on('renamed', (data) => {
    guest.name = data.name;
    window.NAV.saveGuest(guest);
    document.getElementById('pName').textContent = data.name;
    renderAvatars(); // 名字变了，兜底字形（无头像时用名字首字）也要跟着变
    toast('改名成功');
  });
  api.on('error', (data) => {
    if (data && data.message) toast(data.message);
  });

  // 加载个人数据（账号令牌 → 解析账号 id 查询）
  async function loadProfile() {
    try {
      const data = await window.ApiUtils.get(`/api/profile?player=${encodeURIComponent(viewedId)}`);
      const p = data.profile;
      document.getElementById('pRating').textContent = p.rating;
      // 等级系统（PLAN §K7）：显示等级与当前经验，及距下一级的差额
      const lvEl = document.getElementById('pLevel');
      const expEl = document.getElementById('pExp');
      if (lvEl) lvEl.textContent = 'Lv.' + (p.level || 0);
      if (expEl) {
        const need = Math.pow(2, Math.min((p.level || 0) + 1, 64) + 1) - 2;
        expEl.textContent = p.level >= 64 ? `满级 · 经验 ${p.exp}` : `经验 ${p.exp} / ${need}`;
      }
      document.getElementById('sGames').textContent = p.games;
      document.getElementById('sWins').textContent = p.wins;
      document.getElementById('sLosses').textContent = p.losses;
      document.getElementById('sDraws').textContent = p.draws;
      renderEloChart(p.history || []);
      renderRecords(data.records || []);
      renderHonors(data.honors);
      if (!isSelf) {
        // 看别人时，头部显示的必须是被查看者的名字（页面初始渲染的是"我"的名字）
        const name = data.name || '无名棋士';
        // 头像同理：画**他**的字形（服务端下发 `avatar`；没有则按名字稳定派生一个）。
        // ⚠️ 这一步必须在 `renderAvatars()` 之外——后者只负责"我"的头像，且只读视图里直接返回。
        paintAvatar(window.UI.avatarGlyph(data.avatar, name));
        const nameEl = document.getElementById('pName');
        if (nameEl) nameEl.textContent = name;
        const barName = document.getElementById('viewedName');
        if (barName) barName.textContent = name;
        const roleEl = document.getElementById('pRoleLabel');
        if (roleEl) roleEl.textContent = tr('玩家 · ID: {id}', { id: viewedId });
      }
    } catch (e) {
      console.error(e);
    }
  }

  function renderEloChart(history) {
    const el = document.getElementById('eloChart');
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
    const statBox = document.getElementById('honorsStats');
    const listBox = document.getElementById('honorsList');
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
    const el = document.getElementById('recentRecords');
    if (!records.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无对局</div>';
      return;
    }
    // 只显示最近 10 局（2026-09-13 用户要求）：个人页是**概览**而非棋谱列表——
    // 想看全部请去棋谱页（那里有检索与分页）。全量铺开只会让页面很长且没人往下滚。
    // 这里自己按时间倒序再截取，**不依赖服务端返回顺序**（否则换个排序就悄悄显示成最旧的 10 局）。
    const list = records.slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 10);
    el.innerHTML = list.map((r) => {
      const names = r.names || ['先手', '後手'];
      const mineIsB = r.playerIds && r.playerIds.b === guest.id;
      const result = r.result === 'b' ? '先手胜' : r.result === 'w' ? '后手胜' : (r.resultDetail || '和棋');
      const iWon = mineIsB ? r.result === 'b' : r.result === 'w';
      const cls = iWon ? 'result-win' : 'result-lose';
      return `
        <div class="record-item" onclick="location.href='history.html'">
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
    for (const id of ['accountCard', 'myProfileCard', 'btnPickAvatar', 'avatarPicker', 'btnRename', 'renameInput']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // 身份卡的大头像：只读视图里要去掉"可点换头像"的样子（手型光标 + title 提示），
    // 否则用户仍会以为能改对方的头像（点了还会弹出选择器）。
    const face = document.getElementById('avatar');
    if (face) {
      face.style.cursor = 'default';
      face.removeAttribute('title');
    }
    const main = document.querySelector('main.container');
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

  setupViewMode();
  loadProfile();
})();
