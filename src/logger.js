/**
 * src/logger.js — 统一日志与错误上报地基（PLAN §P4）
 *
 * 解决的问题：日志此前散落在各模块的 `console.log('[rooms] ...')`——
 *  - **没有级别**：调试输出与线上告警混在一起，无法只保留重要的；
 *  - **没有时间戳**：多进程/长跑后无法判断先后；
 *  - **没有统一出口**：将来要对接错误上报（Sentry 之类）得改几十处；
 *  - **有陷阱**：`console.error('[a] msg:', err)` 传 Error 对象时，
 *    Node 会把整个对象 dump 出来，日志里出现大段无关字段。
 *
 * 设计取舍：
 *  - **零依赖**（与本项目一致），只用 `process.stdout` / `process.stderr`；
 *  - **默认人类可读**（text），观感与迁移前接近（多出时间戳 + 级别），不打乱现有排障习惯；
 *    需要机器解析时设 `LOG_FORMAT=json`，每行一个 JSON 对象（`ts` / `level` / `ctx` / `msg` + 自定义字段）；
 *  - **按级别分流**：debug/info → stdout，warn/error → stderr，
 *    这样 `npm start > srv.log 2> srv.err` 天然把告警与常规日志分开；
 *  - **可注入输出**（`setOutput`）：单测用它捕获日志，将来对接上报也只需实现一个函数。
 *
 * 用法：
 *   const log = require('./logger');
 *   log.info('rooms', `房间 ${roomId} 销毁`, { roomId, reason });
 *   log.error('admin', '写操作异常', { err });   // Error → JSON 模式带 stack，text 模式另起堆栈行
 *   const rl = log.child({ roomId });            // 子 logger：之后每行自动带 roomId
 *   rl.warn('clock', '时钟超时');
 *
 * 环境变量：
 *   `LOG_LEVEL`  = debug | info | warn | error（默认 info）
 *   `LOG_FORMAT` = text | json（默认 text）
 *
 * ⚠️ 约定：**scope（模块名）是第一个参数**，用来替代旧代码里手写的 `[rooms]` 前缀。
 * 迁移老代码时把 `[x]` 去掉、把 x 作为 scope 传入，**不要**在消息里再写一遍前缀。
 */
'use strict';

/** 级别数值：数值越大越严重 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
/** text 模式的对齐标签（等宽，便于肉眼扫） */
const LABEL = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

function parseLevel(value, fallback) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, s) ? s : fallback;
}

const state = {
  levelName: parseLevel(process.env.LOG_LEVEL, 'info'),
  format: String(process.env.LOG_FORMAT || '').trim().toLowerCase() === 'json' ? 'json' : 'text',
  output: null, // (level, line) => void；注入后不再写 stdout/stderr
};

/** Error → 精简对象（堆栈截断，避免刷屏） */
function serializeError(e) {
  const out = { name: e.name, message: e.message };
  if (e.code) out.code = e.code;
  if (e.stack) out.stack = String(e.stack).split('\n').slice(0, 6).join('\n');
  return out;
}

function toText(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function toMessage(msg) {
  if (msg instanceof Error) return msg.message;
  return typeof msg === 'string' ? msg : String(msg);
}

function emit(level, line) {
  if (state.output) { state.output(level, line); return; }
  const stream = (level === 'warn' || level === 'error') ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

/**
 * 核心写入。`baseCtx` 来自 child()，`fields` 是本次调用附加的字段（fields 优先）。
 */
function write(level, scope, msg, fields, baseCtx) {
  if (LEVELS[level] < LEVELS[state.levelName]) return;
  const now = new Date();
  const merged = Object.assign({}, baseCtx, fields || {});

  if (state.format === 'json') {
    const rec = { ts: now.toISOString(), level, ctx: scope, msg: toMessage(msg) };
    for (const key of Object.keys(merged)) {
      const v = merged[key];
      if (v === undefined) continue;
      rec[key] = v instanceof Error ? serializeError(v) : v;
    }
    emit(level, JSON.stringify(rec));
    return;
  }

  // text：`HH:mm:ss.SSS LEVEL [scope] msg key=value ...`，Error 堆栈另起缩进行
  const parts = [];
  const errors = [];
  for (const key of Object.keys(merged)) {
    const v = merged[key];
    if (v === undefined) continue;
    if (v instanceof Error) {
      parts.push(`${key}=${JSON.stringify(v.message)}`);
      errors.push(v);
    } else {
      parts.push(`${key}=${toText(v)}`);
    }
  }
  // toISOString() 的 11..23 位即 HH:mm:ss.SSS（UTC，与 JSON 模式同源，避免两套时区口径）
  let line = `${now.toISOString().slice(11, 23)} ${LABEL[level]} [${scope}] ${toMessage(msg)}`;
  if (parts.length) line += ' ' + parts.join(' ');
  for (const e of errors) {
    const stack = e.stack ? String(e.stack).split('\n').slice(1, 5).join('\n') : '';
    if (stack) line += '\n' + stack;
  }
  emit(level, line);
}

/**
 * 建一个 logger。传 `baseCtx` 后该 logger 的每一行都自动带上这些字段（如 `{ roomId }`）。
 * @param {object} [baseCtx]
 */
function createLogger(baseCtx) {
  const ctx = baseCtx || null;
  const api = {
    debug: (scope, msg, fields) => write('debug', scope, msg, fields, ctx),
    info: (scope, msg, fields) => write('info', scope, msg, fields, ctx),
    warn: (scope, msg, fields) => write('warn', scope, msg, fields, ctx),
    error: (scope, msg, fields) => write('error', scope, msg, fields, ctx),
    /** 派生带附加上下文的子 logger（不改动父 logger） */
    child: (more) => createLogger(Object.assign({}, ctx, more)),
  };
  return api;
}

const logger = createLogger();

/** 运行时改级别；返回是否设置成功（非法值返回 false 且不改动） */
function setLevel(name) {
  const level = parseLevel(name, null);
  if (!level) return false;
  state.levelName = level;
  return true;
}

function getLevel() { return state.levelName; }

/** 运行时改格式（'text' | 'json'）；非法值返回 false */
function setFormat(format) {
  const f = String(format == null ? '' : format).trim().toLowerCase();
  if (f !== 'text' && f !== 'json') return false;
  state.format = f;
  return true;
}

function getFormat() { return state.format; }

/** 注入输出函数 `(level, line) => void`；传 null 恢复默认（stdout/stderr） */
function setOutput(fn) { state.output = typeof fn === 'function' ? fn : null; }

/**
 * 调试打点（前端 `window.debugLog` 的服务端对等物）。
 *
 * 与 `log.debug` **同源同行为**（debug 级别，`LOG_LEVEL=info` 时静默），单独命名只为
 * **在代码里一眼分辨「这是排障打点」还是「常规运行日志」**——排障/重构时往往要临时加一批
 * 打点再删掉，用 `debugLog(` 一搜就能找全，不会和真正的日志混在一起。
 *
 * @param {string} scope 模块名，与 `log.*` 同义
 * @param {string} msg 描述
 * @param {object} [fields] 结构化字段（Error 用 `{ err }` 传）
 */
function debugLog(scope, msg, fields) { return logger.debug(scope, msg, fields); }

module.exports = {
  LEVELS,
  logger,
  createLogger,
  setLevel,
  getLevel,
  setFormat,
  getFormat,
  setOutput,
  debugLog,
  // 便捷转发：`require('./logger').info(...)` 直接用，无需先取 .logger
  debug: logger.debug,
  info: logger.info,
  warn: logger.warn,
  error: logger.error,
  child: logger.child,
};
