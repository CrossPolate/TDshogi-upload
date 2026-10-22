/**
 * items/byoyomi.js — 读秒语音包的条目规范与 manifest 生成
 *
 * 前端（sound.js）按固定 key 取音频：
 *   remain_60 / remain_30 / remain_20（节点报时）
 *   count_10 … count_01（十秒倒数）
 * manifest 形状（v2）：
 *   { "version": 2, "format": "tdshogi-byoyomi", "cueMode": "count",
 *     "files": { "remain_60": "remain_60.mp3", … } }
 *
 * 扩展包里的读秒目录允许两种命名：
 *  1) 规范名：remain_60.mp3 / count_10.mp3 …
 *  2) 口语名：10.mp3 / 01.mp3 / 十.mp3 …（自动映射到 count_XX；60/30/20 映射到节点）
 * 扩展包要求 13 条齐全；管理后台的“单独导入读秒 ZIP”允许只给 1–10，
 * 缺失的节点音由 count_10 顶替（返回 warning，由管理员决定是否接受）。
 */
'use strict';

const CUE_KEYS = [
  'remain_60', 'remain_30', 'remain_20',
  'count_10', 'count_09', 'count_08', 'count_07', 'count_06',
  'count_05', 'count_04', 'count_03', 'count_02', 'count_01',
];

const CUE_LABELS = {
  remain_60: '剩 1 分钟',
  remain_30: '剩 30 秒',
  remain_20: '剩 20 秒',
  count_10: '十', count_09: '九', count_08: '八', count_07: '七', count_06: '六',
  count_05: '五', count_04: '四', count_03: '三', count_02: '二', count_01: '一',
};

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const AUDIO_EXT = /\.(mp3|ogg|wav)$/i;

/** 取文件名（不含路径/扩展名），小写 */
function stem(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '').trim().toLowerCase();
}

/**
 * 从文件名推断读秒条目 key。
 * @returns {string|null} CUE_KEYS 之一；无法识别返回 null
 */
function cueKeyFromName(name) {
  const s = stem(name);
  if (!s) return null;
  // 规范写法：remain_60 / remain-60 / remain 60
  const rem = /^remain[\s_-]*(60|30|20)$/.exec(s);
  if (rem) return 'remain_' + rem[1];
  // 规范写法：count_10 / count-9 / count 1
  const cnt = /^count[\s_-]*(\d{1,2})$/.exec(s);
  if (cnt) {
    const n = Number(cnt[1]);
    return n >= 1 && n <= 10 ? 'count_' + String(n).padStart(2, '0') : null;
  }
  // 纯数字：60/30/20 = 节点；1–10 = 倒数（01–09 也可以）
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n === 60 || n === 30 || n === 20) return 'remain_' + n;
    if (n >= 1 && n <= 10) return 'count_' + String(n).padStart(2, '0');
    return null;
  }
  // 中文数字：一 … 十
  if (CN_DIGITS[s]) return 'count_' + String(CN_DIGITS[s]).padStart(2, '0');
  return null;
}

/**
 * 把目录里的音频文件映射成 { key: name }。
 * 同一 key 多个文件 → 规范化名优先（例如 count_10.mp3 优于 10.mp3），
 * 其余记入 duplicates。
 * @param {string[]} names 相对路径列表
 * @returns {{mapped:Object<string,string>, unknown:string[], duplicates:Array<{key:string,kept:string,dropped:string}>}}
 */
function mapCueFiles(names) {
  const mapped = {};
  const unknown = [];
  const duplicates = [];
  const ranked = [];
  for (const name of names || []) {
    if (!AUDIO_EXT.test(name)) { unknown.push(name); continue; }
    const key = cueKeyFromName(name);
    if (!key) { unknown.push(name); continue; }
    const canonical = stem(name) === key;
    ranked.push({ key, name, canonical });
  }
  // 规范名优先；同优先级按文件名排序，保证结果稳定
  ranked.sort((a, b) => (Number(b.canonical) - Number(a.canonical)) || a.name.localeCompare(b.name));
  for (const r of ranked) {
    if (!mapped[r.key]) mapped[r.key] = r.name;
    else duplicates.push({ key: r.key, kept: mapped[r.key], dropped: r.name });
  }
  return { mapped, unknown, duplicates };
}

/**
 * 构建语音包清单。
 * @param {Object<string,string>} files key → 文件相对路径
 * @param {{lenient?:boolean}} [opts] lenient=true 时缺节点音可用 count_10 顶替
 * @returns {{ok:true, manifest:object, warnings:string[]}|{ok:false,error:string,code:string,missing:string[]}}
 */
function buildManifest(files, opts) {
  const source = files && typeof files === 'object' ? files : {};
  const out = {};
  const warnings = [];
  const missing = [];
  for (const key of CUE_KEYS) {
    if (source[key]) out[key] = source[key];
    else missing.push(key);
  }
  if (missing.length) {
    const lenient = !!(opts && opts.lenient);
    const onlyRemain = missing.every((k) => k.startsWith('remain_'));
    if (!(lenient && onlyRemain && out.count_10)) {
      return {
        ok: false,
        error: `读秒语音包缺少 ${missing.length} 条：${missing.join('、')}`,
        code: 'MISSING_CUES',
        missing,
      };
    }
    for (const k of missing) out[k] = out.count_10;
    warnings.push(`缺少节点音（${missing.join('、')}），已用 count_10 顶替`);
  }
  return {
    ok: true,
    manifest: { version: 2, format: 'tdshogi-byoyomi', cueMode: 'count', files: out },
    warnings,
  };
}

module.exports = {
  CUE_KEYS,
  CUE_LABELS,
  AUDIO_EXT,
  cueKeyFromName,
  mapCueFiles,
  buildManifest,
};
