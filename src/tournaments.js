/**
 * tournaments.js — 赛事（单败淘汰 + 瑞士制）· **聚合出口**
 *
 * 设计文档：`docs/TOURNAMENT.md`（数据模型 / 权限矩阵 / 状态机 / T1–T8 阶段）。
 * 报名池、赛后存档、权限判定都在此域内收敛。
 *
 * ## 状态机（2026-09-13，T1）
 *
 * ```
 * pending_approval ──approve──→ registration ──开赛──→ playing ──出结果──→ finished ──→ archived
 *        │                          │                    │                    │
 *        └──reject──→ rejected      └────cancel───────→ cancelled ←──cancel────┘
 * ```
 *  - `registration`：报名中（原 `open`，**读旧数据时映射**，见 `normalizeStatus()`）
 *  - `archived`：已存档——主办人只读、仅管理员可编辑（每次编辑写 `adminEditLog`）
 *  - `finished` 仍有收尾窗口，主办人在此阶段**仍可**操作；进 `archived` 后不行
 *
 * ⚠️ **所有管理动作的权限判定只允许存在于一处**：`canManage()`（`tournaments/rules.js`）。
 * 这是 §Q7-1 越权事故的直接教训——当年每个管理接口各抄一份判定，
 * 「新增接口忘记校验」就成了一个静默存在的错误类别。
 *
 * 赛事对局复用房间对局基础设施（rooms.js），对局结束后通过回调推进。
 * 数据以 tournaments.json 落盘（经 storage kv 兼容层）。
 *
 * ⚠️ **§M2 拆分（2026-09-28）**：本文件原先 1571 行、59 个顶层函数挤在一起，现按职责拆到
 * `src/tournaments/`，本文件只做**聚合出口**（re-export + 文档）。加载顺序即依赖顺序（无环）：
 *
 * | `store` | 持久化与共享常量（tournaments.json 的缓存 / 落盘 / 日志 / 建房工厂 / 枚举常量） |
 * | `rules` | 状态机与权限（**所有权限判定只有这一处**：canManage） |
 * | `swiss-flow` | 瑞士制推进 + 名次/公开信息（积分编排、结束轮、名次表、publicInfo） |
 * | `bracket` | 单败淘汰对阵表推进（建表 / 轮空 / 下一轮 / 终局回调） |
 * | `lifecycle` | 赛前生命周期（建赛 / 审批 / 报名 / 踢人 / 开赛 / 作废 / 冠军） |
 * | `archive` | 赛后存档与重赛（存档 / 自动存档 / 管理员编辑 / 重赛裁决） |
 * | `view` | 只读出口（列表 / 详情 / 个人页赛事荣誉） |
 *
 * 拆分方式：**整段原样搬移**，跨模块调用直接引用同名函数（`require` 装配），
 * 因此调用处写法、行为与对外暴露面（下方 `module.exports`）**完全未变**。
 * 改某块逻辑请直接进对应子模块；新增导出记得同时补本文件的聚合。
 */
'use strict';

const { setMatchFactory, addLog, SIZE_OPTIONS, FORMATS, FORMAT_LABELS, MIN_SWISS_ROUNDS, MAX_SWISS_ROUNDS } = require('./tournaments/store');
const { canManage, canTransition, normalizeStatus, transition, STATUS_FLOW, ACTION_ROLES } = require('./tournaments/rules');
const { publicInfo, swissStandings, matchParticipants, placeOf, PLACE_LABEL } = require('./tournaments/swiss-flow');
const { onMatchFinished, assignNextMatches } = require('./tournaments/bracket');
const { createTournament, joinTournament, decideEntrant, kickPlayer, voidPlayer, setChampion, startTournament, approvedCount, approveTournament, rejectTournament, cancelTournament } = require('./tournaments/lifecycle');
const { requestRematch, decideRematch, archiveTournament, autoArchiveDue, editArchived, ARCHIVE_AFTER_HOURS } = require('./tournaments/archive');
const { listTournaments, listAllTournaments, getTournament, honorsOf } = require('./tournaments/view');

module.exports = {
  createTournament,
  joinTournament,
  decideEntrant,   // T3：批准/拒绝报名
  kickPlayer,      // T3：踢出报名者（仅报名阶段）
  voidPlayer,      // T4：取消选手成绩（开赛后；判对手胜 + 重算下游）
  setChampion,     // T4：设置冠军（**仅管理员**）
  requestRematch,  // T6：参赛者申请重赛
  decideRematch,   // T6：裁决重赛（主办人/管理员）
  // ---- T6 新增：赛后存档与管理员编辑 ----
  archiveTournament, // 手动存档（仅管理员）
  autoArchiveDue,    // 自动存档扫描（由 server 定时调用）
  editArchived,      // 编辑已存档赛事（仅管理员）
  ARCHIVE_AFTER_HOURS,
  startTournament, // T3：手动开赛（报名阶段，主办人/管理员）
  approvedCount,   // T3：已批准人数（= 参赛人数）
  approveTournament,
  rejectTournament,
  cancelTournament,
  onMatchFinished,
  listTournaments,
  listAllTournaments,
  getTournament,
  setMatchFactory,
  assignNextMatches,
  // ---- T1 新增：状态机与权限 ----
  // 对外暴露是**有意**的：protocol / HTTP 路由 与 单测都通过它们做判定，
  // 这样"权限只有一处"才真的成立（藏在模块内部反而会诱使调用方自己写一份）。
  canManage,
  canTransition,
  normalizeStatus,
  transition,
  addLog,
  publicInfo,
  STATUS_FLOW,
  ACTION_ROLES,
  SIZE_OPTIONS,
  FORMATS,
  // ---- T8：瑞士制 ----
  swissStandings,     // 名次表（详情页与测试用）
  matchParticipants,  // "这一场是谁打谁"（重赛资格判定复用）
  honorsOf,           // 赛事荣誉（个人页）
  placeOf,            // 单赛事名次（荣誉计算用）
  PLACE_LABEL,
  FORMAT_LABELS,
  MIN_SWISS_ROUNDS,
  MAX_SWISS_ROUNDS,
};
