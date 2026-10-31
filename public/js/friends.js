'use strict';

/**
 * friends.js — 好友 / 关注 / 拉黑 / 约战（1.7）。
 *
 * 所有写操作走 REST；WS 事件只用于提示和约战接受后的跳转。
 * 只有登录账号可使用；游客显示登录引导。
 */
(function (global) {
  'use strict';

  const UI = global.UI;
  const TC = [
    ['10:00', '10 分包干'],
    ['10+30', '10 分 + 30 秒'],
    ['15+60', '15 分 + 60 秒'],
    ['10sec', '10 秒快棋'],
  ];

  const View = {
    title: '好友与约战 · TDShogi',

    render() {
      return `
  <main class="container">
    <div class="card fr-card">
      <div class="fr-head">
        <div>
          <div class="fr-title">好友与约战</div>
          <div class="fr-sub" id="frStats">登录后可使用好友、关注和约战。</div>
        </div>
        <a class="btn btn-ghost btn-sm" href="profile.html">个人页</a>
      </div>

      <div id="frGuest" class="fr-placeholder" style="display:none;">
        好友功能需要正式账号。请先到个人页注册或登录。
      </div>

      <div id="frBody" style="display:none;">
        <div class="fr-toolbar">
          <input class="input" id="frTarget" placeholder="账号 ID 或用户名" style="max-width:240px;">
          <button class="btn btn-primary btn-sm" id="frAdd">加好友</button>
          <button class="btn btn-ghost btn-sm" id="frFollow">关注</button>
          <button class="btn btn-ghost btn-sm" id="frBlock" style="color:var(--red-light);">拉黑</button>
          <span style="margin-left:auto;font-size:12px;color:var(--text-dim);">约战时制</span>
          <select class="input" id="frTimeControl" style="max-width:150px;">
            ${TC.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
          </select>
        </div>

        <div class="fr-section">
          <div class="fr-section-title">好友</div>
          <div id="frFriends" class="fr-list"></div>
        </div>

        <div class="fr-section">
          <div class="fr-section-title">约战</div>
          <div id="frChallenges" class="fr-list"></div>
        </div>

        <div class="fr-section">
          <div class="fr-section-title">关注 / 粉丝</div>
          <div id="frFollows" class="fr-list"></div>
        </div>

        <div class="fr-section">
          <div class="fr-section-title">已拉黑</div>
          <div id="frBlocked" class="fr-list"></div>
        </div>
      </div>
    </div>
  </main>`;
    },

    mount() {
      this._teardown = [];
      let alive = true;
      const teardown = this._teardown;
      let timer = null;
      let data = null;
      teardown.push(() => { alive = false; if (timer) clearInterval(timer); });
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      const guest = global.NAV.getGuest();
      const isAccount = typeof guest.id === 'string' && guest.id.includes('.');
      const token = guest.id;
      const q = `token=${encodeURIComponent(token)}`;

      if (!isAccount) {
        $('frGuest').style.display = '';
        $('frBody').style.display = 'none';
        $('frStats').textContent = '当前为游客身份';
        return;
      }
      $('frGuest').style.display = 'none';
      $('frBody').style.display = '';

      async function apiGet(path) {
        const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}${q}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error((d && d.error) || `请求失败（HTTP ${r.status}）`);
        return d;
      }
      async function apiPost(path, body) {
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ token }, body || {})),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error((d && d.error) || `请求失败（HTTP ${r.status}）`);
        return d;
      }

      const avatar = (p) => {
        if (UI.avatarHtml) return UI.avatarHtml({ avatar: p && p.avatar, name: (p && p.name) || '?', size: 30 });
        return esc(((p && p.name) || '?').slice(0, 1));
      };
      const nameOf = (p) => esc((p && p.name) || (p && p.id) || '未知');
      const tcLabel = (id) => (TC.find((x) => x[0] === id) || [id, id])[1];

      function stats() {
        if (!data) return;
        const friends = data.friends.filter((f) => f.status === 'accepted');
        const online = friends.filter((f) => f.online).length;
        const pending = data.friends.filter((f) => f.status === 'pending' && f.incoming).length;
        $('frStats').textContent = `好友 ${friends.length} · 在线 ${online}${pending ? ` · 待处理申请 ${pending}` : ''}`;
      }

      function friendRow(f) {
        const p = f.profile || { id: f.id, name: f.id };
        const pending = f.status === 'pending';
        if (pending && f.incoming) {
          return `<div class="fr-row">
            ${avatar(p)}<div class="fr-who"><b>${nameOf(p)}</b><span>请求加你为好友</span></div>
            <button class="btn btn-primary btn-sm" data-fr-act="accept" data-id="${esc(f.id)}">接受</button>
            <button class="btn btn-ghost btn-sm" data-fr-act="reject" data-id="${esc(f.id)}">拒绝</button>
          </div>`;
        }
        if (pending) {
          return `<div class="fr-row">${avatar(p)}<div class="fr-who"><b>${nameOf(p)}</b><span>等待对方接受</span></div>
            <button class="btn btn-ghost btn-sm" data-fr-act="remove" data-id="${esc(f.id)}">取消</button></div>`;
        }
        return `<div class="fr-row">
          ${avatar(p)}<div class="fr-who"><b>${nameOf(p)}</b><span class="${f.online ? 'on' : ''}">${f.online ? '在线' : '离线'}</span></div>
          <button class="btn btn-primary btn-sm" data-fr-act="challenge" data-id="${esc(f.id)}" ${f.online ? '' : 'disabled'}>约战</button>
          <button class="btn btn-ghost btn-sm" data-fr-act="remove" data-id="${esc(f.id)}">移除</button>
          <button class="btn btn-ghost btn-sm" data-fr-act="block" data-id="${esc(f.id)}" style="color:var(--red-light);">拉黑</button>
        </div>`;
      }

      function renderFriends() {
        const list = (data && data.friends) || [];
        $('frFriends').innerHTML = list.length
          ? list.map(friendRow).join('')
          : '<div class="fr-empty">还没有好友。输入账号 ID 或用户名添加。</div>';
      }

      function renderChallenges() {
        const list = (data && data.challenges) || [];
        if (!list.length) { $('frChallenges').innerHTML = '<div class="fr-empty">暂无约战。</div>'; return; }
        $('frChallenges').innerHTML = list.map((c) => {
          const other = c.incoming ? c.from : c.to;
          const p = other || { id: c.fromId };
          const state = c.status === 'accepted'
            ? `<button class="btn btn-primary btn-sm" data-fr-act="enter" data-room="${esc(c.roomId || '')}">进入房间 ${esc(c.code || '')}</button>`
            : (c.incoming
              ? `<button class="btn btn-primary btn-sm" data-fr-act="ch-accept" data-id="${esc(c.id)}">接受</button>
                 <button class="btn btn-ghost btn-sm" data-fr-act="ch-decline" data-id="${esc(c.id)}">拒绝</button>`
              : '<span class="fr-wait">等待对方接受</span>');
          return `<div class="fr-row">
            ${avatar(p)}<div class="fr-who"><b>${nameOf(p)}</b><span>${c.status === 'accepted' ? '已接受' : (c.incoming ? '向你发起约战' : '你发起约战')} · ${esc(tcLabel(c.timeControl))}</span></div>
            ${state}
          </div>`;
        }).join('');
      }

      function renderFollows() {
        const box = $('frFollows');
        const follow = (data && data.following) || [];
        const fans = (data && data.followers) || [];
        const row = (x, mode) => {
          const p = x.profile || { id: x.id };
          return `<div class="fr-row">${avatar(p)}<div class="fr-who"><b>${nameOf(p)}</b><span>${x.online ? '在线' : '离线'}</span></div>
            <button class="btn btn-ghost btn-sm" data-fr-act="${mode === 'following' ? 'unfollow' : 'follow'}" data-id="${esc(x.id)}">${mode === 'following' ? '取消关注' : '回关'}</button>
            <button class="btn btn-ghost btn-sm" data-fr-act="block" data-id="${esc(x.id)}" style="color:var(--red-light);">拉黑</button>
          </div>`;
        };
        box.innerHTML = (follow.length || fans.length)
          ? `<div class="fr-subtitle">关注 ${follow.length}</div>${follow.map((x) => row(x, 'following')).join('')}
             <div class="fr-subtitle">粉丝 ${fans.length}</div>${fans.map((x) => row(x, 'follower')).join('')}`
          : '<div class="fr-empty">暂无关注。</div>';
      }

      function renderBlocked() {
        const list = (data && data.blocked) || [];
        $('frBlocked').innerHTML = list.length
          ? list.map((x) => {
            const p = x.profile || { id: x.id };
            return `<div class="fr-row">${avatar(p)}<div class="fr-who"><b>${nameOf(p)}</b></div>
              <button class="btn btn-ghost btn-sm" data-fr-act="unblock" data-id="${esc(x.id)}">解除拉黑</button></div>`;
          }).join('')
          : '<div class="fr-empty">没有拉黑任何人。</div>';
      }

      function renderAll() {
        if (!data) return;
        stats();
        renderFriends();
        renderChallenges();
        renderFollows();
        renderBlocked();
      }

      async function load() {
        try {
          data = await apiGet('/api/social/overview');
          if (!alive) return;
          renderAll();
        } catch (e) {
          if (!alive) return;
          $('frStats').textContent = e.message || '加载失败';
        }
      }

      async function act(fn, okMsg) {
        try {
          const r = await fn();
          if (!alive) return;
          if (okMsg) toast(okMsg);
          await load();
          return r;
        } catch (e) {
          if (!alive) return;
          toast(e.message || '操作失败');
          return null;
        }
      }

      function target() {
        const el = $('frTarget');
        return el ? el.value.trim() : '';
      }

      async function onAction(e) {
        const btn = e.target.closest && e.target.closest('[data-fr-act]');
        if (!btn) return;
        const what = btn.getAttribute('data-fr-act');
        const id = btn.getAttribute('data-id');
        if (what === 'accept') return act(() => apiPost('/api/social/friends/respond', { from: id, accept: true }), '已添加好友');
        if (what === 'reject') return act(() => apiPost('/api/social/friends/respond', { from: id, accept: false }), '已拒绝');
        if (what === 'remove') return act(() => apiPost('/api/social/friends/remove', { target: id }), '已移除');
        if (what === 'block') return act(() => apiPost('/api/social/block', { target: id }), '已拉黑');
        if (what === 'unblock') return act(() => apiPost('/api/social/block', { target: id, off: true }), '已解除拉黑');
        if (what === 'follow') return act(() => apiPost('/api/social/follow', { target: id }), '已关注');
        if (what === 'unfollow') return act(() => apiPost('/api/social/follow', { target: id, off: true }), '已取消关注');
        if (what === 'challenge') {
          const tc = $('frTimeControl') ? $('frTimeControl').value : '10:00';
          return act(() => apiPost('/api/social/challenges', { target: id, timeControl: tc }), '约战已发送');
        }
        if (what === 'ch-accept') {
          const r = await act(() => apiPost(`/api/social/challenges/${encodeURIComponent(id)}/respond`, { accept: true }), '已接受约战');
          if (r && r.roomId && global.Router) global.Router.navigate(`play.html?room=${encodeURIComponent(r.roomId)}`);
          return;
        }
        if (what === 'ch-decline') return act(() => apiPost(`/api/social/challenges/${encodeURIComponent(id)}/respond`, { accept: false }), '已拒绝约战');
        if (what === 'enter' && btn.getAttribute('data-room')) {
          global.Router.navigate(`play.html?room=${encodeURIComponent(btn.getAttribute('data-room'))}`);
        }
      }

      function bind(id, ev, fn) {
        const el = $(id);
        if (!el) return;
        el.addEventListener(ev, fn);
        teardown.push(() => el.removeEventListener(ev, fn));
      }
      bind('frAdd', 'click', () => { if (!target()) return toast('请输入账号 ID 或用户名'); act(() => apiPost('/api/social/friends/request', { target: target() }), '好友申请已发送'); });
      bind('frFollow', 'click', () => { if (!target()) return toast('请输入账号 ID 或用户名'); act(() => apiPost('/api/social/follow', { target: target() }), '已关注'); });
      bind('frBlock', 'click', () => { if (!target()) return toast('请输入账号 ID 或用户名'); act(() => apiPost('/api/social/block', { target: target() }), '已拉黑'); });
      const body = $('frBody');
      if (body) {
        body.addEventListener('click', onAction);
        teardown.push(() => body.removeEventListener('click', onAction));
      }

      const subs = [];
      if (global.API && global.API.on) {
        subs.push(global.API.on('friend_request', () => { toast('收到好友申请'); load(); }));
        subs.push(global.API.on('friend_accepted', () => { toast('好友申请已通过'); load(); }));
        subs.push(global.API.on('challenge_created', (d) => {
          const from = d && d.from ? d.from.name : '';
          toast(from ? `${from} 向你发起约战` : '收到约战');
          load();
        }));
        subs.push(global.API.on('challenge_answered', (d) => {
          // 接受约战的跳转由 boot 的全局处理器负责；这里只在被拒绝时刷新列表。
          if (!(d && d.accepted)) load();
        }));
        subs.forEach((fn) => teardown.push(fn));
      }

      load();
      timer = setInterval(() => { if (alive) load(); }, 12000);
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.friends = View;
})(window);
