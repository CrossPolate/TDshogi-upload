/**
 * admin.js — 管理员鉴权
 *
 * 管理员通过"管理密码"登录，换取短期签名 token（HMAC-SHA256）。
 * 携带 token 的请求可访问管理接口（全部棋谱 / 全部用户数据）。
 *
 * 管理密码来源（优先级从高到低）：
 *   1. 环境变量 ADMIN_PASSWORD
 *   2. data/admin.json 的 password 字段（首启自动生成时会写这里）
 *   3. **首启生成随机口令并在启动日志里打印一次**
 *      ⚠️ 原先这里写着「3. 内置密码 'Cplusplus123'，可直接用」——2026-09-21 安全审查（P1-2）
 *      实测：任何忘记配置的部署＝后台完全沦陷（封人/删号/看手机号与 IP）。
 *      固定默认口令等于没有口令，已删除。
 *
 * 普通用户（未登录管理员）只能访问自己的数据。
 */
'use strict';

const crypto = require('crypto');
const { readJson, writeJson } = require('./storage');
const log = require('./logger');

const TOKEN_TTL = 12 * 60 * 60 * 1000; // 12 小时

function getPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const cfg = readJson('admin.json', null);
  if (cfg && cfg.password) return cfg.password;
  // ⚠️ 不再回落到源码里的固定默认口令（2026-09-21 安全审查 P1-2）：
  // 改为首启生成随机口令、持久化，并**在启动日志里打印一次**（运维从这里取）。
  const pw = crypto.randomBytes(9).toString('base64url');
  writeJson('admin.json', { password: pw, createdAt: Date.now() });
  log.warn('security',
    `未配置 ADMIN_PASSWORD，已生成随机管理口令并写入 data/admin.json（仅本次打印）：${pw}`);
  return pw;
}

/**
 * token 签名密钥：环境变量优先；否则**随机生成并持久化**。
 *
 * ⚠️ 原实现是 `ADMIN_SECRET || 'tdshogi_admin_secret:' + getPassword()` —— 从口令**派生**
 * 意味着只要口令弱（尤其原先那个内置默认值），任何人拿到源码就能**离线伪造管理员 token**。
 * 审查实测：不登录、仅用源码常量即可 200 访问 `/api/admin/overview`（P1-2）。
 * 现在与口令彻底解耦，且用随机字节。
 */
function secret() {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET;
  const saved = readJson('admin-secret.json', null);
  if (saved && saved.key) return saved.key;
  const key = crypto.randomBytes(32).toString('hex');
  writeJson('admin-secret.json', { key, createdAt: Date.now() });
  log.warn('security', '未配置 ADMIN_SECRET，已自动生成随机密钥并持久化到 data/admin-secret.json');
  return key;
}

/**
 * 校验管理密码，正确则返回带有效期的 token。
 * @param {string} password
 * @returns {{ok:true, token:string}|{ok:false, error:string}}
 */
function login(password) {
  const expected = String(getPassword());
  const given = String(password || '');
  // ⚠️ 2026-10-04：共享管理口令原用 `===` 比较，会在首个不同字符处短路 → 时序侧信道
  // （可逐字符爆破）。参照 accounts.verifyPassword：先把两侧按**字节**填到等长再
  // crypto.timingSafeEqual 常量时间比较，长度不等一律判失败。
  const ea = Buffer.from(given);
  const eb = Buffer.from(expected);
  const len = Math.max(ea.length, eb.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ea.copy(pa);
  eb.copy(pb);
  let same = false;
  try {
    same = crypto.timingSafeEqual(pa, pb) && ea.length === eb.length;
  } catch (_) {
    same = false;
  }
  if (same) {
    const payload = `admin:${Date.now()}`;
    const sig = sign(payload);
    return { ok: true, token: `${payload}.${sig}` };
  }
  return { ok: false, error: '管理密码错误' };
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

/**
 * 校验管理员 token。
 * @param {string|null} token
 * @returns {boolean}
 */
function verify(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  // ⚠️ 同 `accounts.verifyToken` 的 P0-1：`sig.length` 是 UTF-16 字符数、`Buffer.from(sig)`
  // 是 UTF-8 字节数，多字节签名会让 `timingSafeEqual` 抛 RangeError。
  // 这里虽然由 `checkAdmin` 调用（在 Express 回调里，异常由 Express 兜住、不会崩进程），
  // 但**同一类错误在别处就会崩**，所以一并按"64 位小写 hex 白名单 + try/catch"收紧。
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig) || sig.length !== expected.length) {
    return false;
  }
  let same = false;
  try {
    same = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
  if (!same) return false;
  // 校验有效期
  const m = /^admin:(\d+)$/.exec(payload);
  if (!m) return false;
  const ts = parseInt(m[1], 10);
  if (Date.now() - ts > TOKEN_TTL) return false;
  return true;
}

/**
 * 从**已校验通过**的管理员 token 里取出「哪一次管理员登录」的等价标识（审计 `adminId` 用）。
 *
 * ⚠️ 2026-10-02 体验修复（问题 2「审计记录带上 adminId」）：`audit.adminAction()` 一直支持
 * `adminId`，但**没有任何调用方传值** → 审计里恒为 `null`，"谁做的"永远查不出来
 * （后台"操作审计"页只能看到一句 IP）。本项目的管理身份是**单一管理口令**（无多账号体系），
 * 所以能作为等价标识的就是"会话"：token 的 payload 形如 `admin:<签发时间戳>`。
 *
 * 取舍与兼容性：
 *  - 同一次登录的所有写操作拿到同一个 id，可据此按会话追责/关联；换一次登录就是新 id；
 *  - **只取 payload，绝不包含 HMAC 签名**——审计在后台可查，把完整 token 写进去
 *    等于把管理员凭证存进了明文日志（那是比"查不到谁做的"严重得多的问题）；
 *  - 老事件没有该字段（历史数据 `adminId` 为 null），出口无需改动即可照常显示。
 *
 * @param {string|null} token 已通过 `verify()` 的 token
 * @returns {string|null} 形如 `admin:1759400000000`；无法解析时返回 null（不伪造身份）
 */
function tokenIdentity(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  const payload = dot > 0 ? token.slice(0, dot) : token;
  const m = /^admin:(\d+)$/.exec(payload);
  return m ? `admin:${m[1]}` : null;
}

module.exports = { login, verify, tokenIdentity };
