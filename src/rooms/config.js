/**
 * rooms/config.js — 房间 / 对局的时间与常量配置（PLAN §M1，从 `rooms.js` 拆出）
 *
 * 拆出来的理由：`rooms.js` 曾有 2000+ 行、76 个方法，"房间码字母表""重连宽限多久"
 * 这类**配置**夹在状态机逻辑之间，改一个超时时间要先在两千行里找常量。
 *
 * ⚠️ 这里的常量全部支持环境变量覆盖（部署时按机器调），改动会影响对局生命周期，
 * 因此集中一处、只此一份定义。
 */
'use strict';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符
const RECONNECT_GRACE_MS = 60 * 1000; // 断线 60 秒重连期
const TICK_MS = 1000;                   // 棋钟 tick
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS || '30000', 10) || 30000; // 进行中对局快照间隔（可配，默认 30s）
const NO_MEMBER_CLEANUP_MS = parseInt(process.env.NO_MEMBER_CLEANUP_MS || '', 10) || 2 * 60 * 1000;   // 完全无连接的房间 2 分钟后清理（可配）
const FINISHED_TTL_MS = parseInt(process.env.FINISHED_TTL_MS || '', 10) || 30 * 60 * 1000;            // 感想战中（FINISHED 有连接成员）自最后活动起 30 分钟（可配）

// 时间控制预设（房间 / 快速匹配可选）
//  - main: 本时（每方思考时间，ms）
//  - byoyomi: 秒读（本时用尽后每手限时，ms；0 = 包干，本时用尽即判负）
const TIME_CONTROLS = {
  '15+60': { id: '15+60', name: '15分钟 + 60秒', main: 15 * 60 * 1000, byoyomi: 60 * 1000 },
  '10+30': { id: '10+30', name: '10分钟 + 30秒', main: 10 * 60 * 1000, byoyomi: 30 * 1000 },
  '10:00': { id: '10:00', name: '10分钟包干',   main: 10 * 60 * 1000, byoyomi: 0 },
  '10sec': { id: '10sec', name: '10秒快棋',      main: 0,             byoyomi: 10 * 1000 }, // 0+10：每手 10 秒读秒
};

const DEFAULT_TIME_CONTROL = '10:00'; // 快速匹配 / 默认标准对局：10 分钟包干

// 持驹中文名 -> 打子符号（与 game.js legalTargets 的 drop 符号一致）
const DROP_SYMBOL_BY_NAME = { '歩': 'P', '香': 'L', '桂': 'N', '銀': 'S', '金': 'G', '角': 'B', '飛': 'R' };

/**
 * 由时间控制生成房间时钟初始状态。
 * 0+10 快棋（main=0, byoyomi>0）：开局即进入读秒（本时恒 0，每手读秒）。
 */
function initClockState(tc) {
  return {
    clock: { b: tc.main, w: tc.main },
    byoyomi: tc.byoyomi,
    curByoyomi: { b: tc.byoyomi, w: tc.byoyomi },
    // main=0 且 byoyomi>0 → 开局即读秒；否则等待本时耗尽进入
    inByoyomi: { b: tc.main <= 0 && tc.byoyomi > 0, w: tc.main <= 0 && tc.byoyomi > 0 },
  };
}

module.exports = {
  ROOM_CODE_ALPHABET,
  RECONNECT_GRACE_MS,
  TICK_MS,
  SNAPSHOT_INTERVAL_MS,
  NO_MEMBER_CLEANUP_MS,
  FINISHED_TTL_MS,
  TIME_CONTROLS,
  DEFAULT_TIME_CONTROL,
  DROP_SYMBOL_BY_NAME,
  initClockState,
};
