/**
 * src/http/routes/health.js — 健康探针（GET /healthz，§7.2）
 *
 * 用途：给部署/监控一个**只读**的存活与基本状态接口，无需鉴权、不触碰业务写路径：
 *   { ok, uptime, version, db, rooms, queue, mem, ts }
 *
 * ⚠️ 设计约束：**绝不返回 5xx**。任何一项取值失败都降级为字段级提示（如 `db.ok=false`），
 *    而不是把探针本身打挂 —— 否则"进程还活着但某个子系统抖动"会被监控误判为"服务死了"，
 *    触发无谓的重启。真正需要报警的是 `ok=false` 或字段异常，而非 HTTP 状态。
 */
'use strict';

const storage = require('../../storage');
const { protocol, VERSION } = require('../context');

/** 轻量 DB 探针：一次只读 kv 访问；抛错即视为不可用 */
function probeDb() {
  try {
    storage.readJson('__health_probe__', null);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = function registerHealth(app) {
  app.get('/healthz', (req, res) => {
    const out = {
      ok: true,
      uptime: Math.round(process.uptime()),
      version: VERSION,
      db: { ok: false },
      rooms: { playing: 0, waiting: 0, reviewing: 0 },
      queue: { matching: 0 },
      mem: {},
      ts: Date.now(),
    };
    try { out.db = { ok: probeDb() }; } catch (_) { out.db = { ok: false }; }
    try {
      const s = protocol.rooms.stats();
      out.rooms = { playing: s.playing, waiting: s.waiting, reviewing: s.reviewing };
      out.queue = { matching: s.matching };
    } catch (_) { /* 房间子系统异常：保持默认值，不掩盖也不炸 */ }
    try {
      const m = process.memoryUsage();
      out.mem = {
        rssMB: Math.round(m.rss / 1048576),
        heapUsedMB: Math.round(m.heapUsed / 1048576),
      };
    } catch (_) {}
    if (out.db.ok === false) out.ok = false; // DB 不可用即整体不健康
    res.json(out);
  });
};
