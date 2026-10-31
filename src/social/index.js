'use strict';

/**
 * social/ — 1.7 好友 / 关注 / 拉黑 / 约战。
 *
 * 关系只存账号 id；昵称/头像/在线状态由路由层补。所有写入都做「双向拉黑」检查。
 * 约战接受后由路由层用现有 rooms.createRoom 建房，并把 roomId/code 记回挑战。
 */

const crypto = require('crypto');
const storage = require('../storage');
const { TIME_CONTROLS } = require('../rooms/config');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function blocked(a, b) {
  return !!(storage.getBlock(a, b) || storage.getBlock(b, a));
}

function listFriends(playerId) {
  const rows = storage.listFriendships(playerId);
  return rows.map((r) => {
    const other = r.a === playerId ? r.b : r.a;
    return {
      id: other,
      status: r.status,
      incoming: r.status === 'pending' && r.b === playerId,
      updatedAt: r.updatedAt,
    };
  });
}

function requestFriend(from, to) {
  if (!from || !to) return { ok: false, code: 'BAD_ID', error: '缺少用户' };
  if (from === to) return { ok: false, code: 'SELF', error: '不能加自己为好友' };
  if (blocked(from, to)) return { ok: false, code: 'BLOCKED', error: '无法添加该用户' };
  const forward = storage.getFriendship(from, to);
  const reverse = storage.getFriendship(to, from);
  if (forward && forward.status === 'accepted') return { ok: true, status: 'accepted' };
  if (reverse && reverse.status === 'accepted') return { ok: true, status: 'accepted' };
  if (forward && forward.status === 'pending') return { ok: true, status: 'pending' };
  // 对方已申请、自己再申请 = 互相接受
  if (reverse && reverse.status === 'pending') {
    storage.putFriendship(to, from, 'accepted');
    return { ok: true, status: 'accepted' };
  }
  storage.putFriendship(from, to, 'pending');
  return { ok: true, status: 'pending' };
}

function respondFriend(actor, from, accept) {
  if (!from || from === actor) return { ok: false, code: 'BAD_ID', error: '好友申请不存在' };
  const row = storage.getFriendship(from, actor);
  if (!row || row.status !== 'pending') return { ok: false, code: 'NO_REQUEST', error: '好友申请不存在' };
  if (accept) {
    storage.putFriendship(from, actor, 'accepted');
    return { ok: true, status: 'accepted' };
  }
  storage.deleteFriendship(from, actor);
  return { ok: true, status: 'rejected' };
}

function removeFriend(actor, target) {
  if (!target) return { ok: false, error: '缺少用户' };
  storage.deleteFriendship(actor, target);
  return { ok: true };
}

function follow(actor, target) {
  if (!actor || !target) return { ok: false, error: '缺少用户' };
  if (actor === target) return { ok: false, error: '不能关注自己' };
  if (blocked(actor, target)) return { ok: false, code: 'BLOCKED', error: '无法关注该用户' };
  storage.putFollow(actor, target);
  return { ok: true };
}

function unfollow(actor, target) {
  storage.deleteFollow(actor, target);
  return { ok: true };
}

function block(actor, target) {
  if (!actor || !target || actor === target) return { ok: false, error: '缺少用户' };
  storage.putBlock(actor, target);
  storage.deleteFriendship(actor, target);
  storage.deleteFollow(actor, target);
  storage.deleteFollow(target, actor);
  // 双向待处理约战一并取消
  for (const c of storage.listChallenges(actor)) {
    const pair = (c.fromId === actor && c.toId === target) || (c.fromId === target && c.toId === actor);
    if (pair && c.status === 'pending') storage.deleteChallenge(c.id);
  }
  return { ok: true };
}

function unblock(actor, target) {
  storage.deleteBlock(actor, target);
  return { ok: true };
}

function followInfo(actor) {
  return {
    following: storage.listFollowing(actor),
    followers: storage.listFollowers(actor),
    blocked: storage.listBlocks(actor),
  };
}

function createChallenge(from, to, timeControl) {
  if (!from || !to || from === to) return { ok: false, code: 'BAD_ID', error: '缺少约战对象' };
  if (!TIME_CONTROLS[timeControl]) return { ok: false, code: 'BAD_TIME', error: '时间制不合法' };
  if (blocked(from, to)) return { ok: false, code: 'BLOCKED', error: '无法约战该用户' };
  const existing = storage.listChallenges(from)
    .find((c) => c.status === 'pending' && ((c.fromId === from && c.toId === to) || (c.fromId === to && c.toId === from)));
  if (existing) return { ok: true, challenge: existing };
  const now = Date.now();
  const challenge = {
    id: `ch_${crypto.randomBytes(6).toString('hex')}`,
    fromId: from,
    toId: to,
    timeControl,
    handicap: null,
    rated: 0,
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    status: 'pending',
    roomId: null,
    code: null,
  };
  storage.putChallenge(challenge);
  return { ok: true, challenge };
}

function respondChallenge(actor, id, accept) {
  const c = storage.getChallenge(id);
  if (!c || c.toId !== actor) return { ok: false, code: 'NO_CHALLENGE', error: '约战不存在' };
  if (c.status !== 'pending') return { ok: false, code: 'NOT_PENDING', error: '约战已处理' };
  if (c.expiresAt <= Date.now()) {
    storage.deleteChallenge(id);
    return { ok: false, code: 'EXPIRED', error: '约战已过期' };
  }
  if (!accept) {
    storage.deleteChallenge(id);
    return { ok: true, accepted: false, challenge: c };
  }
  return { ok: true, accepted: true, challenge: c };
}

function acceptChallengeRoom(id, roomId, code) {
  storage.markChallengeAccepted(id, roomId, code);
}

function listChallenges(actor) {
  return storage.listChallenges(actor).map((c) => ({
    id: c.id,
    fromId: c.fromId,
    toId: c.toId,
    timeControl: c.timeControl,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    status: c.status,
    roomId: c.roomId || null,
    code: c.code || null,
    incoming: c.toId === actor,
  }));
}

module.exports = {
  CHALLENGE_TTL_MS,
  listFriends,
  isBlocked: blocked,
  requestFriend,
  respondFriend,
  removeFriend,
  follow,
  unfollow,
  block,
  unblock,
  followInfo,
  createChallenge,
  respondChallenge,
  acceptChallengeRoom,
  listChallenges,
};
