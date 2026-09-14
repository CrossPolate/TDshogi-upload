/**
 * sound.js — 程序化音效（Web Audio API，零外部素材）
 *
 * 提供：
 *  - playMove()      行棋落子：短促木质敲击（噪声冲击 + 中频衰减）
 *  - playCapture()   吃子：更重的敲击（低频更足）
 *  - playByoyomi()   读秒滴答：高频短「嗒」
 *  - playStart()     对局开始：上扬双音
 *  - playEnd()       对局结束：下行双音
 *
 * 所有音效由 AudioContext 实时合成，不依赖任何音频文件。
 * 首次用户交互后 AudioContext 才允许出声（浏览器自动播放策略），
 * 因此 play.js 在用户点击棋盘时初始化音频上下文。
 */
(function (global) {
  'use strict';

  const SOUND_KEY = 'tdshogi_sound';
  let ctx = null;
  let enabled = true;

  // 音效开关的唯一数据源是 Settings（PLAN §S1）；Settings 未加载时回退旧键
  if (global.Settings) {
    enabled = global.Settings.get('sound');
  } else {
    try { enabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (_) {}
  }

  /** 懒初始化 AudioContext（需在用户手势后调用才可出声） */
  function ensureCtx() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    return ctx;
  }

  /** 主音量（0-1），避免突兀 */
  const MASTER = 0.35;

  function env(gainNode, t0, peak, decay) {
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  }

  /** 落子：短促噪声冲击 + 中频衰减（木质敲击感） */
  function playMove() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER;
    master.connect(ac.destination);

    // 噪声冲击（木击的"啪"）
    const dur = 0.06;
    const buffer = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const nFilter = ac.createBiquadFilter();
    nFilter.type = 'bandpass';
    nFilter.frequency.value = 1800;
    nFilter.Q.value = 0.8;
    const nGain = ac.createGain();
    env(nGain, t0, 1, 0.07);
    noise.connect(nFilter).connect(nGain).connect(master);
    noise.start(t0);

    // 中频体感（木头的"咚"）
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t0);
    osc.frequency.exponentialRampToValueAtTime(160, t0 + 0.09);
    const oGain = ac.createGain();
    env(oGain, t0, 0.9, 0.1);
    osc.connect(oGain).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.12);
  }

  /** 吃子：落子 + 更重的低频（厚度感） */
  function playCapture() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER;
    master.connect(ac.destination);

    const dur = 0.08;
    const buffer = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.5);
    }
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const nFilter = ac.createBiquadFilter();
    nFilter.type = 'lowpass';
    nFilter.frequency.value = 900;
    const nGain = ac.createGain();
    env(nGain, t0, 1.1, 0.1);
    noise.connect(nFilter).connect(nGain).connect(master);
    noise.start(t0);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.12);
    const oGain = ac.createGain();
    env(oGain, t0, 1.0, 0.13);
    osc.connect(oGain).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  }

  /** 读秒滴答：高频短「嗒」 */
  function playByoyomi() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.7;
    master.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 2200;
    const g = ac.createGain();
    env(g, t0, 0.6, 0.04);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.05);
  }

  /**
   * 整分钟提醒（PLAN §U1）：本时剩余每跨过一个整分钟响一次。
   *
   * 音色刻意与读秒「嗒」拉开距离——**低、长、圆润**（正弦，660→440Hz，0.35s）。
   * 这条音是「提示」而不是「催促」：玩家还有好几分钟，不该被高频短音打扰。
   */
  function playMinuteWarning() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.8;
    master.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(440, t0 + 0.18);
    const g = ac.createGain();
    env(g, t0, 0.9, 0.35); // 明显长于读秒音
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  }

  /**
   * 读秒报时（PLAN §U1）：读秒阶段每跨过 10 秒响一次（60/50/40/30/20）。
   *
   * 音色介于两者之间——**三角波双音「叮-咚」**（1100→880Hz，间隔 0.1s）：
   * 比整分钟提醒急促（时间更紧了），但比逐秒「嗒」舒缓（还不是最后关头）。
   */
  function playByoyomiMark() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.7;
    master.connect(ac.destination);

    [1100, 880].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      const t = t0 + i * 0.1;
      env(g, t, 0.55, 0.12);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.14);
    });
  }

  /**
   * 读取音色方案（PLAN §U4）。
   *
   * v1 只有 `default`（上面的程序化合成）；预留 `file:<name>` 形式，
   * 将来实装真实音频时从 `public/audio/` 加载，**调用方无需改动**。
   * Settings 未加载时一律回退 default（不抛错）。
   */
  function variant(key) {
    if (!global.Settings) return 'default';
    try { return global.Settings.get(key) || 'default'; } catch (_) { return 'default'; }
  }

  /** 对局开始：上扬双音 */
  function playStart() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.8;
    master.connect(ac.destination);
    [523, 784].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      const t = t0 + i * 0.09;
      env(g, t, 0.7, 0.18);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  /** 对局结束：下行双音 */
  function playEnd() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = MASTER * 0.8;
    master.connect(ac.destination);
    [392, 262].forEach((f, i) => {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      const t = t0 + i * 0.12;
      env(g, t, 0.7, 0.22);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  }

  /**
   * 设置音效开关。持久化统一交给 Settings（§S1）——它变更后会回调 `applyEnabled()`
   * 同步这里的内部状态。Settings 未加载时退回旧键，保证单独打开 sound.js 也能用。
   */
  function setEnabled(on) {
    if (global.Settings) { global.Settings.set('sound', !!on); return; }
    enabled = !!on;
    try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch (_) {}
  }

  /**
   * 仅同步内部状态（由 Settings.apply 调用）。
   * ⚠️ 这里**不可**再调 setEnabled，否则会 set → apply → set 递归。
   */
  function applyEnabled(on) {
    enabled = !!on;
  }

  function isEnabled() { return enabled; }

  global.Sound = {
    playMove, playCapture, playByoyomi, playStart, playEnd,
    playMinuteWarning, playByoyomiMark, // PLAN §U1：整分钟提醒 / 读秒每 10 秒报时
    variant,                            // PLAN §U4：音色方案读取（v1 恒为 default）
    setEnabled, applyEnabled, isEnabled, ensureCtx,
  };
})(window);
