/**
 * src/http/routes/public.js — 公开 REST（PLAN §M2 从 `server.js` 拆出）
 *
 * 面向所有访客的只读接口：首页 / 大厅 / 个人数据 / 玩家卡 / 赛事列表 / 棋谱广场。
 * 这些路由**不做鉴权**（棋谱广场是 §L 的公开广场），涉及私密数据的一律在 accounts/admin 里。
 */
'use strict';

const records = require('../../records');
const { protocol, VERSION, resolvePlayer } = require('../context');

module.exports = function registerPublic(app) {
  // 首页数据（附版本号——排障时用 curl 即可确认进程跑的是哪份代码）
  app.get('/api/home', (req, res) => {
    res.json({ ...protocol.homeData(), version: VERSION });
  });

  // 大厅数据（进行中对局 / 公告 / 排行）
  app.get('/api/lobby', (req, res) => {
    res.json(protocol.lobbyData());
  });

  // 个人数据
  app.get('/api/profile', (req, res) => {
    const playerId = resolvePlayer(req.query.player);
    if (!playerId) return res.status(400).json({ error: '缺少 player 参数' });
    res.json(protocol.profileData(playerId));
  });

  // 玩家信息卡（公开，悬停小窗数据源；绝不返回手机号）
  app.get('/api/player-card', (req, res) => {
    const card = protocol.playerCardData(String(req.query.id || ''));
    if (!card) return res.status(404).json({ error: '玩家不存在' });
    res.json(card);
  });

  // 赛事列表
  app.get('/api/tournaments', (req, res) => {
    res.json(protocol.tournamentsData());
  });

  // ---------- §L 公开棋谱广场 ----------

  // 广场列表（公开棋谱，无需登录）：?tag=&q=&page=&limit=
  app.get('/api/gallery', (req, res) => {
    res.json(records.listPublic({
      tag: req.query.tag || '',
      query: req.query.q || req.query.query || '',
      page: req.query.page || 1,
      limit: req.query.limit || 20,
    }));
  });
};
