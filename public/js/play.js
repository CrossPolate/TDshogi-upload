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
  // 渲染
  // ==================================================================
  /** 当前棋盘视角：对局者固定自己视角；观战者可切换（PLAN §R1） */
  function currentViewpoint() {
    return isPlayer ? (mySeat === 'w' ? 'w' : 'b') : spectatorViewpoint;
  }

  /**
   * §R5 观战信息增强：玩家栏副标题 —— 等级 / ELO / 称号。
   * 只对确实存在的值做拼接，避免出现 "Lv.undefined" 这种占位。
   */
  function playerMeta(p) {
    if (!p) return '';
    const parts = [];
    if (p.level != null) parts.push(`Lv.${p.level}`);
    if (p.rating != null) parts.push(`ELO ${p.rating}`);
    const meta = parts.join(' · ');
    return p.title ? `${meta} · ${p.title}` : meta;
  }

  /**
   * 玩家栏渲染（名字 / ELO / 悬停信息卡所需的 data-player-id）。
   *
   * ⚠️ 必须独立成函数：终局时 `api.on('state')` 走的是 `enterDemo(state); return;`
   * ——**跳过了 render()**。此前玩家栏只写在 render() 里，于是「重进到一个已结束的房间」
   * 的人（首个 state 就是 FINISHED）玩家栏从未被渲染：显示占位符，且双方
   * `data-player-id` 为空导致悬停信息卡失效。
   * 这正是「退出再进来后看不到双方 id」的根因，重进者才中招、一直在页面上的人不受影响。
   */
  function renderPlayerBars(st) {
    const players = st.players || {};
    const viewpoint = currentViewpoint();
    // 视角布局：上方=对面，下方=自己
    const oppSeat = viewpoint === 'b' ? 'w' : 'b';
    const mySeatX = viewpoint === 'b' ? 'b' : 'w';

    // 上方（对面）玩家栏
    const opp = players[oppSeat];
    const oppDisconnected = opp && opp.connected === false && st.status === 'PLAYING';
    $('topName').textContent = (opp && opp.name) || (oppSeat === 'b' ? '先手' : '後手');
    $('topName').setAttribute('data-player-id', (opp && opp.id) || ''); // 悬停信息卡
    $('topRating').textContent = oppDisconnected
      ? '⚠️ 断线 · 60秒内未重连将判你获胜'
      : (opp ? playerMeta(opp) : '');
    $('topPlayerBar').classList.toggle('disconnected', !!oppDisconnected);
    $('topPlayerBar').classList.toggle('active', st.turn === oppSeat && !oppDisconnected);
    // 头像（2026-09-20）：来自 state.players[].avatar（服务端按 playerId 查会话）
    $('topAvatar').textContent = window.UI.avatarGlyph(opp && opp.avatar, (opp && opp.name) || '');

    // 下方（自己）玩家栏：名字优先显示自己账号名（localStorage），对手用服务端名
    const me = players[mySeatX];
    const myName = guest && guest.name ? guest.name : (me && me.name) || (mySeatX === 'b' ? '先手' : '後手');
    $('bottomName').textContent = myName;
    $('bottomName').setAttribute('data-player-id', (me && me.id) || '');
    $('bottomRating').textContent = me ? playerMeta(me) : '';
    $('bottomPlayerBar').classList.toggle('active', st.turn === mySeatX);
    // 自己的头像以服务端为准（换了头像 → 服务端推新 state），拿不到再退回本地记录
    $('bottomAvatar').textContent = window.UI.avatarGlyph(
      (me && me.avatar) || (guest && guest.avatar), myName);
  }

  /**
   * 手机/平板端首次拿到局面后，把棋盘滚到视口内（PLAN §S2）。
   * 此前首屏停在顶部信息栏与侧栏，要往下滚才见到棋盘——对一个下棋应用来说主次颠倒。
   * 只用一次（后续走子不应打断用户正在看的内容），宽屏不执行。
   */
  let boardScrolled = false;
  function scrollBoardIntoViewOnce() {
    if (boardScrolled) return;
    boardScrolled = true;
    if (window.innerWidth > 900) return;
    const el = $('boardContainer');
    if (!el) return;
    setTimeout(() => {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    }, 80);
  }

  function render(state) {
    const viewpoint = currentViewpoint();
    renderPlayerBars(state);

    // 房间信息 + 时间控制
    const tcName = TIME_CONTROLS[state.timeControl] ? TIME_CONTROLS[state.timeControl].name : '';
    $('roomCodeLabel').textContent = state.code ? `房间 ${state.code}` : '对局';
    if (tcName) $('roomCodeLabel').textContent += ` · ${tcName}`;
    // 駒落ち（让子）：**必须显眼**——让子局的先手是"上手"（少棋子的那一方，即房主），
    // 与平手局相反；不提示的话，玩家会以为"对手凭什么先走"或盘面少了棋子是程序出错。
    if (state.handicapLabel) {
      $('roomCodeLabel').textContent += ` · ${state.handicapLabel}（上手先手 · 不计 ELO）`;
    }

    // 观战标识
    const spectator = !isPlayer;
    $('spectatorTag').style.display = spectator ? 'inline' : 'none';
    $('btnResign').style.display = spectator ? 'none' : 'inline';
    // 入玉宣言（§P1 R-d）：**只在服务端判定「可宣言」时亮出按钮**。
    // 规则只实现一处（`game.canDeclareNyugyoku`），前端不自己算点数；
    // 条件不满足 → 按钮不存在 → 不存在「误点被判反则负」的风险。
    const declareBtn = $('btnDeclare');
    if (declareBtn) {
      const d = state.canDeclare;
      const canDecl = !spectator && state.status === 'PLAYING' && !!(d && d.ok);
      declareBtn.style.display = canDecl ? 'inline' : 'none';
      if (canDecl) {
        declareBtn.title = `入玉宣言（当前 ${d.points} 点 · 敌阵内 ${d.count} 枚）→ 宣言方获胜`;
      }
    }
    // 举报（2026-09-20）：观战者没有"对手"，不给按钮；对局者任何时候都能举报
    //（对局结束后仍可能要举报——比如对面半路挂机/辱骂）
    const reportBtn = $('btnReport');
    if (reportBtn) {
      reportBtn.style.display = spectator ? 'none' : 'inline';
      if (spectator) $('reportPanel').style.display = 'none';
    }
    // §R1：视角切换按钮仅观战者可见，文字反映当前视角
    const vpBtn = $('btnViewpoint');
    if (vpBtn) {
      vpBtn.style.display = spectator ? 'inline' : 'none';
      vpBtn.textContent = viewpoint === 'b' ? '🔄 视角·先手' : '🔄 视角·後手';
    }

    // 棋钟初始 + 读秒（PLAN §M5：逻辑已抽到 play-clock.js）
    window.PlayClock.syncFromState(state);

    // 感想战中：棋盘由推演谱渲染（state 推送仅更新横幅/时钟等周边）
    // §M5：感想战逻辑已抽到 play-demo.js
    if (window.PlayDemo.isActive() && fb) {
      fb.setViewpoint(viewpoint); // §R1：观战者在感想战中也能切视角
      if (state.status === 'FINISHED') { window.PlayDemo.applyMode(); }
      window.PlayDemo.updateUI();
      return;
    }

    // 棋盘渲染与交互统一交给 FreeBoard 组件（PLAN §G v6）
    ensureBoard(viewpoint);
    fb.setViewpoint(viewpoint); // §R1：切换观战视角（内部同视角则空转）
    fb.setModel({ board: state.board, hands: state.hands }, state.lastMove);
    // §J2：王手格此前作为第三个参数传给 setModel 被丢弃，改用专门的 setCheck
    fb.setCheck(state.check ? [findKingSq(state, state.turn)] : []);
    fb.setLegalTargets(state.legalTargetsBySq || {});
    fb.setTurn(state.turn); // 手番方持驹才可点选（打子符号与颜色无关，防误选对手驹台）
    const canMove = isPlayer && state.status === 'PLAYING' && mySeat === state.turn;
    fb.setInteractive(canMove);
    fb.render();
    renderMoveList(state);
    // 观众列表：进场时用 state 快照初始化（此前只有 spectator_update 才渲染，
    // 导致刚进入的观战者一直看到"暂无观众"，直到有人进出才更新）
    // §M5：渲染实现已抽到 play-chat.js
    if (state.spectators) window.PlayChat.renderSpectators(state.spectators);

    // 胜负横幅
    if (state.result) {
      showResult(state);
      const isTournament = state.roomType === 'tournament';
      $('btnRematch').style.display = (isPlayer && !isTournament) ? 'inline' : 'none';
      $('bannerRematch').style.display = (isPlayer && !isTournament) ? 'inline' : 'none';  // 观战者/赛事局不可点再来一局
    } else {
      $('banner').classList.remove('show');
      $('btnRematch').style.display = 'none';
    }
  }

  function findKingSq(st, color) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = st.board[r][c];
        if (cell && cell.piece && cell.color === color && (cell.piece === '玉' || cell.piece === '王')) {
          return cell.sq;
        }
      }
    }
    return null;
  }

  function renderHands(st) {
    const vp = mySeat === 'w' ? 'w' : 'b';
    const oppSeat = vp === 'b' ? 'w' : 'b'; // 对手在左
    const mySeatH = vp;                       // 自己在右
    // 左侧 = 对手持驹（不可操作）；以自己视角渲染，对手棋子朝下
    window.renderHands($('oppHandPieces'), st.hands, oppSeat, null, vp);
    // 右侧 = 自己持驹（可操作打子）；以自己视角渲染，自己棋子正立
    window.renderHands($('myHandPieces'), st.hands, mySeatH, (piece) => onSelectPiece(piece, mySeatH), vp);
  }

  function renderMoveList(st) {
    const el = $('moveList');
    const moves = st.moves || [];
    const kif = st.movesKif || [];
    if (!moves.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">尚未走子</div>';
      return;
    }
    // 每手耗时（KIF 消費時間/累計時間样式）
    const times = st.moveTimes || [];
    let cum = 0;
    const fmt = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    el.innerHTML = moves.map((m, i) => {
      const player = i % 2 === 0 ? '▲' : '△';
      const label = kif[i] || m;
      const spent = Number(times[i]) || 0;
      cum += spent;
      const timeTxt = (spent || cum) ? ' <span style="color:var(--text-dim);font-size:11px;">(' + fmt(spent) + '/' + fmt(cum) + ')</span>' : '';
      return `<div class="move-row"><span class="no">${i + 1}</span><span>${player} ${label}${timeTxt}</span></div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  // 棋钟已抽到 play-clock.js（PLAN §M5）：此处只做一次依赖注入。
  // 注入的是模块内读不到的两个"外部状态"——在 play.js 里它们是闭包变量：
  //   state → 最新对局状态（判断是否 PLAYING、谁的回合）
  //   视角  → 与棋盘**共用 `currentViewpoint()`**，保证两者永远同一口径
  //          （对局者固定自己视角；观战者跟随可切换的 spectatorViewpoint）
  window.PlayClock.init({
    getState: function () { return state; },
    getViewpoint: function () { return currentViewpoint(); },
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
    const checkSqs = st.check ? [findKingSq(st, st.turn)] : [];
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

  function bindBoardClicks(canMove, st) {
    // 重新绑定棋盘格点击（使用事件委托，绑在容器上避免重复绑定）
    const boardEl = board.boardEl;
    boardEl.onclick = (e) => {
      if (!canMove) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const sq = cell.dataset.sq;
      if (!sq) return;
      if (selected) {
        // 有选中：尝试落子
        const t = targets.find((x) => x.to === sq);
        if (t) {
          handleTarget(t);
        } else {
          // 未点中合法目标：若点是己方棋子则改选
          setSelection(sq);
        }
      } else {
        // 无选中：尝试选中己方棋子
        setSelection(sq);
      }
    };
  }

  function handleTarget(t) {
    // 升变：同一 from→to 同时有成与不成
    const cands = targets.filter((x) => x.to === t.to);
    const hasPromote = cands.some((x) => x.promote);
    const hasNonPromote = cands.some((x) => !x.promote);
    if (hasPromote && hasNonPromote && selected && !selected.startsWith('P*') && !/^[PLNSGBR]$/.test(selected)) {
      // 弹层
      const promoteUsi = cands.find((x) => x.promote).usi;
      const nonPromoteUsi = cands.find((x) => !x.promote).usi;
      pendingPromote = { promoteUsi, nonPromoteUsi };
      $('promoteOverlay').classList.add('show');
      return;
    }
    // 直接走
    sendMove(t.usi);
  }

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

  // 升变按钮（对局走子 / 感想战演示共用弹层）
  // 感想战分支必须走 demo_move 通道（带光标 index）；sendMove() 硬编码 type:'move' 不能复用
  $('btnPromote').addEventListener('click', () => {
    // §M5：感想战的升变选择存放在 play-demo.js，用 takePendingPromo() 取出并清空
    const demoPromo = window.PlayDemo.takePendingPromo();
    if (demoPromo) window.PlayDemo.sendMove(demoPromo.usiPromote);
    else if (pendingPromote) sendMove(pendingPromote.promoteUsi);
    $('promoteOverlay').classList.remove('show');
    pendingPromote = null;
  });
  $('btnNoPromote').addEventListener('click', () => {
    const demoPromo = window.PlayDemo.takePendingPromo();
    if (demoPromo) window.PlayDemo.sendMove(demoPromo.usiMove);
    else if (pendingPromote) sendMove(pendingPromote.nonPromoteUsi);
    $('promoteOverlay').classList.remove('show');
    pendingPromote = null;
  });

  // 认输 / 再来一局 / 退出
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
  function reportTarget() {
    if (!state || !state.players) return null;
    // ⚠️ 用 `currentViewpoint()` 而不是直接读 `viewpoint`——后者只是各渲染函数里的**局部**常量，
    // 在模块作用域读会直接 ReferenceError（本文件里 91/139/306 行都是各自声明的）。
    const oppSeat = currentViewpoint() === 'b' ? 'w' : 'b';
    const opp = state.players[oppSeat];
    return opp && opp.id ? opp : null;
  }

  function renderReportCategories(list) {
    const sel = $('reportCategory');
    if (!sel || !list || !list.length || sel.options.length) return; // 幂等：已填过就不再填
    sel.innerHTML = list.map((c) => `<option value="${window.UI.esc(c.id)}">${window.UI.esc(c.label)}</option>`).join('');
  }

  api.on('hello', (d) => { if (d) renderReportCategories(d.reportCategories); });

  if ($('btnReport')) {
    $('btnReport').addEventListener('click', () => {
      const p = $('reportPanel');
      const show = p.style.display === 'none';
      p.style.display = show ? '' : 'none';
      // 按钮在顶部交互栏、表单在右侧「操作」卡里（2026-09-20 移动）——
      // 不滚过去的话，点完看着像"没反应"（尤其手机窄屏，表单在屏幕外）
      if (show) { try { p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {} }
    });
    $('btnReportCancel').addEventListener('click', () => { $('reportPanel').style.display = 'none'; });
    $('btnReportSubmit').addEventListener('click', () => {
      const t = reportTarget();
      if (!t) return toast('找不到可举报的对手');
      api.send({
        type: 'report',
        data: {
          targetId: t.id,
          targetName: t.name,
          category: $('reportCategory').value,
          detail: $('reportDetail').value,
          context: { roomId: (state && state.roomId) || null },
        },
      });
    });
    api.on('reported', () => {
      toast('举报已提交，管理员会尽快处理');
      $('reportPanel').style.display = 'none';
      $('reportDetail').value = '';
    });
  }

  $('btnRematch').addEventListener('click', () => {
    api.send({ type: 'rematch' });
  });
  $('bannerRematch').addEventListener('click', () => {
    api.send({ type: 'rematch' });
    $('banner').classList.remove('show');
  });
  $('btnLeave').addEventListener('click', () => {
    api.send({ type: 'leave' });
    // 赛事对局退出回赛事页，其余回大厅
    location.href = (state && state.roomType === 'tournament') ? 'tournaments.html' : 'lobby.html';
  });
  // §R1：观战视角切换（先手 ⇄ 后手）。仅观战者可用——对局者固定自己视角。
  $('btnViewpoint').addEventListener('click', () => {
    if (isPlayer) return;
    spectatorViewpoint = spectatorViewpoint === 'b' ? 'w' : 'b';
    if (state) render(state);
    else if (fb) fb.setViewpoint(spectatorViewpoint);
  });

  function showResult(st) {
    const names = st.players || {};
    const winnerName = st.result === 'b' ? (names.b && names.b.name) : st.result === 'w' ? (names.w && names.w.name) : null;
    const loserName = st.result === 'b' ? (names.w && names.w.name) : st.result === 'w' ? (names.b && names.b.name) : null;
    let text;
    if (st.resultDetail === '投了') {
      text = `${loserName || '一方'} 投了 · ${winnerName || ''} 胜`;
    } else if (st.resultDetail === '接続切断') {
      // 断线（中途退出/掉线超时）：提示对手掉线而非投了
      text = `${loserName || '对手'} 掉线断开 · ${winnerName || ''} 胜`;
    } else if (st.resultDetail === '詰み') {
      text = `${winnerName || '一方'} 詰み勝ち`;
    } else if (st.resultDetail === '時間切れ') {
      text = `${winnerName || '一方'} 时间切れ勝ち`;
    } else if (st.result === '-') {
      text = `${st.resultDetail || '和棋'}`;
    } else {
      text = '对局结束';
    }
    $('bannerText').textContent = text;
    $('banner').classList.add('show');
  }

  // ==================================================================
  // WS 事件
  // ==================================================================
  let lastMoveCount = 0;      // 上次已知手数（用于音效触发）
  let lastPieceCount = 81;    // 上次棋盘棋子总数（吃子判定）
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
    // 走子音效：手数增加（自己或对手走子）
    if (window.Sound && data.moves && data.moves.length > prevMoves) {
      const pieces = countPieces(data);
      if (pieces < lastPieceCount) window.Sound.playCapture();  // 吃子
      else window.Sound.playMove();                             // 普通落子
    }
    lastPieceCount = countPieces(data);
    state = data;
    mySeat = data.seat || null;
    isPlayer = data.isPlayer === true;
    window.PlayClock.resetTick(); // 以"此刻"为倒计时基准（原 `lastTickTs = Date.now()`）
    scrollBoardIntoViewOnce(); // §S2：手机端首屏直接落到棋盘
    // 感想战路由（PLAN §G v6）：终局自动进入；新对局自动退出（§M5：实现在 play-demo.js）
    if (state.status === 'FINISHED' && state.result) {
      window.PlayDemo.enter(state);
      return;
    }
    if (window.PlayDemo.isActive()) window.PlayDemo.exit();
    // 收到新状态时清空选中（如果对方走子则清）
    if (selected && mySeat !== state.turn) {
      selected = null;
      targets = [];
    }
    render(state);
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
        $('promoteOverlay').classList.add('show');
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
  // 之后 core 只在「进入 / 退出 / 重绘」三个时机反向调用它（见 render() 与 api.on('state')）。
  window.PlayDemo.init({
    getState: function () { return state; },
    getFb: function () { return fb; },
    getSeat: function () { return { mySeat: mySeat, isPlayer: isPlayer }; },
    getViewpoint: function () { return currentViewpoint(); },
    ensureBoard: ensureBoard,
    renderPlayerBars: renderPlayerBars,
    clearSelection: function () { selected = null; targets = []; },
  });

  // ==================================================================
  // 对局事件
  // ==================================================================
  api.on('game_over', (data) => {
    notify('对局结束：' + (data.resultDetail || ''));
    if (window.Sound) window.Sound.playEnd();
    // 终局不跳页——state 推送（含 demo）会触发自动进入感想战模式
  });
  api.on('game_start', (data) => {
    notify('对局开始！');
    if (window.Sound) window.Sound.playStart();
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
      if (['showCoords', 'atlas', 'highlightLastMove'].indexOf(key) < 0) return;
      if (state) render(state);
      else if (fb) fb.render();
    });
  }

  api.on('open', enterRoom);
})();
