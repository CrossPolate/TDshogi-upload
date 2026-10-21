/**
 * pieces.js — 棋子图片素材配置与渲染
 *
 * 使用你提供的自定义木棋子图集（kinki.png / ryoko.png）。
 * 每张图为 512×256、4 行 × 8 列网格，每格 64×64。
 *
 * 坐标布局（kinki.png / ryoko.png 通用）：
 *   row 0: 玉将 飛車 角行 金将 銀将 桂馬 香車 步兵  ← 先手未升变（正立）
 *   row 1: 玉将 龍王 龍馬 成金 成銀 成桂 成香 と   ← 先手成駒（正立）
 *   row 2: 玉将 飛車 角行 金将 銀将 桂馬 香車 步兵  ← 后手未升变（倒置）
 *   row 3: 玉将 龍王 龍馬 成金 成銀 成桂 成香 と   ← 后手成駒（倒置）
 *
 * 后手棋子整体旋转 180°（沿用 v1.1 设计；方向区分先手/后手）。
 *
 * 如果你提供的图集 cell 排列与此不一致，请直接调整下面的 PIECE_ATLAS 即可。
 */
(function () {
  'use strict';

  const CELL = 64;                 // 每格像素（512/8=64, 256/4=64）
  const COLS = 8;
  const ATLAS_DEFAULT = 'pieces/kinki.png';   // 默认先手（金棋楷书）
  const ATLAS_ALT = 'pieces/ryoko.png';        // 备用字体风格

  /**
   * 棋子素材集：kind → { row, col, promoted }
   *   row/col = 图集中的网格位置
   *   promoted = 是否成駒（用于选择 row 0/1 或 2/3）
   * 方向（先手/后手）由 caller 用 CSS transform rotate(180°) 表达。
   */
  const PIECE_ATLAS = {
    // 顺序：未升变 → 升变（与图集 row 0/1 一一对应）
    OU:  { kind: 'OU',  row: 0, col: 0 },   // 玉
    HI:  { kind: 'HI',  row: 0, col: 1 },   // 飛
    KA:  { kind: 'KA',  row: 0, col: 2 },   // 角
    KI:  { kind: 'KI',  row: 0, col: 3 },   // 金
    GI:  { kind: 'GI',  row: 0, col: 4 },   // 銀
    KE:  { kind: 'KE',  row: 0, col: 5 },   // 桂
    KY:  { kind: 'KY',  row: 0, col: 6 },   // 香
    FU:  { kind: 'FU',  row: 0, col: 7 },   // 歩
    // 成駒（row 1）：玉 龍 馬 成金 成銀 成桂 成香 と（与图集 row 1 一一对应）
    OU2: { kind: 'OU2', row: 1, col: 0 },   // 玉（成不变）
    RY:  { kind: 'RY',  row: 1, col: 1 },   // 龍（飛成）
    UM:  { kind: 'UM',  row: 1, col: 2 },   // 馬（角成）
    NG:  { kind: 'NG',  row: 1, col: 4 },   // 成銀（row1 col4；col3 是成金——错位会导致成銀显示成金将形）
    NY:  { kind: 'NY',  row: 1, col: 6 },   // 成香（row1 col6）
    NK:  { kind: 'NK',  row: 1, col: 5 },   // 成桂（row1 col5）
    TO:  { kind: 'TO',  row: 1, col: 7 },   // と（row1 col7）
  };

  /**
   * kind → 素材 row/col。
   * kinki.png / ryoko.png 的 row 0/1（先手未升变/成駒）是正立字。
   * 后手棋子统一用 row 0/1 的正立字，通过 transform:rotate(180) 决定方向（viewpoint）。
   * @param {string} kind
   * @param {boolean} promoted
   * @param {string} color（保留用于将来切换字体/图集）
   */
  function locate(kind, promoted, color) {
    const base = !promoted ? kind : ({ HI: 'RY', KA: 'UM', GI: 'NG', KE: 'NK', KY: 'NY', FU: 'TO', KI: 'KI', OU: 'OU2' })[kind] || kind;
    return PIECE_ATLAS[base] || PIECE_ATLAS.OU;
  }

  /**
   * 生成一枚棋子的 HTML（div + background-image）。
   * 棋子朝向由 viewpoint 决定：己方棋子正立，对方棋子旋转 180°（方向区分）。
   *
   * 缩放逻辑：背景图按显示尺寸等比缩放（background-size 宽 = 8×size），
   * position 偏移同样用 size 步长 → 每个显示格子恰好完整呈现一枚棋子且居中。
   * （旧实现 background-size 用原始 512px + 64px 偏移，而 div 只有 44-56px，
   *   导致棋子只显示左上部分、看起来偏离格心。）
   *
   * @param {object} opts { kind, color:'b'|'w', promoted, size, viewpoint:'b'|'w' }
   * @returns {string} HTML 字符串
   */
  function pieceHTML({ kind, color, promoted, size = 44, atlas = ATLAS_DEFAULT, viewpoint = 'b' }) {
    const cell = locate(kind, promoted, color);
    const x = -cell.col * size;
    const y = -cell.row * size;
    // 己方正立（不旋转），对方旋转 180°（朝下，方向区分）
    const isMine = color === viewpoint;
    const rotate = isMine ? '' : 'transform:rotate(180deg);';
    return `<div class="piece-img" style="width:${size}px;height:${size}px;background-image:url('${atlas}');background-position:${x}px ${y}px;background-size:${COLS * size}px auto;${rotate}"></div>`;
  }

  // 暴露全局
  window.PIECE_ATLAS = PIECE_ATLAS;
  window.PIECE_CELL = CELL;
  window.PIECE_COLS = COLS;
  window.PIECE_ATLAS_DEFAULT = ATLAS_DEFAULT;
  window.PIECE_ATLAS_ALT = ATLAS_ALT;
  window.pieceHTML = pieceHTML;
  window.locate = locate;
})();
