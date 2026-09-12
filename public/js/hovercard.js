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
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  function hide() {
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

  function render(data) {
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
    if (data.createdAt) rows.push(`<div class="hc-row"><span>📅 注册于</span><span>${new Date(data.createdAt).toLocaleDateString('zh-CN')}</span></div>`);
    rows.push(`<div class="hc-row"><span>近 10 局</span><span class="hc-dots">${dots}</span></div>`);
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
        card.innerHTML = render(data);
        place(target);
      } catch (_) {
        hide(); // 未知玩家/网络失败静默
      }
    }, HOVER_DELAY);
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-player-id]')) scheduleHide();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  window.HoverCard = { hide };
})();
