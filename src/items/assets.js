/**
 * items/assets.js — 商品素材上传与格式校验（头像 / 立绘 / BGM）
 *
 * 管理员上传的素材落在 `public/uploads/items/`，对外以 `/uploads/items/<id>.<ext>` 访问。
 * 元数据落 `data/items-assets.json`（键值存储，走 storage.readJson/writeJson）。
 *
 * 格式硬约束（2026-10-07 商品管理需求）：
 *   - 头像 avatar：图片 png/jpg/webp，**必须 256×256**
 *   - 立绘 sprite：图片 png/jpg/webp，最长边 ≤ 2048，短边 ≥ 64
 *   - BGM bgm：音频 mp3/ogg/wav，≤ 12 MB
 *
 * 解析尺寸不引第三方库：只读 PNG/JPEG/WebP 文件头（见 imageSize）。
 * 校验失败返回 `{ok:false, error, code}`，**绝不写盘**。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('../storage');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'items');
const ASSETS_FILE = 'items-assets.json';

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

const LIMITS = {
  avatar: { maxBytes: 2 * 1024 * 1024, width: 256, height: 256 },
  sprite: { maxBytes: 4 * 1024 * 1024, minSide: 64, maxSide: 2048 },
  bgm: { maxBytes: 12 * 1024 * 1024 },
};

function ensureUploadDir() {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) { /* 已存在 */ }
}

/** 读素材注册表：{ [id]: { id, kind, name, ext, url, size, width?, height?, createdAt } } */
function loadAssets() {
  const raw = readJson(ASSETS_FILE, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function persistAssets(map) {
  return writeJson(ASSETS_FILE, map);
}

/** 从文件头解析图片尺寸；识别不了返回 null */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG：8 字节签名 + IHDR（宽高在 offset 16/20，大端）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }
  // JPEG：SOI + 段扫描，取 SOFn 的高宽
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（跳过 DHT/JPG/DAC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), type: 'jpeg' };
      }
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  // WebP：RIFF....WEBP + VP8X / VP8 / VP8L
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), type: 'webp' };
    }
    if (fourcc === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    }
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, type: 'webp' };
    }
  }
  return null;
}

/** 粗判音频容器（防误传）；识别不了返回 null */
function audioKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';          // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';                    // MPEG frame
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  return null;
}

/**
 * 校验并保存一份素材。
 * @param {'avatar'|'sprite'|'bgm'} kind
 * @param {string} filename 原始名（只取扩展名作参考，最终以嗅探为准）
 * @param {Buffer} buf 文件内容
 * @returns {{ok:true, asset:object}|{ok:false, error:string, code:string}}
 */
function saveAsset(kind, filename, buf) {
  if (!LIMITS[kind]) return { ok: false, error: '素材类型不合法', code: 'BAD_KIND' };
  if (!buf || !buf.length) return { ok: false, error: '文件为空', code: 'EMPTY' };
  const lim = LIMITS[kind];
  if (buf.length > lim.maxBytes) {
    return { ok: false, error: `文件过大（上限 ${Math.round(lim.maxBytes / 1024 / 1024)} MB）`, code: 'TOO_LARGE' };
  }

  let ext = null;
  let width = null;
  let height = null;
  if (kind === 'bgm') {
    const a = audioKind(buf);
    if (!a) return { ok: false, error: '仅支持 mp3 / ogg / wav 音频', code: 'BAD_FORMAT' };
    ext = a;
  } else {
    const img = imageSize(buf);
    if (!img) return { ok: false, error: '仅支持 png / jpg / webp 图片', code: 'BAD_FORMAT' };
    ext = img.type === 'jpeg' ? 'jpg' : img.type;
    width = img.width;
    height = img.height;
    if (kind === 'avatar') {
      if (width !== lim.width || height !== lim.height) {
        return {
          ok: false,
          error: `头像必须为 ${lim.width}×${lim.height}（当前 ${width}×${height}）`,
          code: 'BAD_SIZE',
        };
      }
    } else {
      const minSide = Math.min(width, height);
      const maxSide = Math.max(width, height);
      if (minSide < lim.minSide || maxSide > lim.maxSide) {
        return {
          ok: false,
          error: `立绘尺寸需在 ${lim.minSide}–${lim.maxSide} 之间（当前 ${width}×${height}）`,
          code: 'BAD_SIZE',
        };
      }
    }
  }

  ensureUploadDir();
  const id = crypto.randomBytes(8).toString('hex');
  const rel = `${id}.${ext}`;
  const abs = path.join(UPLOAD_DIR, rel);
  try {
    fs.writeFileSync(abs, buf);
  } catch (e) {
    return { ok: false, error: '素材写入失败', code: 'PERSIST_FAILED' };
  }

  const base = String(filename || '').replace(/\.[^.]+$/, '').slice(0, 40) || kind;
  const asset = {
    id,
    kind,
    name: base,
    ext,
    url: `/uploads/items/${rel}`,
    size: buf.length,
    width,
    height,
    createdAt: Date.now(),
  };
  const map = loadAssets();
  map[id] = asset;
  if (!persistAssets(map)) {
    try { fs.unlinkSync(abs); } catch (_) { /* 尽力回滚 */ }
    return { ok: false, error: '素材注册失败', code: 'PERSIST_FAILED' };
  }
  return { ok: true, asset };
}

/** 列出已上传素材（可按 kind 过滤） */
function listAssets(kind) {
  const map = loadAssets();
  const all = Object.values(map);
  return kind ? all.filter((a) => a.kind === kind) : all;
}

function getAsset(id) {
  return loadAssets()[id] || null;
}

/** 删除素材文件 + 注册项（商品引用中时由调用方先解绑） */
function deleteAsset(id) {
  const map = loadAssets();
  const a = map[id];
  if (!a) return { ok: false, error: '素材不存在', code: 'NO_ASSET' };
  delete map[id];
  if (!persistAssets(map)) return { ok: false, error: '素材注册更新失败', code: 'PERSIST_FAILED' };
  if (a.url && a.url.startsWith('/uploads/items/')) {
    const rel = a.url.slice('/uploads/items/'.length);
    if (!rel.includes('..') && !rel.includes('/') && !rel.includes('\\')) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, rel)); } catch (_) { /* 文件可能已不在 */ }
    }
  }
  return { ok: true };
}

module.exports = {
  LIMITS,
  saveAsset,
  listAssets,
  getAsset,
  deleteAsset,
  imageSize,
  audioKind,
  UPLOAD_DIR,
};
