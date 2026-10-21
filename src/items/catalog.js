/**
 * items/catalog.js — 道具目录（定义：id / 类型 / 稀有度 / 价格 / 素材）
 *
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 本文件只负责「定义」，不管谁拥有
 * （拥有/钱包/装备在 store.js + index.js）。条目形状见 DESIGN §5：
 *   { id, type, name, desc, rarity:'N'|'R'|'SR', price:number|null,
 *     asset:{kind:'glyph'|'image'|'audio', value}, unlock?:{type:'level'|'games', value} }
 *
 * ⚠️ 2026-10-21 商城化：目录**默认只有管理员录入的外置商品**。
 *   外置文件 `data/items-catalog.json`（后台「商城管理」写入）：
 *     [ {...}, {...} ]            或           { "items": [ {...} ] }
 *   - 外置项一律过 `normalizeItem` 校验，坏数据**跳过**而不是让整表崩掉。
 *   - 代码不再内置免费头像/BGM/皮肤 —— 素材与商品都由管理员上传、上架。
 *
 * - price===null ⇒ 免费，可直接装备，无需先获得（管理员可用它做免费头像/试用品）。
 * - 默认不装备任何装扮；玩家装备后才生效。
 */
'use strict';

const { readJson, writeJson } = require('../storage');

// ⚠️ 2026-10-03 新功能：道具系统骨架 —— 装备槽位（顺序即前端展示顺序）
// ⚠️ 2026-10-08：BGM 拆成三槽（菜单/开局/终盘），对应三轨 BGM。
// ⚠️ 2026-10-21：默认装备已清空；所有装扮由管理员上架、玩家自行装备。
const SLOTS = ['avatar', 'bgm-menu', 'bgm-game', 'bgm-endgame', 'sprite', 'pieces', 'board', 'byoyomi'];
/** 商品 type（BGM 商品统一 type='bgm'，装备到三个 bgm-* 任一槽） */
const ITEM_TYPES = ['avatar', 'bgm', 'sprite', 'pieces', 'board', 'byoyomi'];
const BGM_SLOTS = ['bgm-menu', 'bgm-game', 'bgm-endgame'];
const RARITIES = ['N', 'R', 'SR'];
/** synth = 程序合成音（仅为兼容旧外置数据保留；新商品请上传真实音频） */
const KINDS = ['glyph', 'image', 'audio', 'synth', 'audiopack']; // audiopack=读秒语音包 manifest（2026-10-12）
/** BGM 使用场景（role）：每首 BGM 有唯一场景，装备时自动落到对应槽位（2026-10-08） */
const BGM_ROLES = ['menu', 'game', 'endgame'];
const CATALOG_FILE = 'items-catalog.json';

/**
 * ⚠️ 2026-10-21 商城化：**默认不装备任何装扮**。
 *
 * BGM / 头像 / 立绘 / 棋子 / 棋盘 / 读秒音全部由管理员在后台「商城管理」上传并上架，
 * 玩家装备后才生效。此前内置的三首 BGM、默认棋子图集、默认合成读秒音已移除；
 * 这样代码仓库不再自带音乐/头像素材，也避免版权与包体问题。
 *
 * 保留常量是为了兼容既有导入（`items/index.js` / 测试），值必须为空对象。
 */
const DEFAULT_EQUIP = {};
const DEFAULT_BGM_EQUIP = {};

/**
 * ⚠️ 2026-10-21 商城化：目录**默认为空**。
 *
 * 原先这里内置了免费头像、示例 BGM/立绘/头像/棋子/读秒音；现在全部改由管理员
 * 在后台录入（写 `data/items-catalog.json`）。空目录的 UI 会显示「商城暂无商品」，
 * 首屏不会去请求 `/music/*.mp3` 这些已删除的素材。
 *
 * 如需预置运营商品，请写 `data/items-catalog.json`（格式同 `normalizeItem`），
 * 不要改这里 —— 代码目录保持“零素材、零默认装扮”。
 */
const DEFAULT_ITEMS = [];

/**
 * 2026-10-21：不再从 `auth.AVATARS` 派生免费头像。
 * 保留函数名是为了让 `buildCatalog` / `deleteItem` 的内置项判断保持简单。
 */
function freeAvatars() {
  return [];
}

/**
 * 按类型 / 素材值推断合法 asset.kind。
 * 管理员后台上传素材后会显式带 kind；外置数据常省略，这里按值兜底。
 *  - bgm → audio（不再允许 synth：默认合成曲已移除）
 *  - byoyomi → .json=audiopack / 音频=audio / 'default'|'synth'=兼容旧数据
 *  - 图片类 → 以 / 开头=image，否则 glyph
 */
function kindForType(type, value) {
  if (type === 'bgm' || (type && type.startsWith('bgm-'))) return 'audio';
  if (type === 'byoyomi') {
    const v = String(value || '');
    if (/\.json(\?|$)/i.test(v)) return 'audiopack';
    if (/\.(mp3|ogg|wav)(\?|$)/i.test(v) || v.startsWith('/')) return 'audio';
    if (v === 'default' || v === 'synth') return 'synth';
    return null;
  }
  return null; // 图片类：image | glyph 均可，由 normalizeItem 按值判断
}

/** 是否 BGM 商品 type（可装到 bgm-menu/game/endgame 任一槽） */
function isBgmType(type) {
  return type === 'bgm' || (typeof type === 'string' && type.startsWith('bgm-'));
}

/** 校验并归一化一条外置道具；不合法返回 null（跳过该条，不拖垮整表） */
function normalizeItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : null;
  if (!it) return null;
  const id = typeof it.id === 'string' ? it.id.trim() : '';
  if (!id) return null;
  // type 允许 ITEM_TYPES；兼容旧写法 bgm-menu 等（归一成 'bgm'）
  let type = typeof it.type === 'string' ? it.type.trim() : '';
  if (isBgmType(type)) type = 'bgm';
  if (!ITEM_TYPES.includes(type)) return null;
  const asset = it.asset && typeof it.asset === 'object' ? it.asset : null;
  if (!asset || typeof asset.value !== 'string' || !asset.value) return null;
  // kind 可省略：bgm 用 audio；byoyomi 按素材值推断；路径/URL 用 image；其余当 glyph
  let kind = KINDS.includes(asset.kind) ? asset.kind : kindForType(type, asset.value);
  if (!kind) {
    kind = asset.value.startsWith('/') ? 'image' : 'glyph';
  }
  if (!KINDS.includes(kind)) return null;
  const isVoice = kind === 'audio' || kind === 'synth' || kind === 'audiopack';
  if (isVoice && type !== 'bgm' && type !== 'byoyomi') return null;
  // BGM 只接受真实音频（2026-10-21：默认合成曲已移除，不再允许 synth BGM）
  if (type === 'bgm' && kind !== 'audio') return null;
  if (type === 'byoyomi' && !isVoice) return null;
  const price = it.price === null || it.price === undefined ? null : Number(it.price);
  if (price !== null && (!Number.isFinite(price) || price < 0)) return null;
  const out = {
    id,
    type,
    name: typeof it.name === 'string' && it.name.trim() ? it.name.trim().slice(0, 40) : id,
    desc: typeof it.desc === 'string' ? it.desc.trim().slice(0, 120) : '',
    rarity: RARITIES.includes(it.rarity) ? it.rarity : 'N',
    price,
    asset: { kind, value: asset.value },
  };
  if (it.unlock && typeof it.unlock === 'object' && typeof it.unlock.value === 'number') {
    out.unlock = { type: String(it.unlock.type || 'level'), value: it.unlock.value };
  }
  // ⚠️ 2026-10-11（问题3）：**限定装扮** —— 不进商城、不可购买，只能通过兑换码/活动发放获得。
  // 拥有后与普通装扮一样可装备、可在「我的装扮」里看到（前端按 `limited` 从商城网格里过滤掉）。
  if (it.limited === true) out.limited = true;
  // ⚠️ 2026-10-08：BGM 角色（menu/game/endgame）——每首 BGM 有唯一使用场景
  // ⚠️ 2026-10-12（P1-④）：**BGM 必有 role**。历史/外置数据可能缺 role，这里归一到 'game'
  //    （开局曲，最常用场景）而不是丢弃条目——缺 role 的 BGM 会让装备请求的槽位退化成
  //    'bgm'（不在 SLOTS 里 → BAD_SLOT），结果是「发了也永远装不上」。归一后从源头杜绝。
  if (type === 'bgm') {
    out.role = BGM_ROLES.includes(it.role) ? it.role : 'game';
  }
  return out;
}

/** 读外置目录（不存在/损坏 ⇒ 空数组，绝不影响内置目录） */
function loadExternalItems() {
  let raw = null;
  try {
    raw = readJson(CATALOG_FILE, null);
  } catch (_) { return []; }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
  return list.map(normalizeItem).filter(Boolean);
}

let cache = null;

/** 构建目录：默认空 + 外置（同 id 覆盖） */
function buildCatalog() {
  const byId = new Map();
  for (const it of freeAvatars()) byId.set(it.id, it);
  for (const it of DEFAULT_ITEMS) byId.set(it.id, it);
  for (const it of loadExternalItems()) byId.set(it.id, it); // 外置（后台录入）
  return [...byId.values()];
}

/** 目录（带缓存；首次访问时构建） */
function getCatalog() {
  if (!cache) cache = buildCatalog();
  return cache;
}

/** 重载目录（外置文件改完后调用；CLI/后台可用） */
function reloadCatalog() {
  cache = buildCatalog();
  return cache;
}

// ==================================================================
// 管理端 CRUD（2026-10-07 商品管理）：只写外置文件 data/items-catalog.json
// 内置项（免费头像 / DEFAULT_ITEMS）可被同 id 覆盖，删除仅对外置生效。
// ==================================================================

/** 读外置文件原始列表（未归一），用于就地改写 */
function loadRawExternal() {
  let raw = null;
  try { raw = readJson(CATALOG_FILE, null); } catch (_) { return []; }
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

function persistExternal(list) {
  return writeJson(CATALOG_FILE, { items: list });
}

/**
 * 新建 / 覆盖一条商品（写入外置目录并重载）。
 * @returns {{ok:true, item:object}|{ok:false, error:string, code:string}}
 */
function upsertItem(raw) {
  const item = normalizeItem(raw);
  if (!item) return { ok: false, error: '商品字段不合法（id/type/asset 必填且合法）', code: 'BAD_ITEM' };
  // 内置 id 允许覆盖；这里不做额外限制，外置同 id 优先（buildCatalog 已保证）
  const list = loadRawExternal().slice();
  const idx = list.findIndex((x) => x && typeof x === 'object' && String(x.id) === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  if (!persistExternal(list)) return { ok: false, error: '目录写入失败', code: 'PERSIST_FAILED' };
  reloadCatalog();
  return { ok: true, item };
}

/**
 * 删除商品。内置免费头像与 DEFAULT_ITEMS 不允许删（只能覆盖）——
 * 否则免费头像会消失、示例项被删后无法恢复。
 * @returns {{ok:true}|{ok:false, error:string, code:string}}
 */
function deleteItem(id) {
  const itemId = String(id || '').trim();
  if (!itemId) return { ok: false, error: '缺少商品 id', code: 'BAD_ID' };
  const builtin = freeAvatars().some((it) => it.id === itemId)
    || DEFAULT_ITEMS.some((it) => it.id === itemId);
  // 内置项：仅当外置文件里存在覆盖时才允许「删覆盖」，回落到内置定义
  const list = loadRawExternal();
  const idx = list.findIndex((x) => x && typeof x === 'object' && String(x.id) === itemId);
  if (idx < 0) {
    return builtin
      ? { ok: false, error: '内置商品不可删除（可覆盖修改）', code: 'BUILTIN' }
      : { ok: false, error: '商品不存在', code: 'NO_ITEM' };
  }
  list.splice(idx, 1);
  if (!persistExternal(list)) return { ok: false, error: '目录写入失败', code: 'PERSIST_FAILED' };
  reloadCatalog();
  return { ok: true, restoredBuiltin: builtin };
}

module.exports = {
  SLOTS, RARITIES, KINDS, ITEM_TYPES, BGM_SLOTS, DEFAULT_BGM_EQUIP, DEFAULT_EQUIP, isBgmType,
  getCatalog, reloadCatalog, CATALOG_FILE, normalizeItem,
  upsertItem, deleteItem, kindForType,
};
