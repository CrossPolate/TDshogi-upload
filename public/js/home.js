/**
 * home.js — 首页 View：随机观战、平台数据条、系统公告、ELO 排行榜、最新对局战报
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 index.html 的主体）
 *   mount(container, params)→ 绑定事件 / 订阅 WS / 起轮询，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（其余页面照此转换）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / api.on / document 监听，统一在 unmount 清理。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: 'TDShogi · 在线将棋对战平台',

    render() {
      // —— 原 index.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- Hero 区 -->
    <section class="hero">
      <h1 class="hero-title">天锻将棋 道场</h1>
      <p class="hero-sub">日本将棋 · 在线实时对战 · 免注册即刻对局</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="lobby.html">⚔️ 开始对局</a>
        <button class="btn btn-ghost btn-lg" id="btnRandomWatch">🎲 随机观战</button>
      </div>
    </section>

    <!-- 平台数据条 -->
    <section class="live-strip" id="statStrip" aria-label="平台实时数据">
      <div class="live-pill"><span class="dot"></span>在线<span class="num" id="statOnline">–</span></div>
      <div class="live-pill">⚔️ 对局中<span class="num" id="statPlaying">–</span></div>
      <div class="live-pill">🕐 等待对局<span class="num" id="statWaiting">–</span></div>
      <div class="live-pill">🎤 复盘中<span class="num" id="statReviewing">–</span></div>
      <div class="live-pill">📜 累计棋谱<span class="num" id="statRecords">–</span></div>
    </section>

    <!-- 主内容 + 侧栏 两栏 Dashboard -->
    <div class="dash-grid">
      <!-- 左：主内容 -->
      <div class="dash-main">
        <!-- 新手三步引导 -->
        <section class="section-block" aria-label="三步开始">
          <div class="section-title">三步开始你的将棋之旅</div>
          <div class="steps-grid">
            <a class="card step-card" href="lobby.html">
              <span class="step-no">STEP 1</span>
              <div class="step-emoji">⚔️</div>
              <div class="step-title">立即开局</div>
              <div class="step-desc">无需注册，打开就能玩。快速匹配在线对手，或生成房间码邀请好友来一局。</div>
            </a>
            <a class="card step-card" href="profile.html">
              <span class="step-no">STEP 2</span>
              <div class="step-emoji">🔐</div>
              <div class="step-title">登记账号</div>
              <div class="step-desc">注册正式账号，ELO 评级、胜绩与全部棋谱永久保存，游客数据可一键升级迁移。</div>
            </a>
            <a class="card step-card" href="profile.html#records">
              <span class="step-no">STEP 3</span>
              <div class="step-emoji">📈</div>
              <div class="step-title">复盘精进</div>
              <div class="step-desc">每局自动存为标准 KIF/CSA 棋谱，复盘器支持书签、评论与变着研究。</div>
            </a>
          </div>
        </section>

        <!-- 最新对局战报 -->
        <section class="card pad-card">
          <div class="section-title">
            <span>最新对局战报</span>
            <span class="spacer"></span>
            <a class="section-link" href="profile.html#records">查看我的棋谱 →</a>
          </div>
          <div id="recentBattles"></div>
        </section>
      </div>

      <!-- 右：侧栏 -->
      <aside class="dash-side">
        <!-- 系统公告 -->
        <section class="card pad-card">
          <div class="section-title">系统公告</div>
          <div id="announcements"></div>
        </section>

        <!-- ELO 排行榜 -->
        <section class="card pad-card">
          <div class="section-title">ELO 排行榜</div>
          <div id="leaderboard"></div>
        </section>
      </aside>
    </div>

    <!-- 将棋规则速查 -->
    <section class="card rule-card pad-card">
      <div class="section-title">将棋规则速查</div>
      <details>
        <summary>🎯 目标：将死对方的王（玉将）</summary>
        <div class="rule-body">轮流走子，攻击对方的王使其无路可逃即为「詰み」（将死）获胜。被将军时必须应将；本平台服务端自动判定王手与将死。</div>
      </details>
      <details>
        <summary>⬆️ 升变：进入敌阵可强化棋子</summary>
        <div class="rule-body">棋子进入、离开或在对方三段阵地内移动时可以选择升变（翻面）：飞车→龙王、角行→龙马、银将/桂马/香车/步兵均获得金将走法。玉与金不能升变。</div>
      </details>
      <details>
        <summary>🖐️ 打入：吃掉的棋子归你使用</summary>
        <div class="rule-body">吃掉的对方棋子放入自己的驹台，之后可在任意空格「打入」重新上战场——这是将棋最独特的规则（二步、打步詰等禁手已由服务端校验）。</div>
      </details>
      <details>
        <summary>⏱ 持钟：包干与本手持读秒</summary>
        <div class="rule-body">常规时制为每方「10+0」包干用时；快棋采用「0+10」形式——不设总时长，每手棋 10 秒读秒，超时即负。时间耗尽前留意读秒提示音。</div>
      </details>
    </section>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      const guest = global.NAV.getGuest();
      // 对局玩家 id：账号的 guest.id 是会话令牌，榜单/名单里存的是 accountId
      const myPlayerId = guest.id && String(guest.id).includes('.')
        ? String(guest.id).split('.')[0]
        : guest.id;

      const api = global.API;
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 随机观战
      const btnWatch = $('btnRandomWatch');
      const onWatch = () => api.send({ type: 'random_spectate' });
      if (btnWatch) btnWatch.addEventListener('click', onWatch);

      // WS 订阅（api.on 返回退订函数 → 记进 teardown）
      this._teardown.push(api.on('spectating', (data) => {
        global.Router.navigate(`play.html?room=${data.roomId}&spectate=1`);
      }));
      this._teardown.push(api.on('error', (data) => {
        if (data && data.message) toast(data.message);
      }));
      if (btnWatch) this._teardown.push(() => btnWatch.removeEventListener('click', onWatch));

      // 加载首页数据（5s 轮询：数据条/公告/排行/战报）
      const loadHome = async () => {
        try {
          const data = await global.ApiUtils.get('/api/home');
          renderStats(data.stats, data.recordsTotal);
          renderAnnouncements(data.announcements);
          renderLeaderboard(data.leaderboard, myPlayerId);
          renderRecent(data.recentBattles || []);
        } catch (e) {
          console.error('load home failed', e);
        }
      };

      // ---- 平台数据条 ----
      function renderStats(stats, recordsTotal) {
        const s = stats || {};
        $('statOnline').textContent = s.online != null ? s.online : '–';
        $('statPlaying').textContent = s.playing != null ? s.playing : '–';
        $('statWaiting').textContent = (s.waiting || 0) + (s.matching || 0);
        $('statReviewing').textContent = s.reviewing != null ? s.reviewing : '–';
        $('statRecords').textContent = recordsTotal != null ? recordsTotal : '–';
      }

      // ---- 公告 ----
      function renderAnnouncements(list) {
        const el = $('announcements');
        if (!el) return;
        if (!list || !list.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无公告</div>';
          return;
        }
        el.innerHTML = list.slice(0, 5).map((a) => `
      <div class="announce-card">
        <div class="announce-title">${esc(a.title)}</div>
        <div class="announce-content">${esc(a.content)}</div>
        <div class="announce-date">${global.I18N.fmtDate(a.createdAt)}</div>
      </div>
    `).join('');
      }

      // ---- ELO 排行榜 ----
      function renderLeaderboard(lb, myId) {
        const el = $('leaderboard');
        if (!el) return;
        const list = (lb && lb.list) || [];
        if (!list.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无对局记录</div>';
          return;
        }
        el.innerHTML = list.map((r, i) => `
      <div class="rank-row ${r.id === myId ? 'self' : ''}">
        <span class="rank-no ${i < 3 ? `top${i + 1}` : ''}">${i + 1}</span>
        <span class="rank-name" data-player-id="${esc(r.id)}">${esc(r.id === myId ? '我 (' + (guest.name) + ')' : r.name || r.id)}</span>
        <span class="rank-rating">${r.rating}</span>
      </div>
    `).join('');
        if (lb && lb.self && !list.find((r) => r.id === myId)) {
          el.insertAdjacentHTML('beforeend', `
        <div class="rank-row self">
          <span class="rank-no">${lb.self.rank}</span>
          <span class="rank-name">我 (${esc(guest.name)})</span>
          <span class="rank-rating">${lb.self.rating}</span>
        </div>
      `);
        }
      }

      // ---- 最新对局战报 ----
      function renderRecent(list) {
        const el = $('recentBattles');
        if (!el) return;
        if (!list.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">还没有完成的对局 —— 第一局就等你来下！</div>';
          return;
        }
        el.innerHTML = list.map((r) => {
          const names = r.names && r.names.length === 2 ? r.names : ['先手', '後手'];
          let resText;
          if (r.result === 'b') resText = `${names[0]} 胜`;
          else if (r.result === 'w') resText = `${names[1]} 胜`;
          else resText = r.resultDetail || '和棋';
          return `
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
            <span>
              <span data-player-id="${esc((r.playerIds && r.playerIds.b) || '')}">${esc(names[0])}</span>
              vs
              <span data-player-id="${esc((r.playerIds && r.playerIds.w) || '')}">${esc(names[1])}</span>
            </span>
            ${r.rated ? '<span style="font-size:11px;color:var(--gold-light);">ELO 战</span>' : ''}
          </div>
          <div class="r-result result-win">${esc(resText)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${r.moveCount} 手 · ${global.I18N.fmt(r.createdAt)} · 点击复盘 →</div>
        </div>
      `;
        }).join('');
      }

      loadHome();
      const pollTimer = setInterval(loadHome, 5000); // 数据条/排行/公告/战报定时刷新
      this._teardown.push(() => clearInterval(pollTimer));
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views.home = View;
})(window);
