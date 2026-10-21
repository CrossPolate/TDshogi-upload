/**
 * items/store.js — 道具持久化（data/items.json，走 storage 的 readJson/writeJson）
 *
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 内存缓存 + 变更落盘，仿 accounts.js 的
 * getCache()/persist() 模式。数据模型见 DESIGN §4：
 *   { wallets:{[accountId]:{coin}}, inventory:{[accountId]:{[itemId]:{at,source}}},
 *     equipped:{[accountId]:{[slot]:itemId|null}}, codes:{[CODE]:{itemId,coin,maxUses,used}} }
 *
 * - 键为 **accountId**（登录后 playerId 与之一致）；游客 id 永不命中 → 天然无道具。
 * - 本层只做"存取"，业务校验（槽位合法性/类型匹配/余额）在 index.js。
 *
 * ⚠️ 2026-10-04 架构优化：写失败可感知 / 原子回滚（体检 #4）——
 *   storage.writeJson 改为返回 boolean 后，本层所有写函数统一走 `withRollback`：
 *   先在内存里改（mutator）→ 落盘一次 → **落盘失败则把内存回滚成快照**（保证"内存 == 磁盘"），
 *   并返回 `{ok:false, error, code:'PERSIST_FAILED'}`，从结构上杜绝"接口回 200 但没落盘"的假成功。
 */
'use strict';

const { readJson, writeJson } = require('../storage');
const { SLOTS } = require('./catalog');

// ⚠️ 2026-10-03 新功能：道具系统骨架 —— 存储键（storage 的 kv 名）
const ITEMS_FILE = 'items.json';

let cache = null;

/** 归一化：补齐四个顶层分区的对象（老数据/坏数据兜底） */
function normalize(data) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  for (const k of ['wallets', 'inventory', 'equipped', 'codes', 'logs']) {
    if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = {};
  }
  return d;
}

function getCache() {
  if (!cache) cache = normalize(readJson(ITEMS_FILE, {}));
  return cache;
}

/** 落盘；返回 writeJson 的布尔结果（true=已写，false=写失败） */
function persist() {
  return writeJson(ITEMS_FILE, getCache());
}

/**
 * ⚠️ 2026-10-04 架构优化：写失败可感知 / 原子回滚 —— 统一写入口。
 *  1) 深拷贝内存快照；
 *  2) 在**内存**里执行 mutator（可能改多处，如扣币 + 入库）；
 *  3) 整体落盘一次；**失败 ⇒ 把内存还原成快照**，保证"内存 == 磁盘"，返回 PERSIST_FAILED。
 * @param {(cache:object)=>object} mutator 返回要合并进结果 `{ok:true, ...}` 的字段
 * @returns {{ok:true}|{ok:false,error:string,code:string}}
 */
function withRollback(mutator) {
  const c = getCache();
  const snapshot = JSON.parse(JSON.stringify(c)); // 深拷贝（结构简单，无函数/循环引用）
  const result = mutator(c);
  if (!persist()) {
    cache = snapshot; // 落盘失败 ⇒ 原子回滚到调用前
    return { ok: false, error: '存储写入失败，已回滚', code: 'PERSIST_FAILED' };
  }
  return { ok: true, ...result };
}

// ---------------- 钱包 ----------------

/** 读余额（只读视图；不存在返回 {coin:0}，不落库，避免游客 id 污染存储） */
function wallet(accountId) {
  const w = getCache().wallets[String(accountId)];
  return { coin: (w && Number.isFinite(w.coin)) ? w.coin : 0 };
}

/**
 * 增减余额（delta 可为负），返回 {ok:true, coin} 或 {ok:false, ...}
 * @param {object} [actor] 操作者（如 `{adminId}`）——随流水落盘，供后台对账/追责
 */
function addCoin(accountId, delta, actor) {
  const id = String(accountId);
  return withRollback((c) => {
    const cur = (c.wallets[id] && Number.isFinite(c.wallets[id].coin)) ? c.wallets[id].coin : 0;
    c.wallets[id] = { coin: cur + delta };
    writeLog(c, { kind: 'coin', accountId: id, coinDelta: delta, source: (actor && actor.source) || 'admin' }, actor);
    return { coin: c.wallets[id].coin };
  });
}

// ---------------- 库存 ----------------

/** 已拥有道具 id 列表 */
function owned(accountId) {
  const inv = getCache().inventory[String(accountId)];
  return inv ? Object.keys(inv) : [];
}

/** 是否已拥有某道具 */
function has(accountId, itemId) {
  const inv = getCache().inventory[String(accountId)];
  return !!(inv && inv[itemId]);
}

/**
 * 发放道具（已拥有则保留首次获得时间），返回 {ok:true, owned} 或 {ok:false, ...}
 * @param {object} [actor] 操作者（如 `{adminId}`）——随流水落盘，供后台对账/追责
 */
function addItem(accountId, itemId, source, actor) {
  const id = String(accountId);
  return withRollback((c) => {
    const inv = c.inventory[id] || (c.inventory[id] = {});
    if (!inv[itemId]) inv[itemId] = { at: Date.now(), source: source || 'grant' };
    writeLog(c, { kind: 'item', accountId: id, itemId, source: source || 'grant' }, actor);
    return { owned: Object.keys(inv) };
  });
}

// ---------------- 装备 ----------------

/** 从给定缓存视图取某账号的完整槽位状态（缺省槽位回填 null） */
function equippedView(c, id) {
  const e = c.equipped[id];
  const out = {};
  for (const slot of SLOTS) out[slot] = (e && e[slot]) || null;
  return out;
}

/** 读某账号的完整槽位状态（缺省槽位回填 null） */
function equipped(accountId) {
  return equippedView(getCache(), String(accountId));
}

/** 设置某槽位（itemId 传 null 表示卸下），返回 {ok:true, equipped} 或 {ok:false, ...} */
function setEquipped(accountId, slot, itemId) {
  const id = String(accountId);
  return withRollback((c) => {
    const e = c.equipped[id] || (c.equipped[id] = {});
    e[slot] = itemId || null;
    return { equipped: equippedView(c, id) };
  });
}

// ---------------- 兑换码 ----------------
// ⚠️ 2026-10-05 安全修复（原型污染 + 伪成功）：`codes` 是普通对象 `{}`，方括号取键
// `codes['__proto__']` 会命中 `Object.prototype`（**真值**）→ 被当成合法码放行，
// 且 `entry.used = ...` 会写到 `Object.prototype` 上（污染全进程）。统一收口：
//  ① 拒绝保留键；② 读写一律 `hasOwnProperty` 守卫（不碰原型链）；③ 赋值走合法键。
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

/** 键是否可安全用作 `codes` 的键（非保留键；非字符串一律拒绝） */
function isSafeCodeKey(key) {
  return typeof key === 'string' && key.length > 0 && !RESERVED_KEYS.includes(key);
}

/** 读 `codes` 里的**自有**键（原型链上的 `__proto__`/`toString` 等一律不算）；不存在/被拒返回 null */
function codeEntry(c, code) {
  const key = String(code);
  if (!isSafeCodeKey(key)) return null;
  if (!Object.prototype.hasOwnProperty.call(c.codes, key)) return null;
  return c.codes[key];
}

/** 读兑换码定义（不存在/保留键返回 null） */
function getCode(code) {
  return codeEntry(getCache(), code);
}

/** 定义/覆盖兑换码（管理员与活动用），返回 {ok:true, ...定义字段} 或 {ok:false, ...} */
function defineCode(code, def) {
  const key = String(code);
  if (!isSafeCodeKey(key)) return { ok: false, error: '兑换码格式无效', code: 'BAD_CODE' };
  return withRollback((c) => {
    // ⚠️ 2026-10-12 修复（第二轮审查 P2-17）：覆盖已有码时**保留使用状态**（used / redeemedBy）。
    // 此前整条覆盖写，管理员只是想改 maxUses / 补 itemId 重新定义一次，就会把使用计数清零、
    // 兑换名单清空 → 所有已兑换过的账号可以再兑换一次（重复得币 / 得道具）。
    const prev = codeEntry(c, key);
    const entry = {
      itemId: (def && def.itemId) || null,
      coin: (def && def.coin) || 0,
      maxUses: (def && def.maxUses) || 1,
      used: prev && Number.isFinite(prev.used) ? prev.used : ((def && def.used) || 0),
      // ⚠️ 2026-10-05 修复：每账号一次 —— 记录已兑换过的账号 id（随定义一并落盘/覆盖）
      redeemedBy: prev && Array.isArray(prev.redeemedBy)
        ? prev.redeemedBy.slice()
        : (Array.isArray(def && def.redeemedBy) ? def.redeemedBy.slice() : []),
    };
    c.codes[key] = entry;
    return { ...entry };
  });
}

/** 记一次使用（used+1），返回 {ok:true, ...} 或 {ok:false, ...}；码不存在返回 null */
function useCode(code) {
  if (!codeEntry(getCache(), code)) return null;
  return withRollback((c) => {
    const entry = codeEntry(c, code);
    entry.used = (entry.used || 0) + 1;
    return { ...entry };
  });
}

// ---------------- 原子组合（一次落盘）----------------
// ⚠️ 2026-10-03 架构优化（原子性）：`buy`/`redeem` 原本是"扣币落盘 + 发放落盘"两次独立写盘，
// 中途异常/崩溃会留下「扣了币没拿到道具」或「发了道具没计使用次数」。
// 这里把涉及多处的变更**先在内存里全部改完，再整体落盘一次**，消除这类半完成状态。
// ⚠️ 2026-10-04：再叠加 withRollback —— 这一次落盘若失败则整体回滚（内存 == 磁盘）。

/**
 * 原子购买：扣币 + 入库，只落盘一次。
 * 余额充足性由调用方（index.js）先校验——本函数只负责"一致地写入"。
 * @returns {{ok:true, owned:string[], wallet:{coin:number}}|{ok:false, error:string, code:string}}
 */
function buyItem(accountId, itemId, price) {
  const id = String(accountId);
  return withRollback((c) => {
    const inv = c.inventory[id] || (c.inventory[id] = {});
    if (!inv[itemId]) inv[itemId] = { at: Date.now(), source: 'buy' };
    const cur = (c.wallets[id] && Number.isFinite(c.wallets[id].coin)) ? c.wallets[id].coin : 0;
    c.wallets[id] = { coin: cur - price };
    writeLog(c, { kind: 'buy', accountId: id, itemId, coinDelta: -price, source: 'buy' });
    return { owned: Object.keys(inv), wallet: { coin: c.wallets[id].coin } };
  });
}

/**
 * 原子兑换：发放（道具 / 货币）+ 记一次使用，只落盘一次。
 * @returns {{ok:true, owned:string[], wallet:{coin:number}}|{ok:false, error:string, code:string}}
 */
function applyCode(accountId, itemId, coinDelta, code) {
  const id = String(accountId);
  return withRollback((c) => {
    if (itemId) {
      const inv = c.inventory[id] || (c.inventory[id] = {});
      if (!inv[itemId]) inv[itemId] = { at: Date.now(), source: 'redeem' };
    }
    if (coinDelta) {
      const cur = (c.wallets[id] && Number.isFinite(c.wallets[id].coin)) ? c.wallets[id].coin : 0;
      c.wallets[id] = { coin: cur + coinDelta };
    }
    // ⚠️ 2026-10-05 修复：走 codeEntry（保留键守卫，不碰原型链）；used+1 并记 redeemedBy
    const entry = codeEntry(c, code);
    if (entry) {
      entry.used = (entry.used || 0) + 1;
      if (!Array.isArray(entry.redeemedBy)) entry.redeemedBy = [];
      if (!entry.redeemedBy.includes(id)) entry.redeemedBy.push(id);
    }
    writeLog(c, {
      kind: 'redeem', accountId: id, itemId: itemId || null,
      coinDelta: coinDelta || 0, source: 'redeem', code,
    });
    return {
      owned: c.inventory[id] ? Object.keys(c.inventory[id]) : [],
      wallet: { coin: (c.wallets[id] && c.wallets[id].coin) || 0 },
    };
  });
}

// ---------------- 发放 / 货币流水（append-only） ----------------
// ⚠️ 2026-10-12（P2-⑥）：每笔发放 / 加币 / 购买 / 兑换**与变更同事务**写一条流水，
// 供后台对账、排查滥发、错发纠正。此前只有 adminAction 审计，事后查不出"谁给谁发过
// 什么、发了几件"。只增不改（append-only），随 items.json 落盘（后续关系化可平移到表）。
//
// ⚠️ 2026-10-12 二轮补齐三点：
//  ① **记操作者**：`actor.adminId` —— 缺了它就无法真正对账（只能拿时间戳跟 adminAction 对齐，很脆）；
//  ② **上限裁剪**：`LOG_MAX` 条封顶，超出删最旧的 —— 否则流水只增不减，而 items.json 每次
//     变更都要整块重写（withRollback 全量深拷贝 + 落盘），会持续放大写入成本；
//  ③ **key 唯一**：`logSeq` 重启后会归零，直接拼 `${at}-${seq}` 有撞键覆盖风险，这里用重试兜住。
const LOG_MAX = 2000; // 流水保留上限（超出删最旧）
let logSeq = 0;

/**
 * 写一条流水（与业务变更同一个 withRollback 事务里调用，落盘失败会一起回滚）。
 * @param {object} c 缓存（withRollback 传入的可变引用）
 * @param {object} entry 流水字段（kind/accountId/itemId/coinDelta/source/code…）
 * @param {object} [actor] 操作者 `{ adminId }`（发放/加币必传；buy/redeem 无须）
 */
function writeLog(c, entry, actor) {
  if (!c.logs || typeof c.logs !== 'object' || Array.isArray(c.logs)) c.logs = {};
  const at = Date.now();
  let key = `${at}-${String(++logSeq).padStart(4, '0')}`;
  // 同毫秒 + 重启后 seq 归零 会撞 key → 重试直到唯一（绝不覆盖已有流水）
  let guard = 0;
  while (c.logs[key] && guard++ < 1000) {
    key = `${at}-${String(++logSeq).padStart(4, '0')}`;
  }
  const rec = Object.assign({ at }, entry);
  // 操作者：只留非敏感标识（绝不落 token 本身，见 adminWrite 的同款约定）
  if (actor && actor.adminId) rec.adminId = String(actor.adminId);
  c.logs[key] = rec;
  // 上限裁剪：删最旧（key 前缀是毫秒时间戳，字典序即时间序）
  const keys = Object.keys(c.logs);
  if (keys.length > LOG_MAX) {
    keys.sort();
    for (let i = 0; i < keys.length - LOG_MAX; i++) delete c.logs[keys[i]];
  }
}

/** 最近 n 条流水（按时间倒序），供后台「发放记录」 */
function recentLogs(n) {
  const logs = getCache().logs || {};
  return Object.keys(logs)
    .map((k) => Object.assign({ id: k }, logs[k]))
    .sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)))
    .slice(0, Math.max(1, Number(n) || 50));
}

module.exports = {
  getCache, persist, withRollback,
  wallet, addCoin,
  owned, has, addItem,
  equipped, setEquipped,
  getCode, defineCode, useCode,
  buyItem, applyCode,
  writeLog, recentLogs,
};
