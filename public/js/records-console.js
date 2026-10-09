/**
 * records-console.js — 棋谱检索台（profile 页子模块，可从任意容器 mount 的可复用模块）
 *
 * 2026-10-04：由原 `history.js` 抽出。原实现自带 `NAV.renderNav('history')` +
 * `API.connect()` 的**页面引导**逻辑，直接塞进个人页会与 `profile.js` 双重初始化
 * 导航与 WS 连接，故改造成「只负责绑定元素 id + 收发 record_search」的可复用件。
 *
 * SPA 迁移（2026-10-09）：再去掉「加载即自启」——改为被 profile 的 mount/unmount
 * **调用/驱动**的函数集合（导出 `window.ProfileParts.RecordsConsole`）：
 *   - `mount()`   由 profile 激活「棋谱」标签时**懒调用**（只挂一次）：绑元素、
 *     订阅 `record_search_result`（退订句柄记进内部 teardown）、发起首次检索。
 *   - `destroy()` 由 profile.unmount 调用：退订 WS、解绑全部监听、复位状态，零残留。
 *
 * 检索走 WS 而非 REST 的理由见原 history.js 头注（PLAN §Q7 越权修复）：
 * 身份由连接握手时绑定并**强制过滤**，客户端不传 playerId（传了也无效）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  let mounted = false;
  let records = [];
  let listPage = 1; // 列表当前页（每页 20 条，见 renderList）
  let teardown = [];

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  const $ = (id) => UI.$(id);
  const esc = (s) => UI.esc(s);
  const resultText = (r, names) => UI.resultText(r, { names, withClass: true });

  // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
  function on(el, ev, fn) {
    if (!el) return;
    el.addEventListener(ev, fn);
    teardown.push(() => el.removeEventListener(ev, fn));
  }

  // 检索条件（不含 player —— 身份由服务端按 WS 连接绑定，客户端无从指定）
  function buildQuery() {
    const q = {};
    const query = $('searchQuery').value.trim();
    const opening = $('searchOpening').value.trim();
    const moves = $('searchMoves').value.trim();
    const result = $('searchResult').value;
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
    global.API.send({ type: 'record_search', data: buildQuery() });
  }

  // 结果由服务端按本连接身份过滤后下发
  function onResult(d) {
    records = (d && d.records) || [];
    listPage = 1; // 新结果 → 回到第 1 页（否则会停在上次页码上，看起来像"检索没生效"）
    const count = $('recordCount');
    if (count) count.textContent = records.length ? global.I18N.t('{n} 局', { n: records.length }) : '';
    renderList();
  }

  function renderList() {
    const el = $('recordList');
    if (!el) return;
    if (!records.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">暂无匹配的对局。完成对局后可在此检索与复盘。</div>';
      // 空结果也要清掉分页条，否则会留着上一次的「第 1 / 5 页」
      UI.paginate({ items: [], container: 'recordPager' });
      return;
    }
    // 分页（2026-09-13）：棋谱可能上千条，全量渲染会把页面与滚动条一起撑爆
    const pg = UI.paginate({
      items: records,
      page: listPage,
      size: 20,
      container: 'recordPager',
      onPage: (n) => { listPage = n; renderList(); },
    });
    listPage = pg.page; // 页码被夹回时（检索后条数变少）同步回来
    // ⚠️ 词表按「整段文本节点精确匹配」翻译，动态拼接的句子匹配不到：
    //   - 能整段匹配的（🌐 公开 / 🔒 私有 / 空结果提示）交给 i18n 的 DOM 扫描自动翻译；
    //   - 拼接出来的（开局 / N 手 / N 局 / 进入复盘 →）在下方显式走 I18N.t()。
    el.innerHTML = pg.slice.map((r) => {
      const names = r.names || ['先手', '後手'];
      const myResult = resultText(r, names);
      const opening = r.opening ? `<span style="color:var(--gold-light);font-size:11px;">${global.I18N.t('开局 ')}${esc(r.opening)}</span>` : '';
      // 标出棋谱公开状态（私有/公开长得一样，打完一局看不出该谱有没有公开出去）
      const vis = r.visibility === 'public' ? '<span style="color:var(--gold-light);font-size:11px;">🌐 公开</span>'
        : (r.visibility ? '<span style="color:var(--text-dim);font-size:11px;">🔒 私有</span>' : '');
      return `
        <div class="record-item" data-href="review.html?id=${encodeURIComponent(r.id)}">
          <div style="font-size:13px;">${esc(names[0])} vs ${esc(names[1])} ${vis}</div>
          <div class="r-result ${myResult.cls}">${esc(myResult.text)}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">${global.I18N.t('{n} 手', { n: r.moveCount || 0 })} · ${global.I18N.fmt(r.createdAt)} · ${opening} · ${global.I18N.t('进入复盘 →')}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * 挂载检索台。幂等：重复调用只生效一次；容器不在则静默不做。
   * 由 profile 在「棋谱」标签激活时调用（懒挂载），**不在模块加载时自启**。
   */
  function mount() {
    if (mounted) return;
    if (!$('recordList')) return; // 容器不在（非棋谱页 / 未渲染）
    mounted = true;

    // api.on 返回退订函数 → 记进 teardown（profile.unmount 经 destroy 一并清理）
    teardown.push(global.API.on('record_search_result', onResult));
    on($('btnSearch'), 'click', loadRecords);
    on($('btnResetSearch'), 'click', () => {
      $('searchQuery').value = '';
      $('searchOpening').value = '';
      $('searchMoves').value = '';
      $('searchResult').value = '';
      loadRecords();
    });
    // 回车触发检索
    ['searchQuery', 'searchOpening', 'searchMoves'].forEach((id) => {
      on($(id), 'keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
    });

    loadRecords();
  }

  /** 拆除：由 profile.unmount 调用（退订 WS、解绑监听、复位状态） */
  function destroy() {
    teardown.forEach((fn) => { try { fn(); } catch (_) {} });
    teardown = [];
    mounted = false;
    records = [];
    listPage = 1;
  }

  global.ProfileParts = global.ProfileParts || {};
  global.ProfileParts.RecordsConsole = { mount, destroy };
})(window);
