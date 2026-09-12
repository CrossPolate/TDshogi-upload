/**
 * auth.js — 游客会话管理
 *
 * v1 采用"游客免注册"模式：浏览器首次访问生成 guest_id（localStorage），
 * 服务端据此维护会话（名字、创建时间、最后在线）。
 *
 * 设计上预留了真实账号体系的扩展位：
 *  - identify() 目前基于 guest_id，后续可替换为 token / 账号 id
 *  - 所有对局、评分、棋谱均以 playerId 关联，升级账号时无需改动上层逻辑
 */
'use strict';

const { randomBytes } = require('crypto');
const { readJson, writeJson, listJsonByPrefix, deleteJson } = require('./storage');

const DEFAULT_NAMES = [
  '无名棋士', '一歩名人', '飛車使い', '銀将', '桂馬',
  '香車', '角行', '竜王', '棋聖', '玉将',
];

function genId() {
  return randomBytes(12).toString('hex');
}

/**
 * 解析 / 校验游客身份，返回会话对象（不存在则创建）。
 * @param {string|null} guestId 客户端携带的游客 id
 * @param {{ip?:string|null, ua?:string|null}} meta 客户端网络信息（PLAN §K2）：
 *   - 首次出现或 IP 变化时更新会话 net 字段并写盘（否则不额外写，避免高频 I/O）
 *   - 通过 audit.loginEvent 记录登录事件（同 playerId+IP 24h 去重）
 * @returns {{id: string, name: string, createdAt: number, banned?: object}}
 */
function identify(guestId, meta = {}) {
  let id = guestId && /^[0-9a-f]{24}$/.test(guestId) ? guestId : genId();
  const relPath = `sessions/${id}.json`;
  let session;
  try {
    session = readJson(relPath, null);
  } catch (_) {
    session = null;
  }

  if (!session || !session.id) {
    session = {
      id,
      name: DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)],
      createdAt: Date.now(),
    };
  }

  // 名称兜底（账号用户名最长 16；游客改名接口仍限 12）
  session.name = typeof session.name === 'string' && session.name.trim()
    ? session.name.slice(0, 16)
    : '无名棋士';
  session.lastSeen = Date.now();

  // 封禁懒解封：有期限且已到期 → 自动解除（PLAN §K3）
  if (session.banned && session.banned.until && Date.now() > session.banned.until) {
    delete session.banned;
  }

  // 网络信息：仅首次 / IP 变化时写盘（PLAN §K2，隐私字段仅管理员可见）。
  // 登录事件（audit.loginEvent）与每日登录经验由 protocol.handleConnection 记录/发放——
  // 那里需要拿到去重结果来判定「每日首次」。
  const ip = (meta && meta.ip) || null;
  const ua = (meta && meta.ua) || null;
  if (ip || ua) {
    const net = session.net || null;
    if (!net || !net.firstIp || net.lastIp !== ip) {
      session.net = {
        firstIp: net ? (net.firstIp || ip) : ip,
        firstSeenAt: net ? (net.firstSeenAt || Date.now()) : Date.now(),
        lastIp: ip,
        lastUa: ua,
        lastSeenAt: Date.now(),
      };
    }
  }

  // 持久化（每个会话独立文件，避免并发写同一文件）
  writeJson(relPath, session);
  return session;
}

/**
 * 校验一个 guest_id 是否合法（存在则返回会话，否则 null）。
 * 用于 WS 断线重连时定位对局。
 */
function load(guestId) {
  if (!guestId || !/^[0-9a-f]{24}$/.test(guestId)) return null;
  return readJson(`sessions/${guestId}.json`, null);
}

/**
 * 修改游客名字。
 * @param {string} guestId
 * @param {string} name 新名字
 * @returns {{ok: boolean, name?: string, error?: string}}
 */
function rename(guestId, name) {
  const session = identify(guestId);
  name = String(name || '').trim();
  if (!name) return { ok: false, error: '名字不能为空' };
  if (name.length > 12) return { ok: false, error: '名字最多 12 个字符' };
  session.name = name;
  writeJson(`sessions/${session.id}.json`, session);
  return { ok: true, name };
}

/**
 * 统一的玩家信息对外形状（不含内部字段）。
 */
function publicInfo(session) {
  return { id: session.id, name: session.name };
}

/**
 * 创建/更新会话（账号系统用：注册/登录后写入，名字为用户名）。
 * 与 identify 不同：不校验 guest id 格式，name 不做游客改名长度限制（上限 16）。
 */
function upsertSession(id, name) {
  if (!id) return null;
  const session = {
    id,
    name: String(name || '无名棋士').slice(0, 16) || '无名棋士',
    createdAt: Date.now(),
  };
  writeJson(`sessions/${id}.json`, session);
  return session;
}

/**
 * 列出全部会话（管理员用）。
 * 会话由 identify/upsertSession 写在 kv（sessions/<id>.json），读取必须同源；
 * 旧实现读独立的 sessions 表（几乎无人写入）导致管理员用户列表拿不到昵称。
 * @returns {Array<{id, name, lastSeen, createdAt}>}
 */
function listSessions() {
  try {
    return listJsonByPrefix('sessions/')
      .filter((s) => s && s.id && s.name)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  } catch (_) {
    return [];
  }
}

// ---------------- 管理员会话操作（PLAN §K3，所有调用方须先过 admin.verify 并写审计）----------------

/** 读取原始会话（不存在返回 null），不触发 identify 的副作用 */
function getSessionRaw(playerId) {
  if (!playerId || !/^[0-9a-f]{24}$/.test(String(playerId))) return null;
  return readJson(`sessions/${String(playerId)}.json`, null);
}

function saveSession(session) {
  writeJson(`sessions/${session.id}.json`, session);
}

/**
 * 管理员改名（显示名，上限 16；不改账号登录用户名）。
 */
function adminRename(playerId, name) {
  const session = getSessionRaw(playerId);
  if (!session) return { ok: false, error: '用户不存在' };
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: '名字不能为空' };
  if (n.length > 16) return { ok: false, error: '名字最多 16 个字符' };
  session.name = n;
  saveSession(session);
  return { ok: true, name: n };
}

/**
 * 封禁：days > 0 为有期（天），否则永久。
 * 生效点：protocol.handleConnection 读取 session.banned 拒绝新连接；
 * 已在线连接由调用方（server 路由）经 protocol.kickPlayer 踢下线。
 */
function banPlayer(playerId, { reason = '', days = 0, by = null } = {}) {
  const session = getSessionRaw(playerId);
  if (!session) return { ok: false, error: '用户不存在' };
  if (session.banned) return { ok: false, error: '该用户已被封禁' };
  const d = Number(days);
  session.banned = {
    reason: String(reason || '').slice(0, 200),
    until: d > 0 ? Date.now() + d * 24 * 60 * 60 * 1000 : 0, // 0 = 永久
    by: by || null,
    at: Date.now(),
  };
  saveSession(session);
  return { ok: true, banned: session.banned };
}

function unbanPlayer(playerId) {
  const session = getSessionRaw(playerId);
  if (!session) return { ok: false, error: '用户不存在' };
  if (!session.banned) return { ok: false, error: '该用户未被封禁' };
  delete session.banned;
  saveSession(session);
  return { ok: true };
}

/** 用户称号（管理员编辑，展示为「名称（称号）」；存会话，游客/账号统一，PLAN §K7 追加） */
function adminSetTitle(playerId, title) {
  const session = getSessionRaw(playerId);
  if (!session) return { ok: false, error: '用户不存在' };
  const t = String(title || '').trim();
  if (t) {
    if (t.length > 12) return { ok: false, error: '称号最多 12 个字符' };
    session.title = t;
  } else {
    delete session.title;
  }
  saveSession(session);
  return { ok: true, title: t };
}

/** 删除会话（删账号时用；评级/棋谱由调用方处理） */
function adminDeleteSession(playerId) {
  deleteJson(`sessions/${String(playerId)}.json`);
  return { ok: true };
}

module.exports = { identify, load, rename, publicInfo, genId, listSessions, upsertSession, getSessionRaw, adminRename, banPlayer, unbanPlayer, adminSetTitle, adminDeleteSession };
