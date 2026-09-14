/**
 * play-clock.js — 对局棋钟（本时倒计时 + 读秒）
 *
 * 从 `play.js` 抽出（PLAN §M5 前端拆分第一步）。**逻辑一字未改**，只把两处对外部
 * 状态的读取改成了注入的回调——因为它们在 play.js 里原本是 IIFE 的闭包变量：
 *   - `getState()`     取最新对局状态（原闭包变量 `state`）
 *   - `getViewpoint()` 取当前显示视角（原 `mySeat === 'w' ? 'w' : 'b'`）
 *
 * 对外接口（由 play.js 调用）：
 *   PlayClock.init({ getState, getViewpoint })  注入依赖并启动 tick
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
    if (isByoyomi) return `${sec}`; // 读秒只显示秒数
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
    if (state.inByoyomi) {
      inByoyomi = { ...state.inByoyomi };
      localByoyomi = state.curByoyomi ? { ...state.curByoyomi } : { b: 0, w: 0 };
      byoyomiDuration = state.byoyomi || 0;
    }
    resetMarks(); // §U1：以服务端时间为新基准，避免时间跳变连响
    update();
  }

  /** clock 消息：走子后以服务端时间为准校准 */
  function syncFromServer(data) {
    if (!data) return;
    if (typeof data.b === 'number') {
      localClocks.b = data.b;
      localClocks.w = data.w;
    }
    if (data.curByoyomi) {
      localByoyomi = { ...data.curByoyomi };
    }
    if (data.inByoyomi) {
      inByoyomi = { ...data.inByoyomi };
    }
    if (data.byoyomi != null) byoyomiDuration = data.byoyomi;
    lastTickTs = Date.now();
    resetMarks(); // §U1：每手都可能重新读秒（60/30 秒起步），边界必须跟着重置
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

  window.PlayClock = {
    init, syncFromState, syncFromServer, resetTick, update, start, stop,
    advance,    // 单测用：不经定时器直接推进 dtMs
    isDanger,   // §U2 棋盘红框用：当前手番方是否读秒 ≤10 秒（调用方需自行排除观战者）
    resetMarks, // 单测用：重置提醒边界
  };
})();
