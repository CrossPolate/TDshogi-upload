/**
 * security-check.js — 启动期安全自检（fail-fast）
 *
 * 背景：本项目支持"零配置启动"——`SESSION_SECRET` / `ADMIN_SECRET` 未配置时自动生成随机值并持久化，
 * `ADMIN_PASSWORD` 未配置时生成随机口令并打印一次。这在**单机自用**时很方便，但**公开部署**时
 * 一个疏忽（忘配密钥、口令设成 123456）就会让整套鉴权形同虚设——而这类问题在启动阶段是**可判定**的。
 *
 * 本模块提供显式的"强配置模式"：设置 `REQUIRE_STRONG_SECRETS=1` 时，启动阶段校验关键密钥/口令，
 * 任一不达标立即 `exit(1)`（而不是带着弱配置默默跑起来对外服务）。
 *
 * ⚠️ 默认（未设置该变量）**完全不改变现有行为**——仍走自动生成/持久化路径，避免把现有部署打断。
 * 建议在 `DEPLOY.md` 指引的正式部署里显式开启。
 */
'use strict';

/** HMAC 密钥（SESSION_SECRET / ADMIN_SECRET）最小长度 */
const MIN_SECRET_LEN = 32;
/** 管理口令最小长度 */
const MIN_ADMIN_PASSWORD_LEN = 12;

/**
 * 纯函数：返回"不达标"的配置项清单（无副作用，便于单测）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{key:string, reason:string}>}
 */
function assertStrongSecrets(env = process.env) {
  const problems = [];
  const needSecret = (key) => {
    const v = env[key];
    if (!v) problems.push({ key, reason: '未设置' });
    else if (String(v).length < MIN_SECRET_LEN) {
      problems.push({ key, reason: `长度 ${String(v).length} 不足 ${MIN_SECRET_LEN}` });
    }
  };
  needSecret('SESSION_SECRET');
  needSecret('ADMIN_SECRET');

  const pw = env.ADMIN_PASSWORD;
  if (!pw) problems.push({ key: 'ADMIN_PASSWORD', reason: '未设置' });
  else if (String(pw).length < MIN_ADMIN_PASSWORD_LEN) {
    problems.push({ key: 'ADMIN_PASSWORD', reason: `长度 ${String(pw).length} 不足 ${MIN_ADMIN_PASSWORD_LEN}` });
  }
  return problems;
}

/**
 * 启动自检：**仅当** `REQUIRE_STRONG_SECRETS=1` 时生效。
 *   - 不达标 → 打印问题清单到 stderr 并 `exit(1)`，返回 true（表示已强制退出）；
 *   - 达标或未启用 → 返回 false（继续正常启动）。
 *
 * @param {{stderr:{write:Function}, exit:Function}} [io] 可注入的 IO（默认 process，便于单测）
 * @returns {boolean} 是否已强制退出
 */
function enforceOrExit(io = process) {
  if (String(process.env.REQUIRE_STRONG_SECRETS) !== '1') return false;
  const problems = assertStrongSecrets(process.env);
  if (problems.length === 0) return false;
  const lines = problems.map((p) => `  - ${p.key}：${p.reason}`).join('\n');
  io.stderr.write(
    '[security] REQUIRE_STRONG_SECRETS=1，但以下安全配置不达标，拒绝启动：\n'
    + lines + '\n'
    + '（请设置足够强的 SESSION_SECRET / ADMIN_SECRET / ADMIN_PASSWORD 后重试；'
    + '本次启动已中止，以避免带弱配置对外服务。详见 SECURITY.md。）\n',
  );
  io.exit(1);
  return true;
}

module.exports = { assertStrongSecrets, enforceOrExit, MIN_SECRET_LEN, MIN_ADMIN_PASSWORD_LEN };
