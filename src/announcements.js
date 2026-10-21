/**
 * announcements.js — 系统公告读写（data/announcements.json）
 *
 * 数据结构（数组）：
 *   { id, title, content, pinned, createdAt, updatedAt? }
 *
 * 公告是**全站可见**的内容，所以：
 *  - 读写都限制长度与条数（上限见下方常量）——公告会被首页/大厅全量下发，不加限制迟早拖慢首屏；
 *  - 置顶在前，其余按时间倒序（列表页与首页看到的顺序一致，不用各自再排一遍）。
 */
'use strict';

const { readJson, writeJson } = require('./storage');
const log = require('./logger');

const KEY = 'announcements.json';
/** 已发放的最大公告 id（与列表分开存，见 `nextId()` 注释） */
const SEQ_KEY = 'announcements.seq';
const MAX_TITLE = 60;
const MAX_CONTENT = 1000;
/** 条数上限：不设上限的话公告会越积越多，而首页要把它们全量发给每个访客 */
const MAX_COUNT = 100;

const DEFAULT = [
  {
    id: 1,
    title: '欢迎来到 TDShogi',
    content: 'TDShogi 在线将棋对战平台正式上线！游客免注册即可开始对局。',
    createdAt: Date.now(),
    pinned: true,
  },
  {
    id: 2,
    title: '功能提示',
    content: '支持好友房间（6 位房间码邀请）、快速匹配、实时观战与随机观战，对局自动保存棋谱并可导出 KIF/CSA。',
    createdAt: Date.now(),
    pinned: false,
  },
];

/** 内部：原始列表（保持存储顺序，写回时顺序稳定） */
function rawList() {
  const data = readJson(KEY, null);
  return Array.isArray(data) ? data : DEFAULT.slice();
}

/**
 * 全部公告（置顶在前，其余按 createdAt 倒序）。
 *
 * ⚠️ 判断条件**只看「是不是数组」，绝不能顺手加 `data.length`**：
 * 管理员把公告删光后写回的是**空数组**；若把空数组也当成"还没有任何数据"，
 * 默认公告就会**重新冒出来**，用户看到的现象是"删不掉"。
 * （旧实现正是这么写的——本次修掉。）
 */
function listAnnouncements() {
  const data = readJson(KEY, null);
  if (!Array.isArray(data)) return DEFAULT.slice();
  return data.slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/** 校验并归一化标题/内容 */
function clean(title, content) {
  const t = String(title == null ? '' : title).trim();
  const c = String(content == null ? '' : content).trim();
  if (!t) return { ok: false, error: '标题不能为空' };
  if (t.length > MAX_TITLE) return { ok: false, error: `标题过长（最多 ${MAX_TITLE} 字）` };
  if (!c) return { ok: false, error: '内容不能为空' };
  if (c.length > MAX_CONTENT) return { ok: false, error: `内容过长（最多 ${MAX_CONTENT} 字）` };
  return { ok: true, title: t, content: c };
}

/**
 * 下一个公告 id：**单调递增**。
 *
 * ⚠️ 不能只取「当前列表里的最大 id + 1」：把最大的那条删掉后，新公告会**复用**刚删掉的 id，
 * 而前端的编辑态/缓存是按 id 索引的 —— 复用会让"正在编辑 #3"突然指向另一条公告。
 * 所以把已发放的最大 id 单独存在一个 kv 键里，与列表本身解耦：
 * 列表被删空也不回退。
 */
function nextId(list) {
  const last = Number(readJson(SEQ_KEY, 0)) || 0;
  const maxExisting = list.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
  const id = Math.max(last, maxExisting) + 1; // 取两者较大值，兼容"升级前已有公告"的情况
  writeJson(SEQ_KEY, id);
  return id;
}

/**
 * 新增公告。
 * @returns {{ok:true, announcement:object}|{ok:false, error:string}}
 */
function addAnnouncement({ title, content, pinned = false } = {}) {
  const v = clean(title, content);
  if (!v.ok) return v;

  const list = rawList();
  if (list.length >= MAX_COUNT) {
    return { ok: false, error: `公告数量已达上限（${MAX_COUNT} 条），请先删除旧公告` };
  }
  const id = nextId(list);
  const item = { id, title: v.title, content: v.content, pinned: !!pinned, createdAt: Date.now() };
  list.unshift(item);
  writeJson(KEY, list);
  log.info('announcements', `新增公告 #${id}`, { title: v.title, pinned: !!pinned });
  return { ok: true, announcement: item };
}

/**
 * 修改公告。字段可只传一部分（例如只切换置顶）。
 * @returns {{ok:true, announcement:object}|{ok:false, error:string}}
 */
function updateAnnouncement(id, { title, content, pinned } = {}) {
  const list = rawList();
  const item = list.find((a) => String(a.id) === String(id));
  if (!item) return { ok: false, error: '公告不存在' };

  const v = clean(title === undefined ? item.title : title, content === undefined ? item.content : content);
  if (!v.ok) return v;

  item.title = v.title;
  item.content = v.content;
  if (pinned !== undefined) item.pinned = !!pinned;
  item.updatedAt = Date.now();
  writeJson(KEY, list);
  log.info('announcements', `修改公告 #${item.id}`, { title: v.title, pinned: !!item.pinned });
  return { ok: true, announcement: item };
}

/**
 * 删除公告。
 * ⚠️ 删到最后一条也**照删**——删空后 `listAnnouncements()` 返回空数组（不会退回默认公告）。
 */
function deleteAnnouncement(id) {
  const list = rawList();
  const idx = list.findIndex((a) => String(a.id) === String(id));
  if (idx < 0) return { ok: false, error: '公告不存在' };
  const removed = list.splice(idx, 1)[0];
  writeJson(KEY, list);
  log.info('announcements', `删除公告 #${removed.id}`, { title: removed.title });
  return { ok: true, id: removed.id };
}

module.exports = {
  listAnnouncements, addAnnouncement, updateAnnouncement, deleteAnnouncement,
  MAX_TITLE, MAX_CONTENT, MAX_COUNT,
};
