/**
 * items/zip.js — 扩展包 ZIP 的安全解压（只读、内存解压）
 *
 * 管理员上传的 `.tdpack` 是不可信输入。这里在**解压前**做尺寸预算，在**解压后**
 * 逐条校验路径，避免以下常见事故：
 *  - 路径穿越（`../`、绝对路径、Windows 盘符）→ 写出到上传目录之外；
 *  - 符号链接（unix mode 0120000）→ 指向任意文件；
 *  - 加密条目 → 无法校验内容；
 *  - ZIP 炸弹（高压缩比 / 超大解压体积）→ 内存与磁盘被打满；
 *  - 同名条目（大小写不敏感文件系统上互相覆盖）。
 *
 * 调用方（packs.js）负责“允许哪些文件名/目录”，本模块只保证**安全地拿到内容**。
 */
'use strict';

const yauzl = require('yauzl');

const MAX_ENTRIES = 256;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RATIO = 200; // 单个条目解压/压缩比上限；只在体积较大时检查，避免误伤空文件

function bad(error, code) {
  return { ok: false, error, code: code || 'BAD_ZIP' };
}

/** 归一化并校验 ZIP 条目名；不合法返回 null */
function normalizeEntryName(raw) {
  const s = String(raw || '').replace(/\\/g, '/');
  if (!s || s.includes('\0')) return null;
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null; // 绝对路径 / 盘符
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    if (p === '.' || p === '..') return null;
    // Windows 会静默去掉结尾的空格/点 → 两条不同条目可能落到同一文件
    if (/[ .]$/.test(p)) return null;
    if (p.length > 120) return null;
  }
  if (s.length > 240) return null;
  return parts.join('/');
}

/** 流式读取单个条目；超过 cap 立刻销毁，避免把放大后的内容读进内存 */
function readEntry(zip, entry, cap) {
  return new Promise((resolve) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return resolve(bad('无法读取压缩条目：' + entry.fileName, 'BAD_ZIP'));
      const chunks = [];
      let total = 0;
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > cap) {
          try { stream.destroy(); } catch (_) { /* ignore */ }
          finish(bad('压缩条目解压后过大：' + entry.fileName, 'TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', () => finish(bad('压缩条目读取失败：' + entry.fileName, 'BAD_ZIP')));
      stream.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    });
  });
}

/**
 * 解压 ZIP。
 * @param {Buffer} buf ZIP 内容
 * @param {{allow?: (name:string)=>boolean, maxTotalBytes?:number}} [opts]
 * @returns {Promise<{ok:true, entries:Map<string,Buffer>, totalBytes:number, names:string[]}|{ok:false,error:string,code:string}>}
 */
function readZip(buf, opts) {
  const options = opts || {};
  const maxTotal = Math.min(options.maxTotalBytes || MAX_TOTAL_BYTES, MAX_TOTAL_BYTES);
  if (!Buffer.isBuffer(buf) || !buf.length) return Promise.resolve(bad('ZIP 内容为空', 'EMPTY'));
  if (buf.length > maxTotal) return Promise.resolve(bad('ZIP 文件过大（上限 64MB）', 'TOO_LARGE'));

  return new Promise((resolve) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, async (err, zip) => {
      if (err) return resolve(bad('不是有效的 ZIP 文件', 'BAD_ZIP'));
      const entries = new Map();
      const seen = new Set();
      let count = 0;
      let totalBytes = 0;
      let settled = false;

      const fail = (r) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) { /* ignore */ }
        resolve(r);
      };

      zip.on('error', () => fail(bad('ZIP 解析失败', 'BAD_ZIP')));
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        if (!entries.size) return resolve(bad('ZIP 内没有文件', 'EMPTY'));
        resolve({ ok: true, entries, totalBytes, names: [...entries.keys()] });
      });

      zip.on('entry', async (entry) => {
        if (settled) return;
        count += 1;
        if (count > MAX_ENTRIES) return fail(bad(`ZIP 条目过多（上限 ${MAX_ENTRIES}）`, 'TOO_MANY'));
        const isDirectory = /\/$/.test(entry.fileName);
        const name = normalizeEntryName(entry.fileName);
        if (!name) return fail(bad('ZIP 含不安全路径：' + String(entry.fileName).slice(0, 80), 'BAD_PATH'));
        if (entry.generalPurposeBitFlag & 0x1) return fail(bad('ZIP 含加密条目，无法校验：' + name, 'ENCRYPTED'));
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return fail(bad('ZIP 含符号链接：' + name, 'SYMLINK'));
        if (isDirectory) { zip.readEntry(); return; }
        if (options.allow && !options.allow(name)) {
          return fail(bad('ZIP 含不允许的文件：' + name, 'BAD_PATH'));
        }
        const size = Number(entry.uncompressedSize) || 0;
        if (size > MAX_FILE_BYTES) return fail(bad(`单个文件过大（上限 16MB）：${name}`, 'TOO_LARGE'));
        if (entry.compressedSize > 0 && size > 8 * 1024 * 1024
          && size / entry.compressedSize > MAX_RATIO) {
          return fail(bad('压缩比异常，疑似 ZIP 炸弹：' + name, 'ZIP_BOMB'));
        }
        totalBytes += size;
        if (totalBytes > maxTotal) return fail(bad('解压后总体积过大（上限 64MB）', 'TOO_LARGE'));
        const key = name.toLowerCase();
        if (seen.has(key)) return fail(bad('ZIP 含重复文件（大小写不敏感重名）：' + name, 'DUPLICATE'));
        seen.add(key);
        const r = await readEntry(zip, entry, Math.min(size || MAX_FILE_BYTES, MAX_FILE_BYTES));
        if (settled) return;
        if (!r.ok) return fail(r);
        entries.set(name, r.buffer);
        zip.readEntry();
      });

      zip.readEntry();
    });
  });
}

module.exports = {
  readZip,
  normalizeEntryName,
  MAX_ENTRIES,
  MAX_TOTAL_BYTES,
  MAX_FILE_BYTES,
};
