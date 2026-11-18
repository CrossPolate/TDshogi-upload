/**
 * fx.js — 棋盘 canvas 特效层（完整档走子粒子 / 庆祝演出）
 *
 * 分层契约（2026-11-17 美术框架）：
 *  - DOM 棋盘负责交互与无障碍；本模块只在 `.shogi-board` 上叠一层
 *    `pointer-events:none` 的 canvas，绝不接管棋子渲染。
 *  - off  = 走子特效关闭 / prefers-reduced-motion → 什么都不画；
 *  - lite = 仅 board.css 的 CSS 伪元素特效（本模块不发射）；
 *  - full = CSS + canvas 粒子（涟漪/火花/金晕/庆祝）。
 *
 * 生命周期：ShogiBoard.build() → FX.attach(boardEl)；destroy() → FX.detach。
 * 全部 stage 共用**一个** rAF：粒子清空自动停表，页面隐藏暂停，
 * 元素脱离文档自动回收（视图忘记 detach 也不泄漏）。DPR 封顶 2。
 */
(function (global) {
  'use strict';

  const DPR_CAP = 2;
  const MAX_PARTS = 240;          // 单 stage 粒子上限：连点/终局庆祝也不失控
  const GOLD = '232,196,106';
  const EMBER = '224,90,71';
  const WARM = '255,214,140';

  const stages = new Map();       // boardEl → stage
  let rafId = 0;
  let lastT = 0;
  let visBound = false;

  /** 当前特效档位：off / lite / full（auto 按设备能力解析） */
  function tier() {
    const S = global.Settings;
    if (!S) return 'lite';
    if (S.get('animateMoves') === false) return 'off';
    try {
      if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'off';
    } catch (_) { /* 无 matchMedia 的环境按正常档 */ }
    const q = S.get('fxQuality');
    if (q === 'lite' || q === 'full') return q;
    const nav = global.navigator || {};
    const saveData = nav.connection && nav.connection.saveData;
    const mem = nav.deviceMemory;
    if (saveData || (mem && mem <= 2)) return 'lite';
    return 'full';
  }

  function resize(st) {
    const rect = st.el.getBoundingClientRect ? st.el.getBoundingClientRect() : { width: 0, height: 0 };
    const w = st.el.clientWidth || rect.width || 0;
    const h = st.el.clientHeight || rect.height || 0;
    const dpr = Math.min(DPR_CAP, global.devicePixelRatio || 1);
    st.w = w; st.h = h; st.dpr = dpr;
    st.canvas.width = Math.max(1, Math.round(w * dpr));
    st.canvas.height = Math.max(1, Math.round(h * dpr));
    st.canvas.style.width = w + 'px';
    st.canvas.style.height = h + 'px';
    if (st.ctx.setTransform) st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function bindVisibility() {
    if (visBound || typeof document === 'undefined' || !document.addEventListener) return;
    visBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopLoop();
      else if (countParts() > 0) startLoop();
    });
  }

  /** 移除节点：优先 parentNode.removeChild（极简 DOM 替身可能没有 el.remove()） */
  function removeNode(node) {
    if (node.parentNode && node.parentNode.removeChild) node.parentNode.removeChild(node);
    else if (node.remove) node.remove();
  }

  /** 把 canvas 特效层挂到棋盘元素上（幂等）。无 2d 上下文时静默降级返回 null。 */
  function attach(el) {
    if (!el) return null;
    if (stages.has(el)) return stages.get(el);
    const canvas = document.createElement('canvas');
    canvas.className = 'fx-layer';
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5;';
    canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) { removeNode(canvas); return null; }
    const st = { el, canvas, ctx, parts: [], ro: null, w: 0, h: 0, dpr: 1 };
    resize(st);
    if (typeof global.ResizeObserver === 'function') {
      try { st.ro = new global.ResizeObserver(() => resize(st)); st.ro.observe(el); } catch (_) { st.ro = null; }
    }
    stages.set(el, st);
    bindVisibility();
    return st;
  }

  function detach(el) {
    const st = stages.get(el);
    if (!st) return;
    if (st.ro && st.ro.disconnect) st.ro.disconnect();
    removeNode(st.canvas);
    stages.delete(el);
    if (!countParts()) stopLoop();
  }

  function detachAll() {
    [...stages.keys()].forEach(detach);
  }

  function countParts() {
    let n = 0;
    stages.forEach((st) => { n += st.parts.length; });
    return n;
  }

  function startLoop() {
    if (rafId || !countParts()) return;
    lastT = 0;
    rafId = global.requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId) { global.cancelAnimationFrame(rafId); rafId = 0; }
    lastT = 0;
  }

  // ------------------------------------------------------------------
  // 粒子生成（程序化，无外部素材；颜色取自主题金/朱/暖白）
  // ------------------------------------------------------------------

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function spawn(type, x, y, size, opts) {
    const out = [];
    if (type === 'ripple') {
      out.push({ kind: 'ring', x, y, t: 0, life: 0.36, r0: size * 0.16, r1: size * (opts.drop ? 1.05 : 0.85), color: GOLD });
    } else if (type === 'sparks') {
      out.push({ kind: 'ring', x, y, t: 0, life: 0.3, r0: size * 0.14, r1: size * 0.8, color: EMBER });
      const n = 10;
      for (let i = 0; i < n; i += 1) {
        const a = (Math.PI * 2 * i) / n + rnd(-0.25, 0.25);
        const sp = rnd(60, 170);
        out.push({
          kind: 'dot', x, y, t: 0, life: rnd(0.34, 0.56),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, g: 220,
          size: rnd(1.6, 3), color: i % 2 ? EMBER : WARM,
        });
      }
    } else if (type === 'glow') {
      out.push({ kind: 'glow', x, y, t: 0, life: 0.55, r: size * 0.95, color: GOLD });
      for (let i = 0; i < 6; i += 1) {
        out.push({
          kind: 'mote', x: x + rnd(-size * 0.3, size * 0.3), y: y + rnd(-size * 0.15, size * 0.2),
          t: 0, life: rnd(0.45, 0.7), vx: rnd(-8, 8), vy: rnd(-55, -25), g: 0,
          size: rnd(1.2, 2.4), color: WARM,
        });
      }
    } else if (type === 'burst') {
      // 终局庆祝：金/朱/暖白花瓣从落点向上抛洒
      const n = 26;
      for (let i = 0; i < n; i += 1) {
        const a = rnd(-Math.PI * 0.85, -Math.PI * 0.15);
        const sp = rnd(90, 260);
        out.push({
          kind: 'petal', x, y, t: 0, life: rnd(0.7, 1.2),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 300,
          size: rnd(3, 6), rot: rnd(0, Math.PI * 2), vr: rnd(-6, 6),
          color: [GOLD, EMBER, WARM][i % 3],
        });
      }
    }
    return out;
  }

  function step(p, dt) {
    if (p.vx !== undefined) {
      p.vy += (p.g || 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (p.vr) p.rot += p.vr * dt;
  }

  function easeOut(k) { return 1 - (1 - k) * (1 - k); }

  function draw(ctx, p) {
    const k = Math.min(1, p.t / p.life);
    if (p.kind === 'ring') {
      const r = p.r0 + (p.r1 - p.r0) * easeOut(k);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.strokeStyle = `rgba(${p.color},1)`;
      ctx.lineWidth = Math.max(0.5, 2.2 * (1 - k));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.kind === 'dot' || p.kind === 'mote') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = p.kind === 'mote' ? Math.sin(Math.PI * k) * 0.9 : 1 - k;
      ctx.fillStyle = `rgba(${p.color},1)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.4, p.size * (1 - k * 0.5)), 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === 'glow') {
      ctx.globalCompositeOperation = 'lighter';
      const a = Math.sin(Math.PI * k) * 0.55;
      const r = Math.max(1, p.r * (0.6 + 0.4 * easeOut(k)));
      if (ctx.createRadialGradient) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(${p.color},${a})`);
        g.addColorStop(1, `rgba(${p.color},0)`);
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (p.kind === 'petal') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = `rgba(${p.color},1)`;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function tick(t) {
    rafId = 0;
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016;
    lastT = t;
    stages.forEach((st, el) => {
      // 视图忘记 detach 的兜底：元素已脱离文档 → 自动回收
      if (el.isConnected === false) { detach(el); return; }
      const ctx = st.ctx;
      if (ctx.clearRect) ctx.clearRect(0, 0, st.w, st.h);
      const alive = [];
      for (const p of st.parts) {
        p.t += dt;
        if (p.t >= p.life) continue;
        step(p, dt);
        draw(ctx, p);
        alive.push(p);
      }
      st.parts = alive;
    });
    if (countParts()) rafId = global.requestAnimationFrame(tick);
    else lastT = 0;
  }

  /**
   * 发射一组粒子。非 full 档直接返回 0（lite 档由 CSS 负责演出）。
   * @param {Element} el 已 attach 的棋盘元素
   * @param {'ripple'|'sparks'|'glow'|'burst'} type
   * @param {number} x 相对棋盘左上角的 px
   * @param {number} y
   * @param {{size?:number, drop?:boolean}} [opts] size=格子边长
   * @returns {number} 实际生成的粒子数
   */
  function emit(el, type, x, y, opts) {
    if (tier() !== 'full') return 0;
    const st = stages.get(el) || attach(el);
    if (!st) return 0;
    const size = (opts && opts.size) || 40;
    const made = spawn(type, x, y, size, opts || {});
    if (!made.length) return 0;
    st.parts.push(...made);
    if (st.parts.length > MAX_PARTS) st.parts.splice(0, st.parts.length - MAX_PARTS);
    startLoop();
    return made.length;
  }

  /** 格子中心相对棋盘左上角的坐标（视角翻转已由调用方的 cell 引用消化） */
  function centerOf(el, cell) {
    if (!el || !cell || !el.getBoundingClientRect || !cell.getBoundingClientRect) return { x: 0, y: 0 };
    const a = el.getBoundingClientRect();
    const b = cell.getBoundingClientRect();
    return { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2 };
  }

  /** 运行状态（测试/排障用） */
  function stats() {
    return { stages: stages.size, particles: countParts(), running: !!rafId, tier: tier() };
  }

  global.FX = { attach, detach, detachAll, emit, centerOf, tier, stats };
})(window);