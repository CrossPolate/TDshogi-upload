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
    tnPending: 1, tnActive: 1, tnHistory: 1,
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
  };

  // 初始化：检测是否已登录
  function initUI() {
    const isAdmin = !!getToken();
    document.getElementById('adminLoginCard').style.display = isAdmin ? 'none' : 'block';
    document.getElementById('adminPanel').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('btnAdminLogout').style.display = isAdmin ? 'inline-block' : 'none';
    if (isAdmin) {
      loadRecords();
      loadUsers();
      loadTournaments();
      loadAudit();
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
      ['records', 'users', 'tournaments', 'audit'].forEach((t) => {
        const el = document.getElementById('tab-' + t);
        if (el) el.style.display = t === btn.dataset.tab ? 'block' : 'none';
      });
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
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${new Date(r.createdAt).toLocaleString('zh-CN')}</div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button class="btn btn-ghost btn-sm" onclick="adminPlayback('${r.id}')">回放</button>
            <button class="btn btn-ghost btn-sm" onclick="adminExport('${r.id}','kif')">KIF</button>
            <button class="btn btn-ghost btn-sm" onclick="adminExport('${r.id}','csa')">CSA</button>
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
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">🌐 最近 IP：${u.lastIp ? `<span title="点击展开完整 IP" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" onclick="this.textContent='${esc(u.lastIp)}';this.title='';">${esc(maskIp(u.lastIp))}</span>` : '—'}${u.lastSeen ? ` · <span title="最后活跃时间">${new Date(u.lastSeen).toLocaleString('zh-CN')}</span>` : ''}</div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="btn btn-ghost btn-sm" onclick="viewUser('${u.id}')">查看详情</button>
          ${u.banned
            ? `<button class="btn btn-ghost btn-sm" onclick="adminUnban('${u.id}','${esc(u.name)}')">解封</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="adminBan('${u.id}','${esc(u.name)}')">封禁</button>`}
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

  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '—');

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
          <button class="btn btn-primary btn-sm" onclick="adminSaveProfile('${id}')">保存资料</button>
        </div>
        <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">📊 等级与 ELO <span style="font-size:11px;color:var(--text-dim);font-weight:400;">（Lv.${p.level} · 经验 ${p.exp}；等级随经验自动推导）</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:6px;">
          <div><div style="font-size:11px;color:var(--text-dim);">ELO（100-5000）</div>
            <input class="input" id="editElo" value="${p.rating}" style="width:110px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">经验（≥0）</div>
            <input class="input" id="editExp" value="${p.exp || 0}" style="width:110px;"></div>
          <button class="btn btn-primary btn-sm" onclick="adminSaveElo('${id}')">保存 ELO/经验</button>
        </div>
        <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">🛠️ 管理操作</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          <button class="btn btn-ghost btn-sm" onclick="adminRename('${id}','${esc(data.name)}')">✏️ 改名</button>
          <button class="btn btn-ghost btn-sm" onclick="adminResetRating('${id}','${esc(data.name)}')">♻️ 重置 ELO</button>
          <button class="btn btn-ghost btn-sm" onclick="adminResetPassword('${id}','${esc(data.name)}')">🔑 重置密码</button>
          ${banned
            ? `<button class="btn btn-primary btn-sm" onclick="adminUnban('${id}','${esc(data.name)}')">✅ 解封</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="adminBan('${id}','${esc(data.name)}')">⛔ 封禁</button>`}
          ${data.isAccount ? `<button class="btn btn-ghost btn-sm" onclick="adminDeleteAccount('${id}','${esc(data.name)}')" style="color:var(--red-light);">🗑 删除账号</button>` : ''}
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
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
        `${approved}/${t.size} 人${pendingN ? `（待批准 ${pendingN}）` : ''}`,
        t.ownerName ? `主办 ${esc(t.ownerName)}` : '',
        new Date(t.createdAt).toLocaleString('zh-CN'),
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
          <button class="btn btn-primary btn-sm" onclick="tnApprove('${t.id}')">✓ 通过</button>
          <button class="btn btn-ghost btn-sm" onclick="tnReject('${t.id}')">✗ 拒绝</button>`;
      } else if (t.status === 'registration' || t.status === 'playing') {
        actions = `<button class="btn btn-ghost btn-sm" onclick="tnCancel('${t.id}')">⛔ 取消赛事</button>`;
      } else if (t.status === 'finished') {
        // T6：存档（存档后主办人只读，管理员仍可编辑）
        actions = `<button class="btn btn-ghost btn-sm" onclick="tnArchive('${t.id}')">📦 存档</button>`;
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

  document.getElementById('btnRefreshAudit').addEventListener('click', loadAudit);

  initUI();
})();
