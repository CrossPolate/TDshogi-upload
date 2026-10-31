'use strict';

/**
 * mail/ — 1.7 邮箱验证 / 密码找回（服务端）。
 *
 * 安全约定：
 *  - 令牌只在数据库存 SHA-256，不存明文；单次使用、30 分钟/24 小时过期；
 *  - 找回接口对“不存在/未验证/无邮箱”返回同一句提示，避免账号枚举；
 *  - 没有 SMTP 配置时明确返回 MAIL_UNAVAILABLE，不影响管理员重置密码兜底；
 *  - 重置成功后由 accounts.resetPassword 递增 tokenInvalidBefore，旧会话全部失效。
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const accounts = require('../accounts');
const storage = require('../storage');
const log = require('../logger');

const RESET_TTL_MS = 30 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || '';
const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT) || 587;
const SECURE = String(process.env.SMTP_SECURE || '') === '1' || PORT === 465;

let transporter = null;
function configured() {
  return !!(HOST && FROM);
}
function transport() {
  if (!configured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: SECURE,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    });
  }
  return transporter;
}
function baseUrl() {
  return String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function makeToken(accountId, purpose, ttl) {
  storage.deleteAccountTokens(accountId, purpose);
  const token = crypto.randomBytes(32).toString('base64url');
  storage.putAccountToken({
    id: crypto.randomBytes(8).toString('hex'),
    accountId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: Date.now() + ttl,
    createdAt: Date.now(),
  });
  return token;
}
function consume(token) {
  if (!token) return null;
  const row = storage.getAccountToken(hashToken(token));
  if (!row || row.usedAt || row.expiresAt <= Date.now()) return null;
  if (!storage.useAccountToken(row.id)) return null;
  return row;
}
async function send(to, subject, text) {
  const t = transport();
  if (!t) throw Object.assign(new Error('邮件服务未配置'), { code: 'MAIL_UNAVAILABLE' });
  await t.sendMail({ from: FROM, to, subject, text });
}

async function requestEmailVerification(accountId, email) {
  if (!configured()) return { ok: false, code: 'MAIL_UNAVAILABLE', error: '邮件服务未配置，请联系管理员' };
  const set = accounts.setEmail(accountId, email);
  if (!set.ok) return set;
  const token = makeToken(accountId, `verify-email:${set.email}`, VERIFY_TTL_MS);
  const link = `${baseUrl()}/profile?emailToken=${encodeURIComponent(token)}`;
  try {
    await send(set.email, 'TDShogi 邮箱验证', `请打开以下链接验证邮箱（24 小时内有效）：\n${link}\n\n若不是你本人操作，请忽略本邮件。`);
  } catch (e) {
    log.warn('mail', '邮箱验证邮件发送失败', { err: e.message });
    return { ok: false, code: e.code || 'MAIL_FAILED', error: '邮件发送失败，请稍后重试' };
  }
  return { ok: true, email: set.email };
}

function verifyEmail(token) {
  const row = consume(token);
  if (!row || !String(row.purpose).startsWith('verify-email:')) return { ok: false, code: 'BAD_TOKEN', error: '验证链接无效或已过期' };
  const email = String(row.purpose).slice('verify-email:'.length);
  const r = accounts.markEmailVerified(row.accountId, email);
  return r.ok ? { ok: true, email } : { ok: false, code: 'EMAIL_CHANGED', error: r.error };
}

async function requestPasswordReset(identifier) {
  if (!configured()) return { ok: false, code: 'MAIL_UNAVAILABLE', error: '邮件服务未配置，请联系管理员' };
  const raw = String(identifier || '').trim();
  const byName = accounts.getAccountByName(raw);
  const byEmail = accounts.findAccountByEmail(raw);
  const acct = byName || byEmail;
  // 统一提示：不区分“不存在 / 未绑定邮箱 / 未验证”
  if (!acct) return { ok: true };
  const info = accounts.getEmailInfo(acct.id);
  if (!info || !info.email || !info.verified) return { ok: true };
  const token = makeToken(acct.id, 'reset-password', RESET_TTL_MS);
  const link = `${baseUrl()}/reset?token=${encodeURIComponent(token)}`;
  try {
    await send(info.email, 'TDShogi 密码重置', `请打开以下链接重置密码（30 分钟内有效，仅可使用一次）：\n${link}\n\n若不是你本人操作，请忽略本邮件。`);
  } catch (e) {
    log.warn('mail', '密码重置邮件发送失败', { err: e.message });
    return { ok: false, code: e.code || 'MAIL_FAILED', error: '邮件发送失败，请稍后重试' };
  }
  return { ok: true };
}

function resetPassword(token, newPassword) {
  const row = consume(token);
  if (!row || row.purpose !== 'reset-password') return { ok: false, code: 'BAD_TOKEN', error: '重置链接无效或已过期' };
  const r = accounts.resetPassword(row.accountId, newPassword);
  return r.ok ? { ok: true, accountId: row.accountId } : { ok: false, code: 'BAD_PASSWORD', error: r.error };
}

module.exports = {
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  configured,
  requestEmailVerification,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
};
