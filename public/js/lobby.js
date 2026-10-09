/**
 * lobby.js — 对战大厅 View：快速匹配、创建/加入房间、观战列表
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 lobby.html 的主体，逐字保留）
 *   mount(container, params)→ 绑定事件 / 订阅 WS / 起轮询，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（照 home.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / setTimeout / api.on / MutationObserver / 元素监听，统一在 unmount 清理。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '对战 · TDShogi',

    render() {
      // —— 原 lobby.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <header class="page-head">
      <h1 class="page-title">对战大厅</h1>
      <p class="page-sub">快速匹配在线对手，或创建房间邀请好友 —— 免注册即刻开局</p>
    </header>

    <div class="lobby-grid">
      <!-- 快速匹配 -->
      <div class="card lobby-card">
        <h3>⚔️ 快速匹配</h3>
        <p>一键匹配在线对手，两人即开，实时对局。</p>
        <div style="font-size:12px;color:var(--text-dim);margin:10px 0 14px;">⏱ 10 分钟包干（标准比赛）</div>
        <div id="matchControls">
          <button class="btn btn-primary btn-lg" id="btnQuickMatch" style="width:100%;">开始匹配</button>
        </div>
        <div class="match-wait" id="matchWait">
          <div class="spinner"></div>
          <div>正在寻找对手…<br><span style="font-size:12px;color:var(--text-dim);">点击下方按钮取消</span></div>
          <button class="btn btn-ghost" id="btnCancelMatch" style="margin-top:12px;">取消匹配</button>
        </div>
      </div>

      <!-- 创建房间 -->
      <div class="card lobby-card">
        <h3>🏠 创建房间</h3>
        <p>生成 6 位房间码，邀请好友加入对局。</p>
        <div style="margin:14px 0;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">比赛时间</div>
          <select class="select" id="roomTimeControl" style="width:100%;">
            <option value="10:00">10 分钟包干（标准比赛）</option>
            <option value="15+60">15 分钟 + 60 秒读秒</option>
            <option value="10+30">10 分钟 + 30 秒读秒</option>
            <option value="10sec">10 秒快棋</option>
          </select>
        </div>
        <!-- 手合割（駒落ち让子）：选项由服务端 \`hello.handicaps\` 下发，前端不抄那张表 -->
        <div style="margin:0 0 14px;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">手合割（让子）</div>
          <select class="select" id="roomHandicap" style="width:100%;">
            <option value="even">平手（标准开局）</option>
          </select>
          <div id="handicapHint" style="font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.7;">平手：双方对等开局；选择让子则由上手（先手）少若干枚棋子。</div>
        </div>
        <!-- 私人房间（PLAN §T2）：休闲模式——不计 ELO，经验值照常加。
             ⚠️ 2026-10-02 文案修正：留空密码时房间仍可凭码加入/观战，原「不开放观战」承诺不成立。 -->
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:8px;">
          <input type="checkbox" id="roomPrivate" style="width:16px;height:16px;cursor:pointer;">
          <span>🔒 私人房间 <span style="color:var(--text-dim);font-size:12px;">（不计 ELO · 设了密码才需密码加入）</span></span>
        </label>
        <div id="roomPasswordWrap" style="display:none;margin:0 0 14px;">
          <input class="input" id="roomPassword" type="password" placeholder="房间密码（4-8 位，可留空表示不设密码）" maxlength="8" style="width:100%;">
        </div>

        <button class="btn btn-ghost btn-lg" id="btnCreateRoom" style="width:100%;">创建房间</button>
        <div id="roomCreated" style="display:none;margin-top:16px;text-align:center;">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">房间码</div>
          <div id="roomCode" style="font-size:34px;font-weight:900;letter-spacing:6px;color:var(--gold-light);font-family:var(--font-serif);"></div>
          <button class="btn btn-sm btn-ghost" id="btnCopyCode" style="margin-top:10px;">复制房间码</button>
          <div style="font-size:12px;color:var(--text-dim);margin-top:10px;">等待对手加入后自动开局…</div>
        </div>
      </div>

      <!-- 加入房间 -->
      <div class="card lobby-card">
        <h3>🔑 加入房间</h3>
        <p>输入好友提供的 6 位房间码加入对局。</p>
        <input class="input" id="joinCode" placeholder="输入房间码，如 AB3X7Q" maxlength="6" style="width:100%;text-transform:uppercase;letter-spacing:4px;margin-bottom:12px;">
        <!-- 私人房间密码：仅在服务端回「需要密码」后出现（PLAN §T2），平时不占版面 -->
        <div id="joinPasswordWrap" style="display:none;margin-bottom:12px;">
          <input class="input" id="joinPassword" type="password" placeholder="该房间需要密码" maxlength="8" style="width:100%;">
        </div>
        <button class="btn btn-primary btn-lg" id="btnJoinRoom" style="width:100%;">加入房间</button>
        <!-- 凭房间码观战（PLAN §T2）：私人房观战需密码；赛事房/普通房直接进 -->
        <button class="btn btn-ghost" id="btnSpectateRoom" style="width:100%;margin-top:8px;">👁 观战（用房间码）</button>
      </div>
    </div>

    <!-- 进行中对局（观战） -->
    <section class="card pad-card">
      <div class="section-title">进行中的对局（观战）</div>
      <div id="activeGames"></div>
    </section>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav('lobby')（导航由外壳渲染）
      const api = global.API;                // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        this._teardown.push(() => el.removeEventListener(ev, fn));
      };

      // ---- 快速匹配 ----
      on($('btnQuickMatch'), 'click', () => {
        api.send({ type: 'quick_match' });
        $('matchControls').style.display = 'none';
        const wait = $('matchWait');
        wait.classList.add('show');
        // ⚠️ 2026-10-02 体验修复：显示已等待时长（此前只有 spinner，用户无法判断是否卡死）
        let tip = $('matchWaitTimer');
        if (!tip) {
          tip = document.createElement('div');
          tip.id = 'matchWaitTimer';
          tip.style.cssText = 'margin-top:8px;font-size:13px;color:var(--text-dim);';
          wait.appendChild(tip);
        }
        let sec = 0;
        tip.textContent = '已等待 0 秒…';
        const iv = setInterval(() => {
          sec += 1;
          tip.textContent = `已等待 ${sec} 秒…（超过 30 秒仍未匹配可点取消后重试）`;
        }, 1000);
        // 等待 UI 一旦被隐藏（匹配成功 / 失败 / 取消），自动停表
        const obs = new MutationObserver(() => {
          if (!wait.classList.contains('show')) { clearInterval(iv); obs.disconnect(); }
        });
        obs.observe(wait, { attributes: true, attributeFilter: ['class'] });
        // SPA：切页时也要停表/断观察（否则计时器泄漏到别的页面）
        this._teardown.push(() => {
          clearInterval(iv);
          try { obs.disconnect(); } catch (_) {}
        });
      });
      on($('btnCancelMatch'), 'click', () => {
        api.send({ type: 'cancel_match' });
        $('matchWait').classList.remove('show');
        $('matchControls').style.display = 'block';
      });

      // ---- 手合割（駒落ち让子）----
      // 选项来自服务端 `hello.handicaps`（本项目的既有分工：表只在服务端维护一份）。
      // ⚠️ 两头都取：立即读一次缓存（`hello` 可能早于本页注册监听器就到了），
      //    再注册监听器兜住"还没到"的情况——只做一头就会出现"下拉框偶尔是空的"。
      let handicaps = [];
      function fillHandicaps(list) {
        if (list && list.length) handicaps = list;
        const sel = $('roomHandicap');
        if (!sel || !handicaps.length) return;
        const keep = sel.value;
        sel.innerHTML = handicaps.map((h) => `<option value="${esc(h.id)}">${esc(h.label)}</option>`).join('');
        if (keep && handicaps.some((h) => h.id === keep)) sel.value = keep;
        syncHandicapHint();
      }
      function syncHandicapHint() {
        const sel = $('roomHandicap');
        const box = $('handicapHint');
        if (!sel || !box) return;
        const cur = handicaps.find((h) => h.id === sel.value);
        const isEven = !sel.value || sel.value === 'even';
        box.innerHTML = (cur && !isEven)
          ? `${esc(cur.hint || '')}<br>⚠️ 让子局：<b>房主执上手（少子的那一方）并先走</b>，不计 ELO。`
          : '不让子：双方各 20 枚，房主随机执先手，计入 ELO。';
      }
      fillHandicaps(api.handicaps);
      this._teardown.push(api.on('hello', (d) => fillHandicaps(d && d.handicaps)));
      on($('roomHandicap'), 'change', syncHandicapHint);

      // ---- 创建房间 ----
      // 私人房间（PLAN §T2）：休闲模式（不计 ELO，经验照常加）+ 可选密码；
      // 勾选后才显示密码框，密码留空 = 不设门禁（只是休闲局）
      let lastCreatedPrivate = false;
      on($('roomPrivate'), 'change', (e) => {
        $('roomPasswordWrap').style.display = e.target.checked ? 'block' : 'none';
      });
      on($('btnCreateRoom'), 'click', () => {
        const timeControl = $('roomTimeControl').value || '10:00';
        const isPrivate = $('roomPrivate').checked;
        const password = $('roomPassword').value.trim();
        if (isPrivate && password && (password.length < 4 || password.length > 8)) {
          return toast('房间密码需 4-8 位');
        }
        lastCreatedPrivate = isPrivate;
        api.send({
          type: 'create_room',
          data: {
            timeControl, isPrivate, password,
            // 手合割（駒落ち让子）：空 = 平手。服务端会拒绝未知 id
            handicap: $('roomHandicap').value || null,
          },
        });
      });

      // ---- 加入房间 ----
      on($('btnJoinRoom'), 'click', () => {
        const code = $('joinCode').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入 6 位有效房间码');
        const password = $('joinPassword').value.trim();
        api.send({ type: 'join_room', data: { code, password } });
      });

      // ---- 凭房间码观战（PLAN §T2）----
      // 私人房：房间码 + 密码 = 房主的邀请；赛事房/普通房：直接进
      on($('btnSpectateRoom'), 'click', () => {
        const code = $('joinCode').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return toast('请输入 6 位有效房间码');
        const password = $('joinPassword').value.trim();
        // 密码必须随「跳到 play 页的那个新连接」一起过去（授权不跨连接）。
        // 放 sessionStorage 而非 URL：避免密码留在浏览器历史与服务端访问日志里。
        if (password) window.sessionStorage.setItem('tdshogi_spectate_pw', password);
        else window.sessionStorage.removeItem('tdshogi_spectate_pw');
        api.send({ type: 'spectate', data: { code, password } });
      });
      // 回车直接加入（房间码 / 密码框内均可）
      ['joinCode', 'joinPassword'].forEach((id) => {
        on($(id), 'keydown', (e) => {
          if (e.key === 'Enter') $('btnJoinRoom').click();
        });
      });

      // ---- WS 事件（api.on 返回退订函数 → 直接记进 teardown）----
      this._teardown.push(api.on('room_created', (data) => {
        $('roomCode').textContent = data.code;
        $('roomCreated').style.display = 'block';
        toast(lastCreatedPrivate
          ? '私人房间已创建，把房间码与密码发给好友'
          : '房间已创建，等待对手加入');
      }));
      this._teardown.push(api.on('room_joined', (data) => {
        toast('加入成功，对局开始！');
        const t = setTimeout(() => global.Router.navigate(`play.html?room=${data.roomId}`), 400);
        this._teardown.push(() => clearTimeout(t));
      }));
      this._teardown.push(api.on('matched', (data) => {
        toast('匹配成功！对局开始');
        const t = setTimeout(() => global.Router.navigate(`play.html?room=${data.roomId}`), 400);
        this._teardown.push(() => clearTimeout(t));
      }));
      this._teardown.push(api.on('game_start', (data) => {
        if (location.search.includes('room')) return;
        global.Router.navigate(`play.html?room=${data.roomId}`);
      }));
      this._teardown.push(api.on('spectating', (data) => {
        // ⚠️ 2026-10-02 体验修复：观战跳转必须带 &spectate=1（与首页随机观战同口径）。
        // 否则 play 页会走 request_state → 非选手/未绑定 → 服务端回 no_room
        // → 被弹回大厅并谎报「该对局已结束或不存在」。
        global.Router.navigate(`play.html?room=${data.roomId}&spectate=1`);
      }));
      this._teardown.push(api.on('error', (data) => {
        if (!data || !data.message) return;
        toast(data.message);
        // ⚠️ 2026-10-02 体验修复：匹配失败一律复位等待 UI（此前靠 message 含「匹配」才复位，
        // 而「你正在对局中」/「同一身份不能自己和自己对弈」等文案不含「匹配」→ spinner 永远转）。
        $('matchWait').classList.remove('show');
        $('matchControls').style.display = 'block';
        // 私人房间需要密码（PLAN §T2）：服务端回的是**结构化标志** → 亮出密码框并聚焦。
        if (data.needPassword) {
          $('joinPasswordWrap').style.display = 'block';
          $('joinPassword').focus();
        }
        // 在局中被禁止观战：服务端回了 backRoomId → 引导回自己的对局（此前前端从不使用）
        if (data.backRoomId) {
          global.Router.navigate(`play.html?room=${encodeURIComponent(data.backRoomId)}`);
        }
      }));

      // ---- 观战列表 ----
      let lastGamesSig = '';
      async function loadGames() {
        try {
          const data = await global.ApiUtils.get('/api/lobby');
          renderGames(data.games);
        } catch (e) { console.error(e); }
      }
      function renderGames(games) {
        const el = $('activeGames');
        if (!el) return;
        if (!games || !games.length) {
          if (lastGamesSig === 'empty') return;
          lastGamesSig = 'empty';
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">当前没有进行中的对局</div>';
          return;
        }
        // ⚠️ 2026-10-02 体验修复：列表每 5s 全量重排，光标下的卡片会突然换位置导致误点；
        // 内容无变化时直接跳过重绘（用 roomId+走子数+观战数做指纹）。
        const sig = games.map((g) => `${g.roomId}:${g.moveCount}:${g.spectatorCount || 0}`).join('|');
        if (sig === lastGamesSig) return;
        lastGamesSig = sig;
        // §R4 热门优先：观众多的排前面（Array.sort 稳定，同人数保持服务端原序）。
        // 注意：渲染与点击绑定必须共用同一个数组（list），否则点击会张冠李戴。
        const list = [...games].sort((a, b) => (b.spectatorCount || 0) - (a.spectatorCount || 0));
        // 显示房间码 + 对局类型 + 走子数 + 观战人数，便于区分重名玩家；名字带悬停信息卡
        el.innerHTML = list.map((g) => {
          const typeName = g.type === 'reviewing' ? '🎤 复盘中' : g.type === 'quick' ? '快速匹配' : g.type === 'tournament' ? '赛事' : '房间对局';
          const pid = g.playerIds || {};
          const sc = g.spectatorCount || 0;
          const spec = sc > 0 ? ` · 👁 <b style="color:var(--gold-light);">${sc}</b> 人观战` : ' · 观战';
          // 让子局必须标出来：不标的话，点进去观战的人看到"棋盘少了几枚棋子"会以为是坏了
          const hd = g.handicapLabel ? ` · ♟ ${esc(g.handicapLabel)}` : '';
          // ⚠️ 2026-10-02 体验修复：卡片显示时制（服务端已下发 timeControl，此前前端丢弃 → 要进房才知道节奏）
          const tc = g.timeControl ? ` · ⏱ ${esc(g.timeControl)}` : '';
          return `
      <div class="game-card" data-room="${esc(g.roomId)}">
        <div class="players">
          <span data-player-id="${esc(pid.b || '')}">${esc(g.players.b || '先手')}</span>
          <span class="vs">vs</span>
          <span data-player-id="${esc(pid.w || '')}">${esc(g.players.w || '後手')}</span>
        </div>
        <div class="meta">房间 ${esc(g.code)} · ${typeName}${tc} · ${g.moveCount} 手${hd}${spec}</div>
      </div>
    `;
        }).join('');
        // 点击卡片进入对局：自己是该局选手 → 不带 spectate（走 request_state 由服务端按
        // playerId 回位到选手座位）；否则才以观战身份进入。playerId 在 hello 时由服务端下发。
        el.querySelectorAll('.game-card').forEach((card, i) => {
          const g = list[i];
          on(card, 'click', () => {
            const mine = api.playerId && g.playerIds && (g.playerIds.b === api.playerId || g.playerIds.w === api.playerId);
            global.Router.navigate(`play.html?room=${encodeURIComponent(g.roomId)}${mine ? '' : '&spectate=1'}`);
          });
        });
      }

      loadGames();
      const pollTimer = setInterval(loadGames, 5000);
      this._teardown.push(() => clearInterval(pollTimer));
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.lobby = View;
})(window);
