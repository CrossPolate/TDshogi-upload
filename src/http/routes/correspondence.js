'use strict';

/**
 * routes/correspondence.js — 异步长局（1.8）。
 * 只有登录账号可使用；每步按天计时，超时由 server 定时 sweep 判定。
 */
const features = require('../../features');
const correspondence = require('../../correspondence');
const social = require('../../social');
const accounts = require('../../accounts');
const auth = require('../../auth');
const rateLimit = require('../../ratelimit');
const { resolveAccount, protocol } = require('../context');

function profileOf(id) {
  const s = auth.load(id);
  if (s) return { id, name: s.name || id, avatar: s.avatar || null };
  const a = accounts.getAccount(id);
  return a ? { id, name: a.nickname || a.username || id, avatar: null } : { id, name: id, avatar: null };
}
function targetOf(raw) {
  const s = String(raw || '').trim();
  return s ? (accounts.getAccount(s) || accounts.getAccountByName(s)) : null;
}
function viewGame(g, actor) {
  const seat = g.playerB === actor ? 'b' : (g.playerW === actor ? 'w' : null);
  if (!seat) return null;
  const opponentId = seat === 'b' ? g.playerW : g.playerB;
  return {
    id: g.id,
    seat,
    opponent: profileOf(opponentId),
    timePerMoveMs: g.timePerMoveMs,
    status: g.status,
    result: g.result,
    resultDetail: g.resultDetail,
    moves: g.moves.length,
    deadline: g.status === 'playing' ? (seat === 'b' ? g.deadlineB : g.deadlineW) : null,
    drawOfferBy: g.drawOfferBy || null,
    drawOfferByMe: !!g.drawOfferBy && g.drawOfferBy === actor,
    canAbort: g.status === 'playing' && (g.moves || []).length < 2,
    state: correspondence.stateFor(g),
  };
}

module.exports = function registerCorrespondence(app) {
  const gate = (res) => {
    if (!features.isOn('correspondence')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '异步对局尚未开放' });
      return false;
    }
    return true;
  };
  const actorOf = (req) => resolveAccount(req);

  app.get('/api/correspondence', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    res.json({
      ok: true,
      games: correspondence.listFor(actor).map((g) => ({ ...g, opponent: profileOf(g.opponentId) })),
    });
  });

  app.post('/api/correspondence', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const target = targetOf(req.body && req.body.target);
    if (!target) return res.status(404).json({ ok: false, code: 'NO_USER', error: '对手不存在' });
    if (social.isBlocked(actor, target.id)) return res.status(403).json({ ok: false, code: 'BLOCKED', error: '无法与对方开局' });
    const days = Number(req.body && req.body.timePerMoveDays);
    if (!correspondence.TIME_OPTIONS.includes(days)) return res.status(400).json({ ok: false, code: 'BAD_TIME', error: '每步时限只能选 1/3/7 天' });
    const side = req.body && req.body.side === 'w' ? 'w' : 'b';
    const r = correspondence.create({
      creatorId: actor,
      opponentId: target.id,
      timePerMoveMs: days * correspondence.DAY,
      creatorSide: side,
    });
    if (!r.ok) return res.status(400).json(r);
    protocol.notifyPlayer(target.id, { type: 'corr_created', data: { gameId: r.game.id, from: profileOf(actor) } });
    res.json({ ok: true, game: viewGame(r.game, actor) });
  });

  app.get('/api/correspondence/:id', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const g = require('../../storage').getCorrGame(req.params.id);
    const view = g ? viewGame(g, actor) : null;
    if (!view) return res.status(404).json({ ok: false, code: 'NO_GAME', error: '对局不存在或无权访问' });
    res.json({ ok: true, game: view });
  });

  app.post('/api/correspondence/:id/move', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = correspondence.move(actor, req.params.id, req.body && req.body.usi);
    if (!r.ok) return res.status(400).json(r);
    const opponentId = r.game.playerB === actor ? r.game.playerW : r.game.playerB;
    protocol.notifyPlayer(opponentId, { type: 'corr_move', data: { gameId: r.game.id, by: profileOf(actor) } });
    if (r.finished) {
      protocol.notifyPlayer(opponentId, { type: 'corr_finished', data: { gameId: r.game.id, result: r.game.result, resultDetail: r.game.resultDetail } });
    }
    res.json({ ok: true, game: viewGame(r.game, actor), finished: !!r.finished });
  });

  app.post('/api/correspondence/:id/draw-offer', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = correspondence.offerDraw(actor, req.params.id);
    if (!r.ok) return res.status(400).json(r);
    const opponentId = r.game.playerB === actor ? r.game.playerW : r.game.playerB;
    protocol.notifyPlayer(opponentId, { type: 'corr_draw_offered', data: { gameId: r.game.id, by: profileOf(actor) } });
    res.json({ ok: true, game: viewGame(r.game, actor) });
  });

  app.post('/api/correspondence/:id/draw-respond', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const accept = !!(req.body && req.body.accept);
    const r = correspondence.respondDraw(actor, req.params.id, accept);
    if (!r.ok) return res.status(400).json(r);
    if (r.accepted) {
      const opponentId = r.game.playerB === actor ? r.game.playerW : r.game.playerB;
      protocol.notifyPlayer(opponentId, {
        type: 'corr_finished',
        data: { gameId: r.game.id, result: '-', resultDetail: r.game.resultDetail },
      });
    }
    res.json({ ok: true, accepted: !!r.accepted, game: viewGame(r.game, actor) });
  });

  app.post('/api/correspondence/:id/abort', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = correspondence.abort(actor, req.params.id);
    if (!r.ok) return res.status(400).json(r);
    const opponentId = r.game.playerB === actor ? r.game.playerW : r.game.playerB;
    protocol.notifyPlayer(opponentId, {
      type: 'corr_finished',
      data: { gameId: r.game.id, result: null, resultDetail: r.game.resultDetail },
    });
    res.json({ ok: true, game: viewGame(r.game, actor) });
  });

  app.post('/api/correspondence/:id/resign', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ ok: false, code: 'AUTH', error: '需要登录账号' });
    const r = correspondence.resign(actor, req.params.id);
    if (!r.ok) return res.status(400).json(r);
    const opponentId = r.game.playerB === actor ? r.game.playerW : r.game.playerB;
    protocol.notifyPlayer(opponentId, { type: 'corr_finished', data: { gameId: r.game.id, result: r.game.result, resultDetail: r.game.resultDetail } });
    res.json({ ok: true, game: viewGame(r.game, actor) });
  });
};
