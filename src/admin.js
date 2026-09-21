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
  const expected = getPassword();
  if (String(password || '') === expected) {
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

module.exports = { login, verify };
