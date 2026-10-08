/* global fmtTs */
/**
   * admin-moderation.js — 违规处理：IP 封禁 + 举报
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
    const { esc, getToken, maskIp, pages, renderPaged, toast } = deps;
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
  // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位，别让切过来先看到一片空白
  const rpBox = document.getElementById('rpList');
  if (rpBox) rpBox.innerHTML = window.AdminUI ? window.AdminUI.loading('正在加载举报…') : '';
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
    // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来没有"与"被状态筛选筛空"
    const filtered = !!document.getElementById('rpFilter').value;
    box.innerHTML = window.AdminUI
      ? window.AdminUI.empty(filtered ? '当前筛选下没有举报（切换「全部」可查看历史）' : '暂无举报记录') : '';
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
            <!-- ⚠️ 2026-10-02 体验修复（举报 id 可点）：把目标 id 显示出来并做成可点链接，
                 点击即打开该玩家的详情弹层（走到 admin-shell.js 的 report-target-view →
                 window.viewUser，与用户列表里的「查看详情」同一处理），不必再手动去用户页搜 id。 -->
            <span style="color:var(--text-dim);font-size:11px;">（<span title="点击查看该玩家详情" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="report-target-view" data-id="${esc(r.targetId)}">${esc(r.targetId)}</span>）</span>
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
    // ⚠️ 2026-10-02 体验修复（空状态统一）：与其余 tab 统一走 AdminUI.empty
    el.innerHTML = window.AdminUI ? window.AdminUI.empty('暂无封禁记录') : '';
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

    // ---- 供其它模块调用（admin.js 装配时按依赖顺序执行，见该文件）----
    global.loadIpBans = loadIpBans;
    global.loadReports = loadReports;

      return {
        allBans,
      allReports,
      fmtLeft,
      initIpBanForm,
      ipbDurations,
      ipbFormReady,
      ipbMyIp,
      ipbPost,
      loadIpBans,
      loadReports,
      renderIpBanPage,
      renderIpBans,
      renderReports,
      reportCategories,
      submitIpBan,
      };
    }

    global.AdminModeration = { make };
  })(typeof window !== 'undefined' ? window : globalThis);
  