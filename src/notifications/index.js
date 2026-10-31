'use strict';

/**
 * notifications/ — 站内通知中心（1.7 WP5）。
 *
 * 只持久化「需要回访」的事件：好友申请、约战、异步长局轮次与结果。
 * 实时提示仍走原有 WS 事件；这里负责离线补课和未读徽标。
 */
const crypto = require('crypto');
const storage = require('../storage');

const EVENT_TYPES = new Set([
  'friend_request',
  'friend_accepted',
  'challenge_created',
  'challenge_answered',
  'corr_created',
  'corr_move',
  'corr_draw_offered',
  'corr_finished',
  'tournament_match_started',
]);

function nameOf(obj, fallback = '对手') {
  return String((obj && (obj.name || obj.id)) || fallback);
}

function resultText(result, detail) {
  if (detail) return detail;
  if (result === 'b') return '先手胜';
  if (result === 'w') return '後手胜';
  if (result === '-') return '和棋';
  return '对局结束';
}

/** 事件 → 通知标题/正文/跳转链接；未列入白名单的事件返回 null（不落库）。 */
function describe(type, d = {}) {
  switch (type) {
    case 'friend_request':
      return d.status === 'accepted'
        ? { title: '好友申请已通过', body: `${nameOf(d.from)} 已成为你的好友`, link: '/friends' }
        : { title: '新的好友申请', body: `${nameOf(d.from)} 请求加你为好友`, link: '/friends' };
    case 'friend_accepted':
      return { title: '好友申请已通过', body: `${nameOf(d.by)} 接受了你的好友申请`, link: '/friends' };
    case 'challenge_created':
      return { title: '收到约战', body: `${nameOf(d.from)} 向你发起约战`, link: '/friends' };
    case 'challenge_answered':
      return d.accepted
        ? { title: '约战已接受', body: `${nameOf(d.by)} 接受了你的约战`, link: '/friends' }
        : { title: '约战被拒绝', body: `${nameOf(d.by)} 拒绝了你的约战`, link: '/friends' };
    case 'corr_created':
      return { title: '新的异步对局', body: `${nameOf(d.from)} 邀请你进行异步对局`, link: '/correspondence' };
    case 'corr_move':
      return { title: '轮到你走子', body: `${nameOf(d.by)} 在异步对局中走了一步`, link: '/correspondence' };
    case 'corr_draw_offered':
      return { title: '对方提议和棋', body: `${nameOf(d.by)} 在异步对局中提议和棋`, link: '/correspondence' };
    case 'corr_finished':
      return {
        title: '异步对局结束',
        body: `对局结束：${resultText(d.result, d.resultDetail)}`,
        link: '/correspondence',
        dedupeKey: d.gameId ? `corr-finished:${d.gameId}` : null,
      };
    case 'tournament_match_started':
      return {
        title: '赛事对局开始',
        body: `${nameOf({ name: d.byName }, '对手')} 的赛事对局已开始`,
        link: d.tournamentId ? `/tournament?id=${encodeURIComponent(d.tournamentId)}` : '/tournaments',
        dedupeKey: d.roomId ? `tournament-match:${d.roomId}` : null,
      };
    default:
      return null;
  }
}

function create(playerId, { type, title, body = '', data = null, dedupeKey = null, createdAt = Date.now() } = {}) {
  if (!playerId || !type || !title) return null;
  const id = `n_${crypto.randomBytes(8).toString('hex')}`;
  const row = { id, playerId, type, title, body, data, dedupeKey, createdAt };
  const inserted = storage.putNotification(row);
  return inserted ? { ...row, read: false, readAt: null } : null;
}

/** WS/REST 事件入口：白名单事件才持久化。 */
function event(playerId, payload) {
  const type = payload && payload.type;
  if (!EVENT_TYPES.has(type)) return null;
  const d = (payload && payload.data) || {};
  const meta = describe(type, d);
  if (!meta) return null;
  return create(playerId, {
    type,
    title: meta.title,
    body: meta.body,
    data: { ...d, link: meta.link },
    dedupeKey: meta.dedupeKey || null,
  });
}

function list(playerId, opts) {
  return storage.listNotifications(playerId, opts);
}

function unread(playerId) {
  return storage.unreadNotificationCount(playerId);
}

module.exports = { EVENT_TYPES, describe, create, event, list, unread };
