'use strict';

/**
 * routes/puzzles.js — 每日诘将棋 / 下一手（1.6）。
 *
 * 只做身份解析 + 开关 + 参数校验；题库与解法校验在 src/puzzles/。
 * 作答是写进度：游客必须带持有证明（B1），账号用令牌；不把解法提前下发。
 */

const features = require('../../features');
const puzzles = require('../../puzzles');
const rateLimit = require('../../ratelimit');
const { resolveOwner, resolveOwnerWrite } = require('../context');

module.exports = function registerPuzzles(app) {
  function gate(res) {
    if (!features.isOn('puzzles')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '每日诘将棋尚未开放' });
      return false;
    }
    return true;
  }

  app.get('/api/puzzles/daily', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const playerId = resolveOwner(req.query.guest) || null;
    res.json(puzzles.dailyFor(playerId));
  });

  app.get('/api/puzzles/me', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const playerId = resolveOwner(req.query.guest) || null;
    res.json({ ok: true, ...puzzles.streak(playerId) });
  });

  app.post('/api/puzzles/:id/attempt', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const body = req.body || {};
    const own = resolveOwnerWrite(body.guest, body.key || req.headers['x-guest-key']);
    if (!own.ok || !own.owner) {
      return res.status(401).json({ ok: false, code: own.code || 'AUTH', error: '需要可验证的玩家身份' });
    }
    if (!Array.isArray(body.moves)) {
      return res.status(400).json({ ok: false, code: 'BAD_MOVES', error: 'moves 必须是数组' });
    }
    const r = puzzles.attempt(own.owner, req.params.id, body.moves);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });
};
