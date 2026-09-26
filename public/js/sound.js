/**
 * sound.js — 音效与 BGM（Web Audio 合成 + 真实音频文件，PLAN §U4）
 *
 * 提供：
 *  - playMove()      行棋落子：短促木质敲击（噪声冲击 + 中频衰减）
 *  - playCapture()   吃子：更重的敲击（低频更足）
 *  - playByoyomi()   读秒滴答：高频短「嗒」
 *  - playStart()     对局开始：上扬双音
 *  - playEnd()       对局结束：下行双音
 *  - bgmStart/Stop/Sync 对局 BGM（真实音频循环播放）
 *
 * 两种音源并存：
 *  - `default` 方案由 AudioContext 实时合成，零素材、永远可用；
 *  - `file:<名字>` 方案播放真实音频（落子音 `sound/<名字>.mp3`、BGM `music/<名字>.mp3`），
 *    文件缺失/自动播放被拦时**静默降级**——落子音退回合成音、BGM 不响，绝不影响对局。
 *
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
    if (playMoveFile(1)) return; // §U4 真实音频方案；未选/失败回退下面的合成音
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
    // 真实音频方案：降一点速高（0.82）= 更沉，对应合成音方案里"吃子更厚"的设计
    if (playMoveFile(0.82)) return;
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
   * 取值：`default`（程序化合成）/ `file:<名字>`（真实音频文件）/ `off`（仅 bgm）。
   * Settings 未加载时一律回退 default（不抛错）。
   */
  function variant(key) {
    if (!global.Settings) return 'default';
    try { return global.Settings.get(key) || 'default'; } catch (_) { return 'default'; }
  }

  /**
   * 播放一次真实音频文件（PLAN §U4 实装，2026-09-26）。
   *
   * ⚠️ 只做**静默降级**：文件缺失、格式不支持、自动播放被拦——一律吞掉，
   * 返回 false 让调用方回退合成音。音频问题绝不能影响对局。
   */
  function playFileSound(path, opts) {
    try {
      const a = new global.Audio(encodeURI(path));
      a.volume = opts && opts.volume != null ? opts.volume : 1;
      if (opts && opts.rate) a.playbackRate = opts.rate;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
      return true;
    } catch (_) { return false; }
  }

  /**
   * 落子/吃子的真实音频方案：`file:<名字>` → `sound/<名字>.mp3`。
   * @param {number} rate 播放速率（吃子 <1 = 更沉）
   * @returns {boolean} 是否已用真实音频顶上（false 时调用方回退合成音）
   */
  function playMoveFile(rate) {
    const v = variant('soundMove');
    if (typeof v !== 'string' || v.indexOf('file:') !== 0) return false;
    return playFileSound('sound/' + v.slice(5) + '.mp3', { volume: 0.9, rate: rate || 1 });
  }

  // ==================================================================
  // 对局 BGM（PLAN §U4）：`file:<名字>` → `music/<名字>.mp3`，循环播放
  // ==================================================================
  let bgmEl = null;      // 当前 <audio>
  let bgmUrl = null;     // 当前曲目 URL（切换/判等用）
  let bgmWanted = false; // 对局进行中（play.js 在 game_start/game_over 维护）

  /**
   * 按「对局进行中 + 音效总开关 + BGM 设置」同步播放状态（幂等）。
   * Settings 变更、总开关切换、终局都会调到这里。
   */
  function bgmSync() {
    const v = variant('bgm');
    const want = bgmWanted && enabled && typeof v === 'string' && v.indexOf('file:') === 0;
    const url = want ? 'music/' + v.slice(5) + '.mp3' : null;
    if (bgmEl && url === bgmUrl) {
      // 曲目没变：只处理暂停/恢复（如开关音效后回来）
      if (want && bgmEl.paused) {
        try { const p = bgmEl.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      }
      return;
    }
    if (bgmEl) { try { bgmEl.pause(); } catch (_) {} bgmEl = null; bgmUrl = null; }
    if (!url) return;
    try {
      const a = new global.Audio(encodeURI(url));
      a.loop = true;
      a.volume = 0.35; // 与合成音 MASTER 平级，不盖过落子/读秒提示音
      const p = a.play();
      if (p && p.catch) p.catch(() => {}); // 自动播放被拦/文件缺失：静默
      bgmEl = a;
      bgmUrl = url;
    } catch (_) {}
  }

  /** 对局开始（或进入进行中的对局）：开始/继续 BGM */
  function bgmStart() { bgmWanted = true; bgmSync(); }

  /** 对局结束/离开：停止 BGM */
  function bgmStop() { bgmWanted = false; bgmSync(); }

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
    bgmSync(); // 总开关关掉时 BGM 也要停（打开时若对局进行中则恢复）
  }

  function isEnabled() { return enabled; }

  global.Sound = {
    playMove, playCapture, playByoyomi, playStart, playEnd,
    playMinuteWarning, playByoyomiMark, // PLAN §U1：整分钟提醒 / 读秒每 10 秒报时
    variant,                            // PLAN §U4：音色方案读取
    bgmStart, bgmStop, bgmSync,         // PLAN §U4：对局 BGM
    setEnabled, applyEnabled, isEnabled, ensureCtx,
  };
})(window);
