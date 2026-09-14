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

  // ==================================================================
  // 账号：会话令牌检测（令牌以 '.' 分隔，游客 id 为 24 hex）
  // ==================================================================
  const SESSION_KEY = 'tdshogi_session_token';
  const isLoggedIn = (id) => typeof id === 'string' && id.includes('.');
  const sessionToken = () => isLoggedIn(guest.id) ? guest.id : localStorage.getItem(SESSION_KEY);

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
      document.getElementById('accountAvatar').textContent = guest.name[0] || '棋';
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
      document.getElementById('createdAtLabel').textContent = new Date(a.createdAt).toLocaleDateString('zh-CN');
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
          ` · 📅 注册于 ${new Date(a.createdAt).toLocaleDateString('zh-CN')}`;
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
  document.getElementById('avatar').textContent = guest.name[0] || '棋';
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
    document.getElementById('avatar').textContent = data.name[0];
    toast('改名成功');
  });
  api.on('error', (data) => {
    if (data && data.message) toast(data.message);
  });

  // 加载个人数据（账号令牌 → 解析账号 id 查询）
  async function loadProfile() {
    try {
      const pid = isLoggedIn(guest.id) ? guest.id.split('.')[0] : guest.id;
      const data = await window.ApiUtils.get(`/api/profile?player=${encodeURIComponent(pid)}`);
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
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${(r.moves || []).length} 手 · ${new Date(r.createdAt).toLocaleString('zh-CN')}</div>
        </div>
      `;
    }).join('');
  }

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  loadProfile();
})();
