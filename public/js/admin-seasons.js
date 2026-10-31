/**
 * admin-seasons.js — 管理后台「赛季 / 竞技场」tab（1.8）
 * 赛季：创建 → 关闭并结算（快照 overall/standard/ultra 前 10，按名次发积分）。
 * 竞技场：管理员直接取消主办人失联 / 违规场次。
 */
(function (global) {
  'use strict';

  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, toast, hub } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    async function adminApi(path, opts = {}) {
      const headers = Object.assign({ 'x-admin-token': getToken() }, opts.headers || {});
      if (opts.body) headers['Content-Type'] = 'application/json';
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || `请求失败（HTTP ${res.status}）`);
      return d;
    }

    const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString('zh-CN') : '—');

    function seasonRow(s) {
      const top = s.data && s.data.categories && s.data.categories.overall ? s.data.categories.overall[0] : null;
      return `
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:9px 0;border-bottom:1px dashed var(--border);">
          <div style="min-width:220px;">
            <div style="font-size:14px;font-weight:700;">${esc(s.name)}
              <span style="font-size:11px;color:${s.status === 'closed' ? 'var(--text-dim)' : 'var(--gold-light)'};">${s.status === 'closed' ? '已结算' : '进行中'}</span>
            </div>
            <div style="font-size:12px;color:var(--text-dim);">${fmtDay(s.startsAt)} → ${fmtDay(s.endsAt)}${s.closedAt ? ` · 结算于 ${fmtDay(s.closedAt)}` : ''}</div>
            ${top ? `<div style="font-size:12px;color:var(--gold-light);">总榜第一：${esc(top.name)}（${top.rating}）</div>` : ''}
          </div>
          <div>
            ${s.status === 'open' ? `<button class="btn btn-primary btn-sm" type="button" data-season-close="${esc(s.id)}">关闭并结算</button>` : ''}
          </div>
        </div>`;
    }

    async function loadSeasons() {
      const box = $('seasonAdminList');
      if (box) box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">加载中…</div>';
      try {
        const d = await adminApi('/api/admin/seasons');
        if (!alive() || !box) return;
        const list = d.seasons || [];
        box.innerHTML = list.length ? list.map(seasonRow).join('') : '<div style="color:var(--text-dim);font-size:13px;">还没有赛季。</div>';
      } catch (e) {
        if (alive() && box) box.innerHTML = `<div style="color:var(--red-light);font-size:13px;">${esc(e.message)}</div>`;
      }
    }

    function arenaRow(a) {
      const active = a.status === 'open' || a.status === 'running';
      return `
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;padding:9px 0;border-bottom:1px dashed var(--border);">
          <div style="min-width:240px;">
            <div style="font-size:14px;font-weight:700;">${esc(a.name)}
              <span style="font-size:11px;color:var(--text-dim);">${esc(a.statusLabel || a.status)}</span>
            </div>
            <div style="font-size:12px;color:var(--text-dim);">主办：${esc(a.ownerName || '—')} · ${fmtDay(a.startsAt)} → ${fmtDay(a.endsAt)} · ${a.entryCount} 人${a.currentRound ? ` · 第 ${a.currentRound} 轮` : ''}</div>
          </div>
          <div>
            ${active ? `<button class="btn btn-ghost btn-sm" type="button" data-arena-cancel="${esc(a.id)}" style="color:var(--red-light);">取消竞技场</button>` : ''}
          </div>
        </div>`;
    }

    async function loadArenas() {
      const box = $('arenaAdminList');
      if (box) box.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">加载中…</div>';
      try {
        const d = await adminApi('/api/admin/arenas');
        if (!alive() || !box) return;
        const list = d.arenas || [];
        box.innerHTML = list.length ? list.map(arenaRow).join('') : '<div style="color:var(--text-dim);font-size:13px;">还没有竞技场。</div>';
      } catch (e) {
        if (alive() && box) box.innerHTML = `<div style="color:var(--red-light);font-size:13px;">${esc(e.message)}</div>`;
      }
    }

    async function createSeason() {
      const name = ($('seasonName') && $('seasonName').value || '').trim();
      if (!name) return toast('请填写赛季名称');
      const start = $('seasonStart').value ? new Date($('seasonStart').value).getTime() : null;
      const end = $('seasonEnd').value ? new Date($('seasonEnd').value).getTime() : null;
      try {
        await adminApi('/api/admin/seasons', { method: 'POST', body: JSON.stringify({ name, startsAt: start, endsAt: end }) });
        toast('赛季已创建');
        if ($('seasonName')) $('seasonName').value = '';
        await loadSeasons();
      } catch (e) { toast(e.message); }
    }

    async function closeSeason(id) {
      if (!global.confirm('关闭并结算该赛季？会立即给榜单前 10 发积分，且不可重复结算。')) return;
      try {
        await adminApi(`/api/admin/seasons/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}' });
        toast('赛季已结算');
        await loadSeasons();
      } catch (e) { toast(e.message); }
    }

    async function cancelArena(id) {
      if (!global.confirm('确定取消该竞技场？')) return;
      try {
        await adminApi(`/api/admin/arenas/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
        toast('竞技场已取消');
        await loadArenas();
      } catch (e) { toast(e.message); }
    }

    on($('btnSeasonCreate'), 'click', createSeason);

    const seasonClick = (ev) => {
      const btn = ev.target.closest && ev.target.closest('[data-season-close]');
      if (btn) closeSeason(btn.getAttribute('data-season-close'));
    };
    const arenaClick = (ev) => {
      const btn = ev.target.closest && ev.target.closest('[data-arena-cancel]');
      if (btn) cancelArena(btn.getAttribute('data-arena-cancel'));
    };
    on($('seasonAdminList'), 'click', seasonClick);
    on($('arenaAdminList'), 'click', arenaClick);

    hub.loadSeasonsAdmin = () => { loadSeasons(); loadArenas(); };
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.seasons = { mount, unmount };
})(window);
