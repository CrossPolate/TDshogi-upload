/* global fmtTs, loadAudit */
/**
   * admin-console.js — 总览仪表盘 + 公告管理 + 实时干预（房间）
   *
   * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**，
   * 逻辑一字未改，只整体左移 2 格缩进。共用工具（token / $ / esc / maskIp / 分页）仍由
   * `admin.js` 装配时注入（见下方 `make(deps)`）。
   *
   * ⚠️ 本文件必须在 `admin.js` **之前**加载（见 public/admin.html 的 <script> 顺序）；
   * `admin.js` 装配时会检查，缺失即抛错——不然症状是"某个 tab 点了没反应"这种静默故障。
   */
  (function (global) {
    'use strict';

    function make(deps) {
      // 共用工具（由 admin.js 装配时注入）
    const { esc, getToken, maskIp, renderPaged, toast } = deps;
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
  // ⚠️ 2026-10-02 体验修复（加载态统一）：公告属"切过去才拉"的懒加载 tab，
  // 此前首次切过去是一段空白；先铺"正在加载"占位（与棋谱/用户/审计/举报同一写法）。
  const anBox = document.getElementById('anList');
  if (anBox) anBox.innerHTML = window.AdminUI ? window.AdminUI.loading('正在加载公告…') : '';
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
  // ⚠️ 2026-10-02 体验修复（加载态统一）：房间列表也是懒加载 tab，先铺"正在加载"占位
  const rmBox = document.getElementById('rmList');
  if (rmBox) rmBox.innerHTML = window.AdminUI ? window.AdminUI.loading('正在加载房间…') : '';
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

    // ---- 供其它模块调用（admin.js 装配时按依赖顺序执行，见该文件）----
    global.loadAnnouncements = loadAnnouncements;
    global.loadOverview = loadOverview;
    global.loadRooms = loadRooms;

      return {
        allAnn,
      allRooms,
      anEditingId,
      anFormReady,
      anPost,
      cancelAnEdit,
      initAnnForm,
      loadAnnouncements,
      loadOverview,
      loadRooms,
      ovBtnReady,
      renderAnnPage,
      renderAnnouncements,
      renderOverview,
      renderRooms,
      rmBtnReady,
      roomPost,
      submitAnnouncement,
      };
    }

    global.AdminConsole = { make };
  })(typeof window !== 'undefined' ? window : globalThis);
  