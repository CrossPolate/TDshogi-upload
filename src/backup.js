/**
 * backup.js — SQLite 数据库备份（PLAN §Q7-4）
 *
 * **为什么必须做**：本项目全部资产都在**单一 SQLite 文件**（`data/tdshogi.db`）里——
 * 账号、游客会话、棋谱、等级分、赛事、公告、审计日志。磁盘损坏或误删一次，
 * 没有任何东西可恢复，而此前**没有任何备份机制**。
 *
 * **为什么用 `VACUUM INTO` 而不是复制文件**：
 *  - 数据库是 WAL 模式，数据分散在 `.db` / `.db-wal` / `.db-shm` 三个文件里。
 *    服务运行时直接拷贝，很可能拷到**不一致的中间状态**（WAL 里的新数据没并进主库），
 *    恢复出来是坏的或过期的——这是"看起来有备份、真出事时用不了"的经典陷阱。
 *  - `VACUUM INTO` 走一次**读事务**，拿到的是**一致性快照**；WAL 下读不阻塞写，
 *    因此**服务运行中也能安全备份**，不影响正在进行的对局。
 *  - 产出是**紧凑单文件**（顺带整理碎片），可直接当完整数据库打开。
 *  - 比 better-sqlite3 的 `db.backup()` 更简单：同步一行，无需管理异步生命周期。
 *
 * ⚠️ `VACUUM INTO` 要求目标文件**不存在**（它不覆盖），所以每次都用带时间戳的新
 * 文件名——这正好与「滚动保留最近 N 份」的策略一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR, DB_PATH, checkpointWal } = require('./storage');
const log = require('./logger');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DEFAULT_KEEP = 14;                            // 保留份数（约两周）
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;   // 总量上限 2GB（棋谱涨大后防撑爆磁盘）
const PREFIX = 'tdshogi-';
const SUFFIX = '.db';

/** 时间戳（本地时区），形如 20260910-153000：字典序 == 时间序，便于排序裁剪 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 列出备份（按时间**升序**：旧 → 新）。目录不存在时返回空数组。 */
function listBackups(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort()
    .map((f) => {
      const full = path.join(dir, f);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) { size = 0; }
      return { file: f, path: full, size };
    });
}

/** 最新一份备份；无备份返回 null */
function latestBackup(dir = BACKUP_DIR) {
  const all = listBackups(dir);
  return all.length ? all[all.length - 1] : null;
}

/** 从备份文件名取日期部分（YYYYMMDD），用于「今天是否已备份」判断 */
function backupDay(entry) {
  if (!entry || !entry.file) return null;
  const m = /^tdshogi-(\d{8})-/.exec(entry.file);
  return m ? m[1] : null;
}

/**
 * 校验备份文件确实可用——避免「以为有备份，其实是坏的」。
 * 做两件事：`PRAGMA integrity_check` 必须为 ok；核心表 records 必须在。
 */
function verifyBackup(file) {
  let db = null;
  try {
    db = new Database(file, { readonly: true });
    const rows = db.pragma('integrity_check');
    const verdict = rows && rows[0] ? Object.values(rows[0])[0] : null;
    if (verdict !== 'ok') return { ok: false, reason: `integrity_check = ${verdict}` };
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get();
    if (!t) return { ok: false, reason: '缺少 records 表' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    try { if (db) db.close(); } catch (_) { /* 关闭失败无需处理 */ }
  }
}

/**
 * 滚动保留：先按份数裁，再按总量裁（都只删最旧的，且**至少保留最新 1 份**）。
 * @returns {string[]} 被删除的文件名
 */
function prune({ dir = BACKUP_DIR, keep = DEFAULT_KEEP, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const removed = [];
  const drop = (entry) => {
    try { fs.unlinkSync(entry.path); removed.push(entry.file); } catch (_) { /* 删不掉就跳过 */ }
  };

  const all = listBackups(dir);
  const keepN = Math.max(1, keep);
  for (const e of all.slice(0, Math.max(0, all.length - keepN))) drop(e);

  // 总量兜底：从最旧的继续删，直到不超上限（永远留住最新那份）
  const alive = listBackups(dir);
  let total = alive.reduce((s, e) => s + e.size, 0);
  for (let i = 0; i < alive.length - 1 && total > maxBytes; i++) {
    drop(alive[i]);
    total -= alive[i].size;
  }
  return removed;
}

/**
 * 执行一次备份。
 * @param {{dir?:string, keep?:number, maxBytes?:number, quiet?:boolean}} opts
 * @returns {{ok:boolean, file?:string, path?:string, size?:number, pruned?:string[], reason?:string}}
 */
function runBackup(opts = {}) {
  const dir = opts.dir || BACKUP_DIR;
  // 用 ?? 而非 ||：0 是合法取值（`maxBytes: 0` 意为"只留最新一份"），不能被当成未传
  const keep = opts.keep ?? DEFAULT_KEEP;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  if (!fs.existsSync(DB_PATH)) return { ok: false, reason: `数据库不存在：${DB_PATH}` };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `无法创建备份目录：${err.message}` };
  }

  const name = `${PREFIX}${stamp()}${SUFFIX}`;
  const dest = path.join(dir, name);

  // 目标文件若已存在（同一秒内重复调用），换个后缀避免 VACUUM INTO 报错
  const finalDest = fs.existsSync(dest)
    ? path.join(dir, `${PREFIX}${stamp()}-${Math.random().toString(36).slice(2, 6)}${SUFFIX}`)
    : dest;
  const finalName = path.basename(finalDest);

  let db = null;
  try {
    // 独立连接（不与服务端共享）；VACUUM INTO 只读源库、只写目标文件
    db = new Database(DB_PATH);
    db.prepare('VACUUM INTO ?').run(finalDest);
  } catch (err) {
    try { if (fs.existsSync(finalDest)) fs.unlinkSync(finalDest); } catch (_) { /* 清理失败忽略 */ }
    return { ok: false, reason: err.message };
  } finally {
    try { if (db) db.close(); } catch (_) { /* 关闭失败忽略 */ }
  }

  // 校验：坏备份宁可不要，也不要留个假的让人安心
  const check = verifyBackup(finalDest);
  if (!check.ok) {
    try { fs.unlinkSync(finalDest); } catch (_) { /* 清理失败忽略 */ }
    return { ok: false, reason: `备份校验失败（已删除）：${check.reason}` };
  }

  let size = 0;
  try { size = fs.statSync(finalDest).size; } catch (_) { size = 0; }
  const pruned = prune({ dir, keep, maxBytes });

  if (!opts.quiet) {
    log.info('backup', `已备份 ${finalName}（${fmtSize(size)}）`
      + (pruned.length ? `，清理 ${pruned.length} 份旧备份` : ''));
  }
  return { ok: true, file: finalName, path: finalDest, size, pruned };
}

/**
 * 启动每日自动备份：
 *  - **立即检查一次**：今天还没备份过才补一份 → 服务反复重启**不会**重复备份
 *  - 之后每 `intervalMs`（默认 6 小时）检查一次；跨过零点后就会被补上
 *  - 定时器 `unref()`，不阻止进程退出（同 src/ratelimit.js 惯例）
 *  - 全部异常就地吞掉并记日志：**备份失败绝不能影响对局服务**
 * @returns {NodeJS.Timeout} 定时器（可 clearInterval 关闭，测试用）
 */
function startAutoBackup({ intervalMs = 6 * 3600 * 1000, keep, maxBytes, dir } = {}) {
  const tick = () => {
    try {
      // 顺手截断 WAL：长期运行的单连接下 `-wal` 不会自己收回去，会白占空间。
      // ⚠️ 与备份的正确性**无关**——备份走 `VACUUM INTO`，本身就把 WAL 内容算进去了
      //（详见 `storage.checkpointWal` 的注释）。这里只是打扫。
      // 放在"是否已备份"判断之前：即使今天已备份，也照样打扫一次。
      checkpointWal();

      const latest = latestBackup(dir);
      const today = stamp().slice(0, 8);
      if (latest && backupDay(latest) === today) return; // 今天已有备份
      runBackup({ dir, keep, maxBytes });
    } catch (err) {
      log.error('backup', '自动备份失败', { err });
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  BACKUP_DIR,
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  listBackups,
  latestBackup,
  backupDay,
  verifyBackup,
  prune,
  runBackup,
  startAutoBackup,
  fmtSize,
};
