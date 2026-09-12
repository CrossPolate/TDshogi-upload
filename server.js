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
const { requestId, adminEntryGate } = require('./src/http/middleware');
const registerPublic = require('./src/http/routes/public');
const registerRecords = require('./src/http/routes/records');
const registerAccounts = require('./src/http/routes/accounts');
const registerAdmin = require('./src/http/routes/admin');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

ensureDataDirs();

const app = express();
app.use(express.json());
// 客户端信息（IP/UA）地基，PLAN §M3：供 §K 的登录记录与管理员审计使用。
// 未配置 TRUST_PROXY 时不信任任何代理头——否则伪造 X-Forwarded-For 即可伪装 IP。
app.set('trust proxy', netInfo.trustProxySetting());
app.use(netInfo.attachClientInfo);
// 请求标识（PLAN §P4）：每个请求分配短 id（响应头 `X-Request-Id` + `req.log`）。
// 线上报错时用户只要报这个 id，就能在日志里直接定位到那一次请求。
app.use(requestId);
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
registerAdmin(app);

// ==================================================================
// WebSocket（与 HTTP 同端口）
// ==================================================================
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // 解析 guestId（从查询参数）
  const url = new URL(req.url, `http://${req.headers.host}`);
  const guestId = url.searchParams.get('guest') || null;
  // 传入客户端 IP/UA（PLAN §K1：登录记录与管理员审计的数据来源）
  protocol.handleConnection(ws, guestId, netInfo.clientInfo(req));
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
  // 清理过期的登录/审计日志（保留期与容量上限见 src/audit.js）
  try {
    const pruned = audit.prune();
    if (pruned.expired || pruned.overflow) {
      log.info('audit', `清理日志：过期 ${pruned.expired} 条，超出容量 ${pruned.overflow} 条，保留 ${pruned.kept} 条`);
    }
  } catch (err) {
    log.error('audit', '日志清理失败', { err });
  }
  // 恢复上次运行未结束的对局（快照重启恢复）
  const restored = protocol.rooms.restoreSnapshots();
  if (restored > 0) log.info('rooms', `已恢复 ${restored} 场未完成对局`);
});
