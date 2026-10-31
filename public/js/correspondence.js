'use strict';

/**
 * correspondence.js — 异步长局页面（1.8）。
 * 列表/创建/棋盘都走 REST；每步按天计时，WS 只做提醒和刷新。
 */
(function (global) {
  'use strict';

  const UI = global.UI;
  const DAY = 24 * 60 * 60 * 1000;

  function fmtDeadline(ts) {
    if (!ts) return '—';
    const ms = ts - Date.now();
    if (ms <= 0) return '已超时';
    const h = Math.floor(ms / 3600000);
    if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
    return `${h} 小时 ${Math.floor((ms % 3600000) / 60000)} 分`;
  }

  const View = {
    title: '异步长局 · TDShogi',
    render() {
      return `
  <main class="container">
    <div class="card pz-card">
      <div class="pz-head">
        <div>
          <div class="pz-title">异步长局</div>
          <div class="pz-sub" id="corrStats">每步 1/3/7 天，适合跨时区与忙时对局。</div>
        </div>
        <a class="btn btn-ghost btn-sm" href="index.html">返回首页</a>
      </div>
      <div id="corrGuest" class="pz-placeholder" style="display:none;">异步长局需要正式账号，请先登录。</div>
      <div id="corrList" style="display:none;">
        <div class="fr-toolbar" style="margin-bottom:12px;">
          <input class="input" id="corrTarget" placeholder="对手账号 ID 或用户名" style="max-width:230px;">
          <select class="input" id="corrDays" style="max-width:130px;"><option value="1">每步 1 天</option><option value="3">每步 3 天</option><option value="7">每步 7 天</option></select>
          <select class="input" id="corrSide" style="max-width:110px;"><option value="b">执先</option><option value="w">执后</option></select>
          <button class="btn btn-primary btn-sm" id="corrCreate">邀请对局</button>
        </div>
        <div id="corrGames"></div>
      </div>
      <div id="corrGameView" style="display:none;">
        <div id="corrGameInfo" style="font-size:12px;color:var(--text-dim);margin-bottom:8px;"></div>
        <div class="pz-board-area play-main">
          <div class="board-area">
            <div class="hand-row" id="corrOppHand"><span class="hand-label">持驹</span><div class="hand-pieces" id="corrOppHandPieces"></div></div>
            <div class="board-wrap" id="corrBoard"></div>
            <div class="hand-row" id="corrMyHand"><span class="hand-label">持驹</span><div class="hand-pieces" id="corrMyHandPieces"></div></div>
          </div>
        </div>
        <div class="pz-msg" id="corrMsg" role="status" aria-live="polite"></div>
        <div class="pz-actions">
          <button class="btn btn-ghost btn-sm" id="corrBack" type="button">返回列表</button>
          <button class="btn btn-ghost btn-sm" id="corrOfferDraw" type="button">提和</button>
          <button class="btn btn-primary btn-sm" id="corrAcceptDraw" type="button" style="display:none;">同意和棋</button>
          <button class="btn btn-ghost btn-sm" id="corrDeclineDraw" type="button" style="display:none;">拒绝和棋</button>
          <button class="btn btn-ghost btn-sm" id="corrAbort" type="button" style="display:none;">中止对局</button>
          <button class="btn btn-ghost btn-sm" id="corrResign" type="button" style="color:var(--red-light);">认输</button>
        </div>
      </div>
    </div>
  </main>`;
    },
    mount(container, params) {
      this._teardown = [];
      let alive = true;
      let timer = null;
      const teardown = this._teardown;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);
      const guest = global.NAV.getGuest();
      const isAccount = typeof guest.id === 'string' && guest.id.includes('.');
      const token = guest.id;
      const q = `token=${encodeURIComponent(token)}`;
      const id = (params && params.id) || new URLSearchParams(location.search).get('id') || '';
      let fb = null;
      let board = null;
      let current = null;
      let viewpoint = 'b';

      if (!isAccount) { $('corrGuest').style.display = ''; return; }
      $('corrList').style.display = '';

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

      function statusText(g) {
        if (g.status !== 'playing') return g.resultDetail || '已结束';
        return g.myTurn ? '轮到你走' : `等待 ${g.opponent ? g.opponent.name : '对手'}`;
      }

      function renderList(d) {
        const games = d.games || [];
        $('corrStats').textContent = `共 ${games.length} 局 · 每步 1/3/7 天 · 不计 ELO`;
        $('corrGames').innerHTML = games.length ? games.map((g) => `
          <div class="fr-row">
            <div class="fr-who"><b>${esc(g.opponent ? g.opponent.name : g.opponentId)}</b>
              <span>${esc(statusText(g))} · 每步 ${Math.round(g.timePerMoveMs / DAY)} 天 · ${g.moves} 手${g.status === 'playing' ? ` · ${esc(fmtDeadline(g.deadline))}` : ''}</span></div>
            <button class="btn ${g.myTurn ? 'btn-primary' : 'btn-ghost'} btn-sm" data-corr-open="${esc(g.id)}" type="button">打开</button>
          </div>`).join('') : '<div class="fr-empty">暂无长局。输入对手账号发起一局。</div>';
        $('corrGames').onclick = (e) => {
          const b = e.target.closest && e.target.closest('[data-corr-open]');
          if (b) global.Router.navigate(`correspondence.html?id=${encodeURIComponent(b.getAttribute('data-corr-open'))}`);
        };
      }

      async function loadList() {
        try {
          const d = await apiGet('/api/correspondence');
          if (alive) renderList(d);
        } catch (e) { if (alive) $('corrStats').textContent = e.message; }
      }

      function ensureBoard(st, g) {
        if (fb) return;
        board = new global.ShogiBoard($('corrBoard'), {});
        viewpoint = g.seat === 'w' ? 'w' : 'b';
        fb = new global.FreeBoard({
          board, viewpoint, interactive: false, mode: 'play',
          hands: { my: $('corrMyHandPieces'), myColor: viewpoint, opp: $('corrOppHandPieces'), oppColor: viewpoint === 'b' ? 'w' : 'b' },
          onMove: (usi) => submitMove(usi),
          onPromoteChoice: ({ usiMove, usiPromote }) => submitMove(global.confirm(`升变吗？\n不成：${usiMove}\n升变：${usiPromote}`) ? usiPromote : usiMove),
        });
        fb.attach();
        fb.bindHands($('corrMyHandPieces'), viewpoint, $('corrOppHandPieces'), viewpoint === 'b' ? 'w' : 'b');
      }

      function applyState(st, g) {
        if (!fb) ensureBoard(st, g);
        const vp = g.seat === 'w' ? 'w' : 'b';
        if (vp !== viewpoint) { viewpoint = vp; fb.setViewpoint(vp); }
        fb.setModel({ board: st.board, hands: st.hands || { b: [], w: [] } }, st.lastMove || null);
        fb.setLegalTargets(st.legalTargetsBySq || {});
        const playing = g.status === 'playing';
        const myTurn = playing && g.seat === st.turn;
        fb.setInteractive(myTurn);
        $('corrGameInfo').textContent = `${g.opponent ? g.opponent.name : ''} · 每步 ${Math.round(g.timePerMoveMs / DAY)} 天 · ${g.moves} 手 · ${statusText({ ...g, myTurn })} · ${fmtDeadline(g.deadline)}`;
        const opponentOffer = playing && !!g.drawOfferBy && !g.drawOfferByMe;
        let msg = g.status === 'playing' ? (myTurn ? '轮到你走。' : '等待对手走子。') : `对局结束：${g.resultDetail || g.result || ''}`;
        if (opponentOffer) msg = '对方提议和棋，请选择同意或拒绝。';
        else if (playing && g.drawOfferByMe) msg = '已提议和棋，等待对方回应。';
        $('corrMsg').textContent = msg;
        $('corrResign').style.display = playing ? '' : 'none';
        $('corrOfferDraw').style.display = playing && !g.drawOfferBy ? '' : 'none';
        $('corrAcceptDraw').style.display = opponentOffer ? '' : 'none';
        $('corrDeclineDraw').style.display = opponentOffer ? '' : 'none';
        $('corrAbort').style.display = playing && g.canAbort ? '' : 'none';
      }

      async function loadGame() {
        if (!id) { $('corrGameView').style.display = 'none'; return; }
        $('corrList').style.display = 'none';
        $('corrGameView').style.display = '';
        try {
          const d = await apiGet(`/api/correspondence/${encodeURIComponent(id)}`);
          if (!alive) return;
          current = d.game;
          applyState(d.game.state, d.game);
        } catch (e) { if (alive) $('corrMsg').textContent = e.message; }
      }

      async function submitMove(usi) {
        if (!current || current.status !== 'playing' || !id) return;
        try {
          const d = await apiPost(`/api/correspondence/${encodeURIComponent(id)}/move`, { usi });
          if (!alive) return;
          current = d.game;
          applyState(d.game.state, d.game);
          if (d.finished) toast('对局结束');
        } catch (e) { if (alive) $('corrMsg').textContent = e.message; }
      }

      async function createGame() {
        const target = ($('corrTarget') && $('corrTarget').value || '').trim();
        if (!target) return toast('请输入对手账号 ID 或用户名');
        try {
          const d = await apiPost('/api/correspondence', {
            target,
            timePerMoveDays: Number($('corrDays').value),
            side: $('corrSide').value,
          });
          toast('邀请已发出，对方可在长局列表中看到');
          global.Router.navigate(`correspondence.html?id=${encodeURIComponent(d.game.id)}`);
        } catch (e) { toast(e.message); }
      }

      async function resign() {
        if (!id || !current) return;
        if (!global.confirm('确认认输？')) return;
        try { await apiPost(`/api/correspondence/${encodeURIComponent(id)}/resign`, {}); await loadGame(); } catch (e) { toast(e.message); }
      }

      async function offerDraw() {
        if (!id || !current) return;
        try { await apiPost(`/api/correspondence/${encodeURIComponent(id)}/draw-offer`, {}); toast('已提出和棋'); await loadGame(); } catch (e) { toast(e.message); }
      }

      async function respondDraw(accept) {
        if (!id || !current) return;
        if (!accept && !global.confirm('确认拒绝和棋？')) return;
        try {
          await apiPost(`/api/correspondence/${encodeURIComponent(id)}/draw-respond`, { accept });
          toast(accept ? '已和棋' : '已拒绝');
          await loadGame();
        } catch (e) { toast(e.message); }
      }

      async function abortGame() {
        if (!id || !current) return;
        if (!global.confirm('确认中止这局？中止不计胜负。')) return;
        try { await apiPost(`/api/correspondence/${encodeURIComponent(id)}/abort`, {}); await loadGame(); } catch (e) { toast(e.message); }
      }

      function bind(id, ev, fn) { const el = $(id); if (!el) return; el.addEventListener(ev, fn); teardown.push(() => el.removeEventListener(ev, fn)); }
      bind('corrCreate', 'click', createGame);
      bind('corrResign', 'click', resign);
      bind('corrOfferDraw', 'click', offerDraw);
      bind('corrAcceptDraw', 'click', () => respondDraw(true));
      bind('corrDeclineDraw', 'click', () => respondDraw(false));
      bind('corrAbort', 'click', abortGame);
      bind('corrBack', 'click', () => global.Router.navigate('correspondence.html'));

      const subs = [];
      if (global.API && global.API.on) {
        subs.push(global.API.on('corr_created', () => { if (!id) loadList(); }));
        subs.push(global.API.on('corr_move', () => { if (id) loadGame(); else loadList(); }));
        subs.push(global.API.on('corr_draw_offered', () => { if (id) loadGame(); }));
        subs.push(global.API.on('corr_finished', () => { toast('长局已结束'); if (id) loadGame(); else loadList(); }));
        subs.forEach((fn) => teardown.push(fn));
      }

      teardown.push(() => { if (fb) { try { fb.destroy(); } catch (_) {} fb = null; } });
      if (id) loadGame(); else loadList();
      timer = setInterval(() => { if (!alive) return; if (id) loadGame(); else loadList(); }, 15000);
      teardown.push(() => { if (timer) clearInterval(timer); });
    },
    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.correspondence = View;
})(window);
