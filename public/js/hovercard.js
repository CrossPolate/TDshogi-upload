/**
 * hovercard.js — 选手信息悬停小窗（PLAN §F3）
 *
 * 用法：渲染名字元素时加 data-player-id="<playerId>" 属性即可，
 * 本脚本用事件委托自动接管，无需逐页绑定。仅展示公开信息，
 * 后端 /api/player-card 永不返回手机号。
 *
 * 交互：悬停 ~400ms 弹出；移开 150ms 后关闭；移入小窗保持；
 * ESC 关闭；同一玩家 30s 内复用缓存；视口边界自动翻转。
 */
(function () {
  const HOVER_DELAY = 400;
  const HIDE_DELAY = 150;
  const CACHE_TTL = 30 * 1000;

  const cache = new Map(); // playerId -> { data, ts }
  let el = null;
  let showTimer = null;
  let hideTimer = null;
  let currentId = null;
  // ⚠️ 2026-10-02 体验修复（可用动作）：内联举报面板的状态。
  let pinned = false;          // 举报面板打开时"钉住"卡片——鼠标移开也不隐藏
  let categories = [];         // 举报类别（优先用服务端 `hello.reportCategories` 下发的，与对局页同源）
  let reportPending = false;   // 是否有一条举报在等回执（用于把 `error` 归因到举报）

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'hover-card';
    el.style.display = 'none';
    el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    el.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(el);
    return el;
  }

  function scheduleHide() {
    if (pinned) return; // ⚠️ 举报面板打开中：别顺手把卡片关了（鼠标离开卡片是常事）
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  function hide() {
    pinned = false;
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    currentId = null;
  }

  async function fetchCard(playerId) {
    const hit = cache.get(playerId);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
    const res = await fetch(`/api/player-card?id=${encodeURIComponent(playerId)}`);
    if (!res.ok) throw new Error('player not found');
    const data = await res.json();
    cache.set(playerId, { data, ts: Date.now() });
    return data;
  }

  function render(data, playerId) {
    const badge = data.isAccount ? '🔐 账号' : '👤 游客';
    const dots = (data.recent || []).map((r) =>
      r === 'win' ? '<span class="hc-dot win">●</span>'
        : r === 'loss' ? '<span class="hc-dot loss">●</span>'
          : '<span class="hc-dot draw">●</span>'
    ).join('') || '<span style="color:var(--text-dim);font-size:11px;">暂无对局</span>';
    const rows = [];
    rows.push(`<div class="hc-row"><span class="hc-name">${esc(data.name)}${data.title ? `（${esc(data.title)}）` : ''}</span><span class="hc-badge">${badge}</span></div>`);
    rows.push(`<div class="hc-row stats"><span>Lv.${data.level ?? 0} · ELO <b>${data.rating}</b></span><span>${data.games} 局</span><span>胜率 <b>${data.winRate}%</b></span></div>`);
    if (data.style) rows.push(`<div class="hc-row"><span>⚔️ 棋风</span><span style="color:var(--gold-light);">${esc(data.style)}</span></div>`);
    if (data.createdAt) rows.push(`<div class="hc-row"><span>📅 注册于</span><span>${I18N.fmtDate(data.createdAt)}</span></div>`);
    rows.push(`<div class="hc-row"><span>近 10 局</span><span class="hc-dots">${dots}</span></div>`);
    // ⚠️ 2026-10-02 体验修复（图例）：那串圆点原本没有任何说明，第一次看的人不知道颜色
    //    代表什么。补一行图例，明确「绿 ● = 胜 / 红 ● = 负 / 灰 ● = 和」。
    rows.push(`<div class="hc-row hc-legend" style="font-size:11px;color:var(--text-dim);">
      <span>图例</span>
      <span><span class="hc-dot win">●</span> 胜 <span class="hc-dot loss">●</span> 负 <span class="hc-dot draw">●</span> 和</span>
    </div>`);
    // 个人页入口（2026-09-20 用户要求："其他人查看的个人页界面没有入口"）。
    // ⚠️ 放在**这张卡片**里，全站凡是有 `data-player-id` 的地方就都有入口了 ——
    // 比在每个页面各加一个链接省事得多，也不会漏掉某个列表。
    // 卡片自身有 mouseenter 取消隐藏，所以移进去点得到（见 ensureEl）。
    if (playerId) {
      // ⚠️ 2026-10-02 体验修复（可用动作）：把「查看个人页 / 举报」收成一行动作区。
      //    举报**复用既有流程**（WS `report` 协议，与对局页同一套服务端处理），不新造协议。
      //    `data-hc-report` 存 playerId，点击后由下面的委托打开内联举报面板。
      rows.push(`<div class="hc-row" style="margin-top:4px;justify-content:flex-end;gap:12px;">
        <a href="profile.html?player=${encodeURIComponent(playerId)}"
           style="color:var(--gold-light);font-size:12px;text-decoration:none;">👤 查看个人页 →</a>
        <button type="button" data-hc-report="${encodeURIComponent(playerId)}"
           style="background:none;border:none;color:var(--red-light);font-size:12px;cursor:pointer;padding:0;">🚩 举报</button>
      </div>`);
    }
    return rows.join('');
  }

  /** 定位：优先锚点下方，放不下翻到上方；横向夹在视口内 */
  function place(anchor) {
    const card = ensureEl();
    card.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x = r.left + window.scrollX;
    let y = r.bottom + window.scrollY + 8;
    if (x + cw > window.scrollX + document.documentElement.clientWidth - 8) {
      x = window.scrollX + document.documentElement.clientWidth - cw - 8;
    }
    if (r.bottom + ch + 8 > window.innerHeight) {
      y = r.top + window.scrollY - ch - 8; // 翻转到上方
    }
    card.style.left = Math.max(8, x) + 'px';
    card.style.top = Math.max(8, y) + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-player-id]');
    if (!target) return;
    const playerId = target.getAttribute('data-player-id');
    if (!playerId) return;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = setTimeout(async () => {
      if (currentId === playerId && el && el.style.display === 'block') return;
      const card = ensureEl();
      card.innerHTML = '<div class="hc-loading">加载中…</div>';
      currentId = playerId;
      card.style.display = 'block';
      place(target);
      try {
        const data = await fetchCard(playerId);
        if (currentId !== playerId) return; // 已移开
        card.innerHTML = render(data, playerId);
        place(target);
      } catch (_) {
        hide(); // 未知玩家/网络失败静默
      }
    }, HOVER_DELAY);
  });

  // ==================================================================
  // 举报（2026-10-02 体验修复）：复用**既有** WS `report` 协议（与对局页同一套服务端流程），
  // 不新造任何服务端协议。类别清单优先取服务端 `hello.reportCategories`（源头是
  // src/reports.js 的 CATEGORIES），拿不到时退化为单个「其他」（也是服务端认的合法类别），
  // 避免"提交必定失败"。⚠️ 被举报人的**显示名由服务端自己查**，这里不传（见 `_hReport`）。
  // ==================================================================
  function openReportPanel(playerId) {
    const card = ensureEl();
    const list = categories.length ? categories : [{ id: 'other', label: '其他' }];
    card.innerHTML = `
      <div class="hc-row"><span class="hc-name">🚩 举报玩家</span></div>
      <div style="font-size:11px;color:var(--text-dim);margin:6px 0;">选择类别，提交后由管理员处理</div>
      <select id="hcReportCategory" style="width:100%;margin-bottom:8px;">
        ${list.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}
      </select>
      <textarea id="hcReportDetail" rows="2" placeholder="补充说明（可选）"
        style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:8px;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" id="hcReportCancel"
          style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:12px;padding:3px 10px;cursor:pointer;">取消</button>
        <button type="button" id="hcReportSubmit"
          style="background:none;border:1px solid var(--red-light);border-radius:6px;color:var(--red-light);font-size:12px;padding:3px 10px;cursor:pointer;">提交</button>
      </div>`;
    card.querySelector('#hcReportCancel').addEventListener('click', () => hide());
    card.querySelector('#hcReportSubmit').addEventListener('click', () => submitReport(playerId));
  }

  function submitReport(playerId) {
    const card = ensureEl();
    // 没连上时 `send` 只会进队列、永远等不到回执 → 明确告知，别让用户以为提交成功了
    if (!window.API || !window.API.send || !window.API.connected) {
      return window.UI.alert('提交举报', '连接尚未就绪，请稍后再试');
    }
    const catEl = card.querySelector('#hcReportCategory');
    const detailEl = card.querySelector('#hcReportDetail');
    reportPending = true;
    window.API.send({
      type: 'report',
      data: {
        targetId: playerId,
        category: catEl ? catEl.value : 'other',
        detail: detailEl ? detailEl.value : '',
      },
    });
    hide(); // 回执（reported / error）到了再提示，避免面板挡着看不见
  }

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-player-id]')) scheduleHide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  // 点「🚩 举报」→ 钉住卡片并展开内联面板。
  // ⚠️ 用事件委托：卡片元素是后建的，委托到 document 最稳，也不怕卡片被重建。
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-hc-report]');
    if (!btn) return;
    e.preventDefault();
    const pid = decodeURIComponent(btn.getAttribute('data-hc-report') || '');
    if (!pid) return;
    pinned = true; // 钉住：鼠标移到面板上时别把卡片先关了
    openReportPanel(pid);
  });

  // 举报回执：成功用 toast（轻量、全站一致），失败用 `UI.alert`（要看清原因）
  if (window.API && window.API.on) {
    window.API.on('hello', (d) => { if (d && d.reportCategories) categories = d.reportCategories; });
    window.API.on('reported', () => {
      if (!reportPending) return;
      reportPending = false;
      window.UI.toast('举报已提交，管理员会尽快处理');
    });
    window.API.on('error', (d) => {
      if (!reportPending) return; // 只认自己这条举报的错误，别抢别处的提示
      reportPending = false;
      window.UI.alert('提交举报', (d && d.message) || '请稍后再试');
    });
  }

  window.HoverCard = { hide };
})();
