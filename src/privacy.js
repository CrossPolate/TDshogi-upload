/**
 * privacy.js — 隐私字段出口白名单（PLAN §M3，§K 的结构性保证）
 *
 * 背景：§F 的手机号靠「人肉记住别返回」守住，§K 又要新增 IP/UA 等隐私数据。
 * 这里把约定变成机制：凡是要发给非管理员的接口（player-card / home / lobby /
 * history / state …），出口统一过一遍 stripPrivate()，命中即剔除。
 *
 * 用法：
 *   res.json(privacy.stripPrivate(data));                     // 全剔除
 *   res.json(privacy.stripPrivate(data, { allow: ['phone'] })); // 白名单放行（本人/管理员场景）
 *   privacy.assertNoPrivate(data);                            // 测试断言，返回命中路径
 *
 * 注意：白名单是**出口级**的，别在数据源头上放行——数据源保持完整，
 * 由出口决定「谁看得到什么」，这样新增接口不会意外漏出去。
 */
'use strict';

/** 命中即视为隐私的键名（小写比较） */
const PRIVATE_KEYS = new Set([
  'phone', 'mobile', 'tel',                       // §F 手机号
  'ip', 'lastip', 'firstip', 'clientip', 'adminip', 'remoteaddress',
  'xforwardedfor', 'xff', 'xrealip',              // §K 网络信息
  'ua', 'useragent', 'lastua', 'firstua',         // §K 设备信息
  'net', 'events', 'audit',                       // §K 聚合对象与事件流
  'adminnote',                                    // 管理员内部备注
  'passhash', 'salt', 'token', 'admintoken', 'sessiontoken', 'secret',
]);

function isPrivateKey(key) {
  return PRIVATE_KEYS.has(String(key).toLowerCase());
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && (v.constructor === Object || v.constructor === undefined);
}

/**
 * 深拷贝并剔除隐私字段（不修改入参）。
 * @param {*} value
 * @param {{allow?: string[]}} opts allow 中的键名放行
 */
function stripPrivate(value, { allow = [] } = {}) {
  const allowSet = new Set(allow.map((k) => String(k).toLowerCase()));
  return walkStrip(value, allowSet);
}

function walkStrip(value, allowSet) {
  if (Array.isArray(value)) return value.map((v) => walkStrip(v, allowSet));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = k.toLowerCase();
      if (PRIVATE_KEYS.has(lk) && !allowSet.has(lk)) continue;
      out[k] = walkStrip(v, allowSet);
    }
    return out;
  }
  return value;
}

/**
 * 收集仍在的隐私字段路径（供 e2e 断言「序列化结果里搜不到」）。
 * @returns {string[]} 命中路径，空数组表示干净
 */
function assertNoPrivate(value) {
  const hits = [];
  walkCollect(value, '', hits, 0);
  return hits;
}

function walkCollect(value, path, hits, depth) {
  if (depth > 12 || value == null) return; // 防御：超深或空值直接跳过
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkCollect(v, `${path}[${i}]`, hits, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (isPrivateKey(k)) hits.push(p);
      walkCollect(v, p, hits, depth + 1);
    }
  }
}

module.exports = {
  PRIVATE_KEYS,
  isPrivateKey,
  stripPrivate,
  assertNoPrivate,
};
