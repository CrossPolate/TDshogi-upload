/**
 * analysis.js — 浏览器本地引擎复盘（1.6，零服务端 CPU）。
 *
 * 引擎是 Fairy-Stockfish WASM（GPL-3.0），资源由 `npm run sync-engine` 同步到
 * `public/engine/`；分析在 Web Worker 中完成，结果缓存在本机 localStorage。
 * 服务端只提供棋谱数据与功能开关，不再启动任何引擎进程。
 *
 * UMD：浏览器挂 `window.AnalysisEngine`；Node 测试可直接 require（纯函数可测）。
 */
/* global module */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnalysisEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MATE_CP = 30000;
  const DEFAULT_DEPTH = 12;
  const DEFAULT_MOVETIME = 250;
  const MAX_PLIES = 300;
  const CACHE_PREFIX = 'tdshogi_analysis_v1_';
  const DEFAULT_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

  function parseInfo(line) {
    const s = String(line || '').trim();
    if (!s.startsWith('info ')) return null;
    const tokens = s.split(/\s+/);
    const out = {};
    for (let i = 1; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === 'depth') out.depth = Number(tokens[++i]);
      else if (t === 'seldepth') out.seldepth = Number(tokens[++i]);
      else if (t === 'score') {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === 'cp' || kind === 'mate') out.score = { type: kind, value };
      } else if (t === 'pv') {
        out.pv = tokens.slice(i + 1);
        break;
      }
    }
    return out.score ? out : null;
  }

  function toBlackCp(score, sideToMove) {
    if (!score || !Number.isFinite(Number(score.value))) return null;
    const sign = sideToMove === 'b' ? 1 : -1;
    if (score.type === 'mate') {
      const v = Number(score.value);
      return (v > 0 ? 1 : -1) * sign * MATE_CP;
    }
    return Math.round(Number(score.value) * sign);
  }

  function winRate(cp) {
    if (!Number.isFinite(cp)) return null;
    if (cp >= MATE_CP) return 1;
    if (cp <= -MATE_CP) return 0;
    return 1 / (1 + Math.pow(10, -cp / 400));
  }

  function moverCp(blackCp, ply) {
    if (!Number.isFinite(blackCp)) return null;
    return ply % 2 === 1 ? blackCp : -blackCp;
  }

  function classifyLoss(lossCp) {
    if (!Number.isFinite(lossCp)) return null;
    if (lossCp >= 300) return 'blunder';
    if (lossCp >= 150) return 'mistake';
    if (lossCp >= 50) return 'inaccuracy';
    return null;
  }

  function summarize(positions) {
    const list = Array.isArray(positions) ? positions : [];
    const moves = [];
    let blunders = 0;
    let mistakes = 0;
    let inaccuracies = 0;
    for (let ply = 1; ply < list.length; ply += 1) {
      const before = list[ply - 1];
      const after = list[ply];
      const a = moverCp(before && before.cp, ply);
      const b = moverCp(after && after.cp, ply);
      const loss = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, a - b) : null;
      const tag = classifyLoss(loss);
      if (tag === 'blunder') blunders += 1;
      else if (tag === 'mistake') mistakes += 1;
      else if (tag === 'inaccuracy') inaccuracies += 1;
      moves.push({
        ply,
        cp: after ? after.cp : null,
        winRate: after ? winRate(after.cp) : null,
        loss,
        tag,
        bestmove: after ? after.bestmove : null,
      });
    }
    return { blunders, mistakes, inaccuracies, moves };
  }

  function isSupported() {
    return typeof Worker !== 'undefined'
      && typeof SharedArrayBuffer !== 'undefined'
      && typeof WebAssembly !== 'undefined';
  }

  function cacheKey(recordId) {
    return `${CACHE_PREFIX}${recordId}`;
  }

  function loadCached(recordId) {
    try {
      const raw = localStorage.getItem(cacheKey(recordId));
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && Array.isArray(data.positions) ? data : null;
    } catch (_) { return null; }
  }

  function saveCached(recordId, data) {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
      }
      // 只保留最近 20 局分析，避免 localStorage 被历史分析撑满
      while (keys.length >= 20) localStorage.removeItem(keys.shift());
      localStorage.setItem(cacheKey(recordId), JSON.stringify(data));
      return true;
    } catch (_) { return false; }
  }

  function workerUrl() {
    const base = (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' ? location.href : '');
    return new URL('analysis-worker.js', base).href;
  }

  class EngineSession {
    constructor() {
      this.worker = null;
      this.lines = [];
      this.waiters = [];
      this.current = null;
      this.dead = false;
    }

    start(timeoutMs = 30000) {
      if (!isSupported()) {
        return Promise.reject(Object.assign(new Error('当前浏览器不支持本地 WASM 引擎'), { code: 'ENGINE_UNSUPPORTED' }));
      }
      try {
        this.worker = new Worker(workerUrl());
      } catch (e) {
        return Promise.reject(Object.assign(new Error('无法启动分析 Worker'), { code: 'ENGINE_UNAVAILABLE' }));
      }
      this.worker.onmessage = (e) => this._onMessage(e.data || {});
      this.worker.onerror = (e) => this._fail(Object.assign(
        new Error(`本机引擎加载失败${e && e.message ? `：${e.message}` : ''}`),
        { code: 'ENGINE_UNAVAILABLE' }
      ));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('本机引擎初始化超时'), { code: 'ENGINE_TIMEOUT' })), timeoutMs);
        this._ready = { resolve, reject, timer };
      });
    }

    _onMessage(d) {
      if (d.t === 'ready') {
        if (this._ready) {
          clearTimeout(this._ready.timer);
          const r = this._ready;
          this._ready = null;
          r.resolve(this);
        }
        return;
      }
      if (d.t === 'error') {
        this._fail(Object.assign(new Error(d.error || '本机引擎加载失败'), { code: 'ENGINE_UNAVAILABLE' }));
        return;
      }
      if (d.t !== 'line') return;
      const line = String(d.line || '');
      if (this.current) {
        if (line.startsWith('info ')) {
          const info = parseInfo(line);
          if (info) this.current.info = info;
        } else if (line.startsWith('bestmove')) {
          const cur = this.current;
          this.current = null;
          clearTimeout(cur.timer);
          const bestmove = line.split(/\s+/)[1] || null;
          cur.resolve({ bestmove, info: cur.info || null });
          return;
        }
      }
      for (let i = 0; i < this.waiters.length; i += 1) {
        const w = this.waiters[i];
        if (w.predicate(line)) {
          this.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(line);
          return;
        }
      }
      // 保留少量未知行，便于调试；不无限增长
      this.lines.push(line);
      if (this.lines.length > 200) this.lines.shift();
    }

    _fail(err) {
      this.dead = true;
      if (this._ready) {
        clearTimeout(this._ready.timer);
        const r = this._ready;
        this._ready = null;
        r.reject(err);
      }
      if (this.current) {
        const c = this.current;
        this.current = null;
        clearTimeout(c.timer);
        c.reject(err);
      }
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this.waiters = [];
    }

    send(line) {
      if (this.worker && !this.dead) this.worker.postMessage({ cmd: 'cmd', line });
    }

    waitLine(predicate, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('引擎响应超时'), { code: 'ENGINE_TIMEOUT' })), timeoutMs);
        this.waiters.push({ predicate, resolve, reject, timer });
      });
    }

    analyzePosition(startSfen, moves, opts = {}) {
      const depth = Math.max(1, Math.min(30, Number(opts.depth) || DEFAULT_DEPTH));
      const movetime = Math.max(50, Math.min(5000, Number(opts.movetime) || DEFAULT_MOVETIME));
      const position = moves && moves.length
        ? `position sfen ${startSfen} moves ${moves.join(' ')}`
        : `position sfen ${startSfen}`;
      this.send(position);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.current) this.current = null;
          this.send('stop');
          reject(Object.assign(new Error('引擎分析超时'), { code: 'ENGINE_TIMEOUT' }));
        }, Math.max(2000, movetime * 5 + 2000));
        this.current = { resolve, reject, timer, info: null };
        this.send(`go depth ${depth} movetime ${movetime}`);
      });
    }

    destroy() {
      this.dead = true;
      try { if (this.worker) { this.worker.postMessage({ cmd: 'quit' }); this.worker.terminate(); } } catch (_) {}
      this.worker = null;
    }
  }

  async function analyze(record, opts = {}) {
    const recordId = record && record.id;
    const moves = Array.isArray(record && record.moves) ? record.moves : [];
    if (!recordId) throw Object.assign(new Error('棋谱 id 缺失'), { code: 'BAD_RECORD' });
    if (moves.length > MAX_PLIES) {
      throw Object.assign(new Error(`棋谱超过 ${MAX_PLIES} 手，暂不分析`), { code: 'RECORD_TOO_LONG' });
    }
    const cached = loadCached(recordId);
    if (cached && !opts.force) return cached;
    const session = new EngineSession();
    try {
      await session.start();
      const uciok = session.waitLine((l) => l === 'uciok', 8000);
      session.send('uci');
      await uciok;
      session.send('setoption name UCI_Variant value shogi');
      const readyok = session.waitLine((l) => l === 'readyok', 8000);
      session.send('isready');
      await readyok;

      const startSfen = record.startSfen || DEFAULT_SFEN;
      const positions = [];
      for (let ply = 0; ply <= moves.length; ply += 1) {
        const r = await session.analyzePosition(startSfen, moves.slice(0, ply), {
          depth: opts.depth || DEFAULT_DEPTH,
          movetime: opts.movetime || DEFAULT_MOVETIME,
        });
        const side = ply % 2 === 0 ? 'b' : 'w';
        const score = r.info && r.info.score ? r.info.score : null;
        positions.push({
          ply,
          cp: toBlackCp(score, side),
          score,
          bestmove: r.bestmove,
          pv: (r.info && r.info.pv) || [],
          depth: (r.info && r.info.depth) || null,
        });
        if (typeof opts.onProgress === 'function') opts.onProgress(ply + 1, moves.length + 1);
      }
      const data = {
        recordId,
        engine: 'Fairy-Stockfish WASM',
        depth: opts.depth || DEFAULT_DEPTH,
        movetime: opts.movetime || DEFAULT_MOVETIME,
        positions,
        summary: summarize(positions),
        createdAt: Date.now(),
      };
      saveCached(recordId, data);
      return data;
    } finally {
      session.destroy();
    }
  }

  return {
    MATE_CP,
    DEFAULT_DEPTH,
    DEFAULT_MOVETIME,
    MAX_PLIES,
    parseInfo,
    toBlackCp,
    winRate,
    moverCp,
    classifyLoss,
    summarize,
    isSupported,
    loadCached,
    saveCached,
    analyze,
  };
});
