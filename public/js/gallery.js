/**
 * gallery.js — 棋谱广场 View（PLAN §L5）
 *
 * 公开棋谱列表：关键词/标签筛选 + 分页，点击进入复盘页（review.html）。
 * 数据源 GET /api/gallery（服务端只返回 visibility=public 的棋谱）。
 *
 * SPA 迁移：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 gallery.html 的主体，逐字保留）
 *   mount(container, params)→ 原 IIFE 主体逻辑：筛选/分页/列表渲染，监听记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 遵循 home.js 范式：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改用 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（本页无 /api/… 导出下载链接）。
 *   - 所有事件监听统一在 unmount 清理。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '棋谱广场 · TDShogi',

    render() {
      // —— 原 gallery.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <div class="section-title" style="font-size:24px;">🏆 棋谱广场</div>
    <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px;">
      管理员精选的公开棋谱（赛事名局、经典对局）。点击任一局进入复盘。
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center;">
      <input class="input" id="q" placeholder="搜索双方名 / 标题 / 赛事" style="max-width:280px;">
      <select class="input" id="tagSel" style="max-width:180px;">
        <option value="">全部标签</option>
      </select>
      <button class="btn btn-primary btn-sm" id="btnSearch">搜索</button>
      <span id="totalTip" style="color:var(--text-dim);font-size:12px;"></span>
    </div>

    <div id="list"></div>

    <div id="pager" style="display:flex;gap:10px;justify-content:center;align-items:center;margin-top:18px;"></div>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      const guest = global.NAV.getGuest(); // 替代原 NAV.renderNav('gallery')
      const api = global.API;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      const PAGE_SIZE = 20;
      let page = 1;
      let total = 0;

      const qEl = $('q');
      const tagEl = $('tagSel');

      async function load() {
        const q = (qEl.value || '').trim();
        const tag = tagEl.value || '';
        try {
          const data = await global.ApiUtils.get(
            `/api/gallery?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}&page=${page}&limit=${PAGE_SIZE}`
          );
          total = data.total || 0;
          renderList(data.records || []);
          renderPager();
        } catch (e) {
          toast('加载失败');
        }
      }

      function renderList(records) {
        $('totalTip').textContent = `共 ${total} 局`;
        const el = $('list');
        if (!el) return;
        if (!records.length) {
          // ⚠️ 2026-10-02 体验修复：空结果给引导（此前只有干巴巴一句「暂无公开棋谱」，
          // 分不清是「本来没有」还是「被筛选条件滤空了」）
          const hasFilter = !!(qEl.value || '').trim() || !!tagEl.value;
          el.innerHTML = hasFilter
            ? '<div style="color:var(--text-dim);font-size:13px;">没有符合条件的棋谱。可<a href="gallery.html" data-act="gallery-clear">清除筛选</a>后重试，或换更短的关键词。</div>'
            : '<div style="color:var(--text-dim);font-size:13px;">暂无公开棋谱。对局结束后在复盘页把棋谱设为「公开」，就会出现在这里。</div>';
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
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          ${title}
          <div style="font-size:14px;">${esc(names[0])} <span style="color:var(--text-dim);font-size:12px;">vs</span> ${esc(names[1])}</div>
          <div class="r-result ${r.result === 'b' || r.result === 'w' ? 'result-win' : 'result-draw'}">${esc(res)} <span style="color:var(--text-dim);font-size:12px;">（${r.moveCount} 手）</span></div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${eventLine ? esc(eventLine) + ' · ' : ''}${global.I18N.fmtDate(r.createdAt)}</div>
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
        const el = $('pager');
        if (!el) return;
        if (pages <= 1) { el.innerHTML = ''; return; }
        el.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="prevPage" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span style="font-size:13px;color:var(--text-dim);">${page} / ${pages}</span>
      <button class="btn btn-ghost btn-sm" id="nextPage" ${page >= pages ? 'disabled' : ''}>下一页</button>
    `;
        $('prevPage').onclick = () => { page -= 1; load(); };
        $('nextPage').onclick = () => { page += 1; load(); };
      }

      // —— 事件绑定（句柄记进 _teardown，unmount 全部解绑）——
      const btnSearch = $('btnSearch');
      const onSearch = () => { page = 1; load(); };
      if (btnSearch) {
        btnSearch.addEventListener('click', onSearch);
        this._teardown.push(() => btnSearch.removeEventListener('click', onSearch));
      }

      const onQKeydown = (e) => { if (e.key === 'Enter') { page = 1; load(); } };
      if (qEl) {
        qEl.addEventListener('keydown', onQKeydown);
        this._teardown.push(() => qEl.removeEventListener('keydown', onQKeydown));
      }

      const onTagChange = () => { page = 1; load(); };
      if (tagEl) {
        tagEl.addEventListener('change', onTagChange);
        this._teardown.push(() => tagEl.removeEventListener('change', onTagChange));
      }

      // 空结果里的「清除筛选」链接：SPA 下 Router.navigate('gallery.html') 与当前同址
      // 不会重挂（筛选是输入框里的客户端状态，不进 URL），需就地清空筛选重查。
      const listEl = $('list');
      const onListClick = (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[data-act="gallery-clear"]');
        if (!a) return;
        e.preventDefault();
        if (qEl) qEl.value = '';
        if (tagEl) tagEl.value = '';
        page = 1;
        load();
      };
      if (listEl) {
        listEl.addEventListener('click', onListClick);
        this._teardown.push(() => listEl.removeEventListener('click', onListClick));
      }

      load();
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.gallery = View;
})(window);
