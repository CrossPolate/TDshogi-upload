/**
 * tournaments/store.js — 持久化与共享常量（tournaments.json 的缓存 / 落盘 / 日志 / 建房工厂 / 枚举常量）
 *
 * §M2（2026-09-28）：从 `src/tournaments.js`（原 1571 行）按职责拆出，**整段原样搬移**。
 * 对外仍由 `src/tournaments.js` 聚合出口统一暴露（见该文件的模块表）；
 * 内部跨模块调用靠下方 `require` 拿到的**同名函数**，调用处写法未变。
 */
'use strict';

const { readJson, writeJson } = require('../storage');

function loadTournaments() {
  const data = readJson('tournaments.json', {});
  return data && typeof data === 'object' ? data : {};
}


let cache = null;

function getCache() {
  if (!cache) cache = loadTournaments();
  return cache;
}

function persist() {
  writeJson('tournaments.json', getCache());
}


// 4–32 且为 2 的幂（Q3 用户确认）：保证对阵树是完美二叉树，不会出现「首轮轮空位」的复杂情形
const SIZE_OPTIONS = [4, 8, 16, 32];

// 赛制（T8）：单败淘汰 + 瑞士制。循环赛需求原文未要求，暂不做。
const FORMATS = ['single-elimination', 'swiss'];

const FORMAT_LABELS = { 'single-elimination': '单败淘汰', swiss: '瑞士制（积分编排）' };

/** 瑞士制轮数区间：少于 3 轮区分度太差，多于 9 轮对 32 人档也没有必要 */
const MIN_SWISS_ROUNDS = 3;

const MAX_SWISS_ROUNDS = 9;


/** 把可能是字符串/空值的时间字段归一化为时间戳或 null */
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}


/**
 * 时间字段自洽校验。
 * **服务端必须再验一遍**——前端校验只防手滑，防不了直接构造 WS 消息的人。
 * @returns {string|null} 错误说明；null = 通过
 */
function validateSchedule(s) {
  const { regStart, regEnd, matchStart, matchEnd } = s || {};
  if (regStart && regEnd && regStart >= regEnd) return '报名结束时间必须晚于报名开始时间';
  if (matchStart && matchEnd && matchStart >= matchEnd) return '比赛结束时间必须晚于比赛开始时间';
  if (regEnd && matchStart && matchStart < regEnd) return '比赛开始时间不能早于报名结束时间';
  return null;
}


/**
 * 追加一条操作日志（T1）。
 *
 * 需求 10/11 涉及大量管理动作（踢人、取消成绩、审重赛、设冠军、存档后编辑…），
 * **日志是事后追责与排障的唯一依据**——尤其是"取消选手成绩"这类直接影响比赛结果的操作。
 * 只保留最近 200 条：赛事生命周期有限，没必要无限增长。
 */
function addLog(t, entry) {
  if (!t) return;
  if (!Array.isArray(t.logs)) t.logs = [];
  t.logs.push(Object.assign({ at: Date.now() }, entry || {}));
  if (t.logs.length > 200) t.logs.shift();
}


// 建房工厂：由 rooms.js 注入，避免循环依赖
// (tournamentId, playerIds) => { roomId } | null
let matchFactory = null;

function setMatchFactory(fn) {
  matchFactory = fn;
}

module.exports = {
  loadTournaments,
  getCache,
  persist,
  SIZE_OPTIONS,
  FORMATS,
  FORMAT_LABELS,
  MIN_SWISS_ROUNDS,
  MAX_SWISS_ROUNDS,
  numOrNull,
  validateSchedule,
  addLog,
  setMatchFactory,
  // ⚠️ 可变量必须走**访问器**导出：`matchFactory` 由 `setMatchFactory()` 在依赖注入时才有值，
  // 而 `module.exports = { matchFactory }` 会把「导出那一刻的取值（null）」固化下来——
  // 别的模块解构后就永远拿不到注入后的工厂（症状：瑞士制/重赛建不了局、首轮空转）。
  // 因此跨模块一律用 `store.matchFactory`（属性访问，读的是最新值），**不要解构**。
  // 同理，`cache` 属内部状态：外部要读请调 `getCache()`，别去解构缓存引用。
  get matchFactory() { return matchFactory; },
};
