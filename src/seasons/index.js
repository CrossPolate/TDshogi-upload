'use strict';

/**
 * seasons/ — 1.8 赛季快照与奖励。
 *
 * 不重置历史评级：关闭赛季时把 overall / standard / ultra 三个榜单各取前 10 存快照，
 * 并按名次发放积分；总榜冠军额外获得称号。管理员手动关闭，避免依赖定时任务。
 */
const crypto = require('crypto');
const storage = require('../storage');
const ratings = require('../ratings');
const auth = require('../auth');

const TOP_N = 10;
const CATEGORIES = ['overall', 'standard', 'ultra'];
const CATEGORY_LABEL = { overall: '总榜', standard: '标准', ultra: '极速' };
const RANK_POINTS = [500, 250, 100];

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString('zh-CN') : '—';
}

function publicSeason(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    createdAt: s.createdAt,
    closedAt: s.closedAt,
    data: s.data || null,
  };
}

function create({ name, startsAt, endsAt } = {}) {
  const title = String(name || '').trim().slice(0, 20);
  if (!title) return { ok: false, error: '请填写赛季名称' };
  const start = Number(startsAt) || null;
  const end = Number(endsAt) || null;
  if (start && end && end <= start) return { ok: false, error: '结束时间必须晚于开始时间' };
  const s = {
    id: `sn_${crypto.randomBytes(5).toString('hex')}`,
    name: title,
    status: 'open',
    startsAt: start,
    endsAt: end,
    createdAt: Date.now(),
    closedAt: null,
    data: null,
  };
  storage.putSeason(s);
  return { ok: true, season: publicSeason(s) };
}

/**
 * 关闭并结算：快照不可变；重复关闭直接拒绝（奖励只发一次）。
 */
function close(id) {
  const s = storage.getSeason(id);
  if (!s) return { ok: false, error: '赛季不存在' };
  if (s.status === 'closed') return { ok: false, error: '该赛季已经结算' };

  const categories = {};
  const rewards = [];
  for (const cat of CATEGORIES) {
    const list = ratings.leaderboard(null, TOP_N, cat).list.map((e) => ({
      id: e.id, name: e.name, rating: e.rating, games: e.games,
      wins: e.wins, losses: e.losses, draws: e.draws,
    }));
    categories[cat] = list;
    list.forEach((entry, i) => {
      const rank = i + 1;
      const points = RANK_POINTS[i] || 50;
      try { ratings.addPoints(entry.id, points); } catch (_) { /* 单人失败不影响整个结算 */ }
      const reward = { category: cat, rank, playerId: entry.id, name: entry.name, points, title: null };
      if (cat === 'overall' && rank === 1) {
        const title = `${s.name.slice(0, 8)}冠军`;
        try {
          const t = auth.adminSetTitle(entry.id, title);
          if (t.ok) reward.title = title;
        } catch (_) { /* 会话不存在时只发积分 */ }
      }
      rewards.push(reward);
    });
  }

  s.status = 'closed';
  s.closedAt = Date.now();
  s.data = { snapshotAt: s.closedAt, topN: TOP_N, categories, rewards };
  storage.putSeason(s);
  ratings.flush();
  return { ok: true, season: publicSeason(s) };
}

function list() {
  return storage.listSeasons(100).map(publicSeason);
}

function detail(id) {
  const s = storage.getSeason(id);
  return s ? publicSeason(s) : null;
}

module.exports = { TOP_N, CATEGORIES, CATEGORY_LABEL, fmtDate, create, close, list, detail };
