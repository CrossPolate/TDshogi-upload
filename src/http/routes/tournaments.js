/**
 * src/http/routes/tournaments.js — 赛事管理 REST（T3，2026-09-13）
 *
 * ## 为什么赛事管理走 HTTP 而不是 WS
 *  - 它是**管理操作**（批准报名 / 踢人 / 开赛），不是对局内的实时动作，不需要长连接；
 *  - 走 HTTP 才有干净的"身份 → 权限"通道：WS 那边只有连接绑定的玩家身份，
 *    没有账号 token / admin token 的位置。
 *
 * ## ⚠️ 为什么不能用 `resolvePlayer(req.query.player)`
 * 那是**公开查询**用的宽松解析（`/api/profile?player=` 就这么用），
 * 任何人都可以填别人的 id。拿它做管理鉴权等于**没有鉴权**。
 * 本文件一律通过 `actorOf()` 取身份：admin token 或账号 token，二者其一。
 *
 * ## ⚠️ 权限判定只有一处
 * 每个写操作都调 `tournaments.canManage(t, actor, action)`，
 * **不要**在这里再写 `t.ownerId === me` 之类的判断——§Q7-1 越权就是这么来的。
 */
'use strict';

const tournaments = require('../../tournaments');
const accounts = require('../../accounts');
const records = require('../../records');
const { checkAdmin } = require('../context');

/**
 * 解析请求身份。
 *  - `x-admin-token`     → 管理员（`isAdmin: true`）
 *  - `x-account-token`   → 正式账号（返回其 accountId）
 * 两者可同时带上：管理员也带账号 token 时，日志里能记到具体是谁操作的。
 *
 * @returns {{id:string|null, isAdmin:boolean}|null} null = 未通过任何鉴权
 */
function actorOf(req) {
  const adminOk = !!checkAdmin(req);
  const raw = req.headers['x-account-token']
    || (req.body && req.body.token)
    || req.query.token
    || '';
  let accountId = null;
  if (raw) {
    try { accountId = accounts.verifyToken(String(raw)); } catch (_) { accountId = null; }
  }
  if (!adminOk && !accountId) return null;
  return { id: accountId || null, isAdmin: adminOk };
}

/** 统一的错误码：'没有权限' 一律 403（其余按 400），避免把权限问题说成参数问题 */
function fail(res, error) {
  return res.status(error === '没有权限' ? 403 : 400).json({ error });
}

module.exports = function registerTournaments(app) {
  // 赛事详情（**所有用户含游客**都可读）
  app.get('/api/tournaments/:id', (req, res) => {
    const t = tournaments.getTournament(req.params.id); // 已是脱敏后的 publicInfo 形态
    if (!t) return res.status(404).json({ error: '赛事不存在' });

    // 附带"当前请求者能做什么"——**由服务端算**，前端据此决定按钮显示。
    // ⚠️ 这只是为了避免 UI 出现"点了必然 403"的按钮；**真正的判定在每个写接口里重做一遍**，
    // 客户端拿到 caps 也无法绕过（caps 只是描述，不是票据）。
    const actor = actorOf(req);
    const actions = [
      'decide_entrant', 'kick_player', 'void_player', 'assign_round',
      'cancel', 'set_champion', 'archive', 'edit_archived', 'decide_rematch',
    ];
    const caps = {};
    for (const a of actions) caps[a] = actor ? tournaments.canManage(t, actor, a) : false;

    // ⚠️ 管理员编辑历史（谁在赛后改了结论）是**敏感信息**，只有管理员能看到。
    // 不能因为它挂在 `publicInfo` 里就顺手下发——那是给所有访客（含游客）的接口。
    const out = Object.assign({}, t);
    if (!(actor && actor.isAdmin)) delete out.adminEditLog;

    res.json({
      tournament: out,
      caps,
      viewerId: (actor && actor.id) || null,
      viewerIsAdmin: !!(actor && actor.isAdmin),
    });
  });

  // 赛事棋谱（T6/需求 12）：**公开可看，不鉴权** ——
  // 赛事对局在落盘时就被强制设为公开（见 `src/rooms/gameplay.js` 的说明），
  // 所以这里不再过滤可见性；拿到的本来就是全部可公开的对局。
  app.get('/api/tournaments/:id/records', (req, res) => {
    const t = tournaments.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: '赛事不存在' });
    res.json({ records: records.listByTournament(req.params.id, 100) });
  });

  // 批准 / 拒绝报名（T3）：主办人（未结束）或管理员
  app.post('/api/tournaments/:id/entrants/:playerId', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const decision = (req.body && req.body.decision) === 'approve' ? 'approve' : 'reject';
    const r = tournaments.decideEntrant(req.params.id, req.params.playerId, decision, actor);
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament, started: !!r.started });
  });

  // 踢出报名者（T3，仅报名阶段；已开赛请用「取消选手成绩」）
  app.post('/api/tournaments/:id/kick', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const t = tournaments.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: '赛事不存在' });
    if (!tournaments.canManage(t, actor, 'kick_player')) return res.status(403).json({ error: '没有权限' });
    const r = tournaments.kickPlayer(req.params.id, req.body && req.body.playerId);
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament });
  });

  // 手动开赛（T3）：报名阶段即可开，不必等满员；未满员时首轮自动轮空
  app.post('/api/tournaments/:id/start', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const t = tournaments.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: '赛事不存在' });
    if (!tournaments.canManage(t, actor, 'assign_round')) return res.status(403).json({ error: '没有权限' });
    const r = tournaments.startTournament(req.params.id, { byRole: actor.isAdmin ? 'admin' : 'owner', action: 'start', detail: { manual: true } });
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament });
  });

  // 取消选手成绩（T4）：该选手所有对局判对手胜，并重算下游
  app.post('/api/tournaments/:id/void', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const r = tournaments.voidPlayer(req.params.id, req.body && req.body.playerId, actor);
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament, affected: r.affected });
  });

  // 取消赛事（需求 10）：主办人**仅未结束时**可用（已存档/已取消一律拒绝，需求 11）
  app.post('/api/tournaments/:id/cancel', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const t = tournaments.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: '赛事不存在' });
    if (!tournaments.canManage(t, actor, 'cancel')) {
      return res.status(403).json({ error: '没有权限（赛事可能已结束或不能取消）' });
    }
    const r = tournaments.cancelTournament(req.params.id, (req.body && req.body.reason) || '');
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament });
  });

  // 设置冠军（T4）：**仅管理员**（用户 2026-09-13 明确修正；`canManage` 已是唯一判定处）
  app.post('/api/tournaments/:id/champion', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const r = tournaments.setChampion(req.params.id, req.body && req.body.playerId, actor);
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament });
  });

  // 申请重赛（T6/需求 12）：**仅本场参赛者**（资格核对在域内，含"是不是这一场的人"）
  app.post('/api/tournaments/:id/rematch', (req, res) => {
    const actor = actorOf(req);
    if (!actor || !actor.id) return res.status(401).json({ error: '需要登录正式账号才能申请重赛' });
    const r = tournaments.requestRematch(
      req.params.id,
      req.body && req.body.matchId,
      req.body && req.body.reason,
      { id: actor.id, name: (req.body && req.body.name) || null }
    );
    if (!r.ok) return fail(res, r.error);
    res.json({ rematch: r.rematch, tournament: r.tournament });
  });

  // 裁决重赛（T6）：主办人 / 管理员
  app.post('/api/tournaments/:id/rematch/:rematchId', (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(401).json({ error: '需要登录' });
    const decision = (req.body && req.body.decision) === 'approve' ? 'approve' : 'reject';
    const r = tournaments.decideRematch(
      req.params.id, req.params.rematchId, decision, actor, req.body && req.body.note
    );
    if (!r.ok) return fail(res, r.error);
    res.json({ tournament: r.tournament, rematch: r.rematch });
  });
};
