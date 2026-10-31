'use strict';

/**
 * routes/social.js — 好友 / 关注 / 拉黑 / 约战（1.7）。
 *
 * 所有接口只接受**账号令牌**（resolveAccount）；关系表只存账号 id。
 * 约战接受时用现有 rooms.createRoom 建房，不另写对局状态机。
 */

const features = require('../../features');
const social = require('../../social');
const accounts = require('../../accounts');
const auth = require('../../auth');
const rateLimit = require('../../ratelimit');
const { protocol, resolveAccount } = require('../context');

function profileOf(id) {
  const s = auth.load(id);
  if (s) return { id, name: s.name || id, avatar: s.avatar || null };
  const a = accounts.getAccount(id);
  return a ? { id, name: a.nickname || a.username || id, avatar: null } : { id, name: id, avatar: null };
}

function resolveTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return accounts.getAccount(s) || accounts.getAccountByName(s) || null;
}

function firstClient(playerId) {
  const set = protocol.playerToClients.get(playerId);
  if (!set) return null;
  for (const clientId of set) {
    if (protocol.playerRegistry.has(clientId)) return clientId;
  }
  return null;
}

module.exports = function registerSocial(app) {
  const gate = (res) => {
    if (!features.isOn('social')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '好友功能尚未开放' });
      return false;
    }
    return true;
  };
  const actorOf = (req) => resolveAccount(req);

  app.get('/api/social/overview', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const friends = social.listFriends(actor).map((f) => ({
      ...f,
      profile: profileOf(f.id),
      online: protocol.playerToClients.has(f.id),
    }));
    const follow = social.followInfo(actor);
    const challenges = social.listChallenges(actor).map((c) => ({
      ...c,
      from: profileOf(c.fromId),
      to: profileOf(c.toId),
    }));
    res.json({
      ok: true,
      friends,
      following: follow.following.map((id) => ({ id, profile: profileOf(id), online: protocol.playerToClients.has(id) })),
      followers: follow.followers.map((id) => ({ id, profile: profileOf(id), online: protocol.playerToClients.has(id) })),
      blocked: follow.blocked.map((id) => ({ id, profile: profileOf(id) })),
      challenges,
    });
  });

  app.post('/api/social/friends/request', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const target = resolveTarget(req.body && req.body.target);
    if (!target) return res.status(404).json({ ok: false, code: 'NO_USER', error: '用户不存在' });
    const r = social.requestFriend(actor, target.id);
    if (!r.ok) return res.status(400).json(r);
    if (r.status === 'pending' || r.status === 'accepted') {
      protocol.notifyPlayer(target.id, { type: 'friend_request', data: { from: profileOf(actor), status: r.status } });
    }
    res.json(r);
  });

  app.post('/api/social/friends/respond', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const from = String((req.body && req.body.from) || '').trim();
    const r = social.respondFriend(actor, from, !!(req.body && req.body.accept));
    if (!r.ok) return res.status(400).json(r);
    if (r.status === 'accepted') protocol.notifyPlayer(from, { type: 'friend_accepted', data: { by: profileOf(actor) } });
    res.json(r);
  });

  app.post('/api/social/friends/remove', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const target = String((req.body && req.body.target) || '').trim();
    if (!target) return res.status(400).json({ ok: false, error: '缺少 target' });
    res.json(social.removeFriend(actor, target));
  });

  app.post('/api/social/follow', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const target = resolveTarget(req.body && req.body.target);
    if (!target) return res.status(404).json({ ok: false, code: 'NO_USER', error: '用户不存在' });
    const off = !!(req.body && req.body.off);
    res.json(off ? social.unfollow(actor, target.id) : social.follow(actor, target.id));
  });

  app.post('/api/social/block', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const target = resolveTarget(req.body && req.body.target);
    if (!target) return res.status(404).json({ ok: false, code: 'NO_USER', error: '用户不存在' });
    const off = !!(req.body && req.body.off);
    res.json(off ? social.unblock(actor, target.id) : social.block(actor, target.id));
  });

  app.post('/api/social/challenges', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const target = resolveTarget(req.body && req.body.target);
    if (!target) return res.status(404).json({ ok: false, code: 'NO_USER', error: '用户不存在' });
    if (!firstClient(target.id)) return res.status(409).json({ ok: false, code: 'OFFLINE', error: '对方不在线' });
    const r = social.createChallenge(actor, target.id, String((req.body && req.body.timeControl) || ''));
    if (!r.ok) return res.status(400).json(r);
    protocol.notifyPlayer(target.id, {
      type: 'challenge_created',
      data: { challenge: r.challenge, from: profileOf(actor) },
    });
    res.json({ ok: true, challenge: { ...r.challenge, from: profileOf(actor), to: profileOf(target.id) } });
  });

  app.post('/api/social/challenges/:id/respond', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const accept = !!(req.body && req.body.accept);
    const r = social.respondChallenge(actor, req.params.id, accept);
    if (!r.ok) return res.status(400).json(r);
    const c = r.challenge;
    if (!accept) {
      protocol.notifyPlayer(c.fromId, { type: 'challenge_answered', data: { accepted: false, by: profileOf(actor) } });
      return res.json({ ok: true, accepted: false });
    }
    const clientId = firstClient(c.fromId);
    if (!clientId) return res.status(409).json({ ok: false, code: 'OFFLINE', error: '发起者已离线，约战取消' });
    const meta = protocol.playerRegistry.get(clientId);
    if (!meta) return res.status(409).json({ ok: false, code: 'OFFLINE', error: '发起者已离线，约战取消' });
    const room = protocol.rooms.createRoom(
      { clientId, playerId: c.fromId, name: meta.name },
      c.timeControl,
      { isPrivate: true }
    );
    if (!room.ok) return res.status(409).json({ ok: false, code: room.code || 'ROOM_FAILED', error: room.error || '无法创建房间' });
    // 接受者本人也直接落座：双方立即开局，不依赖“带房间码去大厅再加入”这一步。
    const actorClient = firstClient(actor);
    const actorMeta = actorClient ? protocol.playerRegistry.get(actorClient) : null;
    if (!actorClient || !actorMeta) return res.status(409).json({ ok: false, code: 'OFFLINE', error: '接受者连接已断开' });
    const joined = protocol.rooms.joinRoom(
      { clientId: actorClient, playerId: actor, name: actorMeta.name },
      room.code
    );
    if (!joined.ok) return res.status(409).json({ ok: false, code: joined.code || 'JOIN_FAILED', error: joined.error || '无法进入约战房间' });
    social.acceptChallengeRoom(c.id, room.roomId, room.code);
    const payload = { ...c, status: 'accepted', roomId: room.roomId, code: room.code };
    protocol.notifyPlayer(c.fromId, { type: 'challenge_answered', data: { accepted: true, challenge: payload, by: profileOf(actor) } });
    res.json({ ok: true, accepted: true, roomId: room.roomId, code: room.code });
  });
};
