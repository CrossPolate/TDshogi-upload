/**
 * items/catalog.js — 道具目录（定义：id / 类型 / 稀有度 / 价格 / 素材）
 *
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 本文件只负责「定义」，不管谁拥有
 * （拥有/钱包/装备在 store.js + index.js）。条目形状见 DESIGN §5：
 *   { id, type, name, desc, rarity:'N'|'R'|'SR', price:number|null,
 *     asset:{kind:'glyph'|'image'|'audio', value}, unlock?:{type:'level'|'games', value} }
 *
 * ⚠️ 2026-10-03 架构优化（目录外置）：目录 = 免费头像 ∪ 内置示例 ∪ **外置文件**。
 *   外置文件 `data/items-catalog.json`（可选，运营/活动可改，**不必发版**）：
 *     [ {...}, {...} ]            或           { "items": [ {...} ] }
 *   - 与内置项 **id 相同 ⇒ 覆盖**（改价格/素材/名称）；id 不同 ⇒ 新增。
 *   - 外置项一律过 `normalizeItem` 校验，坏数据**跳过**而不是让整表崩掉。
 *   - **免费头像始终由代码派生**（`auth.AVATARS`），不会因为外置文件漏维护而消失。
 *
 * - price===null ⇒ 免费（当前仅免费头像），可直接装备，无需先获得。
 * - 立绘/BGM/皮肤素材仍为空，暂用 glyph / 假路径占位（DESIGN §11 待定）。
 */
'use strict';

const auth = require('../auth');
const { readJson, writeJson } = require('../storage');

// ⚠️ 2026-10-03 新功能：道具系统骨架 —— 装备槽位（顺序即前端展示顺序）
// ⚠️ 2026-10-08：BGM 拆成三槽（菜单/开局/终盘），对应三轨 BGM；见 DEFAULT_BGM_EQUIP。
// ⚠️ 2026-10-08：棋子图集、读秒音也从设置迁入装扮 —— 见 DEFAULT_EQUIP。
const SLOTS = ['avatar', 'bgm-menu', 'bgm-game', 'bgm-endgame', 'sprite', 'pieces', 'board', 'byoyomi'];
/** 商品 type（BGM 商品统一 type='bgm'，装备到三个 bgm-* 任一槽） */
const ITEM_TYPES = ['avatar', 'bgm', 'sprite', 'pieces', 'board', 'byoyomi'];
const BGM_SLOTS = ['bgm-menu', 'bgm-game', 'bgm-endgame'];
const RARITIES = ['N', 'R', 'SR'];
/** synth = 程序合成音（无素材文件，如默认读秒「嗒」） */
const KINDS = ['glyph', 'image', 'audio', 'synth'];
const CATALOG_FILE = 'items-catalog.json';

/**
 * ⚠️ 2026-10-08 需求「所有玩家都自带这三首 BGM，且默认是装备的」：
 * 三首 OST 默认曲（loop=菜单 / 静弈=开局 / 制勝=终盘）price=null（自带、无需购买），
 * 并作为各槽的**默认装备**。未显式装备时按此回落；玩家可换成购买的其它 BGM。
 * ⚠️ 同日：棋子图集 / 读秒音同理 —— 内置项自带且默认装备（kinki / 合成读秒音）。
 */
const DEFAULT_EQUIP = {
  'bgm-menu': 'bgm-loop',
  'bgm-game': 'bgm-jingyi',
  'bgm-endgame': 'bgm-zhisheng',
  pieces: 'pieces-kinki',
  byoyomi: 'byoyomi-tick',
};
const DEFAULT_BGM_EQUIP = {
  'bgm-menu': DEFAULT_EQUIP['bgm-menu'],
  'bgm-game': DEFAULT_EQUIP['bgm-game'],
  'bgm-endgame': DEFAULT_EQUIP['bgm-endgame'],
};

/**
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 把 auth 的免费头像白名单派生成目录条目。
 * id 用字形的 Unicode 码点（稳定、可读、与字形一一对应），asset.value 存字形本身。
 */
function freeAvatars() {
  return auth.AVATARS.map((glyph) => ({
    id: `avatar-${glyph.codePointAt(0).toString(16)}`,
    type: 'avatar',
    name: `头像 ${glyph}`,
    desc: '默认免费头像',
    rarity: 'N',
    price: null, // 免费
    asset: { kind: 'glyph', value: glyph },
  }));
}

/**
 * ⚠️ 2026-10-03 新功能：道具系统骨架 —— 内置示例道具（用于打通 展示/购买/装备 闭环）。
 * ⚠️ 2026-10-07 商品管理：BGM 条目接上 OST 真曲（D:/data/download/TDshogiOST 已拷入 public/music）。
 * ⚠️ 2026-10-08：三首默认曲（loop / 静弈 / 制勝）**自带且默认装备**（price=null）；
 * 深层沉浸 / 空弦 作为可购买的对局曲（可装到任一 bgm-* 槽）。
 * （运营要改这些，直接在 `data/items-catalog.json` 里用同 id 覆盖即可，无需改代码。）
 */
const DEFAULT_ITEMS = [
  // —— 自带三首（默认装备，price=null=人人可装、无需购买）——
  // ⚠️ 2026-10-08：每首 BGM 有唯一使用场景（role 字段），装备时自动装到对应槽位。
  { id: 'bgm-loop', type: 'bgm', role: 'menu', name: '循环', desc: '菜单曲：没有对局时循环播放（自带）', rarity: 'N', price: null, asset: { kind: 'audio', value: '/music/loop.mp3' } },
  { id: 'bgm-jingyi', type: 'bgm', role: 'game', name: '静弈', desc: '开局曲：对局中循环（自带）', rarity: 'N', price: null, asset: { kind: 'audio', value: '/music/静弈.mp3' } },
  { id: 'bgm-zhisheng', type: 'bgm', role: 'endgame', name: '制勝', desc: '终盘曲：进入读秒时切换（自带）', rarity: 'N', price: null, asset: { kind: 'audio', value: '/music/制勝.mp3' } },
  // —— 可购买的对局/替换曲 ——
  { id: 'bgm-shen', type: 'bgm', role: 'game', name: '深层沉浸', desc: '深潜入局的长盘对局曲（替代开局曲）', rarity: 'R', price: 150, asset: { kind: 'audio', value: '/music/深层沉浸.mp3' } },
  { id: 'bgm-kongxian', type: 'bgm', role: 'game', name: '空弦', desc: '留白与张力，适合中盘缠斗（替代开局曲）', rarity: 'R', price: 150, asset: { kind: 'audio', value: '/music/空弦.mp3' } },
  // —— 立绘(sprite) ×2（glyph 占位，对局中大字形展示；管理员可上传真图覆盖）——
  { id: 'sprite-fox', type: 'sprite', name: '立绘·狐', desc: '示例立绘（glyph 占位）', rarity: 'R', price: 200, asset: { kind: 'glyph', value: '🦊' } },
  { id: 'sprite-cat', type: 'sprite', name: '立绘·猫', desc: '示例立绘（glyph 占位）', rarity: 'R', price: 200, asset: { kind: 'glyph', value: '🐱' } },
  // —— 头像 ×2（新字形，走道具获得）——
  { id: 'avatar-wolf', type: 'avatar', name: '头像·狼', desc: '示例头像（新字形）', rarity: 'R', price: 120, asset: { kind: 'glyph', value: '🐺' } },
  { id: 'avatar-unicorn', type: 'avatar', name: '头像·独角兽', desc: '示例头像（新字形）', rarity: 'SR', price: 600, asset: { kind: 'glyph', value: '🦄' } },
  // —— 棋子图集（2026-10-08 从设置迁入装扮；自带且默认装备 kinki）——
  { id: 'pieces-kinki', type: 'pieces', name: '棋子图集·金棋', desc: '默认木棋图集（自带）', rarity: 'N', price: null, asset: { kind: 'image', value: 'pieces/kinki.png' } },
  { id: 'pieces-ryoko', type: 'pieces', name: '棋子图集·良刻', desc: '备用字体风格（自带）', rarity: 'N', price: null, asset: { kind: 'image', value: 'pieces/ryoko.png' } },
  // —— 读秒音（2026-10-08 从设置迁入装扮；默认合成「嗒」）——
  { id: 'byoyomi-tick', type: 'byoyomi', name: '读秒·清脆', desc: '默认合成读秒音（自带）', rarity: 'N', price: null, asset: { kind: 'synth', value: 'default' } },
  // —— 棋盘皮肤 ×1（带 level 解锁条件示意）——
  { id: 'board-01', type: 'board', name: '棋盘皮肤·待补', desc: '示例棋盘皮肤（素材待补）', rarity: 'R', price: 300, asset: { kind: 'image', value: '/img/board-待补.png' }, unlock: { type: 'level', value: 3 } },
];

/**
 * 按槽位推断合法 asset.kind：头像/立绘/棋子/棋盘走图片或字形，BGM 走音频。
 * 上传素材后管理员建商品时不必手写 kind，减少对不上的机会。
 */
function kindForType(type) {
  if (type === 'bgm' || (type && type.startsWith('bgm-'))) return 'audio';
  if (type === 'byoyomi') return 'synth'; // 默认合成；有文件时由 normalizeItem 保留 audio
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
  // kind 可省略：bgm 用 audio；byoyomi 用 synth；路径/URL 用 image；其余当 glyph
  let kind = KINDS.includes(asset.kind) ? asset.kind : kindForType(type);
  if (!kind) {
    kind = asset.value.startsWith('/') ? 'image' : 'glyph';
  }
  if (!KINDS.includes(kind)) return null;
  if ((kind === 'audio' || kind === 'synth') && type !== 'bgm' && type !== 'byoyomi') return null;
  if (kind !== 'audio' && kind !== 'synth' && type === 'bgm') return null;
  if (type === 'byoyomi' && kind !== 'audio' && kind !== 'synth') return null;
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
  // ⚠️ 2026-10-08：BGM 角色（menu/game/endgame）——每首 BGM 有唯一使用场景
  const BGM_ROLES = ['menu', 'game', 'endgame'];
  if (type === 'bgm' && typeof it.role === 'string' && BGM_ROLES.includes(it.role)) {
    out.role = it.role;
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

/** 构建目录：免费头像 ∪ 内置示例 ∪ 外置（同 id 覆盖） */
function buildCatalog() {
  const byId = new Map();
  for (const it of freeAvatars()) byId.set(it.id, it);
  for (const it of DEFAULT_ITEMS) byId.set(it.id, it);
  for (const it of loadExternalItems()) byId.set(it.id, it); // 外置覆盖内置
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
