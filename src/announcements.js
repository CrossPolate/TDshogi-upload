/**
 * announcements.js — 系统公告读写（data/announcements.json）
 *
 * 公告由管理员手动维护 JSON 文件：
 * [
 *   { "id": 1, "title": "…", "content": "…", "createdAt": 1234567890, "pinned": true },
 *   ...
 * ]
 */
'use strict';

const { readJson, writeJson } = require('./storage');

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

function listAnnouncements() {
  const data = readJson('announcements.json', null);
  if (Array.isArray(data) && data.length) return data;
  return DEFAULT;
}

function addAnnouncement({ title, content, pinned = false }) {
  const list = listAnnouncements();
  const id = list.length ? Math.max(...list.map((a) => a.id)) + 1 : 1;
  list.unshift({
    id,
    title: String(title || '公告'),
    content: String(content || ''),
    pinned: !!pinned,
    createdAt: Date.now(),
  });
  writeJson('announcements.json', list);
  return list[0];
}

module.exports = { listAnnouncements, addAnnouncement };
