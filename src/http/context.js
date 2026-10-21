/**
 * src/http/context.js — HTTP 层共享上下文（PLAN §M2 从 `server.js` 拆出）
 *
 * 路由拆成多个文件后，它们都需要同一批「服务级单例 + 通用工具」：
 *  - `protocol`：**唯一的**协议处理实例（REST 与 WebSocket 共用）；
 *  - `VERSION`：首页下发的版本号（排障时 `curl /api/home` 即可确认进程跑的是哪份代码）；
 *  - `resolvePlayer` / `sanitize` / `checkAdmin`：原先散在 `server.js` 顶部的通用函数。
 *
 * ⚠️ 放在这里而不是让各路由各自 require/构造，是为了**收敛 `protocol` 的唯一创建点**：
 * 它持有 rooms、连接表等内存状态，一旦某处顺手 `new Protocol()` 就会造出第二套状态，
 * 表现为「REST 查不到 WS 建的对局」这类极难定位的问题。
 */
'use strict';

const { Protocol } = require('../protocol');
const admin = require('../admin');
const accounts = require('../accounts');
const auth = require('../auth'); // resolveOwner 查「会话是否存在」（2026-10-12 P0：悬空 id 不可认领）

const VERSION = require('../../package.json').version;

/** 唯一的协议实例：REST 路由与 WebSocket 连接处理共用 */
const protocol = new Protocol({ onBroadcast: () => {} });

/**
 * 统一身份解析：把客户端传来的"身份参数"解析为服务端真正认识的对局玩家 id。
 *  - 游客：guest.id 本身即 24 hex 玩家 id，原样返回；
 *  - 账号：guest.id 是会话令牌（形如 `<accountId>.<ts>.<sig>`，含点），
 *    必须解析为 accountId——因为对局落盘的 playerIds / winnerId 存的是
 *    服务端 verifyToken 后的账号 id（24 hex），若直接用 token 匹配会查不到
 *    自己的棋谱（历史页空白 / 复盘 403 "只能复盘自己的棋谱"）。
 * @param {string|null} raw
 * @returns {string|null}
 */
function resolvePlayer(raw) {
  if (!raw) return null;
  if (String(raw).includes('.')) {
    const accountId = accounts.verifyToken(raw);
    // 解析失败（token 过期/伪造）回退原值：匹配不上自然返回空，不破坏现有行为
    return accountId || raw;
  }
  return raw;
}

/**
 * **归属判定**专用的严格身份解析（2026-09-21 安全审查 P0-4）。
 *
 * ⚠️⚠️ `resolvePlayer` 是**公开读**用的宽松解析：`/api/profile?player=<任意 id>` 本就该能查
 * 任何人（个人页、悬停卡都是公开数据）。但棋谱的六个接口拿它去做**归属判定**
 * （`records.isOwner`）—— 于是"知道别人的公开 id"就等于拿到了他的身份：
 * 无令牌即可导出/回放/复盘他人棋谱，还能以他的名义写评论、书签、变着（审查已实测复现）。
 *
 * 本函数把边界收紧：**注册账号必须凭签名令牌**；裸 id 只对游客成立。
 * 游客 id 目前"即凭证"的现状保持不变（要改需引入游客会话撤销机制，留下一版）。
 */
function resolveOwner(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (s.includes('.')) return accounts.verifyToken(s) || null; // 账号：必须凭令牌
  // 裸 24 hex：若是**已注册账号**的 id → 不可信（账号一律走令牌）
  if (/^[0-9a-f]{24}$/.test(s) && accounts.getAccount(s)) return null;
  // ⚠️ 2026-10-13 P0 修正（第二轮审查 §1.1）：**墓碑 id（凭证已撤销）不可信**——
  // 会话被删除后若仍放行，谁先来冒认谁就是死者棋谱的「谱主」（isOwner 命中 →
  // 越权读/导出对手私有棋谱 + 冒名评论）。与 WS 握手（protocol.handleConnection）同口径：
  // 只拦「曾存在、已被撤销」的 id；从未有过会话的裸 id 维持「id 即凭证」的已知取舍
  //（那是客户端自选的新游客 id，误杀过一次，e2e 身份全线崩）。
  if (auth.isTombstoned(s)) return null;
  return s; // 游客 id（现存会话或新游客 id；「id 即凭证」的现状保持不变）
}

/**
 * **写操作**专用的归属解析（B1，2026-10-21）。
 *
 * 读接口继续用 `resolveOwner`（兼容期：老浏览器没有 key，先不锁读）；
 * 但「以某人名义改数据」必须证明**持有**该会话，否则知道公开 guestId 就能
 * 替别人加书签/写评论/改变着（与改名/换头像同一类冒用）：
 *  - 账号令牌：令牌本身即凭证（`resolveOwner` 已验签）；
 *  - 已绑定 secret 的游客会话：必须带对 `key`，否则返回 `code='AUTH_KEY'`；
 *  - 未绑定 secret 的老会话 / 会话不存在：兼容放行
 *    （与 `auth.rename` / `auth.setAvatar` / 迁移凭据同一契约，别把功能一起关掉）。
 *
 * @param {*} raw 客户端声明的身份（游客 id 或账号令牌）
 * @param {*} key 游客持有证明（请求体 key / `x-guest-key` 头）
 * @returns {{ok:boolean, owner:string|null, code:string|null}}
 */
function resolveOwnerWrite(raw, key) {
  const owner = resolveOwner(raw);
  if (!owner) return { ok: false, owner: null, code: 'AUTH' };
  if (String(raw).includes('.')) return { ok: true, owner, code: null };
  const vk = auth.verifyKey(owner, key);
  if (vk.bound && !vk.ok) return { ok: false, owner: null, code: 'AUTH_KEY' };
  return { ok: true, owner, code: null };
}

/**
 * 统一「账号令牌」解析 —— **全项目唯一的账号鉴权取参入口**（2026-10-04 架构优化，体检 #8）。
 *
 * 背景：账号令牌此前在四处、以**四种口径**出现——
 *   `x-account-token`（赛事路由）/ `x-session-token`（账号、道具路由）/ `body.token` / `?token=`，
 * 每个新接口都要"记得抄全"，抄漏一处就是一个**不报错的静默越权/取不到身份**。
 * 这里把来源收敛成**一个优先级顺序**，与 `checkAdmin`（管理身份的唯一点）对称。
 *
 * ⚠️ 与 `resolveOwner` 的分工：本函数只回答"这是哪个账号"（鉴权），
 * 不回答"能不能动这条数据"（那是 `resolveOwner`/`isOwner` 的职责），别把两者混用。
 *
 * @param {import('express').Request} req
 * @returns {string|null} accountId；未登录/令牌无效 → null
 */
function resolveAccount(req) {
  const h = (req && req.headers) || {};
  const b = (req && req.body) || {};
  const q = (req && req.query) || {};
  const raw = h['x-account-token'] || h['x-session-token'] || b.token || q.token || q.accountToken || '';
  if (!raw) return null;
  try { return accounts.verifyToken(String(raw)) || null; } catch (_) { return null; }
}

/** 文件名清洗：去掉路径分隔与危险字符 */
function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 20) || '无名';
}

/**
 * 管理身份判定：通过返回 token，失败返回 null。**全项目唯一的判定入口。**
 *
 * 此前每个管理接口都手抄 `req.query.token || req.headers['x-admin-token']` + `admin.verify`，
 * 于是「新增接口忘记写校验」成了一个迟早会发生的错误类别（PLAN §Q7-1 的越权正是同源问题），
 * 而且这类疏漏**不报错、不被测试发现**，只会静默存在。收敛到这一处后，结构上消除了它。
 */
function checkAdmin(req) {
  const token = req.headers['x-admin-token'] || req.query.token || req.query.adminToken || null;
  return admin.verify(token) ? token : null;
}

module.exports = { protocol, VERSION, resolvePlayer, resolveOwner, resolveOwnerWrite, resolveAccount, sanitize, checkAdmin };
