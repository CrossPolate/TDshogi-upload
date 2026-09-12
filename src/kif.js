/**
 * kif.js — KIF 棋谱解析器（纯 JS，导入日本标准 KIF 棋谱）
 *
 * 支持解析真实职业棋谱（如参考项目 data/records/*.kif）：
 *  - 头部字段：手合割 / 先手 / 後手 / 開始日時 / 表題 等
 *  - 走法行：日式记谱「７六歩(77)」「同　銀(33)」「２二角成(88)」「８八角打」
 *  - 结果行：までN手でXXの勝ち / 投了 / 千日手 / 持将棋
 *
 * 输出：{ names, startSfen, moves(USI 列表), result:'b'|'w'|'-', resultDetail }
 */
'use strict';

const { Shogi, Color } = require('shogi.js');
const { usiSquareToXY, parseUsiMove } = require('./coords');

// 打子符号 → shogi.js kind
const DROP_TO_KIND = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' };

const FULL_WIDTH = '１２３４５６７８９';
const KANJI_NUM = '一二三四五六七八九';
const DEFAULT_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

// 棋子中文名 → shogi.js kind（未成 / 成子）
const PIECE_NAME_TO_KIND = {
  '歩': 'FU', '香': 'KY', '桂': 'KE', '銀': 'GI', '金': 'KI',
  '角': 'KA', '飛': 'HI', '王': 'OU', '玉': 'OU',
  'と': 'TO', '杏': 'NY', '圭': 'NK', '全': 'NG', '馬': 'UM', '龍': 'RY', '竜': 'RY',
  '成香': 'NY', '成桂': 'NK', '成銀': 'NG', // 真实 KIF 也常写作成香/成桂/成銀
};

function parseFullToNum(c) {
  return FULL_WIDTH.indexOf(c) + 1; // 0 表示未找到
}
function parseKanjiToSeg(c) {
  return KANJI_NUM.indexOf(c) + 1;  // 段1~9；0 未找到
}

/**
 * 解析走法行正文（不含行首手数、消费时间）→ USI 走法。
 * @param {string} body 如 '７六歩(77)' / '同　銀(33)' / '８八角打'
 * @param {object} ctx { turnColor, lastToXY, board }
 * @returns {string} USI 走法
 */
function parseMoveLine(body, ctx) {
  // 提取来源坐标 (77)
  const fromMatch = /\(([1-9][1-9])\)$/.exec(body);
  let body2 = body;
  let fromXY = null;
  if (fromMatch) {
    const fs = parseInt(fromMatch[1][0], 10);
    const seg = parseInt(fromMatch[1][1], 10);
    fromXY = { x: fs, y: seg };
    body2 = body.slice(0, fromMatch.index).trim();
  }
  // 升变标记（去掉来源后的尾巴 "成"）
  let promote = false;
  if (/成$/.test(body2)) {
    promote = true;
    body2 = body2.replace(/成$/, '');
  }
  // 打子标记（去掉来源后的尾巴 "打"）
  let isDrop = false;
  if (/打$/.test(body2)) {
    isDrop = true;
    body2 = body2.replace(/打$/, '');
  }

  let toXY;
  let pieceName;

  if (/^同/.test(body2)) {
    // 同：到着点 = 前一手到着点
    if (!ctx.lastToXY) throw new Error('“同”出现但无前一着');
    toXY = ctx.lastToXY;
    // 棋子名 = body 去掉“同”后的部分（含空格）
    const after = body2.replace(/^同\s*/, '');
    pieceName = after;
  } else {
    // 形如 ７六歩：筋全角 + 段汉字 + 棋子名
    const m = /^([１２３４５６７８９])([一二三四五六七八九])(.+)$/.exec(body2);
    if (!m) throw new Error(`无法解析走法: ${body}`);
    const file = parseFullToNum(m[1]);
    const seg = parseKanjiToSeg(m[2]);
    if (!file || !seg) throw new Error(`坐标非法: ${body}`);
    toXY = { x: file, y: seg };
    pieceName = m[3];
  }

  // 棋子类型
  const kind = PIECE_NAME_TO_KIND[pieceName.trim()];
  if (!kind) throw new Error(`未知棋子: ${pieceName}`);

  // 打子：来源坐标不存在 或 标记"打"
  if (isDrop || !fromXY) {
    const dropChar = kindToDropChar(kind);
    const toUsi = `${toXY.x}${String.fromCharCode(96 + toXY.y)}`;
    return `${dropChar}*${toUsi}`;
  }

  // 盘上移动
  const fromUsi = `${fromXY.x}${String.fromCharCode(96 + fromXY.y)}`;
  const toUsi = `${toXY.x}${String.fromCharCode(96 + toXY.y)}`;
  return `${fromUsi}${toUsi}${promote ? '+' : ''}`;
}

function kindToDropChar(kind) {
  const map = { FU: 'P', KY: 'L', KE: 'N', GI: 'S', KI: 'G', KA: 'B', HI: 'R' };
  return map[kind] || 'P';
}

/**
 * 解析完整 KIF 文本。
 * @param {string} text
 * @returns {object}
 */
function parseKif(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let startSfen = DEFAULT_SFEN;
  let names = ['先手', '後手'];
  let inMoves = false;
  let moves = [];
  let lastToXY = null;
  let result = null;
  let resultDetail = null;

  // 用 shogi.js 维护局面以确认合法性（也用于 color 轮换）
  const board = new Shogi();
  board.initializeFromSFENString(startSfen);
  let turnColor = Color.Black;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 头部字段
    if (!inMoves) {
      if (line.startsWith('手合割')) {
        const v = line.split('：')[1] || line.split(':')[1] || '';
        if (v.trim() !== '平手') {
          // 非平手暂不支持（駒落ち），抛出但允许继续？此处抛错提示
          throw new Error(`暂不支持非平手棋谱（手合割：${v}）`);
        }
        continue;
      }
      if (line.startsWith('先手')) { names[0] = (line.split('：')[1] || line.split(':')[1] || '').trim(); continue; }
      if (line.startsWith('後手')) { names[1] = (line.split('：')[1] || line.split(':')[1] || '').trim(); continue; }
      if (line.includes('手数') && line.includes('指手')) { inMoves = true; continue; }
      if (line.startsWith('*')) continue; // 头注释
      continue;
    }

    // 走法段
    if (line.startsWith('*')) continue; // 注释
    if (/^投了/.test(line)) { result = turnColor === Color.Black ? 'w' : 'b'; resultDetail = '投了'; continue; }
    if (/^千日手/.test(line)) { result = '-'; resultDetail = '千日手'; continue; }
    if (/^持将棋/.test(line)) { result = '-'; resultDetail = '持将棋'; continue; }
    if (/^まで/.test(line)) {
      const m = /まで(\d+)手で(.+)の勝ち/.exec(line);
      if (m) {
        const winner = m[2];
        result = winner === names[0] ? 'b' : 'w';
        resultDetail = '投了';
      }
      continue;
    }
    // 走法行：手数 + 记谱 + 消费时间
    const moveLine = line.replace(/^(\d+)\s+/, '').replace(/\s+\([\s\d:/]+\)\s*$/, '').trim();
    if (!moveLine) continue;
    try {
      const usi = parseMoveLine(moveLine, { turnColor, lastToXY, board });
      // 校验走法在 shogi.js 中可执行
      const mv = parseUsiMove(usi);
      applyMove(board, mv);
      moves.push(usi);
      // lastToXY：目标格（供下一手“同”使用）
      const toPart = usi.slice(2, 4);
      lastToXY = usiSquareToXY(toPart);
      turnColor = board.turn;
    } catch (e) {
      // 解析/校验失败：跳过该行（容忍注释/杂项），但记谱错误应可感知
      // 仅对看起来像走法的行抛错
      if (/^[１２３４５６７８９同]/.test(moveLine)) throw new Error(`第 ${moves.length + 1} 手解析失败: ${moveLine} (${e.message})`);
    }
  }

  return { names, startSfen, moves, result, resultDetail };
}

function applyMove(board, mv) {
  if (mv.type === 'drop') {
    const to = usiSquareToXY(mv.to);
    board.drop(to.x, to.y, DROP_TO_KIND[mv.piece]);
  } else {
    const from = usiSquareToXY(mv.from);
    const to = usiSquareToXY(mv.to);
    board.move(from.x, from.y, to.x, to.y, mv.promote);
  }
}

module.exports = { parseKif, parseMoveLine };
