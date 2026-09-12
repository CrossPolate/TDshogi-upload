/**
 * play-demo.js — 对局页「感想战」（PLAN §M5 前端拆分第 3 步）
 *
 * 从 `play.js` 抽出。感想战是终局后的推演玩法：同一棋盘组件切到 `demo-rules` 模式，
 * 双方（或观战者）轮流演示/推演，支持历史手回退与自由摆棋。
 *
 * 与 `play-chat.js` 不同，这块**与对局 core 是双向依赖**，所以拆法与 `play-clock.js` 一致
 * 用**回调注入**：
 *   注入进来（core → demo）：`getState` / `getFb` / `getSeat` / `getViewpoint` /
 *                            `ensureBoard` / `renderPlayerBars`
 *   暴露出去（demo → core）：`isActive` / `enter` / `exit` / `applyMode` / `updateUI` /
 *                            `sendMove` / `setPendingPromo` / `takePendingPromo`
 *
 * ⚠️ 迁移原则：**逻辑一字未改**，只把「读 core 的闭包变量」换成注入的回调调用
 * （`reviewActive`→`isActive()`、`state`→`getState()`、`mySeat/isPlayer`→`getSeat()`、
 *  `fb`→`getFb()`）。状态（推演谱 / 光标 / 自由摆棋 …）整体搬进本模块。
 *
 * 依赖：`window.API`、`window.UI`（`$` / `esc` / `toast`）、`window.FreeBoard`、`window.Sound`
 *       DOM：`#demoBar` `#demoStatus` `#btnDemo*` `#btnFreeMode` `#moveList` `#topPlayerBar` `#bottomPlayerBar`
 *
 * ⚠️ 加载顺序：必须在 `play.js` **之前**。
 */
(function () {
  'use strict';

  const api = window.API;
  const $ = (id) => window.UI.$(id);
  function escHtml(s) { return window.UI.esc(s); }
  function toast(msg) { return window.UI.toast(msg); }

  // ---- 注入的 core 依赖（init 时由 play.js 提供，先给安全默认值）----
  let getState = function () { return null; };
  let getFb = function () { return null; };
  let getSeat = function () { return { mySeat: null, isPlayer: false }; };
  let getViewpoint = function () { return 'b'; };
  let ensureBoard = function () {};
  let renderPlayerBars = function () {};
  let clearSelection = function () {};   // 进入感想战时清掉 core 的选中/目标高亮

  // ---- 本模块自己的状态（原 play.js 的闭包变量，整体搬入）----
  let reviewActive = false;       // 感想战模式中
  let demoInfo = null;            // 推演谱（服务端载荷）
  let demoCursor = 0;             // 联合谱浏览位置
  let originalPositions = null;   // 原谱各手局面缓存
  let pendingDemoPromo = null;    // 感想战升变选择
  let freeMode = false;           // 自由摆棋（本地草稿，不入谱不同步）
  let demoLegalCache = {};        // 历史手合法走法按需缓存（PLAN §H）

  function demoEdge() {
    return demoInfo ? demoInfo.baseIndex + demoInfo.moves.length : 0;
  }

  function enterDemo(st) {
    // 终局分支会在 api.on('state') 里 enterDemo 后直接 return（不跑 render），
    // 所以玩家栏必须在这里补渲染一次，否则重进者永远看不到双方名字与 id
    renderPlayerBars(st);
    if (reviewActive && getFb()) { applyDemoMode(); updateDemoUI(); return; }
    reviewActive = true;
    freeMode = false;
    clearSelection(); // 原 core 里的 `selected = null; targets = [];`
    ensureBoard(getViewpoint());
    demoInfo = st.demo || { moves: [], kif: [], baseIndex: (getState().moves || []).length, baseCount: (getState().moves || []).length, legalTargetsBySq: {}, legalMoves: [], turn: 'b', demonstratorSeat: null, demonstratorName: null };
    demoCursor = demoEdge();
    $('demoBar').style.display = 'flex';
    applyDemoMode();
    updateDemoUI();
    if (window.Sound) window.Sound.playEnd();
  }

  function exitDemo() {
    reviewActive = false;
    freeMode = false;
    demoInfo = null;
    pendingDemoPromo = null;
    $('demoBar').style.display = 'none';
  }

  function ensureOriginalPositions() {
    if (originalPositions) return originalPositions;
    const arr = [window.FreeBoard.initialModel()];
    for (const usi of (getState().moves || [])) {
      const prev = arr[arr.length - 1];
      const model = { board: JSON.parse(JSON.stringify(prev.board)), hands: JSON.parse(JSON.stringify(prev.hands)) };
      const color = (arr.length - 1) % 2 === 0 ? 'b' : 'w';
      window.FreeBoard.applyUsiOnModel(model, usi, color);
      arr.push(model);
    }
    originalPositions = arr;
    return arr;
  }

  function applyDemoMode() {
    const fb = getFb();
    const state = getState();
    if (!fb) return;
    // 棋盘 = 联合谱 cursor 对应局面（原谱重放 + 推演叠加）
    const k = Math.min(demoCursor, demoEdge());
    const bi = demoInfo.baseIndex;
    const ops = ensureOriginalPositions();
    let model;
    if (k <= bi) model = ops[k];
    else {
      const basePos = ops[bi];
      model = { board: JSON.parse(JSON.stringify(basePos.board)), hands: JSON.parse(JSON.stringify(basePos.hands)) };
      for (let i = 0; i < k - bi; i++) {
        const color = (bi + i) % 2 === 0 ? 'b' : 'w';
        window.FreeBoard.applyUsiOnModel(model, demoInfo.moves[i], color);
      }
    }
    // §J4：光标停在「最新一手」时，改用**服务端下发的权威局面**覆盖本地重放结果。
    // 只在这一手覆盖的原因：服务端只维护推演终局这一个局面（历史手仍要本地重放——
    // 那是「任意手跳转」的必要代价），而最新一手恰恰是大家在看的、也最容易暴露
    // 持驹/盘面漂移的地方（J3「吃馬得角」就是这么潜伏到用户吃子才发现的）。
    // 深拷贝后再交给组件，避免自由摆棋等交互原地改动服务端载荷。
    if (k === demoEdge() && demoInfo.board && demoInfo.hands) {
      model = {
        board: JSON.parse(JSON.stringify(demoInfo.board)),
        hands: JSON.parse(JSON.stringify(demoInfo.hands)),
      };
    }
    let lastMove = null;
    if (k > 0) lastMove = k <= bi ? ((state.moves || [])[k - 1] || null) : (demoInfo.moves[k - bi - 1] || null);
    fb.setModel(model, lastMove);
    fb.setLegalTargets(demoInfo.legalTargetsBySq || {});
  }

  function renderDemoMoveList() {
    const state = getState();
    const el = $('moveList');
    if (!demoInfo) return;
    const bi = demoInfo.baseIndex;
    const base = demoInfo.baseCount;
    const kifAll = (state.movesKif || []);
    const html = [];
    for (let no = 1; no <= base; no++) {
      const mark = no % 2 === 1 ? '▲' : '△';
      const cur = demoCursor === no ? ' current' : '';
      const off = no > bi;
      const style = off ? ' style="color:var(--text-dim);text-decoration:line-through;opacity:.55;"' : '';
      const times = state.moveTimes || [];
      const spent = Number(times[no - 1]) || 0;
      let cum = 0; for (let k = 0; k <= no - 1; k++) cum += Number(times[k]) || 0;
      const timeTxt = (spent || cum) ? ' (' + Math.floor(spent / 60) + ':' + String(spent % 60).padStart(2, '0') + '/' + Math.floor(cum / 3600) + ':' + Math.floor((cum % 3600) / 60) + ':' + String(cum % 60).padStart(2, '0') + ')' : '';
      html.push('<div class="move-row' + cur + '" data-no="' + no + '" style="cursor:pointer;' + (off ? style : '') + '"><span class="no">' + no + '</span><span' + (off ? style : '') + '>' + mark + ' ' + escHtml(kifAll[no - 1] || (state.moves || [])[no - 1] || '') + timeTxt + '</span></div>');
    }
    for (let i = 0; i < demoInfo.moves.length; i++) {
      const no = bi + i + 1;
      const mark = no % 2 === 1 ? '▲' : '△';
      const cur = demoCursor === no ? ' current' : '';
      const live = no === demoEdge() ? ' 🎤' : '';
      html.push('<div class="move-row' + cur + '" data-no="' + no + '" style="cursor:pointer;color:var(--gold-light);"><span class="no">' + no + '</span><span>' + mark + ' ' + escHtml(demoInfo.kif[i] || demoInfo.moves[i]) + live + '</span></div>');
    }
    el.innerHTML = html.join('');
    el.querySelectorAll('.move-row').forEach((row) => {
      row.addEventListener('click', () => {
        demoCursor = Math.min(parseInt(row.dataset.no, 10), demoEdge());
        applyDemoMode();
        updateDemoUI();
        const curEl = el.querySelector('.move-row.current');
        if (curEl) curEl.scrollIntoView({ block: 'nearest' });
      });
    });
    const curEl = el.querySelector('.move-row.current');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
  }

  function updateDemoUI() {
    const fb = getFb();
    const seatInfo = getSeat();
    const mySeat = seatInfo.mySeat;
    const isPlayer = seatInfo.isPlayer;
    const seat = demoInfo ? demoInfo.demonstratorSeat : null;
    const name = demoInfo ? demoInfo.demonstratorName : null;
    const amDemo = !!mySeat && seat === mySeat;
    let status;
    if (freeMode) status = '✋ 自由摆棋中（本地草稿，不入谱不同步）';
    else if (seat && amDemo) status = '🎤 正在由你演示（对方实时观看）';
    else if (seat) status = '🎤 正在由 ' + (name || '对方') + ' 演示';
    else status = '💤 演示暂停——点「我来演示」开始行棋';
    $('demoStatus').textContent = status;
    $('btnDemoClaim').style.display = (mySeat && !seat && !freeMode) ? 'inline-block' : 'none';
    [ $('btnDemoTransfer'), $('btnDemoUndo'), $('btnDemoClear') ]
      .forEach((b) => { b.style.display = (amDemo && !freeMode) ? 'inline-block' : 'none'; });
    $('btnFreeMode').style.display = mySeat ? 'inline-block' : 'none';
    $('btnFreeMode').textContent = freeMode ? '🧑‍🔧 退出自由摆棋' : '✋ 自由摆棋';
    $('btnDemoLatest').style.display = (demoCursor < demoEdge()) ? 'inline-block' : 'none';
    $('btnDemoRematch').style.display = isPlayer ? 'inline-block' : 'none';
    const turn = demoInfo ? (demoInfo.turn || 'b') : 'b';
    const turnHint = $('turnHint');
    if (turnHint) turnHint.textContent = turn === 'b' ? '当前轮到 先手▲' : '当前轮到 後手△';
    const topBar = $('topPlayerBar'), bottomBar = $('bottomPlayerBar');
    if (topBar) topBar.classList.toggle('active', turn === 'w');
    if (bottomBar) bottomBar.classList.toggle('active', turn === 'b');
    if (fb) {
      fb.setMode(freeMode ? 'free' : 'demo-rules');
      // 感想战不限制驹台：演示时两方持驹都要能选（手番合法性由服务端校验），
      // 清掉对战模式留下的手番限制
      fb.setTurn(null);
      // 合法走法表：最新一手用 demo_state 下发的；历史手按需向服务端请求（demo_legal）
      const atEdge = demoCursor === demoEdge();
      if (freeMode) fb.setLegalTargets({});
      else if (atEdge) fb.setLegalTargets(demoInfo.legalTargetsBySq || {});
      else requestDemoLegal(demoCursor);
      fb.setInteractive(amDemo && (freeMode || atEdge));
    }
  }

  function requestDemoLegal(index) {
    const key = index + ':' + demoInfo.moves.length + ':' + demoInfo.baseIndex;
    if (demoLegalCache[key]) { getFb().setLegalTargets(demoLegalCache[key]); return; }
    api.send({ type: 'demo_legal', data: { index } });
  }

  /** 演示走子（带当前光标 index）——core 的棋盘 onMove 会调它 */
  function sendMove(usi) {
    api.send({ type: 'demo_move', data: { usi, index: demoCursor } });
  }

  function init(ctx) {
    const c = ctx || {};
    if (typeof c.getState === 'function') getState = c.getState;
    if (typeof c.getFb === 'function') getFb = c.getFb;
    if (typeof c.getSeat === 'function') getSeat = c.getSeat;
    if (typeof c.getViewpoint === 'function') getViewpoint = c.getViewpoint;
    if (typeof c.ensureBoard === 'function') ensureBoard = c.ensureBoard;
    if (typeof c.renderPlayerBars === 'function') renderPlayerBars = c.renderPlayerBars;
    if (typeof c.clearSelection === 'function') clearSelection = c.clearSelection;

    api.on('demo_legal', (d) => {
      demoLegalCache[d.index] = d.legalTargetsBySq;
      const fb = getFb();
      if (fb && reviewActive && demoCursor === d.index) {
        fb.setLegalTargets(d.legalTargetsBySq);
        fb.render();
      }
    });

    $('btnDemoClaim').addEventListener('click', () => api.send({ type: 'demo_claim' }));
    $('btnDemoTransfer').addEventListener('click', () => api.send({ type: 'demo_transfer' }));
    $('btnDemoUndo').addEventListener('click', () => api.send({ type: 'demo_undo' }));
    $('btnDemoClear').addEventListener('click', () => { if (confirm('清空全部推演手，回到本谱终局局面？')) api.send({ type: 'demo_reset' }); });
    $('btnDemoLatest').addEventListener('click', () => { demoCursor = demoEdge(); applyDemoMode(); updateDemoUI(); });
    $('btnDemoRematch').addEventListener('click', () => { api.send({ type: 'rematch' }); toast('已请求再来一局，等待对方同意…'); });
    $('btnFreeMode').addEventListener('click', () => {
      if (!getFb()) return;
      freeMode = !freeMode;
      if (freeMode) {
        demoCursor = Math.min(demoCursor, demoEdge());
        applyDemoMode();
        toast('自由摆棋开启：任意移动/吃子/双击升变（本地草稿，不入谱不同步）');
      } else {
        demoCursor = demoEdge();
        applyDemoMode();
        toast('已退出自由摆棋，回到推演谱最新一手');
      }
      updateDemoUI();
    });

    api.on('demo_state', (d) => {
      if (!reviewActive) {
        const state = getState();
        if (state && state.status === 'FINISHED' && state.result) enterDemo(state);
        return;
      }
      // 光标自动跟随：之前在最新一手 → 跟进新一手；浏览历史则停留（可点「回到最新」）
      const prevEdge = demoEdge();
      demoInfo = d;
      if (demoCursor >= prevEdge || demoCursor > demoEdge()) demoCursor = demoEdge();
      applyDemoMode();
      renderDemoMoveList();
      updateDemoUI();
    });
  }

  window.PlayDemo = {
    init,
    isActive: function () { return reviewActive; },
    enter: enterDemo,
    exit: exitDemo,
    applyMode: applyDemoMode,
    updateUI: updateDemoUI,
    renderMoveList: renderDemoMoveList,
    sendMove,                                        // 棋盘 onMove（带光标 index）
    getCursor: function () { return demoCursor; },
    setPendingPromo: function (v) { pendingDemoPromo = v; },
    takePendingPromo: function () { const v = pendingDemoPromo; pendingDemoPromo = null; return v; },
  };
})();
