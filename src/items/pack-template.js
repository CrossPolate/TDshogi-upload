/**
 * items/pack-template.js — 生成可下载的扩展包模板（.tdpack）
 *
 * 模板是**一个可以直接上传并通过校验的完整包**：
 *   - 6 种商品各一个示例（头像 / 立绘 / 棋子 / 棋盘 / BGM / 读秒包）
 *   - 示例图片为纯色/网格占位图；BGM 为 10 秒静音，读秒为 0.6 秒提示音
 *   - README.txt 说明字段、尺寸、命名与上传流程
 *
 * 管理员下载后替换素材、改掉 id/名称/授权，再走「上传并校验 → 安装草稿 → 发布」。
 * ZIP 在内存中生成并缓存：内容只随代码更新，不需要往仓库里放二进制模板。
 */
'use strict';

const zlib = require('zlib');
const yazl = require('yazl');
const { CUE_KEYS } = require('./byoyomi');

// ---------------- PNG（纯色 + 可选网格，不依赖图形库） ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 生成 RGB PNG。
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number]} base 基色
 * @param {{cols?:number, rows?:number}} [opts] 画网格（棋子图集 8×4、棋盘 9×9）
 */
function makePng(width, height, base, opts) {
  const options = opts || {};
  const cols = options.cols || 0;
  const rows = options.rows || 0;
  const cellW = cols ? width / cols : width;
  const cellH = rows ? height / rows : height;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * (width * 3 + 1);
    raw[off] = 0; // filter: none
    const shade = 0.82 + 0.18 * (y / Math.max(1, height - 1));
    const gridY = rows > 0 && (y % cellH) < 2;
    for (let x = 0; x < width; x += 1) {
      const gridX = cols > 0 && (x % cellW) < 2;
      const grid = gridX || gridY;
      const k = grid ? 0.55 : shade;
      const p = off + 1 + x * 3;
      raw[p] = Math.round(base[0] * k);
      raw[p + 1] = Math.round(base[1] * k);
      raw[p + 2] = Math.round(base[2] * k);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- WAV（占位音频：静音 / 提示音） ----------------

/** 16-bit 单声道 WAV；freq=0 时为静音 */
function makeWav(seconds, freq, volume) {
  const sr = 44100;
  const n = Math.max(1, Math.round(seconds * sr));
  const pcm = Buffer.alloc(n * 2);
  const amp = (volume || 0) * 32767;
  const fade = Math.max(1, Math.round(sr * 0.01));
  for (let i = 0; i < n; i += 1) {
    let v = 0;
    if (freq) {
      const envIn = Math.min(1, i / fade);
      const envOut = Math.min(1, (n - i) / fade);
      v = Math.sin((2 * Math.PI * freq * i) / sr) * amp * envIn * envOut;
    }
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);   // PCM
  buf.writeUInt16LE(1, 22);   // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}

// ---------------- 模板内容 ----------------

const README = `TDShogi 扩展包模板（.tdpack）
================================

这个 ZIP 本身就是一个完整、可上传的示例包。建议流程：
  1. 在管理后台「商城 → 扩展包」点「上传并校验」，先跑一遍看报告；
  2. 替换下面目录里的素材，改掉 manifest.json 的 id / name / 作者 / 授权；
  3. 再次上传 → 勾选版权确认 → 安装为草稿 → 预览 → 发布。

文件结构
--------
manifest.json        包清单（必须，根目录）
cover.png            商城卡片封面（可选，640×360 左右）
LICENSE.txt          授权说明（可选，但与 manifest.license 至少一项）
README.txt           本说明（不会作为商品素材）
avatars/             头像：必须 256×256
sprites/             立绘：64–2048
pieces/              棋子图集：必须 2:1（8 列 × 4 行，推荐 512×256）
boards/              棋盘：建议 ≥512
bgm/                 BGM：1 秒–30 分钟
byoyomi/             读秒语音：13 条

manifest 字段
-------------
format       固定 "tdshogi-pack"
formatVersion 固定 1
id           包 id：小写字母/数字/-/_，2–41 位；同一 id 重新上传 = 升级替换
name         包名
versionName  版本号（仅展示与审计）
author       作者
license      许可证（如 CC-BY-4.0）
description  简介
cover        封面路径（可选）
items[]      商品列表：
  id         商品 id（全局唯一；省略时默认 <包id>-<类型>[-<场景>]）
  type       avatar | sprite | pieces | board | bgm | byoyomi
  name/desc  展示名与描述
  rarity     N | R | SR
  price      null=免费；数字=金币价
  role       BGM 必填：menu / game / endgame
  file       图片/音频路径（byoyomi 用 dir 或 files）
  limited    true = 限定（不进商城，只能发放/兑换）
  unlock     { "type":"level"|"games", "value":3 }（可选门槛）

读秒语音包命名（13 条）
-----------------------
remain_60 / remain_30 / remain_20    节点报时
count_10 … count_01                  十秒倒数
也可以直接放 60/30/20.mp3 与 1…10.mp3（或中文「一…十」），系统会自动映射。
建议 MP3：96kbps、单声道、44.1kHz，单条 0.4–1.8 秒、≤2MB。

注意
----
- 模板里的图片是纯色/网格占位图，BGM 是 10 秒静音，读秒是同一声提示音；
  正式发布前请全部替换成自己的素材。
- 商品 id 不能与现有商品冲突（扩展包自己的旧版本除外）。
- 包内素材必须拥有版权或合法授权。
`;

const LICENSE = `示例授权说明（请替换）
Copyright (c) 2026 你的名字

本扩展包模板仅用于演示 .tdpack 格式。正式发布前请填写你实际使用的许可证，
例如 CC-BY-4.0、CC0-1.0 或自有版权声明。
`;

function manifest() {
  return {
    format: 'tdshogi-pack',
    formatVersion: 1,
    id: 'template-pack',
    name: '示例扩展包（请替换素材）',
    versionName: '1.0.0',
    author: '你的名字',
    license: 'CC-BY-4.0',
    description: 'TDShogi 扩展包模板：替换素材、修改 id/名称后上传。',
    cover: 'cover.png',
    items: [
      {
        id: 'template-avatar', type: 'avatar', name: '示例头像', desc: '替换 avatars/avatar.png',
        rarity: 'N', price: null, file: 'avatars/avatar.png',
      },
      {
        id: 'template-sprite', type: 'sprite', name: '示例立绘', desc: '替换 sprites/sprite.png',
        rarity: 'R', price: 100, file: 'sprites/sprite.png',
      },
      {
        id: 'template-pieces', type: 'pieces', name: '示例棋子', desc: '替换 pieces/atlas.png',
        rarity: 'R', price: 100, file: 'pieces/atlas.png',
      },
      {
        id: 'template-board', type: 'board', name: '示例棋盘', desc: '替换 boards/board.png',
        rarity: 'SR', price: 150, file: 'boards/board.png',
      },
      {
        id: 'template-bgm', type: 'bgm', role: 'menu', name: '示例菜单曲', desc: '替换 bgm/menu.wav',
        rarity: 'R', price: 80, file: 'bgm/menu.wav',
      },
      {
        id: 'template-byoyomi', type: 'byoyomi', name: '示例读秒', desc: '替换 byoyomi/ 下的 13 条音频',
        rarity: 'R', price: 60, dir: 'byoyomi',
      },
    ],
  };
}

function buildFiles() {
  const files = {
    'manifest.json': JSON.stringify(manifest(), null, 2),
    'README.txt': README,
    'LICENSE.txt': LICENSE,
    'cover.png': makePng(640, 360, [196, 150, 96]),
    'avatars/avatar.png': makePng(256, 256, [214, 170, 196]),
    'sprites/sprite.png': makePng(420, 640, [150, 176, 206]),
    'pieces/atlas.png': makePng(512, 256, [214, 184, 138], { cols: 8, rows: 4 }),
    'boards/board.png': makePng(640, 640, [176, 128, 74], { cols: 9, rows: 9 }),
    'bgm/menu.wav': makeWav(10, 0, 0),
  };
  const cue = makeWav(0.6, 660, 0.18);
  for (const key of CUE_KEYS) files[`byoyomi/${key}.wav`] = cue;
  return files;
}

function buildZip(files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of Object.entries(files)) {
      zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), name);
    }
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

let cached = null;

/** 生成（并缓存）模板 ZIP；返回 Buffer */
function templateZip() {
  if (!cached) cached = buildZip(buildFiles());
  return cached;
}

module.exports = { templateZip, buildFiles, makePng, makeWav };
