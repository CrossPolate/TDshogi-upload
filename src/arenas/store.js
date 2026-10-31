'use strict';

/**
 * arenas/store.js — Arena 的 kv 缓存与外部依赖注入。
 *
 * Arena-lite（1.8 WP8）与淘汰赛/瑞士制不同：没有固定报名名单和固定轮次，
 * 而是在时间窗口内持续加入、按积分反复配对，所以单独存 `arenas.json`。
 */
const { readJson, writeJson } = require('../storage');

let cache = null;

function getCache() {
  if (!cache) {
    const data = readJson('arenas.json', {});
    cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }
  return cache;
}

function persist() {
  return writeJson('arenas.json', getCache());
}

/** 仅测试用：切换 DATA_DIR 后丢弃缓存。 */
function resetCache() {
  cache = null;
}

let matchFactory = null;
let availabilityChecker = () => true;
let onlineChecker = () => true;
let roomActiveChecker = () => false;
let notifyFn = null;

function setMatchFactory(fn) {
  matchFactory = typeof fn === 'function' ? fn : null;
}

function setAvailabilityChecker(fn) {
  availabilityChecker = typeof fn === 'function' ? fn : () => true;
}

function setOnlineChecker(fn) {
  onlineChecker = typeof fn === 'function' ? fn : () => true;
}

function setRoomActiveChecker(fn) {
  roomActiveChecker = typeof fn === 'function' ? fn : () => false;
}

function setNotifyFn(fn) {
  notifyFn = typeof fn === 'function' ? fn : null;
}

module.exports = {
  getCache,
  persist,
  resetCache,
  setMatchFactory,
  setAvailabilityChecker,
  setOnlineChecker,
  setRoomActiveChecker,
  setNotifyFn,
  // 可变量必须属性访问（同 tournaments/store.js 的教训）
  get matchFactory() { return matchFactory; },
  get availabilityChecker() { return availabilityChecker; },
  get onlineChecker() { return onlineChecker; },
  get isRoomActive() { return roomActiveChecker; },
  get notifyFn() { return notifyFn; },
};
