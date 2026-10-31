'use strict';

/** routes/seasons.js — 赛季快照（1.8，受 FEATURE_SEASONS 保护）。 */
const features = require('../../features');
const seasons = require('../../seasons');
const rateLimit = require('../../ratelimit');

module.exports = function registerSeasons(app) {
  const gate = (res) => {
    if (!features.isOn('seasons')) {
      res.status(501).json({ ok: false, code: 'FEATURE_DISABLED', error: '赛季尚未开放' });
      return false;
    }
    return true;
  };

  app.get('/api/seasons', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    res.json({ ok: true, seasons: seasons.list() });
  });

  app.get('/api/seasons/:id', rateLimit.expressMiddleware(rateLimit.heavy), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!gate(res)) return;
    const s = seasons.detail(req.params.id);
    if (!s) return res.status(404).json({ ok: false, code: 'NO_SEASON', error: '赛季不存在' });
    res.json({ ok: true, season: s });
  });
};
