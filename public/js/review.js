/**
 * review.js — 复盘器（专用页面）
 *
 * 参考参考项目（参考 app.js 复盘分块）：
 *  - 棋谱对子布局（▲/△，先手/後手）
 *  - 日式/USI 切换
 *  - 前进/后退/跳首/跳末 + 当前手滚动居中
 *  - 书签（toggle）
 *  - 评论（写/删）
 *  - 变着（在指定手数下保存备选走法）
 *  - 仅 owner / 管理员可访问（服务端校验）
 */
(function () {
  const guest = window.NAV.renderNav('history');
  const params = new URLSearchParams(location.search);
  const recordId = params.get('id');
  // 管理员访问他人棋谱：携带 adminToken（服务端校验通过则放行）
  const adminToken = params.get('adminToken') || '';
  // 管理员可编辑对局信息、公开设置与任意评论（真正的鉴权在服务端 admin.verify）
  const isAdmin = !!adminToken;
  let editingCommentId = null;   // 正在编辑的评论 id（null = 新增）

  /** 统一请求头：管理员带上 x-admin-token */
  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (adminToken) h['x-admin-token'] = adminToken;
    return h;
  }

  // 公共工具（PLAN §M5）：实现统一在 util.js，此处只转发
  function toast(msg) { return window.UI.toast(msg); }
  function esc(s) { return window.UI.esc(s); }

  if (!recordId) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    document.getElementById('errorText').textContent = '缺少棋谱 ID';
    return;
  }

  const board = new window.ShogiBoard(document.getElementById('boardContainer'), { readonly: true });
  let review = null;     // 完整复盘数据
  let positions = [];    // 中间局面（来自 playback 或本地重放）
  let cursor = 0;        // 当前手（0=初始）
  let displayMode = 'jp';// 'jp' | 'usi'
  let navFromList = false; // 抑制自动滚动
  // 自由摆放（PLAN §G）：本地草稿，不入谱
  let fb = null;
  let freeMode = false;
  // 复盘视角（PLAN §S6）：默认先手，可翻转。与对局页观战视角共用 FreeBoard.setViewpoint
  let viewpoint = 'b';

  async function load() {
    const authQ = `guest=${encodeURIComponent(guest.id)}${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`;
    const url = `/api/records/${recordId}/review?${authQ}`;
    try {
      const r = await fetch(url);
      if (r.status === 403) throw new Error('只能复盘自己的棋谱');
      if (r.status === 404) throw new Error('棋谱不存在');
      if (!r.ok) throw new Error('加载失败');
      review = await r.json();
    } catch (e) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'block';
      document.getElementById('errorText').textContent = e.message;
      return;
    }
    // 加载回放中间局面
    const pb = await fetch(`/api/records/${recordId}/playback?${authQ}`).then((r) => r.json());
    positions = pb.positions || [];
    cursor = 0;
    render();
    initPermissionUI();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('review').style.display = 'block';
  }

  /**
   * §M6：统一的棋盘组件（review 只读模式）。
   * 浏览时渲染局面与上一步高亮；自由摆放时切 free 模式，不再重建实例。
   */
  function ensureFb() {
    if (fb) return fb;
    fb = new window.FreeBoard({
      board,
      viewpoint: 'b',
      interactive: false,
      mode: 'review',
      hands: {
        my: document.getElementById('myHandPieces'), myColor: 'b',
        opp: document.getElementById('oppHandPieces'), oppColor: 'w',
      },
    });
    fb.attach();
    // 绑定一次驹台拖拽（interactive=false 时不会触发，自由摆放开启后生效）
    fb.bindHands(document.getElementById('myHandPieces'), 'b', document.getElementById('oppHandPieces'), 'w');
    return fb;
  }

  /** 当前手的落点格（用于上一步高亮）：打子取落点，普通走子取 to */
  function lastMoveSq() {
    if (!cursor) return null;
    const usi = review.moves[cursor - 1];
    if (!usi) return null;
    return /^[PLNSGBR]\*/.test(usi) ? usi.slice(2) : usi.slice(2, 4);
  }

  /**
   * §L：权限相关的 UI 呈现
   *  - 公开棋谱 + 非管理员 → 只读（隐藏书签/评论/变着/自由摆放）
   *  - 管理员 → 显示「对局信息与展示设置」面板
   */
  function initPermissionUI() {
    const isPub = review.visibility === 'public';
    const readonly = isPub && !isAdmin;
    ['btnBookmark', 'btnComment', 'btnVariation', 'btnFreePlace'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = readonly ? 'none' : '';
    });
    if (isAdmin) {
      const p = document.getElementById('adminPanel');
      p.style.display = 'block';
      fillAdminForm();
    }
  }

  function fillAdminForm() {
    const m = review.meta || {};
    document.getElementById('adTitle').value = m.title || '';
    document.getElementById('adEvent').value = m.event || '';
    document.getElementById('adRound').value = m.round || '';
    document.getElementById('adPlayedOn').value = m.playedOn || '';
    document.getElementById('adTags').value = (m.tags || []).join(', ');
    document.getElementById('adNameB').value = (m.nameOverrides && m.nameOverrides.b) || '';
    document.getElementById('adNameW').value = (m.nameOverrides && m.nameOverrides.w) || '';
    document.getElementById('adResultNote').value = m.resultNote || '';
    document.getElementById('adDesc').value = m.description || '';
    document.getElementById('adFeatured').checked = !!m.featured;
    document.getElementById('adVisibility').value = review.visibility || 'private';
  }

  // 保存对局信息（管理员）
  document.getElementById('btnSaveMeta').addEventListener('click', async () => {
    const val = (id) => document.getElementById(id).value.trim();
    const body = {
      title: val('adTitle'),
      event: val('adEvent'),
      round: val('adRound'),
      playedOn: val('adPlayedOn'),
      tags: val('adTags').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean),
      description: val('adDesc'),
      nameOverrides: { b: val('adNameB'), w: val('adNameW') },
      resultNote: val('adResultNote'),
      featured: document.getElementById('adFeatured').checked,
    };
    try {
      const r = await fetch(`/api/admin/records/${recordId}/meta`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
      }).then((res) => res.json());
      if (r.ok) {
        review.meta = r.meta;
        toast('对局信息已保存');
        render();
      } else toast(r.error || '保存失败');
    } catch (_) { toast('网络错误'); }
  });

  // 应用可见性（管理员）
  document.getElementById('btnSaveVisibility').addEventListener('click', async () => {
    const visibility = document.getElementById('adVisibility').value;
    try {
      const r = await fetch(`/api/admin/records/${recordId}/visibility`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ visibility }),
      }).then((res) => res.json());
      if (r.ok) {
        review.visibility = r.visibility;
        document.getElementById('adTip').textContent = r.visibility === 'public' ? '已公开（广场可见）' : '已设为私有';
        toast(r.visibility === 'public' ? '已公开到棋谱广场' : '已设为私有');
        initPermissionUI();
        render();
      } else {
        document.getElementById('adTip').textContent = r.error || '操作失败';
      }
    } catch (_) { toast('网络错误'); }
  });

  // 对局结果文案（PLAN §M5）：实现统一在 util.js，此处只转发
  // （原先与 history.js 各有一份，加新结果说明时很容易只改一边）
  function resultText(r) { return window.UI.resultText(r); }

// 评论「编辑 / 删除」按钮：从 inline onclick 改为 `data-act` 委托（2026-09-23，审查项 13f）。
// 这两个值（手数 + 评论 id）原先被拼进 `onclick="rvEditComment(3, 'abc')"` 里 ——
// 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态。现在值为**属性文本**，逃不出属性。
window.UI.onAction('cm-edit', (el) => window.rvEditComment(
  Number(el.getAttribute('data-no')), el.getAttribute('data-id'),
));
window.UI.onAction('cm-del', (el) => window.rvDeleteComment(
  Number(el.getAttribute('data-no')), el.getAttribute('data-id'),
));

  function render() {
    // 顶部元信息（§L：管理员可为展示覆盖双方名/结果说明，与广场卡片保持一致）
    const ov = (review.meta && review.meta.nameOverrides) || null;
    document.getElementById('rvNameB').textContent = (ov && ov.b) || (review.names || ['先手'])[0];
    document.getElementById('rvNameW').textContent = (ov && ov.w) || (review.names || ['先手', '後手'])[1];
    const title = (review.meta && review.meta.title) || '';
    const extra = [(review.meta && review.meta.event) || '', (review.meta && review.meta.round) || ''].filter(Boolean).join(' ');
    document.getElementById('rvResult').textContent = [resultText(review), (review.meta && review.meta.resultNote) ? `（${review.meta.resultNote}）` : ''].filter(Boolean).join('');
    document.getElementById('rvMoves').textContent = `${review.moves.length} 手`;
    document.getElementById('rvDate').textContent = [extra, I18N.fmt(review.createdAt)].filter(Boolean).join(' · ');
    document.title = title ? `${title} · 复盘 · TDShogi` : '复盘 · TDShogi';
    document.getElementById('rvCursor').textContent = `${cursor} / ${review.moves.length}`;

    // 玩家栏：按当前视角排布（上方=对面、下方=自己）——PLAN §S6 复盘支持翻转
    // §F3 悬停信息卡：**必须设置 data-player-id**（reviewData 已返回 playerIds）。
    // 此前只设了 textContent，复盘页的悬停卡从未生效——与对局页「重进看不到 id」是两个独立缺陷。
    const names = review.names || ['先手', '後手'];
    const pids = review.playerIds || {};
    const topIdx = viewpoint === 'b' ? 1 : 0;     // 先手视角：上方 = 后手
    const bottomIdx = viewpoint === 'b' ? 0 : 1;  // 先手视角：下方 = 先手
    document.getElementById('topName').textContent = names[topIdx] || (topIdx === 0 ? '先手' : '後手');
    document.getElementById('topName').setAttribute('data-player-id', (topIdx === 0 ? pids.b : pids.w) || '');
    document.getElementById('topRating').textContent = '';
    document.getElementById('bottomName').textContent = names[bottomIdx] || (bottomIdx === 0 ? '先手' : '後手');
    document.getElementById('bottomName').setAttribute('data-player-id', (bottomIdx === 0 ? pids.b : pids.w) || '');
    document.getElementById('bottomRating').textContent = '';
    document.getElementById('topClock').textContent = '';
    document.getElementById('bottomClock').textContent = '';

    // 棋盘：§M6 —— 浏览与自由摆放都走 FreeBoard，
    // 浏览用 review 只读模式（自动带上一步高亮与统一持驹渲染），不再走裸 board.render。
    // §S6：视角统一由 setViewpoint 设置（会一并交换驹台配色并触发重渲染）；切勿直接改 fb.viewpoint
    const pos = positions[cursor];
    if (pos) {
      ensureFb();
      fb.setViewpoint(viewpoint);
      if (freeMode && fb) {
        fb.render();
      } else {
        fb.setModel({ board: pos.board, hands: pos.hands || {} }, lastMoveSq());
      }
    }

    // 棋谱对子列表
    renderMoveList();
    renderAnnotations();
    renderVariations();
  }

  function renderMoveList() {
    // 一编号 = 一手棋，与 KIF 文件手数顺序一致（此前为对子布局，一号两手）
    const el = document.getElementById('rvMoveList');
    const moves = review.moves;
    const times = review.moveTimes || [];
    let cum = 0;
    const html = [];
    for (let no = 1; no <= moves.length; no++) {
      // 每手的走子前局面：positions[0]=初始，positions[k]=第 k 手后
      const before = positions[no - 1];
      const text = formatMove(moves[no - 1], before);
      const mark = no % 2 === 1 ? '▲' : '△';
      const spent = Number(times[no - 1]) || 0;
      cum += spent;
      const timeTxt = spent ? ` <span style="color:var(--text-dim);font-size:11px;">(${Math.floor(spent / 60)}:${String(spent % 60).padStart(2, '0')}/${Math.floor(cum / 3600)}:${String(Math.floor((cum % 3600) / 60)).padStart(2, '0')}:${String(cum % 60).padStart(2, '0')})</span>` : '';
      html.push(`<div class="rv-move-row${cursor === no ? ' current' : ''}">
        <span class="rv-no">${no}</span>
        <span class="rv-mv${cursor === no ? ' cursor' : ''}${isBookmarked(no) ? ' bookmark' : ''}${hasComment(no) ? ' has-comment' : ''}${hasVariation(no) ? ' has-var' : ''}" data-no="${no}">${mark} ${text}${timeTxt}</span>
      </div>`);
      // §L：评论直接展示在手数下方（旧格式位置），管理员可就地编辑/删除
      const cs = (review.comments && review.comments[no]) || [];
      if (cs.length) {
        html.push(`<div class="rv-comments">${cs.map((c) => `
          <div class="rv-comment">
            <span class="rv-comment-who">💬 ${esc(c.authorName || '解说')}</span>
            <span class="rv-comment-text">${esc(c.text)}</span>
            ${c.editedAt ? '<span class="rv-comment-edited">（已编辑）</span>' : ''}
            ${isAdmin ? `<span class="rv-comment-ops">
              <button class="btn btn-ghost btn-sm" data-act="cm-edit" data-no="${no}" data-id="${esc(c.id)}" title="编辑">✏️</button>
              <button class="btn btn-ghost btn-sm" data-act="cm-del" data-no="${no}" data-id="${esc(c.id)}" title="删除">🗑</button>
            </span>` : ''}
          </div>`).join('')}</div>`);
      }
    }
    el.innerHTML = html.join('');
    el.querySelectorAll('.rv-mv').forEach((node) => {
      node.addEventListener('click', () => {
        const no = parseInt(node.dataset.no, 10);
        if (!no || no > review.moves.length) return;
        navFromList = true;
        cursor = no;
        render();
      });
    });
    scrollMoveListToCurrent();
  }

  function formatMove(usi, beforePos) {
    if (!usi) return '—';
    if (displayMode === 'jp') return usiToJp(usi, beforePos ? beforePos.board : null);
    return usi;
  }

  // 从走子前局面查找 from 格的棋子中文名（服务端 KIND_NAME 格式）
  function pieceNameAtBoard(board, fromUsi) {
    if (!board) return '';
    for (let r = 0; r < board.length; r++) {
      const row = board[r];
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell && cell.sq === fromUsi && cell.piece) return cell.piece;
      }
    }
    return '';
  }

  const KIND_JP = {
    '歩': '歩', '香': '香', '桂': '桂', '銀': '銀', '金': '金', '角': '角', '飛': '飛', '玉': '玉',
    'と': 'と', '成香': '杏', '成桂': '圭', '成銀': '全', '馬': '馬', '龍': '龍',
  };

  function usiToJp(usi, beforeBoard) {
    const full = ['０','１','２','３','４','５','６','７','８','９'];
    const kanji = ['一','二','三','四','五','六','七','八','九'];
    // 打子 P*5e → ５五歩打（此前落进普通走子分支渲染错乱）
    const dropM = /^([PLNSGBR])\*([1-9])([a-i])$/.exec(usi);
    if (dropM) {
      const sym = (window.DROP_SYMBOLS || {})[dropM[1]] || '歩';
      return `${full[parseInt(dropM[2], 10) - 1]}${kanji[dropM[3].charCodeAt(0) - 97]}${sym}打`;
    }
    if (usi.length === 4 || usi.length === 5) {
      const toFile = usi[2];
      const toY = usi.charCodeAt(3) - 96;
      // 升变标记
      const promote = usi.length === 5 ? '成' : '';
      // 从走子前局面推导棋子名
      const fromUsi = usi.slice(0, 2);
      const rawPiece = pieceNameAtBoard(beforeBoard, fromUsi);
      const pieceName = KIND_JP[rawPiece] || rawPiece || '';
      return `${full[parseInt(toFile, 10)]}${kanji[toY - 1]}${pieceName}${promote}`;
    }
    // 其他未识别形式，保留 USI
    return usi;
  }

  function scrollMoveListToCurrent() {
    const el = document.getElementById('rvMoveList');
    const cur = el.querySelector('.rv-mv.cursor');
    if (!cur) return;
    if (navFromList) { navFromList = false; return; }
    const target = cur.offsetTop;
    el.scrollTop = Math.max(0, target - el.clientHeight / 2 + cur.clientHeight / 2);
  }

  function isBookmarked(no) { return (review.bookmarks || []).includes(no); }
  // §L3：comments 已升级为数组形态（旧字符串由服务端 normalizeComments 兼容）
  function commentsAt(no) { return (review.comments && review.comments[no]) || []; }
  function hasComment(no) { return commentsAt(no).length > 0; }
  function hasVariation(no) { return !!(review.variations && review.variations[no] && review.variations[no].length); }

  function renderAnnotations() {
    const no = cursor;
    document.getElementById('btnBookmark').classList.toggle('active', isBookmarked(no));
    document.getElementById('btnComment').classList.toggle('active', hasComment(no));
    document.getElementById('rvHasVariation').style.display = hasVariation(no) ? 'block' : 'none';
    // 评论展示
    const cm = document.getElementById('rvComments');
    const cmInput = document.getElementById('rvCommentInput');
    // 编辑态才回填内容；新增态保持为空（comments 现在是数组，不能当字符串用）
    if (cm.style.display !== 'none' && editingCommentId) {
      const hit = commentsAt(no).find((c) => c.id === editingCommentId);
      cmInput.value = hit ? hit.text : '';
    }
  }

  function renderVariations() {
    const el = document.getElementById('rvVariations');
    const list = (review.variations || {})[cursor] || [];
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div style="font-size:12px;color:var(--text-dim);">变着（仅供参考，不影响主棋谱）：</div>` +
      list.map((v) => `<div style="font-size:13px;margin-top:4px;padding:6px 10px;background:var(--bg-3);border-radius:6px;">↪ ${esc(formatMove(v.move))} <span style="color:var(--text-dim);font-size:11px;">(${esc(v.move)})</span></div>`).join('');
  }

  // ---- 操作 ----
  document.getElementById('btnFirst').addEventListener('click', () => { cursor = 0; render(); });
  document.getElementById('btnPrev').addEventListener('click', () => { if (cursor > 0) { cursor--; render(); } });
  document.getElementById('btnNext').addEventListener('click', () => { if (cursor < review.moves.length) { cursor++; render(); } });
  document.getElementById('btnLast').addEventListener('click', () => { cursor = review.moves.length; render(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') { if (cursor > 0) { cursor--; render(); } }
    else if (e.key === 'ArrowRight') { if (cursor < review.moves.length) { cursor++; render(); } }
    else if (e.key === 'Home') { cursor = 0; render(); }
    else if (e.key === 'End') { cursor = review.moves.length; render(); }
  });

  document.getElementById('rvDisplayMode').addEventListener('change', (e) => {
    displayMode = e.target.value;
    renderMoveList();
  });

  // 书签
  document.getElementById('btnBookmark').addEventListener('click', async () => {
    if (!cursor) return toast('初始局面无法加书签');
    const on = !isBookmarked(cursor);
    const r = await fetch(`/api/records/${recordId}/bookmark`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest: guest.id, moveNo: cursor, on }),
    }).then((res) => res.json());
    if (r.ok) {
      review.bookmarks = r.bookmarks;
      render();
      toast(on ? '已加书签' : '已取消书签');
    } else toast(r.error || '操作失败');
  });

  // ---- 评论（§L3）：展示在手数下方，新增/编辑/删除统一走 /api/records/:id/comment ----
  const commentPanel = document.getElementById('rvComments');
  const commentInput = document.getElementById('rvCommentInput');

  /** 打开评论面板：commentId 为空 = 新增 */
  function openCommentPanel(no, commentId = null) {
    if (!no) return toast('初始局面无法评论');
    cursor = no;
    editingCommentId = commentId;
    const hit = commentId ? commentsAt(no).find((c) => c.id === commentId) : null;
    commentInput.value = hit ? hit.text : '';
    commentPanel.style.display = 'block';
    commentPanel.scrollIntoView({ block: 'nearest' });
    commentInput.focus();
    render();
  }

  // 管理员就地编辑 / 删除（手数列表里的按钮）
  window.rvEditComment = (no, cid) => openCommentPanel(no, cid);
  window.rvDeleteComment = async (no, cid) => {
    if (!confirm('删除这条评论？')) return;
    await postComment(no, '', cid);
  };

  document.getElementById('btnComment').addEventListener('click', () => {
    if (!cursor) return toast('初始局面无法评论');
    if (commentPanel.style.display === 'block' && !editingCommentId) {
      commentPanel.style.display = 'none';
      return;
    }
    openCommentPanel(cursor, null);
  });
  document.getElementById('btnCancelComment').addEventListener('click', () => {
    commentPanel.style.display = 'none';
    editingCommentId = null;
  });

  async function postComment(moveNo, text, commentId = null) {
    const body = { guest: guest.id, moveNo, text };
    if (commentId) body.commentId = commentId;
    try {
      const r = await fetch(`/api/records/${recordId}/comment`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
      }).then((res) => res.json());
      if (r.ok) {
        review.comments = r.comments;
        commentPanel.style.display = 'none';
        editingCommentId = null;
        render();
        toast(commentId ? (String(text).trim() ? '评论已更新' : '评论已删除') : '评论已保存');
      } else toast(r.error || '操作失败');
    } catch (_) { toast('网络错误'); }
  }

  document.getElementById('btnSaveComment').addEventListener('click', () => {
    postComment(cursor, commentInput.value, editingCommentId);
  });

  // 变着
  const varPanel = document.getElementById('rvVariationPanel');
  document.getElementById('btnVariation').addEventListener('click', () => {
    if (!cursor) return toast('初始局面无法添加变着');
    varPanel.style.display = varPanel.style.display === 'none' ? 'block' : 'none';
    if (varPanel.style.display === 'block') {
      document.getElementById('rvVariationInput').focus();
    }
  });
  document.getElementById('btnCancelVariation').addEventListener('click', () => { varPanel.style.display = 'none'; });
  document.getElementById('btnSaveVariation').addEventListener('click', async () => {
    const move = document.getElementById('rvVariationInput').value.trim();
    if (!move) return;
    const r = await fetch(`/api/records/${recordId}/variation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest: guest.id, parent: cursor, move }),
    }).then((res) => res.json());
    if (r.ok) {
      review.variations = r.variations;
      varPanel.style.display = 'none';
      document.getElementById('rvVariationInput').value = '';
      render();
      toast('变着已保存');
    } else toast(r.error || '操作失败');
  });

  // ---- 自由摆放（PLAN §G）：本地草稿，不入谱；导航/关闭即丢弃 ----
  function startFreePlace() {
    const pos = positions[cursor];
    if (!pos) return toast('局面尚未加载');
    // §M6：复用同一个 FreeBoard 实例，切模式即可（不再 destroy + new，避免双实例与重复绑定）
    ensureFb();
    fb.setMode('free');
    fb.setInteractive(true);
    fb.startFrom({ board: pos.board, hands: pos.hands || { b: [], w: [] } });
    freeMode = true;
    document.getElementById('btnFreePlace').classList.add('active');
    document.getElementById('btnUndoFree').style.display = 'inline-block';
    toast('自由摆放已开启：移动/驹台放置/双击升变，翻页即丢弃');
  }

  function stopFreePlace() {
    freeMode = false;
    // 回到 review 只读模式（保留实例，翻页继续用）
    if (fb) {
      fb.setMode('review');
      fb.setInteractive(false);
    }
    document.getElementById('btnFreePlace').classList.remove('active');
    document.getElementById('btnUndoFree').style.display = 'none';
    render();
  }

  document.getElementById('btnFreePlace').addEventListener('click', () => {
    if (freeMode) stopFreePlace();
    else startFreePlace();
  });

  function undoFreePlace() {
    if (!freeMode || !fb) return toast('自由摆放未开启');
    if (!fb.undo()) toast('没有可撤销的操作');
  }
  document.getElementById('btnUndoFree')?.addEventListener('click', undoFreePlace);
  document.addEventListener('keydown', (e) => {
    if (!freeMode) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoFreePlace(); }
  });

  // 导出
  function doExport(fmt) {
    const url = `/api/records/${recordId}/export?fmt=${fmt}&guest=${encodeURIComponent(guest.id)}${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`;
    window.location.href = url;
  }
  document.getElementById('btnExportKif').addEventListener('click', () => doExport('kif'));
  document.getElementById('btnExportCsa').addEventListener('click', () => doExport('csa'));

  // §S6：复盘视角翻转（先手 ⇄ 后手）——与对局页观战视角同一套 FreeBoard.setViewpoint
  document.getElementById('btnFlipView').addEventListener('click', () => {
    viewpoint = viewpoint === 'b' ? 'w' : 'b';
    render();
  });

  // 设置变更 → 重渲染棋盘（坐标 §S4 / 图集 §S5，PLAN §S1）
  if (window.Settings) {
    window.Settings.subscribe((all, key) => {
      if (['showCoords', 'atlas'].indexOf(key) < 0) return;
      if (review) render();
    });
  }

  load();
})();
