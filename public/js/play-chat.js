/**
 * play-chat.js — 对局页「聊天 + 观众列表」（PLAN §M5 前端拆分第 2 步）
 *
 * 从 `play.js` 抽出（第一步是 `play-clock.js`）。选它先搬的原因：**与对局状态零耦合**——
 * 聊天记录、分区 tab、观众名单都是自成一体的（只碰 DOM 与 WS 事件），
 * 不像感想战那样要读写 `state` / `fb` / `cursor` 一堆闭包变量。**搬过来逻辑一字未改**。
 *
 * 对外接口（由 `play.js` 调用）：
 *   PlayChat.init()                  注册 WS 事件与 DOM 交互（在 `api.connect()` 之后调；幂等）
 *   PlayChat.renderSpectators(list)  state 快照里的观众名单（首屏初始化用——此前只有
 *                                    `spectator_update` 才渲染，导致刚进场的人一直看到「暂无观众」）
 *
 * 依赖：`window.API`、`window.UI`（`$` / `esc`）、`window.Settings`（观众进出提示开关）
 *       DOM：`#chatBox` `#chatInput` `#btnChatSend` `#chatTabs` `#spectatorList` `#spectatorCount`
 *
 * ⚠️ 加载顺序：必须在 `play.js` **之前**（play.js 会调它的接口）。
 */
(function () {
  'use strict';

  const api = window.API;
  const $ = (id) => window.UI.$(id);
  // 公共工具（PLAN §M5）：与全站同一份实现，此处只转发
  function escHtml(s) { return window.UI.esc(s); }

  // ==================================================================
  // 观众列表（PLAN §R）
  // ==================================================================
  /**
   * 兼容两种形态：字符串数组（旧）与 `{id,name,rating,level}`（新）。
   */
  function renderSpectators(list) {
    const countEl = $('spectatorCount');
    const el = $('spectatorList');
    if (!el) return;
    const items = (list || []).map((s) => (typeof s === 'string' ? { name: s } : (s || {})));
    if (countEl) countEl.textContent = items.length;
    el.innerHTML = items.length
      ? items.map((s) => {
        const attrs = s.id ? ` data-player-id="${escHtml(s.id)}"` : '';
        const lv = (s.level !== undefined && s.level !== null) ? ` <span style="color:var(--gold-light);font-size:11px;">Lv.${s.level}</span>` : '';
        return `<div style="padding:3px 0;">👤 <span${attrs} class="spectator-name">${escHtml(s.name || '观众')}</span>${lv}</div>`;
      }).join('')
      : '<div style="color:var(--text-dim);font-size:12px;">暂无观众</div>';
  }

  // ==================================================================
  // 聊天（§R2 kibitz 分区）
  // ==================================================================
  const chatBox = $('chatBox');
  const chatInput = $('chatInput');
  // §R2 kibitz 分区：保存全量消息，切 tab 时按当前筛选整体重渲染（否则切不回来）
  let chatLog = [];
  let chatTab = 'all'; // all | players | spectators

  /** 当前 tab 是否应显示该条 */
  function chatMatch(msg) {
    if (chatTab === 'all') return true;
    if (msg.sys) return true; // 系统消息在任何分区都可见
    if (chatTab === 'players') return msg.role === 'player-b' || msg.role === 'player-w';
    if (chatTab === 'spectators') return msg.role === 'spectator';
    return true;
  }

  function appendChatRow(msg) {
    if (!chatBox) return;
    const row = document.createElement('div');
    // §R2：玩家金色 / 观战者冷蓝 / 系统暗色斜体（配色见 style.css）
    const kind = msg.sys ? 'sys' : (msg.role === 'spectator' ? 'spectator' : 'player');
    row.className = `chat-msg ${kind}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.name || '';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = msg.text;
    row.appendChild(who);
    row.appendChild(text);
    chatBox.appendChild(row);
  }

  function renderChat() {
    if (!chatBox) return;
    chatBox.innerHTML = '';
    for (const m of chatLog) if (chatMatch(m)) appendChatRow(m);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function appendChat(msg) {
    chatLog.push(msg);
    while (chatLog.length > 100) chatLog.shift();
    if (!chatMatch(msg)) return; // 当前分区不显示，但仍记入全量，切回来还在
    appendChatRow(msg);
    if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    api.send({ type: 'chat', data: { text } });
    chatInput.value = '';
  }

  /** 注册 DOM 交互与 WS 事件（**幂等**：重复调用不会重复绑定/重复收消息） */
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;

    if ($('btnChatSend')) $('btnChatSend').addEventListener('click', sendChat);
    if (chatInput) chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    // §R2 分区切换
    if ($('chatTabs')) {
      $('chatTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-tab');
        if (!btn) return;
        chatTab = btn.getAttribute('data-tab') || 'all';
        $('chatTabs').querySelectorAll('.chat-tab').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        renderChat();
      });
    }

    api.on('chat', (data) => {
      if (!data) return;
      // §R3：观众进出提示可关闭（人多时避免刷屏）；其余系统消息不受影响
      if (data.kind && data.kind.indexOf('spectate-') === 0
        && window.Settings && window.Settings.get('spectatorNotices') === false) return;
      const mark = data.role === 'spectator' ? '👁 ' : '';
      appendChat({
        name: mark + (data.name || ''),
        text: data.text,
        role: data.role || 'player',
        sys: !!data.sys,
        kind: data.kind || null,
      });
    });

    // 观战者进入时系统提示（rebind=选手掉线重进回位，不算观战）
    api.on('spectating', (data) => {
      if (data && data.rebind) return;
      appendChat({ name: '系统', text: '你已进入观战，欢迎交流！', sys: true });
    });

    api.on('spectator_update', (d) => renderSpectators(d.spectators || []));
  }

  window.PlayChat = { init, renderSpectators };
})();
