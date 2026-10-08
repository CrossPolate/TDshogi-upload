/**
 * freeboard-dnd.js — 棋盘**输入交互层**：点选 / 点击 / 拖拽（Pointer Events）
 *
 * §M5（2026-09-28）：从 `public/js/freeboard.js`（原 667 行）整段搬出，只做两处机械变换
 * （方法首行改成 function 声明、整体左移 2 格缩进），**逻辑一字未改**。
 *
 * 装配方式：本文件只暴露工厂 `window.FreeBoardDnd.make(deps)`，由 `freeboard.js` 在
 * 类定义之后把方法注入原型：
 *
 *     Object.assign(FreeBoard.prototype, window.FreeBoardDnd.make({ sqToRC, DROP_NAME, ... }));
 *
 * 走工厂注入而非直接读全局，是为了让依赖**显式**：搬出来的代码仍能用裸名 `sqToRC` /
 * `DROP_NAME` / `DRAG_THRESHOLD_*`（它们是工厂形参，被闭包捕获），但依赖关系一眼可见，
 * 不依赖脚本加载顺序时机的巧合。
 *
 * ⚠️ 本文件必须在 `freeboard.js` **之前**加载（`freeboard.js` 装配时会检查，缺失即抛错）。
 *
 * 覆盖：`_canPickHand` · `_dragEnabled` · `bindHands` · `clearSelection` · `_selectFrom` ·
 *       `_tryTarget` · `_pickHand` · `_handleClick` · `_handleDblClick` ·
 *       `_handlePointerDown` · `_ensureGhost` · `_handleDocMove` · `_handleHandPointerDown` ·
 *       `_handleDocUp` · `_removeGhost`
 */
(function (global) {
  'use strict';

  /**
   * @param {{sqToRC:Function, DROP_NAME:Object, DRAG_THRESHOLD_MOUSE:number, DRAG_THRESHOLD_TOUCH:number}} deps
   * @returns {Object} 注入 `FreeBoard.prototype` 的方法表
   */
  function make({ sqToRC, DROP_NAME, DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH }) {
  function _canPickHand(color) {
    if (this.mode === 'review') return false;
    return this.mode === 'free' || !this.turnColor || color === this.turnColor;
  }

  /**
   * 是否允许「按住拖拽」走子（PLAN §S3）。
   *
   * 触屏设备默认**关闭**：手机上「想滚动页面」与「拖拽走子」手势冲突，
   * 极易误走一步；改用「点棋子 → 点目标格」两步点选更可靠
   * （81Dojo 移动版同样以点选为主）。桌面鼠标拖拽不受此设置影响。
   *
   * 关闭拖拽只影响 pointerdown 链路，**点击走子（_handleClick）完全不受影响**。
   */
  function _dragEnabled() {
    if (!global.Settings) return true;
    if (global.Settings.get('dragToMove')) return true;
    return !(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
  }

  function bindHands(myEl, myColor, oppEl, oppColor) {
    this.handsEls = { my: myEl, myColor, opp: oppEl, oppColor };
    // 驹台容器绑定 pointerdown：支持从驹台拖拽打入/放置（PLAN §H）
    if (myEl) {
      myEl.dataset.fbColor = myColor;
      myEl.addEventListener('pointerdown', (e) => this._handleHandPointerDown(e, myColor));
    }
    if (oppEl) {
      oppEl.dataset.fbColor = oppColor;
      oppEl.addEventListener('pointerdown', (e) => this._handleHandPointerDown(e, oppColor));
    }
  }

  function clearSelection() { this.selectedSq = null; this.selectedHand = null; this.render(); }

  // ---------- 选中/出招核心（模式间共享） ----------
  function _selectFrom(sq) {
    const targets = this.legalTargetsBySq[sq];
    if (!targets) return false; // 该棋子当前不可动
    this.selectedSq = sq;
    this.selectedHand = null;
    this.render();
    return true;
  }

  function _tryTarget(fromSq, toSq) {
    const targets = this.legalTargetsBySq[fromSq] || [];
    const t = targets.find((x) => x.to === toSq);
    if (!t) return false;
    this.selectedSq = null;
    // ⚠️ 2026-10-02 体验修复：清选中必须把**两种**选中态都清掉。此前只清 selectedSq，
    // 而 render() 会用「selectedHand || selectedSq」重铺高亮：若玩家先点了驹台（selectedHand 仍在），
    // 弹层背后就会残留一片打点绿点。棋盘走子 / 拖拽两条路径都会走到这里，一次修好两处。
    this.selectedHand = null;
    const promote = targets.find((x) => x.to === toSq && x.promote);
    const non = targets.find((x) => x.to === toSq && !x.promote);
    if (promote && non && this.onPromoteChoice) {
      this.render(); // ⚠️ 2026-10-02 体验修复：弹层前先重绘，清掉上一手的落点/目标高亮
      this.onPromoteChoice({ to: toSq, usiMove: non.usi, usiPromote: promote.usi });
    } else if (this.onMove) {
      this.onMove(t.usi);
    }
    return true;
  }

  function _pickHand(color, piece, sym) {
    if (this.selectedHand && this.selectedHand.color === color && this.selectedHand.piece === piece) {
      this.selectedHand = null;
    } else {
      this.selectedHand = { color, piece, sym: sym || Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece) };
      this.selectedSq = null;
    }
    this.render();
  }

  // ---------- 点击流 ----------
  function _handleClick(e) {
    if (!this.model) return;
    // review 模式：只读浏览，不依赖 interactive——只把点击的格子回执给页面
    // （如复盘页点击上一步的落点跳到该手）
    if (this.mode === 'review') {
      const rc = e.target.closest('.cell');
      if (rc && rc.dataset.sq && this.onSqClick) this.onSqClick(rc.dataset.sq);
      return;
    }
    if (!this.interactive || this._drag) return;
    const hand = e.target.closest('.hand-piece');
    if (hand && hand.parentElement && hand.parentElement.dataset.fbColor) {
      const color = hand.parentElement.dataset.fbColor;
      if (!this._canPickHand(color)) return; // 非手番方持驹禁选
      const piece = hand.dataset.piece;
      if (this.mode === 'free') { this._pickHand(color, piece); return; }
      const sym = Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
      if (sym && this.legalTargetsBySq[sym]) { this._pickHand(color, piece, sym); return; }
      return; // 该棋子无合法打点
    }
    const cell = e.target.closest('.cell');
    // ⚠️ 2026-10-02 体验修复：点在棋盘容器的**空白区域**（格子之间的内边距/边框，closest 不到 .cell）
    // 时不能静默 return——否则已选中的棋子/持驹与高亮会一直挂着。这里改为清除当前选中。
    if (!cell || !cell.dataset.sq) {
      if (this.selectedSq || this.selectedHand) clearSelection.call(this);
      return;
    }
    this._activateSq(cell.dataset.sq);
  }

  /**
   * §6.3：给定格名，执行「点击该格」的全部逻辑。
   *
   * 抽出来的唯一理由：**键盘 Enter 与鼠标点击必须共用同一处走子逻辑**——
   * 各写一份必然渐渐分叉（一处修了另一处忘改），这正是本项目反复踩的坑。
   */
  function _activateSq(sq) {
    if (!this.model || !sq) return;
    if (this.mode === 'review') { if (this.onSqClick) this.onSqClick(sq); return; }
    if (!this.interactive || this._drag) return;
    const [r, c] = sqToRC(sq);
    const cellPiece = this.model.board[r][c];
    // ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 选中态回执（接线）。
    // free 模式下 `selectedSq` 只在本函数里变更（鼠标点击 `_handleClick` 与键盘 Enter
    // 都汇到 `_activateSq`，见上方注释「键盘与鼠标必须共用同一处逻辑」），所以
    // 处理完再回执一次就够覆盖两条路径。回调收到的永远是**已经定稿**的 selectedSq
    // （例如「双击升变」的第二次点击会把选中取消 → 回执 null）。
    if (this.mode === 'free') {
      this._freeClick(sq);
      if (this.onSqSelect) this.onSqSelect(this.selectedSq);
      return;
    }
    if (this.selectedHand) {
      // ⚠️ 2026-10-02 体验修复：打子未命中合法落点（点到空白格 / 无可走目标区域）时清除选中，
      // 此前直接 return → 选中态与打点高亮一直挂着，玩家以为"点了没反应"。
      if (this._tryTarget(this.selectedHand.sym, sq)) { this.selectedHand = null; this.render(); }
      else { this.selectedHand = null; this.selectedSq = null; this.render(); }
      return;
    }
    if (this.selectedSq && this.selectedSq !== sq) {
      if (this._tryTarget(this.selectedSq, sq)) { this.selectedSq = null; this.render(); return; }
      // 未命中合法目标：点的是可再选的己方棋子 → 改选；否则清除选中（不再残留高亮）
      if (cellPiece && cellPiece.piece && this._selectFrom(sq)) return;
      this.selectedSq = null;
      this.render();
      return;
    }
    if (this.selectedSq === sq) { this.selectedSq = null; this.render(); return; }
    if (cellPiece && cellPiece.piece && this._selectFrom(sq)) return;
    // 无选中 / 点到不可动的棋子：落到这里都清一次，确保空白格不残留旧高亮
    this.selectedSq = null;
    this.render();
  }

  // ---------- 键盘走子（§6.3） ----------
  /** 在**显示网格**里找某格名的 [r,c]（与视角翻转同口径） */
  function _findDisplayRC(sq) {
    const cells = this.board && this.board.cells;
    if (!cells) return null;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (cells[r][c] && cells[r][c].dataset.sq === sq) return [r, c];
      }
    }
    return null;
  }

  /** 默认活动格：棋盘正中心（5e 一带），保证第一次按方向键就有落点 */
  function _defaultKbSq() {
    const cells = this.board && this.board.cells;
    if (!cells || !cells[4] || !cells[4][4]) return null;
    return cells[4][4].dataset.sq;
  }

  /** 把「活动格」同步到 ARIA（aria-activedescendant）并加一个可视焦点类 */
  function _syncKbFocus() {
    const el = this.board && this.board.boardEl;
    if (!el || !this._kbSq) return;
    const pos = _findDisplayRC.call(this, this._kbSq);
    if (!pos) return;
    const cell = this.board.cells[pos[0]][pos[1]];
    if (cell && cell.id && el.setAttribute) el.setAttribute('aria-activedescendant', cell.id);
    if (el.querySelectorAll) el.querySelectorAll('.cell.kb-active').forEach((x) => x.classList.remove('kb-active'));
    if (cell && cell.classList) cell.classList.add('kb-active');
  }

  /**
   * 棋盘键盘操作：**方向键**在显示网格里移动「活动格」，**Enter/Space** 等价于点击该格，
   * **Esc** 取消当前选中。仅对可交互棋盘生效（review 模式只允许移动 + 回执点击）。
   */
  function _handleKeydown(e) {
    if (!this.model) return;
    const review = this.mode === 'review';
    if (!review && (!this.interactive || this._drag)) return;
    const key = e.key;
    if (key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      this._kbSq = null;
      clearSelection.call(this);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (e.preventDefault) e.preventDefault();
      if (!this._kbSq) this._kbSq = _defaultKbSq.call(this);
      if (!this._kbSq) return;
      this._activateSq(this._kbSq);
      _syncKbFocus.call(this);
      return;
    }
    const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
    if (!dir) return;
    if (e.preventDefault) e.preventDefault();
    if (!this._kbSq) this._kbSq = _defaultKbSq.call(this);
    const pos = _findDisplayRC.call(this, this._kbSq) || [4, 4];
    const dr = Math.max(0, Math.min(8, pos[0] + dir[0]));
    const dc = Math.max(0, Math.min(8, pos[1] + dir[1]));
    const cell = this.board.cells[dr][dc];
    if (!cell) return;
    this._kbSq = cell.dataset.sq;
    _syncKbFocus.call(this);
  }

  function _handleDblClick(e) {
    if (!this.interactive || !this.model || this.mode !== 'free') return;
    const cell = e.target.closest('.cell');
    if (!cell || !cell.dataset.sq) return;
    this.togglePromote(cell.dataset.sq);
  }

  // ---------- 拖拽行棋（Pointer Events：鼠标/触屏通用） ----------
  function _handlePointerDown(e) {
    if (!this.interactive || !this.model || (e.button !== undefined && e.button !== 0)) return;
    if (!this._dragEnabled()) return; // §S3：触屏默认不拖拽（点选两步走子）
    const hand = e.target.closest('.hand-piece');
    let drag = null;
    if (hand && hand.parentElement && hand.parentElement.dataset.fbColor) {
      const color = hand.parentElement.dataset.fbColor;
      if (!this._canPickHand(color)) return; // 非手番方持驹禁拖
      const piece = hand.dataset.piece;
      const sym = Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
      if (this.mode === 'free') drag = { kind: 'hand-free', color, piece };
      else if (sym && this.legalTargetsBySq[sym]) drag = { kind: 'hand', color, piece, sym, fromSq: sym };
      if (!drag) return;
      drag.ghostSrc = hand.innerHTML;
    } else {
      const cell = e.target.closest('.cell');
      if (!cell || !cell.dataset.sq) return;
      const sq = cell.dataset.sq;
      const [r, c] = sqToRC(sq);
      const cellPiece = this.model.board[r][c];
      if (!cellPiece || !cellPiece.piece) return;
      if (this.mode === 'free') drag = { kind: 'cell-free', fromSq: sq };
      else if (this.legalTargetsBySq[sq]) drag = { kind: 'cell', fromSq: sq };
      else return; // 不可动的棋子
      const pieceEl = cell.querySelector('span, img, div');
      drag.ghostSrc = pieceEl ? pieceEl.outerHTML : cell.innerHTML;
    }
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.pointerId = e.pointerId;
    drag.pointerType = e.pointerType || 'mouse';
    this._drag = drag;
    this._docMove = (ev) => this._handleDocMove(ev);
    this._docUp = (ev) => this._handleDocUp(ev);
    document.addEventListener('pointermove', this._docMove);
    document.addEventListener('pointerup', this._docUp);
    // 触屏不 preventDefault：保留页面滚动能力，改由 CSS touch-action 控制棋盘区域
    if (drag.pointerType !== 'touch') e.preventDefault();
  }

  function _ensureGhost() {
    if (this._drag.ghost) return this._drag.ghost;
    const g = document.createElement('div');
    g.className = 'fb-drag-ghost';
    g.innerHTML = this._drag.ghostSrc;
    document.body.appendChild(g);
    this._drag.ghost = g;
    return g;
  }

  function _handleDocMove(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    // 触屏阈值更宽：手指按下难免微动，太灵敏会把"点一下"误判成拖拽
    const threshold = drag.pointerType === 'touch' ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < threshold) return;
    drag.moved = true;
    const ghost = this._ensureGhost();
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    // 触屏时把幽灵抬到手指上方，避免被手指完全遮住
    if (drag.pointerType === 'touch') ghost.style.transform = 'translate(-50%, -125%)';
    // 悬停格高亮
    document.querySelectorAll('.cell.drag-over').forEach((c) => c.classList.remove('drag-over'));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.cell');
    if (cell) cell.classList.add('drag-over');
  }

  /** 驹台拖拽起点：按住驹台棋子拖到目标格（rules 校验合法打点；free 自由放置） */
  function _handleHandPointerDown(e, color) {
    if (!this.interactive || !this.model) return;
    if (!this._dragEnabled()) return; // §S3：触屏默认不拖拽（点选两步打入）
    // 视角翻转后，监听器闭包捕获的 color 会与当前左右驹台不符
    // （setViewpoint 只交换配色标记、不重建监听器）→ 以元素上的 dataset.fbColor 为准纠正，
    // 避免「拖下方驹台却按对面身份打子」。§S6 复盘翻转与 §R1 观战翻转共用此修正。
    const holder = e.currentTarget;
    if (holder && holder.dataset && holder.dataset.fbColor) color = holder.dataset.fbColor;
    if (!this._canPickHand(color)) return; // 非手番方持驹禁拖
    const wrap = e.target.closest('.hand-piece');
    if (!wrap) return;
    const piece = wrap.dataset.piece;
    const sym = Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
    if (this.mode !== 'free') {
      if (!sym || !(this.legalTargetsBySq[sym] || []).length) return; // 无合法打点不可拖
    }
    const touch = e.pointerType === 'touch';
    this._drag = {
      kind: this.mode === 'free' ? 'hand-free' : 'hand',
      color, piece, sym, fromSq: sym,
      startX: e.clientX, startY: e.clientY, pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      ghostSrc: wrap.innerHTML,
    };
    this._docMove = (ev) => this._handleDocMove(ev);
    this._docUp = (ev) => this._handleDocUp(ev);
    document.addEventListener('pointermove', this._docMove);
    document.addEventListener('pointerup', this._docUp);
    if (!touch) e.preventDefault();
  }

  function _handleDocUp(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    document.removeEventListener('pointermove', this._docMove);
    document.removeEventListener('pointerup', this._docUp);
    this._drag = null;
    if (drag.ghost) drag.ghost.remove();
    document.querySelectorAll('.cell.drag-over').forEach((c) => c.classList.remove('drag-over'));
    if (!drag.moved) return; // 未拖动 → 交给 click 流程
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.cell');
    const toSq = cell && cell.dataset.sq;
    if (!toSq) return;
    if (drag.kind === 'cell-free' || drag.kind === 'hand-free') {
      if (drag.kind === 'cell-free') this._move(drag.fromSq, toSq);
      else this._drop(drag.color, drag.piece, toSq);
      return;
    }
    // play / demo-rules：目标是合法落点才出招
    const fromSq = drag.fromSq;
    if (fromSq === toSq) return;
    if (!this._tryTarget(fromSq, toSq)) {
      // 非法落点：无操作（棋子由模型重绘归位）
      this.render();
    } else {
      this.selectedSq = null;
      this.selectedHand = null;
      this.render();
    }
  }

  function _removeGhost() {
    if (this._drag && this._drag.ghost) this._drag.ghost.remove();
    document.querySelectorAll('.fb-drag-ghost').forEach((g) => g.remove());
  }

    // 注入表：freeboard.js 用 Object.assign(FreeBoard.prototype, …) 装配
    return {
      _canPickHand, _dragEnabled, bindHands, clearSelection,
      _selectFrom, _tryTarget, _pickHand, _handleClick, _handleDblClick,
      _activateSq, _handleKeydown,
      _handlePointerDown, _ensureGhost, _handleDocMove, _handleHandPointerDown,
      _handleDocUp, _removeGhost,
    };
  }

  global.FreeBoardDnd = { make };
})(typeof window !== 'undefined' ? window : globalThis);
