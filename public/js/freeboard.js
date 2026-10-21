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
      this.danger = false;           // §U2：读秒 ≤10 秒的红色外框（由 play.js 判定后设置）
      this._onClick = (e) => this._handleClick(e);
      this._onDbl = (e) => this._handleDblClick(e);
      this._onPointerDown = (e) => this._handlePointerDown(e);
      this._onKey = (e) => this._handleKeydown(e);
      this._drag = null;
      this._onViewport = null;
      this._bindViewport();
    }

    /**
     * 视口变化（横竖屏旋转 / 窗口缩放）后重绘棋盘（PLAN §D）。
     *
     * ⚠️ **为什么必须补这个监听**：`render()` 只在"走子 / 装载局面"时被调用，
     * 而**旋转屏幕并不会走子**——不补的话，手机上转屏后棋盘会停在旧尺寸
     *（表现为错位、溢出、格子大小不匀）。
     *
     * 节流到 150ms：`resize` 是连续事件，而每次 `render()` 都要重建整棵树。
     */
    _bindViewport() {
      const g = (typeof window !== 'undefined') ? window : null;
      if (!g || !g.addEventListener) return;
      let timer = null;
      this._onViewport = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (this.model) this.render();
        }, 150);
      };
      g.addEventListener('resize', this._onViewport);
      g.addEventListener('orientationchange', this._onViewport);
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

    /**
     * 危险状态（PLAN §U2）：读秒 ≤10 秒时给棋盘**外框**加红。
     *
     * ⚠️ 只负责"贴不贴 class"，**不判断该不该红**——调用方必须自行排除观战者。
     * 需求明确要求观战者不显示红框，而本组件在观战与对局两种情形下长得完全一样，
     * 无从区分（`PlayClock.isDanger()` 的注释写了同一条边界）。
     *
     * 用 class 而非重建 DOM：外框是**静态容器**，重建会打断过渡动画；
     * 何况 `render()` 每次走子都会跑，重建外框纯属浪费。
     */
    setDanger(on) {
      this.danger = !!on;
      this._applyDanger();
    }

    /** 把危险态贴到容器上（`render()` 末尾也调一次，防止容器被重建后标记丢失） */
    _applyDanger() {
      if (this.board && this.board.boardEl) {
        this.board.boardEl.classList.toggle('fb-danger', !!this.danger);
      }
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

    /**
     * 读某格的棋子（返回**副本**；空格 / 越界返回 null）。
     *
     * ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 最小读取 API。
     * 面板需要「这一格现在是什么子、属于哪一方、成没成」，而不该自己去做 r/c 换算、
     * 也不该直接摸 `model.board`（此前外部若直接改模型，会绕过撤销栈与重绘）。
     * @param {string} sq 格名（如 '5e'）
     * @returns {{piece:string, color:string, promoted:boolean, sq:string}|null}
     */
    getSquare(sq) {
      if (!this.model || !sq) return null;
      const [r, c] = sqToRC(sq);
      const row = this.model.board[r];
      const p = row ? row[c] : null;
      if (!p || !p.piece) return null;
      return { piece: p.piece, color: p.color, promoted: !!p.promoted, sq: p.sq || sq };
    }

    /**
     * 就地写入某格的棋子（`null` = 清空该格），压撤销栈后重绘。
     *
     * ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 最小写入 API。
     * 面板的「换棋种 / 翻转归属 / 清空该格」三件事**全部**走这里，理由是它复用了
     * `_pushHistory` + `_afterOp`，与既有 `_move` / `_drop` / `togglePromote` 是同一条
     * 落库与重绘链路 —— 于是「撤销摆放」(Ctrl+Z) 自然能回退面板的编辑，也无需新增渲染逻辑。
     * `color` 是模型里真实存在的归属字段（`board.js` 渲染时按 `piece.color` 决定棋子朝向），
     * 所以调用方可以真的翻转先手/后手，而不是只做一个视觉假象。
     * @param {string} sq 格名
     * @param {{piece:string, color:'b'|'w', promoted:boolean}|null} piece
     * @returns {boolean} 是否写入成功
     */
    setSquare(sq, piece) {
      if (!this.model || !sq) return false;
      const [r, c] = sqToRC(sq);
      if (!this.model.board[r]) return false;
      this._pushHistory();
      this.model.board[r][c] = piece
        ? { piece: piece.piece, color: piece.color, promoted: !!piece.promoted, sq }
        : null;
      this.selectedSq = sq;  // 编辑后保持该格选中：#freePalette 面板继续作用在同一格
      this.lastMove = null;  // 手工编辑不是「上一步」，清掉落点高亮以免误读
      this._afterOp();
      return true;
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
    /** 卸载：解除 resize/orientationchange 监听、detach 棋盘事件、移除幽灵元素并清空局面。
     *  ⚠️ 2026-10-02 审查 P3：类内原有**两个** destroy()，后者覆盖前者 → 前者的
     *  resize/orientationchange 卸载逻辑成了死代码、监听永不解除。已把两部分合并进这份，
     *  并删除被覆盖的那份（此前约 :92），类内现仅此一个 destroy()。 */
    destroy() {
      const g = (typeof window !== 'undefined') ? window : null;
      if (g && g.removeEventListener && this._onViewport) {
        g.removeEventListener('resize', this._onViewport);
        g.removeEventListener('orientationchange', this._onViewport);
      }
      this._onViewport = null;
      this.detach();
      this._removeGhost();
      this.model = null;
    }
    attach() {
      // ⚠️ 2026-10-02 体验修复：加幂等保护。attach() 此前无任何状态标记，一旦被调用两次
      //（同一 FreeBoard 复用 / 重复装配），`keydown` 会被挂上两个**相同**处理器，
      // 于是按一次方向键或 Enter 就触发两次走子（等于走两步 / 选中被瞬间取消）。
      // 这里用 _attached 兜底，保证四种监听（click/dblclick/pointerdown/keydown）只绑一次。
      if (this._attached) return;
      this._attached = true;
      const el = this.board.boardEl;
      // §6.3：棋盘是**可聚焦的 grid 部件**——Tab 能进来，方向键移格、Enter 走子、Esc 取消。
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'grid');
      el.setAttribute('aria-label', '将棋盘：方向键移动，Enter 选择或落子，Esc 取消');
      el.addEventListener('click', this._onClick);
      el.addEventListener('dblclick', this._onDbl);
      el.addEventListener('pointerdown', this._onPointerDown);
      el.addEventListener('keydown', this._onKey);
    }
    detach() {
      this._attached = false; // 复位：允许 detach 后再次 attach（不残留半绑定状态）
      this.board.boardEl.removeEventListener('click', this._onClick);
      this.board.boardEl.removeEventListener('dblclick', this._onDbl);
      this.board.boardEl.removeEventListener('pointerdown', this._onPointerDown);
      this.board.boardEl.removeEventListener('keydown', this._onKey);
      document.removeEventListener('pointermove', this._onDocMove);
      document.removeEventListener('pointerup', this._onDocUp);
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
      // ⚠️ 2026-10-02 体验修复：驹台（持驹）选中态高亮。此前 selectedHand 只用来点亮棋盘打点，
      // 驹台本身没有任何视觉反馈——玩家点了自己的持驹却看不出"已选中、接下来点棋盘落子"。
      // renderHands 每次都重建 .hand-piece 节点（内联样式随之清空），故在其后按选中信息补高亮。
      if (this.selectedHand) {
        const held = this.selectedHand;
        const container = (this.handsEls && this.handsEls.myColor === held.color) ? this.handsEls.my
          : (this.handsEls && this.handsEls.oppColor === held.color) ? this.handsEls.opp : null;
        if (container && container.querySelector) {
          const sel = container.querySelector('.hand-piece[data-piece="' + held.piece + '"]');
          if (sel) {
            sel.classList.add('hand-sel');
            sel.style.outline = '3px solid var(--gold, #c9a227)';
            sel.style.outlineOffset = '2px';
            sel.style.borderRadius = '6px';
            sel.style.background = 'rgba(201, 162, 39, 0.30)';
          }
        }
      }
      this._applyDanger(); // §U2：棋盘重建后重新贴危险外框
    }
  }

  // ==================================================================
  // §M5（2026-09-28）：输入交互层（点选/点击/拖拽）已拆到 freeboard-dnd.js
  // ==================================================================
  // ⚠️ 该文件必须在本文件**之前**加载（见 public/play.html、public/review.html 的
  // <script> 顺序）。缺了就当场抛错——否则症状会是"棋盘点了没反应"这种**静默**故障
  // （页面照常渲染、控制台连红字都没有），排查成本极高。
  if (!global.FreeBoardDnd) {
    throw new Error('freeboard-dnd.js 必须在 freeboard.js 之前加载（<script> 顺序错了）');
  }
  Object.assign(FreeBoard.prototype, global.FreeBoardDnd.make({
    sqToRC, DROP_NAME, DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH,
  }));

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
