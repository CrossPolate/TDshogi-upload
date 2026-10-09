/**
 * admin-records.js — 全部棋谱（admin 子模块）：KIF 导入、列表、搜索、回放/导出、就地编辑展示信息
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.records`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定 DOM 事件、导出 loadRecords / 就地编辑等到 ctx.hub，句柄记内部 teardown
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * 共用工具（token / $ / esc / maskIp / 分页 / AdminUI）由 admin.js 的 mount 通过 `ctx` 注入。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, renderPaged, setToken, toast, hub } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();

    // ---- 导入 KIF ----
    on($('btnImportKif'), 'click', () => {
      const fi = $('kifFileInput');
      if (fi) fi.click();
    });
    on($('kifFileInput'), 'change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      let okCount = 0, failCount = 0;
      const resultEl = $('importResult');
      if (resultEl) resultEl.textContent = `正在导入 ${files.length} 个棋谱...`;
      for (const file of files) {
        const text = await file.text();
        if (!alive()) return;
        try {
          const res = await fetch('/api/admin/records/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
            body: JSON.stringify({ text }),
          });
          if (!alive()) return;
          const data = await res.json();
          if (res.ok && data.ok) okCount++;
          else failCount++;
        } catch (_) { failCount++; }
      }
      if (!alive()) return;
      if (resultEl) resultEl.textContent = `导入完成：成功 ${okCount}，失败 ${failCount}`;
      e.target.value = '';
      loadRecords();
      if (failCount === 0 && okCount > 0) toast(`成功导入 ${okCount} 个棋谱`);
      else if (failCount > 0) toast(`导入完成：${okCount} 成功 / ${failCount} 失败`);
    });

    // ---- 全部棋谱 ----
    let allRecords = [];

    // ⚠️ 2026-10-02 体验修复（刷新按钮）：棋谱列表此前**没有**手动刷新入口——
    // 导完 KIF 或别处改了数据后，只能切走再切回来。这里补一个（每次 mount 绑一次）。
    on($('btnRefreshRecords'), 'click', () => loadRecords());

    async function loadRecords() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位，别让点开 tab 的头几百毫秒是空白
      const box = $('adminRecordList');
      if (box) box.innerHTML = ctx.AdminUI ? ctx.AdminUI.loading('正在加载棋谱…') : '';
      try {
        const data = await global.ApiUtils.get(`/api/history?adminToken=${encodeURIComponent(getToken())}`);
        if (!alive()) return;
        allRecords = data.records || [];
        renderPaged('records', allRecords, 'recordPager', renderRecords);
      } catch (e) {
        if (!alive()) return;
        // token 失效则回到登录
        if (e.message && e.message.includes('403')) setToken(null);
        toast('加载棋谱失败');
        if (box) box.innerHTML = ctx.AdminUI
          ? ctx.AdminUI.empty('加载棋谱失败，请确认登录状态后点「刷新」重试') : '';
        if (hub.initUI) hub.initUI();
      }
    }

    function renderRecords(records) {
      // ⚠️ 2026-10-02 体验修复：标题用**总数**（此前用当页条数，恒 ≤20）
      const cnt = $('recordCount');
      if (cnt) cnt.textContent = allRecords.length;
      const el = $('adminRecordList');
      if (!el) return;
      if (!records.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来没有"与"被搜索筛空"
        const q = ($('recordSearch') || {}).value || '';
        const msg = q.trim() ? '没有匹配关键词的棋谱（清空搜索框可看全部）' : '暂无棋谱';
        el.innerHTML = ctx.AdminUI ? ctx.AdminUI.empty(msg) : '';
        return;
      }
      el.innerHTML = records.map((r) => {
        const names = r.names || ['先手', '後手'];
        const res = r.result === 'b' ? `${names[0]} 胜` : r.result === 'w' ? `${names[1]} 胜` : (r.resultDetail || '和棋');
        // ⚠️ 2026-10-02 体验修复（"点完没有可见变化"）：把**可编辑的展示信息渲染出来**。
        // 此前列表只显示双方名与结果——管理员改完标题/标签/置顶后刷新列表，行内容一字不变，
        // 看起来就像"编辑没生效"。现在保存后这一行会立刻出现新标题/标签/📌。
        const m = r.meta || {};
        const metaBits = [];
        if (m.title) metaBits.push(esc(m.title));
        if (m.event) metaBits.push(esc(m.event));
        if (m.tags && m.tags.length) metaBits.push(m.tags.map((t) => `#${esc(t)}`).join(' '));
        const metaHtml = (m.featured || metaBits.length)
          ? `<div style="font-size:11px;color:var(--gold-light);margin-top:2px;">${m.featured ? '📌 ' : ''}${metaBits.join(' · ')}</div>` : '';
        return `
          <div class="record-item" data-rec-item="${esc(r.id)}">
            <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])} <span style="color:var(--text-dim);font-size:11px;">（${r.moveCount || 0}手）</span></div>
            <div class="r-result result-win">${esc(res)}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${global.I18N.fmt(r.createdAt)}</div>
            ${metaHtml}
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" data-act="rb-playback" data-id="${esc(r.id)}">回放</button>
              <button class="btn btn-ghost btn-sm" data-act="rb-export" data-id="${esc(r.id)}" data-fmt="kif">KIF</button>
              <button class="btn btn-ghost btn-sm" data-act="rb-export" data-id="${esc(r.id)}" data-fmt="csa">CSA</button>
              <button class="btn btn-ghost btn-sm" data-act="record-edit" data-id="${esc(r.id)}">✏️ 编辑</button>
            </div>
            <div data-rec-edit="${esc(r.id)}" style="display:none;margin-top:8px;"></div>
          </div>
        `;
      }).join('');
    }

    // ==================================================================
    // ⚠️ 2026-10-02 体验修复（棋谱就地编辑入口）
    //
    // 后端 `/api/admin/records/:id/meta`（写标题/赛事/轮次/日期/标签/简介/结果说明/置顶）
    // 早就存在并带审计，但管理端**完全没有入口**——只有靠手调 API。这里补一个就地表单：
    // 点「✏️ 编辑」在本行展开，保存后 toast + 重拉列表（改动能当场看见）。
    //
    // ⚠️ 关于「editArchived 无变化」：那是**赛事**的归档编辑（前端入口在
    // `public/js/tournament.js` 的 btnEditNoteTn → `/api/admin/tournaments/:id/edit`），
    // 不在本次改动的文件白名单内，故未改动；本条只负责棋谱（records）一侧的编辑入口与反馈，
    // 并把"保存后可见变化 + 成功/失败提示 + 列表刷新"这套反馈范式落实到本页。
    // ==================================================================
    const REC_META_FIELDS = [
      ['title', '标题'],
      ['event', '赛事'],
      ['round', '轮次'],
      ['playedOn', '日期'],
      ['description', '简介'],
      ['resultNote', '结果说明'],
    ];

    /** 按 data-rec-edit 精确找容器（不用属性选择器拼 id，避免 id 里出现特殊字符时选择器报错） */
    function findEditBox(id) {
      const boxes = document.querySelectorAll('[data-rec-edit]');
      for (const b of boxes) if (b.getAttribute('data-rec-edit') === String(id)) return b;
      return null;
    }

    function findRecord(id) {
      return allRecords.find((r) => String(r.id) === String(id)) || null;
    }

    /** 展开 / 收起某一行的就地编辑表单 */
    hub.adminRecordEdit = (id) => {
      const box = findEditBox(id);
      if (!box) return;
      if (box.style.display !== 'none' && box.innerHTML.trim()) { box.style.display = 'none'; return; }
      const r = findRecord(id);
      if (!r) return toast('未找到该棋谱（列表可能已刷新，请重试）');
      const m = r.meta || {};
      const fields = REC_META_FIELDS.map(([k, label]) =>
        `<label style="font-size:11px;color:var(--text-dim);display:block;">${label}
          <input class="input" data-rec-field="${k}" value="${esc(m[k] || '')}" style="width:100%;padding:5px 8px;font-size:12px;margin-top:2px;"></label>`).join('');
      box.innerHTML = `
        <div class="card" style="padding:12px;background:var(--bg-2);">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">
            编辑展示信息（仅管理员；保存会记入审计日志）。留空即清除该字段。
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;">${fields}</div>
          <label style="font-size:11px;color:var(--text-dim);display:block;margin-top:8px;">标签（逗号分隔，最多 10 个）
            <input class="input" data-rec-field="tags" value="${esc((m.tags || []).join(', '))}" style="width:100%;padding:5px 8px;font-size:12px;margin-top:2px;"></label>
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin:8px 0 10px;">
            <input type="checkbox" data-rec-field="featured" ${m.featured ? 'checked' : ''}> 置顶（广场优先展示）
          </label>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary btn-sm" data-act="record-edit-save" data-id="${esc(id)}">保存</button>
            <button class="btn btn-ghost btn-sm" data-act="record-edit-cancel" data-id="${esc(id)}">取消</button>
          </div>
        </div>`;
      box.style.display = 'block';
      if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    };

    /** 取消编辑：收起表单即可（不改数据） */
    hub.adminRecordEditCancel = (id) => {
      const box = findEditBox(id);
      if (box) box.style.display = 'none';
    };

    /** 读表单 → 组装 patch（仅允许字段；字段名与 src/records.js 的 META_FIELDS 对齐） */
    function readEditBox(box) {
      const patch = {};
      box.querySelectorAll('[data-rec-field]').forEach((el) => {
        const k = el.getAttribute('data-rec-field');
        if (k === 'featured') patch.featured = el.checked;
        else if (k === 'tags') patch.tags = el.value.split(',').map((s) => s.trim()).filter(Boolean);
        else patch[k] = el.value;
      });
      return patch;
    }

    hub.adminRecordSave = async (id) => {
      const box = findEditBox(id);
      if (!box) return;
      const r = findRecord(id);
      const who = (r && r.names ? r.names.join(' vs ') : id);
      // ⚠️ 2026-10-02 体验修复（危险操作确认）：保存会**覆盖**既有展示信息（且影响公开广场），
      // 先给一次二次确认；确认框里带上"改的是哪盘"避免看错行。
      if (!confirm(`确定保存对棋谱「${who}」的展示信息修改？`)) return;
      try {
        const res = await fetch(`/api/admin/records/${encodeURIComponent(id)}/meta`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken() },
          body: JSON.stringify(readEditBox(box)),
        });
        if (!alive()) return;
        const data = await res.json().catch(() => ({}));
        if (!alive()) return;
        if (res.status === 403 || res.status === 401) {
          setToken(null);
          toast('登录已过期，请重新登录');
          if (hub.initUI) hub.initUI();
          return;
        }
        if (!res.ok || data.ok === false) {
          // 失败也要说清楚（含后端返回的原因，如"棋谱不存在"）
          toast((data && data.error) || `保存失败（HTTP ${res.status}）`);
          return;
        }
        // 成功：toast + 收起表单 + 重拉列表（列表里会出现新标题/标签/📌，肉眼可见）
        toast('棋谱展示信息已保存');
        box.style.display = 'none';
        await loadRecords();
      } catch (e) {
        if (!alive()) return;
        toast('保存失败：' + e.message);
      }
    };

    // 回放/导出必须携带管理员 token（否则 403）
    hub.adminPlayback = (id) => {
      // 站内整页跳转 → SPA 路由（铁律3）
      global.Router.navigate(`review.html?id=${id}&adminToken=${encodeURIComponent(getToken() || '')}`);
    };
    hub.adminExport = (id, fmt) => {
      // ⚠️ 例外（铁律3）：指向 /api/... 的导出/下载链接保留 location.href（那是下载不是跳页）
      location.href = `/api/records/${id}/export?fmt=${fmt}&token=${encodeURIComponent(getToken() || '')}`;
    };

    // 棋谱搜索（按选手名/ID）
    on($('recordSearch'), 'input', (e) => {
      const q = (e.target.value || '').trim().toLowerCase();
      if (!q) return renderPaged('records', allRecords, 'recordPager', renderRecords, true);
      renderPaged('records', allRecords.filter((r) => {
        const names = (r.names || []).join(' ').toLowerCase();
        const ids = [r.playerIds && r.playerIds.b, r.playerIds && r.playerIds.w].filter(Boolean).join(' ').toLowerCase();
        return names.includes(q) || ids.includes(q);
      }), 'recordPager', renderRecords, true);
    });

    // ---- 供其它模块调用（admin.js 装配，见该文件）----
    hub.loadRecords = loadRecords;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.records = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);
