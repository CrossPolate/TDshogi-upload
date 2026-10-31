'use strict';

/**
 * admin-puzzles.js — 管理后台「题库」tab（1.6）。
 *
 * 只负责 UI：JSON 导入 / 列表 / 上下架；校验和每日题逻辑在 src/puzzles/。
 */
(function (global) {
  'use strict';

  function mount(ctx) {
    const { $, esc, toast, getToken, hub } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();
    let PUZZLES = [];

    const authHeaders = () => ({ 'Content-Type': 'application/json', 'x-admin-token': getToken() || '' });

    async function apiGet(path) {
      const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken() || '')}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
      return data;
    }
    async function apiPost(path, body) {
      const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
      return data;
    }

    function report(text, isErr) {
      const el = $('puzzleImportReport');
      if (!el) return;
      el.innerHTML = '';
      const span = document.createElement('span');
      span.style.color = isErr ? 'var(--red-light)' : 'var(--green)';
      span.textContent = text;
      el.appendChild(span);
    }

    function render() {
      const box = $('puzzleList');
      const cnt = $('puzzleCount');
      if (cnt) cnt.textContent = String(PUZZLES.length);
      if (!box) return;
      if (!PUZZLES.length) {
        box.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:12px 0;">题库为空。导入 JSON 后才会生成每日题。</div>';
        return;
      }
      box.innerHTML = PUZZLES.map((p) => {
        const active = p.status !== 'disabled';
        return `<div class="record-item" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;">
          <div style="flex:1;min-width:180px;font-size:13px;">
            <b>${esc(p.id)}</b>
            <span style="font-size:11px;color:var(--text-dim);"> · ${esc(p.type)} · 难度 ${esc(String(p.difficulty || 1))}/5${p.tags && p.tags.length ? ' · ' + esc(p.tags.join(' / ')) : ''}</span>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">SFEN: ${esc(String(p.sfen || '').slice(0, 70))}${String(p.sfen || '').length > 70 ? '…' : ''}</div>
          </div>
          <span style="font-size:11px;color:${active ? 'var(--green)' : 'var(--text-dim)'};">${active ? '启用' : '停用'}</span>
          <button class="btn btn-ghost btn-sm" data-puzzle-toggle="${esc(p.id)}" data-puzzle-status="${active ? 'disabled' : 'active'}" type="button">${active ? '停用' : '启用'}</button>
        </div>`;
      }).join('');
      box.onclick = (e) => {
        const btn = e.target.closest && e.target.closest('[data-puzzle-toggle]');
        if (!btn) return;
        toggleStatus(btn.getAttribute('data-puzzle-toggle'), btn.getAttribute('data-puzzle-status'));
      };
    }

    async function load() {
      const box = $('puzzleList');
      if (box) box.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:12px 0;">加载题库…</div>';
      try {
        const d = await apiGet('/api/admin/puzzles');
        if (!alive()) return;
        PUZZLES = d.puzzles || [];
        render();
      } catch (e) {
        if (!alive()) return;
        if (box) box.innerHTML = `<div style="font-size:12px;color:var(--red-light);padding:12px 0;">${esc(e.message)}</div>`;
      }
    }

    async function importJson() {
      const ta = $('puzzleImportText');
      const raw = ta ? ta.value.trim() : '';
      if (!raw) return report('请先粘贴题库 JSON', true);
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return report(`JSON 解析失败：${e.message}`, true); }
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.puzzles) ? parsed.puzzles : null);
      if (!list) return report('JSON 必须是数组，或 { "puzzles": [...] }', true);
      try {
        const r = await apiPost('/api/admin/puzzles/import', { puzzles: list });
        if (!alive()) return;
        report(`已导入 ${r.imported} 题`, false);
        toast(`题库已导入 ${r.imported} 题`);
        await load();
      } catch (e) {
        if (!alive()) return;
        report(e.message, true);
      }
    }

    async function toggleStatus(id, status) {
      try {
        await apiPost(`/api/admin/puzzles/${encodeURIComponent(id)}/status`, { status });
        if (!alive()) return;
        toast(status === 'active' ? '已启用' : '已停用');
        await load();
      } catch (e) {
        if (!alive()) return;
        toast(e.message);
      }
    }

    const onEl = (id, ev, fn) => { on($(id), ev, fn); };
    onEl('btnPuzzleRefresh', 'click', load);
    onEl('btnPuzzleImport', 'click', importJson);

    hub.loadPuzzlesAdmin = load;
  }

  function unmount() {}

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.puzzles = { mount, unmount };
})(window);
