/**
 * play.js — 对局页逻辑
 *
 *  - 状态同步（state 消息全量渲染）
 *  - 走子交互：点己方棋子/持驹 → 高亮合法目标 → 点目标格落子
 *  - 升变：存在成/不成两种走法时弹层选择
 *  - 棋钟：本地倒计时 + 服务端 clock 消息校准
 *  - 认输 / 再来一局 / 退出 / 观战模式
 */
(function () {
  const guest = window.NAV.renderNav('play');
  const api = window.API;
  api.connect(guest.id);
  // §M5：聊天与观众列表已抽到 play-chat.js——WS 事件与 DOM 交互由它自己注册。
  // 放在 connect 之后调用，保证与拆分前的注册时机一致。
  window.PlayChat.init();

  const board = new window.ShogiBoard(document.getElementById('boardContainer'), {});

  let state = null;       // 最新对局状态
  let mySeat = null;      // 'b' | 'w' | null（观战）
  let isPlayer = false;
  let selected = null;    // 当前选中的起点（格名或打子符号）
  let targets = [];       // 当前选中起点的合法目标
  let pendingPromote = null; // { usi, nonPromoteUsi, promoteUsi }
  // 棋钟状态与逻辑已抽到 play-clock.js（PLAN §M5）：本时剩余 / 读秒 / tick 都在那边
  // 统一棋盘组件（PLAN §G v6）：play 模式行棋 / 终局切感想战（demo-rules）/ 自由摆棋
  let fb = null;                  // FreeBoard 控制器（棋盘交互与拖拽）
  let spectatorViewpoint = 'b';   // 观战视角（PLAN §R1）：仅观战者生效，可切 'b' / 'w'
  // 感想战的状态（推演谱 / 光标 / 原谱缓存 / 自由摆棋 / 升变待选）已整体搬进
  // **play-demo.js**（PLAN §M5）——包括此前漏写声明、被 eslint 抓出的隐式全局
  // `window.freeMode`：现在它位于模块内部，跨脚本污染的隐患从根上消失。

  // 时间控制预设（与服务端 TIME_CONTROLS 对应）
  const TIME_CONTROLS = {
    '15+60': { name: '15分钟 + 60秒' },
    '10+30': { name: '10分钟 + 30秒' },
    '10:00': { name: '10分钟包干' },
    '10sec': { name: '10秒快棋' },
  };

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发，避免"抄多份、改一处漏九处"
  const $ = (id) => window.UI.$(id);
  function toast(msg) { return window.UI.toast(msg); }

  /**
   * 重要提示（PLAN §U3）：**弹窗 + 聊天区留痕**。
   *
   * 背景：弹窗 2.5 秒就消失，玩家低头看棋盘就错过了；聊天区能回看。
   * 所以**信息类**提示（对局开始 / 结束、对手请求再来一局、服务端报错）走这里；
   * **断线类**（"此身份已在其他窗口登录"）刻意仍用 `toast` ——
   * 页面都断了，往聊天区写一条没人会看的消息只会误导。
   */
  function notify(msg) {
    toast(msg);
    if (window.PlayChat) window.PlayChat.system(msg);
  }

  // ==================================================================
  // §M5（2026-09-28）：渲染/弹层视图层已拆到 play-views.js
  // ==================================================================
  // ⚠️ 该文件必须在本文件**之前**加载（见 public/play.html 的 <script> 顺序）。
  // 缺了就当场抛错——否则症状会是"界面不刷新"这种静默故障。
  if (!window.PlayViews) {
    throw new Error('play-views.js 必须在 play.js 之前加载（<script> 顺序错了）');
  }
  const views = window.PlayViews.make({
    $, toast, api, guest, TIME_CONTROLS, ensureBoard, onSelectPiece,
    // ⚠️ 必须是 **getter**：这些是会在对局中被重新赋值的 `let`，
    // 按值捕获会让视图层永远停在初始值（症状：切了视角棋盘不翻、换座位后按钮不变）。
    ctx: {
      get state() { return state; },
      get mySeat() { return mySeat; },
      get isPlayer() { return isPlayer; },
      get fb() { return fb; },
      get spectatorViewpoint() { return spectatorViewpoint; },
      // ⚠️ 写回也必须走 ctx：视图层里的 `ctx.spectatorViewpoint = ...`（切观战视角）
      // 若没有 setter，在 'use strict' 下会直接抛 TypeError —— 那是一个"点了没反应"的静默故障。
      set spectatorViewpoint(v) { spectatorViewpoint = v; },
    },
  });

  // 调试句柄：把视图层挂到 window，便于在浏览器控制台直接调用、排查渲染问题。
  // （⚠️ 审查 P3：原注释声称可让 `tests/play-views.test.js` 真跑一遍渲染，但仓库里
  //   并不存在该测试文件——已移除这句以免误导；现有前端测试仅 play-clock.test.js。）
  window.__playViews = views;


  // 棋钟已抽到 play-clock.js（PLAN §M5）：此处只做一次依赖注入。
  // 注入的是模块内读不到的两个"外部状态"——在 play.js 里它们是闭包变量：
  //   state → 最新对局状态（判断是否 PLAYING、谁的回合）
  //   视角  → 与棋盘**共用 `views.currentViewpoint()`**，保证两者永远同一口径
  //          （对局者固定自己视角；观战者跟随可切换的 spectatorViewpoint）
  window.PlayClock.init({
    getState: function () { return state; },
    getViewpoint: function () { return views.currentViewpoint(); },
    // §U2：每次棋钟刷新时同步「危险外框」。
    // ⚠️ 需求明确「观战者不显示」，而 PlayClock.isDanger() 只报告**时间事实**
    // （当前手番方是否读秒 ≤10 秒）——"必须是本人且轮到本人"这条判断必须在这里做：
    // 观战者 mySeat 为 null，天然被排除；若把判断挪进棋钟，观战者会跟着变红。
    onTick: function (st) {
      if (!fb) return;
      fb.setDanger(
        mySeat !== null && !!st && st.status === 'PLAYING'
        && st.turn === mySeat && window.PlayClock.isDanger()
      );
    },
  });

  // ==================================================================
  // 走子交互
  // ==================================================================
  function onSelectPiece(pieceName, color) {
    if (color !== mySeat) return;      // 只能操作自己持驹
    if (state.turn !== mySeat) return; // 未轮到自己
    const sym = window.DROP_SYMBOLS && Object.keys(window.DROP_SYMBOLS).find((k) => window.DROP_SYMBOLS[k] === pieceName);
    if (!sym) return;
    setSelection(sym);
  }

  function setSelection(from) {
    selected = from;
    const legalBySq = (state && state.legalTargetsBySq) || {};
    targets = legalBySq[from] || [];
    // 重绘高亮
    reapplySelection();
  }

  function reapplySelection() {
    const st = state;
    const checkSqs = st.check ? [views.findKingSq(st, st.turn)] : [];
    const viewpoint = mySeat === 'w' ? 'w' : 'b';
    board.render(st, {
      lastMove: st.lastMove,
      check: checkSqs,
    }, viewpoint);
    // 叠加选中与目标
    if (selected) board.highlightSq(selected, 'sel');
    targets.forEach((t) => {
      const cell = board._findCell(t.to);
      if (cell) {
        // 先清旧类再添加：避免残留 has-piece（方块）污染空格目标（应为绿点）
        cell.classList.remove('target', 'has-piece');
        cell.classList.add('target');
        // 有棋子的目标格 → 绿色方块；空位 → 绿点
        if (cell.innerHTML) cell.classList.add('has-piece');
      }
    });
  }

  // ⚠️ 审查 P3：原 `bindBoardClicks` / `handleTarget` 旧走子交互簇**经全仓 grep 确认无任何调用点**
  // （棋盘交互已统一由 FreeBoard 承担，见 play-demo.js / freeboard.js），属死代码，已删除。
  // 其中 `setSelection` / `reapplySelection` 仍被 `onSelectPiece`（持驹点选，被 play-views.js 引用）调用，保留。
  // `sendMove` 仍被升变/打子按钮复用，保留于此。
  function sendMove(usi) {
    api.send({ type: 'move', data: { usi } });
    selected = null;
    targets = [];
    // 立即移除本地高亮（否则走子后绿点/方块残留直到服务器推送）
    clearHighlights();
  }

  /** 清除棋盘上的选中/目标/方块高亮类 */
  function clearHighlights() {
    if (!board || !board.boardEl) return;
    board.boardEl.querySelectorAll('.cell.sel, .cell.target, .cell.has-piece').forEach((c) => {
      c.classList.remove('sel', 'target', 'has-piece');
    });
  }

  /** §6.3：升变弹层的显示/隐藏统一走这里——顺带把焦点管理交给 `A11y`。
   *  ⚠️ 2026-10-02 体验修复：注册 Esc/取消（此前 Esc 被刻意禁用、又没有取消按钮 →
   *  点到会升变的目标格就只能二选一、无法退出）。「成」已在 HTML 中置前并带 autofocus。 */
  function cancelPromote() {
    if (window.PlayDemo && window.PlayDemo.takePendingPromo) window.PlayDemo.takePendingPromo(); // 清掉感想战暂存
    pendingPromote = null;
    if (selected) { selected = null; targets = []; clearHighlights(); }
    hidePromoteOverlay();
  }
  function showPromoteOverlay() {
    const el = $('promoteOverlay');
    if (!el) return;
    el.classList.add('show');
    if (window.A11y) window.A11y.onDialogOpen(el, { onClose: cancelPromote });
  }
  function hidePromoteOverlay() {
    const el = $('promoteOverlay');
    if (!el) return;
    el.classList.remove('show');
    if (window.A11y) window.A11y.onDialogClose(el);
  }

  // 升变按钮（对局走子 / 感想战演示共用弹层）
  // 感想战分支必须走 demo_move 通道（带光标 index）；sendMove() 硬编码 type:'move' 不能复用
  $('btnPromote').addEventListener('click', () => {
    // §M5：感想战的升变选择存放在 play-demo.js，用 takePendingPromo() 取出并清空
    const demoPromo = window.PlayDemo.takePendingPromo();
    if (demoPromo) window.PlayDemo.sendMove(demoPromo.usiPromote);
    else if (pendingPromote) sendMove(pendingPromote.promoteUsi);
    hidePromoteOverlay();
    pendingPromote = null;
  });
  $('btnNoPromote').addEventListener('click', () => {
    const demoPromo = window.PlayDemo.takePendingPromo();
    if (demoPromo) window.PlayDemo.sendMove(demoPromo.usiMove);
    else if (pendingPromote) sendMove(pendingPromote.nonPromoteUsi);
    hidePromoteOverlay();
    pendingPromote = null;
  });
  if ($('btnPromoteCancel')) $('btnPromoteCancel').addEventListener('click', cancelPromote);

  // 认输 / 再来一局 / 退出
  // 结算横幅的「关闭」：原先写在 play.html 的 inline onclick 里，
  // 改为 data-act + 整页委托（2026-09-23，审查项 13f）。
  window.UI.onAction('banner-close', () => {
    const b = document.getElementById('banner');
    if (b) b.classList.remove('show');
  });

  $('btnResign').addEventListener('click', () => {
    if (confirm('确定认输吗？')) api.send({ type: 'resign' });
  });
  // 入玉宣言（§P1 R-d）：条件一律由服务端判定，成功即宣言方胜；失败会收到具体原因
  if ($('btnDeclare')) {
    $('btnDeclare').addEventListener('click', () => {
      api.send({ type: 'declare_nyugyoku' });
    });
  }
  // ==================================================================
  // 举报（2026-09-20 用户要求）
  //
  // ⚠️ 类别清单来自服务端（`hello.reportCategories`，源头是 `src/reports.js` 的 `CATEGORIES`），
  // 前端**不另抄一份**——抄了就会出现"前端能选、服务端不认"或反之。
  // ⚠️ 被举报人取**对面座位**的 id，而不是"当前视角那个人"写死成先手/后手；
  // 视角可翻转，取错就会举报到自己。
  // ⚠️ 服务端还会做去重与配额（同一目标 30 分钟内只收一条），这里只负责发起。
  // ==================================================================
  // ==================================================================
  // WS 事件
  // ==================================================================
  let lastMoveCount = 0;      // 上次已知手数（用于音效触发）
  let lastPieceCount = null;  // 上次棋盘棋子总数（吃子判定）；null = 尚未收到首帧
  function countPieces(st) {
    let n = 0;
    const b = st.board;
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
      if (b[r][c] && b[r][c].piece) n++;
    }
    return n;
  }
  // 首次交互解锁音频（浏览器自动播放策略）
  document.addEventListener('pointerdown', () => {
    if (window.Sound) window.Sound.ensureCtx();
  }, { once: true });

  // 音效开关
  const btnSound = $('btnSound');
  function refreshSoundBtn() {
    if (!btnSound) return;
    btnSound.textContent = (window.Sound && window.Sound.isEnabled()) ? '🔊 音效' : '🔇 静音';
  }
  if (btnSound) {
    btnSound.addEventListener('click', () => {
      if (!window.Sound) return;
      window.Sound.setEnabled(!window.Sound.isEnabled());
      refreshSoundBtn();
      if (window.Sound.isEnabled()) window.Sound.playMove();  // 反馈音
    });
    refreshSoundBtn();
  }

  api.on('state', (data) => {
    const prevMoves = lastMoveCount;
    lastMoveCount = (data.moves || []).length;
    // 走子音效：手数增加（自己或对手走子）。
    // ⚠️ 审查 P3：**首帧不发**。进入 / 重连时的第一条 state 可能一次性带着几十手历史，
    //   会被当成"刚走的一手"；且旧代码 lastPieceCount 初值 81 恒大于实际子数 → 必误播吃子音。
    //   这里以 lastPieceCount===null 标记"尚未收到首帧"：首帧只做基线初始化，之后才参与吃子判定。
    if (window.Sound && data.moves && data.moves.length > prevMoves && lastPieceCount !== null) {
      const pieces = countPieces(data);
      if (pieces < lastPieceCount) window.Sound.playCapture();  // 吃子
      else window.Sound.playMove();                             // 普通落子
    }
    lastPieceCount = countPieces(data);
    state = data;
    mySeat = data.seat || null;
    isPlayer = data.isPlayer === true;
    window.PlayClock.resetTick(); // 以"此刻"为倒计时基准（原 `lastTickTs = Date.now()`）
    views.scrollBoardIntoViewOnce(); // §S2：手机端首屏直接落到棋盘
    // §U4 对局 BGM：进行中开、终局停（刷新/中途进房也走这里）
    // ⚠️ 2026-10-08：把对手开局曲交给 Sound（设置里「播放对手 BGM」时交替循环）
    if (window.Sound) {
      if (window.Sound.setOpponentTrack) {
        const oppSeat = mySeat === 'b' ? 'w' : 'b';
        const opp = state.players && state.players[oppSeat];
        window.Sound.setOpponentTrack(opp && opp.bgm ? opp.bgm : null);
      }
      if (state.status === 'PLAYING') window.Sound.bgmStart();
      else if (state.status === 'FINISHED') window.Sound.bgmStop();
    }
    // 感想战路由（PLAN §G v6）：终局自动进入；新对局自动退出（§M5：实现在 play-demo.js）
    if (state.status === 'FINISHED' && state.result) {
      window.PlayDemo.enter(state);
      // ⚠️ 2026-10-02 体验修复：终局也必须渲染一次——胜负横幅在 render() 内，
      // 此前直接 return 导致「进入感想战」吞掉了正式结果呈现（只剩一闪而过的 toast）。
      views.render(state);
      return;
    }
    if (window.PlayDemo.isActive()) window.PlayDemo.exit();
    // 收到新状态时清空选中（如果对方走子则清）
    if (selected && mySeat !== state.turn) {
      selected = null;
      targets = [];
    }
    views.render(state);
  });

  // 棋钟校准（PLAN §M5：处理逻辑已抽到 play-clock.js）
  api.on('clock', (data) => window.PlayClock.syncFromServer(data));
  // 观众列表（PLAN §R）：渲染实现与 `spectator_update` 订阅均已抽到 play-chat.js（§M5），
  // 此处不再保留副本——避免"两份实现、改一处漏一处"。

  // ==================================================================
  // 感想战（PLAN §G v6 单页）：终局自动进入，同一棋盘组件切 demo-rules
  // ==================================================================
  // 整块（推演谱 / 光标浏览 / 演示权 / 自由摆棋 / 历史手合法走法）已抽到 **play-demo.js**（§M5）。
  // 下面的 `ensureBoard` 属于通用棋盘，**留在 core**——对战与感想战共用同一个 FreeBoard 实例；
  // 模块的依赖注入见本段末尾的 `PlayDemo.init(...)`。

  function ensureBoard(viewpoint) {
    if (fb) return;
    fb = new window.FreeBoard({
      board,
      viewpoint,
      interactive: false,
      mode: 'play',
      hands: {
        my: $('myHandPieces'), myColor: viewpoint,
        opp: $('oppHandPieces'), oppColor: viewpoint === 'b' ? 'w' : 'b',
      },
      onMove: (usi) => {
        // §M5：感想战走子（带光标 index）由 play-demo.js 负责
        if (window.PlayDemo.isActive()) window.PlayDemo.sendMove(usi);
        else api.send({ type: 'move', data: { usi } });
      },
      onPromoteChoice: ({ usiMove, usiPromote }) => {
        if (window.PlayDemo.isActive()) window.PlayDemo.setPendingPromo({ usiMove, usiPromote });
        else pendingPromote = { promoteUsi: usiPromote, nonPromoteUsi: usiMove };
        showPromoteOverlay();
      },
    });
    fb.attach();
    fb.bindHands($('myHandPieces'), viewpoint, $('oppHandPieces'), viewpoint === 'b' ? 'w' : 'b');
  }

  // `ensureOriginalPositions()`（原谱逐手局面缓存）与 `applyDemoMode()`（联合谱渲染 + §J4 权威覆盖）
  // 已搬到 **play-demo.js**（§M5）。其中 §J4 的「最新一手用服务端局面覆盖本地重放」逻辑原样保留。

  // `renderDemoMoveList()`（推演谱列表）与 `updateDemoUI()`（演示栏状态）已搬到 play-demo.js（§M5）。
  // core 里的 `escHtml` 也随之移除——原本只有这两处用它，两个模块各自持有一份转发。

  // 历史手合法走法（demo_legal）、demo 按钮交互、demo_state 订阅均已搬到 play-demo.js（§M5）。

  // ---- 依赖注入（与 play-clock.js 同一模式）----
  // 注入的是模块内读不到的 core 闭包状态与三个既有函数：
  //   getState / getFb / getSeat / getViewpoint   → 状态读取
  //   ensureBoard / renderPlayerBars / clearSelection → core 既有函数
  // 之后 core 只在「进入 / 退出 / 重绘」三个时机反向调用它（见 views.render() 与 api.on('state')）。
  window.PlayDemo.init({
    getState: function () { return state; },
    getFb: function () { return fb; },
    getSeat: function () { return { mySeat: mySeat, isPlayer: isPlayer }; },
    getViewpoint: function () { return views.currentViewpoint(); },
    ensureBoard: ensureBoard,
    renderPlayerBars: views.renderPlayerBars,
    clearSelection: function () { selected = null; targets = []; },
  });

  // ==================================================================
  // 对局事件
  // ==================================================================
  api.on('game_over', (data) => {
    notify('对局结束：' + (data.resultDetail || ''));
    if (window.Sound) { window.Sound.bgmStop(); } // §U4 终局停 BGM —— 终局音效统一由演示栏进入时播放（此前两处都播 → 双响）
    // 终局不跳页——state 推送（含 demo）会触发自动进入感想战模式
  });
  api.on('game_start', (data) => {
    notify('对局开始！');
    if (window.Sound) { window.Sound.playStart(); window.Sound.bgmStart(); } // §U4 开局起 BGM
  });
  // 对手请求再来一局：提示并高亮「再来一局」按钮
  api.on('rematch_requested', (data) => {
    const name = (data && data.requesterName) || '对手';
    notify(`${name} 请求再来一局，点击「再来一局」应战`);
    const btn = $('btnRematch');
    const bannerBtn = $('bannerRematch');
    btn.style.display = 'inline';
    btn.classList.add('pulse');
    if (bannerBtn) {
      bannerBtn.style.display = 'inline';
      bannerBtn.classList.add('pulse');
    }
    setTimeout(() => {
      btn.classList.remove('pulse');
      if (bannerBtn) bannerBtn.classList.remove('pulse');
    }, 4000);
  });
  api.on('error', (data) => {
    if (data && data.message) notify(data.message);
    // 私人房观战需要密码（PLAN §T2）：本页没有密码输入框 → 提示后回大厅的
    // 「👁 观战」入口补填密码（那里有房间码与密码框）。否则用户只会停在一片空白对局页。
    if (data && data.needPassword) {
      setTimeout(() => { location.href = 'lobby.html'; }, 1200);
    }
  });

  // 服务端明确回执「没有可进入的房间」（历史 bug 修复，2026-09-13）：
  // 从大厅点一张"自己是选手"的卡片时走的是 request_state（不带 spectate），
  // 若那局已结束 / 房间已销毁，服务端原先**静默不响应** → 页面一片白且没有任何提示。
  // 现在改为明确告知 + 送返大厅（与上面 needPassword 的处理风格一致）。
  api.on('no_room', () => {
    notify('该对局已结束或不存在，即将返回大厅');
    setTimeout(() => { location.href = 'lobby.html'; }, 1600);
  });
  // 同身份在别处登录：本页被顶替，提示并停止操作
  api.on('replaced', () => {
    toast('此身份已在其他窗口登录，本页已断开');
    board.setInteractive(false);
  });

  // ==================================================================
  // 聊天（§R2 分区 / §R3 观众进出提示）
  // ==================================================================
  // 整块已抽到 **play-chat.js**（PLAN §M5）：聊天记录、分区 tab、观众列表及其 WS 事件
  // 都在那边，由 `PlayChat.init()` 统一注册。此处不再保留副本。

  // 仅当显式带 spectate=1 参数时才进入观战（来自观战列表/随机观战入口）
  // 玩家（建房/加入/匹配/重连）跳转不带 spectate，走 request_state，由服务端按连接身份返回对应状态
  const params = new URLSearchParams(location.search);
  const isSpectate = !!params.get('spectate');
  const isTournamentJoin = !!params.get('join');
  const roomParam = params.get('room');
  function enterRoom() {
    if (isSpectate) {
      // 私人房间观战密码（PLAN §T2）：由大厅放进 sessionStorage，随本连接提交。
      // 取完即删——避免残留在会话里被下一次观战误用。
      let pw = '';
      try {
        pw = window.sessionStorage.getItem('tdshogi_spectate_pw') || '';
        if (pw) window.sessionStorage.removeItem('tdshogi_spectate_pw');
      } catch (_) { /* 隐私模式下 sessionStorage 可能不可用，忽略即可 */ }
      api.send({ type: 'spectate', data: { roomId: roomParam, password: pw } });
    } else if (isTournamentJoin) {
      // 赛事对局：玩家主动进入（建局时可能不在线）
      api.send({ type: 'join_tournament_match', data: { roomId: roomParam } });
    } else {
      // 请求当前状态（可能是重连，也可能是玩家跳转进来）；
      // 带 URL 里的 roomId：服务端回位优先绑定该房间（重新匹配后不被旧对局的
      // 复盘中座位按插入顺序劫持——幽灵房修复）
      api.send({ type: 'request_state', data: roomParam ? { roomId: roomParam } : {} });
    }
  }
  // WS 首次连接与断线重连统一在此进入房间；
  // 观战者重连后服务端不会主动重推 state，必须重新发起 spectate/request_state
  // 设置变更 → 重渲染棋盘（坐标 §S4 / 图集 §S5 / 上一步高亮，PLAN §S1）
  if (window.Settings) {
    window.Settings.subscribe((all, key) => {
      if (['showCoords', 'highlightLastMove'].indexOf(key) >= 0) {
        if (state) views.render(state);
        else if (fb) fb.render();
      }
    });
  }
  // ⚠️ 2026-10-08：棋子图集迁入装扮 —— 装备变化后按新图集重画
  document.addEventListener('tdshogi-appearance', () => {
    if (state) views.render(state);
    else if (fb) fb.render();
  });

  // ==================================================================
  // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 对局立绘渲染
  //
  // 独立处理器：**不改动既有的 state 渲染主逻辑**（play-views.js），只在本页额外
  // 挂一个 state 监听，把 `state.players[b|w].sprite` 画到棋盘两侧（见 DESIGN §9）。
  //   kind==='glyph' → 大号字形；kind==='image' → <img src=value>；空 → 容器留空（不占视觉）。
  // 视角无关：先手(b)恒在右、后手(w)恒在左（与各自持驹所在方位一致，不随观战视角翻转）。
  // 移动端（<900px，与 CSS 断点对齐）不展示，直接隐藏。
  // ==================================================================
  const escHtml = window.UI.esc;
  function renderSprites(st) {
    const boxes = { b: $('spriteB'), w: $('spriteW') };
    if (!boxes.b || !boxes.w) return; // HTML 里没插立绘容器就直接跳过
    const narrow = window.innerWidth < 900;
    for (const seat of ['b', 'w']) {
      const box = boxes[seat];
      const sp = st && st.players && st.players[seat] ? st.players[seat].sprite : null;
      if (narrow || !sp || !sp.value) { box.style.display = 'none'; box.innerHTML = ''; continue; }
      if (sp.kind === 'image') {
        box.innerHTML = `<img src="${escHtml(sp.value)}" alt="" style="max-height:220px;max-width:100%;object-fit:contain;">`;
      } else {
        // 字形（glyph）占位立绘：大号衬线字
        box.innerHTML = `<span style="font-size:72px;line-height:1;font-family:var(--font-serif);color:var(--gold-light);">${escHtml(sp.value)}</span>`;
      }
      box.style.display = 'flex';
    }
  }
  api.on('state', (data) => renderSprites(data));

  api.on('open', enterRoom);
})();
