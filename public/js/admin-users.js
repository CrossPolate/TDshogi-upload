/**
 * admin-users.js — 全部用户（admin 子模块）：列表、搜索、用户详情弹层与管理操作
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.users`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定 DOM 事件、导出 loadUsers / viewUser / 管理操作等到 ctx.hub
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI / fmtTime）由 admin.js 的 mount 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, maskIp, renderPaged, setToken, toast, hub, fmtTime } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ---- 全部用户 ----
    let allUsers = [];

    // ⚠️ 2026-10-02 体验修复（刷新按钮）：用户列表此前**没有**手动刷新入口——
    // 看到某个用户状态变了（封禁/改名），只能切走再切回来才能重新拉。这里补一个。
    on($('btnRefreshUsers'), 'click', () => loadUsers());

    async function loadUsers() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位，避免点开 tab 先看到空白
      const box = $('adminUserList');
      if (box) box.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载用户…') : '';
      try {
        const data = await global.ApiUtils.get(`/api/admin/users?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allUsers = data.users || [];
        renderPaged('users', allUsers, 'userPager', renderUsers);
      } catch (e) {
        if (!alive()) return;
        if (e.message && e.message.includes('403')) setToken(null);
        toast('加载用户失败');
        if (box) box.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty('加载用户失败，请确认登录状态后点「刷新」重试') : '';
        if (hub.initUI) hub.initUI();
      }
    }

    function renderUsers(users) {
      // ⚠️ 2026-10-02 体验修复：标题用**总数**（此前用当页条数，恒 ≤20）
      const cnt = $('userCount');
      if (cnt) cnt.textContent = allUsers.length;
      const el = $('adminUserList');
      if (!el) return;
      if (!users.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来没用户"与"被搜索筛空"
        const q = ($('userSearch') || {}).value || '';
        el.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty(q.trim() ? '没有匹配关键词的用户（清空搜索框可看全部）' : '暂无用户') : '';
        return;
      }
      el.innerHTML = users.map((u) => `
    <div class="record-item">
      <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
        <span>${u.isAccount ? '<span title="正式账号">🔐</span>' : '<span title="游客">👤</span>'} ${esc(u.name)}${u.title ? `（${esc(u.title)}）` : ''} <span style="color:var(--text-dim);font-size:11px;">(${u.id})</span></span>
        <span style="font-size:11px;">${u.banned ? '<span style="color:var(--red-light);">⛔ 封禁中</span>' : ''}</span>
      </div>
      <div class="r-result result-win">Lv.${u.level || 0} · ELO ${u.rating}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${u.games} 局 · 胜 ${u.wins} / 负 ${u.losses} / 平 ${u.draws} · 胜率 ${u.winRate}% · 经验 ${u.exp || 0} · 积分 ${u.points || 0}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">🌐 最近 IP：${u.lastIp ? `<span title="点击展开完整 IP" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="reveal-ip" data-text="${esc(u.lastIp)}">${esc(maskIp(u.lastIp))}</span>` : '—'}${u.lastSeen ? ` · <span title="最后活跃时间">${global.I18N.fmt(u.lastSeen)}</span>` : ''}</div>
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
    on($('userSearch'), 'input', (e) => {
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

    hub.viewUser = async (id) => {
      try {
        const data = await global.ApiUtils.get(`/api/admin/users/${id}?token=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        VIEWED_ID.v = id;
        const nameEl = $('detailUserName');
        if (nameEl) nameEl.textContent = data.title ? `${data.name}（${data.title}）` : data.name;
        const p = data.profile;
        const recs = data.records || [];
        const net = data.net || null;
        const banned = data.banned || null;
        const events = data.events || [];
        const styleOpts = STYLE_OPTIONS.map((s) =>
          `<option value="${s}" ${s === (data.style || '不设定') ? 'selected' : ''}>${s}</option>`).join('');
        const bodyEl = $('detailBody');
        if (!bodyEl) return;
        bodyEl.innerHTML = `
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
      <div style="font-size:14px;font-weight:700;margin:14px 0 6px;">📊 等级与 ELO <span style="font-size:11px;color:var(--text-dim);font-weight:400;">（Lv.${p.level} · 经验 ${p.exp} · 积分 ${p.points || 0}；等级随经验自动推导）</span></div>
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
        const detailModal = $('userDetailModal');
        if (!detailModal) return;
        detailModal.style.display = 'flex';
        if (global.A11y) global.A11y.onDialogOpen(detailModal, {
          onClose: () => { detailModal.style.display = 'none'; if (global.A11y) global.A11y.onDialogClose(detailModal); },
        });
      } catch (e) {
        if (!alive()) return;
        toast('加载用户详情失败');
      }
    };

    hub.adminSaveProfile = async (id) => {
      const phone = $('editPhone') ? $('editPhone').value.trim() : '';
      const style = $('editStyle') ? $('editStyle').value : '';
      const title = $('editTitle') ? $('editTitle').value.trim() : '';
      try {
        await adminPost(`/api/admin/users/${id}/profile`, { phone, style, title });
        if (!alive()) return;
        toast('资料已保存');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminSaveElo = async (id) => {
      const rating = parseInt($('editElo') && $('editElo').value, 10);
      const exp = parseInt($('editExp') && $('editExp').value, 10);
      if (!Number.isFinite(rating) || !Number.isFinite(exp)) return toast('ELO 与经验需为整数');
      try {
        await adminPost(`/api/admin/users/${id}/elo`, { rating, exp });
        if (!alive()) return;
        toast('ELO/经验已保存');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminRename = async (id, oldName) => {
      const name = prompt(`修改「${oldName}」的显示名（≤16 字，不改账号登录用户名）：`, oldName);
      if (name === null || !name.trim()) return;
      // ⚠️ 2026-10-02 体验修复（危险操作确认）：改名会**即时**改变对局内双方看到的名字，
      // 且存在"改成与他人类似的名字冒充"的风险——按封禁/重置/删除同一口径补一次二次确认。
      if (!confirm(`确定把显示名「${oldName}」改为「${name.trim()}」？\n改后对手在对局内会立即看到新名字。`)) return;
      try {
        await adminPost(`/api/admin/users/${id}/rename`, { name: name.trim() });
        if (!alive()) return;
        toast('已改名（对局内对手即时可见）');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminResetRating = async (id, name) => {
      if (!confirm(`确定重置「${name}」的 ELO 与战绩？不可恢复。`)) return;
      try {
        await adminPost(`/api/admin/users/${id}/reset-rating`, {});
        if (!alive()) return;
        toast('已重置评级与战绩');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminResetPassword = async (id, name) => {
      if (!confirm(`确定重置「${name}」的密码？其全部已登录会话将被强制失效。`)) return;
      try {
        const r = await adminPost(`/api/admin/users/${id}/reset-password`, {});
        if (!alive()) return;
        prompt('新密码（仅此一次显示，请转交用户）：', r.password || '');
        toast('密码已重置');
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminBan = async (id, name) => {
      const reason = prompt(`封禁「${name}」的原因（可留空）：`);
      if (reason === null) return;
      const daysStr = prompt('封禁天数（留空或 0 = 永久）：', '');
      if (daysStr === null) return;
      const days = parseFloat(daysStr) || 0;
      if (!confirm(`确定封禁「${name}」${days > 0 ? days + ' 天' : '（永久）'}？该用户将被强制下线。`)) return;
      try {
        const r = await adminPost(`/api/admin/users/${id}/ban`, { reason, days });
        if (!alive()) return;
        toast(`已封禁${r.kicked ? `（踢下线 ${r.kicked} 个连接）` : ''}`);
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminUnban = async (id, name) => {
      if (!confirm(`确定解封「${name}」？`)) return;
      try {
        await adminPost(`/api/admin/users/${id}/unban`, {});
        if (!alive()) return;
        toast('已解封');
        loadUsers(); hub.viewUser(id);
      } catch (e) { if (alive()) toast(e.message); }
    };

    hub.adminDeleteAccount = async (id, name) => {
      const c = prompt(`⚠️ 删除账号「${name}」不可恢复（棋谱保留、评级清空）。\n输入 DELETE 确认：`);
      if (c === null) return;
      if (c !== 'DELETE' && c !== name) return toast('确认输入不正确，未删除');
      try {
        await adminPost(`/api/admin/users/${id}`, { confirm: c }, 'DELETE');
        if (!alive()) return;
        toast('账号已删除');
        const dmClose = $('userDetailModal');
        if (dmClose) {
          dmClose.style.display = 'none';
          if (global.A11y) global.A11y.onDialogClose(dmClose);
        }
        loadUsers();
      } catch (e) { if (alive()) toast(e.message); }
    };

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadUsers = loadUsers;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.users = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);
