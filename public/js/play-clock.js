/**
 * play-clock.js — 对局棋钟（本时倒计时 + 读秒）
 *
 * 从 `play.js` 抽出（PLAN §M5 前端拆分第一步）。**逻辑一字未改**，只把两处对外部
 * 状态的读取改成了注入的回调——因为它们在 play.js 里原本是 IIFE 的闭包变量：
 *   - `getState()`     取最新对局状态（原闭包变量 `state`）
 *   - `getViewpoint()` 取当前显示视角（原 `mySeat === 'w' ? 'w' : 'b'`）
 *
 * 对外接口（由 play.js 的 View 生命周期驱动）：
 *   PlayClock.init({ getState, getViewpoint })  注入依赖并启动 tick（play.mount 调）
 *   PlayClock.destroy()                         停表并复位模块状态（play.unmount 调）
 *   PlayClock.syncFromState(state)              state 消息里的棋钟字段
 *   PlayClock.syncFromServer(data)              clock 消息（走子后以服务端校准）
 *   PlayClock.resetTick()                       以"此刻"为基准（收到服务端消息时）
 *   PlayClock.update()                          强制刷新显示
 *
 * 依赖：DOM 元素 `#topClock` / `#bottomClock`；读秒音效走 `window.Sound`。
 */
(function () {
  'use strict';

  let getState = function () { return null; };
  let getViewpoint = function () { return 'b'; };

  // 本时剩余 / 当前手读秒剩余 / 是否在读秒 / 秒读时长
  let localClocks = { b: 15 * 60 * 1000, w: 15 * 60 * 1000 };
  let localByoyomi = { b: 0, w: 0 };
  let inByoyomi = { b: false, w: false };
  let byoyomiDuration = 0;
  let lastTickTs = Date.now();
  let lastTickSecond = -1;  // 读秒音效：记录上次"嗒"的秒数（跨秒触发）
  // §U1 提醒边界：**按座位分别记**——用一个变量的话，换手时数值会从
  // "我方剩余"跳到"对方剩余"，表现为凭空跨过若干个整分钟，一口气连响好几声。
  let lastMinuteMark = { b: -1, w: -1 };   // 本时：上次已提醒的"剩余整分钟数"
  let lastByoyomiMark = { b: -1, w: -1 };  // 读秒：上次已报时的"剩余整十秒数"
  let timer = null;
  // §U2：每次刷新显示后的回调 (state) => void —— play.js 用它同步"危险外框"等派生 UI。
  // 挂在这里而不是让 play.js 自己开定时器：棋钟本来就每 500ms 在跑，没必要再来一个。
  let onTick = null;

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function $(id) { return window.UI.$(id); }

  function fmtClock(ms, isByoyomi) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    if (isByoyomi) return `读秒 ${sec}`; // 读秒：加「读秒」前缀，避免裸秒数被误读
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function displayFor(seat) {
    // 本时用尽且进入读秒 → 显示读秒剩余；否则显示本时
    if (inByoyomi[seat] && byoyomiDuration > 0) return fmtClock(localByoyomi[seat], true);
    return fmtClock(localClocks[seat], false);
  }

  function update() {
    const state = getState();
    const vp = getViewpoint() === 'w' ? 'w' : 'b';
    const oppSeat = vp === 'b' ? 'w' : 'b'; // 上方=对面
    const mySeatH = vp;                     // 下方=自己
    $('topClock').textContent = displayFor(oppSeat);
    $('bottomClock').textContent = displayFor(mySeatH);
    const lowOpp = inByoyomi[oppSeat] ? localByoyomi[oppSeat] <= 10000 : localClocks[oppSeat] <= 10000;
    const lowMe = inByoyomi[mySeatH] ? localByoyomi[mySeatH] <= 10000 : localClocks[mySeatH] <= 10000;
    $('topClock').classList.toggle('low', lowOpp && state && state.turn === oppSeat);
    $('bottomClock').classList.toggle('low', lowMe && state && state.turn === mySeatH);
    // §U2：把"该不该红框"交给 play.js —— 它才知道我是选手还是观战者。
    // 回调里做的是幂等的 class toggle，500ms 一次的开销可以忽略。
    if (onTick) { try { onTick(state); } catch (_) { /* 派生 UI 出错不该拖垮棋钟 */ } }
  }

  /**
   * 按当前手番推进 `dtMs` 毫秒（**纯扣减**，tick 与单测共用）。
   *
   * 把这段逻辑从 tick 里拎出来，是为了让它**不依赖定时器也能被验证**——
   * 时间算错是用户立刻能感知的错误，不能只靠"跑起来看着对"。
   * 非 PLAYING（未开局 / 已终局）不扣时，由本函数自行判断，调用方无需关心。
   *
   * §U1 在此加入**两级时间提醒**（三种音两两可区分）：
   *   - 本时每跨过一个整分钟 → `playMinuteWarning()`（低、长）
   *   - 读秒每跨过 10 秒（60/50/40/30/20）→ `playByoyomiMark()`（中频双音）
   *   - 读秒 ≤10 秒 → `playByoyomi()`（高频短「嗒」，原有）
   */
  function advance(dtMs) {
    const state = getState();
    if (!state || state.status !== 'PLAYING') return;
    const turn = state.turn;
    if (inByoyomi[turn] && byoyomiDuration > 0) {
      maybeEndgamePhase(); // 进读秒 ⇒ 终盘曲（幂等）
      localByoyomi[turn] = Math.max(0, localByoyomi[turn] - dtMs);

      // §U1：读秒每跨过 10 秒报时一次。
      // **刻意不含 10 秒**——那一拍交给下面的逐秒「嗒」，否则两个音会叠在一起。
      const mark = Math.ceil(localByoyomi[turn] / 10000);
      if (lastByoyomiMark[turn] === -1) {
        lastByoyomiMark[turn] = mark; // 首次只记录、不补响（进对局/换手瞬间不该出声）
      } else if (mark !== lastByoyomiMark[turn]) {
        if (mark >= 2 && mark <= 6 && window.Sound) window.Sound.playByoyomiMark();
        lastByoyomiMark[turn] = mark;
      }

      // 读秒 ≤10 秒：每秒「嗒」（跨秒边界触发，含 10 与 1）
      const sec = Math.ceil(localByoyomi[turn] / 1000);
      if (sec >= 1 && sec <= 10 && sec !== lastTickSecond) {
        if (window.Sound) window.Sound.playByoyomi();
        lastTickSecond = sec;
      }
      if (sec > 10) lastTickSecond = -1;
    } else {
      localClocks[turn] = Math.max(0, localClocks[turn] - dtMs);

      // §U1：本时每跨过一个整分钟提醒一次（mm = 剩余整分钟数）
      // ⚠️ 条件用 `mm >= 0` 而不是 `>= 1`：`Math.ceil` 使 mm=1 覆盖 (0, 60000]，
      // 从 1:00 走到 0:00 时 mm 由 1 变 0 —— 这一跨也是"跨过一个整分钟"，
      // 用 >=1 会把最后一分钟那条提醒吞掉。mm=0 之后不再变化，不会重复响。
      const mm = Math.ceil(localClocks[turn] / 60000);
      if (lastMinuteMark[turn] === -1) {
        lastMinuteMark[turn] = mm; // 首次只记录、不补响
      } else if (mm !== lastMinuteMark[turn]) {
        if (mm >= 0 && window.Sound) window.Sound.playMinuteWarning();
        lastMinuteMark[turn] = mm;
      }
    }
  }

  /**
   * 重置全部提醒边界为"下一条服务端消息到达时的值"。
   *
   * **收到任何时间校准后都必须调用**：本地与服务端时钟存在偏差，
   * 不重置就会表现为"凭空跨过几个整分钟"，一口气连响好几声。
   */
  function resetMarks() {
    lastMinuteMark = { b: -1, w: -1 };
    lastByoyomiMark = { b: -1, w: -1 };
    lastTickSecond = -1;
  }

  /**
   * 当前手番方是否处于「读秒 ≤10 秒」的危险状态（PLAN §U2，供棋盘红框使用）。
   *
   * ⚠️ 这里只回答**时间事实**，不判断"是不是自己"——那是调用方的责任：
   * 需求明确要求**观战者不显示红框**，而观战者（`mySeat === null`）只能由
   * `play.js` 排除。把这条判断挪进来，观战者也会跟着变红。
   */
  function isDanger() {
    const state = getState();
    if (!state || state.status !== 'PLAYING') return false;
    const turn = state.turn;
    return !!(inByoyomi[turn] && byoyomiDuration > 0 && localByoyomi[turn] <= 10000);
  }

  /** 本地棋钟 tick（每 500ms） */
  function tick() {
    const state = getState();
    // ⚠️ 非 PLAYING 时**不更新 lastTickTs**——保持抽出前的语义
    // （暂停期间不计入倒计时基准；恢复时服务端 state 消息会 resetTick 重新校准）
    if (!state || state.status !== 'PLAYING') { update(); return; }
    const now = Date.now();
    const dt = now - lastTickTs;
    lastTickTs = now;
    advance(dt);
    update();
  }

  /** state 消息里的棋钟字段（原 play.js `render()` 中的棋钟初始化） */
  function syncFromState(state) {
    if (state.clock) {
      localClocks.b = state.clock.b;
      localClocks.w = state.clock.w;
    }
    // ⚠️ 2026-10-04 修复：原来只在 `state.inByoyomi` 为真值时才更新读秒状态，
    // 而**包干局**（byoyomi=0）服务端下发的是 `null` → 上一局残留的 `inByoyomi=true`
    // 会一直留着，显示卡在「读秒 N」。改为按 `byoyomi` 判断：>0 才启用读秒，=0 显式清空。
    const by = state.byoyomi || 0;
    byoyomiDuration = by;
    if (by > 0) {
      inByoyomi = state.inByoyomi ? { ...state.inByoyomi } : { b: false, w: false };
      localByoyomi = state.curByoyomi ? { ...state.curByoyomi } : { b: 0, w: 0 };
    } else {
      inByoyomi = { b: false, w: false };
      localByoyomi = { b: 0, w: 0 };
    }
    lastAnchorTurn = state.turn || lastAnchorTurn;
    resetMarks(); // §U1：以服务端时间为新基准，避免时间跳变连响
    maybeEndgamePhase();
    update();
  }

  /**
   * ⚠️ 2026-10-07 BGM 三轨：任一方进入读秒 ⇒ 切「终盘」曲（制勝 等）。
   * 只从 game → endgame 单向切换（终盘不会退回开局曲），避免读秒边界反复横跳。
   */
  function maybeEndgamePhase() {
    if (!window.Sound || typeof window.Sound.setPhase !== 'function') return;
    const anyByo = !!(inByoyomi && (inByoyomi.b || inByoyomi.w));
    if (!anyByo) return;
    if (window.Sound.getPhase && window.Sound.getPhase() === 'endgame') return;
    window.Sound.setPhase('endgame');
  }

  // ⚠️ 2026-10-04 修复（棋钟与服务端不同步）：把"当前手番"记为锚点手番，
  // 用于判断 clock 消息（每秒广播）是否发生了**手番切换**——见下方 syncFromServer。
  let lastAnchorTurn = null;

  /**
   * clock 消息：服务端**每秒广播**（`src/rooms/clock.js` 的 `_tick`），是权威时间的锚点。
   *
   * ⚠️ 2026-10-04 修复（两处，同一根因导致的）：
   *  1. **载荷形状读错**：服务端发的是 `{ clock:{b,w}, byoyomi, curByoyomi, inByoyomi, turn }`，
   *     而这里原来读 **`data.b` / `data.w`**（扁平字段）——永远不是数字，于是每秒一次的
   *     校准被**静默丢弃**：本时只在收到 `state` 时才被纠正，中途本地计数的任何偏差都会
   *     一直累积，最终表现为「本地还显示有时间、服务端已判定时间切れ」。
   *     现在按真实形状读取（`data.clock`），并保留扁平写法兜底。
   *  2. **提醒边界被每秒清零**：原来每次消息都 `resetMarks()`，而标记的语义是
   *     「首次只记录、不补响」，于是分钟提醒与读秒「嗒」声**永远走不到"变化"分支 → 不响**。
   *     改为**仅在手番切换时**重置（同一手番内的每秒校准不动提醒状态）。
   */
  function syncFromServer(data) {
    if (!data) return;
    // 本时：优先服务端真实形状 `data.clock`；兼容历史/测试用的扁平 `data.b/w`
    const c = data.clock || (typeof data.b === 'number' ? { b: data.b, w: data.w } : null);
    if (c && typeof c.b === 'number' && typeof c.w === 'number') {
      localClocks.b = c.b;
      localClocks.w = c.w;
    }
    if (data.byoyomi != null) byoyomiDuration = data.byoyomi;
    // ⚠️ 2026-10-04 修复（同 syncFromState）：包干局服务端不下发 inByoyomi/curByoyomi
    // （为 null），此时必须**显式清空**，否则会沿用上一局残留的读秒状态、显示卡在「读秒 N」。
    if (data.curByoyomi) {
      localByoyomi = { ...data.curByoyomi };
    } else if (byoyomiDuration === 0) {
      localByoyomi = { b: 0, w: 0 };
    }
    if (data.inByoyomi) {
      inByoyomi = { ...data.inByoyomi };
    } else if (byoyomiDuration === 0) {
      inByoyomi = { b: false, w: false };
    }
    lastTickTs = Date.now();
    // 只在手番变化时重置提醒边界（每秒都重置会吞掉提醒音）
    if (data.turn && data.turn !== lastAnchorTurn) {
      lastAnchorTurn = data.turn;
      resetMarks();
    }
    maybeEndgamePhase();
    update();
  }

  /**
   * 以「此刻」为倒计时基准。
   * 收到任何服务端消息时调用，否则会把「等待对方思考」的时长也算进自己的倒计时。
   */
  function resetTick() { lastTickTs = Date.now(); }

  function start() { if (!timer) timer = setInterval(tick, 500); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function init(opts) {
    const o = opts || {};
    if (typeof o.getState === 'function') getState = o.getState;
    if (typeof o.getViewpoint === 'function') getViewpoint = o.getViewpoint;
    if (typeof o.onTick === 'function') onTick = o.onTick; // §U2：同步危险外框等派生 UI
    start();
  }

  /**
   * SPA 生命周期（2026-10-09）：`play.unmount` 调用——停掉 500ms tick 定时器，
   * 并把模块状态复位到「刚加载」的样子（含注入回调），保证下一次 `init` 不残留上一局的
   * 读秒/提醒边界/闭包引用（否则切走再进会看到旧棋钟数字、或 tick 摸到已销毁的 DOM）。
   */
  function destroy() {
    stop();
    getState = function () { return null; };
    getViewpoint = function () { return 'b'; };
    onTick = null;
    localClocks = { b: 15 * 60 * 1000, w: 15 * 60 * 1000 };
    localByoyomi = { b: 0, w: 0 };
    inByoyomi = { b: false, w: false };
    byoyomiDuration = 0;
    lastTickTs = Date.now();
    lastAnchorTurn = null;
    resetMarks();
  }

  window.PlayClock = {
    init, destroy, syncFromState, syncFromServer, resetTick, update, start, stop,
    advance,    // 单测用：不经定时器直接推进 dtMs
    isDanger,   // §U2 棋盘红框用：当前手番方是否读秒 ≤10 秒（调用方需自行排除观战者）
    resetMarks, // 单测用：重置提醒边界
  };
})();
