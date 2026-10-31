'use strict';

/**
 * routes/upcoming.js — 1.6–1.9 功能的占位接口。
 *
 * 目的：先把路由边界和响应契约固定下来，业务模块接进来时不需要再改前端/网关。
 *  - 功能开关关闭：501 + FEATURE_DISABLED
 *  - 功能开关打开但业务尚未接入：501 + NOT_IMPLEMENTED
 *
 * 这些前缀都是新命名空间，不会覆盖现有 `/api/records`、`/api/items` 等真实接口。
 */

const features = require('../../features');

// 1.6–1.9 的功能均已接入真实路由；保留空清单给未来新功能先占位。
const UPCOMING = [];

function handlerFor(item) {
  return (req, res) => {
    const enabled = features.isOn(item.flag);
    res.setHeader('Cache-Control', 'no-store');
    res.status(501).json({
      ok: false,
      code: enabled ? 'NOT_IMPLEMENTED' : 'FEATURE_DISABLED',
      feature: item.flag,
      version: item.version,
      label: item.label,
      error: enabled ? '功能骨架已就绪，业务逻辑尚未接入' : '功能尚未开放',
    });
  };
}

module.exports = function registerUpcoming(app) {
  for (const item of UPCOMING) {
    // use 匹配前缀与全部子路径；不进入 next()，避免落到 SPA 兜底或旧接口。
    app.use(item.prefix, handlerFor(item));
  }
};

module.exports.UPCOMING = UPCOMING;
module.exports.handlerFor = handlerFor;
module.exports.registerUpcoming = module.exports;
