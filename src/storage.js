/**
 * storage.js — SQLite 存储层（better-sqlite3）
 *
 * 将原先的 JSON 文件存储迁移到单一 SQLite 数据库（data/tdshogi.db），
 * 对外保持与旧版兼容的接口，各业务模块无需改动：
 *
 *  - readJson(name, fallback) / writeJson(name, data)
 *    通用键值存储（ratings/tournaments/accounts/announcements/admin）
 *  - records 表：棋谱（id 主键 + 数据 JSON + createdAt 索引）
 *  - sessions 表：游客/账号会话（id 主键 + 数据 JSON）
 *
 * 首次启动自动把旧 data/*.json 与 data/records/*.json 迁移进库。
 * 依赖：better-sqlite3（node_modules 预编译，无需构建工具）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const log = require('./logger');

// 运行时数据根目录（可用环境变量 DATA_DIR 覆盖，便于部署到持久目录）
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'tdshogi.db');
const RECORDS_DIR = path.join(DATA_DIR, 'records'); // 保留（旧数据迁移源 + 兼容）
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------- 数据库初始化 ----------------
let db = null;

function getDb() {
  if (db) return db;
  ensureDir(DATA_DIR);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');      // 读写并发友好
  db.pragma('synchronous = NORMAL');    // 性能与安全平衡
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- 「摘要列」方案（PLAN §Q7-2 性能）：
    -- data 里存的是整谱（含 100+ 手 moves），列表/检索若都走 data 就必须逐条 JSON.parse，
    -- 单进程 Node 下会**同步阻塞**主线程（连带卡住对局广播）。故把列表/检索要用的字段
    -- 冗余成标量列 + 索引，查询只读这些列、完全不碰 data。
    -- 老库缺列由 ensureRecordColumns() 用 ALTER TABLE 补齐，再由 backfillRecordSummaries() 回填。
    CREATE TABLE IF NOT EXISTS records (
      id           TEXT PRIMARY KEY,
      data         TEXT NOT NULL,
      createdAt    INTEGER,
      playerB      TEXT,    -- playerIds.b（先手 id）
      playerW      TEXT,    -- playerIds.w（后手 id）
      nameB        TEXT,
      nameW        TEXT,
      result       TEXT,    -- 'b' | 'w' | '-' | null
      resultDetail TEXT,
      moveCount    INTEGER,
      opening      TEXT,    -- 前 N 手 USI 逗号串（定式检索）
      pub          INTEGER, -- visibility='public' ? 1 : 0
      visibility   TEXT,
      source       TEXT,
      timeControl  TEXT,
      rated        INTEGER,
      winnerId     TEXT,
      durationSec  INTEGER,
      meta         TEXT     -- 广场展示信息（JSON 串）
    );
    CREATE INDEX IF NOT EXISTS idx_records_createdAt ON records(createdAt);
    -- ⚠️ 摘要列索引**不能**在这里建：老库中 CREATE TABLE IF NOT EXISTS 不会补列，
    -- 直接 CREATE INDEX ON records(playerB) 会报 "no such column"。
    -- 这三条索引统一由紧随其后的 ensureRecordColumns() 负责（先 ALTER 补列、再建索引）。
    CREATE TABLE IF NOT EXISTS sessions (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gamesnapshots (
      roomId TEXT PRIMARY KEY,
      data   TEXT NOT NULL,
      savedAt INTEGER
    );
  `);
  migrateLegacyJson();
  // 老库补列（幂等）——必须早于任何写/读摘要列的语句
  ensureRecordColumns();
  // 存量棋谱摘要列回填（幂等，仅首次扫描）。放这里而非 server 启动处：
  // initDb 由 getDb() 惰性触发且只执行一次，能保证**任何入口**（含脚本/测试）都已回填。
  try {
    const filled = backfillRecordSummaries();
    if (filled) log.info('storage', `已为 ${filled} 条存量棋谱回填摘要列（列表/检索不再解析整谱）`);
  } catch (err) {
    log.error('storage', '棋谱摘要列回填失败', { err });
  }
  return db;
}

/** 摘要列清单：ALTER TABLE 逐列补齐（SQLite 无 ADD COLUMN IF NOT EXISTS，故查 PRAGMA） */
const RECORD_SUMMARY_COLUMNS = [
  ['playerB', 'TEXT'], ['playerW', 'TEXT'], ['nameB', 'TEXT'], ['nameW', 'TEXT'],
  ['result', 'TEXT'], ['resultDetail', 'TEXT'], ['moveCount', 'INTEGER'], ['opening', 'TEXT'],
  ['pub', 'INTEGER'], ['visibility', 'TEXT'], ['source', 'TEXT'], ['timeControl', 'TEXT'],
  ['rated', 'INTEGER'], ['winnerId', 'TEXT'], ['durationSec', 'INTEGER'], ['meta', 'TEXT'],
];

/** 给已存在的老库补摘要列与索引（幂等，可重复调用） */
function ensureRecordColumns() {
  const d = getDb();
  const cols = new Set(d.prepare('PRAGMA table_info(records)').all().map((c) => c.name));
  for (const [name, type] of RECORD_SUMMARY_COLUMNS) {
    if (!cols.has(name)) d.exec(`ALTER TABLE records ADD COLUMN ${name} ${type}`);
  }
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_records_playerB ON records(playerB);
    CREATE INDEX IF NOT EXISTS idx_records_playerW ON records(playerW);
    CREATE INDEX IF NOT EXISTS idx_records_pub ON records(pub, createdAt);
  `);
}

// ---------------- 旧 JSON 数据一次性迁移 ----------------
function migrateLegacyJson() {
  // 通用 kv 文件（ratings/tournaments/accounts/announcements/admin）
  for (const name of ['ratings.json', 'tournaments.json', 'accounts.json', 'announcements.json', 'admin.json']) {
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') {
        const stmt = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
        stmt.run(name, JSON.stringify(data));
        // 迁移后改名备份，避免重复迁移
        fs.renameSync(file, `${file}.bak`);
      }
    } catch (_) { /* 忽略损坏文件 */ }
  }
  // records/*.json
  if (fs.existsSync(RECORDS_DIR)) {
    const insert = db.prepare('INSERT OR REPLACE INTO records (id, data, createdAt) VALUES (?, ?, ?)');
    const files = fs.readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, f), 'utf8'));
        if (rec && rec.id) insert.run(rec.id, JSON.stringify(rec), rec.createdAt || Date.now());
      } catch (_) {}
    }
    // 迁移后目录改名（保留备份）
    if (files.length) fs.renameSync(RECORDS_DIR, `${RECORDS_DIR}.bak`);
  }
  // sessions/*.json
  if (fs.existsSync(SESSIONS_DIR)) {
    const insert = db.prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)');
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s && s.id) insert.run(s.id, JSON.stringify(s));
      } catch (_) {}
    }
    if (files.length) fs.renameSync(SESSIONS_DIR, `${SESSIONS_DIR}.bak`);
  }
}

// ---------------- 兼容接口：通用 kv ----------------
/**
 * 读取 JSON（key 形式：'ratings.json' 等）。兼容旧接口。
 */
function readJson(name, fallback = null) {
  const d = getDb();
  try {
    const row = d.prepare('SELECT value FROM kv WHERE key = ?').get(String(name));
    if (!row) return fallback;
    return JSON.parse(row.value);
  } catch (err) {
    log.error('storage', `读取 ${name} 失败`, { err, name });
    return fallback;
  }
}

/**
 * 写入 JSON（key 形式）。兼容旧接口。
 */
function writeJson(name, data) {
  const d = getDb();
  try {
    d.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .run(String(name), JSON.stringify(data));
  } catch (err) {
    log.error('storage', `写入 ${name} 失败`, { err, name });
  }
}

/**
 * 按前缀枚举 kv 中的 JSON（如 'sessions/'）。
 * 会话实际写在此处（identify/upsertSession 走 writeJson），
 * 读取侧（auth.listSessions → ratings.allUsers → admin 用户列表）必须走同一来源。
 */
function listJsonByPrefix(prefix) {
  const d = getDb();
  try {
    const rows = d.prepare('SELECT key, value FROM kv WHERE key LIKE ? ESCAPE ?')
      .all(`${String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`, '\\');
    return rows.map((r) => JSON.parse(r.value));
  } catch (err) {
    log.error('storage', `枚举 ${prefix}* 失败`, { err, prefix });
    return [];
  }
}

/**
 * 删除 kv 项（审计/事件日志裁剪用，PLAN §M3）。
 * 幂等：键不存在时无副作用。
 */
function deleteJson(name) {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(String(name));
  return true;
}

// ---------------- records / sessions 表接口 ----------------
function recordExists(id) {
  return !!getDb().prepare('SELECT 1 FROM records WHERE id = ?').get(id);
}

function getRecordById(id) {
  const row = getDb().prepare('SELECT data FROM records WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

/** 定式指纹取多少手（检索用前 N 手匹配；超出部分回退 JSON 比对，见 searchRecords） */
const OPENING_N = 10;

/** 取整谱前 N 手 USI 逗号串（无棋谱返回 null） */
function openingOf(moves) {
  if (!Array.isArray(moves) || !moves.length) return null;
  return moves.slice(0, OPENING_N).join(',');
}

/** 从棋谱对象抽出摘要列的值（写入与回填共用，保证两条路径口径一致） */
function summaryValues(rec) {
  const p = rec.playerIds || {};
  const names = rec.names || [];
  return {
    playerB: p.b || null,
    playerW: p.w || null,
    nameB: names[0] || null,
    nameW: names[1] || null,
    result: rec.result || null,
    resultDetail: rec.resultDetail || null,
    moveCount: Array.isArray(rec.moves) ? rec.moves.length : 0,
    opening: openingOf(rec.moves),
    pub: rec.visibility === 'public' ? 1 : 0,
    visibility: rec.visibility === 'public' ? 'public' : 'private',
    source: rec.source || null,
    timeControl: rec.timeControl || null,
    rated: rec.rated === false ? 0 : 1,
    winnerId: rec.winnerId || null,
    durationSec: rec.durationSec || null,
    meta: rec.meta ? JSON.stringify(rec.meta) : null,
  };
}

/** 摘要行 → 对外的轻量棋谱对象（字段与旧完整记录兼容，仅不含 moves） */
function rowToSummary(r) {
  let meta = null;
  if (r.meta) { try { meta = JSON.parse(r.meta); } catch (_) { meta = null; } }
  return {
    id: r.id,
    names: [r.nameB || '先手', r.nameW || '後手'],
    playerIds: { b: r.playerB || null, w: r.playerW || null },
    result: r.result,
    resultDetail: r.resultDetail,
    moveCount: r.moveCount || 0,
    // 展示仍用前 4 手（opening 列存前 OPENING_N 手，供检索前缀匹配）
    opening: r.opening ? r.opening.split(',').slice(0, 4).join(',') : '',
    createdAt: r.createdAt,
    rated: !!r.rated,
    visibility: r.visibility || 'private',
    isPublic: r.visibility === 'public',
    source: r.source,
    timeControl: r.timeControl,
    winnerId: r.winnerId,
    durationSec: r.durationSec,
    meta,
  };
}

const SUMMARY_SELECT = `SELECT id, playerB, playerW, nameB, nameW, result, resultDetail,
  moveCount, opening, createdAt, rated, visibility, source, timeControl, winnerId,
  durationSec, meta FROM records`;

function putRecord(rec) {
  const v = summaryValues(rec);
  getDb().prepare(`INSERT OR REPLACE INTO records
    (id, data, createdAt, playerB, playerW, nameB, nameW, result, resultDetail,
     moveCount, opening, pub, visibility, source, timeControl, rated, winnerId, durationSec, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      rec.id, JSON.stringify(rec), rec.createdAt || Date.now(),
      v.playerB, v.playerW, v.nameB, v.nameW, v.result, v.resultDetail,
      v.moveCount, v.opening, v.pub, v.visibility, v.source, v.timeControl,
      v.rated, v.winnerId, v.durationSec, v.meta
    );
}

/**
 * 完整棋谱列表（含 moves）——**仅在确实需要整谱时使用**。
 * 列表 / 检索类场景请改用 listSummaries()，否则会逐条解析整谱（PLAN §Q7-2）。
 */
function listRecords(limit = 500) {
  const rows = getDb()
    .prepare('SELECT data FROM records ORDER BY createdAt DESC, id DESC LIMIT ?')
    .all(limit);
  return rows.map((r) => JSON.parse(r.data));
}

/**
 * 摘要列表（PLAN §Q7-2）：只读标量列，完全不触碰 data 里的整谱。
 * @param {{playerId?:string|null, pub?:boolean|null, limit?:number, offset?:number}} opts
 */
function listSummaries({ playerId = null, pub = null, limit = 100, offset = 0 } = {}) {
  const conds = [];
  const params = [];
  if (playerId) {
    conds.push('(playerB = ? OR playerW = ?)');
    params.push(playerId, playerId);
  }
  if (pub !== null && pub !== undefined) {
    conds.push('pub = ?');
    params.push(pub ? 1 : 0);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`${SUMMARY_SELECT} ${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.max(1, limit), Math.max(0, offset));
  return rows.map(rowToSummary);
}

/** 摘要总数（分页用；比拉全量再取 length 便宜得多） */
function countSummaries({ playerId = null, pub = null } = {}) {
  const conds = [];
  const params = [];
  if (playerId) {
    conds.push('(playerB = ? OR playerW = ?)');
    params.push(playerId, playerId);
  }
  if (pub !== null && pub !== undefined) {
    conds.push('pub = ?');
    params.push(pub ? 1 : 0);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return getDb().prepare(`SELECT COUNT(*) AS n FROM records ${where}`).get(...params).n;
}

/**
 * 为存量棋谱回填摘要列（幂等）：以 moveCount IS NULL 判定"尚未回填"。
 * 老库首次启动会扫描全部棋谱一次（一次性成本），之后不再执行。
 * @returns {number} 本次回填条数
 */
function backfillRecordSummaries() {
  const d = getDb();
  const rows = d.prepare('SELECT id, data FROM records WHERE moveCount IS NULL').all();
  if (!rows.length) return 0;
  const upd = d.prepare(`UPDATE records SET
    playerB=@playerB, playerW=@playerW, nameB=@nameB, nameW=@nameW, result=@result,
    resultDetail=@resultDetail, moveCount=@moveCount, opening=@opening, pub=@pub,
    visibility=@visibility, source=@source, timeControl=@timeControl, rated=@rated,
    winnerId=@winnerId, durationSec=@durationSec, meta=@meta WHERE id=@id`);
  const tx = d.transaction((list) => {
    for (const r of list) {
      let rec;
      try { rec = JSON.parse(r.data); } catch (_) { rec = null; }
      // 数据损坏也写入占位值——否则每次启动都会重复扫描同一条
      upd.run(rec
        ? { ...summaryValues(rec), id: r.id }
        : {
          playerB: null, playerW: null, nameB: null, nameW: null, result: null, resultDetail: null,
          moveCount: 0, opening: null, pub: 0, visibility: 'private', source: null, timeControl: null,
          rated: 1, winnerId: null, durationSec: null, meta: null, id: r.id,
        });
    }
  });
  tx(rows);
  return rows.length;
}

/**
 * 检索棋谱（条件可组合，全部可选）：
 * @param {object} q
 *  - playerId: 按玩家过滤（先手或后手）
 *  - movesMin / movesMax: 手数范围
 *  - result: 'b' | 'w' | '-' | null
 *  - opening: 开局特征（前 N 手 USI 序列，如 '7g7f,3c3d'）
 *  - query: 关键词（选手名 / 走法片段）
 *  - limit
 */
function searchRecords(q = {}) {
  const conds = [];
  const params = [];
  if (q.playerId) {
    conds.push('(playerB = ? OR playerW = ?)');
    params.push(q.playerId, q.playerId);
  }
  if (q.pub !== null && q.pub !== undefined) {
    conds.push('pub = ?');
    params.push(q.pub ? 1 : 0);
  }
  if (Number.isFinite(q.movesMin)) {
    conds.push('moveCount >= ?');
    params.push(q.movesMin);
  }
  if (Number.isFinite(q.movesMax)) {
    conds.push('moveCount <= ?');
    params.push(q.movesMax);
  }
  if (q.result) {
    conds.push('result = ?');
    params.push(q.result);
  }
  if (q.opening) {
    // 开局特征：前 N 手完全匹配（USI 序列）
    const seq = String(q.opening).split(',').map((s) => s.trim()).filter(Boolean);
    if (seq.length) {
      const pat = seq.join(',');
      if (seq.length <= OPENING_N) {
        // opening 列已存前 OPENING_N 手 → 前缀匹配即可（快路径，不解析 JSON）
        conds.push('(opening = ? OR opening LIKE ?)');
        params.push(pat, `${pat},%`);
      } else {
        // 超出入库长度：回退逐手比对（慢路径，极少触发）
        const checks = seq.map((_, i) => `json_extract(data, '$.moves[' || ${i} || ']') = ?`).join(' AND ');
        conds.push(`json_array_length(json_extract(data, '$.moves')) >= ? AND (${checks})`);
        params.push(seq.length, ...seq);
      }
    }
  }
  if (q.query) {
    // 关键词：优先匹配双方名（标量列）；走法片段搜索仍需扫 data，故放在最后
    const kw = `%${String(q.query)}%`;
    conds.push('(nameB LIKE ? OR nameW LIKE ? OR data LIKE ?)');
    params.push(kw, kw, kw);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(q.limit || 100, 500);
  const rows = getDb()
    .prepare(`${SUMMARY_SELECT} ${where} ORDER BY createdAt DESC, id DESC LIMIT ${limit}`)
    .all(...params);
  return rows.map(rowToSummary);
}

function sessionExists(id) {
  return !!getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
}

/** 棋谱总数（首页统计胶囊用） */
function countRecords() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM records').get().n;
}

function getSessionById(id) {
  const row = getDb().prepare('SELECT data FROM sessions WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

function putSession(session) {
  getDb().prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)')
    .run(session.id, JSON.stringify(session));
}

function listSessions() {
  const rows = getDb().prepare('SELECT data FROM sessions').all();
  return rows.map((r) => JSON.parse(r.data));
}

// ---------------- gamesnapshots：进行中对局快照（重启恢复） ----------------
function putGameSnapshot(roomId, data) {
  getDb().prepare('INSERT OR REPLACE INTO gamesnapshots (roomId, data, savedAt) VALUES (?, ?, ?)')
    .run(roomId, JSON.stringify(data), Date.now());
}

function getGameSnapshot(roomId) {
  const row = getDb().prepare('SELECT data FROM gamesnapshots WHERE roomId = ?').get(roomId);
  return row ? JSON.parse(row.data) : null;
}

function listGameSnapshots() {
  const rows = getDb().prepare('SELECT roomId, data FROM gamesnapshots').all();
  return rows.map((r) => ({ roomId: r.roomId, data: JSON.parse(r.data) }));
}

function deleteGameSnapshot(roomId) {
  getDb().prepare('DELETE FROM gamesnapshots WHERE roomId = ?').run(roomId);
}

// ---------------- 兼容旧导出（供仍引用 RECORDS_DIR 的代码） ----------------
function ensureDataDirs() {
  ensureDir(DATA_DIR);
  getDb(); // 初始化库（含迁移）
}

function listRecordFiles(exts = ['.json']) {
  // 旧接口返回文件路径数组；SQLite 下返回空（业务已改用表接口）
  return [];
}

module.exports = {
  DATA_DIR,
  DB_PATH, // src/backup.js 需要（避免在别处重复推导路径）
  RECORDS_DIR,
  SESSIONS_DIR,
  ensureDataDirs,
  readJson,
  writeJson,
  deleteJson,
  listJsonByPrefix,
  listRecordFiles,
  // 表级接口
  recordExists,
  getRecordById,
  putRecord,
  listRecords,
  listSummaries,
  countSummaries,
  backfillRecordSummaries,
  searchRecords,
  countRecords,
  sessionExists,
  getSessionById,
  putSession,
  listSessions,
  // gamesnapshots
  putGameSnapshot,
  getGameSnapshot,
  listGameSnapshots,
  deleteGameSnapshot,
  // 仅供测试/工具
  _getDb: getDb,
};
