/**
 * items/bgm-roles.js — BGM 三轨配置（菜单 / 开局 / 终盘）
 *
 * 需求（2026-10-07）：
 *   - 菜单音乐：没有对局时播放
 *   - 开局音乐：对局中循环播放
 *   - 终盘音乐：进入读秒时切换播放
 *   - 管理员可在后台调整各轨对应的曲目（文件）
 *
 * 持久化：`data/bgm-roles.json` → { menu, game, endgame }，每项是**相对 public 的 URL**
 * （如 `/music/静弈.mp3`）或 null（该轨静音）。
 *
 * 默认归类（用户授权「你直接整」，后台可改）：
 *   menu    = loop.mp3      （循环感强，适合大厅）
 *   game    = 静弈.mp3      （对局主曲，开局起循环）
 *   endgame = 制勝.mp3      （读秒高潮）
 * 另两首（深层沉浸 / 空弦）进商店作为可购买的对局 BGM。
 */
'use strict';

const { readJson, writeJson } = require('../storage');

const KEY = 'bgm-roles.json';
const PHASES = ['menu', 'game', 'endgame'];
const PHASE_LABELS = { menu: '菜单', game: '开局', endgame: '终盘' };

const DEFAULT_ROLES = {
  menu: '/music/loop.mp3',
  game: '/music/静弈.mp3',
  endgame: '/music/制勝.mp3',
};

/** URL 归一：只允许站内相对路径（以 / 开头），拒绝 .. 与协议 */
function normalizeTrack(v) {
  if (v === null || v === undefined || v === '' || v === 'off') return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!s.startsWith('/')) return null;
  if (s.includes('..') || s.includes('\\') || s.includes('\0')) return null;
  return s.slice(0, 200);
}

function load() {
  const raw = readJson(KEY, null);
  const out = { ...DEFAULT_ROLES };
  if (raw && typeof raw === 'object') {
    for (const p of PHASES) {
      if (raw[p] !== undefined) out[p] = normalizeTrack(raw[p]);
    }
  }
  return out;
}

function persist(roles) {
  return writeJson(KEY, roles);
}

/** 读取三轨配置 */
function getRoles() {
  return load();
}

/**
 * 设置三轨（部分更新亦可）。
 * @param {{menu?:string|null, game?:string|null, endgame?:string|null}} patch
 * @returns {{ok:true, roles:object}|{ok:false, error:string, code:string}}
 */
function setRoles(patch) {
  const cur = load();
  const next = { ...cur };
  for (const p of PHASES) {
    if (patch && patch[p] !== undefined) {
      const n = normalizeTrack(patch[p]);
      // normalizeTrack 对非法值返回 null；但显式传 null 也是合法（静音）。
      // 区分：传入非空字符串却归一失败 ⇒ 拒绝。
      if (patch[p] !== null && patch[p] !== '' && patch[p] !== 'off' && n === null && String(patch[p]).trim() !== '') {
        return { ok: false, error: `${PHASE_LABELS[p]}轨路径不合法`, code: 'BAD_TRACK' };
      }
      next[p] = n;
    }
  }
  if (!persist(next)) return { ok: false, error: '配置写入失败', code: 'PERSIST_FAILED' };
  return { ok: true, roles: next };
}

module.exports = { PHASES, PHASE_LABELS, DEFAULT_ROLES, getRoles, setRoles, normalizeTrack };
