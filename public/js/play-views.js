/**
 * play-views.js — 对局页**视图层**：把 state 画到 DOM 上（渲染 + 横幅 + 持驹 + 棋谱 + 举报弹层）
 *
 * §M5（2026-09-28）：从 `public/js/play.js`（原 748 行）整段搬出，逻辑一字未改，
 * 只做两处机械变换：① 整体左移 2 格缩进；② 读到 play.js 闭包里**可变变量**的地方
 * （state / mySeat / isPlayer / fb / spectatorViewpoint）改成读注入的 `ctx` 属性。
 *
 * ⚠️ 为什么 `ctx` 的属性必须是 **getter**：这些都是 `let`，会在对局过程中被重新赋值
 * （换座位、切视角、切自由摆棋）。若在 make() 时按值捕获，视图层就会永远看到初始值
 * （症状：切了视角棋盘不跟着翻）。
 *
 * 装配见 `play.js`：`const views = window.PlayViews.make({ ctx, ... });`
 * ⚠️ 本文件必须在 `play.js` **之前**加载（`play.js` 装配时会检查，缺失即抛错）。
 */
(function (global) {
  'use strict';

  function make(deps) {
    const ctx = deps.ctx;
    const $ = deps.$;
    const TIME_CONTROLS = deps.TIME_CONTROLS;
    const api = deps.api;
    const ensureBoard = deps.ensureBoard;
    const guest = deps.guest;
    const onSelectPiece = deps.onSelectPiece;
    const toast = deps.toast;

function currentViewpoint() {
  return ctx.isPlayer ? (ctx.mySeat === 'w' ? 'w' : 'b') : ctx.spectatorViewpoint;
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
  // ⚠️ 2026-10-07：支持图片头像（道具上传的 /uploads/...）
  const setAv = (id, avatar, name) => {
    const node = $(id);
    if (!node) return;
    if (window.UI && window.UI.setAvatarContent) window.UI.setAvatarContent(node, avatar, name);
    else node.textContent = window.UI.avatarGlyph(avatar, name);
  };
  setAv('topAvatar', opp && opp.avatar, (opp && opp.name) || '');

  // 下方（自己）玩家栏：名字优先显示自己账号名（localStorage），对手用服务端名
  const me = players[mySeatX];
  const myName = guest && guest.name ? guest.name : (me && me.name) || (mySeatX === 'b' ? '先手' : '後手');
  $('bottomName').textContent = myName;
  $('bottomName').setAttribute('data-player-id', (me && me.id) || '');
  $('bottomRating').textContent = me ? playerMeta(me) : '';
  $('bottomPlayerBar').classList.toggle('active', st.turn === mySeatX);
  // 自己的头像以服务端为准（换了头像 → 服务端推新 state），拿不到再退回本地记录
  setAv('bottomAvatar', (me && me.avatar) || (guest && guest.avatar), myName);
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
  const spectator = !ctx.isPlayer;
  $('spectatorTag').style.display = spectator ? 'inline' : 'none';
  $('btnResign').style.display = spectator ? 'none' : 'inline';
  // 入玉宣言（§P1 R-d）：**只在服务端判定「可宣言」时亮出按钮**。
  // 规则只实现一处（`game.canDeclareNyugyoku`），前端不自己算点数；
  // 条件不满足 → 按钮不存在 → 不存在「误点被判反则负」的风险。
  const declareBtn = $('btnDeclare');
  if (declareBtn) {
    const d = state.canDeclare;
    // ⚠️ 2026-10-02 体验修复：canDeclare 按「当前手番方」算，必须再校验「是不是我」——
    // 否则对手回合/对手满足条件时，我方屏幕也会亮出按钮，一点即报错（看得见用不了的假按钮）。
    const canDecl = !spectator && ctx.isPlayer && state.status === 'PLAYING'
      && ctx.mySeat === state.turn && !!(d && d.ok);
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
  if (window.PlayDemo.isActive() && ctx.fb) {
    ctx.fb.setViewpoint(viewpoint); // §R1：观战者在感想战中也能切视角
    if (state.status === 'FINISHED') { window.PlayDemo.applyMode(); }
    window.PlayDemo.updateUI();
    // ⚠️ 2026-10-02 体验修复：终局必须显示胜负横幅——此分支此前直接 return，
    // 把下面的 showResult 吞掉了，导致「进入感想战」后看不到正式结果。
    if (state.result) {
      showResult(state);
      const isTournament = state.roomType === 'tournament';
      $('btnRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';
      $('bannerRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';
    }
    return;
  }

  // 棋盘渲染与交互统一交给 FreeBoard 组件（PLAN §G v6）
  ensureBoard(viewpoint);
  ctx.fb.setViewpoint(viewpoint); // §R1：切换观战视角（内部同视角则空转）
  ctx.fb.setModel({ board: state.board, hands: state.hands }, state.lastMove);
  // §J2：王手格此前作为第三个参数传给 setModel 被丢弃，改用专门的 setCheck
  ctx.fb.setCheck(state.check ? [findKingSq(state, state.turn)] : []);
  ctx.fb.setLegalTargets(state.legalTargetsBySq || {});
  ctx.fb.setTurn(state.turn); // 手番方持驹才可点选（打子符号与颜色无关，防误选对手驹台）
  const canMove = ctx.isPlayer && state.status === 'PLAYING' && ctx.mySeat === state.turn;
  ctx.fb.setInteractive(canMove);
  ctx.fb.render();
  renderMoveList(state);
  // 观众列表：进场时用 state 快照初始化（此前只有 spectator_update 才渲染，
  // 导致刚进入的观战者一直看到"暂无观众"，直到有人进出才更新）
  // §M5：渲染实现已抽到 play-chat.js
  if (state.spectators) window.PlayChat.renderSpectators(state.spectators);

  // 胜负横幅
  if (state.result) {
    showResult(state);
    const isTournament = state.roomType === 'tournament';
    $('btnRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';
    $('bannerRematch').style.display = (ctx.isPlayer && !isTournament) ? 'inline' : 'none';  // 观战者/赛事局不可点再来一局
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
  const vp = ctx.mySeat === 'w' ? 'w' : 'b';
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
    // ⚠️ 2026-10-02 审查 P3：走子文本做防御性转义（同 play-demo.js 用 escHtml）——
    // 来源虽为服务端生成，仍应转义，避免将来引入用户可控内容时成为 XSS 面。
    const safeLabel = (typeof esc === 'function') ? esc(label) : String(label);
    return `<div class="move-row"><span class="no">${i + 1}</span><span>${player} ${safeLabel}${timeTxt}</span></div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}
function reportTarget() {
  if (!ctx.state || !ctx.state.players) return null;
  // ⚠️ 用 `currentViewpoint()` 而不是直接读 `viewpoint`——后者只是各渲染函数里的**局部**常量，
  // 在模块作用域读会直接 ReferenceError（本文件里 91/139/306 行都是各自声明的）。
  const oppSeat = currentViewpoint() === 'b' ? 'w' : 'b';
  const opp = ctx.state.players[oppSeat];
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
        context: { roomId: (ctx.state && ctx.state.roomId) || null },
      },
    });
  });
  api.on('reported', () => {
    toast('举报已提交，管理员会尽快处理');
    $('reportPanel').style.display = 'none';
    $('reportDetail').value = '';
  });
}

// 「再来一局」：双方同意才重开。请求方此前无任何回执（服务端只通知对手），
// 玩家会以为没反应而连点——这里本地即时给「已请求，等待对方同意」并禁用按钮。
let rematchRequested = false;
function requestRematch(btn) {
  if (rematchRequested) return;
  rematchRequested = true;
  api.send({ type: 'rematch' });
  toast('已请求再来一局，等待对方同意…');
  if (btn) btn.disabled = true;
}
$('btnRematch').addEventListener('click', (e) => requestRematch(e.currentTarget));
$('bannerRematch').addEventListener('click', (e) => {
  requestRematch(e.currentTarget);
  $('banner').classList.remove('show');
});
api.on('game_start', () => { rematchRequested = false; }); // 对局重开 → 复位
$('btnLeave').addEventListener('click', () => {
  const inGame = ctx.isPlayer && ctx.state && ctx.state.status === 'PLAYING';
  // ⚠️ 2026-10-02 体验修复：对局中「退出对局」会被服务端判「接続切断」负，
  // 此前无任何确认、一点即判负并跳走（认输反有确认）——补一次确认。
  if (inGame && !window.confirm('退出将对局判负（相当于认输），确定退出吗？')) return;
  api.send({ type: 'leave' });
  // 赛事对局退出回赛事页，其余回大厅
  location.href = (ctx.state && ctx.state.roomType === 'tournament') ? 'tournaments.html' : 'lobby.html';
});
// §R1：观战视角切换（先手 ⇄ 后手）。仅观战者可用——对局者固定自己视角。
$('btnViewpoint').addEventListener('click', () => {
  if (ctx.isPlayer) return;
  ctx.spectatorViewpoint = ctx.spectatorViewpoint === 'b' ? 'w' : 'b';
  if (ctx.state) render(ctx.state);
  else if (ctx.fb) ctx.fb.setViewpoint(ctx.spectatorViewpoint);
});

function showResult(st) {
  const names = st.players || {};
  const bName = (names.b && names.b.name) || '先手';
  const wName = (names.w && names.w.name) || '後手';
  const winnerName = st.result === 'b' ? bName : st.result === 'w' ? wName : null;
  const loserName = st.result === 'b' ? wName : st.result === 'w' ? bName : null;
  // ⚠️ 2026-10-02 体验修复：统一中文 + 让「和棋」有明确注解，胜负方口径一致。
  let text;
  if (st.result === '-') {
    text = `和棋（${st.resultDetail || '和棋'}）`;
  } else if (!winnerName) {
    text = '对局结束';
  } else if (st.resultDetail === '投了') {
    text = `${loserName} 投了 · ${winnerName} 胜`;
  } else if (st.resultDetail === '接続切断') {
    text = `${loserName} 掉线 · ${winnerName} 胜`;
  } else if (st.resultDetail === '時間切れ') {
    text = `${winnerName} 胜（对手超时）`;
  } else if (st.resultDetail === '詰み') {
    text = `${winnerName} 胜（将死）`;
  } else if (st.resultDetail === '入玉宣言') {
    text = `${winnerName} 胜（入玉宣言）`;
  } else {
    text = `${winnerName} 胜`;
  }
  $('bannerText').textContent = text;
  $('banner').classList.add('show');
}

    return {
      boardScrolled,
      currentViewpoint,
      findKingSq,
      playerMeta,
      render,
      renderHands,
      renderMoveList,
      renderPlayerBars,
      renderReportCategories,
      reportTarget,
      scrollBoardIntoViewOnce,
      showResult,
    };
  }

  global.PlayViews = { make };
})(typeof window !== 'undefined' ? window : globalThis);
