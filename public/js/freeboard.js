/**
 * freeboard.js — 统一棋盘组件（PLAN §G v6，2026-09-08 优化）
 *
 * 四种模式（一个组件，全站共用）：
 *   play       对战：高亮服务端合法落点，onMove(usi) 交页面发送（服务端权威）
 *   demo-rules 感想战：同规则行棋，本地模型乐观渲染（服务端 demo 校验 + 广播）
 *   free       自由摆棋：不校验规则，本地草稿（撤销/双击升变，不入谱）
 *   review     复盘浏览：只读（不可选子/不可拖），自动带上一步与王手高亮（PLAN §M6）
 *
 * 所有「查看棋谱」的场景（复盘页 / 历史页 / 棋谱广场 / 管理后台回放 / 对局页终局浏览）
 * 都应使用 review 模式，保证渲染链路唯一。
 *
 * 交互：点击流 + 拖拽行棋（鼠标/触屏 Pointer Events，参考 lishogi/81dojo）。
 * 吃子/打子归属按正常将棋规则（被吃子恢复原始棋种进吃方驹台）。
 *
 * 坐标策略：模型统一用服务端 r/c 坐标，渲染交给 ShogiBoard（内部处理视角镜像）。
 * 棋种映射统一取自 `piece-kinds.js`（单一来源，加载时自检互逆）。
 */
(function (global) {
  // 棋种映射：取自单一来源 piece-kinds.js（不存在时退回内联备份，保证旧页面不炸）
  const K = global.PieceKinds || {};
  const PROMOTE = K.PROMOTE || { '歩': 'と', '香': '成香', '桂': '成桂', '銀': '成銀', '角': '馬', '飛': '龍' };
  const DEMOTE = K.DEMOTE || { 'と': '歩', '成香': '香', '杏': '香', '成桂': '桂', '圭': '桂', '成銀': '銀', '全': '銀', '馬': '角', '龍': '飛' };
  const DROP_NAME = K.DROP_NAME || { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛' };
  const rawOf = K.rawOf || ((name) => DEMOTE[name] || name);

  const MODES = ['play', 'demo-rules', 'free', 'review'];
  // 拖拽阈值：手指比鼠标抖，触屏放宽一点，避免点一下被判成拖拽
  const DRAG_THRESHOLD_MOUSE = 6;
  const DRAG_THRESHOLD_TOUCH = 12;

  function sqToRC(sq) {
    const x = parseInt(sq[0], 10) - 1;
    const y = sq.charCodeAt(1) - 97;
    return [y, x];
  }

  class FreeBoard {
    constructor({ board, viewpoint = 'b', interactive = false, mode = 'play', hands, onChange, onMove, onPromoteChoice, onSqClick = null } = {}) {
      this.board = board;            // ShogiBoard 实例
      this.viewpoint = viewpoint;
      this.interactive = !!interactive;
      this.mode = MODES.includes(mode) ? mode : 'play';
      this.handsEls = hands || null; // { my: el, myColor, opp: el, oppColor }
      this.onChange = onChange || null;
      this.onMove = onMove || null;          // (usi) => void
      this.onPromoteChoice = onPromoteChoice || null; // ({ usiMove, usiPromote }) => void
      this.onSqClick = onSqClick || null;    // (sq) => void，仅 review 模式：点击格子回执（如跳转到该手）
      this.model = null;             // { board, hands }
      this.lastMove = null;
      this.checkSquares = [];        // 王手格（J2：此前 setModel 的第三参被丢弃，高亮丢失）
      this.legalTargetsBySq = {};    // { fromSq|dropSym: [{to, usi, promote}] }
      this.turnColor = null;         // 当前手番 'b'|'w'（非 free 模式下限制只能选手番方持驹）
      this.history = [];             // free 模式撤销栈
      this.selectedSq = null;
      this.selectedHand = null;      // { color, piece, sym }
      this._onClick = (e) => this._handleClick(e);
      this._onDbl = (e) => this._handleDblClick(e);
      this._onPointerDown = (e) => this._handlePointerDown(e);
      this._drag = null;
    }

    // ---------- 装载 ----------
    /**
     * 装载局面。
     * @param {{board:Array, hands:object}} modelLike
     * @param {string|null} lastMove 上一步**落点格**（如 '7f'），不是完整 USI
     */
    setModel(modelLike, lastMove = null) {
      this.model = {
        board: JSON.parse(JSON.stringify(modelLike.board)),
        hands: JSON.parse(JSON.stringify(modelLike.hands || { b: [], w: [] })),
      };
      this.lastMove = lastMove;
      this.selectedSq = null;
      this.selectedHand = null;
      this.render();
    }

    /** 王手格（数组，元素为格子名如 '5e'）；传空数组清除（§J2） */
    setCheck(squares) {
      this.checkSquares = Array.isArray(squares) ? squares.filter(Boolean) : [];
      this.render();
    }

    /** 单独更新上一步落点 */
    setLastMove(sq) {
      this.lastMove = sq || null;
      this.render();
    }

    /** 切换模式：'play' | 'demo-rules' | 'free' | 'review' */
    setMode(mode) {
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      this.selectedSq = null;
      this.selectedHand = null;
      this.ruleTargets = null;
      this.render();
    }

    startFrom(stateLike) {
      this.setModel(stateLike, stateLike.lastMove || null);
      this.history = [JSON.stringify(this.model)];
    }

    getSnapshot() {
      return { position: JSON.parse(JSON.stringify(this.model)), lastMove: this.lastMove };
    }

    // ---------- 模式/开关 ----------
    // setMode 见上方「装载」区（带 MODES 校验）
    setInteractive(v) {
      this.interactive = !!v;
      if (!this.interactive) { this.selectedSq = null; this.selectedHand = null; }
      this.render();
    }
    setLegalTargets(map) { this.legalTargetsBySq = map || {}; }
    setRuleContext(ctx) { this.setLegalTargets(ctx ? ctx.legalTargetsBySq || {} : {}); } // 兼容旧调用
    /** 设置当前手番（'b'|'w'）：非 free 模式下，非手番方的持驹不可选（打子符号与颜色无关，
     *  否则演示者/玩家可点对手驹台的同种棋子，视觉上像从对手驹台打入） */
    setTurn(color) { this.turnColor = (color === 'b' || color === 'w') ? color : null; }
    /**
     * 切换视角（'b'|'w'），PLAN §R1：观战者可在先手 / 后手视角间切换。
     *
     * 只翻转 `board.render` 的 viewpoint 与驹台配色——**不换 DOM、不重建监听**：
     * 下方驹台（`handsEls.my`）始终呈现“当前视角方”的持驹，所以只需交换
     * `myColor / oppColor` 两个标记（`render()` 用它们决定各自渲染谁的持驹）。
     * 若改为交换 DOM 元素，`bindHands` 闭包里捕获的 color 就会与元素错位。
     */
    setViewpoint(vp) {
      if (vp !== 'b' && vp !== 'w') return;
      if (this.viewpoint === vp) return;
      this.viewpoint = vp;
      if (this.handsEls) {
        const { my, myColor, opp, oppColor } = this.handsEls;
        this.handsEls = { my, myColor: oppColor, opp, oppColor: myColor };
        if (my) my.dataset.fbColor = oppColor;
        if (opp) opp.dataset.fbColor = myColor;
      }
      // 视角变了，选中状态必须清掉：否则残留的选中格/持驹属于另一视角
      this.selectedSq = null;
      this.selectedHand = null;
      if (this.model) this.render();
    }
    /** 驹台是否可选：review 模式一律不可选（只读浏览） */
    _canPickHand(color) {
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
    _dragEnabled() {
      if (!global.Settings) return true;
      if (global.Settings.get('dragToMove')) return true;
      return !(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
    }
    destroy() { this.detach(); this._removeGhost(); this.model = null; }
    attach() {
      this.board.boardEl.addEventListener('click', this._onClick);
      this.board.boardEl.addEventListener('dblclick', this._onDbl);
      this.board.boardEl.addEventListener('pointerdown', this._onPointerDown);
    }
    detach() {
      this.board.boardEl.removeEventListener('click', this._onClick);
      this.board.boardEl.removeEventListener('dblclick', this._onDbl);
      this.board.boardEl.removeEventListener('pointerdown', this._onPointerDown);
      document.removeEventListener('pointermove', this._onDocMove);
      document.removeEventListener('pointerup', this._onDocUp);
    }
    bindHands(myEl, myColor, oppEl, oppColor) {
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

    clearSelection() { this.selectedSq = null; this.selectedHand = null; this.render(); }

    // ---------- 选中/出招核心（模式间共享） ----------
    _selectFrom(sq) {
      const targets = this.legalTargetsBySq[sq];
      if (!targets) return false; // 该棋子当前不可动
      this.selectedSq = sq;
      this.selectedHand = null;
      this.render();
      return true;
    }

    _tryTarget(fromSq, toSq) {
      const targets = this.legalTargetsBySq[fromSq] || [];
      const t = targets.find((x) => x.to === toSq);
      if (!t) return false;
      this.selectedSq = null;
      const promote = targets.find((x) => x.to === toSq && x.promote);
      const non = targets.find((x) => x.to === toSq && !x.promote);
      if (promote && non && this.onPromoteChoice) {
        this.onPromoteChoice({ to: toSq, usiMove: non.usi, usiPromote: promote.usi });
      } else if (this.onMove) {
        this.onMove(t.usi);
      }
      return true;
    }

    _pickHand(color, piece, sym) {
      if (this.selectedHand && this.selectedHand.color === color && this.selectedHand.piece === piece) {
        this.selectedHand = null;
      } else {
        this.selectedHand = { color, piece, sym: sym || Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece) };
        this.selectedSq = null;
      }
      this.render();
    }

    // ---------- 点击流 ----------
    _handleClick(e) {
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
      if (!cell || !cell.dataset.sq) return;
      const sq = cell.dataset.sq;
      const [r, c] = sqToRC(sq);
      const cellPiece = this.model.board[r][c];

      if (this.mode === 'free') { this._freeClick(sq); return; }

      if (this.selectedHand) {
        if (this._tryTarget(this.selectedHand.sym, sq)) { this.selectedHand = null; this.render(); }
        return;
      }
      if (this.selectedSq && this.selectedSq !== sq) {
        if (this._tryTarget(this.selectedSq, sq)) { this.selectedSq = null; this.render(); return; }
      }
      if (this.selectedSq === sq) { this.selectedSq = null; this.render(); return; }
      if (cellPiece && cellPiece.piece) { this._selectFrom(sq); return; }
      this.selectedSq = null;
      this.render();
    }

    _handleDblClick(e) {
      if (!this.interactive || !this.model || this.mode !== 'free') return;
      const cell = e.target.closest('.cell');
      if (!cell || !cell.dataset.sq) return;
      this.togglePromote(cell.dataset.sq);
    }

    // ---------- 拖拽行棋（Pointer Events：鼠标/触屏通用） ----------
    _handlePointerDown(e) {
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

    _ensureGhost() {
      if (this._drag.ghost) return this._drag.ghost;
      const g = document.createElement('div');
      g.className = 'fb-drag-ghost';
      g.innerHTML = this._drag.ghostSrc;
      document.body.appendChild(g);
      this._drag.ghost = g;
      return g;
    }

    _handleDocMove(e) {
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
    _handleHandPointerDown(e, color) {
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

    _handleDocUp(e) {
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

    _removeGhost() {
      if (this._drag && this._drag.ghost) this._drag.ghost.remove();
      document.querySelectorAll('.fb-drag-ghost').forEach((g) => g.remove());
    }

    // ---------- free 模式操作 ----------
    _freeClick(sq) {
      const [r, c] = sqToRC(sq);
      const cell = this.model.board[r][c];
      if (this.selectedHand) {
        if (cell && cell.piece) return;
        this._drop(this.selectedHand.color, this.selectedHand.piece, sq);
        return;
      }
      if (this.selectedSq && this.selectedSq !== sq) { this._move(this.selectedSq, sq); return; }
      if (this.selectedSq === sq) { this.selectedSq = null; this.render(); return; }
      if (cell && cell.piece) { this.selectedSq = sq; this.render(); }
    }

    _move(fromSq, toSq) {
      const [fr, fc] = sqToRC(fromSq);
      const [tr, tc] = sqToRC(toSq);
      const piece = this.model.board[fr][fc];
      if (!piece) return;
      this._pushHistory();
      const target = this.model.board[tr][tc];
      if (target && target.piece) {
        // 被吃子还原为原始棋种（成駒 → 未成），统一走 rawOf（单一来源，防 J3 复发）
        this._addToHand(piece.color, rawOf(target.piece));
      }
      this.model.board[tr][tc] = { piece: piece.piece, color: piece.color, promoted: !!piece.promoted, sq: toSq };
      this.model.board[fr][fc] = null;
      this.selectedSq = null;
      this.lastMove = toSq;
      this._afterOp();
    }

    _drop(color, piece, sq) {
      const [r, c] = sqToRC(sq);
      if (this.model.board[r][c] && this.model.board[r][c].piece) return;
      this._pushHistory();
      const list = this.model.hands[color] || [];
      const idx = list.findIndex((h) => h.piece === piece);
      if (idx < 0) { this.history.pop(); return; }
      list[idx].count -= 1;
      if (list[idx].count <= 0) list.splice(idx, 1);
      this.model.board[r][c] = { piece, color, promoted: false, sq };
      this.selectedHand = null;
      this.lastMove = sq;
      this._afterOp();
    }

    togglePromote(sq) {
      const [r, c] = sqToRC(sq);
      const piece = this.model.board[r][c];
      if (!piece || !piece.piece) return;
      let next = null;
      if (PROMOTE[piece.piece]) next = { name: PROMOTE[piece.piece], promoted: true };
      else if (DEMOTE[piece.piece]) next = { name: DEMOTE[piece.piece], promoted: false };
      if (!next) return;
      this._pushHistory();
      piece.piece = next.name;
      piece.promoted = next.promoted;
      this._afterOp();
    }

    undo() {
      if (this.history.length <= 1) return false;
      this.history.pop();
      this.model = JSON.parse(this.history[this.history.length - 1]);
      this.selectedSq = null;
      this.selectedHand = null;
      this._afterOp();
      return true;
    }

    _pushHistory() {
      this.history.push(JSON.stringify(this.model));
      if (this.history.length > 200) this.history.shift();
    }

    _afterOp() {
      this.render();
      if (this.onChange) this.onChange(this.getSnapshot());
    }

    _addToHand(color, piece) {
      const list = this.model.hands[color] = this.model.hands[color] || [];
      const h = list.find((x) => x.piece === piece);
      if (h) h.count += 1;
      else list.push({ piece, count: 1 });
    }

    // ---------- 规则模式：合法 USI 应用到模型（推演乐观渲染/谱面重放） ----------
    applyUsi(usi, color) {
      if (!this.model) return;
      applyUsiOnModel(this.model, usi, color);
      const isDrop = /^([PLNSGBR])\*/.test(usi);
      this.lastMove = isDrop ? usi.slice(2) : usi.slice(2, 4);
    }

    // ---------- 渲染 ----------
    render() {
      if (!this.model) return;
      // §J2：check 此前从未传给 board.render，王手红格高亮一直不显示
      this.board.render(
        { board: this.model.board },
        { lastMove: this.lastMove, check: this.checkSquares },
        this.viewpoint
      );
      if (this.selectedSq) this.board.highlightSq(this.selectedSq, 'sel');
      const from = this.selectedHand ? this.selectedHand.sym : this.selectedSq;
      const targets = from ? (this.legalTargetsBySq[from] || []) : [];
      for (const t of targets) this.board.highlightSq(t.to, 'target');
      if (this.handsEls) {
        const pick = (color, sym) => (piece) => {
          if (!this.interactive) return;
          if (!this._canPickHand(color)) return; // 非手番方持驹禁选
          if (this.mode === 'free') { this._pickHand(color, piece); return; }
          const s = sym || Object.keys(DROP_NAME).find((k) => DROP_NAME[k] === piece);
          if (!s || !this.legalTargetsBySq[s]) return; // 该棋子无合法打点
          // 驹台点击走这里（棋盘容器不含驹台，_handleClick 的 hand 分支不可达）：
          // 再次点击同种持驹 = 放下（取消选中）；点击其他种类 = 切换选中
          this._pickHand(color, piece, s);
        };
        const vp = this.viewpoint;
        if (this.handsEls.opp) global.renderHands(this.handsEls.opp, this.model.hands, this.handsEls.oppColor, this.interactive ? pick(this.handsEls.oppColor) : null, vp);
        if (this.handsEls.my) global.renderHands(this.handsEls.my, this.model.hands, this.handsEls.myColor, this.interactive ? pick(this.handsEls.myColor) : null, vp);
      }
    }
  }

  /** 标准平手初始盘面模型（谱面浏览/重放用） */
  function initialModel() {
    const board = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => ({ piece: null, color: null, promoted: false, sq: `${c + 1}${String.fromCharCode(97 + r)}` })));
    const set = (r, c, piece, color) => { board[r][c] = { piece, color, promoted: false, sq: `${c + 1}${String.fromCharCode(97 + r)}` }; };
    const backW = ['香', '桂', '銀', '金', '玉', '金', '銀', '桂', '香'];
    for (let c = 0; c < 9; c++) { set(0, c, backW[c], 'w'); set(8, c, backW[c], 'b'); set(2, c, '歩', 'w'); set(6, c, '歩', 'b'); }
    set(1, 1, '角', 'w'); set(1, 7, '飛', 'w');
    set(7, 1, '飛', 'b'); set(7, 7, '角', 'b');
    return { board, hands: { b: [], w: [] } };
  }

  /**
   * 将一步合法 USI 应用到模型（纯结构变换：移动/吃子/打子/升变）。
   * color：该手的行棋方。规则已由服务端校验。
   */
  function applyUsiOnModel(model, usi, color) {
    const dropM = /^([PLNSGBR])\*([1-9])([a-i])$/.exec(usi);
    if (dropM) {
      const piece = DROP_NAME[dropM[1]];
      const sq = usi.slice(2);
      const [r, c] = sqToRC(sq);
      const list = model.hands[color] = model.hands[color] || [];
      const idx = list.findIndex((h) => h.piece === piece);
      if (idx >= 0) {
        list[idx].count -= 1;
        if (list[idx].count <= 0) list.splice(idx, 1);
      }
      model.board[r][c] = { piece, color, promoted: false, sq };
      return;
    }
    if (usi.length >= 4) {
      const fromSq = usi.slice(0, 2);
      const toSq = usi.slice(2, 4);
      const promote = usi[4] === '+';
      const [fr, fc] = sqToRC(fromSq);
      const [tr, tc] = sqToRC(toSq);
      const piece = model.board[fr][fc];
      if (!piece || !piece.piece) return;
      const target = model.board[tr][tc];
      if (target && target.piece) {
        const raw = rawOf(target.piece);
        const list = model.hands[color] = model.hands[color] || [];
        const h = list.find((x) => x.piece === raw);
        if (h) h.count += 1;
        else list.push({ piece: raw, count: 1 });
      }
      let name = piece.piece;
      let promoted = !!piece.promoted;
      if (promote) { name = PROMOTE[name] || name; promoted = true; }
      model.board[tr][tc] = { piece: name, color: piece.color, promoted, sq: toSq };
      model.board[fr][fc] = null;
    }
  }

  global.FreeBoard = FreeBoard;
  FreeBoard.initialModel = initialModel;
  FreeBoard.applyUsiOnModel = applyUsiOnModel;
  // 常量与纯函数导出：供单元测试直接加载断言（tests/，PLAN §P1）
  FreeBoard.MODES = MODES;
  FreeBoard.sqToRC = sqToRC;
  FreeBoard.PROMOTE = PROMOTE;
  FreeBoard.DEMOTE = DEMOTE;
  FreeBoard.DROP_NAME = DROP_NAME;
  FreeBoard.DRAG_THRESHOLD_MOUSE = DRAG_THRESHOLD_MOUSE;
  FreeBoard.DRAG_THRESHOLD_TOUCH = DRAG_THRESHOLD_TOUCH;
})(typeof window !== 'undefined' ? window : globalThis);
