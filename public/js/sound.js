/**
 * sound.js — 音效与 BGM（Web Audio 合成 + 真实音频文件，PLAN §U4）
 *
 * 提供：
 *  - playMove()      行棋落子：短促木质敲击（噪声冲击 + 中频衰减）
 *  - playCapture()   吃子：更重的敲击（低频更足）
 *  - playByoyomi()   读秒滴答：高频短「嗒」
 *  - playStart()     对局开始：上扬双音
 *  - playEnd()       对局结束：下行双音
 *  - bgmStart/Stop/Sync 对局 BGM（`file:<名字>` 素材循环；素材缺失自动切合成 pad）
 *
 * 两种音源并存：
 *  - `default` 方案由 AudioContext 实时合成，零素材、永远可用；
 *  - `file:<名字>` 方案播放真实音频（落子音 `sound/<名字>.mp3`、BGM `music/<名字>.mp3`），
 *    文件缺失/自动播放被拦时**静默降级**——落子音退回合成音、BGM 退回合成 pad，
 *    两者都绝不抛错、绝不影响对局（`public/music/` 本身就是**可选素材**）。
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
    // §U4 真实音频方案；未选/同步失败 → 立刻合成音；异步失败（404/被拦）→ onFail 回退合成音
    if (playMoveFile(1, synthMove)) return;
    synthMove();
  }

  /** 落子合成音（真实音频不可用时的回退路径） */
  function synthMove() {
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
    if (playMoveFile(0.82, synthCapture)) return;
    synthCapture();
  }

  /** 吃子合成音（真实音频不可用时的回退路径） */
  function synthCapture() {
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

  /** 读秒滴答：高频短「嗒」（⚠️ 2026-10-08：读秒音从设置迁入装扮，可换文件方案） */
  let byoyomiVariant = 'default'; // 'default'（合成）/ 文件 URL

  /** 设置读秒音方案（装扮装备后调用） */
  function setByoyomiVariant(v) {
    byoyomiVariant = (v && String(v)) || 'default';
  }

  function playByoyomi() {
    if (!enabled) return;
    // 文件方案：sound/<名字>.mp3 或完整站内路径
    if (byoyomiVariant && byoyomiVariant !== 'default' && byoyomiVariant.indexOf('synth') !== 0) {
      const path = byoyomiVariant.charAt(0) === '/' ? byoyomiVariant : 'sound/' + byoyomiVariant + '.mp3';
      if (playFileSound(path, { volume: 0.9 }, synthByoyomi)) return;
    }
    synthByoyomi();
  }

  /** 读秒合成音（文件缺失时的回退） */
  function synthByoyomi() {
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
   * 尝试播放一次真实音频文件（PLAN §U4 实装，2026-09-26）。
   *
   * ⚠️ 契约（Bug5 修）：**必须真的具备降级能力**——文件缺失（404）、格式不支持、
   * 自动播放被拦时，要让调用方回退合成音，而不是"装作播了"。
   * 旧实现的 `const p = a.play(); return true;` 破坏了这个契约：`.catch(()=>{})` 把
   * reject 吞掉又无条件返回 true，调用方 `if (playMoveFile(...)) return;` 于是**永不回退**，
   * 结果完全没声音（静默失败，最难查）。
   *
   * 回退触发（两条都要覆盖，不同浏览器走的不一样）：
   *  - `play()` 返回的 Promise reject（自动播放被拦 / 解码失败）；
   *  - 音频元素 `error` 事件（404 等加载错误常走这条）。
   * 同步构造 / `play()` 同步抛错 → 返回 false，由调用方**立刻**回退。
   *
   * @param {string} path
   * @param {{volume?:number, rate?:number}} [opts]
   * @param {Function} [onFail] 异步失败时的回退回调（合成音）
   * @returns {boolean} true=已顶上真实音频（失败会经 onFail 回退）；false=立刻失败，调用方自行回退
   */
  function playFileSound(path, opts, onFail) {
    let a;
    try {
      a = new global.Audio(encodeURI(path));
    } catch (_) {
      return false; // 连元素都建不出：交给调用方回退
    }
    a.volume = opts && opts.volume != null ? opts.volume : 1;
    if (opts && opts.rate) a.playbackRate = opts.rate;
    let settled = false;
    const fallback = () => {
      if (settled) return;   // 只回退一次（error 与 promise reject 可能都来）
      settled = true;
      if (typeof onFail === 'function') { try { onFail(); } catch (_) {} }
    };
    a.onerror = fallback;    // 404/格式不支持：多数浏览器走 error 事件
    let p;
    try {
      p = a.play();
    } catch (_) {
      settled = true;        // 同步抛：返回 false 让调用方立刻回退；标记已决，避免再触发 onerror 重复
      return false;
    }
    if (p && typeof p.catch === 'function') p.catch(fallback);
    return true;
  }

  /**
   * 落子/吃子的真实音频方案：`file:<名字>` → `sound/<名字>.mp3`。
   * @param {number} rate 播放速率（吃子 <1 = 更沉）
   * @param {Function} [onFail] 真实音频失败时的回退（合成音）
   * @returns {boolean} 是否已用真实音频顶上（false 时调用方需立刻回退合成音）
   */
  function playMoveFile(rate, onFail) {
    const v = variant('soundMove');
    if (typeof v !== 'string' || v.indexOf('file:') !== 0) return false;
    return playFileSound('sound/' + v.slice(5) + '.mp3', { volume: 0.9, rate: rate || 1 }, onFail);
  }

  // ==================================================================
  // BGM 三轨（2026-10-07）：菜单 / 开局 / 终盘
  //  - menu：没有对局时（大厅/个人页等）循环
  //  - game：对局进行中循环（玩家装备的 BGM 会覆盖这一轨）
  //  - endgame：进入读秒时切换循环
  // 全局音乐开关独立于行棋音效（右上角 🔊/🔇 控制，持久化在 Settings.music）。
  // 素材缺失仍自动降级合成 pad，绝不抛错。
  // ==================================================================
  const BGM_GAIN = 0.35;   // 与合成音 MASTER 平级，不盖过落子/读秒提示音

  let bgmEl = null;        // 当前 <audio>（素材路径）
  let bgmUrl = null;       // 当前素材 URL（切换/判等用）
  let bgmMode = null;      // 当前实际出声的路径：'file' | 'synth' | null
  let bgmSynthName = null; // 合成兜底所对应的曲名
  let bgmPhase = 'menu';   // 'menu' | 'game' | 'endgame'
  // ⚠️ 2026-10-08：初始即带默认三轨（loop / 静弈 / 制勝），首页在接口返回前也能起菜单曲。
  // 登录后 initFromServer 会用「已装备」覆盖。
  let bgmTracks = {
    menu: '/music/loop.mp3',
    game: '/music/静弈.mp3',
    endgame: '/music/制勝.mp3',
  };
  let bgmMusicOn = true;   // 全局音乐开关（独立于行棋音效 enabled；初始从 Settings 读）
  if (global.Settings) {
    try { bgmMusicOn = global.Settings.get('music') !== false; } catch (_) { /* 默认开 */ }
  }
  let bgmFailed = null;    // 最近一次确认缺失的素材 URL（避免每次同步都重试 404）
  let bgmGen = 0;          // 重建代数：迟到的失败回调不得误伤新曲

  // ⚠️ 2026-10-08：对局中「自己 + 对手」开局曲交替循环
  let bgmOpponentUrl = null;   // 对手开局曲 URL（state.players.opp.bgm）
  let bgmPlayOpponent = true;  // 设置项 playOpponentBgm
  let bgmAltIndex = 0;         // 0=自己的曲，1=对手的曲（game 轨交替）
  let bgmVolume = 0.5;         // 音量 0–1（Settings.musicVolume / 100）
  if (global.Settings) {
    try {
      const v = Number(global.Settings.get('musicVolume'));
      if (Number.isFinite(v)) bgmVolume = Math.min(1, Math.max(0, v / 100));
      bgmPlayOpponent = global.Settings.get('playOpponentBgm') !== false;
    } catch (_) { /* 默认 50% / 开 */ }
  }

  /** BGM 音量：0.7 × 用户百分比（50% → 0.35，与历史默认一致；100% → 0.7） */
  function bgmGain() {
    return 0.7 * bgmVolume;
  }

  /** 读全局音乐开关（内存态；由 setMusicOn / applyMusicOn 同步，初始从 Settings 读） */
  function musicOn() {
    return bgmMusicOn;
  }

  /**
   * 按曲名取一组和弦音（稳定哈希 → 同一曲名永远同一色彩）。
   * 让「循环 / 制勝 / 空弦 …」在无素材时听感各不相同，而不是同一段糊在一起。
   */
  const PAD_PALETTES = [
    [196.00, 293.66, 392.00], // G3 D4 G4
    [174.61, 261.63, 349.23], // F3 C4 F4
    [220.00, 329.63, 440.00], // A3 E4 A4
    [164.81, 246.94, 329.63], // E3 B3 E4
    [146.83, 220.00, 293.66], // D3 A3 D4
  ];
  function padPalette(name) {
    const s = String(name || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PAD_PALETTES[h % PAD_PALETTES.length];
  }

  let pad = null; // { ac, out, oscs, lfo }

  /** 停掉合成 pad（若仍有残留） */
  function synthPadStop() {
    if (!pad) return;
    const { ac, out, oscs, lfo } = pad;
    pad = null;
    try {
      const t = ac.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0.0001, t, 0.2);
      const end = t + 1.0;
      oscs.forEach((o) => { try { o.stop(end); } catch (_) {} });
      try { lfo.stop(end); } catch (_) {}
    } catch (_) {}
  }

  /**
   * 起合成 ambient pad（BGM 兜底）。
   * 无 AudioContext（单测环境 / 老浏览器）→ 静默返回，**绝不抛错**。
   */
  function synthPadStart(name) {
    synthPadStop();
    const ac = ensureCtx();
    if (!ac) return;
    try {
      const t = ac.currentTime;
      const out = ac.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.setTargetAtTime(bgmGain() * 0.6, t, 1.5);

      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      filter.Q.value = 0.6;
      filter.connect(out);
      out.connect(ac.destination);

      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.06;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 240;
      lfo.connect(lfoGain).connect(filter.frequency);
      lfo.start(t);

      const oscs = padPalette(name).map((f, i) => {
        const o = ac.createOscillator();
        o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = (i - 1) * 5;
        const g = ac.createGain();
        g.gain.value = i === 0 ? 0.5 : 0.26;
        o.connect(g).connect(filter);
        o.start(t);
        return o;
      });
      pad = { ac, out, oscs, lfo };
    } catch (_) { pad = null; }
  }

  /** 停掉一切 BGM（素材与合成），并清空状态 */
  function bgmStopAudio() {
    if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
    bgmEl = null;
    bgmUrl = null;
    bgmMode = null;
    bgmSynthName = null;
    synthPadStop();
  }

  function bgmStartSynth() {
    // ⚠️ 2026-10-08 用户要求「去掉默认的合成电子音」：素材缺失/被拦时**静默**，
    // 不再起 ambient pad 兜底（那玩意儿听起来就是电子嗡鸣）。
    bgmMode = null;
    bgmSynthName = null;
  }

  function bgmStartFile(url, name) {
    const gen = ++bgmGen;
    let settled = false;
    /** permanent=true 表示素材确实坏了（404），记下来别反复重试 */
    const fail = (permanent) => {
      if (gen !== bgmGen || settled) return;
      settled = true;
      if (permanent) bgmFailed = url;
      if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
      bgmEl = null;
      bgmUrl = null;
      bgmMode = null;
      bgmStartSynth(); // 静默（不合成）
    };
    try {
      const a = new global.Audio(encodeURI(url));
      // ⚠️ 2026-10-08：game 轨可与对手曲交替 → 不 loop，用 onended 切下一轮
      const alt = bgmPhase === 'game' && bgmOpponentUrl && bgmPlayOpponent
        && bgmOpponentUrl !== bgmTracks.game;
      a.loop = !alt;
      a.volume = bgmGain();
      a.onerror = () => fail(true);
      // ⚠️ 2026-10-08（SPA 迁移）：文档不再随切页销毁，`<audio>` 常驻于外壳，
      // 同一首曲自然从当前时间点继续 —— 无需再把 currentTime 写 sessionStorage、
      // 换页重建后再 seek 回去（那套「停止→重开→快进」必有静音间隙 + metadata 竞态）。
      // 这里保留「同曲不重建」的幂等（见 bgmSync），它才是真正有效的防重建。
      if (alt) {
        a.onended = () => {
          if (gen !== bgmGen) return;
          bgmAltIndex = bgmAltIndex === 0 ? 1 : 0;
          bgmSync(true);
        };
      }
      let p;
      try { p = a.play(); } catch (_) { fail(true); return; }
      if (gen !== bgmGen || settled) return;
      // play() 被拒（多半是自动播放策略）：**不**记 bgmFailed —— 手势解锁后要能重试
      if (p && p.catch) p.catch(() => fail(false));
      bgmEl = a;
      bgmUrl = url;
      bgmMode = 'file';
    } catch (_) { fail(true); }
  }

  /** 当前轨应播的 URL（game 轨在「自己/对手」间交替） */
  function currentTrackUrl() {
    if (bgmPhase === 'game' && bgmOpponentUrl && bgmPlayOpponent
      && bgmOpponentUrl !== bgmTracks.game) {
      return bgmAltIndex === 1 ? bgmOpponentUrl : (bgmTracks.game || bgmOpponentUrl);
    }
    return bgmTracks[bgmPhase] || null;
  }

  /**
   * 同步当前轨播放（幂等）。全局音乐关 / 当前轨无曲 → 停。
   * @param {boolean} [force] 强制重建（换轨/换曲时 true）
   */
  function bgmSync(force) {
    const wantOn = musicOn();
    const url = wantOn ? currentTrackUrl() : null;
    const name = url ? url.split('/').pop().replace(/\.[^.]+$/, '') : bgmPhase;

    // ⚠️ 同一首曲已在播/暂停 → 只恢复，不重建（重建会丢失播放进度）
    if (url && bgmMode === 'file' && bgmUrl === url && bgmEl) {
      if (bgmEl.paused) {
        try { const p = bgmEl.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      }
      return;
    }

    bgmStopAudio();
    if (!url) return;
    // ⚠️ 2026-10-08：素材确认缺失 → 静默（不再合成电子音兜底）
    if (bgmFailed === url) return;
    bgmStartFile(url, name);
  }

  /**
   * 设置三轨曲目 URL（null = 该轨静音）。
   * @param {{menu?:string|null, game?:string|null, endgame?:string|null}} tracks
   */
  function setTracks(tracks) {
    if (!tracks || typeof tracks !== 'object') return;
    for (const k of ['menu', 'game', 'endgame']) {
      if (tracks[k] !== undefined) bgmTracks[k] = tracks[k] || null;
    }
    bgmSync(true);
  }

  /**
   * 切换播放阶段（换曲）。
   * @param {'menu'|'game'|'endgame'} phase
   */
  function setPhase(phase) {
    const p = phase === 'game' || phase === 'endgame' ? phase : 'menu';
    if (p === bgmPhase) { bgmSync(false); return; }
    bgmPhase = p;
    bgmAltIndex = 0; // 换阶段从自己的曲起播
    bgmSync(true);
  }

  /**
   * ⚠️ 2026-10-08：设置对手开局曲（对局中交替播放）。
   * @param {string|null} url
   */
  function setOpponentTrack(url) {
    const next = url || null;
    if (next === bgmOpponentUrl) return;
    bgmOpponentUrl = next;
    bgmAltIndex = 0;
    bgmSync(true);
  }

  /** 音量（0–100 百分比；由 Settings.musicVolume 同步） */
  function applyMusicVolume(pct) {
    const v = Number(pct);
    bgmVolume = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5;
    if (bgmEl) { try { bgmEl.volume = bgmGain(); } catch (_) {} }
  }

  function applyPlayOpponentBgm(on) {
    bgmPlayOpponent = !!on;
    bgmAltIndex = 0;
    bgmSync(true);
  }

  function getPhase() { return bgmPhase; }
  function getTracks() { return { ...bgmTracks }; }

  /** 全局音乐开关（写 Settings.music 并同步内部状态） */
  function setMusicOn(on) {
    const v = !!on;
    bgmMusicOn = v;
    if (global.Settings) {
      try { global.Settings.set('music', v); } catch (_) { /* 仅内存 */ }
    }
    bgmSync(true);
  }

  /** 仅同步内部状态（Settings.apply 调用）；不可回调 setMusicOn */
  function applyMusicOn(on) {
    bgmMusicOn = !!on;
    bgmSync(true);
  }

  function isMusicOn() { return musicOn(); }

  /** 调试/测试：当前 BGM 状态 */
  function bgmState() {
    return {
      phase: bgmPhase,
      tracks: { ...bgmTracks },
      opponent: bgmOpponentUrl,
      altIndex: bgmAltIndex,
      volume: bgmVolume,
      mode: bgmMode,
      url: bgmUrl,
      synth: bgmSynthName,
      musicOn: musicOn(),
    };
  }

  // 兼容旧 API：bgmStart = 进入对局；bgmStop = 回菜单
  function bgmStart() { setPhase('game'); }
  function bgmStop() { setPhase('menu'); }

  /**
   * 试听专用：临时暂停 BGM（不清状态，resume 时从暂停点继续）。
   * 2026-10-08 用户要求「试听时应该停止正在播放的 bgm」。
   */
  function bgmPauseForPreview() {
    if (bgmEl) { try { bgmEl.pause(); } catch (_) {} }
  }
  /** 试听结束：恢复 BGM（若全局音乐开） */
  function bgmResumeFromPreview() {
    if (!musicOn()) return;
    if (bgmEl && bgmMode === 'file' && bgmEl.paused) {
      try { const p = bgmEl.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
  }

  // ⚠️ 2026-10-08（SPA 迁移）：跨页续播不再走 sessionStorage。
  // 单文档常驻后 `bgmEl` 自始至终是同一个 <audio>，切页自然连续；
  // 原 saveBgmPosition / restoreBgmPosition 已删除（那是「整页跳转销毁文档」的补丁）。

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
   * 注意：行棋音效开关**不再**联动 BGM（2026-10-07 音乐独立开关）。
   */
  function applyEnabled(on) {
    enabled = !!on;
  }

  function isEnabled() { return enabled; }

  // ==================================================================
  // 初始化（2026-10-07）：从服务端拉三轨配置 + 本机已装备的对局曲
  // ==================================================================
  const BGM_GAME_KEY = 'tdshogi_bgm_game_url';

  /**
   * 装备 BGM 后由装扮页调用：覆盖「开局」轨并记住（刷新后仍生效）。
   * @param {string|null} url 站内音频 URL；null = 恢复系统默认开局曲
   */
  function setGameTrackOverride(url) {
    try {
      if (url) localStorage.setItem(BGM_GAME_KEY, url);
      else localStorage.removeItem(BGM_GAME_KEY);
    } catch (_) { /* 隐私模式：忽略 */ }
    if (url) setTracks({ game: url });
    else {
      bgmTracks.game = null;
      initFromServer();
    }
  }

  function gameTrackOverride() {
    try { return localStorage.getItem(BGM_GAME_KEY) || null; } catch (_) { return null; }
  }

  /**
   * 页面加载后拉取 BGM 三轨并起菜单曲。
   * ⚠️ 2026-10-08：带上会话令牌 —— 登录玩家返回**装备的**三首（默认自带），
   * 游客走系统默认轨。
   */
  function initFromServer() {
    let token = null;
    try {
      const g = JSON.parse(localStorage.getItem('tdshogi_guest') || 'null');
      if (g && g.id && String(g.id).includes('.')) token = g.id;
    } catch (_) { /* ignore */ }

    const applyRoles = (roles) => {
      if (!roles || typeof roles !== 'object') return;
      setTracks({
        menu: roles.menu || null,
        game: roles.game || null,
        endgame: roles.endgame || null,
      });
      if (bgmPhase === 'menu') setPhase('menu');
    };

    /** 棋子图集 / 读秒音（装扮装备）——写入全局供 board.js / playByoyomi 使用 */
    const applyAppearance = (ap) => {
      if (!ap || typeof ap !== 'object') return;
      try {
        if (ap.atlas) global.PIECE_ATLAS_DEFAULT = ap.atlas;
        if (ap.byoyomi != null) setByoyomiVariant(ap.byoyomi);
        // 让已渲染的棋盘按新图集重画（play.js / review.js 监听此事件）
        if (global.document && global.document.dispatchEvent) {
          global.document.dispatchEvent(new global.CustomEvent('tdshogi-appearance'));
        }
      } catch (_) { /* 外观失败不影响 BGM */ }
    };

    try {
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      fetch('/api/items/bgm-roles' + qs)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || !d.ok) return;
          applyRoles(d.roles);
          if (d.appearance) applyAppearance(d.appearance);
        })
        .catch(() => {});
    } catch (_) { /* 无 fetch：保持默认 */ }
  }

  // ==================================================================
  // 自动播放解锁（浏览器策略）：首次用户手势后起 BGM / 恢复 AudioContext。
  // 首页等非对局页没有 play.js 的 pointerdown 钩子，必须在这里兜底。
  // ==================================================================
  function unlockAudio() {
    try { ensureCtx(); } catch (_) { /* 无 AudioContext */ }
    if (musicOn()) bgmSync(true);
  }
  try {
    if (global.document && global.document.addEventListener) {
      for (const ev of ['pointerdown', 'click', 'keydown', 'touchstart']) {
        global.document.addEventListener(ev, unlockAudio, { once: true, passive: true });
      }
      // ⚠️ 2026-10-08（SPA 迁移）：不再需要 pagehide/beforeunload 存续播位置，
      // 也不再需要每 2 秒定时写 sessionStorage —— 文档常驻，<audio> 不销毁。
    }
  } catch (_) { /* 测试环境 */ }

  // 页面加载后立即拉轨并尝试起菜单曲（可能被自动播放策略拦下，手势后再起）
  if (global.document && global.document.addEventListener) {
    const boot = () => { try { initFromServer(); bgmSync(false); } catch (_) {} };
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  global.Sound = {
    playMove, playCapture, playByoyomi, playStart, playEnd,
    playMinuteWarning, playByoyomiMark,
    variant, setByoyomiVariant,
    // BGM 三轨（2026-10-07）+ 音量 / 对手 BGM 交替（2026-10-08）
    setTracks, setPhase, getPhase, getTracks,
    setOpponentTrack, applyMusicVolume, applyPlayOpponentBgm,
    setMusicOn, applyMusicOn, isMusicOn,
    setGameTrackOverride, gameTrackOverride, initFromServer,
    bgmStart, bgmStop, bgmSync, bgmState,
    bgmPauseForPreview, bgmResumeFromPreview,
    setEnabled, applyEnabled, isEnabled, ensureCtx,
  };
})(window);
