/**
 * admin.js — 管理员鉴权
 *
 * 管理员通过"管理密码"登录，换取短期签名 token（HMAC-SHA256）。
 * 携带 token 的请求可访问管理接口（全部棋谱 / 全部用户数据）。
 *
 * 管理密码来源（优先级从高到低）：
 *   1. 环境变量 ADMIN_PASSWORD
 *   2. data/admin.json 的 password 字段
 *   3. 内置密码 'Cplusplus123'（可直接用；生产建议仍用环境变量覆盖为更强密码）
 *
 * 普通用户（未登录管理员）只能访问自己的数据。
 */
'use strict';

const crypto = require('crypto');
const { readJson } = require('./storage');

const TOKEN_TTL = 12 * 60 * 60 * 1000; // 12 小时

function getPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const cfg = readJson('admin.json', null);
  if (cfg && cfg.password) return cfg.password;
  return 'Cplusplus123';
}

/**
 * token 签名密钥：优先环境变量；未配置时从管理密码派生。
 * 不能用源码里的固定默认值——否则任何拿到源码的人都能伪造管理员 token。
 */
function secret() {
  return process.env.ADMIN_SECRET || `tdshogi_admin_secret:${getPassword()}`;
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
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return false;
  }
  // 校验有效期
  const m = /^admin:(\d+)$/.exec(payload);
  if (!m) return false;
  const ts = parseInt(m[1], 10);
  if (Date.now() - ts > TOKEN_TTL) return false;
  return true;
}

module.exports = { login, verify };
