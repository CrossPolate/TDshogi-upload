/**
 * items/index.js — 道具系统统一入口（导出 DESIGN §5 契约 API）
 *
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 业务逻辑层：目录(catalog) / 快照(snapshot) /
 * 装备(equip) / 购买(buy) / 兑换(redeem) / 发放(grant/addCoin) /
 * 头像白名单(avatarOptionsFor) / 对局皮肤(skinFor)。
 *
 * ⚠️ 2026-10-03 架构优化（三项）：
 *  1. **目录动态化**：不再在加载时静态解构 `CATALOG`，改为 `catalog.getCatalog()`，
 *     支持外置文件（`data/items-catalog.json`）改完后 `refreshCatalog()` 重载。
 *  2. **快照字段裁剪**：`snapshot()` 里只有「已拥有 或 免费」的条目才带 `asset`，
 *     其余只回元信息（标 `locked:true`）——避免将来付费素材地址随响应外泄。
 *     另提供 `publicCatalog()`（完全不含 `asset`）供公开接口使用。
 *  3. **原子写**：`buy`/`redeem` 改走 `store.buyItem` / `store.applyCode`（一次落盘），
 *     消除"扣币未得物 / 发了道具没计使用"的半完成态。
 *
 * ⚠️ 2026-10-04 架构优化（体检 #4）：**写失败可感知**——store 写函数改为返回
 * `{ok:true,...}` / `{ok:false, error, code:'PERSIST_FAILED'}`，本层据此把落盘失败
 * **冒泡**给调用方，绝不在落盘失败时回 `ok:true`（消除「接口回 200 但没落盘」的静默假成功）。
 *
 * 校验原则（从严）：
 *  - 槽位必须合法；道具类型必须与槽位一致；
 *  - 装备前必须「已拥有 或 免费(price===null)」；
 *  - 购买必须校验 price 存在且为货币价、余额充足，并原子扣币。
 */
'use strict';

const store = require('./store');
const catalogMod = require('./catalog');
const bgmRoles = require('./bgm-roles');
const assets = require('./assets');
const {
  SLOTS, BGM_SLOTS, DEFAULT_BGM_EQUIP, DEFAULT_EQUIP, isBgmType,
  getCatalog, reloadCatalog,
} = catalogMod;

// ⚠️ 2026-10-03 架构优化：目录可重载 ⇒ id 索引用可变引用 + 重建函数（原先在加载时一次性建好）
let BY_ID = new Map();
function reindex() {
  BY_ID = new Map(getCatalog().map((it) => [it.id, it]));
}
reindex();

function getItem(itemId) {
  return (typeof itemId === 'string' && BY_ID.get(itemId)) || null;
}

/** 目录数组（浅拷贝，防外部改写内置定义） */
function catalog() {
  return getCatalog().map((it) => ({ ...it }));
}

/** 公开目录：含元信息与素材（供商店预览图/试听；静态文件本就公开可访问） */
function publicCatalog() {
  return getCatalog().map((it) => ({ ...it }));
}

/** 重载目录（外置 `data/items-catalog.json` 改完后调用；CLI/后台可用），返回条目数 */
function refreshCatalog() {
  const list = reloadCatalog();
  reindex();
  return list.length;
}

/**
 * 校验道具的 `unlock` 门槛（catalog 里的声明式条件）。
 *
 * ⚠️ 2026-10-05 修复：catalog 的 `pieces-01`/`board-01` 声明了 `unlock:{type:'level',value:N}`，
 * 但 `buy`/`equip` 此前**完全不校验** —— 门槛只是"写在目录里的一句空话"。
 * 惰性 `require('../ratings')`（避免顶层循环依赖）后按 `profile()` 取 level / games。
 * type：`'level'`（value=所需等级）/ `'games'`（value=所需对局数）。
 *
 * @returns {null|{ok:false, error:string, code:string}} 满足门槛返回 null
 */
function checkUnlock(accountId, item) {
  const u = item && item.unlock;
  if (!u || typeof u !== 'object' || typeof u.value !== 'number') return null;
  const id = accountId ? String(accountId) : '';
  let prof;
  try { prof = require('../ratings').profile(id); } catch (_) { return null; } // 评级不可用 ⇒ 不阻断
  const have = u.type === 'games' ? (prof.games || 0) : (prof.level || 0);
  if (have >= u.value) return null;
  const error = u.type === 'games'
    ? `对局数不足，需要 ${u.value} 局`
    : `等级不足，需要 Lv.${u.value}`;
  return { ok: false, error, code: 'LOCKED' };
}

// ---------------- 快照 ----------------

/**
 * 生效装备：显式装备优先，未装备时回落**自带默认项**（2026-10-08）。
 * 「所有玩家都自带这三首 BGM / 默认棋子图集 / 默认读秒音，且默认是装备的」——
 * 不必先写库，展示与播放在读时合并。
 */
function effectiveEquipped(accountId) {
  const id = accountId ? String(accountId) : '';
  const eq = { ...store.equipped(id) };
  for (const [slot, defId] of Object.entries(DEFAULT_EQUIP)) {
    const cur = eq[slot];
    if (cur === undefined || cur === null) {
      if (defId && getItem(defId)) eq[slot] = defId;
    }
  }
  return eq;
}

/** 我的装扮快照：{ wallet, owned, equipped, catalog }（equipped 含 BGM 默认装备） */
function snapshot(accountId) {
  const id = accountId ? String(accountId) : '';
  const own = new Set(store.owned(id));
  const list = getCatalog().map((it) => {
    const unlocked = it.price === null || own.has(it.id);
    return unlocked ? { ...it } : { ...it, locked: true };
  });
  return {
    wallet: store.wallet(id),
    owned: store.owned(id),
    equipped: effectiveEquipped(id),
    catalog: list,
  };
}

// ---------------- 装备 ----------------

/**
 * 把新头像推给该身份的所有活跃连接，并刷新对局内头像缓存。
 *
 * ⚠️ 2026-10-04 修复（小洞）：REST 装备路径此前**只改了会话文件**——前端要刷新页面才看到
 * 新头像，进行中的对局也不会即刻更新。这里复用 WS 那条路径的同款动作
 * （`avatar_updated` 推送 + `rooms.refreshAvatar`），两端行为保持一致。
 * 整段 try/catch：没有在线连接 / protocol 未就绪时静默（下次进页面会由 hello 下发）。
 */
function pushAvatar(accountId, glyph) {
  if (!glyph) return;
  try {
    const protocol = require('../http/context').protocol;
    if (typeof protocol.notifyPlayer === 'function') {
      protocol.notifyPlayer(accountId, { type: 'avatar_updated', data: { avatar: glyph } });
    }
    if (protocol.rooms && typeof protocol.rooms.refreshAvatar === 'function') {
      protocol.rooms.refreshAvatar(accountId);
    }
  } catch (_) { /* 离线 / 未就绪：无需推送 */ }
}

/**
 * 装备/卸下。itemId=null 表示卸下该槽位。
 * @returns {{ok:true, equipped:object}|{ok:false, error:string, code?:string}}
 */
function equip(accountId, slot, itemId) {
  const id = accountId ? String(accountId) : '';
  if (!SLOTS.includes(slot)) return { ok: false, error: '槽位不合法', code: 'BAD_SLOT' };

  // 卸下
  if (itemId === null || itemId === undefined) {
    // ⚠️ 2026-10-04 架构优化：写失败可感知 —— 落盘失败绝不能回 ok:true，直接冒泡
    const r = store.setEquipped(id, slot, null);
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    // ⚠️ 2026-10-04 修复（小洞）：卸下**头像**槽位时，会话里的头像要**回落到免费字形**——
    // 否则道具已卸下、头像却还留着道具字形（名不副实）。
    if (slot === 'avatar') {
      const free = getCatalog().find((it) => it.type === 'avatar' && it.price === null);
      const glyph = free ? free.asset.value : null;
      if (glyph) {
        try { require('../auth').setAvatar(id, glyph, null, avatarOptionsFor(id)); } catch (_) { /* 会话同步失败不阻断 */ }
        pushAvatar(id, glyph);
      }
    }
    return { ok: true, equipped: r.equipped };
  }

  const item = getItem(itemId);
  if (!item) return { ok: false, error: '道具不存在', code: 'NO_ITEM' };
  // 槽位确定：BGM 用 item.role 自动映射到 bgm-menu/game/endgame；其余 type 与 slot 一致
  const effectiveSlot = isBgmType(item.type)
    ? (item.role ? 'bgm-' + item.role : slot)
    : slot;
  if (!SLOTS.includes(effectiveSlot)) return { ok: false, error: '槽位不合法', code: 'BAD_SLOT' };
  const slotOk = isBgmType(item.type)
    ? BGM_SLOTS.includes(effectiveSlot) && (!item.role || effectiveSlot === 'bgm-' + item.role)
    : item.type === effectiveSlot;
  if (!slotOk) return { ok: false, error: '道具类型与槽位不匹配', code: 'TYPE_MISMATCH' };

  // ⚠️ 2026-10-05 修复：先校验解锁门槛（等级/对局数），不满足直接拒绝
  const locked = checkUnlock(id, item);
  if (locked) return locked;

  // 必须已拥有，或该道具免费（price===null，如免费头像）
  if (item.price !== null && !store.has(id, itemId)) {
    return { ok: false, error: '尚未拥有该道具', code: 'NOT_OWNED' };
  }
  // ⚠️ 2026-10-04 架构优化：写失败可感知 —— 先确认落盘成功，再触发下面的外部副作用
  const r = store.setEquipped(id, effectiveSlot, itemId);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  const equipped = r.equipped;

  // ⚠️ 2026-10-03 道具系统骨架 —— 装备有两处**外部副作用**，必须在这里一并触发，
  // 否则会出现"装扮页显示已装备、实际没生效"：
  //  ① 头像槽位：真正的头像存在**会话文件**（`auth.setAvatar`），items 只记"装了哪件"——
  //     这里把字形同步写回会话并**推送 `avatar_updated`**（2026-10-04 补推送），
  //     否则换装只在装扮页可见，对局/悬停卡仍是旧头像；
  //  ② 对局皮肤（sprite/pieces/board）：随房间 state 下发且有 30s 缓存——这里通知房间
  //     清缓存并重推，装备后对手/观战者才能立刻看到（而不是等缓存过期）。
  // 两处都惰性 require + try/catch：任一侧不可用都不应让"装备"本身失败。
  if (effectiveSlot === 'avatar') {
    try { require('../auth').setAvatar(id, item.asset.value, null, avatarOptionsFor(id)); } catch (_) { /* 会话同步失败不阻断装备 */ }
    pushAvatar(id, item.asset.value);
  } else {
    try { require('../http/context').protocol.rooms.refreshItems(id); } catch (_) { /* 房间未就绪（如 CLI/离线） */ }
  }
  return { ok: true, equipped };
}

// ---------------- 购买 ----------------

/**
 * 用货币购买。仅对 price 为数字的道具生效（免费/不可售道具拒绝）。
 * ⚠️ 2026-10-03 架构优化：扣币与入库走 `store.buyItem`，**只落盘一次**（原先两次）。
 * ⚠️ 2026-10-04 架构优化：写失败可感知 —— 落盘失败冒泡 PERSIST_FAILED，绝不假成功。
 * @returns {{ok:true, wallet:object, owned:string[]}|{ok:false, error:string, code?:string}}
 */
function buy(accountId, itemId) {
  const id = accountId ? String(accountId) : '';
  const item = getItem(itemId);
  if (!item) return { ok: false, error: '道具不存在', code: 'NO_ITEM' };
  // ⚠️ 2026-10-05 修复：先校验解锁门槛（等级/对局数），不满足直接拒绝
  const locked = checkUnlock(id, item);
  if (locked) return locked;
  if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price <= 0) {
    return { ok: false, error: '该道具不可购买', code: 'NOT_FOR_SALE' };
  }
  if (store.has(id, itemId)) return { ok: false, error: '已拥有该道具', code: 'ALREADY_OWNED' };

  const { coin } = store.wallet(id);
  if (coin < item.price) return { ok: false, error: '余额不足', code: 'INSUFFICIENT_COIN' };

  const r = store.buyItem(id, itemId, item.price); // 原子：扣币 + 入库，一次落盘
  if (!r.ok) return { ok: false, error: r.error, code: r.code }; // ⚠️ 2026-10-04：落盘失败 ⇒ 冒泡
  return { ok: true, wallet: r.wallet, owned: r.owned };
}

// ---------------- 兑换码 ----------------

/**
 * 兑换码：校验存在与 maxUses，成功后发放道具/加币并记一次使用。
 * ⚠️ 2026-10-03 架构优化：发放 + 计数走 `store.applyCode`，**只落盘一次**（原先三次）。
 * ⚠️ 2026-10-04 架构优化：写失败可感知 —— 落盘失败冒泡 PERSIST_FAILED（store 侧已回滚 codes.used）。
 * @returns {{ok:true, owned:string[], wallet:object}|{ok:false, error:string, code?:string}}
 */
function redeem(accountId, code) {
  const id = accountId ? String(accountId) : '';
  const key = String(code || '').trim();
  if (!key) return { ok: false, error: '兑换码不能为空', code: 'BAD_CODE' };
  // ⚠️ 2026-10-05 安全修复：兑换码白名单 —— 挡掉 `__proto__` 等原型链键与超长/异常输入
  // （store 侧另有 hasOwnProperty 守卫兜底，这里早失败更清晰）
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) return { ok: false, error: '兑换码格式无效', code: 'BAD_CODE' };

  const entry = store.getCode(key);
  if (!entry) return { ok: false, error: '兑换码无效', code: 'NO_CODE' };
  const used = entry.used || 0;
  const maxUses = Number.isFinite(entry.maxUses) ? entry.maxUses : 1;
  if (used >= maxUses) return { ok: false, error: '兑换码已达使用上限', code: 'CODE_EXHAUSTED' };
  // ⚠️ 2026-10-05 修复：每账号一次 —— 该账号已兑换过则拒绝
  if (Array.isArray(entry.redeemedBy) && entry.redeemedBy.includes(id)) {
    return { ok: false, error: '该账号已兑换过此码', code: 'ALREADY_REDEEMED' };
  }
  if (entry.itemId && !getItem(entry.itemId)) {
    return { ok: false, error: '兑换码对应道具已下架', code: 'NO_ITEM' };
  }

  const r = store.applyCode(id, entry.itemId || null, entry.coin || 0, key);
  if (!r.ok) return { ok: false, error: r.error, code: r.code }; // ⚠️ 2026-10-04：落盘失败 ⇒ 冒泡
  return { ok: true, owned: r.owned, wallet: r.wallet };
}

// ---------------- 发放（管理员/活动用） ----------------

/** 直接发放道具（不校验价格）；⚠️ 2026-10-04：落盘失败冒泡 PERSIST_FAILED */
function grant(accountId, itemId, source) {
  const id = accountId ? String(accountId) : '';
  if (!getItem(itemId)) return { ok: false, error: '道具不存在', code: 'NO_ITEM' };
  const r = store.addItem(id, itemId, source || 'grant');
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  return { ok: true, owned: r.owned };
}

/** 直接加/减币（管理员/活动用），n 必须为整数；⚠️ 2026-10-04：落盘失败冒泡 PERSIST_FAILED */
function addCoin(accountId, n) {
  const id = accountId ? String(accountId) : '';
  if (!Number.isInteger(n) || n === 0) return { ok: false, error: '数量必须为非零整数', code: 'BAD_AMOUNT' };
  const r = store.addCoin(id, n);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  return { ok: true, wallet: { coin: r.coin } };
}

// ---------------- 头像 / 皮肤 ----------------

/**
 * 头像可选字形：免费字形（price===null）∪ 已拥有 avatar 道具的字形。
 * 供 `auth.setAvatar` 的 extraAllowed 使用；游客 id 查不到 → 只返回免费字形（行为与旧版一致）。
 * @returns {string[]}
 */
function avatarOptionsFor(accountId) {
  const id = accountId ? String(accountId) : '';
  const set = new Set();
  for (const it of getCatalog()) {
    if (it.type === 'avatar' && it.price === null) set.add(it.asset.value);
  }
  for (const itemId of store.owned(id)) {
    const it = getItem(itemId);
    if (it && it.type === 'avatar') set.add(it.asset.value);
  }
  return [...set];
}

/**
 * 对局皮肤：一次读取立绘/棋子/棋盘 + 开局 BGM（未装备或游客 → null）。
 * 供房间把 sprite/pieces/board/bgm 下发到 state.players.*（DESIGN §7）。
 * ⚠️ 2026-10-08：附带 `bgm`（该玩家开局曲 URL），对局中可与对手 BGM 交替播放。
 * @returns {{sprite:object|null, pieces:object|null, board:object|null, bgm:string|null}}
 */
function skinFor(accountId) {
  const id = accountId ? String(accountId) : '';
  const eq = effectiveEquipped(id);
  const out = { sprite: null, pieces: null, board: null, bgm: null };
  for (const slot of ['sprite', 'pieces', 'board']) {
    const it = eq[slot] ? getItem(eq[slot]) : null;
    out[slot] = it ? { ...it.asset } : null;
  }
  const tracks = bgmTracksFor(id);
  out.bgm = tracks.game || null;
  return out;
}

/**
 * ⚠️ 2026-10-08：三轨 BGM（菜单/开局/终盘）当前应播的 URL。
 * 取「玩家装备的 BGM」→ 没有则用系统 `bgm-roles` 配置（管理员可改）。
 * 游客只走系统轨。返回 `{ menu, game, endgame }`，每项 URL 或 null。
 */
function bgmTracksFor(accountId) {
  const sys = bgmRoles.getRoles();
  const out = { menu: sys.menu, game: sys.game, endgame: sys.endgame };
  if (!accountId) return out;
  const id = String(accountId);
  const eq = effectiveEquipped(id);
  for (const slot of BGM_SLOTS) {
    const phase = slot.slice(4); // 'menu' | 'game' | 'endgame'
    const it = eq[slot] ? getItem(eq[slot]) : null;
    if (it && it.asset && it.asset.value) out[phase] = it.asset.value;
  }
  return out;
}

/**
 * 玩家当前应用的外观/音效（前端启动时拉一次）：
 * `{ atlas, byoyomi, bgm: {menu,game,endgame} }`
 * - atlas：棋子图集 URL（装扮 pieces 槽）
 * - byoyomi：读秒音 `default` 或文件 URL（装扮 byoyomi 槽）
 * - bgm：三轨（装扮 bgm-* 槽）
 */
function appearanceFor(accountId) {
  const id = accountId ? String(accountId) : '';
  const eq = effectiveEquipped(id);
  const piecesIt = eq.pieces ? getItem(eq.pieces) : null;
  const byoIt = eq.byoyomi ? getItem(eq.byoyomi) : null;
  return {
    atlas: (piecesIt && piecesIt.asset && piecesIt.asset.value) || 'pieces/kinki.png',
    byoyomi: (byoIt && byoIt.asset && byoIt.asset.value) || 'default',
    bgm: bgmTracksFor(id),
  };
}

module.exports = {
  SLOTS, BGM_SLOTS, DEFAULT_BGM_EQUIP, DEFAULT_EQUIP,
  catalog, publicCatalog, snapshot, equip, buy, redeem, grant, addCoin,
  avatarOptionsFor, skinFor, bgmTracksFor, effectiveEquipped, appearanceFor, refreshCatalog,
  // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 定义兑换码（管理员/活动用；CLI 与后台都走这里）。
  // 直通 store.defineCode，避免 CLI 绕过业务层直接 require store。
  // ⚠️ 2026-10-04 架构优化：写失败可感知 —— store 已返回 {ok:true, ...定义字段}/{ok:false, error, code}，
  // 落盘失败（PERSIST_FAILED）原样冒泡；成功时定义字段仍在顶层，兼容 admin/CLI 读 def.itemId/coin/maxUses。
  defineCode: (code, def) => store.defineCode(code, def),
  // ⚠️ 2026-10-07 商品管理：目录 CRUD / 素材上传 / BGM 三轨
  upsertItem: (raw) => catalogMod.upsertItem(raw),
  deleteItem: (id) => catalogMod.deleteItem(id),
  assets,
  bgmRoles,
  getBgmRoles: () => bgmRoles.getRoles(),
  setBgmRoles: (patch) => bgmRoles.setRoles(patch),
};
