'use strict';

/**
 * analysis-worker.js — 浏览器本地引擎 Worker。
 *
 * 引擎资源由 `npm run sync-engine` 放到 /js/engine/（Fairy-Stockfish WASM，GPL-3.0）。
 * 这里只做 UCI 命令/输出转发；队列与评分归一化在 analysis.js。
 */
importScripts('engine/stockfish.js');

let sf = null;
let dead = false;

function send(msg) {
  try { postMessage(msg); } catch (_) {}
}

(async () => {
  try {
    // Worker 的 location 是 /js/analysis-worker.js，而引擎资源在 /js/engine/。
    // 显式给出 locateFile/mainScriptUrlOrBlob，避免 Emscripten 按 Worker 的目录去找 wasm/线程脚本。
    const base = new URL('engine/', self.location.href).href;
    const Module = {
      locateFile: (name) => new URL(name, base).href,
      mainScriptUrlOrBlob: new URL('stockfish.js', base).href,
    };
    sf = await Stockfish(Module);
    sf.addMessageListener((line) => send({ t: 'line', line: String(line) }));
    send({ t: 'ready' });
  } catch (e) {
    send({ t: 'error', error: String((e && e.message) || e) });
  }
})();

self.onmessage = (e) => {
  const d = e.data || {};
  if (d.cmd === 'quit') {
    dead = true;
    try { if (sf && sf.terminate) sf.terminate(); } catch (_) {}
    try { close(); } catch (_) {}
    return;
  }
  if (d.cmd !== 'cmd' || dead) return;
  try {
    if (!sf) return;
    sf.postMessage(String(d.line || ''));
  } catch (err) {
    send({ t: 'error', error: String((err && err.message) || err) });
  }
};
