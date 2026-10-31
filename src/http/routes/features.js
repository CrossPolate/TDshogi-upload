'use strict';

/**
 * routes/features.js — 公开展示当前启用的升级功能。
 *
 * 前端只依赖这个接口决定是否显示“题库 / 研究 / 长局”等入口；
 * 真正的权限与功能逻辑仍由各自模块校验，不能把开关当成授权。
 */

const features = require('../../features');

module.exports = function registerFeatures(app) {
  app.get('/api/features', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(features.publicInfo());
  });
};
