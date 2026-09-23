/**
 * server.js — TDShogi 服务端入口
 *
 * 单进程运行：Express（REST + 静态资源）+ ws（WebSocket）同端口。
 * 启动：npm start 或 node server.js（端口可用 PORT 环境变量覆盖，默认 3000）。
 *
 * ⚠️ **§M2 拆分（2026-09-12）**：本文件由 592 行拆到 ~120 行，只负责**组装**，不再定义业务路由。
 * 拆分原因：45 条路由 + 鉴权包装 + 通用工具混在一个文件里，改一处鉴权要在其中翻半天；
 * 更糟的是新增管理接口时**看不到**别人怎么写的校验，很容易又抄一份——
 * 那正是 §Q7-1「越权」这个错误类别的复现路径。
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `src/http/context.js`    | `protocol` 单例、`VERSION`、通用工具（`resolvePlayer`/`sanitize`/`checkAdmin`） |
 * | `src/http/middleware.js` | `requestId`（§P4）/ 入口门禁（§J5）/ `adminOnly` / `adminWrite` / `tournamentAction` |
 * | `src/http/routes/public.js`   | 首页 / 大厅 / 个人 / 玩家卡 / 赛事列表 / 棋谱广场 |
 * | `src/http/routes/records.js`  | 棋谱导出 / 回放 / 复盘 / 检索 / 书签 / 评论 / 变着 |
 * | `src/http/routes/accounts.js` | 注册 / 登录 / 令牌校验 / 个人资料 |
 * | `src/http/routes/admin.js`    | 用户管理 / 审计 / 棋谱导入与元数据 / 赛事审核 |
 */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { ensureDataDirs } = require('./src/storage');
const netInfo = require('./src/net');
const audit = require('./src/audit');
const rateLimit = require('./src/ratelimit');
const log = require('./src/logger');
const { protocol, VERSION } = require('./src/http/context');
const { requestId, securityHeaders, adminEntryGate, ipBanGate } = require('./src/http/middleware');
const registerPublic = require('./src/http/routes/public');
const registerRecords = require('./src/http/routes/records');
const registerAccounts = require('./src/http/routes/accounts');
const registerTournaments = require('./src/http/routes/tournaments');
const registerAdmin = require('./src/http/routes/admin');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

ensureDataDirs();

const app = express();
// 安全响应头（§Q7）：挂在**最前**，保证静态资源、API、错误响应都带上。
app.use(securityHeaders);
app.use(express.json());
// 客户端信息（IP/UA）地基，PLAN §M3：供 §K 的登录记录与管理员审计使用。
// 未配置 TRUST_PROXY 时不信任任何代理头——否则伪造 X-Forwarded-For 即可伪装 IP。
app.set('trust proxy', netInfo.trustProxySetting());
app.use(netInfo.attachClientInfo);
// 请求标识（PLAN §P4）：每个请求分配短 id（响应头 `X-Request-Id` + `req.log`）。
// 线上报错时用户只要报这个 id，就能在日志里直接定位到那一次请求。
app.use(requestId);
// IP 封禁门（PLAN §X4 第一个生效点）。位置是刻意的：
//  - 在 `requestId` 之后 → 被封的请求也能带上 requestId，用户报障时可对账；
//  - 在**限流之前** → 被封的 IP 不该继续消耗限流计数，也不该污染限流统计。
// ⚠️ 这里只挡 HTTP；WS 那侧在同文件的 `verifyClient` 拦，两处都要有。
app.use(ipBanGate);
// 速率限制（PLAN §Q7）：/api 全局兜底（宽松，默认 600 次/分钟/IP），
// 登录与重查询在各自路由上再叠加更严的档位。
// ⚠️ 限流键为 clientIp（遵守 TRUST_PROXY）——反代部署若未配置 TRUST_PROXY，
//    所有请求会被视作同一个 IP，务必按 DEPLOY.md 配置。
app.use('/api', rateLimit.expressMiddleware(rateLimit.api));
// 管理后台入口门禁（PLAN §J5，见 middleware.adminEntryGate）
app.use(adminEntryGate);
// 静态资源禁用强缓存（协商缓存）：防止服务进程与磁盘文件版本错位时
// 浏览器还拿着旧脚本（实机『感想战瘫痪』类问题的环境性根因）
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ==================================================================
// REST 路由装配（PLAN §M2 按域拆分）
// ==================================================================
// 顺序不影响 Express 的路径匹配（按 method + path 精确匹配），这里按
// 「公开 → 棋谱 → 账号 → 管理」排列，便于阅读与排查。
registerPublic(app);
registerRecords(app);
registerAccounts(app);
registerTournaments(app); // T3/T6：赛事管理（报名审批 / 踢人 / 开赛 / 取消成绩 / 重赛裁决）
registerAdmin(app);

// ==================================================================
// WebSocket（与 HTTP 同端口）
// ==================================================================
const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  // 单条消息体积上限（2026-09-21 审查 P2-2）：ws 默认 100 MiB，而本项目最大的客户端消息
  // 也就几十字节（走法/聊天/建房参数），64 KB 已经宽得离谱。留着默认值等于给"发一个巨大帧
  // 把内存吃满"留门（限流只限制**频率**，不限制**单帧体积**）。
  maxPayload: 64 * 1024,
  // IP 封禁的**第二个生效点**（PLAN §X4）：在握手阶段就拒绝。
  //
  // ⚠️ 少了这里就是**假封禁**：WS 才是对局主通道，只挡 HTTP 的话，
  // 被封的 IP 照样能连上、照样能下棋——只是刷不出页面而已（看起来"封了"）。
  verifyClient: (info) => {
    try {
      const ip = netInfo.clientIp(info.req);
      const r = require('./src/ipban').check(ip);
      if (r.banned) {
        log.warn('ipban', '拒绝已封禁 IP 的 WebSocket 握手', { ip, reason: r.record.reason });
        return false;
      }
    } catch (err) {
      // 判定本身出错时**放行**：宁可漏封，也不能因为一个异常把所有人挡在 WS 外面
      log.error('ipban', 'WS 握手封禁判定异常，已放行', { err });
    }
    return true;
  },
});

/**
 * 单 IP 并发 WS 连接上限（2026-09-21 审查 P2-6）。
 *
 * ⚠️ 现有两道防护都**不管这件事**：限流只管"消息频率"，IP 封禁只管"黑名单"。
 * 于是单个 IP 可以开上万个连接把内存/文件描述符吃光（连上不发消息就完全不触发限流）。
 * 上限给得宽松（正常浏览器最多几个标签页；多人共用出口 IP 的 NAT/公司网络也够用），
 * 目的是"存在一个天花板"，不是精确治理。可用 `WS_MAX_CONN_PER_IP` 调整。
 */
const WS_MAX_CONN_PER_IP = Math.max(1, Number(process.env.WS_MAX_CONN_PER_IP) || 60);
const wsConnsByIp = new Map();

wss.on('connection', (ws, req) => {
  // ⚠️⚠️ 握手回调**必须整体兜住异常**（2026-09-21 安全审查 P0-1，已实测复现）：
  // 这里的任何抛出都没有人接 —— Node 视为 uncaughtException 直接**退出进程**，
  // 全部在线对局一起断线。而触发它只需要一条畸形消息或一个畸形请求头：
  //   ① `new URL(req.url, 'http://' + req.headers.host)`：畸形 Host（如 `a b`）抛 ERR_INVALID_URL；
  //   ② `handleConnection` 内部解析 guest 令牌时抛错（见 `accounts.verifyToken` 的字节长度坑）。
  let ip = 'unknown';
  try { ip = netInfo.clientIp(req) || 'unknown'; } catch (_) { /* 取不到就算 unknown */ }
  // 并发连接计数（同一 IP 复用出口时也该有个天花板）
  const used = (wsConnsByIp.get(ip) || 0) + 1;
  if (used > WS_MAX_CONN_PER_IP) {
    log.warn('ws', '同一 IP 并发连接超限，拒绝新连接', { ip, used, limit: WS_MAX_CONN_PER_IP });
    try { ws.close(1013, 'too many connections'); } catch (_) { /* 忽略 */ }
    return; // ⚠️ 不计数、也不进入协议层
  }
  wsConnsByIp.set(ip, used);
  let released = false;
  const release = () => {
    if (released) return; // close 与 error 都会来，只能减一次
    released = true;
    const cur = (wsConnsByIp.get(ip) || 1) - 1;
    if (cur <= 0) wsConnsByIp.delete(ip); else wsConnsByIp.set(ip, cur);
  };
  ws.on('close', release);
  ws.on('error', release);

  try {
    // 解析 guestId（从查询参数）。⚠️ **不信任 Host**：畸形 Host 会让 new URL 抛错，
    // 而 Host 在这里只用来凑基地址（req.url 本身是绝对路径），固定 localhost 即可。
    const url = new URL(req.url, 'http://localhost');
    const guestId = url.searchParams.get('guest') || null;
    // 传入客户端 IP/UA（PLAN §K1：登录记录与管理员审计的数据来源）
    protocol.handleConnection(ws, guestId, netInfo.clientInfo(req));
  } catch (err) {
    log.error('ws', 'WS 握手异常，仅拒绝该连接', { err: err && err.message });
    try { ws.close(); } catch (_) { /* 忽略 */ }
  }
});

// ---- 最后一道保险（2026-09-21 安全审查 P0-1）----
// 已知的两个崩溃向量已按"逐个入口兜住"修掉，但这类漏口永远是"下一个还在路上"。
// 对**单进程**游戏服来说，"单个请求把全站打崩"的代价远大于"这一个请求处理失败"，
// 所以再加一道进程级兜底：记日志、保持存活。
// ⚠️ 这是保险而**不是替代品**：新代码仍必须自己 try/catch（走到这里时状态可能已不一致）。
process.on('uncaughtException', (err) => {
  log.error('process', '未捕获异常（已兜住，进程继续运行）',
    { err: err && err.stack ? String(err.stack).split('\n')[0] : String(err) });
});
process.on('unhandledRejection', (err) => {
  log.error('process', '未处理的 Promise 拒绝（已兜住）', { err: err && err.message ? err.message : String(err) });
});

server.listen(PORT, () => {
  // 启动横幅（PLAN §P4）：走 logger 后与其余日志同一格式（带时间戳与级别，LOG_FORMAT=json 时为 JSON 行）
  log.info('server', `TDShogi server v${VERSION} running at http://localhost:${PORT}`);
  log.info('server', `WebSocket listening on ws://localhost:${PORT}/ws`);
  // 注：棋谱摘要列回填已在 storage 初始化时完成（PLAN §Q7-2，见 src/storage.js initDb）
  // 数据库每日自动备份（PLAN §Q7-4）：全部资产在一个 SQLite 里，没有备份等于没保险。
  // 启动时补一次（今天没备过才备）+ 每 6 小时检查；失败只记日志，绝不影响对局服务。
  try {
    require('./src/backup').startAutoBackup();
  } catch (err) {
    log.error('backup', '自动备份启动失败', { err });
  }
  // 游客数据清理（PLAN §U5）：超期未登录的游客会话，及其"双方皆为游客"的棋谱。
  // ⚠️ 删除不可逆——首次上线建议先用 `CLEANUP_DRY_RUN=1` 启动一次，看清清单再放开。
  try {
    require('./src/cleanup').startAutoCleanup();
  } catch (err) {
    log.error('cleanup', '游客清理启动失败', { err });
  }
  // 清理过期的登录/审计日志（保留期与容量上限见 src/audit.js）
  try {
    const pruned = audit.prune();
    if (pruned.expired || pruned.overflow) {
      log.info('audit', `清理日志：过期 ${pruned.expired} 条，超出容量 ${pruned.overflow} 条，保留 ${pruned.kept} 条`);
    }
  } catch (err) {
    log.error('audit', '日志清理失败', { err });
  }
  // 赛事赛后自动存档（T6/需求 11）：启动补一次（进程重启期间可能已过窗口）+ 每小时检查。
  // ⚠️ 放在 listen 回调里、与其他定时器同处——放模块顶层会在 **require 时**就跑，
  // 那时数据库/缓存还没初始化，也违背"服务真正起来后再开定时器"的语义。
  try {
    const tournaments = require('./src/tournaments');
    tournaments.autoArchiveDue();
    const archiveTimer = setInterval(() => {
      try { tournaments.autoArchiveDue(); } catch (err) { log.error('tournament', '自动存档失败', { err }); }
    }, 3600 * 1000);
    if (archiveTimer.unref) archiveTimer.unref(); // 不阻止进程退出
  } catch (err) {
    log.error('tournament', '自动存档定时器启动失败', { err });
  }
  // 恢复上次运行未结束的对局（快照重启恢复）
  const restored = protocol.rooms.restoreSnapshots();
  if (restored > 0) log.info('rooms', `已恢复 ${restored} 场未完成对局`);
});
