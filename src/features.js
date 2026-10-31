'use strict';

/**
 * features.js — 1.6–1.9 升级功能的统一开关。
 *
 * 目的：让新模块可以**先合入骨架、默认关闭**，再按版本逐项启用；
 * 关闭时旧流程完全不受影响，出问题也能单独下线。
 *
 * 约定：
 *  - 只认环境变量；默认全部关闭（false）。
 *  - 取值 `1/true/on/yes` 为开，`0/false/off/no` 为关；未设置/非法值一律关闭。
 *  - 新增功能必须同时登记到这里，禁止在业务代码里散落 `process.env.FEATURE_*`。
 */

const FLAGS = {
  analysis: { env: 'FEATURE_ANALYSIS', version: '1.6', label: '引擎复盘' },
  puzzles: { env: 'FEATURE_PUZZLES', version: '1.6', label: '每日诘将棋' },
  social: { env: 'FEATURE_SOCIAL', version: '1.7', label: '好友与挑战' },
  mail: { env: 'FEATURE_MAIL', version: '1.7', label: '邮箱与找回' },
  pwa: { env: 'FEATURE_PWA', version: '1.7', label: 'PWA 安装' },
  notifications: { env: 'FEATURE_NOTIFICATIONS', version: '1.7', label: '站内通知中心' },
  correspondence: { env: 'FEATURE_CORRESPONDENCE', version: '1.8', label: '异步对局' },
  seasons: { env: 'FEATURE_SEASONS', version: '1.8', label: '分时制评级与赛季' },
  arenas: { env: 'FEATURE_ARENAS', version: '1.8', label: 'Arena 竞技场' },
  studies: { env: 'FEATURE_STUDIES', version: '1.9', label: '研究收藏与开局统计' },
};

function parse(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  return false;
}

function isOn(name) {
  const def = FLAGS[name];
  return !!(def && parse(process.env[def.env]));
}

function all() {
  const out = {};
  for (const [name, def] of Object.entries(FLAGS)) {
    out[name] = { enabled: isOn(name), version: def.version, label: def.label, env: def.env };
  }
  return out;
}

/** 给前端的精简开关表（不含 env 细节，避免把部署配置暴露给客户端） */
function publicFlags() {
  const out = {};
  for (const name of Object.keys(FLAGS)) out[name] = isOn(name);
  return out;
}

/** 给 /api/features 的完整公开信息（开关 + 版本 + 说明，不含环境变量名） */
function publicInfo() {
  return {
    ok: true,
    flags: publicFlags(),
    features: Object.entries(FLAGS).map(([name, def]) => ({
      name,
      version: def.version,
      label: def.label,
      enabled: isOn(name),
    })),
  };
}

module.exports = { FLAGS, isOn, all, publicFlags, publicInfo };
