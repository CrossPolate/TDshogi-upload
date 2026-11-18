/**
 * portrait.js — 立绘槽位（对局两侧 / 未来选手卡复用）
 *
 * 素材契约（2026-11-17 美术框架，.tdpack sprite 商品的可选 `art` 字段）：
 *   spec = { kind:'image'|'glyph', value, art?:{ frames, fps, expressions } }
 *   - frames>1：value 是**横排帧条**（N 帧等宽，推荐单帧 3:4），按 fps 循环播放；
 *   - expressions：{ idle, talk, win, lose } → 各状态独立图（仅单图模式换图；
 *     帧条模式只切换状态演出类）；
 *   - 缺素材 / 加载失败 → 回退金色剪影，绝不出现破图。
 *
 * 状态机：idle（呼吸）/ talk（说话轻摆）/ win（金光弹跳）/ lose（灰暗低垂）。
 * 演出全部走 CSS（style.css 立绘段 + motion.css 令牌），reduced-motion 自动全关。
 *
 * 防闪烁：同一素材签名不重建 DOM（state 广播每手都来，重建会重置动画/重新拉图）。
 * 生命周期：视图 unmount 调 Portrait.dispose(box) 清 talk 定时器与 DOM。
 */
(function (global) {
  'use strict';

  const STATES = ['idle', 'talk', 'win', 'lose'];
  const MAX_FRAMES = 64;
  const MAX_FPS = 30;

  const SILHOUETTE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 160'>"
    + "<g fill='none' stroke='#c9a227' stroke-width='3' opacity='0.55'>"
    + "<circle cx='60' cy='52' r='26'/>"
    + "<path d='M20 150c0-30 18-46 40-46s40 16 40 46'/>"
    + "</g></svg>",
  );

  function specOf(spec) {
    if (!spec || !spec.value) return null;
    const art = (spec.art && typeof spec.art === 'object') ? spec.art : {};
    let frames = Math.floor(Number(art.frames));
    if (!Number.isFinite(frames) || frames < 1) frames = 1;
    frames = Math.min(MAX_FRAMES, frames);
    let fps = Number(art.fps);
    if (!Number.isFinite(fps) || fps < 1) fps = 8;
    fps = Math.min(MAX_FPS, fps);
    const expressions = {};
    if (art.expressions && typeof art.expressions === 'object') {
      for (const s of STATES) {
        const u = art.expressions[s];
        if (typeof u === 'string' && u) expressions[s] = u;
      }
    }
    return { kind: spec.kind === 'image' ? 'image' : 'glyph', value: String(spec.value), frames, fps, expressions };
  }

  function sigOf(p) {
    return JSON.stringify([p.kind, p.value, p.frames, p.fps, p.expressions]);
  }

  function findImg(box) {
    for (const c of box.children || []) {
      if (c.tagName === 'IMG') return c;
      for (const cc of c.children || []) if (cc.tagName === 'IMG') return cc;
    }
    return null;
  }

  function clearBox(box) {
    if (box._portrait && box._portrait.talkTimer) clearTimeout(box._portrait.talkTimer);
    box.innerHTML = '';
    if (box.classList) STATES.forEach((s) => box.classList.remove('portrait-' + s));
  }

  /**
   * 渲染立绘到槽位。spec 为空 → 隐藏槽位（空默认商城模型：未装备不占视觉）。
   * 同签名重复调用只保证可见，不重建 DOM。
   */
  function render(box, spec) {
    if (!box) return;
    const p = specOf(spec);
    if (!p) {
      clearBox(box);
      box.style.display = 'none';
      box._portrait = null;
      return;
    }
    const sig = sigOf(p);
    if (box._portrait && box._portrait.sig === sig) {
      box.style.display = 'flex';
      return;
    }
    clearBox(box);
    box.style.display = 'flex';
    box.classList.add('portrait-slot');
    box._portrait = { sig, spec: p, state: 'idle', base: 'idle', talkTimer: 0 };

    if (p.kind === 'glyph') {
      const span = document.createElement('span');
      span.className = 'portrait-glyph';
      span.textContent = p.value;
      box.appendChild(span);
    } else if (p.frames > 1) {
      const strip = document.createElement('div');
      strip.className = 'portrait-strip';
      const img = document.createElement('img');
      img.className = 'portrait-img portrait-strip-img';
      img.alt = '';
      img.decoding = 'async';
      img.src = p.expressions.idle || p.value;
      img.style.width = (p.frames * 100) + '%';
      img.style.maxWidth = 'none';
      img.style.height = '100%';
      img.style.objectFit = 'fill';
      const dur = (p.frames / p.fps).toFixed(3);
      img.style.setProperty('--p-end', '-' + (((p.frames - 1) / p.frames) * 100).toFixed(4) + '%');
      img.style.animation = `portrait-strip ${dur}s steps(${p.frames - 1}) infinite`;
      img.addEventListener('error', () => fallback(box), { once: true });
      strip.appendChild(img);
      box.appendChild(strip);
    } else {
      const img = document.createElement('img');
      img.className = 'portrait-img';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = p.expressions.idle || p.value;
      img.addEventListener('error', () => fallback(box), { once: true });
      box.appendChild(img);
    }
    setState(box, 'idle');
  }

  /** 加载失败回退：金色剪影（只回退一次，剪影本身不再触发） */
  function fallback(box) {
    const img = findImg(box);
    if (!img || img.src === SILHOUETTE) return;
    if (img.style) {
      img.style.animation = '';
      img.style.width = '';
      img.style.maxWidth = '100%';
      img.style.objectFit = 'contain';
    }
    img.src = SILHOUETTE;
    if (box.classList) box.classList.add('portrait-fallback');
  }

  /** 切换状态：idle / talk / win / lose（非法值归一 idle） */
  function setState(box, state) {
    if (!box || !box._portrait) return;
    if (!STATES.includes(state)) state = 'idle';
    const rec = box._portrait;
    if (state !== 'talk') rec.base = state;
    rec.state = state;
    STATES.forEach((s) => box.classList.remove('portrait-' + s));
    box.classList.add('portrait-' + state);
    // 表情差分：仅单图模式换图（帧条模式保持帧动画，只切演出类）；
    // idle 无差分图时回到主图，避免停留在 win/lose 表情上
    const p = rec.spec;
    if (p.kind === 'image' && p.frames === 1) {
      const target = p.expressions[state] || (state === 'idle' ? p.value : '');
      const img = findImg(box);
      if (target && img && !box.classList.contains('portrait-fallback')) img.src = target;
    }
  }

  /** 说话演出：talk 持续 ms 后回到基础状态（win/lose 不会被 talk 覆盖回去） */
  function talk(box, ms) {
    if (!box || !box._portrait) return;
    const rec = box._portrait;
    if (rec.base === 'win' || rec.base === 'lose') return;
    setState(box, 'talk');
    if (rec.talkTimer) clearTimeout(rec.talkTimer);
    rec.talkTimer = setTimeout(() => {
      rec.talkTimer = 0;
      if (box._portrait === rec && rec.state === 'talk') setState(box, rec.base);
    }, Math.max(200, Number(ms) || 1200));
  }

  /** 视图卸载：清定时器 + DOM + 状态记录 */
  function dispose(box) {
    if (!box) return;
    clearBox(box);
    box._portrait = null;
  }

  /**
   * 立绘列布局协商（纯函数，play.js 与测试共用）。
   *
   * 立绘与「棋盘 + 两侧驹台」同处一行（flex 实占列，**结构上不可能遮挡**）。
   * 舞台宽减去驹台 / 间隙 / 立绘列 / 棋盘内边距后，余量才是棋盘能用的宽度：
   * 默认格尺寸放得下 → 棋盘不动（cell=null）；放不下 → 缩格让位；
   * 缩到 minCell 以下仍放不下 → 放弃立绘（show=false），绝不压驹台、也不把棋盘挤到不可用。
   *
   * @param {object} o {left,right:boolean, stageW,handsW,areaGap,stageGap,spriteW,pad,minCell,baseCell:number}
   * @returns {{show:boolean, cell:number|null}}
   */
  function fitColumns(o) {
    const n = (o.left ? 1 : 0) + (o.right ? 1 : 0);
    if (!n) return { show: false, cell: null };
    const avail = o.stageW - o.handsW - o.areaGap - o.stageGap * n - o.spriteW * n - o.pad;
    const fit = Math.floor(avail / 9);
    if (fit < o.minCell) return { show: false, cell: null };
    return { show: true, cell: fit < o.baseCell ? fit : null };
  }

  global.Portrait = { STATES, render, setState, talk, dispose, fitColumns, SILHOUETTE };
})(window);