/**
 * tournaments/view.js — 只读出口（列表 / 详情 / 个人页赛事荣誉）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const { getCache, FORMAT_LABELS } = require('./store');
const { normalizeStatus } = require('./rules');
const { publicInfo, PLACE_LABEL, placeOf } = require('./swiss-flow');
const swiss = require('../swiss');

/** 选手在本赛事里的显示名（players 快照优先，回退 entrants） */
function nameOfId(t, id) {
  const p = (t.players || []).find((x) => x.id === id)
    || (t.entrants || []).find((x) => x.id === id);
  return (p && p.name) || null;
}

/**
 * 查询某选手「当前可进行的赛事对局」（约战制，2026-10-11）。
 *
 * 背景：赛事开赛后不再自动建房，改为选手自行约战。前端在大厅快速匹配区显示
 * 「开始赛事」按钮时，需要知道：**有没有一场轮到我、且还没开打的对局**，对手是谁。
 *
 * @param {string} playerId
 * @returns {null|{tournamentId:string, tournamentName:string, format:string,
 *   opponentId:string, opponentName:string|null, nodeIndex?:number, round?:number, pairIndex?:number}}
 *   null = 当前没有可进行的赛事对局
 */
function pendingMatchFor(playerId) {
  if (!playerId) return null;
  const pid = String(playerId);
  for (const t of Object.values(getCache())) {
    if (normalizeStatus(t.status) !== 'playing') continue;
    if ((t.format || 'single-elimination') === 'swiss') {
      for (const rec of (t.rounds || [])) {
        const pairs = rec.pairs || [];
        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          if (!Array.isArray(pair) || pair.indexOf(pid) < 0) continue;
          if (rec.matchIds && rec.matchIds[i]) continue;           // 已建房（正在打/已打完）
          if (rec.results && rec.results[swiss.pairKey(pair[0], pair[1])]) continue; // 已出结果
          const oppId = pair[0] === pid ? pair[1] : pair[0];
          return {
            tournamentId: t.id, tournamentName: t.name, format: 'swiss',
            round: rec.round, pairIndex: i,
            opponentId: oppId, opponentName: nameOfId(t, oppId),
          };
        }
      }
    } else {
      for (const n of (t.bracket || [])) {
        if (!n.ready || n.matchId || n.winnerId) continue;          // 未配对 / 已打 / 已定
        const players = n.players || [];
        if (players.indexOf(pid) < 0) continue;
        const oppId = players.find((p) => p !== pid) || null;
        return {
          tournamentId: t.id, tournamentName: t.name, format: 'single-elimination',
          nodeIndex: n.index,
          opponentId: oppId, opponentName: nameOfId(t, oppId),
        };
      }
    }
  }
  return null;
}


/**
 * 公开列表：只返回可展示的赛事（审核中/被拒/已取消不对外）。
 */
function listTournaments() {
  // T1：`registration` 是新的"报名中"（旧数据写 `open`，由 normalizeStatus 映射）；
  // `archived`（已存档）与 `finished` 一样对外可见——办过的赛事应当能回看。
  const PUBLIC_STATUS = ['registration', 'playing', 'finished', 'archived'];
  return Object.values(getCache())
    .filter((t) => PUBLIC_STATUS.includes(normalizeStatus(t.status)))
    .map(publicInfo)
    .sort((a, b) => b.createdAt - a.createdAt);
}


/**
 * 管理员全量列表：含 pending_approval / rejected / cancelled。
 */
function listAllTournaments() {
  return Object.values(getCache())
    .map(publicInfo)
    .sort((a, b) => b.createdAt - a.createdAt);
}


function getTournament(tournamentId) {
  const t = getCache()[tournamentId];
  return t ? publicInfo(t) : null;
}


/**
 * 某玩家的赛事荣誉。
 *
 * ⚠️ **只统计 `finished` / `archived`**：进行中的赛事还没有结论，
 * 写进"荣誉"会误导（这也是"荣誉"与"参赛记录"的区别）。
 * `cancelled` / `rejected` / `pending_approval` 一律不算参赛。
 *
 * @param {string} playerId
 * @param {number} [limit=20] 荣誉明细上限（个人页是概览，不铺全量）
 * @returns {{stats:object, items:Array}}
 */
function honorsOf(playerId, limit = 20) {
  // ⚠️ 口径更正（P3）：`winRate` 这个字段名**名不副实**——它的真实口径是「夺冠率」
  //（= titles / finished，即已结束赛事里夺冠的占比），并非对局胜负胜率（见下方计算）。
  // 之所以**保留字段名而不改名 `titleRate`**：前端 `public/js/profile.js` 与其已构建产物
  // `public/js/profile.bundle.js` 都按 `s.winRate` 读取，改名需同步改前端脚本 + 重建 bundle
  //（超出本次改动范围，且会破坏既有契约）；故保留字段名、在此把口径写清楚。
  const stats = { joined: 0, finished: 0, titles: 0, runnerUps: 0, top4: 0, winRate: 0 };
  if (!playerId) return { stats, items: [] };

  const items = [];
  for (const t of Object.values(getCache())) {
    const st = normalizeStatus(t.status);
    if (st === 'cancelled' || st === 'rejected' || st === 'pending_approval') continue;

    const joined = (t.players || []).some((p) => p.id === playerId)
      || (t.entrants || []).some((e) => e.id === playerId && e.status === 'approved');
    if (!joined) continue;
    stats.joined++;

    if (st !== 'finished' && st !== 'archived') continue; // 还没打完：只计入"参赛"
    stats.finished++;

    const place = placeOf(t, playerId);
    if (place === 1) stats.titles++;
    else if (place === 2) stats.runnerUps++;
    else if (place === 3) stats.top4++;
    // ⚠️ 明细**列出每一个打完的赛事**（含没有名次的）：2026-09-20 用户要求"只写已参加的赛事即可"。
    // 早先 `if (!place) continue` 会把"参加了但没进前四"的赛事整条丢掉——
    // 于是打满 5 场只显示 1 条，看着像数据丢了。没名次就标「参赛」。
    items.push({
      tournamentId: t.id,
      name: t.name,
      place,
      placeLabel: PLACE_LABEL[place] || '参赛',
      size: t.size,
      format: t.format || 'single-elimination',
      formatLabel: FORMAT_LABELS[t.format || 'single-elimination'] || null,
      playerCount: (t.players || []).length,
      endedAt: t.endedAt || t.archivedAt || null,
      manual: !!t.championManual, // 冠军由管理员人工裁定 → 详情页会标注
    });
  }

  items.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  // 注意：这里是**夺冠率**（夺冠次数 / 已结束赛事数），不是对局胜率。字段名沿用 `winRate`（见上方说明）。
  stats.winRate = stats.finished ? Math.round((stats.titles / stats.finished) * 100) : 0;
  return { stats, items: items.slice(0, limit) };
}

module.exports = {
  listTournaments,
  listAllTournaments,
  getTournament,
  honorsOf,
  pendingMatchFor,
};
