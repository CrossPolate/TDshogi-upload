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

const { randomBytes, timingSafeEqual } = require('crypto');
const { readJson, writeJson, listJsonByPrefix, deleteJson } = require('./storage');
const log = require('./logger');

const DEFAULT_NAMES = [
  '无名棋士', '一歩名人', '飛車使い', '銀将', '桂馬',
  '香車', '角行', '竜王', '棋聖', '玉将',
];

function genId() {
  return randomBytes(12).toString('hex');
}

/** §5.5：会话写盘节流——`identify()` 每次连接都会调用，全量写盘在高并发下是无谓的 I/O 放大。 */
const IDENTIFY_PERSIST_THROTTLE_MS = 60 * 1000;
const _lastPersist = new Map(); // id -> 上次落盘时间(ms)
/**
 * `_lastPersist` 的容量上限：该 Map 只写不删，会随历史会话 id 无界增长（长期运行的内存泄漏）。
 * 超过阈值时做一次**惰性裁剪**：先清掉早已超出节流窗口的条目（删了不影响写盘判定），
 * 仍超限则按插入序（Map 保持插入顺序）删除最旧条目。
 */
const IDENTIFY_PERSIST_CAP = 5000;

function _pruneLastPersist(now) {
  if (_lastPersist.size <= IDENTIFY_PERSIST_CAP) return;
  for (const [k, t] of _lastPersist) {
    if (now - t > IDENTIFY_PERSIST_THROTTLE_MS) _lastPersist.delete(k);
  }
  while (_lastPersist.size > IDENTIFY_PERSIST_CAP) {
    _lastPersist.delete(_lastPersist.keys().next().value);
  }
}

/**
 * 生成游客"持有证明"密钥：64 位小写 hex（32 字节随机）。
 *
 * 背景（B1）：会话 id（guestId / 账号 id）是**公开数据**——大厅对局列表、个人页、
 * 管理接口都能看到。若"谁能报出 id 谁就是这个身份"，则任何人拿到 id 即可
 * **改名 / 换头像 / 顶替身份**。持有证明让客户端在首次连接时携带一个**不下发的随机 key**，
 * 服务端把它作为会话 `secret` 绑定的凭据（TOFU，首次即信任），之后改名/改头像必须带对 key。
 * ⚠️ `secret` 绝不下发：已在 `privacy.js` 的隐私键黑名单中。
 */
function genKey() {
  return randomBytes(32).toString('hex');
}

/**
 * 校验持有证明。
 * @param {string} id 会话 id
 * @param {string} key 客户端携带的 key
 * @returns {{ok:boolean, bound:boolean}} bound=false 表示该会话尚未绑定 secret（兼容期：放行）
 */
function verifyKey(id, key) {
  const session = id ? getSessionRaw(id) : null;
  // ⚠️ P1-2（2026-10-10）：会话**不存在**时绝不可当作「持有」——否则会话被 30 天清理后，
  // 任何人凭公开 guestId 即可无凭据迁移其评级/棋谱（见 accounts.migrateGuestData + register）。
  // 与「会话存在但未绑 secret」区分：后者按产品契约兼容放行，前者一律拒绝。
  if (!session) return { ok: false, bound: false };
  // 账号会话的凭据是**会话令牌**（连接握手已验过），不走游客持有证明（B1）。
  // 注册升级时旧游客 secret 若被带进账号会话，会在改名/换头像时报 AUTH_KEY——
  // 这里按设计「账号放行」，并由 register/login/migrate 负责清掉 secret。
  if (!session.secret || session.isAccount) return { ok: true, bound: false };
  const provided = String(key || '');
  // 先做格式白名单（64 位小写 hex ⇒ 字符数恒等于字节数），再常量时间比较，并兜住异常
  if (!/^[0-9a-f]{64}$/.test(provided) || provided.length !== session.secret.length) {
    return { ok: false, bound: true };
  }
  let same = false;
  try {
    same = timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(session.secret, 'hex'));
  } catch (_) {
    return { ok: false, bound: true };
  }
  return { ok: same, bound: true };
}

/**
 * 预设头像白名单（2026-09-20 用户要求）。
 *
 * ⚠️ 存的是**字形本身**而不是 id：这样就**没有第二张"id → 字形"映射表**，
 * 前后端只剩这一份白名单——服务端按它校验、前端直接渲染。
 * （若存 id，前端就得抄一份同样的表，新增头像时必然出现"服务端认、前端画不出"。）
 *
 * 只存会话文件、不上传任何文件：游客也能用（平台默认就是游客开下，
 * 头像不该反过来要求注册）。
 */
const AVATARS = [
  '🐯', '🐰', '🦊', '🐼', '🐨', '🐸', '🐵', '🦁',
  '🐮', '🐷', '🐙', '🦉', '🐧', '🐢', '🐲', '🦅',
];

/** 未选过头像时按 id **稳定**派生一个：同一玩家每次进来看见的一样，而不是每次随机闪 */
function deriveAvatar(id) {
  const tail = parseInt(String(id).slice(-4), 16);
  return AVATARS[(Number.isFinite(tail) ? tail : 0) % AVATARS.length];
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

  const isNew = !session || !session.id;
  if (isNew) {
    session = {
      id,
      name: DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)],
      createdAt: Date.now(),
    };
  }
  // §5.5：写盘降频的"变更签名"——只有确有变化（或超过节流窗口）才落盘。
  const _sig = () => `${session.name}|${session.avatar || ''}|${session.secret || ''}|${JSON.stringify(session.net || null)}|${JSON.stringify(session.banned || null)}`;
  const sigBefore = _sig();

  // 名称兜底（账号用户名最长 16；游客改名接口仍限 12）
  session.name = typeof session.name === 'string' && session.name.trim()
    ? session.name.slice(0, 16)
    : '无名棋士';
  // 头像兜底：白名单外的值（老数据 / 手改）一律回落成派生值，避免前端渲染出奇怪的东西。
  // ⚠️ 2026-10-03 道具系统骨架 —— 例外：**该账号已拥有**的头像道具（`items.avatarOptionsFor`）
  // 同样是合法值，不能在这里被重置（否则用户装备道具头像后，下一次连接就被清回派生字形）。
  // 惰性 require + try/catch：`items` 未就绪时行为与旧版**完全一致**。
  if (!AVATARS.includes(session.avatar)) {
    let allowedByItems = false;
    try { allowedByItems = require('./items').avatarOptionsFor(id).includes(session.avatar); } catch (_) { /* items 未就绪 */ }
    if (!allowedByItems) session.avatar = deriveAvatar(id);
  }
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

  // 持有证明绑定（B1，TOFU）：会话尚无 secret 且客户端首次携带合法 key → 绑定之。
  // ⚠️ 只**首次**绑定：之后即使断开重连，也用会话里已存的 secret 校验，避免被后续请求覆盖。
  // ⚠️ 账号会话（isAccount）的凭据是令牌，**绝不**绑定游客持有证明（2026-10-02 审查 +P2-13）。
  // ⚠️ P1-3（2026-10-10）：只在**新建会话**（isNew）时绑定——否则已存在的未绑会话会被
  // 任意人抢先绑上自己的 key（TOFU 抢绑），原主人此后改名/换头像反被锁死（报 AUTH_KEY）。
  const key = meta && meta.key;
  if (isNew && !session.isAccount && !session.secret && typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)) {
    session.secret = key;
  }

  // 持久化（每个会话独立文件，避免并发写同一文件）
  // §5.5：确有变化才写；否则 lastSeen 也只在超过节流窗口时兜底写一次，避免每次连接都写盘。
  const now = Date.now();
  const last = _lastPersist.get(id) || 0;
  if (isNew || _sig() !== sigBefore || (now - last) > IDENTIFY_PERSIST_THROTTLE_MS) {
    // ⚠️ 2026-10-04：检查 writeJson 返回值（失败返回 false 且已由 storage 记日志），
    // 这里补记会话上下文；不抛异常、不改动既有的写盘降频语义。
    if (!writeJson(relPath, session)) {
      log.error('auth', '会话写入失败', { id, relPath });
    }
    _lastPersist.set(id, now);
    _pruneLastPersist(now);
  }
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
function rename(guestId, name, key) {
  // B1：已绑定持有证明的会话必须先过校验；未绑定（老会话/账号）放行（兼容期）。
  const vr = verifyKey(guestId, key);
  if (vr.bound && !vr.ok) return { ok: false, error: '身份校验失败，请重新进入', code: 'AUTH_KEY' };
  const session = identify(guestId);
  name = String(name || '').trim();
  if (!name) return { ok: false, error: '名字不能为空' };
  if (name.length > 12) return { ok: false, error: '名字最多 12 个字符' };
  session.name = name;
  if (!writeJson(`sessions/${session.id}.json`, session)) {
    log.error('auth', '改名落盘失败', { id: session.id, name });
  }
  return { ok: true, name };
}

/**
 * 修改头像（白名单校验）。
 *
 * 与 `rename` 同款：走**会话文件**而非账号表 —— 游客也能设头像，
 * 不必为了换个头像去注册账号（平台默认就是游客开下）。
 *
 * @param {string} guestId
 * @param {string} avatar 必须是 `AVATARS` 里的字形
 * @returns {{ok: boolean, avatar?: string, error?: string}}
 */
function setAvatar(guestId, avatar, key, extraAllowed = []) {
  // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 第 4 参 extraAllowed：道具获得的头像字形白名单
  // （来自 items.avatarOptionsFor）。不传时默认 []，行为与旧版**完全一致**（向后兼容）。
  const extra = Array.isArray(extraAllowed) ? extraAllowed : [];
  // B1：同 rename，已绑定则必须带对 key。
  const vr = verifyKey(guestId, key);
  if (vr.bound && !vr.ok) return { ok: false, error: '身份校验失败，请重新进入', code: 'AUTH_KEY' };
  const session = identify(guestId);
  if (!AVATARS.includes(avatar) && !extra.includes(avatar)) return { ok: false, error: '头像不在可选范围内' };
  session.avatar = avatar;
  if (!writeJson(`sessions/${session.id}.json`, session)) {
    log.error('auth', '换头像落盘失败', { id: session.id, avatar });
  }
  return { ok: true, avatar };
}

/**
 * 统一的玩家信息对外形状（不含内部字段）。
 */
function publicInfo(session) {
  return { id: session.id, name: session.name, avatar: session.avatar || null };
}

/**
 * 创建/更新会话（账号系统用：注册/登录后写入，名字为用户名）。
 * 与 identify 不同：不校验 guest id 格式，name 不做游客改名长度限制（上限 16）。
 *
 * ⚠️ 必须**合并**已有会话，绝不能整份覆盖：`banned`（封禁）、`avatar`、`secret`
 * （持有证明）、`net`、`title` 都在会话文件上。原实现每次登录/注册都写一份裸
 * `{id,name,createdAt}`，会直接抹掉封禁（被封用户改密码登录即可解封）、
 * 抹掉头像与持有证明（B1 防顶替失效），迁移后的游客会话也被覆盖丢失。
 */
function upsertSession(id, name) {
  if (!id) return null;
  const existing = getSessionRaw(id);
  const session = Object.assign({}, existing, {
    id,
    name: String(name || '无名棋士').slice(0, 16) || '无名棋士',
    createdAt: (existing && existing.createdAt) || Date.now(),
    lastSeen: Date.now(),
  });
  writeJson(`sessions/${id}.json`, session);
  return session;
}

/**
 * 把会话标记为**账号会话**（注册/登录/游客升级后调用）。
 *
 * 账号的身份凭据是会话令牌，不是游客持有证明（B1）。若把游客的 `secret`
 * 留在账号会话上，之后改名/换头像会被 verifyKey 判失败（「身份校验失败」）——
 * 连接层对账号连接又刻意不下发 key（`player.key = null`），于是永远对不上。
 * 这里统一打上 `isAccount` 并清掉 `secret`，旧数据也会被注册/登录路径治愈。
 */
function markAccountSession(id, name) {
  const session = upsertSession(id, name);
  if (!session) return null;
  session.isAccount = true;
  if (session.secret) delete session.secret;
  writeJson(`sessions/${session.id}.json`, session);
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

/**
 * 删除会话文件（不存在也视为成功）。
 *
 * 用途：① 删账号时清理；② **游客升级账号后清理旧游客会话**（Bug3）——
 * 迁移是「移动」而非「复制」，旧游客会话若留着，同一人会在 `listSessions()` /
 * 管理端用户列表里出现**两条**（一条幽灵游客、一条账号），且旧游客身份仍能建立连接
 * （正是「注册后自己匹配到自己」这类问题的温床）。会话的唯一来源是 kv（sessions/<id>.json），
 * 所以删除也必须走这里。
 */
function removeSession(playerId) {
  if (!playerId) return { ok: false, error: '缺少会话 id' };
  deleteJson(`sessions/${String(playerId)}.json`);
  return { ok: true };
}

/** 删除会话（删账号时用；评级/棋谱由调用方处理）——语义同 removeSession */
function adminDeleteSession(playerId) {
  return removeSession(playerId);
}

module.exports = {
  identify, load, rename, publicInfo, genId, genKey, verifyKey, listSessions,
  AVATARS, setAvatar, // 头像（2026-09-20）：白名单只此一份，前端直接渲染字形
  upsertSession, markAccountSession, getSessionRaw, saveSession, removeSession, // §M4：会话的唯一来源是 kv，迁移也走这几个
  adminRename, banPlayer, unbanPlayer, adminSetTitle, adminDeleteSession,
};
