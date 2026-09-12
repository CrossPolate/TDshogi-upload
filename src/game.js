/**
 * game.js — 基于 shogi.js 的规则引擎封装（服务端权威判定）
 *
 * shogi.js 是底层库：getMovesFrom / getDropsBy 只做"伪合法"检查
 * （移动规则、二歩、打步死），但**不检查王手自杀**。因此本模块负责：
 *
 *  1. 王手过滤：对每个候选走法，在临时副本上模拟，若导致己方王被将则剔除。
 *  2. 升变候选：为每个 from→to 判断是否存在"成 / 不成"两种走法。
 *  3. 结果判定：王手、将死、千日手、入玉（持将棋）。
 *  4. 局面快照：输出前端渲染所需的统一结构。
 *
 * 对外只暴露 USI 走法字符串，前端不直接触碰 shogi.js。
 */
'use strict';

const { Shogi, Piece, Color, kindToString } = require('shogi.js');
const {
  usiSquareToXY, xyToUsiSquare, parseUsiMove, moveToUsi,
} = require('./coords');

const STARTING_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

// shogi.js Kind 与中文/英文名称、CSA 符号映射
const KIND_NAME = {
  FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金',
  KA: '角', HI: '飛', OU: '玉',
  TO: 'と', NY: '成香', NK: '成桂', NG: '成銀', UM: '馬', RY: '龍',
};
// 原始（未成）棋子 → 可用于打子的 CSA 符号
const RAW_TO_DROP = { FU: 'P', KY: 'L', KE: 'N', GI: 'S', KI: 'G', KA: 'B', HI: 'R' };
const DROP_TO_KIND = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' };

function cloneBoard(shi) {
  const s = new Shogi();
  s.initializeFromSFENString(shi.toSFENString());
  return s;
}

function findKing(shi, color) {
  for (let y = 1; y <= 9; y++) {
    for (let x = 1; x <= 9; x++) {
      const p = shi.get(x, y);
      if (p && p.kind === 'OU' && p.color === color) {
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * 判断在给定 Shogi 局面上，color 方走一步后是否合法（即己方王不被将）。
 * @param {Shogi} shi 局面
 * @param {import('./coords').UsiMove} mv 待验证走法
 */
function isMoveLegal(shi, mv) {
  const clone = cloneBoard(shi);
  try {
    if (mv.type === 'drop') {
      const to = usiSquareToXY(mv.to);
      clone.drop(to.x, to.y, DROP_TO_KIND[mv.piece]);
    } else {
      const from = usiSquareToXY(mv.from);
      const to = usiSquareToXY(mv.to);
      clone.move(from.x, from.y, to.x, to.y, mv.promote);
    }
  } catch (err) {
    return false;
  }
  // 走子/打子后 clone.turn 均已切换到对手 → 走子方自己的王 = oppositeColor(clone.turn)。
  // 修复：原打子分支误查 clone.turn（对手的王），导致「打入对方王周围构成打将」的
  // 合法着法（如金打王侧）被误判非法。打将是否成立由对方应对，不在此过滤。
  return !clone.isCheck(oppositeColor(clone.turn));
}

function oppositeColor(color) {
  return color === Color.Black ? Color.White : Color.Black;
}

/**
 * 从某格出发的候选走法（含升变两种情况）。
 * 返回 USI 数组。
 */
function candidateMovesFrom(shi, x, y, piece, legalOnly = true) {
  const out = [];
  const color = piece.color;
  const rawKind = Piece.unpromote(piece.kind);

  // 盘上移动
  for (const m of shi.getMovesFrom(x, y)) {
    const toSq = xyToUsiSquare(m.to.x, m.to.y);
    // 是否可能升变：棋子非玉、非金、且未成，且落点在其升变区域内
    const canPromote = rawKind !== 'OU' && rawKind !== 'KI' && !Piece.isPromoted(piece.kind)
      && inPromotionZone(m.to.y, color);
    if (canPromote) {
      const promoteMv = { type: 'move', from: xyToUsiSquare(x, y), to: toSq, promote: true };
      if (!legalOnly || isMoveLegal(shi, promoteMv)) out.push(moveToUsi(promoteMv));
      // 「不成」仅在非强制升变时提供（R-b）：歩/香到底线、桂到最下两段必须升变，
      // 否则会出现「选了不成、实际仍自动升变」的名不副实选项。
      if (!mustPromote(rawKind, m.to.y, color)) {
        const nonPromoteMv = { type: 'move', from: xyToUsiSquare(x, y), to: toSq, promote: false };
        if (!legalOnly || isMoveLegal(shi, nonPromoteMv)) out.push(moveToUsi(nonPromoteMv));
      }
    } else {
      const mv = { type: 'move', from: xyToUsiSquare(x, y), to: toSq, promote: false };
      if (!legalOnly || isMoveLegal(shi, mv)) out.push(moveToUsi(mv));
    }
  }
  return out;
}

function inPromotionZone(y, color) {
  // 先手（Black）推进方向是 y 减小（朝 9 段），升变区为 y<=3（1、2、3 行/段）
  // 后手（White）推进方向是 y 增大，升变区为 y>=7
  return color === Color.Black ? y <= 3 : y >= 7;
}

/**
 * 走到该位置后是否**必须升变**（不提供「不成」选项）。
 *
 * 依据（PLAN §P1-待确认 R-b，2026-09-10 用户确认）：
 * 歩 / 香 到达最底线、桂 到达最下两段时，未升变则该棋子再无任何合法移动，
 * 正式规则要求强制升变。shogi.js 的 `move(..., false)` 对这种情况会**静默自动升变**，
 * 因此若在此处仍提供「不成」，前端会显示一个名不副实的选项（选了实际还是升变）。
 *
 * @param {string} rawKind 升变前的棋种（FU/KY/KE/…）
 * @param {number} toY 目标格段号（1=最上段）
 * @param {Color} color 走子方
 */
function mustPromote(rawKind, toY, color) {
  const last = color === Color.Black ? 1 : 9; // 先手底线 y=1，后手底线 y=9
  if (rawKind === 'FU' || rawKind === 'KY') return toY === last;
  if (rawKind === 'KE') return color === Color.Black ? toY <= 2 : toY >= 8;
  return false;
}

class Game {
  constructor(startSfen = STARTING_SFEN, names = ['先手', '後手']) {
    this.startSfen = startSfen;
    this.names = names;
    this.shogi = new Shogi();
    try {
      this.shogi.initializeFromSFENString(startSfen);
    } catch (err) {
      this.shogi = new Shogi(); // 兜底回平手
    }
    this.moves = [];            // USI 走法历史
    this.result = null;         // 'b' | 'w' | '-' | null
    this.resultDetail = null;   // '詰み' | '投了' | '千日手' | '入玉' | null
    this.lastMove = null;       // 最近一手 USI
  }

  get turn() {
    return this.shogi.turn === Color.Black ? 'b' : 'w';
  }

  /**
   * 当前局面所有合法走法（USI 数组），已过滤王手自杀。
   */
  legalMovesUsi() {
    const out = [];
    const color = this.shogi.turn;
    for (let y = 1; y <= 9; y++) {
      for (let x = 1; x <= 9; x++) {
        const p = this.shogi.get(x, y);
        if (p && p.color === color) {
          out.push(...candidateMovesFrom(this.shogi, x, y, p));
        }
      }
    }
    // 打子
    for (const m of this.shogi.getDropsBy(color)) {
      const mv = { type: 'drop', piece: RAW_TO_DROP[Piece.unpromote(m.kind)], to: xyToUsiSquare(m.to.x, m.to.y) };
      if (isMoveLegal(this.shogi, mv)) out.push(moveToUsi(mv));
    }
    return out;
  }

  /**
   * 从某个起点（盘上格名 or 打子符号）出发的合法走法，用于前端高亮。
   * @param {string} from '7g' 或 'P'/'L'/...（打子符号）
   * @returns {{to:string, usi:string, promote:boolean, drop:boolean}[]}
   */
  legalTargets(from) {
    const color = this.shogi.turn;
    const out = [];
    // 打子：from 为打子符号（'P'/'L'/'N'/'S'/'G'/'B'/'R'），用 DROP_TO_KIND（符号→kind）判断
    if (from && from.length === 1 && from in DROP_TO_KIND) {
      const kind = DROP_TO_KIND[from];
      const dropMoves = this.shogi.getDropsBy(color).filter((m) => m.kind === kind);
      for (const m of dropMoves) {
        const mv = { type: 'drop', piece: from, to: xyToUsiSquare(m.to.x, m.to.y) };
        if (isMoveLegal(this.shogi, mv)) {
          out.push({ to: mv.to, usi: moveToUsi(mv), promote: false, drop: true });
        }
      }
      return out;
    }
    // 盘上移动
    let xy;
    try { xy = usiSquareToXY(from); } catch (_) { return out; }
    const piece = this.shogi.get(xy.x, xy.y);
    if (!piece || piece.color !== color) return out;
    for (const usi of candidateMovesFrom(this.shogi, xy.x, xy.y, piece)) {
      const parsed = parseUsiMove(usi);
      out.push({ to: parsed.to, usi, promote: parsed.promote, drop: false });
    }
    return out;
  }

  /**
   * 同一 from→to 是否同时存在"成/不成"两种走法。
   * @returns {string[]|null} [不成usi, 成usi] 或 null
   */
  promotionChoice(from, to) {
    const cands = this.legalTargets(from).filter((t) => t.to === to);
    const usis = cands.map((c) => c.usi);
    if (usis.length >= 2) return usis;
    return null;
  }

  /**
   * 执行一步走子。
   * @param {string} usi
   * @returns {{ok:boolean, error?:string}}
   */
  applyMove(usi) {
    let mv;
    try { mv = parseUsiMove(usi); } catch (_) { return { ok: false, error: '无法解析走法' }; }
    // 强制升变校验（R-b）：歩/香 到底线、桂 到最下两段时必须带 '+'。
    // 防御性校验——正常前端只会发候选走法（已过滤过），此处拦的是手工构造的 USI。
    if (mv.type === 'move' && !mv.promote) {
      const from = usiSquareToXY(mv.from);
      const to = usiSquareToXY(mv.to);
      const piece = this.shogi.get(from.x, from.y);
      if (piece && piece.color === this.shogi.turn
        && mustPromote(Piece.unpromote(piece.kind), to.y, piece.color)) {
        return { ok: false, error: '该棋子走到此位置必须升变' };
      }
    }
    // 合法性校验（含王手过滤）
    if (!isMoveLegal(this.shogi, mv)) {
      return { ok: false, error: '非法走法' };
    }
    try {
      if (mv.type === 'drop') {
        const to = usiSquareToXY(mv.to);
        this.shogi.drop(to.x, to.y, DROP_TO_KIND[mv.piece]);
      } else {
        const from = usiSquareToXY(mv.from);
        const to = usiSquareToXY(mv.to);
        this.shogi.move(from.x, from.y, to.x, to.y, mv.promote);
      }
    } catch (err) {
      return { ok: false, error: `走子失败: ${err.message}` };
    }
    this.moves.push(usi);
    this.lastMove = usi;
    this.updateResult();
    return { ok: true };
  }

  /**
   * 判定并更新结果。
   */
  updateResult() {
    const color = this.shogi.turn; // 当前轮到的一方
    const opp = oppositeColor(color);

    // 对方王被吃（不可能在合法棋中出现，纯兜底）
    if (!findKing(this.shogi, opp)) {
      this.result = color === Color.Black ? 'b' : 'w';
      this.resultDetail = '詰み';
      return;
    }
    // 己方王被吃（同上，纯兜底）
    if (!findKing(this.shogi, color)) {
      this.result = opp === Color.Black ? 'b' : 'w';
      this.resultDetail = '詰み';
      return;
    }

    // 无任何合法着法 → **当前方判负**（对手胜）：
    //  - 被将 = 詰み（将死）
    //  - 未被将却无步可走 = 困毙，同样判负（国际象棋才是和棋）
    // ⚠️ 困毙此前误判为和棋并记 '入玉'（PLAN §P1-待确认 R-a，2026-09-10 用户确认修正）
    if (this.legalMovesUsi().length === 0) {
      this.result = opp === Color.Black ? 'b' : 'w';
      this.resultDetail = this.shogi.isCheck(color) ? '詰み' : '困毙';
      return;
    }

    // 千日手（R-c）：普通千日手判和；**连续王手千日手判王手方负**
    const rep = this.detectRepetition();
    if (rep.repeated) {
      if (rep.perpCheckBy) {
        this.result = rep.perpCheckBy === 'b' ? 'w' : 'b';
        this.resultDetail = '連続王手の千日手';
      } else {
        this.result = '-';
        this.resultDetail = '千日手';
      }
      return;
    }

    this.result = null;
    this.resultDetail = null;
  }

  /**
   * 千日手判定（PLAN §P1-待确认 R-c，2026-09-10 用户确认按正式规则）。
   *
   * 局面 key 含手番与持驹（SFEN 去掉手数字段），同一 key 出现 4 次即千日手成立。
   * 在此基础上区分：
   *  - 这 4 次之间的走子里，**同一方每一步都在将军**（另一方不满足）→ 连续王手千日手
   *  - 否则为普通千日手
   *
   * @returns {{repeated:boolean, perpCheckBy:('b'|'w'|null)}} perpCheckBy = 连续王手的那一方
   */
  detectRepetition() {
    const replay = new Shogi();
    try {
      replay.initializeFromSFENString(this.startSfen);
    } catch (_) {
      return { repeated: false, perpCheckBy: null };
    }
    const keyOf = (shi) => shi.toSFENString().replace(/ \d+$/, ''); // 去掉手数字段
    const positions = new Map(); // key -> [{ index }]（出现位置）
    const steps = [];            // 第 i 步：{ mover, gaveCheck }
    positions.set(keyOf(replay), [{ index: 0 }]);

    for (let i = 0; i < this.moves.length; i++) {
      const mv = parseUsiMove(this.moves[i]);
      const mover = replay.turn === Color.Black ? 'b' : 'w';
      try {
        if (mv.type === 'drop') {
          const to = usiSquareToXY(mv.to);
          replay.drop(to.x, to.y, DROP_TO_KIND[mv.piece]);
        } else {
          const from = usiSquareToXY(mv.from);
          const to = usiSquareToXY(mv.to);
          replay.move(from.x, from.y, to.x, to.y, mv.promote);
        }
      } catch (_) {
        return { repeated: false, perpCheckBy: null };
      }
      // 走完后手番交给对方 → 对方若被将，说明这一步是将军
      const gaveCheck = replay.isCheck(replay.turn);
      steps.push({ mover, gaveCheck });
      const key = keyOf(replay);
      if (!positions.has(key)) positions.set(key, []);
      positions.get(key).push({ index: i + 1 });
    }

    for (const list of positions.values()) {
      if (list.length < 4) continue;
      const first = list[0].index;   // 首次出现（步数位置）
      const fourth = list[3].index;  // 第 4 次出现
      const movesBy = { b: 0, w: 0 };
      const checksBy = { b: 0, w: 0 };
      for (let i = first; i < fourth; i++) {
        const s = steps[i];
        if (!s) continue;
        movesBy[s.mover] += 1;
        if (s.gaveCheck) checksBy[s.mover] += 1;
      }
      const perpB = movesBy.b > 0 && checksBy.b === movesBy.b;
      const perpW = movesBy.w > 0 && checksBy.w === movesBy.w;
      // 仅当「一方每步都将军、另一方不是」才认定为连续王手；双方都满足（罕见）按普通千日手处理
      let perpCheckBy = null;
      if (perpB && !perpW) perpCheckBy = 'b';
      else if (perpW && !perpB) perpCheckBy = 'w';
      return { repeated: true, perpCheckBy };
    }
    return { repeated: false, perpCheckBy: null };
  }

  /**
   * 认输（当前手番方认输）。
   */
  resign() {
    const color = this.shogi.turn;
    this.result = color === Color.Black ? 'w' : 'b';
    this.resultDetail = '投了';
  }

  isGameOver() {
    return !!this.result;
  }

  /**
   * 输出统一局面快照，供前端渲染。
   * board: display[0]=9段(上) 左起9筋→1筋，元素 {piece, color, promoted, sq} 或 null
   */
  state() {
    const shi = this.shogi;
    const rows = [];
    for (let y = 1; y <= 9; y++) {       // y=1 最上段(9段)
      const row = [];
      for (let x = 1; x <= 9; x++) {     // x=1 1筋 ... x=9 9筋（需转成显示 9筋→1筋）
        const p = shi.get(x, y);
        const sq = xyToUsiSquare(x, y);
        if (p) {
          row.push({
            piece: KIND_NAME[p.kind],
            color: p.color === Color.Black ? 'b' : 'w',
            promoted: Piece.isPromoted(p.kind),
            sq,
          });
        } else {
          row.push({ piece: null, color: null, promoted: false, sq });
        }
      }
      rows.push(row);
    }
    return {
      sfen: shi.toSFENString(),
      turn: this.turn,
      board: rows,
      hands: this.hands(),
      moves: [...this.moves],
      check: shi.isCheck(shi.turn),
      result: this.result,
      resultDetail: this.resultDetail,
      lastMove: this.lastMove,
      names: this.names,
    };
  }

  /**
   * 持驹。
   * @returns {{b: {piece, count}[], w: {piece, count}[]}}
   */
  hands() {
    const out = { b: [], w: [] };
    for (const color of [Color.Black, Color.White]) {
      const key = color === Color.Black ? 'b' : 'w';
      const summary = this.shogi.getHandsSummary(color);
      // 展示顺序：飛角金銀桂香歩（对应 RAW_TO_DROP 顺序 R B G S N L P）
      for (const kind of ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU']) {
        const count = summary[kind] || 0;
        if (count > 0) {
          out[key].push({ piece: KIND_NAME[kind], count });
        }
      }
    }
    return out;
  }

  /**
   * 某一方当前是否王手。
   */
  isCheck() {
    return this.shogi.isCheck(this.shogi.turn);
  }

  /**
   * 入玉宣言（PLAN §P1 R-d；用户 2026-09-10 拍板 **AJSA / 27 点法**，对齐 81Dojo）。
   *
   * 条件（缺一不可）：
   *  1. 宣言方的玉在**敌阵**（先手 y≤3 上方三段，后手 y≥7 下方三段）
   *  2. 宣言方在**敌阵内**、除玉外的棋子 **≥10 枚**（持驹不算入这 10 枚）
   *  3. 点数 ≥ **先手 28 / 后手 27**（27 点法：先后手差 1 点以抵消先手优势）
   *  4. 必须轮到宣言方（自己手番）
   *  5. 宣言方**未被王手**
   *
   * ⚠️ 点数的**统计范围**是最容易搞错的一点——AJSA 只计这两部分：
   *   - ✅ 宣言方**在敌阵内**的棋子（不含玉）
   *   - ✅ 宣言方**持驹**
   *   - ❌ 敌阵**以外**的盘上棋子（自己半场 / 中央的棋子）**不计**
   *   大駒（飛角，含龍馬）5 点 / 其余 1 点；玉 0 点。
   *
   * 为什么必须是「敌阵内 + 持驹」：己方非玉棋子满员也只有 **27 点**，
   * 若只算盘上，先手的 28 点门槛**永远不可能达到**。而 28/27 的设计前提是
   * 「盘面总点数恒为 54、双方各 27」，超出 27 的部分只能来自吃掉的对方棋子（持驹）。
   *
   * @param {'b'|'w'} color 宣言方
   * @returns {{ok:boolean, reason?:string, points?:number, count?:number}}
   */
  canDeclareNyugyoku(color) {
    const shi = this.shogi;
    const col = color === 'b' ? Color.Black : Color.White;
    if (this.result) return { ok: false, reason: '对局已结束' };
    if (shi.turn !== col) return { ok: false, reason: '只能在自己的手番宣言' };
    if (shi.isCheck(col)) return { ok: false, reason: '被王手时不能宣言' };

    const king = findKing(shi, col);
    if (!king) return { ok: false, reason: '找不到玉' };
    // 敌阵：先手看 y≤3（上方三段），后手看 y≥7（下方三段）
    const inEnemyCamp = (y) => (col === Color.Black ? y <= 3 : y >= 7);
    if (!inEnemyCamp(king.y)) return { ok: false, reason: '玉还不在敌阵' };

    const score = (rawKind) => ((rawKind === 'HI' || rawKind === 'KA') ? 5 : 1);

    let inCamp = 0;  // 敌阵内、除玉外的己方棋子数（不含持驹）
    let points = 0;  // 点数 = 敌阵内己方棋子 + 持驹（**不含**敌阵以外的盘上棋子）
    for (let y = 1; y <= 9; y++) {
      for (let x = 1; x <= 9; x++) {
        const p = shi.get(x, y);
        if (!p || p.color !== col) continue;
        const raw = Piece.unpromote(p.kind); // 龍→HI、馬→KA、と→FU ……
        if (raw === 'OU') continue;          // 玉 0 点，也不计入枚数
        if (!inEnemyCamp(y)) continue;       // 敌阵以外的盘上棋子：既不计枚数也不计分
        inCamp++;
        points += score(raw);
      }
    }
    // 持驹：只计分，**不计入**「10 枚」（持驹不在敌阵内）
    const hand = shi.getHandsSummary(col) || {};
    for (const kind of Object.keys(hand)) {
      points += (hand[kind] || 0) * score(Piece.unpromote(kind));
    }

    if (inCamp < 10) {
      return { ok: false, reason: `敌阵内棋子需 10 枚以上（当前 ${inCamp}）`, points, count: inCamp };
    }
    const need = col === Color.Black ? 28 : 27;
    if (points < need) {
      return { ok: false, reason: `点数不足：先手需 28 / 后手需 27（当前 ${points}）`, points, count: inCamp };
    }
    return { ok: true, points, count: inCamp };
  }

  /**
   * 执行入玉宣言：满足条件则**宣言方获胜**（`resultDetail` 记「入玉宣言」）。
   * @param {'b'|'w'} color
   */
  declareNyugyoku(color) {
    const chk = this.canDeclareNyugyoku(color);
    if (!chk.ok) return { ok: false, error: chk.reason };
    this.result = color === 'b' ? 'b' : 'w';
    this.resultDetail = '入玉宣言';
    return { ok: true, result: this.result, detail: this.resultDetail, points: chk.points, count: chk.count };
  }
}

function newGame(startSfen = STARTING_SFEN, names = ['先手', '後手']) {
  return new Game(startSfen, names);
}

module.exports = {
  Game,
  newGame,
  STARTING_SFEN,
  KIND_NAME,
  kindToString,
};
