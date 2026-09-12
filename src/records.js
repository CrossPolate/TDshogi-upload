/**
 * records.js — 棋谱：JSON 落盘 + 历史列表 + 日本标准 KIF/CSA 导出
 *
 * KIF / CSA 严格遵循日本业内标准格式，判定原理对照参考项目 record.py 重写为 JS 版：
 *
 *  - KIF：`Kifu for Windows` 头、`手合割：平手`、`先手/後手`、
 *    `手数----指手` 表头、日式记谱「７六歩(77)」「同　銀(33)」「２二角成(88)」「８八角打」、
 *    结果「までN手で○○の勝ち」。
 *  - CSA：`V2.2` 头、`N+/N-`、`P1~P9` 盘面、持驹、手番、走法行 `+776FU`、结果 `%TORYO/%TSUMI/%SENNICHITE`。
 */
'use strict';

const { Shogi, Color } = require('shogi.js');
const {
  putRecord, getRecordById,
  listRecords: dbListRecords,
  listSummaries: dbListSummaries,
  searchRecords: dbSearch,
} = require('./storage');
const { parseUsiMove, usiSquareToXY } = require('./coords');
const { KIND_NAME } = require('./game');

// 打子符号 → shogi.js kind（本地定义，game.js 不导出）
const DROP_TO_KIND = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' };

const FULL_WIDTH = '１２３４５６７８９';
const KANJI_NUM = '一二三四五六七八九';

// rank 字母 a~i 对应段 1~9（a=1段最上, i=9段最下，标准 USI / 日本将棋记谱）
// shogi.js 的 y 坐标即段号（y=1=段1最上）
function rankCharToSegment(rankChar) {
  return rankChar.charCodeAt(0) - 96; // a->1, i->9
}
function fileToFull(file) {
  return FULL_WIDTH[parseInt(file, 10) - 1];
}
function segmentToKanji(seg) {
  return KANJI_NUM[seg - 1];
}
// USI 格 '7g' -> 日式坐标 '76'（筋+段，如 7筋7段=77）
function usiToJpCoord(sq) {
  const file = parseInt(sq[0], 10);
  const seg = rankCharToSegment(sq[1]);
  return `${file}${seg}`;
}
// USI 格 '7g' -> CSA 坐标 '76'
function usiToCsaCoord(sq) {
  return usiToJpCoord(sq);
}

const CSA_PIECE = {
  FU: 'FU', KY: 'KY', KE: 'KE', GI: 'GI', KI: 'KI',
  KA: 'KA', HI: 'HI', OU: 'OU', TO: 'TO', NY: 'NY',
  NK: 'NK', NG: 'NG', UM: 'UM', RY: 'RY',
};
const PROMOTED_MAP = { KY: 'NY', KE: 'NK', GI: 'NG', KA: 'UM', HI: 'RY' };

/**
 * 在 board 上执行一步走子（仅推进用）。
 */
function applyMoveOn(board, mv) {
  if (mv.type === 'drop') {
    const to = usiSquareToXY(mv.to);
    board.drop(to.x, to.y, DROP_TO_KIND[mv.piece]);
  } else {
    const from = usiSquareToXY(mv.from);
    const to = usiSquareToXY(mv.to);
    board.move(from.x, from.y, to.x, to.y, mv.promote);
  }
}

/**
 * 走法历史 -> 逐手 KIF 记谱（含来源日式坐标）。
 */
function movesToKif(sfen, moves) {
  const board = new Shogi();
  board.initializeFromSFENString(sfen);
  const out = [];
  let lastTo = null;
  for (const usi of moves) {
    const mv = parseUsiMove(usi);
    out.push(moveToKif(board, mv, lastTo));
    applyMoveOn(board, mv);
    lastTo = mv.to;
  }
  return out;
}

function moveToKif(board, mv, lastTo) {
  const xFull = fileToFull(mv.to[0]);
  const yKanji = segmentToKanji(rankCharToSegment(mv.to[1]));
  if (mv.type === 'drop') {
    return `${xFull}${yKanji}${KIND_NAME[DROP_TO_KIND[mv.piece]]}打`;
  }
  // 盘上移动：来源棋子类型从 board 读
  const from = usiSquareToXY(mv.from);
  const pieceKind = board.get(from.x, from.y).kind;
  const piece = KIND_NAME[pieceKind];
  const head = lastTo === mv.to ? `同　${piece}` : `${xFull}${yKanji}${piece}`;
  if (mv.promote) return `${head}成(${usiToJpCoord(mv.from)})`;
  return `${head}(${usiToJpCoord(mv.from)})`;
}

// ======================================================================
// JSON 落盘 / 历史列表
// ======================================================================

let recordSeq = 0;

/**
 * 保存一局棋谱（JSON），返回记录对象。
 */
function saveRecord(data) {
  recordSeq += 1;
  const now = Date.now();
  const id = `${now.toString(36)}${recordSeq.toString(36)}`;
  const record = {
    id,
    startSfen: data.startSfen,
    moves: data.moves || [],
    moveTimes: data.moveTimes || [],   // 每手耗时（秒）——KIF 消費時間
    names: data.names || ['先手', '後手'],
    result: data.result,
    resultDetail: data.resultDetail,
    playerIds: data.playerIds || { b: null, w: null },
    winnerId: data.winnerId || null,
    rated: data.rated !== false,
    source: data.source || null,
    timeControl: data.timeControl || null,
    createdAt: data.createdAt || now,
    durationSec: data.durationSec || null,
    // §L 公开棋谱广场：默认私有；meta 为展示用可编辑信息（管理员维护）
    visibility: data.visibility === 'public' ? 'public' : 'private',
    meta: data.meta || null,
  };
  putRecord(record);
  return record;
}

function listRecords(limit = 200) {
  try {
    return dbListRecords(limit);
  } catch (_) {
    return [];
  }
}

function getRecord(id) {
  try {
    return getRecordById(id);
  } catch (_) {
    return null;
  }
}

/**
 * 某玩家的对局列表（**摘要**，不含整谱 moves）。
 * PLAN §Q7-2：改走摘要列 + playerB/playerW 索引。旧实现是 `listRecords(500)` 全量拉取后
 * 内存 filter —— 每次都要解析 500 份整谱，单进程 Node 下会同步阻塞主线程（连带卡住对局广播）。
 */
function listPlayerRecords(playerId, limit = 50) {
  try {
    return dbListSummaries({ playerId, limit });
  } catch (_) {
    return [];
  }
}

/**
 * 最新对局轻量摘要（首页"最新战报"轮询用）：直接读摘要列，不解析整谱。
 */
function recentSummaries(limit = 5) {
  return dbListSummaries({ limit });
}

/**
 * 棋谱检索（SQL 层过滤）。
 * @param {object} q 见 storage.searchRecords
 * @returns {Array} 匹配的棋谱（附带 opening 开局特征）
 */
function searchRecords(q = {}) {
  // storage 侧已返回摘要（含 moveCount / opening），无需再解析整谱（PLAN §Q7-2）
  return dbSearch(q);
}

// ======================================================================
// KIF / CSA 导出
// ======================================================================

const DEFAULT_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

// 时制 → 秒（CSA $TIME_LIMIT 用）：main=持時間（秒），byo=秒読み（秒）
const HOLD_TIME_LIMIT = {
  '10:00': { main: 600, byo: 0 },
  '15+60': { main: 900, byo: 60 },
  '10+30': { main: 600, byo: 30 },
  '10sec': { main: 0, byo: 10 },
};

function exportKif(rec) {
  // 对齐 81Dojo 导出格式（用户提供的标答）：
  // 首行 #KIF version=2.0 / 場所 / 持ち時間 / 每手行 (消費/累計) 时间不补零
  const HOLD_TIME = { '10:00': '10分', '15+60': '15分+60秒', '10+30': '10分+30秒', '10sec': '10秒' };
  const spentFmt = (s) => `${Math.floor(s / 60)}:${s % 60}`;
  const totalFmt = (s) => `${Math.floor(s / 3600)}:${Math.floor((s % 3600) / 60)}:${s % 60}`;
  const started = new Date(rec.createdAt || Date.now());
  const startDate = `${started.getFullYear()}/${String(started.getMonth() + 1).padStart(2, '0')}/${String(started.getDate()).padStart(2, '0')} ${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
  const lines = [
    '#KIF version=2.0 encoding=UTF-8',
    `開始日時：${startDate}`,
    '場所：天锻将棋道场',
    `持ち時間：${HOLD_TIME[rec.timeControl] || '10分'}`,
    '手合割：平手',
    `先手：${rec.names ? rec.names[0] : '先手'}`,
    `後手：${rec.names ? rec.names[1] : '後手'}`,
    '手数----指手---------消費時間--',
  ];
  const jpMoves = movesToKif(rec.startSfen || DEFAULT_SFEN, rec.moves || []);
  const times = rec.moveTimes || [];
  // §L：导出手数评论（KIF 标准注释行以 * 开头，置于对应手之后；旧字符串评论同样兼容）
  const comments = normalizeComments(rec);
  let cum = 0;
  jpMoves.forEach((m, i) => {
    const spent = Number(times[i]) || 0;
    cum += spent;
    lines.push(`${i + 1}   ${m}   (${spentFmt(spent)}/${totalFmt(cum)})`);
    for (const c of (comments[i + 1] || [])) {
      lines.push(`*${String(c.text).replace(/[\r\n]/g, ' ')}`);
    }
  });
  const n = (rec.moves || []).length;
  if (rec.resultDetail === '投了') {
    lines.push(`${n + 1} 投了`);
    lines.push(`まで${n}手で${rec.names[rec.result === 'b' ? 0 : 1]}の勝ち`);
  } else if (rec.result === 'b' || rec.result === 'w') {
    lines.push(`まで${n}手で${rec.names[rec.result === 'b' ? 0 : 1]}の勝ち`);
  } else if (rec.result === '-') {
    lines.push(`まで${n}手で${rec.resultDetail || '持将棋'}`);
  } else if (rec.resultDetail === '時間切れ') {
    lines.push('*時間切れにて終局');
  }
  return lines.join('\n') + '\n';
}

function exportCsa(rec) {
  const board = new Shogi();
  board.initializeFromSFENString(rec.startSfen || DEFAULT_SFEN);
  // 元信息字段（81Dojo/CSA V2.2 惯例，用户标答）
  const start = new Date(rec.createdAt || Date.now());
  const endTime = rec.durationSec ? rec.createdAt + rec.durationSec * 1000 : Date.now();
  const end = new Date(endTime);
  const dt = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const hold = HOLD_TIME_LIMIT[rec.timeControl] || { main: 600, byo: 0 };
  const timeLimit = `${String(Math.floor(hold.main / 60)).padStart(2, '0')}:${String(hold.main % 60).padStart(2, '0')}+${hold.byo}`;
  const lines = ['V2.2'];
  lines.push(`$EVENT:天锻将棋道场`);
  lines.push(`$SITE:天锻将棋道场`);
  lines.push(`$START_TIME:${dt(start)}`);
  lines.push(`$END_TIME:${dt(end)}`);
  lines.push(`$TIME_LIMIT:${timeLimit}`);
  lines.push(`N+${rec.names ? rec.names[0] : '先手'}`);
  lines.push(`N-${rec.names ? rec.names[1] : '後手'}`);
  // 盘面 P1(9段)~P9(1段)：y=1 为 9段，x=1 为 1筋
  for (let y = 1; y <= 9; y++) {
    let row = `P${y}`;
    for (let x = 1; x <= 9; x++) {
      const p = board.get(x, y);
      if (!p) row += ' * ';
      else row += (p.color === Color.Black ? '+' : '-') + CSA_PIECE[p.kind];
    }
    lines.push(row);
  }
  // 持驹
  for (const [color, sign] of [[Color.Black, 'P+'], [Color.White, 'P-']]) {
    const summary = board.getHandsSummary(color);
    const parts = [];
    for (const kind of ['FU', 'KY', 'KE', 'GI', 'KI', 'KA', 'HI']) {
      for (let i = 0; i < (summary[kind] || 0); i++) parts.push(`00${CSA_PIECE[kind]}`);
    }
    if (parts.length) lines.push(sign + parts.join(''));
  }
  lines.push(board.turn === Color.Black ? '+' : '-');
  // 走法
  for (const usi of rec.moves || []) {
    const mv = parseUsiMove(usi);
    const color = board.turn === Color.Black ? '+' : '-';
    if (mv.type === 'drop') {
      lines.push(`${color}00${usiToCsaCoord(mv.to)}${CSA_PIECE[DROP_TO_KIND[mv.piece]]}`);
      applyMoveOn(board, mv);  // 打子同样推进盘面，否则后续棋子读取错位
    } else {
      const fromXY = usiSquareToXY(mv.from);
      const pieceKind = board.get(fromXY.x, fromXY.y).kind;
      let pt = mv.promote ? (PROMOTED_MAP[pieceKind] || pieceKind) : pieceKind;
      lines.push(`${color}${usiToCsaCoord(mv.from)}${usiToCsaCoord(mv.to)}${CSA_PIECE[pt]}`);
      applyMoveOn(board, mv);
    }
  }
  // 结果
  if (rec.resultDetail === '投了') lines.push('%TORYO');
  else if (rec.resultDetail === '詰み') lines.push('%TSUMI');
  else if (rec.resultDetail === '接続切断') lines.push('%CHUDAN'); // CSA 标准：对局中断（断线/逃亡）
  else if (rec.resultDetail === '時間切れ') lines.push('%TIME_UP'); // 切れ負け
  else if (rec.resultDetail === '反則勝ち' || rec.resultDetail === '反則負け') lines.push('%ILLEGAL_MOVE');
  else if (rec.result === '-') lines.push(rec.resultDetail === '入玉' || rec.resultDetail === '持将棋' ? '%JISHOGI' : '%SENNICHITE');
  return lines.join('\n') + '\n';
}

function exportRecord(rec, fmt) {
  return fmt === 'csa' ? exportCsa(rec) : exportKif(rec);
}

/**
 * 生成回放数据：每一步之后的局面快照（board 数组）。
 * @param {object} rec
 * @returns {{startSfen:string, moves:string[], positions:Array}}
 */
function playbackData(rec) {
  const { Game } = require('./game');
  const game = new Game(rec.startSfen || DEFAULT_SFEN, rec.names);
  const positions = [];
  // 初始局面（含持驹）
  const snap = () => {
    const s = game.state();
    return { board: s.board, hands: s.hands || {} };
  };
  positions.push(snap());
  for (const usi of rec.moves || []) {
    game.applyMove(usi);
    positions.push(snap());
  }
  return {
    id: rec.id,
    startSfen: rec.startSfen || DEFAULT_SFEN,
    moves: rec.moves || [],
    positions,
    names: rec.names,
    result: rec.result,
    resultDetail: rec.resultDetail,
  };
}

/**
 * 导入 KIF 棋谱为平台记录（管理员）。
 * @param {string} text KIF 文本
 * @returns {{ok:true, record:object}|{ok:false, error:string}}
 */
function importKif(text) {
  const { parseKif } = require('./kif');
  let parsed;
  try {
    parsed = parseKif(text);
  } catch (e) {
    return { ok: false, error: `KIF 解析失败：${e.message}` };
  }
  // 尝试从 KIF 头提取"開始日時：YYYY/MM/DD HH:MM"
  let createdAt = null;
  const m = /開始日時[：:]\s*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ 　](\d{1,2}):(\d{1,2})/.exec(text || '');
  if (m) {
    createdAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }
  const record = saveRecord({
    startSfen: parsed.startSfen,
    moves: parsed.moves,
    names: parsed.names,
    result: parsed.result || null,
    resultDetail: parsed.resultDetail || null,
    playerIds: { b: null, w: null },
    winnerId: null,
    rated: false,
    source: 'kif-import',
    createdAt: createdAt || Date.now(),
  });
  return { ok: true, record };
}

// ======================================================================
// §L 公开棋谱广场：可见性 / 展示信息 / 评论模型升级
// ======================================================================

/**
 * 可见性判定（§L2）：管理员、谱主、以及已公开的棋谱可看。
 * @param {object} rec 棋谱
 * @param {{playerId?:string|null, isAdmin?:boolean}} ctx
 */
function canView(rec, ctx = {}) {
  if (!rec) return false;
  if (ctx.isAdmin) return true;
  if (rec.visibility === 'public') return true;
  return isOwner(rec, ctx.playerId);
}

function isPublic(rec) {
  return !!(rec && rec.visibility === 'public');
}

/**
 * 公开棋谱列表（§L4）：按置顶优先、时间倒序。
 * @param {{tag?:string, query?:string, page?:number, limit?:number}} opts
 */
function listPublic({ tag = '', query = '', page = 1, limit = 20 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const n = Math.min(60, Math.max(1, parseInt(limit, 10) || 20));
  // PLAN §Q7-2：改读摘要列（不解析整谱）。公开谱是管理员精选，数量有限。
  let rows = dbListSummaries({ pub: true, limit: 1000 }).filter(isPublic);
  if (tag) {
    const t = String(tag).trim().toLowerCase();
    rows = rows.filter((r) => ((r.meta && r.meta.tags) || []).some((x) => String(x).toLowerCase() === t));
  }
  if (query) {
    const q = String(query).trim().toLowerCase();
    rows = rows.filter((r) => {
      const names = (r.names || []).join(' ').toLowerCase();
      const meta = r.meta || {};
      const title = String(meta.title || '').toLowerCase();
      const event = String(meta.event || '').toLowerCase();
      return names.includes(q) || title.includes(q) || event.includes(q);
    });
  }
  const total = rows.length;
  const sorted = rows.sort((a, b) => {
    const fa = (a.meta && a.meta.featured) ? 1 : 0;
    const fb = (b.meta && b.meta.featured) ? 1 : 0;
    return fb - fa || (b.createdAt || 0) - (a.createdAt || 0);
  });
  const slice = sorted.slice((p - 1) * n, p * n);
  return {
    total,
    page: p,
    limit: n,
    records: slice.map(publicSummary),
  };
}

/** 列表项轻量摘要（不含 moves，省带宽） */
function publicSummary(r) {
  const meta = r.meta || {};
  return {
    id: r.id,
    names: r.names || ['先手', '後手'],
    result: r.result,
    resultDetail: r.resultDetail,
    // 摘要对象自带 moveCount；兼容传入完整记录（含 moves）的旧调用
    moveCount: typeof r.moveCount === 'number' ? r.moveCount : (Array.isArray(r.moves) ? r.moves.length : 0),
    createdAt: r.createdAt,
    timeControl: r.timeControl || null,
    playerIds: r.playerIds || {},
    meta: {
      title: meta.title || '',
      event: meta.event || '',
      round: meta.round || '',
      playedOn: meta.playedOn || '',
      tags: meta.tags || [],
      description: meta.description || '',
      featured: !!meta.featured,
      nameOverrides: meta.nameOverrides || null,
      resultNote: meta.resultNote || '',
    },
  };
}

/**
 * 设置公开/私有（§L4，管理员）。
 */
function setVisibility(id, visibility) {
  const r = getRecord(id);
  if (!r) return { ok: false, error: '棋谱不存在' };
  const v = visibility === 'public' ? 'public' : 'private';
  if (r.visibility === v) return { ok: false, error: '可见性未变化' };
  r.visibility = v;
  writeRecord(r);
  return { ok: true, visibility: v };
}

/** 允许管理员编辑的展示字段（§L1） */
const META_FIELDS = ['title', 'event', 'round', 'playedOn', 'tags', 'description', 'featured', 'nameOverrides', 'resultNote'];

/**
 * 编辑展示信息（§L4，管理员）。只写允许字段，未传的不动。
 * @param {string} id
 * @param {object} patch
 */
function setMeta(id, patch = {}) {
  const r = getRecord(id);
  if (!r) return { ok: false, error: '棋谱不存在' };
  const meta = { ...(r.meta || {}) };
  for (const k of META_FIELDS) {
    if (patch[k] === undefined) continue;
    if (k === 'tags') {
      if (!Array.isArray(patch[k])) return { ok: false, error: 'tags 需为数组' };
      meta.tags = patch[k].map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 10);
    } else if (k === 'featured') {
      meta.featured = !!patch[k];
    } else if (k === 'nameOverrides') {
      meta.nameOverrides = patch[k] || null;
    } else {
      meta[k] = String(patch[k]).trim().slice(0, 120);
    }
  }
  meta.updatedAt = Date.now();
  r.meta = meta;
  writeRecord(r);
  return { ok: true, meta };
}

/**
 * 评论归一化（§L3）：旧格式 { moveNo: '文本' } → { moveNo: [{id, authorId, authorName, text, ts}] }。
 * 读时兼容、写时转新结构（懒迁移，存量数据无需脚本处理）。
 */
function normalizeComments(rec) {
  const src = (rec && rec.comments) || {};
  const out = {};
  for (const [key, val] of Object.entries(src)) {
    if (Array.isArray(val)) {
      out[key] = val.filter((c) => c && c.text);
    } else if (typeof val === 'string' && val.trim()) {
      out[key] = [{
        id: `legacy-${key}`,
        authorId: null,
        authorName: null,
        text: val.trim(),
        ts: rec.createdAt || Date.now(),
        editedBy: null,
        editedAt: null,
      }];
    }
  }
  return out;
}

function genCommentId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 读取某棋谱的完整复盘数据（含书签/评论/变着）。
 * §L：附带 visibility/meta，评论统一为数组形态（旧字符串自动包装）。
 */
function reviewData(id) {
  const r = getRecord(id);
  if (!r) return null;
  return {
    id: r.id,
    startSfen: r.startSfen,
    moves: r.moves || [],
    moveTimes: r.moveTimes || [],
    names: r.names || ['先手', '後手'],
    result: r.result,
    resultDetail: r.resultDetail,
    playerIds: r.playerIds || {},
    createdAt: r.createdAt,
    bookmarks: r.bookmarks || [],
    comments: normalizeComments(r),
    variations: r.variations || {},
    visibility: r.visibility || 'private',
    meta: r.meta || null,
  };
}

function toggleBookmark(id, moveNo, on) {
  if (!Number.isInteger(moveNo) || moveNo < 0) return { ok: false, error: '手数非法' };
  const r = getRecord(id);
  if (!r) return { ok: false, error: '棋谱不存在' };
  const bookmarks = new Set(r.bookmarks || []);
  if (on) bookmarks.add(moveNo);
  else bookmarks.delete(moveNo);
  r.bookmarks = Array.from(bookmarks).sort((a, b) => a - b);
  writeRecord(r);
  return { ok: true, bookmarks: r.bookmarks };
}

/**
 * 写评论（§L3 升级）：
 *  - 不带 commentId：新增一条（authorId/authorName 由调用方从会话解析后传入）
 *  - 带 commentId + text：编辑该条（记录 editedBy/editedAt）
 *  - 带 commentId + 空 text：删除该条
 * 权限（本人自己的评论 / 管理员）由调用方（server.js）判定后传入 force=true。
 * @returns {{ok, comments?, error?}} comments 为归一化后的数组形态
 */
function setComment(id, moveNo, text, opts = {}) {
  if (!Number.isInteger(moveNo) || moveNo < 0) return { ok: false, error: '手数非法' };
  const r = getRecord(id);
  if (!r) return { ok: false, error: '棋谱不存在' };
  const comments = normalizeComments(r);
  const list = comments[moveNo] ? [...comments[moveNo]] : [];
  const t = String(text || '').trim();

  if (opts.commentId) {
    const idx = list.findIndex((c) => c.id === opts.commentId);
    if (idx < 0) return { ok: false, error: '评论不存在' };
    if (!opts.force && list[idx].authorId && list[idx].authorId !== opts.authorId) {
      return { ok: false, error: '只能编辑自己的评论' };
    }
    if (t) {
      list[idx] = {
        ...list[idx],
        text: t,
        editedBy: opts.force ? (opts.authorId || null) : null,
        editedAt: Date.now(),
      };
    } else {
      list.splice(idx, 1);
    }
  } else {
    if (!t) return { ok: false, error: '评论不能为空' };
    list.push({
      id: genCommentId(),
      authorId: opts.authorId || null,
      authorName: opts.authorName || null,
      text: t,
      ts: Date.now(),
      editedBy: null,
      editedAt: null,
    });
  }

  if (list.length) comments[moveNo] = list;
  else delete comments[moveNo];
  r.comments = comments;
  writeRecord(r);
  return { ok: true, comments };
}

function addVariation(id, parent, move) {
  const r = getRecord(id);
  if (!r) return { ok: false, error: '棋谱不存在' };
  const movesLen = (r.moves || []).length;
  if (!Number.isInteger(parent) || parent < 0 || parent >= movesLen) {
    return { ok: false, error: '父手数非法' };
  }
  if (!/^([1-9][a-i])([1-9][a-i])(\+?)$|^[PLNSGBR]\*[1-9][a-i]$/.test(move)) {
    return { ok: false, error: '变着走法非法' };
  }
  const variations = { ...(r.variations || {}) };
  if (!variations[parent]) variations[parent] = [];
  if (!variations[parent].some((v) => v.move === move)) {
    variations[parent].push({ move, parent });
  }
  r.variations = variations;
  writeRecord(r);
  return { ok: true, variations: r.variations };
}

function isOwner(rec, playerId) {
  return !!(rec && rec.playerIds && (rec.playerIds.b === playerId || rec.playerIds.w === playerId));
}

function writeRecord(record) {
  putRecord(record);
}

module.exports = {
  saveRecord,
  listRecords,
  getRecord,
  listPlayerRecords,
  recentSummaries,
  searchRecords,
  exportKif,
  exportCsa,
  exportRecord,
  movesToKif,
  playbackData,
  importKif,
  reviewData,
  toggleBookmark,
  setComment,
  addVariation,
  isOwner,
  // §L 公开棋谱广场
  canView,
  isPublic,
  listPublic,
  publicSummary,
  setVisibility,
  setMeta,
  META_FIELDS,
  normalizeComments,
};
