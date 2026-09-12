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
  let timer = null;

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
  }

  /**
   * 按当前手番推进 `dtMs` 毫秒（**纯扣减**，tick 与单测共用）。
   *
   * 把这段逻辑从 tick 里拎出来，是为了让它**不依赖定时器也能被验证**——
   * 时间算错是用户立刻能感知的错误，不能只靠"跑起来看着对"。
   * 非 PLAYING（未开局 / 已终局）不扣时，由本函数自行判断，调用方无需关心。
   */
  function advance(dtMs) {
    const state = getState();
    if (!state || state.status !== 'PLAYING') return;
    const turn = state.turn;
    if (inByoyomi[turn] && byoyomiDuration > 0) {
      localByoyomi[turn] = Math.max(0, localByoyomi[turn] - dtMs);
      // 读秒 ≤10 秒：每秒「嗒」（跨秒边界触发，含 10 与 1）
      const sec = Math.ceil(localByoyomi[turn] / 1000);
      if (sec >= 1 && sec <= 10 && sec !== lastTickSecond) {
        if (window.Sound) window.Sound.playByoyomi();
        lastTickSecond = sec;
      }
      if (sec > 10) lastTickSecond = -1;
    } else {
      localClocks[turn] = Math.max(0, localClocks[turn] - dtMs);
    }
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
    start();
  }

  window.PlayClock = {
    init, syncFromState, syncFromServer, resetTick, update, start, stop,
    advance, // 单测用：不经定时器直接推进 dtMs
  };
})();
