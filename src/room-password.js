/**
 * room-password.js — 私人房间密码的哈希与校验（PLAN §T2）
 *
 * 单独成模块的理由：这是**纯函数**，可以脱离 `RoomManager` 直接单测。
 * 密码属于安全相关逻辑，不该埋在 1787 行的 `rooms.js` 里靠人肉检查——
 * 抽出来之后，正确性由 `tests/room-password.test.js` 守住。
 */
'use strict';

const crypto = require('crypto');

/** 密码长度约束（留空 = 不设密码，是允许的） */
const MIN = 4;
const MAX = 8;

/**
 * 哈希：sha256 + 随机盐。
 *
 * **刻意不用 scrypt / bcrypt**：慢哈希是为了防「拿到 hash 之后离线暴力破解」，
 * 而房间密码的 hash 只存在于服务端内存（快照也是短命数据），攻击者拿不到它；
 * 反过来 `scryptSync` 会阻塞事件循环 50–100ms，建房/加房会让**所有人的走子**卡一下。
 * 权衡：门禁类密码用快哈希即可，账号凭证才值得慢哈希。
 */
function hash(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  return `${salt}:${crypto.createHash('sha256').update(salt + String(pw)).digest('hex')}`;
}

/**
 * 校验密码。
 * @param {string|null} stored 房间保存的 `salt:hash`；为空表示房间未设密码 → **一律通过**
 * @param {string} pw 客户端提交的明文密码
 */
function verify(stored, pw) {
  if (!stored) return true; // 未设密码
  if (typeof pw !== 'string' || !pw) return false;
  const parts = String(stored).split(':');
  const salt = parts[0];
  const want = parts[1] || '';
  const got = crypto.createHash('sha256').update(salt + pw).digest('hex');
  // 先比长度：timingSafeEqual 对长度不等的 Buffer 会直接抛错
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** 长度是否合法（留空视为「不设密码」，属合法） */
function isValid(pw) {
  if (!pw) return true;
  const s = String(pw);
  return s.length >= MIN && s.length <= MAX;
}

module.exports = { hash, verify, isValid, MIN, MAX };
