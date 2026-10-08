/**
 * ratelimit.js — 内存滑动窗口限流（PLAN §Q7）
 *
 * 用途：登录 / 注册防爆破、REST 防刷、WS 消息防洪泛。
 *
 * 设计取舍：
 *  - **纯内存、零依赖**：与项目「单进程 Node + SQLite、无外部服务」的定位一致；
 *    重启即清零（对限流而言可接受）。
 *  - **固定窗口计数**：实现简单、内存极小；代价是窗口边界处可能瞬时放行约 2 倍请求，
 *    对「防爆破 / 防刷」这类场景完全够用。
 *  - **定期清理**：桶按 windowMs 过期，`prune()` 删除 2 个窗口未活动的键，避免 Map 无限增长。
 *
 * ⚠️ 部署提醒：限流键优先用 `req.clientIp`（见 src/net.js）。反代部署**必须**配置
 *    `TRUST_PROXY`，否则所有请求的 clientIp 都是反代地址，限流会把全体用户当成同一个 IP。
 *
 * 环境变量：`RATE_LIMIT_DISABLED=1` 可整体关闭（本地压测 / 排障用）。
 */
'use strict';

const log = require('./logger');

const DISABLED = process.env.RATE_LIMIT_DISABLED === '1';

class RateLimiter {
  /**
   * @param {{name?:string, windowMs?:number, max?:number}} opts
   *   windowMs 窗口长度（毫秒）；max 窗口内允许的请求数
   */
  constructor({ name = 'rl', windowMs = 60 * 1000, max = 60 } = {}) {
    this.name = name;
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map(); // key -> { start, count }
  }

  /**
   * 记一次请求。
   * @param {string} key 限流维度（IP / clientId / playerId…）
   * @param {number} cost 权重
   * @returns {{allowed:boolean, remaining:number, retryAfterMs:number}}
   */
  hit(key, cost = 1) {
    if (DISABLED) return { allowed: true, remaining: this.max, retryAfterMs: 0 };
    const now = Date.now();
    const k = String(key || 'unknown');
    let b = this.buckets.get(k);
    if (!b || now - b.start >= this.windowMs) {
      b = { start: now, count: 0 };
      this.buckets.set(k, b);
    }
    b.count += cost;
    const allowed = b.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - b.count),
      retryAfterMs: allowed ? 0 : (b.start + this.windowMs - now),
    };
  }

  /** 只查询当前额度，不计数（用于前端提示 / 调试） */
  peek(key) {
    const b = this.buckets.get(String(key || 'unknown'));
    if (!b || Date.now() - b.start >= this.windowMs) {
      return { allowed: true, remaining: this.max, retryAfterMs: 0 };
    }
    const remaining = Math.max(0, this.max - b.count);
    return { allowed: b.count <= this.max, remaining, retryAfterMs: remaining > 0 ? 0 : (b.start + this.windowMs - Date.now()) };
  }

  /** 立刻清空某键（如登录成功后清零失败计数） */
  reset(key) {
    this.buckets.delete(String(key || 'unknown'));
  }

  /** 清空全部（测试用） */
  clear() {
    this.buckets.clear();
  }

  /** 删除 2 个窗口未活动的桶，返回清理数 */
  prune(now = Date.now()) {
    let n = 0;
    for (const [k, b] of this.buckets) {
      if (now - b.start >= this.windowMs * 2) {
        this.buckets.delete(k);
        n += 1;
      }
    }
    return n;
  }

  get size() {
    return this.buckets.size;
  }
}

// ---------------- 预置限流器（按场景分档） ----------------

/** 客户端 IP（跟随 net.js 的 TRUST_PROXY 判定） */
function ipOf(req) {
  return (req && (req.clientIp || req.ip)) || (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

/** REST 全局兜底（宽松）：同 IP 每分钟上限——多用户共享出口 IP（NAT/校园网）下也不易误伤 */
const api = new RateLimiter({ name: 'api', windowMs: 60 * 1000, max: 600 });
/** 账号登录 / 注册：防密码爆破 */
const auth = new RateLimiter({ name: 'auth', windowMs: 5 * 60 * 1000, max: 20 });
/** 管理员登录：更严（WS admin_login 也用它） */
const adminLogin = new RateLimiter({ name: 'admin-login', windowMs: 10 * 60 * 1000, max: 8 });
/** 重查询（棋谱检索 / 全量列表）：防刷库 */
const heavy = new RateLimiter({ name: 'heavy', windowMs: 60 * 1000, max: 60 });
/** WS 单连接消息速率：正常对局远低于此值，仅拦「脚本刷消息」 */
const wsMsg = new RateLimiter({ name: 'ws-msg', windowMs: 1000, max: 40 });
/** WS 限流提示节流：超限后最多每 5 秒提示一次——否则「错误响应本身」会形成新的洪泛 */
const wsNotice = new RateLimiter({ name: 'ws-notice', windowMs: 5000, max: 1 });

const ALL = [api, auth, adminLogin, heavy, wsMsg, wsNotice];

/** 定期清理过期桶（unref：不阻止进程退出） */
const pruneTimer = setInterval(() => {
  let n = 0;
  for (const l of ALL) n += l.prune();
  if (n > 0 && process.env.RATE_LIMIT_DEBUG === '1') {
    log.info('ratelimit', `清理 ${n} 个过期桶`);
  }
}, 60 * 1000);
if (pruneTimer.unref) pruneTimer.unref();

/**
 * Express 中间件工厂。
 * @param {RateLimiter} limiter
 * @param {{keyFn?:(req)=>string, message?:string, cost?:number}} opts
 */
function expressMiddleware(limiter, { keyFn = ipOf, message = '请求过于频繁，请稍后再试', cost = 1 } = {}) {
  return function rateLimitMw(req, res, next) {
    const r = limiter.hit(keyFn(req), cost);
    if (r.allowed) return next();
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
    return res.status(429).json({ error: message, retryAfter: Math.ceil(r.retryAfterMs / 1000) });
  };
}

module.exports = {
  RateLimiter,
  expressMiddleware,
  ipOf,
  api,
  auth,
  adminLogin,
  heavy,
  wsMsg,
  wsNotice,
  limiters: { api, auth, adminLogin, heavy, wsMsg, wsNotice },
  DISABLED,
};
