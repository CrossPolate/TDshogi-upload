/**
 * handicap.js — 駒落ち（让子）手合割表与初始局面生成（PLAN §D 玩法项）
 *
 * 让子局的规则要点（依据日本将棋连盟《6.実戦》「駒落ちの場合は、**必ず上手から指し始めます**」）：
 *
 *  - **上手**：实力强的一方，**落掉自己的若干棋子**；**下手**：用全部棋子的一方；
 *  - **上手先手**：让子局由上手先走（本模块据此把初始手番定为 `b`）；
 *  - 落掉的棋子**直接不存在**（不在盘上、不在驹台、也不算被吃）——所以生成初始局面时是
 *    「把这枚棋子从初形里拿掉」，而不是塞进谁的手里。
 *
 * 术语映射到本项目：**上手 = 座位 `b`，下手 = 座位 `w`**。
 * 这不是随便定的——它同时满足两件事，从而**不必改动"先手先行"的既有前提**
 * （走子判定 `seat.seat !== game.turn`、棋钟 `room.clock[game.turn]` 都按 `game.turn` 走，
 * 但把上手放在 `b` 可以省掉"白先"这一整类边界）：
 *   1. 上手先手 ⇒ 初始手番就是 SFEN 默认的 `b`；
 *   2. 落掉的棋子取自 `b` 的初形（`1i`/`2h`/… 那一侧）。
 * 因此 `createRoom` 在让子局里把房主固定为 `b`（平手局仍然随机执先手）。
 *
 * ⚠️ **已知待确认的约定**：传统上「**香落ち是例外，由下手先手**」（通称"香落ち下手先"）。
 * 连盟的入门页写的是"必ず上手から"、**未收录该例外**，故本模块按"一律上手先手"实现；
 * 若要改成例外，只需把对应条目的 `firstMover` 改成 `'w'`（局面其余部分不受影响）。
 */

'use strict';

const { STARTING_SFEN } = require('./game');

/** SFEN 盘面行的段顺序：`a` = 1 段（最上）… `i` = 9 段（最下） */
const RANK_ORDER = 'abcdefghi';

/**
 * 手合割表。
 *
 * `removed` 用 **USI 格名**（如 `9i`），且**以 `b`（上手）的初形为准**：
 *   - `9i`/`1i` = 上手的两枚香车，其中 **`9i` 是与上手角行（`8h`）同侧的那枚**，
 *     即 連盟 所说的「上手左侧（角のあるほう）の香」——所以 香落ち 落的是 `9i` 而不是 `1i`；
 *   - `8h` 角、`2h` 飛、`8i`/`2i` 桂、`7i`/`3i` 銀、`6i`/`4i` 金。
 *
 * ⚠️ **刻意不做三枚/五枚/七枚/九枚落ち**：这几种在各方资料里落子组合不一致
 * （尤其五枚落ち是"四枚+左桂"还是"四枚+双桂"说法不一），
 * 与其猜一个，不如只提供各来源一致的标准阶梯。
 */
const HANDICAPS = [
  {
    id: 'even',
    label: '平手',
    removed: [],
    hint: '不让子，双方均用全部棋子',
  },
  {
    id: 'lance',
    label: '香落ち',
    removed: ['9i'],
    hint: '上手落左香（与角同侧）。约 2 段差',
  },
  {
    id: 'lance-right',
    label: '右香落ち',
    removed: ['1i'],
    hint: '上手落右香。约 2 段差',
  },
  {
    id: 'bishop',
    label: '角落ち',
    removed: ['8h'],
    hint: '上手落角行。约 3 段差',
  },
  {
    id: 'rook',
    label: '飛車落ち',
    removed: ['2h'],
    hint: '上手落飞车。约 4 段差',
  },
  {
    id: 'rook-lance',
    label: '飛香落ち',
    removed: ['2h', '9i'],
    hint: '上手落飞车 + 左香。约 5 段差',
  },
  {
    id: 'two',
    label: '二枚落ち',
    removed: ['2h', '8h'],
    hint: '上手落飞车 + 角行。约 6~7 段差，最常用的让子',
  },
  {
    id: 'four',
    label: '四枚落ち',
    removed: ['2h', '8h', '9i', '1i'],
    hint: '二枚落ち + 双香。约 8~9 段差',
  },
  {
    id: 'six',
    label: '六枚落ち',
    removed: ['2h', '8h', '9i', '1i', '8i', '2i'],
    hint: '四枚落ち + 双桂。约 10 段差以上',
  },
  {
    id: 'eight',
    label: '八枚落ち',
    removed: ['2h', '8h', '9i', '1i', '8i', '2i', '7i', '3i'],
    hint: '六枚落ち + 双银（多用于入门指导）',
  },
  {
    id: 'ten',
    label: '十枚落ち',
    removed: ['2h', '8h', '9i', '1i', '8i', '2i', '7i', '3i', '6i', '4i'],
    hint: '八枚落ち + 双金：上手只剩玉与歩（入门指导用）',
  },
];

// ==================================================================
// SFEN 盘面字段的解析 / 序列化（只用到 `removed` 这一种修改，所以写最小实现）
// ==================================================================

/** `lnsgkgsnl/...` → 9 行 × 9 格；空格子为 `''`，其余为 `'P'` / `'+P'` 这类 token */
function parseBoardField(field) {
  return field.split('/').map((row) => {
    const cells = [];
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch >= '1' && ch <= '9') {
        for (let k = 0; k < Number(ch); k++) cells.push('');
      } else if (ch === '+') {
        cells.push('+' + row[++i]); // 成駒（本模块用不到，但解析要完整，否则遇到就静默错位）
      } else {
        cells.push(ch);
      }
    }
    if (cells.length !== 9) throw new Error(`SFEN 盘面行不是 9 格: ${row}`);
    return cells;
  });
}

/** 9 行 × 9 格 → `lnsgkgsnl/...`（空格子合并成数字） */
function serializeBoardField(rows) {
  return rows.map((cells) => {
    let out = '';
    let empty = 0;
    for (const c of cells) {
      if (!c) { empty++; continue; }
      if (empty) { out += String(empty); empty = 0; }
      out += c;
    }
    if (empty) out += String(empty);
    return out;
  }).join('/');
}

/** USI 格名 → 盘面下标；非法格名直接抛错（宁可 require 时就炸，也不要生成一个怪局面） */
function squareToIndex(sq) {
  const file = Number(sq[0]);
  const rank = RANK_ORDER.indexOf(sq[1]);
  if (!Number.isInteger(file) || file < 1 || file > 9 || rank < 0) {
    throw new Error(`非法格名: ${sq}`);
  }
  return { r: rank, c: 9 - file }; // 行内从左到右是 9 筋 → 1 筋
}

/**
 * 由手合割生成初始局面 SFEN。
 *
 * 只改两处：盘面（拿掉落子）与**手番**（`firstMover`，默认上手先手 = `b`）；
 * 持驹与手数沿用平手初形。
 */
function buildSfen(def) {
  const parts = STARTING_SFEN.split(' ');
  const rows = parseBoardField(parts[0]);
  for (const sq of def.removed) {
    const { r, c } = squareToIndex(sq);
    if (!rows[r][c]) {
      // 表里写了个空格子 → 是数据错误（比如坐标写错或与另一枚重了）。必须炸，不能当没事发生：
      // 否则生成出的局面"看起来正常"，只是少了一枚不该少的棋子。
      throw new Error(`手合割 ${def.id} 的落点 ${sq} 原本就是空格`);
    }
    rows[r][c] = '';
  }
  parts[0] = serializeBoardField(rows);
  parts[1] = def.firstMover || 'b';
  return parts.join(' ');
}

// 模块加载时就把每个条目的局面算好并校验：数据表写错立刻暴露，而不是等到建房时才炸。
const BY_ID = new Map();
for (const def of HANDICAPS) {
  const entry = Object.assign({}, def, {
    firstMover: def.firstMover || 'b',
    startSfen: buildSfen(def),
  });
  BY_ID.set(entry.id, entry);
}

/** 全部条目（供前端下拉；含 平手 一项） */
function list() {
  return HANDICAPS.map((d) => BY_ID.get(d.id));
}

/** 按 id 取条目；未知返回 null */
function get(id) {
  if (!id) return null;
  return BY_ID.get(String(id)) || null;
}

/**
 * 归一化前端传来的手合割：空 / `'even'` / 平手 → `null`（表示"不让子"）。
 * 未知 id 返回 `false`（调用方据此拒绝），与 `null` 区分开。
 */
function normalize(id) {
  if (id == null || id === '' || id === 'even' || id === '平手') return null;
  return get(id) || false;
}

module.exports = {
  HANDICAPS,
  list,
  get,
  normalize,
  buildSfen,      // 导出给测试用（表里的 startSfen 就是它算的）
  parseBoardField,
  serializeBoardField,
};
