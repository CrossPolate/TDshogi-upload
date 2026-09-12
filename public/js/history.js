/**
 * history.js — 棋谱页：检索 + 列表（点击进入复盘器）
 *
 * 检索条件：关键词（选手名）/ 开局（前 N 手 USI）/ 手数范围 / 结果。
 *
 * 为什么检索走 WS 而不是 REST（PLAN §Q7 越权修复）：
 * 旧接口 `/api/records/search?player=<id>` 在服务端无法验证「请求者就是该 id」——
 * 游客 id 在大厅列表、观战页、悬停卡里都是公开的，任何人拿到别人的 id 就能枚举其棋谱。
 * WS 连接在握手时已由服务端 identify() 绑定身份，所以检索改由该身份**强制过滤**，
 * 客户端不再传 playerId（传了也无效）。
 */
(function () {
  const guest = window.NAV.renderNav('history');
  window.API.connect(guest.id);

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function esc(s) { return window.UI.esc(s); }

  // 对局结果文案（PLAN §M5）：实现统一在 util.js，此处只转发
  // （原先与 review.js 各有一份，加新结果说明时很容易只改一边）
  function resultText(r, names) { return window.UI.resultText(r, { names, withClass: true }); }

  // 检索条件（不再包含 player —— 身份由服务端按 WS 连接绑定，客户端无从指定）
  function buildQuery() {
    const q = {};
    const query = document.getElementById('searchQuery').value.trim();
    const opening = document.getElementById('searchOpening').value.trim();
    const moves = document.getElementById('searchMoves').value.trim();
    const result = document.getElementById('searchResult').value;
    if (query) q.query = query;
    if (opening) q.opening = opening;
    if (moves) {
      const m = moves.match(/^(\d+)\s*[-~]\s*(\d+)$/);
      if (m) { q.movesMin = m[1]; q.movesMax = m[2]; }
    }
    if (result) q.result = result;
    return q;
  }

  // 检索请求：走 WS（离线时 api 会入队，连上后自动发出）
  function loadRecords() {
    window.API.send({ type: 'record_search', data: buildQuery() });
  }

  // 结果由服务端按本连接身份过滤后下发
  window.API.on('record_search_result', (d) => {
    records = (d && d.records) || [];
    document.getElementById('recordCount').textContent = records.length ? `${records.length} 局` : '';
    renderList();
  });

  function renderList() {
    const el = document.getElementById('recordList');
    if (!records.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无匹配的对局。完成对局后可在此检索与复盘。</div>';
      return;
    }
    el.innerHTML = records.map((r) => {
      const names = r.names || ['先手', '後手'];
      const myResult = resultText(r, names);
      const opening = r.opening ? `<span style="color:var(--gold-light);font-size:11px;">开局 ${esc(r.opening)}</span>` : '';
      return `
        <div class="record-item" onclick="location.href='review.html?id=${r.id}'">
          <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])}</div>
          <div class="r-result ${myResult.cls}">${esc(myResult.text)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${r.moveCount || 0} 手 · ${new Date(r.createdAt).toLocaleString('zh-CN')} · ${opening} · 进入复盘 →</div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('btnSearch').addEventListener('click', loadRecords);
  document.getElementById('btnResetSearch').addEventListener('click', () => {
    document.getElementById('searchQuery').value = '';
    document.getElementById('searchOpening').value = '';
    document.getElementById('searchMoves').value = '';
    document.getElementById('searchResult').value = '';
    loadRecords();
  });
  // 回车触发检索
  ['searchQuery', 'searchOpening', 'searchMoves'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
  });

  let records = [];
  loadRecords();
})();
