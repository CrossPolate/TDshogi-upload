/**
 * coords.js — USI 坐标 与 shogi.js 内部 (x, y) 坐标的转换工具
 *
 * 经实测确认（shogi.js 5.4）：
 *  - shogi.js 内部 board[x][y]，x∈[1,9] 为筋（1=1筋…9=9筋），y∈[1,9] 为段
 *    其中 y=1 对应最上段（9段，后手侧），y=9 对应最下段（1段，先手侧）。
 *  - USI 记法 "7g"：file=7（7筋）、rank 字母 a~i 对应段 9→1
 *    （a=9段, b=8段, …, i=1段），rank 序号 = 10 - 段数字。
 *
 * 转换关系：
 *  - x = file（直接相等）
 *  - y = 10 - 段数字（段数字：1段=1 … 9段=9）
 *  - rank 字母序号 n（a=1..i=9）满足：段数字 = 10 - n，y = n
 *
 * 即：rankChar 'a'..'i' → y = (charCode - 'a') + 1
 */
'use strict';

// rank 字母 → y 坐标（a=1 ... i=9）
function rankCharToY(rankChar) {
  const n = rankChar.charCodeAt(0) - 97; // a=0 ... i=8
  return n + 1;
}

// y 坐标 → rank 字母
function yToRankChar(y) {
  return String.fromCharCode(97 + (y - 1)); // a ... i
}

/**
 * USI 格子名 "7g" → { x, y }
 * @param {string} sq e.g. "7g"
 * @returns {{x:number, y:number}}
 */
function usiSquareToXY(sq) {
  if (!/^[1-9][a-i]$/.test(sq)) throw new Error(`非法格子名: ${sq}`);
  const file = parseInt(sq[0], 10);
  const y = rankCharToY(sq[1]);
  return { x: file, y };
}

/**
 * { x, y } → USI 格子名 "7g"
 */
function xyToUsiSquare(x, y) {
  if (x < 1 || x > 9 || y < 1 || y > 9) throw new Error(`非法坐标: ${x},${y}`);
  return `${x}${yToRankChar(y)}`;
}

/**
 * USI 走法字符串 → 结构化对象
 * 支持： "7g7f"（移动）、"8h2b+"（升变移动）、"P*5e"（打子）
 * @returns {{type:'move'|'drop', from?:string, to:string, promote:boolean, piece?:string}}
 */
function parseUsiMove(usi) {
  // 打子：P*5e
  const dropMatch = /^([P,L,N,S,G,B,R])\*([1-9][a-i])$/.exec(usi);
  if (dropMatch) {
    return { type: 'drop', piece: dropMatch[1], to: dropMatch[2], promote: false };
  }
  // 移动：7g7f 或 7g7f+
  const moveMatch = /^([1-9][a-i])([1-9][a-i])(\+?)$/.exec(usi);
  if (moveMatch) {
    return {
      type: 'move',
      from: moveMatch[1],
      to: moveMatch[2],
      promote: moveMatch[3] === '+',
    };
  }
  throw new Error(`非法走法: ${usi}`);
}

/**
 * 结构化走法 → USI 字符串
 * @param {{type:'move'|'drop', from?:string, to:string, promote?:boolean, piece?:string}} mv
 */
function moveToUsi(mv) {
  if (mv.type === 'drop') {
    return `${mv.piece}*${mv.to}`;
  }
  return `${mv.from}${mv.to}${mv.promote ? '+' : ''}`;
}

module.exports = {
  rankCharToY,
  yToRankChar,
  usiSquareToXY,
  xyToUsiSquare,
  parseUsiMove,
  moveToUsi,
};
