/**
 * admin.js — 管理后台：管理员登录、查看全部棋谱与用户数据
 */
(function () {
  const guest = window.NAV.renderNav(null);
  const ADMIN_KEY = 'tdshogi_admin_token';
  const api = window.API;
  api.connect(guest.id);

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }

  function getToken() {
    return localStorage.getItem(ADMIN_KEY);
  }
  function setToken(t) {
    if (t) localStorage.setItem(ADMIN_KEY, t);
    else localStorage.removeItem(ADMIN_KEY);
  }

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  /**
   * IP 掩码（PLAN §U6）：后台**默认**只显示到网段，点击才展开完整地址。
   *
   * 原始 IP 属隐私数据，后台又是最容易被截图的页面——
   * 默认掩码能挡掉"随手截图外流"这类低级泄露，同时不影响管理员排查（点一下就能看全）。
   */
  function maskIp(ip) {
    const s = String(ip || '');
    if (!s) return '';
    if (s.includes(':')) {                            // IPv6：保留前两组
      return s.split(':').slice(0, 2).join(':') + ':*';
    }
    const seg = s.split('.');
    if (seg.length === 4) return `${seg[0]}.${seg[1]}.${seg[2]}.*`;
    return s;                                         // 非预期格式：原样返回（显示出来总比留空好）
  }

  // ==================================================================
  // 分页（PLAN §W1 / 需求 13）：后台每个列表最多显示 20 条
  // ==================================================================
  const PAGE_SIZE = 20;
  // 各列表的当前页。赛事那三个（待审核/进行中/历史）也在这里，**不要再另起一个 tnPages**
  // ——两套页码状态并存时，翻页行为会出现"这个列表记住了、那个列表没记住"的怪象（2026-09-14 归并）。
  const pages = {
    records: 1, users: 1, audit: 1, tournaments: 1,
    tnPending: 1, tnActive: 1, tnHistory: 1, ipbans: 1, announcements: 1, reports: 1,
  };

  /**
   * 把"全量数据 → 列表渲染"包成分页渲染。
   *
   * **四个 tab 共用这一个函数**——同一份翻页逻辑抄四遍，迟早只改三处。
   * 刻意做成"包裹"而不是改各 render 函数内部：这样 render 只管画一页，
   * 分页状态集中在这里，两边职责不混。
   * 服务端目前仍全量下发；真到十万级数据时再改服务端分页，那时也只需动这一处。
   *
   * @param {string} key         tab 标识（用来记当前页码）
   * @param {Array}  items       全量数据
   * @param {string} pagerElId   分页条容器 id
   * @param {(slice:Array)=>void} render 只负责渲染传入的这一页
   * @param {boolean} [reset]    数据来源变了（如搜索）→ 回到第 1 页
   */
  function renderPaged(key, items, pagerElId, render, reset) {
    if (reset) pages[key] = 1;
    // 统一到 `UI.paginate`（2026-09-14）：admin 原先自己实现了一份分页条，
    // 与前台三处 + 赛事详情页那份并存——两边的按钮风格与边界行为（单页时显不显"共 N 条"、
    // 页码越界怎么夹）迟早会不一致。现在这里只是它的薄封装，只负责"用已有 items 重画"。
    const pg = window.UI.paginate({
      items,
      page: pages[key],
      size: PAGE_SIZE,
      container: pagerElId,
      onPage: (n) => window.adminPage(key, n), // 翻页走统一入口（会重拉数据，保持与刷新一致）
    });
    pages[key] = pg.page; // 页码被夹回时同步回来，避免停在空页
    render(pg.slice);
  }

  /** 翻页：更新页码后重跑该 tab 的加载（保持与刷新一致的数据来源） */
  window.adminPage = function (key, page) {
    pages[key] = page;
    if (key === 'records') loadRecords();
    else if (key === 'users') loadUsers();
    else if (key === 'audit') loadAudit();
    else if (key === 'tournaments') loadTournaments();
    else if (key === 'ipbans') loadIpBans();
    else if (key === 'announcements') loadAnnouncements();
    else if (key === 'reports') loadReports();
  };

  // 初始化：检测是否已登录
  function initUI() {
    const isAdmin = !!getToken();
    document.getElementById('adminLoginCard').style.display = isAdmin ? 'none' : 'block';
    document.getElementById('adminPanel').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('btnAdminLogout').style.display = isAdmin ? 'inline-block' : 'none';
    if (isAdmin) {
      // 只加载默认 tab（总览）。其余 tab 切过去再拉——
      // 原先进后台会把四个重查询（棋谱/用户/赛事/审计）全跑一遍，首屏白等很久，
      // 而多数时候管理员只看其中一两个。
      loadOverview();
    }
  }

  // ---- 登录 / 登出 ----
  document.getElementById('btnAdminLogin').addEventListener('click', () => {
    const password = document.getElementById('adminPassword').value;
    if (!password) return toast('请输入管理密码');
    api.send({ type: 'admin_login', data: { password } });
  });
  api.on('admin_logged_in', (data) => {
    setToken(data.token);
    toast('管理员登录成功');
    initUI();
    window.NAV.renderNav(null); // 重渲染导航：登录后显示管理入口（PLAN §J5）
  });
  api.on('error', (data) => {
    if (data && data.message) toast(data.message);
  });
  document.getElementById('btnAdminLogout').addEventListener('click', () => {
    setToken(null);
    toast('已退出管理员');
    initUI();
    window.NAV.renderNav(null); // 重渲染导航：登出后隐藏管理入口（PLAN §J5）
  });

  // ---- 标签切换 ----
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.classList.toggle('btn-ghost', b !== btn);
      });
      ['overview', 'records', 'users', 'tournaments', 'announcements', 'audit', 'ipbans'].forEach((t) => {
        const el = document.getElementById('tab-' + t);
        if (el) el.style.display = t === btn.dataset.tab ? 'block' : 'none';
      });
      // 切到该 tab 才拉数据（避免进后台就把所有接口白跑一遍）
      if (btn.dataset.tab === 'ipbans') loadIpBans();
      else if (btn.dataset.tab === 'announcements') loadAnnouncements();
      else if (btn.dataset.tab === 'rooms') loadRooms();
      else if (btn.dataset.tab === 'overview') loadOverview();
      else if (btn.dataset.tab === 'records') loadRecords();
      else if (btn.dataset.tab === 'users') loadUsers();
      else if (btn.dataset.tab === 'tournaments') loadTournaments();
      else if (btn.dataset.tab === 'audit') loadAudit();
      else if (btn.dataset.tab === 'reports') loadReports();
    });
  });

  // ---- 导入 KIF ----
  document.getElementById('btnImportKif').addEventListener('click', () => {
    document.getElementById('kifFileInput').click();
  });
  document.getElementById('kifFileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let okCount = 0, failCount = 0;
    const resultEl = document.getElementById('importResult');
    resultEl.textContent = `正在导入 ${files.length} 个棋谱...`;
    for (const file of files) {
      const text = await file.text();
      try {
        const res = await fetch('/api/admin/records/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (res.ok && data.ok) okCount++;
        else failCount++;
      } catch (_) { failCount++; }
    }
    resultEl.textContent = `导入完成：成功 ${okCount}，失败 ${failCount}`;
    e.target.value = '';
    loadRecords();
    if (failCount === 0 && okCount > 0) toast(`成功导入 ${okCount} 个棋谱`);
    else if (failCount > 0) toast(`导入完成：${okCount} 成功 / ${failCount} 失败`);
  });

  // ---- 全部棋谱 ----
  let allRecords = [];
  async function loadRecords() {
    try {
      const data = await window.ApiUtils.get(`/api/history?adminToken=${encodeURIComponent(getToken())}`);
      allRecords = data.records || [];
      renderPaged('records', allRecords, 'recordPager', renderRecords);
    } catch (e) {
      // token 失效则回到登录
      if (e.message && e.message.includes('403')) setToken(null);
      toast('加载棋谱失败');
      initUI();
    }
  }

  function renderRecords(records) {
    document.getElementById('recordCount').textContent = records.length;
    const el = document.getElementById('adminRecordList');
    if (!records.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无棋谱</div>';
      return;
    }
    el.innerHTML = records.map((r) => {
      const names = r.names || ['先手', '後手'];
      const res = r.result === 'b' ? `${names[0]} 胜` : r.result === 'w' ? `${names[1]} 胜` : (r.resultDetail || '和棋');
      return `
        <div class="record-item">
          <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])} <span style="color:var(--text-dim);font-size:11px;">（${r.moveCount || 0}手）</span></div>
          <div class="r-result result-win">${esc(res)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${I18N.fmt(r.createdAt)}</div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button class="btn btn-ghost btn-sm" data-act="rb-playback" data-id="${esc(r.id)}">回放</button>
            <button class="btn btn-ghost btn-sm" data-act="rb-export" data-id="${esc(r.id)}" data-fmt="kif">KIF</button>
            <button class="btn btn-ghost btn-sm" data-act="rb-export" data-id="${esc(r.id)}" data-fmt="csa">CSA</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 回放/导出必须携带管理员 token（否则 403）
  window.adminPlayback = (id) => {
    location.href = `review.html?id=${id}&adminToken=${encodeURIComponent(getToken() || '')}`;
  };
  window.adminExport = (id, fmt) => {
    location.href = `/api/records/${id}/export?fmt=${fmt}&token=${encodeURIComponent(getToken() || '')}`;
  };

  // 棋谱搜索（按选手名/ID）
  document.getElementById('recordSearch').addEventListener('input', (e) => {
    const q = (e.target.value || '').trim().toLowerCase();
    if (!q) return renderPaged('records', allRecords, 'recordPager', renderRecords, true);
    renderPaged('records', allRecords.filter((r) => {
      const names = (r.names || []).join(' ').toLowerCase();
      const ids = [r.playerIds && r.playerIds.b, r.playerIds && r.playerIds.w].filter(Boolean).join(' ').toLowerCase();
      return names.includes(q) || ids.includes(q);
    }), 'recordPager', renderRecords, true);
  });

  // ---- 全部用户 ----
  let allUsers = [];
  async function loadUsers() {
    try {
      const data = await window.ApiUtils.get(`/api/admin/users?token=${encodeURIComponent(getToken())}`);
      allUsers = data.users || [];
      renderPaged('users', allUsers, 'userPager', renderUsers);
    } catch (e) {
      if (e.message && e.message.includes('403')) setToken(null);
      initUI();
    }
  }

  function renderUsers(users) {
    document.getElementById('userCount').textContent = users.length;
    const el = document.getElementById('adminUserList');
    if (!users.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无用户</div>';
      return;
    }
    el.innerHTML = users.map((u) => `
      <div class="record-item">
        <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
          <span>${u.isAccount ? '<span title="正式账号">🔐</span>' : '<span title="游客">👤</span>'} ${esc(u.name)}${u.title ? `（${esc(u.title)}）` : ''} <span style="color:var(--text-dim);font-size:11px;">(${u.id})</span></span>
          <span style="font-size:11px;">${u.banned ? '<span style="color:var(--red-light);">⛔ 封禁中</span>' : ''}</span>
        </div>
        <div class="r-result result-win">Lv.${u.level || 0} · ELO ${u.rating}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${u.games} 局 · 胜 ${u.wins} / 负 ${u.losses} / 平 ${u.draws} · 胜率 ${u.winRate}% · 经验 ${u.exp || 0}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">🌐 最近 IP：${u.lastIp ? `<span title="点击展开完整 IP" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="reveal-ip" data-text="${esc(u.lastIp)}">${esc(maskIp(u.lastIp))}</span>` : '—'}${u.lastSeen ? ` · <span title="最后活跃时间">${I18N.fmt(u.lastSeen)}</span>` : ''}</div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="btn btn-ghost btn-sm" data-act="user-view" data-id="${esc(u.id)}">查看详情</button>
          ${u.banned
            ? `<button class="btn btn-ghost btn-sm" data-act="user-unban" data-id="${esc(u.id)}" data-name="${esc(u.name)}">解封</button>`
            : `<button class="btn btn-ghost btn-sm" data-act="user-ban" data-id="${esc(u.id)}" data-name="${esc(u.name)}">封禁</button>`}
        </div>
      </div>
    `).join('');
  }

  // 用户搜索
  document.getElementById('userSearch').addEventListener('input', (e) => {
    const q = (e.target.value || '').trim().toLowerCase();
    if (!q) return renderPaged('users', allUsers, 'userPager', renderUsers, true);
    renderPaged('users', allUsers.filter((u) =>
      (u.name || '').toLowerCase().includes(q) || (u.id || '').toLowerCase().includes(q)), 'userPager', renderUsers, true);
  });

  // ---- 用户详情 + 管理操作（PLAN §K4）----
  const STYLE_OPTIONS = ['不设定', '居飞车·急战', '居飞车·持久战', '振飞车', '力战型', '奇袭型', '接受型'];
  const VIEWED_ID = { v: null }; // 详情弹层当前用户（编辑资料保存时用）

  async function adminPost(path, body = {}, method = 'POST') {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    // 非 JSON 响应（如 404 HTML）多半是服务端没重启跑的旧代码——把状态码亮出来便于判断
    if (!res.ok || data.ok === false) {
      throw new Error((data && data.error) || `请求失败（HTTP ${res.status}，若为 404 请确认服务进程已重启）`);
    }
    return data;
  }

  const fmtTime = (ts) => (ts ? I18N.fmt(ts) : '—');

  window.viewUser = async (id) => {
    try {
      const data = await window.ApiUtils.get(`/api/admin/users/${id}?token=${encodeURIComponent(getToken())}`);
      VIEWED_ID.v = id;
      document.getElementById('detailUserName').textContent = data.title ? `${data.name}（${data.title}）` : data.name;
      const p = data.profile;
      const recs = data.records || [];
      const net = data.net || null;
      const banned = data.banned || null;
      const events = data.events || [];
      const styleOpts = STYLE_OPTIONS.map((s) =>
        `<option value="${s}" ${s === (data.style || '不设定') ? 'selected' : ''}>${s}</option>`).join('');
      document.getElementById('detailBody').innerHTML = `
        ${banned ? `<div style="background:rgba(176,58,46,0.15);border:1px solid var(--red-light);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;">
          ⛔ <b>封禁中</b>${banned.reason ? '：' + esc(banned.reason) : ''}${banned.until ? `（至 ${fmtTime(banned.until)}）` : '（永久）'}
        </div>` : ''}
        <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px;">
          <div class="card stat-card"><div class="num">${p.rating}</div><div class="label">ELO</div></div>
          <div class="card stat-card"><div class="num">${p.games}</div><div class="label">对局</div></div>
          <div class="card stat-card"><div class="num">${p.wins}</div><div class="label">胜</div></div>
          <div class="card stat-card"><div class="num">${p.losses}</div><div class="label">负</div></div>
        </div>
        ${data.phone ? `<div style="font-size:13px;margin-bottom:10px;">📱 手机号：<span style="color:var(--gold-light);">${esc(data.phone)}</span> <span style="color:var(--text-dim);font-size:11px;">（私密字段，仅管理员可见）</span></div>` : ''}
        <div style="font-size:14px;font-weight:700;margin:8px 0;">🌐 登录信息 <span style="font-size:11px;color:var(--text-dim);font-weight:400;">（隐私，仅管理员可见）</span></div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
          ${net
            ? `首次：${esc(net.firstIp || '—')}（${fmtTime(net.firstSeenAt)}）<br>最近：${esc(net.lastIp || '—')}（${fmtTime(net.lastSeenAt)}）<br>UA：${esc(net.lastUa || '—')}`
            : '暂无网络记录（旧会话或尚未连接过）'}
        </div>
        <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">✏️ 编辑资料</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:6px;">
          <div><div style="font-size:11px;color:var(--text-dim);">手机号（私密）</div>
            <input class="input" id="editPhone" value="${esc(data.phone || '')}" placeholder="11 位，留空清除" maxlength="11" style="width:150px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">棋风</div>
            <select class="input" id="editStyle" style="width:150px;">${styleOpts}</select></div>
          <div style="flex:1;min-width:200px;"><div style="font-size:11px;color:var(--text-dim);">用户称号（展示为「名称（称号）」，留空清除）</div>
            <input class="input" id="editTitle" value="${esc(data.title || '')}" maxlength="12" style="width:100%;"></div>
          <button class="btn btn-primary btn-sm" data-act="user-save-profile" data-id="${esc(id)}">保存资料</button>
        </div>
        <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">📊 等级与 ELO <span style="font-size:11px;color:var(--text-dim);font-weight:400;">（Lv.${p.level} · 经验 ${p.exp}；等级随经验自动推导）</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:6px;">
          <div><div style="font-size:11px;color:var(--text-dim);">ELO（100-5000）</div>
            <input class="input" id="editElo" value="${p.rating}" style="width:110px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">经验（≥0）</div>
            <input class="input" id="editExp" value="${p.exp || 0}" style="width:110px;"></div>
          <button class="btn btn-primary btn-sm" data-act="user-save-elo" data-id="${esc(id)}">保存 ELO/经验</button>
        </div>
        <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">🛠️ 管理操作</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          <button class="btn btn-ghost btn-sm" data-act="user-rename" data-id="${esc(id)}" data-name="${esc(data.name)}">✏️ 改名</button>
          <button class="btn btn-ghost btn-sm" data-act="user-reset-rating" data-id="${esc(id)}" data-name="${esc(data.name)}">♻️ 重置 ELO</button>
          <button class="btn btn-ghost btn-sm" data-act="user-reset-pwd" data-id="${esc(id)}" data-name="${esc(data.name)}">🔑 重置密码</button>
          ${banned
            ? `<button class="btn btn-primary btn-sm" data-act="user-unban" data-id="${esc(id)}" data-name="${esc(data.name)}">✅ 解封</button>`
            : `<button class="btn btn-ghost btn-sm" data-act="user-ban" data-id="${esc(id)}" data-name="${esc(data.name)}">⛔ 封禁</button>`}
          ${data.isAccount ? `<button class="btn btn-ghost btn-sm" data-act="user-delete" data-id="${esc(id)}" data-name="${esc(data.name)}" style="color:var(--red-light);">🗑 删除账号</button>` : ''}
        </div>
        <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">🕘 最近登录记录（${events.length}）</div>
        ${events.length ? `<div style="max-height:180px;overflow-y:auto;margin-bottom:10px;">${events.map((e) => `
          <div style="font-size:11px;padding:3px 0;border-bottom:1px solid rgba(128,128,128,0.12);color:var(--text-dim);">
            ${fmtTime(e.ts)} · <span style="color:var(--gold-light);">${esc(e.ip || '—')}</span> · ${esc(e.ua || '—')}
          </div>`).join('')}</div>` : '<div style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">暂无记录</div>'}
        <div style="font-size:14px;font-weight:700;margin:8px 0;">对局记录（${recs.length}）</div>
        ${recs.length ? recs.map((r) => {
          const names = r.names || ['先手', '後手'];
          const res = r.result === 'b' ? `${names[0]}胜` : r.result === 'w' ? `${names[1]}胜` : (r.resultDetail || '和棋');
          return `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,0.15);">${esc(names[0])} vs ${esc(names[1])} — ${esc(res)}（${r.moveCount || 0}手）</div>`;
        }).join('') : '<div style="color:var(--text-dim);font-size:12px;">暂无对局</div>'}
      `;
      document.getElementById('userDetailModal').style.display = 'flex';
    } catch (e) {
      toast('加载用户详情失败');
    }
  };

  window.adminSaveProfile = async (id) => {
    const phone = document.getElementById('editPhone').value.trim();
    const style = document.getElementById('editStyle').value;
    const title = document.getElementById('editTitle').value.trim();
    try {
      await adminPost(`/api/admin/users/${id}/profile`, { phone, style, title });
      toast('资料已保存');
      loadUsers(); window.viewUser(id);
    } catch (e) { toast(e.message); }
  };

  window.adminSaveElo = async (id) => {
    const rating = parseInt(document.getElementById('editElo').value, 10);
    const exp = parseInt(document.getElementById('editExp').value, 10);
    if (!Number.isFinite(rating) || !Number.isFinite(exp)) return toast('ELO 与经验需为整数');
    try {
      await adminPost(`/api/admin/users/${id}/elo`, { rating, exp });
      toast('ELO/经验已保存');
      loadUsers(); window.viewUser(id);
    } catch (e) { toast(e.message); }
  };

  window.adminRename = async (id, oldName) => {
    const name = prompt(`修改「${oldName}」的显示名（≤16 字，不改账号登录用户名）：`, oldName);
    if (name === null || !name.trim()) return;
    try {
      await adminPost(`/api/admin/users/${id}/rename`, { name: name.trim() });
      toast('已改名（对局内对手即时可见）');
      loadUsers(); window.viewUser(id);
    } catch (e) { toast(e.message); }
  };

  window.adminResetRating = async (id, name) => {
    if (!confirm(`确定重置「${name}」的 ELO 与战绩？不可恢复。`)) return;
    try {
      await adminPost(`/api/admin/users/${id}/reset-rating`, {});
      toast('已重置评级与战绩');
      loadUsers(); window.viewUser(id);
    } catch (e) { toast(e.message); }
  };

  window.adminResetPassword = async (id, name) => {
    if (!confirm(`确定重置「${name}」的密码？其全部已登录会话将被强制失效。`)) return;
    try {
      const r = await adminPost(`/api/admin/users/${id}/reset-password`, {});
      prompt('新密码（仅此一次显示，请转交用户）：', r.password || '');
      toast('密码已重置');
    } catch (e) { toast(e.message); }
  };

  window.adminBan = async (id, name) => {
    const reason = prompt(`封禁「${name}」的原因（可留空）：`);
    if (reason === null) return;
    const daysStr = prompt('封禁天数（留空或 0 = 永久）：', '');
    if (daysStr === null) return;
    const days = parseFloat(daysStr) || 0;
    if (!confirm(`确定封禁「${name}」${days > 0 ? days + ' 天' : '（永久）'}？该用户将被强制下线。`)) return;
    try {
      const r = await adminPost(`/api/admin/users/${id}/ban`, { reason, days });
      toast(`已封禁${r.kicked ? `（踢下线 ${r.kicked} 个连接）` : ''}`);
      loadUsers(); window.viewUser(id);
    } catch (e) { toast(e.message); }
  };

  window.adminUnban = async (id, name) => {
    if (!confirm(`确定解封「${name}」？`)) return;
    try {
      await adminPost(`/api/admin/users/${id}/unban`, {});
      toast('已解封');
      loadUsers(); window.viewUser(id);
    } catch (e) { toast(e.message); }
  };

  window.adminDeleteAccount = async (id, name) => {
    const c = prompt(`⚠️ 删除账号「${name}」不可恢复（棋谱保留、评级清空）。\n输入 DELETE 确认：`);
    if (c === null) return;
    if (c !== 'DELETE' && c !== name) return toast('确认输入不正确，未删除');
    try {
      await adminPost(`/api/admin/users/${id}`, { confirm: c }, 'DELETE');
      toast('账号已删除');
      document.getElementById('userDetailModal').style.display = 'none';
      loadUsers();
    } catch (e) { toast(e.message); }
  };

  // ---- 操作审计（PLAN §K4）----
  let allAudit = [];
  async function loadAudit() {
    try {
      const data = await window.ApiUtils.get(`/api/admin/audit?token=${encodeURIComponent(getToken())}`);
      allAudit = data.events || [];
      renderPaged('audit', allAudit, 'auditPager', renderAudit);
    } catch (e) {
      if (e.message && e.message.includes('403')) setToken(null);
    }
  }
  function renderAudit(events) {
    document.getElementById('auditCount').textContent = events.length;
    const el = document.getElementById('auditList');
    if (!events.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无管理员操作记录</div>';
      return;
    }
    el.innerHTML = events.map((e) => `
      <div class="record-item">
        <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
          <span>${esc(e.action)} ${e.targetId ? `<span style="color:var(--text-dim);font-size:11px;">→ ${esc(e.targetId)}</span>` : ''}</span>
          <span style="font-size:11px;color:${e.ok ? 'var(--green)' : 'var(--red-light)'};">${e.ok ? '成功' : '失败'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
          ${fmtTime(e.ts)} · 来源 IP：${esc(e.adminIp || '—')}${e.detail ? ` · ${esc(JSON.stringify(e.detail))}` : ''}
        </div>
      </div>
    `).join('');
  }

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
      const data = await window.ApiUtils.get(`/api/admin/tournaments?token=${encodeURIComponent(getToken())}`);
      allTournaments = data.tournaments || [];
      // 赛事 tab **刻意不分页**：它内部已按「待审核 / 进行中 / 历史」分三块渲染，
    // 整体切片会打乱这个分组（比如某页只剩"历史"没有"待审核"）。
    // 历史块自带 max-height + 滚动，赛事数量级也远小于棋谱/用户，暂不需要。
    renderTournaments(allTournaments);
    } catch (e) {
      if (e.message && e.message.includes('403')) setToken(null);
      initUI();
    }
  }

  /** 时间戳 → 本地短格式；空值显示「不限」（申请表允许不填时间） */
  function fmtTs(ts) {
    if (!ts) return '不限';
    return I18N.fmt(ts, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /** 已确认参赛人数：开赛后看 players，报名阶段看 entrants 里 approved 的数量 */
  function tnJoinedCount(t) {
    const s = t.status;
    if (s === 'playing' || s === 'finished' || s === 'archived') return t.playerCount || 0;
    return (t.entrants || []).filter((e) => e.status === 'approved').length;
  }

  function renderTournaments(list) {
    document.getElementById('tnCount').textContent = list.length;
    const pending = list.filter((t) => t.status === 'pending_approval');
    // ⚠️ T1 起「报名中」的状态名是 `registration`（旧的 `open` 由服务端出口映射过来）
    const active = list.filter((t) => t.status === 'registration' || t.status === 'playing');
    // T1 起多了 `archived`（已存档）——与 finished 同属历史
    const history = list.filter((t) => ['finished', 'archived', 'rejected', 'cancelled'].includes(t.status));
    document.getElementById('tnStats').textContent =
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
    const el = document.getElementById(listElId);
    if (!fullList.length) {
      el.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${emptyText}</div>`;
      window.UI.paginate({ items: [], container: pagerElId }); // 清掉上一次残留的分页条
      return;
    }
    const pg = window.UI.paginate({
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
        I18N.fmt(t.createdAt),
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
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast((data && data.error) || '操作失败');
        return false;
      }
      const suffix = action === 'cancel' && data.dissolvedMatches ? `（已解散 ${data.dissolvedMatches} 场对局）` : '';
      toast(action === 'approve' ? '已通过审核' : action === 'reject' ? '已拒绝' : `已取消${suffix}`);
      loadTournaments();
      return true;
    } catch (_) {
      toast('网络错误');
      return false;
    }
  }
  window.tnApprove = (id) => tnAction(id, 'approve');
  window.tnReject = (id) => {
    const reason = prompt('拒绝原因（可留空）：');
    if (reason === null) return;
    tnAction(id, 'reject', reason);
  };
  window.tnCancel = (id) => {
    const name = (allTournaments.find((t) => t.id === id) || {}).name || '';
    if (!confirm(`确定取消赛事「${name}」？进行中的对局将被解散。`)) return;
    const reason = prompt('取消原因（可留空）：');
    if (reason === null) return;
    tnAction(id, 'cancel', reason);
  };

  // 存档赛事（T6/需求 11）：复用 `tnAction`——同样是 `/api/admin/tournaments/:id/:action`
  // 的 POST + 审计落盘，没必要另写一份 fetch。
  window.tnArchive = (id) => {
    const name = (allTournaments.find((t) => t.id === id) || {}).name || '';
    if (!confirm(`确定存档赛事「${name}」？\n存档后主办人转为只读，仅管理员可继续编辑。`)) return;
    tnAction(id, 'archive');
  };

  // ==================================================================
  // IP 封禁（PLAN §X）
  //
  // ⚠️ 服务端会**再判一次"不能封自己"**（见 `src/http/routes/admin.js`）——
  // 前端这里只是提前提示，判定以后端为准（前端判定可被绕过）。
  // ==================================================================
  let allBans = [];
  let ipbMyIp = null;
  let ipbDurations = [];
  let ipbFormReady = false;

  async function loadIpBans() {
    try {
      const res = await fetch('/api/admin/ipbans', { headers: { 'x-admin-token': getToken() } });
      const data = await res.json();
      if (!res.ok) { toast((data && data.error) || '加载失败'); return; }
      allBans = data.bans || [];
      ipbMyIp = data.myIp || null;
      ipbDurations = data.durations || [];
      initIpBanForm();
      renderIpBans();
    } catch (e) { toast('加载失败：' + e.message); }
  }

  // ==================================================================
  // 举报处理（2026-09-20）
  // ==================================================================
  let allReports = [];
  // ⚠️ 声明必须在 `renderReports` 之前：虽然调用发生在加载完成之后、运行时踩不到 TDZ，
  // 但"先用后声明"读起来就像 bug，下一个改这里的人会先愣一下。
  let reportCategories = [];

  async function loadReports() {
    const status = document.getElementById('rpFilter').value;
    try {
      const res = await fetch(`/api/admin/reports?status=${encodeURIComponent(status)}`, {
        headers: { 'x-admin-token': getToken() },
      });
      const data = await res.json();
      if (!res.ok) { toast((data && data.error) || '加载失败'); return; }
      allReports = data.reports || [];
      reportCategories = data.categories || reportCategories;
      document.getElementById('rpPending').textContent = data.pending || 0;
      document.getElementById('rpCount').textContent = allReports.length;
      // 与其余 tab 一致走统一分页（PLAN §W1 / 需求 13：后台每个列表最多 20 条）。
      // ⚠️ 新加的 tab 容易漏掉这一步——列表一长就把整页撑爆，而"共 N 条"还显示着全量。
      renderPaged('reports', allReports, 'rpPager', renderReports);
    } catch (e) { toast('加载失败：' + e.message); }
  }

  /** @param {Array} slice 本页的举报（全量在 `allReports`） */
  function renderReports(slice) {
    const box = document.getElementById('rpList');
    if (!slice.length) {
      box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">没有符合条件的举报。</div>';
      return;
    }
    const catLabel = (id) => {
      const c = reportCategories.find((x) => x.id === id);
      return c ? c.label : id;
    };
    const statusMeta = {
      pending: ['🕐 待处理', 'var(--gold-light)'],
      handled: ['✅ 已处理', 'var(--text-dim)'],
      rejected: ['↩️ 已驳回', 'var(--text-dim)'],
    };
    box.innerHTML = slice.map((r) => {
      const st = statusMeta[r.status] || [r.status, 'var(--text-dim)'];
      const ops = r.status === 'pending'
        ? `<button class="btn btn-primary btn-sm" data-rp="handled" data-id="${esc(r.id)}">标记已处理</button>
           <button class="btn btn-ghost btn-sm" data-rp="rejected" data-id="${esc(r.id)}">驳回</button>`
        : '';
      const ctx = r.context && (r.context.roomId || r.context.recordId)
        ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">上下文：${
          [r.context.roomId ? `房间 ${esc(r.context.roomId)}` : '', r.context.recordId ? `棋谱 ${esc(r.context.recordId)}` : '']
            .filter(Boolean).join(' · ')}</div>`
        : '';
      return `
        <div class="record-item">
          <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
            <span><span data-player-id="${esc(r.targetId)}">${esc(r.targetName)}</span>
              <span style="color:var(--text-dim);font-size:12px;">被 ${esc(r.byName)} 举报</span></span>
            <span style="color:${st[1]};font-size:12px;">${st[0]}</span>
          </div>
          <div style="font-size:12px;margin-top:4px;">类别：${esc(catLabel(r.category))}${
  r.detail ? `<br>说明：${esc(r.detail)}` : ''}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${I18N.fmt(r.at)}</div>
          ${ctx}
          ${r.note ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">处理备注：${esc(r.note)}</div>` : ''}
          ${ops ? `<div style="display:flex;gap:6px;margin-top:8px;">${ops}</div>` : ''}
        </div>`;
    }).join('');
  }

  document.getElementById('btnRefreshReports').addEventListener('click', loadReports);
  // 换了筛选条件 = 数据来源变了 → 回到第 1 页（否则筛选后停在旧页码上会看到"空列表"）
  document.getElementById('rpFilter').addEventListener('change', () => {
    pages.reports = 1;
    loadReports();
  });
  document.getElementById('rpList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-rp]');
    if (!btn) return;
    const status = btn.getAttribute('data-rp');
    const id = btn.getAttribute('data-id');
    const note = prompt(status === 'handled' ? '处理备注（可留空）：' : '驳回理由（可留空）：');
    if (note === null) return;
    try {
      const res = await fetch(`/api/admin/reports/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
        body: JSON.stringify({ status, note }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast((data && data.error) || '处理失败'); return; }
      toast(status === 'handled' ? '已标记为处理' : '已驳回');
      loadReports();
    } catch (err) { toast('处理失败：' + err.message); }
  });

  /** 表单与按钮只绑一次（列表每次刷新会重建，重复绑定会累积监听器） */
  function initIpBanForm() {
    if (ipbFormReady || !ipbDurations.length) return;
    document.getElementById('ipbHours').innerHTML = ipbDurations
      .map((d) => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
    document.getElementById('btnIpBan').addEventListener('click', submitIpBan);
    document.getElementById('btnRefreshIpBan').addEventListener('click', loadIpBans);
    // 多填一个 IP 就点一次封禁：回车提交比找按钮顺手
    document.getElementById('ipbReason').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitIpBan();
    });
    ipbFormReady = true;
  }

  function renderIpBans() {
    document.getElementById('ipbCount').textContent = allBans.length;
    document.getElementById('ipbMyIp').innerHTML = ipbMyIp
      ? `你当前的 IP：<b>${esc(maskIp(ipbMyIp))}</b> —— 不能封禁会把你自己也圈进去的规则`
      : '';
    renderPaged('ipbans', allBans, 'ipbPager', renderIpBanPage);
  }

  function renderIpBanPage(slice) {
    const el = document.getElementById('ipbList');
    if (!slice.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无封禁记录。</div>';
      return;
    }
    const now = Date.now();
    el.innerHTML = slice.map((b) => {
      const st = b.permanent
        ? '<span style="color:var(--red-light);">永久</span>'
        : (b.active
          ? `<span style="color:var(--gold-light);">剩余 ${fmtLeft(b.expiresAt - now)}</span>`
          : '<span style="color:var(--text-dim);">已过期</span>');
      const hit = b.hits
        ? ` · 已命中 ${b.hits} 次${b.lastHitAt ? `（最近 ${fmtTs(b.lastHitAt)}）` : ''}`
        : ' · 尚未命中';
      return `
        <div class="record-item">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <div>
              <div style="font-size:13px;">
                <span class="ipb-mask" data-ip="${esc(b.ip)}" data-shown="0" style="cursor:pointer;"
                      title="点击展开完整地址">${esc(maskIp(b.ip))}</span>
                &nbsp;${st}
              </div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
                ${esc(b.reason || '')} · 操作人 ${esc(b.bannedById || '—')} · ${fmtTs(b.bannedAt)}${hit}
              </div>
            </div>
            <div style="display:flex;gap:6px;">
              ${b.permanent ? '' : `<button class="btn btn-ghost btn-sm" data-ipb-ext="${esc(b.ip)}">延长 24h</button>`}
              <button class="btn btn-ghost btn-sm" data-ipb-unban="${esc(b.ip)}" style="color:var(--red-light);">解封</button>
            </div>
          </div>
        </div>`;
    }).join('');

    // 掩码点击展开（IP 属隐私数据，与 §U6 同一口径：默认只见网段）
    el.querySelectorAll('.ipb-mask').forEach((s) => s.addEventListener('click', () => {
      const ip = s.getAttribute('data-ip');
      const shown = s.getAttribute('data-shown') === '1';
      s.textContent = shown ? maskIp(ip) : ip;
      s.setAttribute('data-shown', shown ? '0' : '1');
    }));
    el.querySelectorAll('button[data-ipb-unban]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ip = btn.getAttribute('data-ipb-unban');
        if (!confirm(`确定解封 ${ip}？`)) return;
        ipbPost('/api/admin/ipbans/unban', { ip }, '已解封');
      });
    });
    el.querySelectorAll('button[data-ipb-ext]').forEach((btn) => {
      btn.addEventListener('click', () => {
        ipbPost('/api/admin/ipbans/extend', { ip: btn.getAttribute('data-ipb-ext'), hours: 24 }, '已延长 24 小时');
      });
    });
  }

  function submitIpBan() {
    const ip = document.getElementById('ipbIp').value.trim();
    const reason = document.getElementById('ipbReason').value.trim();
    const durId = document.getElementById('ipbHours').value;
    const dur = ipbDurations.find((d) => d.id === durId) || {};

    if (!ip) return toast('请填写 IP 或网段');
    if (!reason) return toast('必须填写封禁理由');

    // 永久封禁单独再确认一次：它是 NAT 共享出口误伤面最大的一档，且不会自动解除
    if (dur.hours === null && !confirm(`确定对 ${ip} 做【永久】封禁？\n共享出口 IP 可能影响很多人，且不会自动解除。`)) return;
    if (!confirm(`确定封禁 ${ip}？\n理由：${reason}\n时长：${dur.label || durId}`)) return;

    ipbPost('/api/admin/ipbans', { ip, reason, hours: dur.hours }, '已封禁').then((ok) => {
      if (ok) { document.getElementById('ipbIp').value = ''; document.getElementById('ipbReason').value = ''; }
    });
  }

  /** 三个写操作共用：POST + 错误提示 + 成功后刷新列表 */
  async function ipbPost(path, body, okMsg) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast((data && data.error) || '操作失败'); return false; }
      toast(okMsg);
      loadIpBans();
      return true;
    } catch (e) { toast('操作失败：' + e.message); return false; }
  }

  /** 剩余时长文案 */
  function fmtLeft(ms) {
    if (ms <= 0) return '已过期';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} 小时`;
    return `${Math.floor(h / 24)} 天`;
  }

  // ==================================================================
  // §C1 总览仪表盘
  // ==================================================================
  let ovBtnReady = false;

  async function loadOverview() {
    if (!ovBtnReady) {
      const b = document.getElementById('btnRefreshOverview');
      if (b) b.addEventListener('click', loadOverview);
      ovBtnReady = true;
    }
    try {
      const res = await fetch('/api/admin/overview', { headers: { 'x-admin-token': getToken() } });
      const d = await res.json();
      if (!res.ok) { toast((d && d.error) || '加载失败'); return; }
      renderOverview(d);
    } catch (e) { toast('加载失败：' + e.message); }
  }

  function renderOverview(d) {
    const cards = [
      ['在线人数', d.stats.online, 'var(--gold-light)'],
      ['进行中对局', d.stats.playing],
      ['等待中', d.stats.waiting],
      ['棋谱总数', d.recordsTotal],
      ['用户数', d.userCount],
      ['赛事数', d.tournamentCount],
      ['公告数', d.announcementCount],
      ['生效中的 IP 封禁', d.activeBanCount],
    ];
    document.getElementById('ovStats').innerHTML = cards.map(([label, val, color]) => `
      <div class="card" style="padding:14px 16px;background:var(--bg-2);">
        <div style="font-size:12px;color:var(--text-dim);">${label}</div>
        <div style="font-size:24px;font-weight:800;margin-top:4px;${color ? `color:${color};` : ''}">${val == null ? '—' : val}</div>
      </div>`).join('');

    const au = (d.recentAudit || []).slice().reverse(); // 最新在上
    document.getElementById('ovAudit').innerHTML = au.length ? au.map((e) => `
      <div style="font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <span style="color:var(--text-dim);">${fmtTs(e.ts)}</span>
        · <span style="color:var(--gold-light);">${esc(e.action || '')}</span>
        · ${esc(maskIp(e.ip || ''))}
        ${e.ok === false ? ' · <span style="color:var(--red-light);">失败</span>' : ''}
      </div>`).join('') : '<div style="color:var(--text-dim);font-size:13px;">暂无记录。</div>';

    const bt = d.recentBattles || [];
    document.getElementById('ovBattles').innerHTML = bt.length ? bt.map((r) => {
      const names = r.names || ['先手', '後手'];
      const res = window.UI.resultText(r, { withClass: true });
      return `<div style="font-size:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        ${esc(names[0])} vs ${esc(names[1])}
        <span class="${res.cls}" style="font-size:11px;">${esc(res.text)}</span>
        <span style="color:var(--text-dim);"> · ${r.moveCount || 0} 手 · ${fmtTs(r.createdAt)}</span>
      </div>`;
    }).join('') : '<div style="color:var(--text-dim);font-size:13px;">暂无对局。</div>';
  }

  // ==================================================================
  // §C5 公告管理
  //
  // ⚠️ 公告删空后**不会**退回默认公告（旧实现会，表现为"删不掉"）——
  // 由服务端 `listAnnouncements()` 只用「是不是数组」判断来保证。
  // ==================================================================
  let allAnn = [];
  let anEditingId = null;
  let anFormReady = false;

  async function loadAnnouncements() {
    initAnnForm();
    try {
      const res = await fetch('/api/admin/announcements', { headers: { 'x-admin-token': getToken() } });
      const d = await res.json();
      if (!res.ok) { toast((d && d.error) || '加载失败'); return; }
      allAnn = d.announcements || [];
      renderAnnouncements();
    } catch (e) { toast('加载失败：' + e.message); }
  }

  function initAnnForm() {
    if (anFormReady) return;
    document.getElementById('btnAnnAdd').addEventListener('click', submitAnnouncement);
    document.getElementById('btnAnnCancelEdit').addEventListener('click', cancelAnEdit);
    document.getElementById('btnRefreshAnn').addEventListener('click', loadAnnouncements);
    anFormReady = true;
  }

  function cancelAnEdit() {
    anEditingId = null;
    document.getElementById('anTitle').value = '';
    document.getElementById('anContent').value = '';
    document.getElementById('anPinned').checked = false;
    document.getElementById('btnAnnAdd').textContent = '＋ 发布公告';
    document.getElementById('btnAnnCancelEdit').style.display = 'none';
    document.getElementById('anEditHint').style.display = 'none';
  }

  async function submitAnnouncement() {
    const title = document.getElementById('anTitle').value.trim();
    const content = document.getElementById('anContent').value.trim();
    const pinned = document.getElementById('anPinned').checked;
    if (!title) return toast('请填写标题');
    if (!content) return toast('请填写内容');

    if (anEditingId != null) {
      const ok = await anPost(`/api/admin/announcements/${anEditingId}/update`, { title, content, pinned }, '公告已更新');
      if (ok) cancelAnEdit();
    } else {
      const ok = await anPost('/api/admin/announcements', { title, content, pinned }, '公告已发布');
      if (ok) cancelAnEdit();
    }
  }

  function renderAnnouncements() {
    document.getElementById('anCount').textContent = allAnn.length;
    renderPaged('announcements', allAnn, 'anPager', renderAnnPage);
  }

  function renderAnnPage(slice) {
    const el = document.getElementById('anList');
    if (!slice.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无公告。用上方表单发一条吧。</div>';
      return;
    }
    el.innerHTML = slice.map((a) => `
      <div class="record-item">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;min-width:240px;">
            <div style="font-size:13px;font-weight:700;">
              ${a.pinned ? '<span style="color:var(--gold-light);">📌</span> ' : ''}${esc(a.title)}
            </div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:4px;white-space:pre-wrap;">${esc(a.content)}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">
              #${a.id} · 发布于 ${fmtTs(a.createdAt)}${a.updatedAt ? ` · 修改于 ${fmtTs(a.updatedAt)}` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm" data-an-pin="${a.id}" data-an-pinned="${a.pinned ? 1 : 0}">${a.pinned ? '取消置顶' : '置顶'}</button>
            <button class="btn btn-ghost btn-sm" data-an-edit="${a.id}">编辑</button>
            <button class="btn btn-ghost btn-sm" data-an-del="${a.id}" style="color:var(--red-light);">删除</button>
          </div>
        </div>
      </div>`).join('');

    el.querySelectorAll('button[data-an-pin]').forEach((b) => {
      b.addEventListener('click', () => {
        anPost(`/api/admin/announcements/${encodeURIComponent(b.getAttribute('data-an-pin'))}/update`,
          { pinned: b.getAttribute('data-an-pinned') !== '1' }, '已更新');
      });
    });
    el.querySelectorAll('button[data-an-edit]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = allAnn.find((x) => String(x.id) === b.getAttribute('data-an-edit'));
        if (!a) return;
        anEditingId = a.id;
        document.getElementById('anTitle').value = a.title;
        document.getElementById('anContent').value = a.content;
        document.getElementById('anPinned').checked = !!a.pinned;
        document.getElementById('btnAnnAdd').textContent = '保存修改';
        document.getElementById('btnAnnCancelEdit').style.display = '';
        document.getElementById('anEditHint').style.display = '';
        document.getElementById('anEditHint').textContent = `正在编辑 #${a.id}「${a.title}」`;
        document.getElementById('anTitle').focus();
      });
    });
    el.querySelectorAll('button[data-an-del]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-an-del');
        const a = allAnn.find((x) => String(x.id) === String(id));
        if (!confirm(`确定删除公告「${a ? a.title : id}」？`)) return;
        anPost(`/api/admin/announcements/${encodeURIComponent(id)}/delete`, {}, '已删除').then((ok) => {
          if (ok && String(anEditingId) === String(id)) cancelAnEdit();
        });
      });
    });
  }

  // ==================================================================
  // §C6 实时干预：在线房间列表 + 强制解散 / 强制下线
  //
  // ⚠️ 强制解散是**破坏性**操作：对局会立刻中断。所以每个按钮都带二次确认，
  // 并且确认框里写出"房间里有谁"——避免管理员看错行、解散错房间。
  // ==================================================================
  let allRooms = [];
  let rmBtnReady = false;

  async function loadRooms() {
    if (!rmBtnReady) {
      const b = document.getElementById('btnRefreshRooms');
      if (b) b.addEventListener('click', loadRooms);
      rmBtnReady = true;
    }
    try {
      const res = await fetch('/api/admin/rooms', { headers: { 'x-admin-token': getToken() } });
      const d = await res.json();
      if (!res.ok) { toast((d && d.error) || '加载失败'); return; }
      allRooms = d.rooms || [];
      renderRooms();
    } catch (e) { toast('加载失败：' + e.message); }
  }

  function renderRooms() {
    document.getElementById('rmCount').textContent = allRooms.length;
    const el = document.getElementById('rmList');
    if (!allRooms.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">当前没有在线房间。</div>';
      return;
    }
    el.innerHTML = allRooms.map((r) => {
      const who = (r.players || []).map((p) => `
        <span data-player-id="${esc(p.id || '')}" style="margin-right:6px;">
          ${p.seat === 'b' ? '▲' : '△'} ${esc(p.name || '—')}
          ${p.connected ? '' : '<span style="color:var(--red-light);font-size:11px;">（已断线）</span>'}
          <button class="btn btn-ghost btn-sm" data-rm-kick="${esc(p.id || '')}" style="padding:1px 6px;font-size:11px;">下线</button>
        </span>`).join('') || '<span style="color:var(--text-dim);">无人</span>';
      const tags = [
        r.status,
        r.isPrivate ? '<span style="color:var(--gold-light);">私人房</span>' : '',
        r.tournamentId ? '赛事对局' : '',
        r.rated ? '计分' : '不计分',
        r.spectators ? `观众 ${r.spectators}` : '',
      ].filter(Boolean).join(' · ');
      return `
        <div class="record-item">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <div style="flex:1;min-width:260px;">
              <div style="font-size:13px;">${who}</div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">
                ${esc(tags)}${r.code ? ` · 房号 ${esc(r.code)}` : ''} · ${r.moveCount} 手 · 建于 ${fmtTs(r.createdAt)}
              </div>
            </div>
            <div>
              <button class="btn btn-ghost btn-sm" data-rm-close="${esc(r.roomId)}" style="color:var(--red-light);">强制解散</button>
            </div>
          </div>
        </div>`;
    }).join('');

    el.querySelectorAll('button[data-rm-close]').forEach((b) => {
      b.addEventListener('click', () => {
        const roomId = b.getAttribute('data-rm-close');
        const r = allRooms.find((x) => x.roomId === roomId);
        const who = r ? (r.players || []).map((p) => p.name || '—').join(' vs ') : '';
        if (!confirm(`确定强制解散房间？\n房内：${who}\n\n对局会立刻中断。`)) return;
        roomPost(`/api/admin/rooms/${encodeURIComponent(roomId)}/close`, {}, '已解散房间');
      });
    });
    el.querySelectorAll('button[data-rm-kick]').forEach((b) => {
      b.addEventListener('click', () => {
        const pid = b.getAttribute('data-rm-kick');
        if (!pid) return toast('该座位没有可下线的玩家');
        if (!confirm('确定把该玩家强制下线？\n（对局中会走断线判负流程）')) return;
        roomPost('/api/admin/kick', { playerId: pid }, '已强制下线');
      });
    });
  }

  async function roomPost(path, body, okMsg) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast((data && data.error) || '操作失败'); return false; }
      toast(okMsg);
      loadRooms();
      return true;
    } catch (e) { toast('操作失败：' + e.message); return false; }
  }

  /** 公告的三个写操作共用：POST + 错误提示 + 成功后刷新 */
  async function anPost(path, body, okMsg) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast((data && data.error) || '操作失败'); return false; }
      toast(okMsg);
      loadAnnouncements();
      return true;
    } catch (e) { toast('操作失败：' + e.message); return false; }
  }

  document.getElementById('btnRefreshAudit').addEventListener('click', loadAudit);

  // ==================================================================
  // `data-act` 分派（2026-09-23，安全审查遗留项 13f）
  //
  // 本页原先有 **19 处** inline `onclick`，且多处把用户可控的值（玩家名、赛事名）
  // 拼进属性里 —— 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态：
  // 游客把名字改成 `');alert()//`，管理员点该用户任一按钮即以管理员身份执行。
  // `esc` 补上单引号转义只是**止血**；改成 `data-act` + 属性值之后，
  // 引号逃不出属性、更不会被当代码执行，而且**事件走 util.js 的整页委托** ——
  // 列表整块重渲染也不会丢监听（逐个绑定要做到这点，得每次渲染后重新绑一遍）。
  //
  // ⚠️ 处理器一律写成 `window.xxx`：本页的处理函数都是 `window.xxx = …` 赋的，
  // 直接写裸名既是未定义标识符、也会被 eslint 的 `no-undef` 拦下。
  // ==================================================================
  {
    const at = (el, k) => el.getAttribute(k);
    window.UI.onAction('rb-playback', (el) => window.adminPlayback(at(el, 'data-id')));
    window.UI.onAction('rb-export', (el) => window.adminExport(at(el, 'data-id'), at(el, 'data-fmt')));
    window.UI.onAction('reveal-ip', (el) => {
      el.textContent = at(el, 'data-text');
      el.removeAttribute('title');
      el.style.cursor = 'default';
    });
    window.UI.onAction('user-view', (el) => window.viewUser(at(el, 'data-id')));
    window.UI.onAction('user-ban', (el) => window.adminBan(at(el, 'data-id'), at(el, 'data-name')));
    window.UI.onAction('user-unban', (el) => window.adminUnban(at(el, 'data-id'), at(el, 'data-name')));
    window.UI.onAction('user-save-profile', (el) => window.adminSaveProfile(at(el, 'data-id')));
    window.UI.onAction('user-save-elo', (el) => window.adminSaveElo(at(el, 'data-id')));
    window.UI.onAction('user-rename', (el) => window.adminRename(at(el, 'data-id'), at(el, 'data-name')));
    window.UI.onAction('user-reset-rating', (el) => window.adminResetRating(at(el, 'data-id'), at(el, 'data-name')));
    window.UI.onAction('user-reset-pwd', (el) => window.adminResetPassword(at(el, 'data-id'), at(el, 'data-name')));
    window.UI.onAction('user-delete', (el) => window.adminDeleteAccount(at(el, 'data-id'), at(el, 'data-name')));
    window.UI.onAction('tn-approve', (el) => window.tnApprove(at(el, 'data-id')));
    window.UI.onAction('tn-reject', (el) => window.tnReject(at(el, 'data-id')));
    window.UI.onAction('tn-cancel', (el) => window.tnCancel(at(el, 'data-id')));
    window.UI.onAction('tn-archive', (el) => window.tnArchive(at(el, 'data-id')));
    // 用户详情弹窗的「关闭」（原先写在 admin.html 的 inline onclick 里）
    window.UI.onAction('modal-close', () => {
      const m = document.getElementById('userDetailModal');
      if (m) m.style.display = 'none';
    });
  }

  initUI();
})();
