/**
 * items/targets.js — 发放类写操作的**收件人解析与终检**（2026-10-12 P0）
 *
 * 为什么单独一个模块：`resolveAdminUserId` 原本只在 admin 路由里做"形态规范化"
 * （令牌 → accountId、缺会话则补建），**不校验收件人是否存在**——非空字符串原样透传。
 * 而道具层是"以字符串为键直接读写"的唯一出口，于是输错一个 id，`store.addItem`
 * 就静默写进一个**无人认领的孤儿键**：后台 toast「已发放」，收件人背包里什么都没有。
 * 这正是「管理员发放物品发放不出去」的根因。
 *
 * 抽出来有两重好处：
 *  ① 终检逻辑可被测试直接覆盖（admin.js 顶层 require 了半个服务端，不适合被单测加载）；
 *  ② 解析规则只此一份，后台其它发放入口可复用。
 *
 * ⚠️ 不要把这套"必须存在"的语义并进 `http/context.resolvePlayer`——那是给**公开读**用的
 * 宽松解析（个人页/悬停卡要能查任何人），收紧它会误伤公开读接口。
 */
'use strict';

const auth = require('../auth');
const accounts = require('../accounts');

/**
 * 身份形态规范化（与 `http/context.resolvePlayer` 同语义）：
 * 含 `.` 当令牌解析为 accountId；否则原样返回（游客 id / 裸 id）。
 * @param {string|null} raw
 * @returns {string|null}
 */
function resolvePlayerLoose(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (s.includes('.')) {
    const accountId = accounts.verifyToken(s);
    return accountId || s;
  }
  return s;
}

/**
 * 管理端「用户 id」解析（Bug3）：形态规范化 + 给缺会话的账号补建会话。
 * @param {string} raw
 * @returns {string|null} 规范化的会话 id，无法解析返回 null
 */
function resolveAdminUserId(raw) {
  const id = resolvePlayerLoose(raw);
  if (!id) return null;
  if (!auth.getSessionRaw(id)) {
    const acct = accounts.getAccount(id);
    if (acct) auth.markAccountSession(id, acct.username); // 账号必然应有会话；缺则补建
  }
  return id;
}

/**
 * 道具/发放类写操作的**收件人终检**（详细版）：返回 `{ok, id}` 或 `{ok:false, code, error}`。
 *
 * ⚠️ 2026-10-12 产品决策：**禁止发给游客**。理由——
 *  ① 道具/装扮的持有主体是「登录账号」（`/api/items` 走 `resolveAccount` → `verifyToken`），
 *     游客根本没有装扮背包入口，发了也看不到；
 *  ② 游客升级为账号时 `migrateGuestData` 只迁 评级 / 棋谱 / 会话，**不迁 items** ——
 *     发给游客的道具在注册那一刻就等于永久丢失。
 * 所以收件人必须是**注册账号**：`accounts.getAccount(id)` 命中才放行。
 *
 * 两条通道：
 *  ① id / 令牌 → 规范化后必须命中**注册账号**（游客 id 一律拒绝，返回 `code:'GUEST'`）；
 *  ② 否则按**登录用户名**精确匹配（`accounts.getAccountByName`）→ 账号 id。
 * 都落空才拒绝——**绝不静默写孤儿键**，也绝不写进游客键。
 *
 * @param {string} raw 路径里的 :id（账号 id / 令牌 / 登录用户名）
 * @returns {{ok:true, id:string}|{ok:false, code:string, error:string}}
 */
function resolveItemTargetDetail(raw) {
  const id = resolveAdminUserId(raw);
  if (id && accounts.getAccount(id)) return { ok: true, id };
  // ② 登录用户名通道（同样必须是注册账号）
  const byName = accounts.getAccountByName && accounts.getAccountByName(raw);
  if (byName && byName.id) {
    const id2 = resolveAdminUserId(byName.id);
    if (id2 && accounts.getAccount(id2)) return { ok: true, id: id2 };
  }
  // 落空：区分「游客」与「根本不存在」，给可操作的提示（否则管理员只会以为系统坏了）
  if (id && auth.getSessionRaw(id)) {
    return {
      ok: false,
      code: 'GUEST',
      error: '对方是游客，道具只发给注册账号（游客注册/升级为账号后才能持有装扮）',
    };
  }
  return {
    ok: false,
    code: 'NOT_FOUND',
    error: '账号不存在（支持账号 id / 令牌 / 登录用户名；注意昵称不作为查找依据）',
  };
}

/**
 * 道具/发放类写操作的**收件人终检**：只允许**注册账号**，返回账号 id 或 null。
 * 详细错误请用 `resolveItemTargetDetail`（区分「游客」与「不存在」）。
 *
 * @param {string} raw 路径里的 :id（账号 id / 令牌 / 登录用户名）
 * @returns {string|null}
 */
function resolveItemTarget(raw) {
  const r = resolveItemTargetDetail(raw);
  return r.ok ? r.id : null;
}

/** 收件人展示名（发放成功 toast 用；查不到则回落 id 前 8 位） */
function targetLabel(uid) {
  const acct = accounts.getAccount(uid);
  return acct ? (acct.nickname || acct.username) : String(uid).slice(0, 8);
}

module.exports = {
  resolvePlayerLoose,
  resolveAdminUserId,
  resolveItemTarget,
  resolveItemTargetDetail,
  targetLabel,
};
