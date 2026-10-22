/**
 * items/packs.js — 装扮扩展包（.tdpack）的校验、安装与上下架
 *
 * 包结构（ZIP，根目录必须有 manifest.json）：
 *   manifest.json
 *   cover.webp | cover.png | cover.jpg          （可选，商城卡片封面）
 *   LICENSE.txt                                  （可选；与 manifest.license 至少一项）
 *   avatars/<file> sprites/<file> pieces/<file> boards/<file> bgm/<file>
 *   byoyomi/<remain_60.mp3 … count_01.mp3>       （读秒语音包目录）
 *
 * manifest 关键字段：
 *   { "format":"tdshogi-pack", "formatVersion":1, "id":"sakura", "name":"樱",
 *     "versionName":"1.0.0", "author":"…", "license":"CC-BY-4.0",
 *     "items":[ { "id":"sakura-avatar", "type":"avatar", "file":"avatars/a.png",
 *                 "name":"樱头像", "price":500, "rarity":"R" },
 *               { "type":"bgm", "role":"menu", "file":"bgm/menu.mp3" },
 *               { "type":"byoyomi", "dir":"byoyomi" } ] }
 *
 * 安装流程刻意分成两步（管理端）：
 *   1) 上传 → 完整校验 + 返回报告（不落商品目录）；
 *   2) 确认授权 → 安装为**草稿**（玩家不可见/不可买/不可装备）→ 管理员预览 → 发布。
 *
 * 失败回滚：文件目录、素材登记、商品目录、包登记四处任一写入失败，都会恢复安装前状态，
 * 不留“半套商品 + 半套文件”的中间态。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('../storage');
const catalog = require('./catalog');
const assets = require('./assets');
const bgmRoles = require('./bgm-roles');
const audio = require('./audio');
const byoyomi = require('./byoyomi');
const { templateZip } = require('./pack-template');
const { readZip } = require('./zip');

const ROOT = path.join(__dirname, '..', '..');
const PACK_ROOT = process.env.ITEMS_PACK_DIR
  ? path.resolve(process.env.ITEMS_PACK_DIR)
  : path.join(ROOT, 'public', 'uploads', 'packs');
const PACKS_FILE = 'items-packs.json';
const TMP_ROOT = path.join(os.tmpdir(), 'tdshogi-pack-tmp');
const TMP_TTL_MS = 30 * 60 * 1000;

const MAX_ITEMS = 64;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 128 * 1024;
const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROOT_ALLOW = /^(manifest\.json|README\.txt|LICENSE\.txt|cover\.(png|jpe?g|webp)|(avatars|sprites|pieces|boards|bgm|byoyomi)\/.+)$/i;

function fail(error, code, extra) {
  return { ok: false, error, code: code || 'PACK_INVALID', ...(extra || {}) };
}

function relUrl(packId, ...parts) {
  return '/uploads/packs/' + [packId, ...parts].map((p) => encodeURIComponent(p)).join('/');
}

function extOf(p) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(p || ''));
  return m ? m[1].toLowerCase() : '';
}

function safeRemoveDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 尽力清理 */ }
}

// ==================================================================
// 包登记（data/items-packs.json）
// ==================================================================

function loadRegistry() {
  const raw = readJson(PACKS_FILE, { packs: {} });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { packs: {} };
  const packs = raw.packs && typeof raw.packs === 'object' && !Array.isArray(raw.packs) ? raw.packs : {};
  return { packs };
}

function persistRegistry(reg) {
  return writeJson(PACKS_FILE, reg);
}

/** 单个包登记（含实时商品列表，供管理端展示） */
function getPack(packId) {
  const id = String(packId || '').trim();
  if (!id) return null;
  const entry = loadRegistry().packs[id];
  if (!entry) return null;
  return decoratePack(entry);
}

function decoratePack(entry) {
  const items = catalog.packItems(entry.id);
  return {
    ...entry,
    items,
    itemCount: items.length,
    status: entry.status === 'published' ? 'published' : 'draft',
  };
}

/** 全部包（按安装时间倒序） */
function listPacks() {
  return Object.values(loadRegistry().packs)
    .filter((p) => p && typeof p === 'object' && p.id)
    .map(decoratePack)
    .sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
}

// ==================================================================
// manifest 解析与包内文件校验
// ==================================================================

/** 默认商品 id：`<packId>-<type>[-<role>]` */
function defaultItemId(packId, type, role) {
  return `${packId}-${type}${role ? '-' + role : ''}`.slice(0, 64);
}

function parseManifest(buf) {
  if (!buf || !buf.length) return fail('manifest.json 为空');
  if (buf.length > MANIFEST_MAX_BYTES) return fail('manifest.json 过大（上限 128KB）');
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch (_) { return fail('manifest.json 不是合法 JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return fail('manifest.json 必须是对象');
  if (m.format !== 'tdshogi-pack') return fail('manifest.format 必须为 "tdshogi-pack"');
  if (Number(m.formatVersion) !== 1) return fail('manifest.formatVersion 必须为 1');
  const id = String(m.id || '').trim().toLowerCase();
  if (!PACK_ID_RE.test(id)) return fail('manifest.id 不合法（小写字母/数字/-/_，2–41 位）');
  const name = String(m.name || '').trim();
  if (!name) return fail('manifest.name 不能为空');
  if (!Array.isArray(m.items) || !m.items.length) return fail('manifest.items 至少包含一个商品');
  if (m.items.length > MAX_ITEMS) return fail(`单个扩展包最多 ${MAX_ITEMS} 件商品`);

  const pack = {
    id,
    name: name.slice(0, 60),
    versionName: String(m.versionName || m.version || '1.0.0').trim().slice(0, 40) || '1.0.0',
    author: String(m.author || '').trim().slice(0, 60),
    license: String(m.license || '').trim().slice(0, 80),
    description: String(m.description || '').trim().slice(0, 300),
    coverPath: typeof m.cover === 'string' ? m.cover.trim() : '',
    items: m.items,
  };
  return { ok: true, pack };
}

/** 比较尺寸，返回错误或 warning */
function checkImage(info, type, label, warnings) {
  const w = info.width;
  const h = info.height;
  if (!w || !h) return `无法读取 ${label} 的尺寸`;
  if (type === 'avatar') {
    return w === 256 && h === 256 ? null : `${label} 必须是 256×256（当前 ${w}×${h}）`;
  }
  if (type === 'sprite') {
    const min = Math.min(w, h); const max = Math.max(w, h);
    return min >= 64 && max <= 2048 ? null : `${label} 尺寸需在 64–2048（当前 ${w}×${h}）`;
  }
  if (type === 'pieces') {
    const ratio = w / h;
    if (w < 64 || h < 64 || w > 4096 || h > 4096) return `${label} 尺寸需在 64–4096（当前 ${w}×${h}）`;
    if (ratio < 1.96 || ratio > 2.04) return `${label} 必须为 2:1 图集（8 列 × 4 行，推荐 512×256，当前 ${w}×${h}）`;
    if (w % 8 !== 0) warnings.push(`${label} 宽度 ${w} 不能被 8 整除，棋子格可能不是正方形`);
    return null;
  }
  if (type === 'cover') {
    const min = Math.min(w, h); const max = Math.max(w, h);
    return min >= 64 && max <= 2048 ? null : `${label} 尺寸需在 64–2048（当前 ${w}×${h}）`;
  }
  const min = Math.min(w, h); const max = Math.max(w, h);
  if (min < 64 || max > 4096) return `${label} 尺寸需在 64–4096（当前 ${w}×${h}）`;
  if (min < 512) warnings.push(`${label} 仅 ${w}×${h}，棋盘铺满后可能偏糊，建议 ≥512`);
  return null;
}

function imageInfo(buf, type, label, warnings) {
  if (!buf || !buf.length) return { error: `${label} 为空` };
  if (buf.length > MAX_IMAGE_BYTES) return { error: `${label} 过大（上限 4MB）` };
  const info = assets.imageSize(buf);
  if (!info) return { error: `${label} 不是有效图片（png / jpg / webp）` };
  const err = checkImage(info, type, label, warnings);
  if (err) return { error: err };
  return { info };
}

/** 收集读秒文件：支持 dir（目录）与 files（显式 key→路径） */
function collectCueSources(item, entries) {
  const out = {};
  if (typeof item.dir === 'string' && item.dir.trim()) {
    const dir = item.dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = dir + '/';
    for (const name of entries.keys()) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      out[rest] = name;
    }
  }
  if (item.files && typeof item.files === 'object' && !Array.isArray(item.files)) {
    for (const [key, p] of Object.entries(item.files)) {
      if (typeof p === 'string' && p) out[key] = p.replace(/\\/g, '/');
    }
  }
  return out;
}

/**
 * 校验整个包（不落盘）。
 * @param {Buffer} buf
 * @param {{strictByoyomi?:boolean}} [opts] strictByoyomi=false 供“单独导入读秒 ZIP”使用
 * @returns {Promise<object>}
 */
async function validatePack(buf, opts) {
  const strictByoyomi = !(opts && opts.strictByoyomi === false);
  const zip = await readZip(buf, { allow: (name) => ROOT_ALLOW.test(name) });
  if (!zip.ok) return zip;
  const entries = zip.entries;
  const warnings = [];

  const mfBuf = entries.get('manifest.json');
  if (!mfBuf) return fail('扩展包根目录缺少 manifest.json', 'NO_MANIFEST');
  const parsed = parseManifest(mfBuf);
  if (!parsed.ok) return parsed;
  const pack = parsed.pack;

  if (!pack.license && !entries.get('LICENSE.txt')) {
    return fail('缺少授权信息：请在 manifest.license 填写许可证，或在包内附 LICENSE.txt', 'NO_LICENSE');
  }
  if (!pack.license && entries.get('LICENSE.txt')) {
    warnings.push('manifest.license 为空，已使用 LICENSE.txt 作为授权说明');
  }

  const ids = new Set();
  const usedFiles = new Set();
  const prepared = [];

  for (let i = 0; i < pack.items.length; i += 1) {
    const raw = pack.items[i];
    if (!raw || typeof raw !== 'object') return fail(`items[${i}] 不是对象`);
    const type = String(raw.type || '').trim();
    if (!catalog.ITEM_TYPES.includes(type)) return fail(`items[${i}].type 不合法：${type || '(空)'}`);
    const role = type === 'bgm' ? String(raw.role || '').trim() : '';
    if (type === 'bgm' && !catalog.BGM_ROLES.includes(role)) {
      return fail(`items[${i}] 是 BGM，必须指定 role：menu / game / endgame`);
    }
    const id = String(raw.id || defaultItemId(pack.id, type, role)).trim();
    if (!ITEM_ID_RE.test(id)) return fail(`items[${i}].id 不合法：${id}`);
    if (ids.has(id)) return fail(`items[${i}].id 重复：${id}`);
    ids.add(id);
    const name = String(raw.name || id).trim().slice(0, 40) || id;
    const desc = String(raw.desc || '').trim().slice(0, 120);
    const rarity = catalog.RARITIES.includes(raw.rarity) ? raw.rarity : 'N';
    let price = raw.price === null || raw.price === undefined ? null : Number(raw.price);
    if (price !== null && (!Number.isFinite(price) || price < 0)) return fail(`items[${i}].price 不合法`);
    const limit = String(raw.file || raw.dir || '').trim();

    const item = {
      id, type, name, desc, rarity, price,
      limited: raw.limited === true,
      role: role || undefined,
      source: null,
      info: {},
      warnings: [],
    };
    if (raw.unlock && typeof raw.unlock === 'object'
      && (raw.unlock.type === 'level' || raw.unlock.type === 'games')
      && Number.isFinite(Number(raw.unlock.value)) && Number(raw.unlock.value) > 0) {
      item.unlock = { type: raw.unlock.type, value: Math.floor(Number(raw.unlock.value)) };
    }

    if (type === 'byoyomi') {
      const sources = collectCueSources(raw, entries);
      if (!Object.keys(sources).length) {
        return fail(`items[${i}]（读秒音）未找到音频：请用 dir 指定目录，或用 files 逐条指定`);
      }
      // files 里显式写规范 key（count_01 等）时直接采用；其余按文件名自动映射
      const direct = {};
      const rest = [];
      for (const [key, p] of Object.entries(sources)) {
        if (byoyomi.CUE_KEYS.includes(key)) direct[key] = p;
        else rest.push(p);
      }
      const { mapped, unknown, duplicates } = byoyomi.mapCueFiles(rest);
      const full = { ...mapped, ...direct };
      for (const [key, p] of Object.entries(full)) {
        if (!entries.has(p)) return fail(`items[${i}] 引用的读秒文件不存在（${key}）：${p}`);
      }
      if (unknown.length) warnings.push(`读秒音有 ${unknown.length} 个文件未识别，已忽略：${unknown.slice(0, 6).join('、')}`);
      if (duplicates.length) warnings.push(`读秒音有重复条目，已保留规范名：${duplicates.map((d) => d.dropped).join('、')}`);
      const built = byoyomi.buildManifest(full, { lenient: !strictByoyomi });
      if (!built.ok) return fail(`items[${i}]（读秒音）${built.error}`, built.code, { missing: built.missing });
      item.warnings.push(...built.warnings);

      let container = null;
      for (const key of byoyomi.CUE_KEYS) {
        const p = full[key];
        if (!p) continue;
        const cue = await audio.validateByoyomiCue(entries.get(p), `${name}/${key}`);
        if (!cue.ok) return fail(`items[${i}]（读秒音）${cue.error}`, cue.code);
        if (!container) container = cue.info.kind;
        else if (container !== cue.info.kind) warnings.push(`读秒音混用了多种容器（${container} / ${cue.info.kind}），建议统一 MP3`);
        usedFiles.add(p);
        item.warnings.push(...(cue.warnings || []));
      }
      item.source = { kind: 'cues', dir: raw.dir || null, files: full };
      item.info = { cues: byoyomi.CUE_KEYS.filter((k) => full[k]).length };
      item.summary = `读秒语音包 · ${item.info.cues}/13 条`;
    } else {
      const file = limit;
      if (!file) return fail(`items[${i}] 缺少 file`);
      if (!entries.has(file)) return fail(`items[${i}] 引用的文件不存在：${file}`);
      const buf2 = entries.get(file);
      usedFiles.add(file);
      if (type === 'bgm') {
        const r = await audio.validateBgm(buf2, `${name}/${file}`);
        if (!r.ok) return fail(`items[${i}]（BGM）${r.error}`, r.code);
        item.source = { kind: 'file', path: file };
        item.info = r.info;
        item.summary = `BGM · ${Math.round(r.info.durationMs / 1000)} 秒 · ${r.info.kind.toUpperCase()}`;
        item.warnings.push(...(r.warnings || []));
      } else {
        const r = imageInfo(buf2, type, `${name}/${file}`, item.warnings);
        if (r.error) return fail(`items[${i}] ${r.error}`, 'BAD_IMAGE');
        item.source = { kind: 'file', path: file };
        item.info = r.info;
        item.summary = `${r.info.width}×${r.info.height} · ${r.info.type.toUpperCase()}`;
      }
    }
    prepared.push(item);
  }

  // 封面：manifest.cover 优先，否则根目录 cover.*
  let coverPath = '';
  if (pack.coverPath) {
    if (!entries.has(pack.coverPath)) return fail(`cover 指定的文件不存在：${pack.coverPath}`);
    coverPath = pack.coverPath;
  } else {
    coverPath = ['cover.webp', 'cover.png', 'cover.jpg', 'cover.jpeg']
      .find((n) => entries.has(n)) || '';
  }
  let coverInfo = null;
  if (coverPath) {
    const r = imageInfo(entries.get(coverPath), 'cover', `封面/${coverPath}`, warnings);
    if (r.error) return fail(r.error, 'BAD_COVER');
    coverInfo = r.info;
    usedFiles.add(coverPath);
  }

  const licenseTxt = entries.get('LICENSE.txt');
  if (licenseTxt) {
    if (licenseTxt.length > 64 * 1024) return fail('LICENSE.txt 过大（上限 64KB）');
    usedFiles.add('LICENSE.txt');
  }
  const readme = entries.get('README.txt');
  if (readme) {
    if (readme.length > 64 * 1024) return fail('README.txt 过大（上限 64KB）');
    usedFiles.add('README.txt');
  }

  const unreferenced = [...entries.keys()].filter((n) => !usedFiles.has(n) && n !== 'manifest.json');
  if (unreferenced.length) {
    warnings.push(`包内有 ${unreferenced.length} 个未引用文件（已忽略）：${unreferenced.slice(0, 8).join('、')}`);
  }
  if (prepared.filter((it) => it.type === 'bgm').length > 1) {
    const roles = prepared.filter((it) => it.type === 'bgm').map((it) => it.role);
    if (new Set(roles).size !== roles.length) warnings.push('同一扩展包含多首相同场景的 BGM，玩家只能装备其中一首');
  }

  return {
    ok: true,
    pack: {
      ...pack,
      coverPath: coverPath || '',
      coverInfo,
      licenseText: licenseTxt ? licenseTxt.toString('utf8').slice(0, 500) : '',
    },
    items: prepared,
    warnings,
    entries,
    totalBytes: zip.totalBytes,
  };
}

/** 校验报告（可 JSON 序列化，不包含文件内容） */
function reportOf(parsed) {
  return {
    ok: true,
    pack: {
      id: parsed.pack.id,
      name: parsed.pack.name,
      versionName: parsed.pack.versionName,
      author: parsed.pack.author,
      license: parsed.pack.license,
      description: parsed.pack.description,
      hasCover: !!parsed.pack.coverPath,
    },
    items: parsed.items.map((it) => ({
      id: it.id,
      type: it.type,
      name: it.name,
      role: it.role || null,
      rarity: it.rarity,
      price: it.price,
      summary: it.summary,
      warnings: it.warnings,
    })),
    warnings: parsed.warnings,
    totalBytes: parsed.totalBytes,
  };
}

// ==================================================================
// 安装
// ==================================================================

/** 写包内文件到临时目录，返回 {files, assetList, catalogItems, coverUrl, license} */
function materialize(parsed, tempDir) {
  const pack = parsed.pack;
  const entries = parsed.entries;
  const assetList = [];
  const catalogItems = [];
  fs.mkdirSync(tempDir, { recursive: true });

  for (const it of parsed.items) {
    let url;
    if (it.source.kind === 'cues') {
      const itemDir = path.join(tempDir, it.id);
      fs.mkdirSync(itemDir, { recursive: true });
      const manifestFiles = {};
      for (const key of byoyomi.CUE_KEYS) {
        const src = it.source.files[key];
        if (!src) continue;
        const buf = entries.get(src);
        const ext = extOf(src) || 'mp3';
        const destName = `${key}.${ext}`;
        fs.writeFileSync(path.join(itemDir, destName), buf);
        manifestFiles[key] = destName;
      }
      const mf = { version: 2, format: 'tdshogi-byoyomi', cueMode: 'count', files: manifestFiles };
      fs.writeFileSync(path.join(itemDir, 'manifest.json'), JSON.stringify(mf, null, 2));
      url = relUrl(pack.id, it.id, 'manifest.json');
      assetList.push({ kind: 'audiopack', name: it.name, ext: 'json', url, size: 0 });
    } else {
      const buf = entries.get(it.source.path);
      const ext = it.type === 'bgm' ? (it.info.kind || extOf(it.source.path)) : (it.info.type === 'jpeg' ? 'jpg' : it.info.type);
      const destName = `${it.id}.${ext}`;
      fs.writeFileSync(path.join(tempDir, destName), buf);
      url = relUrl(pack.id, destName);
      const kind = it.type === 'bgm' ? 'bgm' : it.type;
      assetList.push({
        kind,
        name: it.name,
        ext,
        url,
        size: buf.length,
        width: it.info.width || null,
        height: it.info.height || null,
      });
    }
    const asset = it.type === 'byoyomi'
      ? { kind: 'audiopack', value: url }
      : { kind: it.type === 'bgm' ? 'audio' : 'image', value: url };
    catalogItems.push({
      id: it.id,
      type: it.type,
      name: it.name,
      desc: it.desc,
      rarity: it.rarity,
      price: it.price,
      limited: it.limited,
      role: it.role,
      unlock: it.unlock,
      asset,
    });
  }

  let coverUrl = null;
  if (pack.coverPath) {
    const ext = pack.coverInfo.type === 'jpeg' ? 'jpg' : pack.coverInfo.type;
    const destName = `cover.${ext}`;
    fs.writeFileSync(path.join(tempDir, destName), entries.get(pack.coverPath));
    coverUrl = relUrl(pack.id, destName);
  }
  if (entries.get('LICENSE.txt')) {
    fs.writeFileSync(path.join(tempDir, 'LICENSE.txt'), entries.get('LICENSE.txt'));
  }

  return { assetList, catalogItems, coverUrl };
}

function restoreDir(target, backup) {
  safeRemoveDir(target);
  if (backup && fs.existsSync(backup)) {
    try { fs.renameSync(backup, target); } catch (_) { /* 尽力恢复 */ }
  }
}

/**
 * 安装已校验的包为草稿（或指定状态）。
 * @param {object} parsed validatePack 的结果
 * @param {{status?:string, rightsConfirmed?:boolean, actor?:object, kind?:string}} [opts]
 */
async function installParsed(parsed, opts) {
  const options = opts || {};
  if (!options.rightsConfirmed) {
    return fail('请先确认素材版权/授权（rightsConfirmed）', 'RIGHTS_REQUIRED');
  }
  const pack = parsed.pack;
  const status = options.status === 'published' ? 'published' : 'draft';
  fs.mkdirSync(PACK_ROOT, { recursive: true });
  const target = path.join(PACK_ROOT, pack.id);
  const tempDir = path.join(PACK_ROOT, `.tmp-${pack.id}-${crypto.randomBytes(6).toString('hex')}`);

  // 先检查 id 冲突：同名商品若属于别的包/手工录入，直接拒绝
  const existing = catalog.getCatalog();
  const conflicts = parsed.items.filter((it) => {
    const cur = existing.find((x) => x.id === it.id);
    return cur && cur.packId !== pack.id;
  });
  if (conflicts.length) {
    return fail(
      `商品 id 与现有商品冲突：${conflicts.map((c) => c.id).join('、')}。请修改 manifest 内的 id 后重试`,
      'ID_CONFLICT',
    );
  }

  const prevEntry = loadRegistry().packs[pack.id] || null;
  const prevItems = catalog.packItems(pack.id);
  const prevAssets = assets.listAssets().filter((a) => a.packId === pack.id);
  const backup = target + `.bak-${crypto.randomBytes(4).toString('hex')}`;

  let movedOld = false;
  try {
    const built = materialize(parsed, tempDir);
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedOld = true;
    }
    fs.renameSync(tempDir, target);

    const meta = {
      source: 'pack',
      packName: pack.name,
      author: pack.author,
      license: pack.license,
      cover: built.coverUrl || '',
    };
    // 1) 商品目录（草稿）
    const catRes = catalog.replacePackItems(pack.id, built.catalogItems, {
      status, version: pack.versionName, meta,
    });
    if (!catRes.ok) throw new Error(catRes.error);
    // 2) 素材登记
    const assetRes = assets.replacePackAssets(pack.id, built.assetList);
    if (!assetRes.ok) throw new Error(assetRes.error);
    // 3) 包登记
    const reg = loadRegistry();
    const now = Date.now();
    reg.packs[pack.id] = {
      id: pack.id,
      kind: options.kind || 'pack',
      name: pack.name,
      versionName: pack.versionName,
      author: pack.author,
      license: pack.license,
      description: pack.description,
      cover: built.coverUrl,
      status,
      itemIds: built.catalogItems.map((it) => it.id),
      itemCount: built.catalogItems.length,
      installedAt: (prevEntry && prevEntry.installedAt) || now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null,
      warnings: parsed.warnings.slice(0, 20),
      installedBy: options.actor && options.actor.adminId ? options.actor.adminId : null,
    };
    if (!persistRegistry(reg)) throw new Error('扩展包登记写入失败');

    if (movedOld) safeRemoveDir(backup);
    return {
      ok: true,
      pack: decoratePack(reg.packs[pack.id]),
      items: catRes.items,
      warnings: parsed.warnings,
    };
  } catch (err) {
    // 回滚：目录 → 素材 → 商品 → 包登记
    safeRemoveDir(tempDir);
    restoreDir(target, movedOld ? backup : null);
    if (prevItems.length) {
      catalog.replacePackItems(pack.id, prevItems, {
        status: prevEntry && prevEntry.status === 'published' ? 'published' : 'draft',
        version: prevEntry && prevEntry.versionName,
        meta: prevEntry ? {
          source: prevEntry.kind === 'byoyomi' ? 'byoyomi' : 'pack',
          packName: prevEntry.name,
          author: prevEntry.author,
          license: prevEntry.license,
          cover: prevEntry.cover,
        } : undefined,
      });
    } else {
      catalog.removePackItems(pack.id);
    }
    if (prevAssets.length) assets.replacePackAssets(pack.id, prevAssets);
    else assets.removePackAssets(pack.id);
    const reg2 = loadRegistry();
    if (prevEntry) reg2.packs[pack.id] = prevEntry;
    else delete reg2.packs[pack.id];
    persistRegistry(reg2);
    return fail('安装失败，已回滚：' + (err && err.message ? err.message : '未知错误'), 'INSTALL_FAILED');
  }
}

// ==================================================================
// 分步上传（校验 → 安装）
// ==================================================================

function ensureTmp() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
}

/** 清理超过 30 分钟的上传暂存（服务重启后也不会无限堆积） */
function sweepTmp() {
  ensureTmp();
  const now = Date.now();
  let names = [];
  try { names = fs.readdirSync(TMP_ROOT); } catch (_) { return; }
  for (const n of names) {
    const p = path.join(TMP_ROOT, n);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > TMP_TTL_MS) fs.rmSync(p, { force: true });
    } catch (_) { /* ignore */ }
  }
}

async function validateAndStage(buf, opts) {
  sweepTmp();
  const parsed = await validatePack(buf, opts);
  if (!parsed.ok) return parsed;
  ensureTmp();
  const token = crypto.randomBytes(16).toString('hex');
  const file = path.join(TMP_ROOT, `${token}.tdpack`);
  try {
    fs.writeFileSync(file, buf);
  } catch (_) {
    return fail('暂存上传文件失败，请重试', 'PERSIST_FAILED');
  }
  return { ok: true, token, report: reportOf(parsed), warnings: parsed.warnings };
}

function readStaged(token) {
  const key = String(token || '').trim();
  if (!/^[a-f0-9]{32}$/.test(key)) return fail('上传令牌不合法', 'BAD_TOKEN');
  const file = path.join(TMP_ROOT, `${key}.tdpack`);
  try {
    const buf = fs.readFileSync(file);
    return { ok: true, buf, file };
  } catch (_) {
    return fail('上传已过期，请重新选择扩展包', 'TOKEN_EXPIRED');
  }
}

function dropStaged(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
}

/** 安装已暂存的上传（会再次完整校验，防止暂存后被替换） */
async function installStaged(token, opts) {
  const staged = readStaged(token);
  if (!staged.ok) return staged;
  try {
    const parsed = await validatePack(staged.buf);
    if (!parsed.ok) return parsed;
    return await installParsed(parsed, opts);
  } finally {
    dropStaged(staged.file);
  }
}

// ==================================================================
// 单独导入读秒 ZIP（MP3 一到十等）
// ==================================================================

/** 读秒 ZIP：允许根目录音频、byoyomi/ 目录、LICENSE.txt；自动生成 manifest */
async function validateByoyomiZip(buf, opts) {
  const zip = await readZip(buf, {
    allow: (name) => /^LICENSE\.txt$/i.test(name)
      || /^byoyomi\/[^/]+$/i.test(name)
      || /^[^/]+\.(mp3|ogg|wav)$/i.test(name),
  });
  if (!zip.ok) return zip;
  const entries = zip.entries;
  const names = [...entries.keys()].filter((n) => byoyomi.AUDIO_EXT.test(n));
  if (!names.length) return fail('ZIP 内没有可识别的音频文件（mp3 / ogg / wav）', 'NO_AUDIO');
  const { mapped, unknown, duplicates } = byoyomi.mapCueFiles(names);
  const warnings = [];
  if (unknown.length) warnings.push(`有 ${unknown.length} 个文件未识别，已忽略：${unknown.slice(0, 6).join('、')}`);
  if (duplicates.length) warnings.push(`有重复条目，已保留规范名：${duplicates.map((d) => d.dropped).join('、')}`);
  const full = { ...mapped };
  const built = byoyomi.buildManifest(full, { lenient: true });
  if (!built.ok) return fail(built.error, built.code, { missing: built.missing });
  warnings.push(...built.warnings);

  let container = null;
  for (const key of byoyomi.CUE_KEYS) {
    const p = full[key];
    if (!p) continue;
    const cue = await audio.validateByoyomiCue(entries.get(p), key);
    if (!cue.ok) return fail(cue.error, cue.code);
    if (!container) container = cue.info.kind;
    else if (container !== cue.info.kind) warnings.push(`混用了多种容器（${container} / ${cue.info.kind}），建议统一 MP3`);
    warnings.push(...(cue.warnings || []));
  }
  const sourceFiles = {};
  for (const [k, p] of Object.entries(built.manifest.files)) sourceFiles[k] = p;
  const name = String((opts && opts.name) || '').trim().slice(0, 40) || '读秒语音包';
  const price = opts && opts.price !== undefined && opts.price !== null && opts.price !== ''
    ? Number(opts.price) : null;
  if (price !== null && (!Number.isFinite(price) || price < 0)) return fail('价格不合法', 'BAD_PRICE');
  const token = crypto.randomBytes(4).toString('hex');
  const packId = String((opts && opts.packId) || `byoyomi-${token}`).toLowerCase();
  if (!PACK_ID_RE.test(packId)) return fail('扩展包 id 不合法', 'BAD_PACK_ID');
  const itemId = `${packId}-voice`.slice(0, 64);
  const parsed = {
    ok: true,
    pack: {
      id: packId,
      name,
      versionName: '1.0.0',
      author: String((opts && opts.author) || '').trim().slice(0, 60),
      license: String((opts && opts.license) || '').trim().slice(0, 80) || '管理员上传（未填写许可证）',
      description: '读秒语音包（管理后台上传）',
      coverPath: '',
      coverInfo: null,
    },
    items: [{
      id: itemId, type: 'byoyomi', name, desc: '读秒语音包',
      rarity: 'N', price, limited: false, role: undefined,
      source: { kind: 'cues', dir: null, files: sourceFiles },
      info: { cues: byoyomi.CUE_KEYS.filter((k) => full[k]).length },
      summary: `读秒语音包 · ${byoyomi.CUE_KEYS.filter((k) => full[k]).length}/13 条`,
      warnings: [],
    }],
    warnings,
    entries,
    totalBytes: zip.totalBytes,
  };
  return parsed;
}

async function installByoyomiZip(buf, opts) {
  if (!opts || !opts.rightsConfirmed) return fail('请先确认素材版权/授权（rightsConfirmed）', 'RIGHTS_REQUIRED');
  const parsed = await validateByoyomiZip(buf, opts);
  if (!parsed.ok) return parsed;
  return installParsed(parsed, { ...opts, kind: 'byoyomi' });
}

// ==================================================================
// 上架 / 下架 / 删除
// ==================================================================

function publish(packId) {
  const entry = loadRegistry().packs[packId];
  if (!entry) return fail('扩展包不存在', 'NO_PACK');
  const r = catalog.setPackStatus(packId, 'published');
  if (!r.ok) return r;
  const reg = loadRegistry();
  reg.packs[packId].status = 'published';
  reg.packs[packId].publishedAt = Date.now();
  reg.packs[packId].updatedAt = Date.now();
  if (!persistRegistry(reg)) {
    catalog.setPackStatus(packId, 'draft');
    return fail('发布失败（扩展包登记写入失败），已恢复为草稿', 'PERSIST_FAILED');
  }
  return { ok: true, pack: decoratePack(reg.packs[packId]) };
}

function unpublish(packId) {
  const entry = loadRegistry().packs[packId];
  if (!entry) return fail('扩展包不存在', 'NO_PACK');
  const r = catalog.setPackStatus(packId, 'draft');
  if (!r.ok) return r;
  const reg = loadRegistry();
  reg.packs[packId].status = 'draft';
  reg.packs[packId].updatedAt = Date.now();
  if (!persistRegistry(reg)) {
    catalog.setPackStatus(packId, 'published');
    return fail('下架失败（扩展包登记写入失败），已恢复为已发布', 'PERSIST_FAILED');
  }
  return { ok: true, pack: decoratePack(reg.packs[packId]), count: r.count };
}

function remove(packId) {
  const id = String(packId || '').trim();
  const reg = loadRegistry();
  const entry = reg.packs[id];
  if (!entry) return fail('扩展包不存在', 'NO_PACK');

  // 包内素材可能被「系统 BGM 三轨」或手工商品引用；直接删会让那些配置指向 404。
  const urls = new Set(assets.listAssets().filter((a) => a.packId === id).map((a) => a.url));
  const roleRefs = Object.entries(bgmRoles.getRoles())
    .filter(([, url]) => url && urls.has(url)).map(([phase]) => `bgm-role:${phase}`);
  const itemRefs = catalog.getCatalog()
    .filter((it) => it.packId !== id && it.asset && urls.has(it.asset.value))
    .map((it) => it.id);
  const refs = [...roleRefs, ...itemRefs];
  if (refs.length) {
    return fail(`包内素材仍被引用（${refs.join('、')}），请先修改系统 BGM 三轨或相关商品`, 'ASSET_IN_USE', { refs });
  }

  const prevItems = catalog.packItems(id);
  const catRes = catalog.removePackItems(id);
  if (!catRes.ok) return catRes;
  delete reg.packs[id];
  if (!persistRegistry(reg)) {
    // 目录已删但包登记没删掉 → 恢复目录，避免「包还在、商品全空」
    if (prevItems.length) {
      catalog.replacePackItems(id, prevItems, {
        status: entry.status === 'published' ? 'published' : 'draft',
        version: entry.versionName,
        meta: {
          source: entry.kind === 'byoyomi' ? 'byoyomi' : 'pack',
          packName: entry.name,
          author: entry.author,
          license: entry.license,
          cover: entry.cover,
        },
      });
    }
    return fail('扩展包删除失败（登记写入失败），已恢复商品目录', 'PERSIST_FAILED');
  }
  assets.removePackAssets(id);
  safeRemoveDir(path.join(PACK_ROOT, id));
  return { ok: true, removed: catRes.removed, packId: id };
}

/** 启动时清理未完成的临时目录（.tmp-* / .bak-* 仅在安装过程中存在） */
function sweepPackRoot() {
  let names = [];
  try { names = fs.readdirSync(PACK_ROOT); } catch (_) { return; }
  for (const n of names) {
    if (!/^\.(tmp|bak)-/.test(n)) continue;
    const p = path.join(PACK_ROOT, n);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) safeRemoveDir(p);
    } catch (_) { /* ignore */ }
  }
}

module.exports = {
  PACK_ROOT,
  PACKS_FILE,
  MAX_ITEMS,
  parseManifest,
  validatePack,
  reportOf,
  validateAndStage,
  installStaged,
  installParsed,
  installByoyomiZip,
  validateByoyomiZip,
  templateZip,
  listPacks,
  getPack,
  publish,
  unpublish,
  remove,
  sweepPackRoot,
};
