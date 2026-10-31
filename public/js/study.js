'use strict';

/**
 * study.js — 开局统计 + 研究收藏（1.9）。
 * 开局统计只读公开棋谱摘要列；研究收藏按账号私有/公开保存棋谱链接。
 */
(function (global) {
  'use strict';
  const UI = global.UI;

  const View = {
    title: '研究 · TDShogi',
    render() {
      return `
  <main class="container">
    <div class="card pz-card">
      <div class="pz-head">
        <div>
          <div class="pz-title">开局统计</div>
          <div class="pz-sub" id="studyStats">按战法 / 围玉标签统计公开棋谱。</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--text-dim);">按战法 / 围玉聚合</span>
          <a class="btn btn-ghost btn-sm" href="gallery.html">棋谱广场</a>
        </div>
      </div>
      <div id="studyList"><div class="pz-placeholder">加载中…</div></div>
      <div class="pz-hint">统计只包含公开棋谱中带有「开局 / 战法 / 围玉」标签的对局；未标注棋谱归入未分类，不参与榜单。</div>
    </div>

    <div class="card pz-card" style="margin-top:16px;">
      <div class="pz-head">
        <div>
          <div class="pz-title">研究收藏</div>
          <div class="pz-sub">把棋谱整理成研究；公开研究所有人可看，私密研究仅自己可见。</div>
        </div>
      </div>
      <div id="studyGuest" class="pz-placeholder" style="display:none;">登录账号后可创建研究；游客可以浏览公开研究。</div>
      <div id="studyCollection">
        <div class="fr-toolbar" id="studyCreateRow">
          <input class="input" id="studyTitle" placeholder="研究标题" style="max-width:220px;">
          <select class="input" id="studyVisibility" style="max-width:120px;"><option value="private">私密</option><option value="public">公开</option></select>
          <button class="btn btn-primary btn-sm" id="studyCreate">新建研究</button>
        </div>
        <div id="studyStudies"><div class="fr-empty">加载中…</div></div>
        <div id="studyDetail" style="display:none;margin-top:12px;border-top:1px solid var(--border);padding-top:10px;"></div>
      </div>
    </div>
  </main>`;
    },
    mount() {
      this._teardown = [];
      let alive = true;
      const teardown = this._teardown;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      const guest = global.NAV.getGuest();
      const isAccount = typeof guest.id === 'string' && guest.id.includes('.');
      const token = isAccount ? guest.id : '';
      const q = token ? `token=${encodeURIComponent(token)}` : '';
      let openId = null;

      async function apiGet(path) {
        const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}${q}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || `请求失败（HTTP ${r.status}）`);
        return d;
      }
      async function apiPost(path, body) {
        const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token }, body || {})) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || `请求失败（HTTP ${r.status}）`);
        return d;
      }
      async function apiDelete(path) {
        const r = await fetch(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || `请求失败（HTTP ${r.status}）`);
        return d;
      }

      async function loadOpenings() {
        try {
          const r = await fetch('/api/studies/openings?limit=20');
          const d = await r.json().catch(() => ({}));
          if (!alive) return;
          if (!r.ok || d.ok === false) {
            $('studyList').innerHTML = `<div class="pz-placeholder">${esc(d.error || '加载失败')}</div>`;
            return;
          }
          $('studyStats').textContent = `公开棋谱 · 已标注 ${d.total || 0} 局 / 共 ${d.publicTotal || 0} 局${d.untagged ? ` · 未分类 ${d.untagged}` : ''}`;
          const list = d.list || [];
          $('studyList').innerHTML = list.length ? `
            <div style="display:grid;grid-template-columns:56px 1fr 70px 90px;gap:8px;font-size:11px;color:var(--text-dim);padding:6px 0;border-bottom:1px solid var(--border);">
              <span>#</span><span>战法 / 围玉</span><span>局数</span><span>先手胜率</span>
            </div>
            ${list.map((x, i) => `
              <div style="display:grid;grid-template-columns:56px 1fr 70px 90px;gap:8px;align-items:center;font-size:13px;padding:8px 0;border-bottom:1px dashed var(--border);">
                <span style="color:var(--gold-light);">${i + 1}</span>
                <a href="/gallery?opening=${encodeURIComponent(x.tag)}" style="font-size:13px;color:var(--text);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="查看该战法的公开棋谱：${esc(x.tag)}">${esc(x.tag)}</a>
                <span>${x.count}</span>
                <span><b style="color:var(--gold-light);">${x.blackRate === null ? '—' : `${x.blackRate}%`}</b> <span style="font-size:11px;color:var(--text-dim);">(先 ${x.blackWins} / 后 ${x.whiteWins}${x.draws ? ` / 和 ${x.draws}` : ''})</span></span>
              </div>`).join('')}` : '<div class="pz-placeholder">暂无公开棋谱数据。</div>';
        } catch (_) {
          if (alive) $('studyList').innerHTML = '<div class="pz-placeholder">加载失败，请稍后重试。</div>';
        }
      }

      async function loadStudies() {
        if (!isAccount) $('studyCreateRow').style.display = 'none';
        try {
          const d = await apiGet('/api/studies');
          if (!alive) return;
          const list = d.studies || [];
          $('studyStudies').innerHTML = list.length ? list.map((st) => `
            <div class="fr-row">
              <div class="fr-who"><b>${esc(st.title)}</b><span>${st.visibility === 'public' ? '公开' : '私密'} · ${st.itemCount || 0} 条${st.mine ? ' · 我的' : ''}</span></div>
              <button class="btn btn-ghost btn-sm" data-study-open="${esc(st.id)}" type="button">打开</button>
              ${st.mine ? `<button class="btn btn-ghost btn-sm" data-study-del="${esc(st.id)}" type="button" style="color:var(--red-light);">删除</button>` : ''}
            </div>`).join('') : '<div class="fr-empty">还没有研究。</div>';
        } catch (e) {
          if (alive) $('studyStudies').innerHTML = `<div class="fr-empty">${esc(e.message)}</div>`;
        }
      }

      async function openStudy(id) {
        openId = id;
        try {
          const d = await apiGet(`/api/studies/${encodeURIComponent(id)}`);
          if (!alive) return;
          const st = d.study;
          const items = d.items || [];
          $('studyDetail').style.display = '';
          $('studyDetail').innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <div style="flex:1;font-size:14px;font-weight:800;color:var(--gold-light);">${esc(st.title)} <span style="font-size:11px;color:var(--text-dim);font-weight:400;">${st.visibility === 'public' ? '公开' : '私密'}</span></div>
              <button class="btn btn-ghost btn-sm" data-study-close type="button">收起</button>
            </div>
            ${items.length ? items.map((it) => {
              const r = it.record;
              const label = r ? `${(r.names || []).join(' vs ')} · ${r.moveCount} 手` : it.recordId;
              return `<div class="fr-row"><div class="fr-who"><b>${esc(label)}</b><span>${esc(it.note || '')}${it.ply ? ` · 第 ${it.ply} 手` : ''}</span></div>
                ${r ? `<a class="btn btn-ghost btn-sm" href="review.html?id=${encodeURIComponent(r.id)}">复盘</a>` : ''}
                ${d.mine ? `<button class="btn btn-ghost btn-sm" data-study-item-del="${esc(it.recordId)}" data-ply="${it.ply}" type="button" style="color:var(--red-light);">移除</button>` : ''}</div>`;
            }).join('') : '<div class="fr-empty">还没有收藏棋谱。</div>'}
            ${d.mine ? `<div class="fr-toolbar" style="margin-top:10px;">
              <input class="input" id="studyRecordId" placeholder="棋谱 ID" style="max-width:200px;">
              <input class="input" id="studyPly" placeholder="手数（可选）" style="max-width:110px;">
              <input class="input" id="studyNote" placeholder="备注（可选）" style="max-width:200px;">
              <button class="btn btn-primary btn-sm" id="studyAddItem" type="button">收藏棋谱</button>
            </div>` : ''}`;
        } catch (e) { toast(e.message); }
      }

      async function createStudy() {
        const title = ($('studyTitle') && $('studyTitle').value || '').trim();
        if (!title) return toast('请输入研究标题');
        try {
          const d = await apiPost('/api/studies', { title, visibility: $('studyVisibility').value });
          toast('研究已创建');
          await loadStudies();
          if (d.study) openStudy(d.study.id);
        } catch (e) { toast(e.message); }
      }

      async function addItem() {
        if (!openId) return;
        const recordId = ($('studyRecordId') && $('studyRecordId').value || '').trim();
        if (!recordId) return toast('请输入棋谱 ID');
        try {
          await apiPost(`/api/studies/${encodeURIComponent(openId)}/items`, {
            recordId,
            ply: Number(($('studyPly') && $('studyPly').value) || 0),
            note: ($('studyNote') && $('studyNote').value) || '',
          });
          toast('已收藏');
          await openStudy(openId);
          await loadStudies();
        } catch (e) { toast(e.message); }
      }

      const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); teardown.push(() => el.removeEventListener(ev, fn)); };
      on($('studyCreate'), 'click', createStudy);
      const collection = $('studyCollection');
      if (collection) {
        const onClick = async (e) => {
          const open = e.target.closest && e.target.closest('[data-study-open]');
          if (open) return openStudy(open.getAttribute('data-study-open'));
          const del = e.target.closest && e.target.closest('[data-study-del]');
          if (del) {
            if (!global.confirm('确认删除这个研究？')) return;
            try { await apiDelete(`/api/studies/${encodeURIComponent(del.getAttribute('data-study-del'))}`); toast('已删除'); openId = null; $('studyDetail').style.display = 'none'; await loadStudies(); } catch (err) { toast(err.message); }
            return;
          }
          const close = e.target.closest && e.target.closest('[data-study-close]');
          if (close) { $('studyDetail').style.display = 'none'; openId = null; return; }
          const itemDel = e.target.closest && e.target.closest('[data-study-item-del]');
          if (itemDel && openId) {
            try {
              await apiDelete(`/api/studies/${encodeURIComponent(openId)}/items/${encodeURIComponent(itemDel.getAttribute('data-study-item-del'))}?ply=${itemDel.getAttribute('data-ply')}`);
              toast('已移除'); await openStudy(openId); await loadStudies();
            } catch (err) { toast(err.message); }
            return;
          }
          const add = e.target.closest && e.target.closest('#studyAddItem');
          if (add) addItem();
        };
        collection.addEventListener('click', onClick);
        teardown.push(() => collection.removeEventListener('click', onClick));
      }

      teardown.push(() => { alive = false; });
      loadOpenings();
      loadStudies();
    },
    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.study = View;
})(window);
