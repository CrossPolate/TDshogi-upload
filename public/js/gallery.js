/**
 * gallery.js — 棋谱广场（PLAN §L5）
 *
 * 公开棋谱列表：关键词/标签筛选 + 分页，点击进入复盘页（review.html）。
 * 数据源 GET /api/gallery（服务端只返回 visibility=public 的棋谱）。
 */
(function () {
  const guest = window.NAV.renderNav('gallery');
  const api = window.API;
  api.connect(guest.id);

  const PAGE_SIZE = 20;
  let page = 1;
  let total = 0;

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }
  function esc(s) { return window.UI.esc(s); }

  const qEl = document.getElementById('q');
  const tagEl = document.getElementById('tagSel');

  async function load() {
    const q = (qEl.value || '').trim();
    const tag = tagEl.value || '';
    try {
      const data = await window.ApiUtils.get(
        `/api/gallery?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}&page=${page}&limit=${PAGE_SIZE}`
      );
      total = data.total || 0;
      render(data.records || []);
      renderPager();
    } catch (e) {
      toast('加载失败');
    }
  }

  function render(records) {
    document.getElementById('totalTip').textContent = `共 ${total} 局`;
    const el = document.getElementById('list');
    if (!records.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无公开棋谱</div>';
      return;
    }
    el.innerHTML = records.map((r) => {
      const m = r.meta || {};
      // 名称：管理员可覆盖展示名
      const names = (m.nameOverrides && (m.nameOverrides.b || m.nameOverrides.w))
        ? [m.nameOverrides.b || r.names[0], m.nameOverrides.w || r.names[1]]
        : (r.names || ['先手', '後手']);
      const res = r.result === 'b' ? `${names[0]} 胜`
        : r.result === 'w' ? `${names[1]} 胜`
          : (r.resultDetail || '和棋');
      const title = m.title
        ? `<div style="font-size:15px;font-weight:800;margin-bottom:4px;">⭐ ${esc(m.title)}</div>`
        : '';
      const eventLine = [m.event, m.round, m.playedOn].filter(Boolean).join(' · ');
      const tags = (m.tags || []).length
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${m.tags.map((t) => `<span style="font-size:11px;color:var(--gold-light);background:rgba(201,162,39,0.12);border-radius:6px;padding:2px 8px;">${esc(t)}</span>`).join('')}</div>`
        : '';
      const desc = m.description
        ? `<div style="font-size:12px;color:var(--text-dim);margin-top:6px;line-height:1.6;">${esc(m.description)}</div>`
        : '';
      return `
        <div class="record-item" data-href="review.html?id=${r.id}">
          ${title}
          <div style="font-size:14px;">${esc(names[0])} <span style="color:var(--text-dim);font-size:12px;">vs</span> ${esc(names[1])}</div>
          <div class="r-result ${r.result === 'b' || r.result === 'w' ? 'result-win' : 'result-draw'}">${esc(res)} <span style="color:var(--text-dim);font-size:12px;">（${r.moveCount} 手）</span></div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${eventLine ? esc(eventLine) + ' · ' : ''}${I18N.fmtDate(r.createdAt)}</div>
          ${desc}${tags}
        </div>
      `;
    }).join('');

    // 用首屏数据补齐标签下拉（无专门接口，够用）
    const seen = new Set();
    records.forEach((r) => ((r.meta && r.meta.tags) || []).forEach((t) => seen.add(t)));
    if (seen.size) {
      const cur = tagEl.value;
      seen.forEach((t) => {
        if (![...tagEl.options].some((o) => o.value === t)) {
          const op = document.createElement('option');
          op.value = t;
          op.textContent = t;
          tagEl.appendChild(op);
        }
      });
      tagEl.value = cur;
    }
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const el = document.getElementById('pager');
    if (pages <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="prevPage" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span style="font-size:13px;color:var(--text-dim);">${page} / ${pages}</span>
      <button class="btn btn-ghost btn-sm" id="nextPage" ${page >= pages ? 'disabled' : ''}>下一页</button>
    `;
    document.getElementById('prevPage').onclick = () => { page -= 1; load(); };
    document.getElementById('nextPage').onclick = () => { page += 1; load(); };
  }

  document.getElementById('btnSearch').addEventListener('click', () => { page = 1; load(); });
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; load(); } });
  tagEl.addEventListener('change', () => { page = 1; load(); });

  load();
})();
