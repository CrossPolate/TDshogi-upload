'use strict';

/**
 * notifications.js — 站内通知中心（1.7）。
 * 好友申请、约战、异步长局轮次与结果在这里补课；实时事件仍走 WS。
 */
(function (global) {
  'use strict';
  const UI = global.UI;

  const ICONS = {
    friend_request: '👥',
    friend_accepted: '🤝',
    challenge_created: '⚔️',
    challenge_answered: '⚔️',
    corr_created: '📮',
    corr_move: '⏳',
    corr_finished: '🏁',
    tournament_match_started: '🏆',
  };

  function accountToken() {
    const g = global.NAV && global.NAV.getGuest ? global.NAV.getGuest() : null;
    return g && typeof g.id === 'string' && g.id.includes('.') ? g.id : '';
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const token = accountToken();
    if (token) headers['X-Account-Token'] = token;
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `请求失败（HTTP ${r.status}）`);
    return d;
  }

  const View = {
    title: '通知 · TDShogi',
    render() {
      return `
  <main class="container">
    <div class="card pz-card">
      <div class="pz-head">
        <div>
          <div class="pz-title">通知中心</div>
          <div class="pz-sub" id="notifStats">加载中…</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="notifReadAll" type="button">全部已读</button>
      </div>
      <div id="notifList"><div class="pz-placeholder">加载中…</div></div>
      <div style="text-align:center;margin-top:10px;">
        <button class="btn btn-ghost btn-sm" id="notifMore" type="button" style="display:none;">加载更多</button>
      </div>
      <div class="pz-hint">好友申请、约战和异步长局轮次会保留在这里；每人只保留最近 200 条。</div>
    </div>
  </main>`;
    },
    mount() {
      this._teardown = [];
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      let alive = true;
      const PAGE = 30;
      let offset = 0;
      const token = accountToken();

      if (!token) {
        $('notifStats').textContent = '登录账号后查看通知。';
        $('notifList').innerHTML = '<div class="pz-placeholder">游客不会收到好友 / 约战 / 异步长局通知。</div>';
        $('notifReadAll').style.display = 'none';
        return;
      }

      const fmt = (ts) => (global.I18N && global.I18N.fmt ? global.I18N.fmt(ts) : new Date(ts).toLocaleString());

      function rowHtml(n) {
        const link = typeof (n.data && n.data.link) === 'string' && n.data.link.startsWith('/') ? n.data.link : '';
        return `
          <div class="notif-item${n.read ? '' : ' unread'}">
            <div class="notif-icon" aria-hidden="true">${ICONS[n.type] || '🔔'}</div>
            <div class="notif-main">
              <div class="notif-title">${esc(n.title || '通知')}</div>
              <div class="notif-body">${esc(n.body || '')}</div>
              <div class="notif-time">${fmt(n.createdAt)}</div>
            </div>
            <div class="notif-actions">
              ${link ? `<a class="btn btn-ghost btn-sm" href="${esc(link)}" data-notif-link="${esc(n.id)}">查看</a>` : ''}
              ${n.read ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-notif-read="${esc(n.id)}">已读</button>`}
            </div>
          </div>`;
      }

      async function load(reset = true) {
        try {
          if (reset) offset = 0;
          const d = await api(`/api/notifications?limit=${PAGE}&offset=${offset}`);
          if (!alive) return;
          const items = d.items || [];
          $('notifStats').textContent = d.unread ? `${d.unread} 条未读` : '没有未读通知';
          $('notifReadAll').disabled = !d.unread;
          if (reset) {
            $('notifList').innerHTML = items.length
              ? items.map(rowHtml).join('')
              : '<div class="pz-placeholder">暂时没有通知。</div>';
          } else if (items.length) {
            $('notifList').insertAdjacentHTML('beforeend', items.map(rowHtml).join(''));
          }
          offset += items.length;
          const more = $('notifMore');
          if (more) more.style.display = items.length === PAGE ? '' : 'none';
          if (global.NAV && global.NAV.refreshNotifications) global.NAV.refreshNotifications();
        } catch (e) {
          if (!alive) return;
          if (reset) $('notifList').innerHTML = `<div class="pz-placeholder">${esc(e.message)}</div>`;
          else toast(e.message);
        }
      }

      async function markRead(id) {
        try {
          await api('/api/notifications/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch (_) { /* 标记失败不拦跳转 */ }
      }

      const onClick = async (ev) => {
        const readBtn = ev.target.closest('[data-notif-read]');
        if (readBtn) {
          ev.preventDefault();
          await markRead(readBtn.getAttribute('data-notif-read'));
          load(true);
          return;
        }
        const link = ev.target.closest('[data-notif-link]');
        if (!link) return;
        ev.preventDefault();
        await markRead(link.getAttribute('data-notif-link'));
        const href = link.getAttribute('href');
        if (global.Router && global.Router.navigate) global.Router.navigate(href);
        else location.href = href;
      };
      $('notifList').addEventListener('click', onClick);
      this._teardown.push(() => $('notifList') && $('notifList').removeEventListener('click', onClick));

      const readAll = async () => {
        try {
          await api('/api/notifications/read-all', { method: 'POST' });
          toast('已全部标记为已读');
          load(true);
        } catch (e) { toast(e.message); }
      };
      $('notifReadAll').addEventListener('click', readAll);
      this._teardown.push(() => $('notifReadAll') && $('notifReadAll').removeEventListener('click', readAll));

      const loadMore = () => load(false);
      $('notifMore').addEventListener('click', loadMore);
      this._teardown.push(() => $('notifMore') && $('notifMore').removeEventListener('click', loadMore));

      const EVENT_TYPES = [
        'friend_request', 'friend_accepted', 'challenge_created', 'challenge_answered',
        'corr_created', 'corr_move', 'corr_finished', 'tournament_match_started',
      ];
      const offs = global.API && global.API.on
        ? EVENT_TYPES.map((type) => global.API.on(type, () => load()))
        : [];
      this._teardown.push(...offs);

      load();
      this._alive = () => { alive = false; };
    },
    unmount() {
      if (this._alive) this._alive();
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.notifications = View;
})(window);
