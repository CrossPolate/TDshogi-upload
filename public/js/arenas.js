'use strict';

/**
 * arenas.js — Arena-lite 竞技场（1.8）。
 * 时间窗口内自由加入，服务端按积分每 N 分钟配对；页面只做列表 / 详情 / 加入退出。
 */
(function (global) {
  'use strict';
  const UI = global.UI;

  function accountToken() {
    const g = global.NAV && global.NAV.getGuest ? global.NAV.getGuest() : null;
    return g && typeof g.id === 'string' && g.id.includes('.') ? g.id : '';
  }

  const statusClass = (s) => (s === 'running' ? 'live' : s === 'open' ? 'open' : s === 'finished' ? 'done' : 'cancelled');

  function pad(n) { return String(n).padStart(2, '0'); }

  /** 时间戳 → datetime-local 需要的本地字符串 */
  function localInput(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmt(ts) {
    if (!ts) return '—';
    return global.I18N && global.I18N.fmt ? global.I18N.fmt(ts) : new Date(ts).toLocaleString();
  }

  function T(s, vars) {
    return global.I18N && global.I18N.t ? global.I18N.t(s, vars) : s;
  }


  const View = {
    title: '竞技场 · TDShogi',

    render() {
      return `
  <main class="container">
    <div class="card arena-hero">
      <div class="arena-hero-head">
        <div>
          <div class="section-title" style="margin-bottom:6px;">竞技场</div>
          <div class="arena-sub">时间窗口内自由加入，按积分自动配对 · 时制由主办人选择 · 不计 ELO</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="arenaRefresh" type="button">刷新</button>
      </div>

      <div id="arenaGuest" class="arena-guest" style="display:none;">登录正式账号后可以创建 / 加入竞技场。</div>

      <div id="arenaCreate" class="arena-create" style="display:none;">
        <div class="arena-form">
          <label class="arena-field"><span>名称</span><input class="input" id="arenaName" maxlength="20" placeholder="如：周末快棋竞技场"></label>
          <label class="arena-field"><span>开始</span><input class="input" id="arenaStart" type="datetime-local"></label>
          <label class="arena-field"><span>结束</span><input class="input" id="arenaEnd" type="datetime-local"></label>
          <label class="arena-field"><span>配对间隔</span>
            <select class="input" id="arenaEvery">
              <option value="3">3 分钟</option><option value="5" selected>5 分钟</option>
              <option value="10">10 分钟</option><option value="15">15 分钟</option>
            </select>
          </label>
          <label class="arena-field"><span>对局时制</span>
            <select class="input" id="arenaTc">
              <option value="10:00" selected>10 分钟包干</option>
              <option value="10+30">10 分 + 30 秒</option>
              <option value="15+60">15 分 + 60 秒</option>
              <option value="10sec">10 秒快棋</option>
            </select>
          </label>
          <button class="btn btn-primary btn-sm" id="arenaCreateBtn" type="button">创建竞技场</button>
        </div>
        <div class="arena-hint">到开始时间自动开赛、到结束时间停止配对。对局中退出需先完成或认输。</div>
      </div>
    </div>

    <div id="arenaDetail"></div>
    <div class="section-title" style="margin-top:22px;">全部竞技场</div>
    <div id="arenaList"><div class="pz-placeholder">加载中…</div></div>
  </main>`;
    },

    mount(container, params) {
      this._teardown = [];
      let alive = true;
      const teardown = this._teardown;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      const token = accountToken();
      const isAccount = !!token;
      let listTimer = null;
      let detailTimer = null;
      let lastListJson = '';
      let lastDetailJson = '';
      const selectedId = (params && params.id) || '';

      teardown.push(() => {
        alive = false;
        if (listTimer) clearInterval(listTimer);
        if (detailTimer) clearInterval(detailTimer);
      });

      async function api(path, opts = {}) {
        const headers = Object.assign({}, opts.headers || {});
        if (token) headers['X-Account-Token'] = token;
        if (opts.body) headers['Content-Type'] = 'application/json';
        const r = await fetch(path, Object.assign({}, opts, { headers }));
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || `请求失败（HTTP ${r.status}）`);
        return d;
      }

      function defaultTimes() {
        const now = Date.now();
        const start = Math.ceil((now + 5 * 60 * 1000) / (5 * 60 * 1000)) * 5 * 60 * 1000;
        $('arenaStart').value = localInput(start);
        $('arenaEnd').value = localInput(start + 2 * 60 * 60 * 1000);
      }

      function joinButton(a) {
        if (!isAccount || a.status === 'finished' || a.status === 'cancelled') return '';
        if (a.joined) return `<button class="btn btn-ghost btn-sm" type="button" data-arena-leave="${esc(a.id)}">退出</button>`;
        return `<button class="btn btn-primary btn-sm" type="button" data-arena-join="${esc(a.id)}">加入</button>`;
      }

      function cardHtml(a) {
        const top = (a.top || []).map((x, i) => `${i + 1}. ${esc(x.name)} ${x.score}`).join(' · ');
        return `
          <div class="card arena-card">
            <div class="arena-card-head">
              <div style="min-width:0;">
                <div class="arena-name">
                  <a href="/arenas?id=${encodeURIComponent(a.id)}">${esc(a.name)}</a>
                  <span class="arena-status ${statusClass(a.status)}">${esc(T(a.statusLabel))}</span>
                  ${a.mine ? `<span class="arena-status mine">${T('我主办')}</span>` : ''}
                </div>
                <div class="arena-meta">${fmt(a.startsAt)} → ${fmt(a.endsAt)} · ${T('每 {n} 分钟配对', { n: a.roundMinutes })} · ${esc(T(a.timeControlName || ''))} · ${T('{n} 人', { n: a.entryCount })}${a.currentRound ? ` · ${T('第 {n} 轮', { n: a.currentRound })}` : ''}${a.status === 'running' && a.nextRoundAt ? ` · ${T('下一轮')} ${fmt(a.nextRoundAt)}` : ''}</div>
                ${top ? `<div class="arena-top">${top}</div>` : ''}
              </div>
              <div class="arena-card-actions">
                <a class="btn btn-ghost btn-sm" href="/arenas?id=${encodeURIComponent(a.id)}">详情</a>
                ${joinButton(a)}
              </div>
            </div>
          </div>`;
      }

      async function loadList() {
        try {
          const d = await api('/api/arenas');
          if (!alive) return;
          const list = d.arenas || [];
          const json = JSON.stringify(list);
          if (json === lastListJson) return;
          lastListJson = json;
          $('arenaList').innerHTML = list.length
            ? list.map(cardHtml).join('')
            : '<div class="pz-placeholder">还没有竞技场。登录后可以创建第一个。</div>';
        } catch (e) {
          if (alive) $('arenaList').innerHTML = `<div class="pz-placeholder">${esc(e.message)}</div>`;
        }
      }

      function standingsHtml(d) {
        const rows = (d.entries || []).map((e) => `
          <tr class="${d.me && d.me.id === e.id ? 'me' : ''}">
            <td>${e.rank}</td>
            <td class="name">${esc(e.name)}</td>
            <td><b>${e.score}</b></td>
            <td>${e.wins}</td><td>${e.draws}</td><td>${e.losses}</td>
          </tr>`).join('');
        return `
          <div class="arena-table-wrap">
            <table class="arena-table">
              <thead><tr><th>#</th><th>棋手</th><th>积分</th><th>胜</th><th>和</th><th>负</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">还没有参赛者</td></tr>'}</tbody>
            </table>
          </div>`;
      }

      function roundsHtml(d) {
        const rounds = (d.rounds || []).slice().reverse();
        if (!rounds.length) return '<div class="pz-placeholder">还没有开始配对。</div>';
        return rounds.map((r) => `
          <div class="arena-round">
            <div class="arena-round-head">第 ${r.round} 轮 <span>${fmt(r.at)}</span></div>
            ${r.pairs.map((p) => {
              const result = p.scored ? (p.winner === '-' ? '和棋' : `${esc(p.winnerName || '')} 胜`) : (p.roomId ? '对局中' : '未开局');
              return `<div class="arena-pair"><span>${esc(p.a)} vs ${esc(p.b)}</span><b class="${p.scored ? 'done' : ''}">${result}</b></div>`;
            }).join('')}
            ${r.bye ? `<div class="arena-pair bye"><span>轮空：${esc(r.bye)}</span><b>—</b></div>` : ''}
          </div>`).join('');
      }

      function detailHtml(d) {
        const mine = d.me && !d.me.withdrawnAt;
        const rank = mine ? (d.entries.find((e) => e.id === d.me.id) || {}).rank : null;
        return `
          <div class="card arena-detail">
            <div class="arena-detail-head">
              <div>
                <div class="arena-name" style="font-size:20px;">${esc(d.name)}
                  <span class="arena-status ${statusClass(d.status)}">${esc(T(d.statusLabel))}</span>
                </div>
                <div class="arena-meta">${T('主办')}：${esc(d.ownerName || '—')} · ${fmt(d.startsAt)} → ${fmt(d.endsAt)} · ${T('每 {n} 分钟配对', { n: d.roundMinutes })} · ${T('{n} 人', { n: d.entryCount })}${d.currentRound ? ` · ${T('第 {n} 轮', { n: d.currentRound })}` : ''}${d.status === 'running' && d.nextRoundAt ? ` · ${T('下一轮')} ${fmt(d.nextRoundAt)}` : ''}</div>
                <div class="arena-meta">${T('对局时制')}：${esc(T(d.timeControlName || ''))} · 不计 ELO${rank ? ` · 我的排名：第 ${rank} 名` : ''}</div>
              </div>
              <div class="arena-card-actions">
                ${joinButton({ ...d, joined: mine })}
                ${d.canManage && (d.status === 'open' || d.status === 'running') ? `<button class="btn btn-ghost btn-sm" type="button" data-arena-cancel="${esc(d.id)}" style="color:var(--red-light);">取消竞技场</button>` : ''}
              </div>
            </div>
            ${d.champion ? `<div class="arena-champion">🏆 冠军：${esc(d.champion.name)}</div>` : ''}
            <div class="arena-detail-grid">
              <div>
                <div class="arena-section-title">积分榜</div>
                ${standingsHtml(d)}
              </div>
              <div>
                <div class="arena-section-title">最近轮次</div>
                <div class="arena-rounds">${roundsHtml(d)}</div>
              </div>
            </div>
          </div>`;
      }

      async function loadDetail() {
        if (!selectedId) { $('arenaDetail').innerHTML = ''; return; }
        try {
          const d = await api(`/api/arenas/${encodeURIComponent(selectedId)}`);
          if (!alive) return;
          const json = JSON.stringify(d.arena);
          if (json === lastDetailJson) return;
          lastDetailJson = json;
          $('arenaDetail').innerHTML = detailHtml(d.arena);
        } catch (e) {
          if (alive) $('arenaDetail').innerHTML = `<div class="card arena-detail"><div class="pz-placeholder">${esc(e.message)}</div></div>`;
        }
      }

      async function act(path, okMsg) {
        try {
          await api(path, { method: 'POST', body: '{}' });
          if (okMsg) toast(okMsg);
          await Promise.all([loadList(), loadDetail()]);
        } catch (e) { toast(e.message); }
      }

      const onClick = (ev) => {
        const join = ev.target.closest('[data-arena-join]');
        if (join) { act(`/api/arenas/${encodeURIComponent(join.getAttribute('data-arena-join'))}/join`, '已加入竞技场'); return; }
        const leave = ev.target.closest('[data-arena-leave]');
        if (leave) { act(`/api/arenas/${encodeURIComponent(leave.getAttribute('data-arena-leave'))}/leave`, '已退出竞技场'); return; }
        const cancel = ev.target.closest('[data-arena-cancel]');
        if (cancel && global.confirm('确定取消该竞技场？')) {
          act(`/api/arenas/${encodeURIComponent(cancel.getAttribute('data-arena-cancel'))}/cancel`, '竞技场已取消');
        }
      };
      $('arenaList').addEventListener('click', onClick);
      $('arenaDetail').addEventListener('click', onClick);
      teardown.push(() => {
        $('arenaList').removeEventListener('click', onClick);
        $('arenaDetail').removeEventListener('click', onClick);
      });

      if (!isAccount) {
        $('arenaGuest').style.display = '';
      } else {
        $('arenaCreate').style.display = '';
        defaultTimes();
        const create = async () => {
          const startsAt = new Date($('arenaStart').value).getTime();
          const endsAt = new Date($('arenaEnd').value).getTime();
          if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) { toast('请选择开始与结束时间'); return; }
          try {
            const d = await api('/api/arenas', {
              method: 'POST',
              body: JSON.stringify({
                name: $('arenaName').value,
                startsAt,
                endsAt,
                roundMinutes: Number($('arenaEvery').value),
                timeControl: $('arenaTc').value,
              }),
            });
            toast('竞技场已创建');
            if (global.Router && global.Router.navigate) global.Router.navigate(`/arenas?id=${encodeURIComponent(d.arena.id)}`);
            else location.href = `/arenas?id=${encodeURIComponent(d.arena.id)}`;
          } catch (e) { toast(e.message); }
        };
        $('arenaCreateBtn').addEventListener('click', create);
        teardown.push(() => $('arenaCreateBtn').removeEventListener('click', create));

        // 等级特权与赛事同一门槛（Lv.5）：服务端仍会再校验，这里只负责把按钮状态说清楚。
        const applyPrivilege = (p, level) => {
          if (!p) return;
          const btn = $('arenaCreateBtn');
          if (p.ok) { btn.disabled = false; return; }
          btn.disabled = true;
          const hint = document.querySelector('.arena-hint');
          if (hint) hint.textContent = `创建竞技场需要 Lv.${p.need}（你当前 Lv.${level == null ? 0 : level}）。`;
        };
        if (global.API) applyPrivilege(global.API.privileges && global.API.privileges.create_tournament, global.API.level);
        if (global.API && global.API.on) {
          const off = global.API.on('hello', (d) => {
            if (d && d.privileges) applyPrivilege(d.privileges.create_tournament, d.level);
          });
          teardown.push(off);
        }
      }

      const refresh = () => { loadList(); if (selectedId) loadDetail(); };
      $('arenaRefresh').addEventListener('click', refresh);
      teardown.push(() => $('arenaRefresh').removeEventListener('click', refresh));

      loadList();
      loadDetail();
      listTimer = setInterval(loadList, 15000);
      if (selectedId) detailTimer = setInterval(loadDetail, 15000);
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.arenas = View;
})(window);
