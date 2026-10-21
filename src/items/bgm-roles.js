/**
 * items/bgm-roles.js — BGM 三轨配置（菜单 / 开局 / 终盘）
 *
 * 需求（2026-10-07）：
 *   - 菜单音乐：没有对局时播放
 *   - 开局音乐：对局中循环播放
 *   - 终盘音乐：进入读秒时切换播放
 *   - 管理员可在后台调整各轨对应的曲目（文件）
 *
 * ⚠️ 2026-10-21 商城化：代码不再内置任何 BGM 文件，**默认三轨全静音**。
 * 管理员先在「商城管理」上传 BGM 素材，再从这里选为系统轨（游客/未装备玩家的兜底）；
 * 玩家在装扮里装备的 BGM 仍会覆盖「开局」轨。
 *
 * 持久化：`data/bgm-roles.json` → { menu, game, endgame }，每项是**相对 public 的 URL**
 * （如 `/uploads/items/xxx.mp3`）或 null（该轨静音）。读取时会校验文件是否存在：
 * 素材被删除后自动回落 null，避免反复 404。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('../storage');

const KEY = 'bgm-roles.json';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PHASES = ['menu', 'game', 'endgame'];
const PHASE_LABELS = { menu: '菜单', game: '开局', endgame: '终盘' };

/** 2026-10-21：默认全静音（不再内置 loop/静弈/制勝） */
const DEFAULT_ROLES = {
  menu: null,
  game: null,
  endgame: null,
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

/** 站内素材是否真实存在（`/uploads/items/x.mp3` → public/uploads/items/x.mp3） */
function trackExists(url) {
  if (!url) return false;
  const rel = String(url).split('?')[0].replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) return false;
  try { return fs.existsSync(abs); } catch (_) { return false; }
}

function load() {
  const raw = readJson(KEY, null);
  const out = { ...DEFAULT_ROLES };
  if (raw && typeof raw === 'object') {
    for (const p of PHASES) {
      if (raw[p] !== undefined) {
        const track = normalizeTrack(raw[p]);
        // 素材被删除 / 旧版内置曲已移除 → 该轨静音（不反复请求 404）
        out[p] = track && trackExists(track) ? track : null;
      }
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
      if (n && !trackExists(n)) {
        return { ok: false, error: `${PHASE_LABELS[p]}轨素材不存在（请先在商城上传）`, code: 'BAD_TRACK' };
      }
      next[p] = n;
    }
  }
  if (!persist(next)) return { ok: false, error: '配置写入失败', code: 'PERSIST_FAILED' };
  return { ok: true, roles: next };
}

module.exports = { PHASES, PHASE_LABELS, DEFAULT_ROLES, getRoles, setRoles, normalizeTrack };
