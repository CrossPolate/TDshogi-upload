/**
 * accounts.js — 账号系统（用户名 + 密码 + scrypt 哈希）
 *
 * 数据落盘 data/accounts.json：
 *   { [accountId]: { id, username, passHash, salt, createdAt, updatedAt } }
 *
 * 设计要点：
 *  - 密码使用 Node 内置 crypto.scrypt 加盐哈希，不存明文；零新增依赖。
 *  - 游客升级：注册时可选传 guestId，账号建立后把游客的
 *    对局/评级/会话数据迁移到 accountId，保证数据不丢失。
 *  - 登录成功后返回不透明会话令牌（HMAC 签名，带过期时间），
 *    前端存 localStorage，后续请求带 ?guest=<token> 即可识别为账号。
 *
 * 注册流程（REST）：POST /api/register {username, password, guestId?}
 * 登录流程（REST）：POST /api/login {username, password}
 */
'use strict';

const crypto = require('crypto');
const { readJson, writeJson } = require('./storage');
const auth = require('./auth');
const log = require('./logger');

const ACCOUNTS_FILE = 'accounts.json';
const SESSION_SECRET = process.env.SESSION_SECRET || 'tdshogi_session_secret_change_me';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const MAX_USERNAME = 16;
const MIN_PASSWORD = 4;

let cache = null;
function getCache() {
  if (!cache) cache = readJson(ACCOUNTS_FILE, {}) || {};
  return cache;
}
function persist() {
  writeJson(ACCOUNTS_FILE, getCache());
}

/**
 * 密码哈希：scrypt + 随机盐（每用户独立盐）。
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

/**
 * 注册新账号。
 * @param {string} username
 * @param {string} password
 * @param {string|null} guestId 游客 id（升级用，可选）
 * @returns {{ok:true, account:object}|{ok:false, error:string}}
 */
const USERNAME_RE = new RegExp(`^[\\w\\u4e00-\\u9fa5-]{2,${MAX_USERNAME}}$`);
function register(username, password, guestId = null) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!USERNAME_RE.test(name)) {
    return { ok: false, error: `用户名需为 2-${MAX_USERNAME} 个字符（中文/字母/数字/下划线/横线）` };
  }
  if (pass.length < MIN_PASSWORD) {
    return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
  }
  const accounts = getCache();
  if (Object.values(accounts).some((a) => a.username === name)) {
    return { ok: false, error: '用户名已被占用' };
  }
  const id = auth.genId();
  const { salt, hash } = hashPassword(pass);
  const account = {
    id,
    username: name,
    salt,
    passHash: hash,
    guestId: guestId || null, // 升级来源游客 id（迁移后仍保留用于追溯）
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  accounts[id] = account;
  persist();
  // 游客数据迁移（对局/评级/会话 → accountId）
  if (guestId) migrateGuestData(guestId, id);
  // 写会话（名字=用户名，供 WS/REST 显示）
  auth.upsertSession(id, name);
  return { ok: true, account: publicInfo(account) };
}

/**
 * 登录：校验用户名 + 密码，成功返回账号 + 会话令牌。
 */
function login(username, password) {
  const name = String(username || '').trim();
  const accounts = getCache();
  const account = Object.values(accounts).find((a) => a.username === name);
  if (!account) return { ok: false, error: '用户名或密码错误' };
  if (!verifyPassword(String(password || ''), account.salt, account.passHash)) {
    return { ok: false, error: '用户名或密码错误' };
  }
  // 刷新会话（名字=用户名）
  auth.upsertSession(account.id, account.username);
  return { ok: true, token: issueToken(account.id), account: publicInfo(account) };
}

/**
 * 签发会话令牌：payload=账号 id，HMAC-SHA256 签名，带过期时间。
 */
function issueToken(accountId) {
  const payload = `${accountId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * 校验会话令牌，返回账号 id（有效）或 null。
 */
function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [accountId, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${accountId}.${ts}`).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  if (Date.now() - Number(ts) > SESSION_TTL_MS) return null;
  const acct = getCache()[accountId];
  if (!acct) return null;
  // §K3：管理员重置密码后使旧令牌全部失效（签发时间早于重置时刻的令牌不再有效）
  if (acct.tokenInvalidBefore && Number(ts) < acct.tokenInvalidBefore) return null;
  return accountId;
}

/**
 * 账号公开信息（不含密码字段）。
 */
function publicInfo(account) {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.createdAt,
  };
}

function getAccount(accountId) {
  const a = getCache()[accountId];
  return a ? publicInfo(a) : null;
}

function listAccounts() {
  return Object.values(getCache()).map(publicInfo);
}

/**
 * 账号**原始**记录（含 `guestId` 等非公开字段），仅供服务端内部逻辑使用。
 *
 * 为什么单独开一个而不是改 `listAccounts()`：后者走 `publicInfo()`，会剔除隐私字段——
 * 而 §U5 的游客清理**必须**知道"这个游客后来注册了没有"，依据正是 `account.guestId`
 * （`register()` 里注释写明"迁移后仍保留用于追溯"）。
 * ⚠️ 返回值**绝不可**直接下发到客户端。
 */
function listAccountsRaw() {
  return Object.values(getCache());
}

// ---------------- 个人资料（PLAN §F）----------------

// 棋风预设（公开字段）
const STYLE_OPTIONS = ['不设定', '居飞车·急战', '居飞车·持久战', '振飞车', '力战型', '奇袭型', '接受型'];

/**
 * 本人视角资料（含手机号私密字段）。
 * 手机号只在两处返回：本人（携有效令牌调 getOwnProfile/updateProfile）与管理员
 * （adminUserData），其余公开接口一律剔除。
 */
function getOwnProfile(accountId) {
  const a = getCache()[accountId];
  if (!a) return null;
  return {
    id: a.id,
    username: a.username,
    createdAt: a.createdAt,
    profile: {
      phone: (a.profile && a.profile.phone) || '',
      style: (a.profile && a.profile.style) || '不设定',
    },
  };
}

/**
 * 更新资料。phone 未传不动；传空串=清除。style 未传不动。
 */
function updateProfile(accountId, { phone, style } = {}) {
  const a = getCache()[accountId];
  if (!a) return { ok: false, error: '账号不存在' };
  if (phone !== undefined) {
    const p = String(phone || '').trim();
    if (p && !/^1\d{10}$/.test(p)) return { ok: false, error: '手机号格式不正确（11 位数字）' };
    a.profile = { ...(a.profile || {}), phone: p };
  }
  if (style !== undefined) {
    if (!STYLE_OPTIONS.includes(style)) return { ok: false, error: '棋风选项无效' };
    a.profile = { ...(a.profile || {}), style };
  }
  a.updatedAt = Date.now();
  persist();
  return { ok: true, profile: { phone: a.profile.phone || '', style: a.profile.style || '不设定' } };
}

/**
 * 公开资料卡字段（玩家信息悬停小窗用）。绝不包含手机号。
 */
function getPublicCard(accountId) {
  const a = getCache()[accountId];
  if (!a) return null;
  return {
    isAccount: true,
    username: a.username,
    createdAt: a.createdAt,
    style: (a.profile && a.profile.style) || '不设定',
  };
}

/**
 * 游客数据迁移到账号：重写该游客的
 *  - 对局记录（records/*.json 的 playerIds / winnerId）
 *  - ELO 评级表（ratings.json 的 key）
 *  - 游客会话（sessions/<guestId>.json → 重命名为账号 id）
 */
function migrateGuestData(guestId, accountId) {
  if (!guestId || guestId === accountId) return;
  try {
    // 1. 评级表
    const ratings = readJson('ratings.json', {}) || {};
    if (ratings[guestId]) {
      ratings[accountId] = ratings[guestId];
      delete ratings[guestId];
      writeJson('ratings.json', ratings);
    }
    // 2. 对局记录（playerIds / winnerId 替换）
    //    PLAN §Q7-2：先用摘要列 playerB/playerW 的索引**只取受影响的棋谱**，再逐条读整谱改写。
    //    旧实现 dbList(100000) 会把全表整谱都解析一遍（游客升级账号时明显卡顿）。
    const storage = require('./storage');
    for (const s of storage.listSummaries({ playerId: guestId, limit: 100000 })) {
      const rec = storage.getRecordById(s.id);
      if (!rec) continue;
      let changed = false;
      if (rec.playerIds && rec.playerIds.b === guestId) { rec.playerIds.b = accountId; changed = true; }
      if (rec.playerIds && rec.playerIds.w === guestId) { rec.playerIds.w = accountId; changed = true; }
      if (rec.winnerId === guestId) { rec.winnerId = accountId; changed = true; }
      if (changed) storage.putRecord(rec);
    }
    // 3. 游客会话 → 账号会话（保留名字/创建时间）
    const s = require('./storage').getSessionById(guestId);
    if (s && !require('./storage').getSessionById(accountId)) {
      s.id = accountId;
      require('./storage').putSession(s);
    }
    // 4. 在缓存中使 rating 缓存失效（下轮自动重读）
    try { require('./ratings').refreshCache(); } catch (_) {}
  } catch (err) {
    log.error('accounts', '游客数据迁移失败', { err });
  }
}

// ---------------- 管理员账号操作（PLAN §K3，调用方须先过 admin.verify 并写审计）----------------

/**
 * 管理员更新账号资料（手机号/棋风；备注存会话，见 auth.adminSetNote）。
 * phone 传空串 = 清除；style 需在预设枚举内。
 */
function adminUpdateProfile(accountId, { phone, style } = {}) {
  const a = getCache()[accountId];
  if (!a) return { ok: false, error: '账号不存在' };
  if (phone !== undefined) {
    const p = String(phone || '').trim();
    if (p && !/^1\d{10}$/.test(p)) return { ok: false, error: '手机号格式不正确（11 位数字）' };
    a.profile = { ...(a.profile || {}), phone: p };
  }
  if (style !== undefined) {
    if (!STYLE_OPTIONS.includes(style)) return { ok: false, error: '棋风选项无效' };
    a.profile = { ...(a.profile || {}), style };
  }
  a.updatedAt = Date.now();
  persist();
  return { ok: true };
}

/**
 * 管理员重置密码：不传 newPassword 则生成随机 10 位。
 * 同时使该账号全部旧会话令牌失效（tokenInvalidBefore，PLAN §K3）。
 * @returns {{ok, password?}} 明文密码仅此一次返回（前端展示给管理员转交用户）
 */
function adminResetPassword(accountId, newPassword = '') {
  const a = getCache()[accountId];
  if (!a) return { ok: false, error: '账号不存在' };
  let pass = String(newPassword || '');
  if (!pass) pass = crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10);
  if (pass.length < MIN_PASSWORD) return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
  const { salt, hash } = hashPassword(pass);
  a.salt = salt;
  a.passHash = hash;
  a.tokenInvalidBefore = Date.now();
  a.updatedAt = Date.now();
  persist();
  return { ok: true, password: pass };
}

/**
 * 删除账号：删除账号记录 + 会话 + 评级战绩；棋谱保留但 playerIds 悬空（不可逆操作）。
 */
function deleteAccount(accountId) {
  const a = getCache()[accountId];
  if (!a) return { ok: false, error: '账号不存在' };
  const username = a.username;
  delete getCache()[accountId];
  persist();
  try { auth.adminDeleteSession(accountId); } catch (_) {}
  try { require('./ratings').removePlayer(accountId); } catch (_) {}
  return { ok: true, username };
}

module.exports = {
  register,
  login,
  verifyToken,
  issueToken,
  getAccount,
  listAccounts,
  listAccountsRaw, // §U5 游客清理用：含 guestId 等非公开字段，仅服务端内部
  publicInfo,
  getOwnProfile,
  updateProfile,
  getPublicCard,
  adminUpdateProfile,
  adminResetPassword,
  deleteAccount,
  STYLE_OPTIONS,
};
