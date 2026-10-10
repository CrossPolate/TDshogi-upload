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

/**
 * 会话令牌签名密钥。
 *
 * ⚠️⚠️ **绝不能用源码里的固定默认值**（2026-09-21 安全审查 P0-2）：本仓库是公开的，
 * 而**账号 id 本身是公开数据**（大厅对局列表、个人页、悬停卡、管理接口都能看到），
 * 于是"公开 id + 内置默认密钥"＝可以**离线伪造**出任意账号的合法会话令牌 →
 * 完全接管账号（读私密资料、连 WS 顶替身份、检索其棋谱）。审查已实测复现。
 *
 * 规则：**环境变量优先；没有就生成随机密钥并持久化**（首启一次，零运维负担）。
 * ⚠️ 必须持久化：密钥一换，所有旧令牌立即失效（用户需重新登录），不能每次启动随机。
 */
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const saved = readJson('secret.json', null);
  if (saved && saved.key) return saved.key;
  const key = crypto.randomBytes(32).toString('hex');
  writeJson('secret.json', { key, createdAt: Date.now() });
  log.warn('security',
    '未配置 SESSION_SECRET，已自动生成随机密钥并持久化到 data/secret.json（建议显式配置）');
  return key;
}

const SESSION_SECRET = resolveSessionSecret();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const MAX_USERNAME = 16;
const MIN_PASSWORD = 8;

/**
 * 极弱口令黑名单（不区分大小写）。
 *
 * ⚠️ 刻意保持**短**：口令强度主要靠"长度下限"（MIN_PASSWORD），黑名单只拦"一眼就知道"的常见口令，
 * 免得变成一份永远维护不过来的大表。用户名同名口令由 `register` 单独判。
 */
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '88888888',
  'password', 'passw0rd', 'qwertyui', 'qwerty123', '1qaz2wsx', 'iloveyou', 'admin123',
  'abc12345', 'tdshogi', 'tdshogi123', 'shogi123',
]);

/**
 * scrypt 参数：**显式写死并版本化**。
 *
 * 目的：将来若要调参（提高 N 等），老账号仍能按 `account.hashAlg` 记录的旧参数验证——
 * 否则一调参所有存量账号直接登录失败。未知版本一律回退到当前版本（见 `paramsFor`）。
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const CURRENT_HASH_ALG = 'scrypt-v1';
const HASH_ALG_PARAMS = { 'scrypt-v1': SCRYPT_PARAMS };

/** 取某个哈希版本对应的 scrypt 参数；未知版本回退当前版本。 */
function paramsFor(alg) {
  return HASH_ALG_PARAMS[alg] || SCRYPT_PARAMS;
}

let cache = null;
function getCache() {
  if (!cache) cache = readJson(ACCOUNTS_FILE, {}) || {};
  return cache;
}
function persist() {
  // ⚠️ 2026-10-04：writeJson 失败会返回 false（并已记日志）——补记账号表上下文，不抛异常。
  if (!writeJson(ACCOUNTS_FILE, getCache())) {
    log.error('accounts', '账号表落盘失败', { file: ACCOUNTS_FILE });
  }
}

/**
 * 密码哈希：scrypt + 随机盐（每用户独立盐），参数按版本 `alg` 选择。
 * @returns {{salt:string, hash:string, alg:string}}
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex'), alg = CURRENT_HASH_ALG) {
  const p = paramsFor(alg);
  const hash = crypto.scryptSync(String(password), salt, p.keylen, { N: p.N, r: p.r, p: p.p }).toString('hex');
  return { salt, hash, alg };
}

/**
 * 校验口令。
 *
 * ⚠️ 两个要点（2026-09 审查）：
 *  1. **按 `alg` 选参**：不读 `alg` 而固定用当前参数，是一颗"调参即全体登录失败"的雷（已修）。
 *  2. 先做**格式与长度**校验再常量时间比较：`expectedHash` 非法（非 hex、长度不等）直接 false，
 *     避免 `timingSafeEqual` 因字节长度不等抛 RangeError。
 */
function verifyPassword(password, salt, expectedHash, alg = CURRENT_HASH_ALG) {
  // 格式白名单 + 异常兜底（同 verifyToken 的 P0-1）：expectedHash 非 hex 时
  // `Buffer.from(s,'hex')` 会变短，timingSafeEqual 抛 RangeError → 登录接口 500。
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]+$/.test(expectedHash) || expectedHash.length === 0) {
    return false;
  }
  const { hash } = hashPassword(password, salt, alg);
  if (hash.length !== expectedHash.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch (_) {
    return false;
  }
}

/**
 * 注册新账号。
 * @param {string} username
 * @param {string} password
 * @param {string|null} guestId 游客 id（升级用，可选）
 * @returns {{ok:true, account:object}|{ok:false, error:string}}
 */
const USERNAME_RE = new RegExp(`^[\\w\\u4e00-\\u9fa5-]{2,${MAX_USERNAME}}$`);
function register(username, password, guestId = null, migrationKey = null) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!USERNAME_RE.test(name)) {
    return { ok: false, error: `用户名需为 2-${MAX_USERNAME} 个字符（中文/字母/数字/下划线/横线）` };
  }
  if (pass.length < MIN_PASSWORD) {
    return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
  }
  if (WEAK_PASSWORDS.has(pass.toLowerCase())) {
    return { ok: false, error: '密码过于常见，请更换更复杂的密码' };
  }
  if (pass.toLowerCase() === name.toLowerCase()) {
    return { ok: false, error: '密码不能与用户名相同' };
  }
  const accounts = getCache();
  if (Object.values(accounts).some((a) => a.username === name)) {
    return { ok: false, error: '用户名已被占用' };
  }
  const id = auth.genId();
  const { salt, hash, alg } = hashPassword(pass);
  const account = {
    id,
    username: name,
    nickname: name, // 昵称（对外显示名）：初始=用户名，此后二者分离；改昵称花积分（见 setNickname）
    salt,
    passHash: hash,
    hashAlg: alg, // 口令哈希版本（校验时按它选 scrypt 参数，见 verifyPassword）
    guestId: guestId || null, // 升级来源游客 id（迁移后仍保留用于追溯）
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  accounts[id] = account;
  persist();
  // 游客数据迁移（对局/评级/会话 → accountId）
  //
  // ⚠️⚠️ **必须先确认这个 id 不是别人的注册账号**（2026-09-21 安全审查 P0-3，已实测复现）：
  // 账号 id 是公开数据，而原实现不验证来源 —— 任何人用受害者 id 注册，
  // 就能干净地拿走他的**全部棋谱、ELO 战绩与会话**（审查实测：1516 分 1 局的账号被搬空，
  // 受害者账号随即变回 1500 分空号）。
  // 完整方案是「迁移凭据」（游客会话里存一个不下发的 key，迁移时必须携带）——留下一版；
  // 本版先做**最小修复**：已是注册账号的 id 一律不迁移，并记审计日志。
  let migrated = false;
  let migrationSkipped = null;
  if (guestId && getAccount(guestId)) {
    log.warn('accounts', '拒绝游客数据迁移：目标 id 已是注册账号', { guestId, by: id });
    migrationSkipped = 'target_is_account';
  } else if (guestId) {
    // B2 迁移凭据（2026-10-02 审查 P1-3）：迁移必须能证明「持有」来源会话。
    // 已绑定 secret 的会话：必须携带匹配的 migrationKey，否则拒绝（防冒用公开 guestId 搬空资产的 IDOR）。
    // 未绑定 secret 的老会话：与 rename/setAvatar 同一契约——**兼容放行**（无法证明持有，但也不锁死升级）。
    // ⚠️ 2026-10-06：外包曾改成「未绑定一律拒绝」，与 B1/B2 产品契约及 e2e 升级路径冲突，已恢复。
    const vk = auth.verifyKey(guestId, migrationKey);
    if (!vk.ok) {
      log.warn('accounts', '拒绝游客数据迁移：缺少有效的迁移凭据', { guestId, by: id, bound: vk.bound });
      migrationSkipped = 'no_valid_key';
    } else {
      migrateGuestData(guestId, id);
      migrated = true;
    }
  }
  // 写会话（名字=用户名，供 WS/REST 显示）。账号会话不带游客持有证明（B1）。
  auth.markAccountSession(id, name);
  return { ok: true, account: publicInfo(account), migrated, migrationSkipped };
}

/**
 * 登录：校验用户名 + 密码，成功返回账号 + 会话令牌。
 */
function login(username, password) {
  const name = String(username || '').trim();
  const accounts = getCache();
  const account = Object.values(accounts).find((a) => a.username === name);
  if (!account) {
    // ⚠️ 2026-10-02 审查 P3：用户名不存在时也做一次等价的 scrypt 计算，
    // 消除「未知用户名秒返回 / 已存在用户名耗时数十 ms」的时序侧信道（用户名枚举）。
    try { hashPassword(String(password || ''), '0'.repeat(32)); } catch (_) { /* 忽略 */ }
    return { ok: false, error: '用户名或密码错误' };
  }
  if (!verifyPassword(String(password || ''), account.salt, account.passHash, account.hashAlg)) {
    return { ok: false, error: '用户名或密码错误' };
  }
  // 刷新会话（显示名=昵称）；账号身份走令牌，清掉持有证明绑定
  auth.markAccountSession(account.id, account.nickname || account.username);
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
  // ⚠️⚠️ 常量时间比较前必须把「长度」量准（2026-09-21 安全审查 P0-1，已实测复现）：
  // 原实现用 `sig.length`（**UTF-16 字符数**）做前置校验，而 `Buffer.from(sig)` 得到的是
  // **UTF-8 字节数**。签名段塞多字节字符时（32 个 emoji = 64 字符 / 128 字节），
  // 长度校验通过、`crypto.timingSafeEqual` 因字节长度不等抛 RangeError；
  // 该异常发生在 WS 握手回调里且无人接 → **整个进程退出，全部在线对局断线**
  // （单行命令即可打崩，且不需要任何账号）。
  // 修法：先做**格式白名单**（64 位小写 hex ⇒ 字符数恒等于字节数），再比较，并兜住异常。
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig) || sig.length !== expected.length) {
    return null;
  }
  let same = false;
  try {
    same = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return null; // 理论上到不了这里，但握手路径不允许有任何抛出点
  }
  if (!same) return null;
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
    nickname: account.nickname || account.username, // 昵称（对外显示名）；老账号回落用户名
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
    nickname: a.nickname || a.username, // 昵称（显示名）；老账号回落用户名
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
  // 两项都未传时 a.profile 可能仍为 undefined，不能直接 .phone
  const prof = a.profile || {};
  return { ok: true, profile: { phone: prof.phone || '', style: prof.style || '不设定' } };
}

/**
 * 公开资料卡字段（玩家信息悬停小窗用）。绝不包含手机号。
 * ⚠️ 隐私（2026-10-10）：对外只给**昵称**，不暴露登录用户名（防撞库 + 用户要求"他人只看昵称"）。
 */
function getPublicCard(accountId) {
  const a = getCache()[accountId];
  if (!a) return null;
  return {
    isAccount: true,
    nickname: a.nickname || a.username, // 显示昵称（原为 username，会暴露登录名）
    createdAt: a.createdAt,
    style: (a.profile && a.profile.style) || '不设定',
  };
}

/**
 * 改昵称（花积分）。昵称 = 对外显示名，与登录用户名（username）分离。
 * 扣 `NICKNAME_COST` 积分（每完成一局 +1，见 ratings.addPoints）；积分不足则拒绝、不扣分。
 * 成功后同步会话显示名，使对局/榜单即时生效。
 */
const NICKNAME_COST = 5;
function setNickname(accountId, nickname) {
  const a = getCache()[accountId];
  if (!a) return { ok: false, error: '账号不存在' };
  const n = String(nickname || '').trim();
  if (!USERNAME_RE.test(n)) {
    return { ok: false, error: `昵称需为 2-${MAX_USERNAME} 个字符（中文/字母/数字/下划线/横线）` };
  }
  if (n === (a.nickname || a.username)) return { ok: false, error: '昵称未变化' };
  // 函数内 require，避免与 ratings 形成模块环（ratings 顶部不依赖本模块）
  const ratings = require('./ratings');
  const prof = ratings.profile(accountId);
  if ((prof.points || 0) < NICKNAME_COST) {
    return { ok: false, error: `积分不足：改昵称需 ${NICKNAME_COST} 积分（当前 ${prof.points || 0}）` };
  }
  ratings.addPoints(accountId, -NICKNAME_COST); // 扣积分
  a.nickname = n;
  a.updatedAt = Date.now();
  persist();
  // 同步会话显示名（对局/榜单显示昵称）
  try { auth.markAccountSession(accountId, n); } catch (_) { /* 会话可能不存在，忽略 */ }
  return { ok: true, nickname: n, points: ratings.profile(accountId).points };
}

/**
 * 游客数据迁移到账号（**幂等**，可**安全重跑**）。
 *
 * 重写的三类数据：
 *  - ELO 评级表（ratings.json 的 key）
 *  - 对局记录（records/*.json 的 playerIds / winnerId）
 *  - 游客会话（sessions/<guestId>.json → 账号 id，最后一步）
 *
 * ⚠️ 执行顺序（架构体检 #6 修复）：**先做可重复的重活，最后做不可逆的一步**。
 *   1) 评级表 → 2) 棋谱 → 3) **游客会话**。会话一旦挪走，用户就认为迁移已完成，
 *   所以它必须放最后：哪怕前两步失败，用户的「身份」仍在游客会话里，重跑即可补齐；
 *   反之若先挪会话、后两步失败，就会退化成「注册完反而数据丢了」的半迁移态。
 *
 * ⚠️ 幂等性（为什么重跑安全）：每步都是「已经做过就跳过」的写入，重复执行不重复迁移、不丢数据——
 *   - 评级：客→账 覆盖写 + 删客；重跑时 guestId 已不在表 → 跳过。
 *   - 棋谱：按 playerIds/winnerId 逐条替换；重跑时已无记录引用 guestId → 不改。
 *   - 会话：迁移前先看账号会话是否已存在；重跑时游客会话已被删 → 跳过（或补账号标记）。
 *   因此本函数可在任意「半迁移态」下直接重跑收敛，无需人工清理。
 *
 * ⚠️ 失败语义：每步各自独立 try/catch，**一步失败不影响后续步骤**（它们互不依赖）；
 *   失败原因收集进 `failed` 并用 `log.error` 记录（不静默）。失败的那一步**不置为成功**。
 *   注意：会话放最后，故其失败时前两步（可重复）可能已成功——重跑会被幂等跳过，只补会话。
 *
 * @param {string} guestId 游客 id
 * @param {string} accountId 目标账号 id
 * @returns {{ok:boolean, moved:{ratings:boolean, records:number, session:boolean}, failed:string[]}}
 *   ok=全部成功；moved.records=本次真正改写的棋谱条数（幂等重跑时可能为 0）；
 *   failed=失败的步骤名列表（'ratings'|'records'|'session'）。`ok` 字段用于向后兼容旧调用方判真假。
 */
function migrateGuestData(guestId, accountId) {
  const result = { ok: false, moved: { ratings: false, records: 0, session: false }, failed: [] };
  if (!guestId || guestId === accountId) {
    result.ok = true;
    return result;
  }
  const markFail = (step, err) => {
    result.failed.push(step);
    log.error('accounts', `游客数据迁移失败：${step}`, { err, guestId, accountId });
  };

  // 1. 评级表 —— 幂等：客→账 覆盖写 + 删客，重跑时 guestId 已不在表，跳过。
  // ⚠️ §5.1：ratings 现用去抖写；下面要**直接**落盘 ratings.json，必须先把内存改动 flush，
  //    否则未落盘的去抖写会在此后 refreshCache 时被丢弃（见 ratings.refreshCache 的契约说明）。
  try { require('./ratings').flush(); } catch (_) {}
  try {
    const ratings = readJson('ratings.json', {}) || {};
    if (ratings[guestId]) {
      // ⚠️ 2026-10-04 架构优化：迁移幂等化 —— guestId 与 accountId 同时存在时，以「客→账、删客」
      //    的覆盖写收口，保证重复执行结果一致（不会出现两份评级或半边迁移）。
      ratings[accountId] = ratings[guestId];
      delete ratings[guestId];
      writeJson('ratings.json', ratings);
      result.moved.ratings = true;
    }
  } catch (err) {
    markFail('ratings', err);
  }

  // 2. 对局记录（playerIds / winnerId 替换）—— 幂等：重跑时已无记录引用 guestId，不再改动。
  //    PLAN §Q7-2：先用摘要列 playerB/playerW 的索引**只取受影响的棋谱**，再逐条读整谱改写。
  //    旧实现 dbList(100000) 会把全表整谱都解析一遍（游客升级账号时明显卡顿）。
  try {
    const storage = require('./storage');
    for (const s of storage.listSummaries({ playerId: guestId, limit: 100000 })) {
      const rec = storage.getRecordById(s.id);
      if (!rec) continue;
      let changed = false;
      if (rec.playerIds && rec.playerIds.b === guestId) { rec.playerIds.b = accountId; changed = true; }
      if (rec.playerIds && rec.playerIds.w === guestId) { rec.playerIds.w = accountId; changed = true; }
      if (rec.winnerId === guestId) { rec.winnerId = accountId; changed = true; }
      if (changed) { storage.putRecord(rec); result.moved.records += 1; }
    }
  } catch (err) {
    markFail('records', err);
  }

  // 3. 游客会话 → 账号会话（**最后一步**：可重复的重活都做完才动不可逆的身份迁移）。
  //
  // ⚠️ 会话的**唯一来源是 kv**（`sessions/<id>.json`，见 `auth.js` 顶部注释）。
  // 这里原先读写的是 `storage` 的 `sessions` **表** —— 那是另一条路，两者互不相通：
  // 于是"迁移"看着做了，实际游客的会话根本没搬过去（名字/创建时间丢失），
  // 也正是"管理员用户列表偶尔拿不到昵称"的根因（PLAN §M4）。
  // 现在统一走 `auth.getSessionRaw` / `auth.saveSession`。
  try {
    const guestSession = auth.getSessionRaw(guestId);
    if (guestSession) {
      // ⚠️ 2026-10-04 架构优化：迁移幂等化 —— 先判断账号会话是否已存在，避免重复迁移/覆盖。
      if (!auth.getSessionRaw(accountId)) {
        // ⚠️ 不要带走游客持有证明 `secret`：账号的身份凭据是会话令牌。
        // 把 secret 迁到账号会话后，改名/换头像会被 verifyKey 判 AUTH_KEY
        // （连接层对账号连接刻意不传 key），表现为「注册完就身份校验失败」。
        const { secret: _drop, ...guestRest } = guestSession;
        auth.saveSession(Object.assign({}, guestRest, { id: accountId, isAccount: true }));
      } else {
        // 目标已有会话（兼容旧路径/重跑）：补账号标记并去掉误迁的 secret
        auth.markAccountSession(accountId);
      }
      // 3.5 迁移成功后**删除旧游客会话**（Bug3）——迁移是「移动」而不是「复制」。
      //     旧游客会话若留存，同一人会在 `listSessions()` / 管理端用户列表里出现**两条**
      //     （一条幽灵游客、一条账号），旧游客身份也仍能建立连接（自战温床）。
      //     来源由 `account.guestId` 保留（§U5 游客清理/追溯要用），这里只清会话文件。
      //     幂等：会话删掉后重跑 guestSession 为 null → 整步跳过。
      auth.removeSession(guestId);
      result.moved.session = true;
    }
  } catch (err) {
    markFail('session', err);
  }

  // 4. 在缓存中使 rating 缓存失效（下轮自动重读）—— 尽力而为，不算作迁移步骤。
  try { require('./ratings').refreshCache(); } catch (_) {}

  result.ok = result.failed.length === 0;
  return result;
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
  // 随机口令：生成足够长再截断，确保即便去掉 base64url 里的 -/_ 后仍满足长度下限。
  if (!pass) pass = crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, 16);
  if (pass.length < MIN_PASSWORD) return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
  const { salt, hash, alg } = hashPassword(pass);
  a.salt = salt;
  a.passHash = hash;
  a.hashAlg = alg;
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
  verifyPassword, // 口令校验纯函数（测试覆盖坏哈希不抛异常）
  verifyToken,
  issueToken,
  getAccount,
  listAccounts,
  listAccountsRaw, // §U5 游客清理用：含 guestId 等非公开字段，仅服务端内部
  publicInfo,
  getOwnProfile,
  updateProfile,
  getPublicCard,
  setNickname, // 改昵称（花积分，见上）
  adminUpdateProfile,
  adminResetPassword,
  deleteAccount,
  STYLE_OPTIONS,
};
