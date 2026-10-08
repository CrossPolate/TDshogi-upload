/**
 * src/messages.js — WS 消息契约（PLAN §P5）
 *
 * 解决的问题：客户端消息此前是**裸字符串 switch**（`case 'move':`），由此产生两类隐患：
 *  1. **字段写错静默失败**——前端发 `{ type: 'move', data: { usi: ... } }`，
 *     服务端读 `data.usiX` 只会拿到 `undefined`，然后被下游当成"非法走法"报一句模糊错误，
 *     排查时要在两端来回猜；
 *  2. **类型名拼错无处校验**——`'demo_move'` 写成 `'demo_mov'` 只会落到 default，
 *     如果 default 分支没回错误，就是彻底的静默丢弃。
 *
 * 做法：把客户端消息类型收敛成常量表，并给"必填参数"配一份声明式校验规则；
 * `protocol._route()` 在进入业务分支**之前**先校验，缺参数直接回明确错误。
 *
 * ⚠️ 两条约定：
 *  - **只校验"必填且类型明确"的参数**，不做全量 schema。校验过严会把合法请求拒之门外，
 *    比不校验更糟——可选参数一律交给业务层。
 *  - 新增客户端消息时，**必须**同步 `C2S`；`tests/messages.test.js` 会比对
 *    `protocol.js` 里的 `case` 列表与 `C2S` 是否一致，防止两边漂移。
 *
 * 服务端 → 客户端的消息（`state` / `game_over` / `demo_state` …）目前仍由各模块直接构造，
 * 未纳入本文件——那属于 §M2（路由模块化）一并收敛的范围。
 */
'use strict';

/** 客户端 → 服务端消息类型（`msg.type` 的取值全集） */
const C2S = {
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  QUICK_MATCH: 'quick_match',
  CANCEL_MATCH: 'cancel_match',
  MOVE: 'move',
  RESIGN: 'resign',
  DECLARE_NYUGYOKU: 'declare_nyugyoku',
  REMATCH: 'rematch',
  SPECTATE: 'spectate',
  RANDOM_SPECTATE: 'random_spectate',
  LEAVE: 'leave',
  RENAME: 'rename',
  SET_AVATAR: 'set_avatar', // 2026-09-20：换头像（游客与账号都能用）
  REPORT: 'report',         // 2026-09-20：举报玩家
  REQUEST_STATE: 'request_state',
  CHAT: 'chat',
  ADMIN_LOGIN: 'admin_login',
  CREATE_TOURNAMENT: 'create_tournament',
  JOIN_TOURNAMENT: 'join_tournament',
  JOIN_TOURNAMENT_MATCH: 'join_tournament_match',
  DEMO_ENTER: 'demo_enter',
  DEMO_MOVE: 'demo_move',
  DEMO_UNDO: 'demo_undo',
  DEMO_TRANSFER: 'demo_transfer',
  DEMO_CLAIM: 'demo_claim',
  DEMO_RESET: 'demo_reset',
  DEMO_LEGAL: 'demo_legal',
  RECORD_SEARCH: 'record_search',
};

/** 类型名全集（顺序与 C2S 定义一致，便于一致性测试与日志展示） */
const C2S_TYPES = Object.freeze(Object.values(C2S));

function isClientType(type) {
  return typeof type === 'string' && C2S_TYPES.includes(type);
}

/** data 里的字段是否为「非空字符串」 */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 生成一个"必填字符串"校验器。
 * @param {string} field data 里的字段名
 * @param {string} [hint] 补充说明（如"6 位房间码"）
 * @returns {(d:object)=>string|null} 返回错误文案，或 null 表示通过
 */
function needString(field, hint) {
  return (d) => {
    if (nonEmptyString(d[field])) return null;
    return `缺少参数 data.${field}${hint ? `（${hint}）` : ''}`;
  };
}

/**
 * 各类型的参数校验规则。**未列出的类型视为"无必填参数"**。
 * 函数返回错误文案（字符串）或 null。
 */
const RULES = {
  [C2S.MOVE]: needString('usi', 'USI 走法，如 7g7f'),
  [C2S.CHAT]: needString('text', '聊天内容'),
  [C2S.RENAME]: needString('name', '新名字'),
  // 头像：必填且必须是白名单里的字形（白名单校验在 `auth.setAvatar`，这里只挡"没传")
  [C2S.SET_AVATAR]: needString('avatar', '头像'),
  // 举报：只挡"没传被举报人"；类别合法性、去重与配额都在 `reports.submit` 里判
  [C2S.REPORT]: needString('targetId', '被举报人 id'),
  [C2S.ADMIN_LOGIN]: needString('password', '管理密码'),
  [C2S.JOIN_ROOM]: needString('code', '6 位房间码'),
  [C2S.JOIN_TOURNAMENT]: needString('id', '赛事 id'),
  [C2S.JOIN_TOURNAMENT_MATCH]: needString('roomId', '对局房间 id'),
  [C2S.DEMO_MOVE]: needString('usi', 'USI 走法'),
  // ⚠️ `demo_enter` **刻意不设必填**：前端与 e2e 均以空 data 调用（`send('demo_enter', {})`），
  // roomId 由服务端依据连接身份定位所在对局。**不要**顺手给它加 roomId 必填——
  // 那会直接打断感想战进入（`tests/messages.test.js` 有专门的回归断言守着）。
  // 房间 id 与房间码二选一（大厅观战用 code，对局页/URL 用 roomId）
  [C2S.SPECTATE]: (d) => (
    nonEmptyString(d.roomId) || nonEmptyString(d.code)
      ? null
      : '缺少参数 data.roomId 或 data.code'
  ),
};

/**
 * 校验一条客户端消息。
 *
 * @param {string} type `msg.type`
 * @param {object} [data] `msg.data`
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function validate(type, data) {
  if (!isClientType(type)) {
    return { ok: false, error: `未知消息类型: ${type}` };
  }
  const rule = RULES[type];
  if (!rule) return { ok: true };
  // data 缺失或不是对象时按空对象处理，让规则统一给出「缺少参数」而不是抛错
  const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  const err = rule(d);
  return err ? { ok: false, error: `${type}: ${err}` } : { ok: true };
}

module.exports = { C2S, C2S_TYPES, isClientType, validate };
