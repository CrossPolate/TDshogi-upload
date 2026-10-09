/**
 * review.js — 复盘器 View：棋谱回放、书签、评论、本地变着、自由摆放、导出 KIF/CSA
 *
 * 参考参考项目（参考 app.js 复盘分块）：
 *  - 棋谱对子布局（▲/△，先手/後手）
 *  - 日式/USI 切换
 *  - 前进/后退/跳首/跳末 + 当前手滚动居中
 *  - 书签（toggle）
 *  - 评论（写/删）
 *  - 变着（在指定手数下保存备选走法）
 *  - 仅 owner / 管理员可访问（服务端校验）
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回 `<main class="container">…`（原 review.html 的主体，逐字保留）
 *   mount(container, params)→ 绑定事件 / 起异步加载 / 挂全局句柄，句柄记进 this._teardown
 *   unmount()               → 统一清理，切页零泄漏
 *
 * 范式（照 home.js / lobby.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再 `api.connect`（外壳持有唯一 WS；本页纯 REST，不碰 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（本页无整页跳转；导出走 fetch+blob）。
 *   - 所有 setTimeout / document 监听 / Settings 订阅 / 棋盘拖拽观察，统一在 unmount 清理。
 *   - 异步回调返回处做存活判断（局部 alive，unmount 置 false），避免向已销毁 DOM 写入。
 *
 * ⚠️ 棋盘栈（board.js / pieces.js / piece-kinds.js / freeboard.js / freeboard-dnd.js）是
 *    play 与 review **共用的纯库**（window.ShogiBoard / window.FreeBoard / window.PieceKinds …），
 *    保持不动；本页只调用它们的 API，一个字都不改那些文件。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '复盘 · TDShogi',

    render() {
      // —— 原 review.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <!-- 加载中 -->
    <div id="loading" class="card" style="padding:40px;text-align:center;">
      加载棋谱中…
    </div>

    <!-- 无权限/未找到 -->
    <div id="error" class="card" style="padding:40px;text-align:center;display:none;color:var(--red-light);">
      <div id="errorText"></div>
      <button class="btn btn-ghost" style="margin-top:16px;" data-href="profile.html#records">返回棋谱列表</button>
    </div>

    <!-- 复盘器主体 -->
    <div id="review" style="display:none;">
      <!-- 顶部元信息 -->
      <div class="card" style="padding:18px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:18px;font-weight:800;">
              <span id="rvNameB">先手</span>
              <span style="margin:0 10px;color:var(--text-dim);font-weight:400;">vs</span>
              <span id="rvNameW">後手</span>
            </div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">
              <span id="rvResult"></span>
              <span style="margin:0 8px;">·</span>
              <span id="rvMoves"></span>
              <span style="margin:0 8px;">·</span>
              <span id="rvDate"></span>
            </div>
          </div>
          <!-- 按钮组样式在 review.css 的 \`.rv-meta-actions\`（手机端要等分两列，
               所以不能写 inline 的 display/gap——inline 会盖掉媒体查询） -->
          <div class="rv-meta-actions">
            <button class="btn btn-ghost btn-sm" id="btnFlipView" title="切换先手 / 后手视角">🔄 翻转视角</button>
            <button class="btn btn-ghost btn-sm" id="btnExportKif">导出 KIF</button>
            <button class="btn btn-ghost btn-sm" id="btnExportCsa">导出 CSA</button>
            <button class="btn btn-ghost btn-sm" data-href="profile.html#records">返回</button>
          </div>
        </div>
      </div>

      <!-- 管理员：对局信息与展示设置（PLAN §L5） -->
      <div class="card" id="adminPanel" style="padding:18px;margin-bottom:16px;display:none;">
        <h3 style="margin:0 0 12px;font-size:15px;color:var(--gold-light);">🛡️ 管理员：对局信息与展示设置</h3>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;">
          <div><div style="font-size:11px;color:var(--text-dim);">标题</div>
            <input class="input" id="adTitle" maxlength="120" style="width:180px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">赛事</div>
            <input class="input" id="adEvent" maxlength="120" style="width:140px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">轮次</div>
            <input class="input" id="adRound" maxlength="120" style="width:100px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">对局日期</div>
            <input class="input" id="adPlayedOn" maxlength="40" placeholder="2026-09-06" style="width:130px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">标签（逗号分隔）</div>
            <input class="input" id="adTags" style="width:180px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">先手展示名</div>
            <input class="input" id="adNameB" maxlength="120" style="width:130px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">後手展示名</div>
            <input class="input" id="adNameW" maxlength="120" style="width:130px;"></div>
          <div><div style="font-size:11px;color:var(--text-dim);">结果说明</div>
            <input class="input" id="adResultNote" maxlength="120" style="width:150px;"></div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
            <input type="checkbox" id="adFeatured"> 广场置顶
          </label>
        </div>
        <div style="margin-top:10px;">
          <div style="font-size:11px;color:var(--text-dim);">简介</div>
          <textarea class="input" id="adDesc" rows="2" maxlength="200" placeholder="展示在广场卡片上的一句话说明"></textarea>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" id="btnSaveMeta">保存对局信息</button>
          <select class="input" id="adVisibility" style="max-width:160px;">
            <option value="private">私有（仅谱主可见）</option>
            <option value="public">公开（广场可见）</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="btnSaveVisibility">应用可见性</button>
          <span id="adTip" style="font-size:12px;color:var(--text-dim);"></span>
        </div>
      </div>

      <div class="review-layout">
        <!-- 中央棋盘（对战页同款布局：玩家栏 + 棋盘区含持驹） -->
        <div>
          <div class="card" style="padding:18px;">
            <div class="play-main">
              <!-- 上方玩家栏（对面，复盘默认先手视角） -->
              <div class="player-bar" id="topPlayerBar">
                <div>
                  <div class="name" id="topName">—</div>
                  <div class="rating" id="topRating"></div>
                </div>
                <div class="player-clock" id="topClock">—</div>
              </div>
              <div class="board-area">
                <div class="hand-row" id="oppHand">
                  <span class="hand-label">持驹</span>
                  <div class="hand-pieces" id="oppHandPieces"></div>
                </div>
                <div class="board-wrap" id="boardContainer"></div>
                <!-- ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 空容器（真按钮由 review.js
                     动态创建后填充；样式一律 inline，不改 CSS 文件）。仅在自由摆放且棋盘上
                     选中了某格时由 review.js 显示，其余时刻 display:none。 -->
                <div id="freePalette" style="display:none;"></div>
                <div class="hand-row" id="myHand">
                  <span class="hand-label">持驹</span>
                  <div class="hand-pieces" id="myHandPieces"></div>
                </div>
              </div>
              <!-- 下方玩家栏 -->
              <div class="player-bar" id="bottomPlayerBar">
                <div>
                  <div class="name" id="bottomName">—</div>
                  <div class="rating" id="bottomRating"></div>
                </div>
                <div class="player-clock" id="bottomClock">—</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：棋谱 + 操作 -->
        <div class="review-side">
          <!-- 棋谱面板 -->
          <div class="card" style="padding:18px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <h3 style="margin:0;font-size:15px;color:var(--gold-light);">走子记录</h3>
              <div style="display:flex;gap:8px;align-items:center;">
                <label style="font-size:12px;color:var(--text-dim);">显示：</label>
                <select class="select" id="rvDisplayMode" style="font-size:12px;padding:4px 8px;">
                  <option value="jp" selected>日式</option>
                  <option value="usi">USI</option>
                </select>
              </div>
            </div>
            <div class="rv-nav-actions">
              <button class="btn btn-ghost btn-sm" id="btnFirst">⏮ 首手</button>
              <button class="btn btn-ghost btn-sm" id="btnPrev">◀ 上一手</button>
              <button class="btn btn-ghost btn-sm" id="btnNext">下一手 ▶</button>
              <button class="btn btn-ghost btn-sm" id="btnLast">末手 ⏭</button>
              <button class="btn btn-ghost btn-sm" id="btnFreePlace" title="在当前局面上自由摆放棋子（草稿，不入谱）">✋ 自由摆放</button>
              <button class="btn btn-ghost btn-sm" id="btnUndoFree" style="display:none;">↩️ 撤销摆放</button>
            </div>
            <div id="rvMoveList" class="rv-move-list"></div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:8px;text-align:right;" id="rvCursor">0 / 0</div>
          </div>

          <!-- 当前手详情 -->
          <div class="card" style="padding:18px;">
            <h3 style="margin:0 0 10px;font-size:15px;color:var(--gold-light);">当前手</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" id="btnBookmark">🔖 书签</button>
              <button class="btn btn-ghost btn-sm" id="btnComment">💬 评论</button>
              <button class="btn btn-ghost btn-sm" id="btnVariation">↪ 添加变着</button>
            </div>
            <div id="rvVariations" style="margin-top:12px;"></div>
            <div id="rvComments" style="margin-top:14px;display:none;">
              <textarea class="input" id="rvCommentInput" placeholder="评论当前手…" rows="3"></textarea>
              <div style="display:flex;gap:6px;margin-top:6px;">
                <button class="btn btn-primary btn-sm" id="btnSaveComment">保存</button>
                <button class="btn btn-ghost btn-sm" id="btnCancelComment">取消</button>
              </div>
            </div>
            <div id="rvVariationPanel" style="margin-top:14px;display:none;">
              <input class="input" id="rvVariationInput" placeholder="走法 USI，如 7g7f 或 P*5e">
              <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">💾 变着保存在本机浏览器，仅自己可见，不会写入服务器或影响他人。</div>
              <div style="display:flex;gap:6px;margin-top:6px;">
                <button class="btn btn-primary btn-sm" id="btnSaveVariation">保存到本地</button>
                <button class="btn btn-ghost btn-sm" id="btnCancelVariation">取消</button>
              </div>
            </div>
            <div id="rvHasVariation" style="margin-top:8px;font-size:12px;color:var(--text-dim);display:none;">
              本手已存在变着
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>`;
    },

    mount(container, params) {
      this._teardown = [];
      const teardown = this._teardown;  // 副作用句柄统一收集（unmount 逐个清）
      let alive = true;                 // 存活标志（切页竞态防护）：unmount 置 false，
                                        // 异步回调返回处据此放弃写 DOM
      teardown.push(() => { alive = false; });

      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav('profile')（导航由外壳渲染）
      // 棋谱 id / 管理员令牌：优先 router 下发的 params，回退 location.search（原 `?id=` 读取逻辑等价保留）
      const qs = new URLSearchParams(global.location.search);
      const recordId = (params && params.id) || qs.get('id');
      // 管理员访问他人棋谱：携带 adminToken（服务端校验通过则放行）
      const adminToken = (params && params.adminToken) || qs.get('adminToken') || '';
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
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        teardown.push(() => el.removeEventListener(ev, fn));
      };
      // document / window 级监听：必须在 unmount 解绑（SPA 文档不销毁，不解就泄漏到别的页面）
      const onDoc = (ev, fn) => {
        document.addEventListener(ev, fn);
        teardown.push(() => document.removeEventListener(ev, fn));
      };

      if (!recordId) {
        $('loading').style.display = 'none';
        $('error').style.display = 'block';
        $('errorText').textContent = '缺少棋谱 ID';
        return;
      }

      // ---- 棋盘栈调用（纯库 API，保持原样）----
      const board = new window.ShogiBoard($('boardContainer'), { readonly: true });
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
          if (!alive) return;
          if (r.status === 403) throw new Error('只能复盘自己的棋谱');
          if (r.status === 404) throw new Error('棋谱不存在');
          if (!r.ok) throw new Error('加载失败');
          review = await r.json();
          if (!alive) return;
        } catch (e) {
          if (!alive) return;
          $('loading').style.display = 'none';
          $('error').style.display = 'block';
          $('errorText').textContent = e.message;
          return;
        }
        // 加载回放中间局面
        const pb = await fetch(`/api/records/${recordId}/playback?${authQ}`).then((r) => r.json());
        if (!alive) return;
        positions = pb.positions || [];
        cursor = 0;
        render();
        initPermissionUI();
        $('loading').style.display = 'none';
        $('review').style.display = 'block';
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
            my: $('myHandPieces'), myColor: 'b',
            opp: $('oppHandPieces'), oppColor: 'w',
          },
          // ⚠️ 2026-10-02 体验修复：点击棋盘落点跳到该手（此前 onSqClick 从未接线 → 点棋盘毫无反应）
          onSqClick: (sq) => {
            if (freeMode || !review || !sq) return;
            let target = -1;
            (review.moves || []).forEach((usi, i) => {
              const to = /^[PLNSGBR]\*/.test(usi) ? usi.slice(2, 4) : usi.slice(2, 4);
              if (to === sq) target = i + 1;
            });
            if (target > 0) { navFromList = true; navigate(target); }
          },
        });
        fb.attach();
        // 绑定一次驹台拖拽（interactive=false 时不会触发，自由摆放开启后生效）
        fb.bindHands($('myHandPieces'), 'b', $('oppHandPieces'), 'w');
        return fb;
      }

      // 棋盘拖拽的 document 级 pointermove/pointerup 只在拖拽中挂载（freeboard-dnd），
      // 切页时若恰好拖到一半，一并兜底解除 + 移除拖拽幽灵 / 悬停高亮（棋盘相关观察器清理）
      teardown.push(() => {
        try {
          if (fb && fb._docMove) document.removeEventListener('pointermove', fb._docMove);
          if (fb && fb._docUp) document.removeEventListener('pointerup', fb._docUp);
          if (fb && fb._drag && fb._drag.ghost) fb._drag.ghost.remove();
          document.querySelectorAll('.cell.drag-over').forEach((c) => c.classList.remove('drag-over'));
        } catch (_) {}
      });

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
        // ⚠️ 2026-10-03 需求变更（变着＝本地草稿）：变着不再写服务端、任何人都能加，
        // 因此**不再随只读隐藏**（此前隐藏 → 非谱主连入口都看不到，与「可本地添加」相矛盾）。
        // 书签 / 评论 / 自由摆放仍按原权限隐藏。
        ['btnBookmark', 'btnComment', 'btnFreePlace'].forEach((id) => {
          const el = $(id);
          if (el) el.style.display = readonly ? 'none' : '';
        });
        const varBtn = $('btnVariation');
        if (varBtn) varBtn.style.display = ''; // 变着入口任何情况下都可用（本地草稿）
        // ⚠️ 2026-10-02 体验修复：只读时给出明确标识（此前按钮凭空消失，用户分不清"没权限"还是"加载失败"）
        if (readonly) {
          const anchor = $('boardContainer');
          if (anchor && anchor.parentNode && !$('readonlyTag')) {
            const tag = document.createElement('div');
            tag.id = 'readonlyTag';
            tag.style.cssText = 'margin:8px 0;padding:6px 10px;border-radius:8px;background:rgba(201,162,39,0.12);color:var(--gold-light);font-size:12px;';
            tag.textContent = '🔒 只读浏览（非谱主）——可回放 / 导出 / 添加本地变着（仅自己可见），但不能评论或修改棋谱';
            anchor.parentNode.insertBefore(tag, anchor);
          }
        }
        if (isAdmin) {
          const p = $('adminPanel');
          p.style.display = 'block';
          fillAdminForm();
        }
      }

      function fillAdminForm() {
        const m = review.meta || {};
        $('adTitle').value = m.title || '';
        $('adEvent').value = m.event || '';
        $('adRound').value = m.round || '';
        $('adPlayedOn').value = m.playedOn || '';
        $('adTags').value = (m.tags || []).join(', ');
        $('adNameB').value = (m.nameOverrides && m.nameOverrides.b) || '';
        $('adNameW').value = (m.nameOverrides && m.nameOverrides.w) || '';
        $('adResultNote').value = m.resultNote || '';
        $('adDesc').value = m.description || '';
        $('adFeatured').checked = !!m.featured;
        $('adVisibility').value = review.visibility || 'private';
      }

      // 保存对局信息（管理员）
      on($('btnSaveMeta'), 'click', async () => {
        const val = (id) => $(id).value.trim();
        const body = {
          title: val('adTitle'),
          event: val('adEvent'),
          round: val('adRound'),
          playedOn: val('adPlayedOn'),
          tags: val('adTags').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean),
          description: val('adDesc'),
          nameOverrides: { b: val('adNameB'), w: val('adNameW') },
          resultNote: val('adResultNote'),
          featured: $('adFeatured').checked,
        };
        try {
          const r = await fetch(`/api/admin/records/${recordId}/meta`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
          }).then((res) => res.json());
          if (!alive) return;
          if (r.ok) {
            review.meta = r.meta;
            toast('对局信息已保存');
            render();
          } else toast(r.error || '保存失败');
        } catch (_) { if (alive) toast('网络错误'); }
      });

      // 应用可见性（管理员）
      on($('btnSaveVisibility'), 'click', async () => {
        const visibility = $('adVisibility').value;
        try {
          const r = await fetch(`/api/admin/records/${recordId}/visibility`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ visibility }),
          }).then((res) => res.json());
          if (!alive) return;
          if (r.ok) {
            review.visibility = r.visibility;
            $('adTip').textContent = r.visibility === 'public' ? '已公开（广场可见）' : '已设为私有';
            toast(r.visibility === 'public' ? '已公开到棋谱广场' : '已设为私有');
            initPermissionUI();
            render();
          } else {
            $('adTip').textContent = r.error || '操作失败';
          }
        } catch (_) { if (alive) toast('网络错误'); }
      });

      // 对局结果文案（PLAN §M5）：实现统一在 util.js，此处只转发
      // （原先与 history.js 各有一份，加新结果说明时很容易只改一边）
      function resultText(r) { return UI.resultText(r); }

      // 评论「编辑 / 删除」按钮：从 inline onclick 改为 `data-act` 委托（2026-09-23，审查项 13f）。
      // 这两个值（手数 + 评论 id）原先被拼进 `onclick="rvEditComment(3, 'abc')"` 里 ——
      // 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态。现在值为**属性文本**，逃不出属性。
      // SPA：`UI.onAction('cm-edit'/'cm-del')` 的委托注册在文件末尾（模块级只注册一次），
      // 统一派发进 `window.Views.review._handlers`（mount 挂、unmount 置空）——
      // 原 `window.rvEditComment / window.rvDeleteComment` 收敛进该命名空间，离开页面后旧句柄不再被误调用。

      /**
       * 跳到第 n 手（翻页 / 跳首尾 / 键盘 / 列表与棋盘点击统一走这里）。
       * ⚠️ 审查 P3：自由摆放（freeMode）下翻页此前直接 `cursor = n; render()`，而 render() 在
       * freeMode 分支里只 `fb.render()` 保持草稿 → 既不刷新到新局面、也不丢弃改动，与「翻页会
       * 丢弃改动」的提示自相矛盾。这里统一在翻页前退出自由摆放（stopFreePlace 会重渲染回只读
       * 局面），使行为与文案一致。
       */
      function navigate(n) {
        if (freeMode) stopFreePlace();
        cursor = n;
        render();
      }

      function render() {
        if (!alive) return; // 切页竞态防护：unmount 后不再写 DOM
        // ⚠️ 2026-10-02 体验修复：翻页/任意重绘都会把棋盘复位到当前手，此前的「变着预览」随之中止——
        // 这里统一清掉预览标记，避免变着列表里的「退出预览」按钮与现实不一致。
        varPreview = null;
        // 顶部元信息（§L：管理员可为展示覆盖双方名/结果说明，与广场卡片保持一致）
        const ov = (review.meta && review.meta.nameOverrides) || null;
        $('rvNameB').textContent = (ov && ov.b) || (review.names || ['先手'])[0];
        $('rvNameW').textContent = (ov && ov.w) || (review.names || ['先手', '後手'])[1];
        const title = (review.meta && review.meta.title) || '';
        const extra = [(review.meta && review.meta.event) || '', (review.meta && review.meta.round) || ''].filter(Boolean).join(' ');
        $('rvResult').textContent = [resultText(review), (review.meta && review.meta.resultNote) ? `（${review.meta.resultNote}）` : ''].filter(Boolean).join('');
        $('rvMoves').textContent = `${review.moves.length} 手`;
        $('rvDate').textContent = [extra, global.I18N.fmt(review.createdAt)].filter(Boolean).join(' · ');
        document.title = title ? `${title} · 复盘 · TDShogi` : '复盘 · TDShogi';
        $('rvCursor').textContent = `${cursor} / ${review.moves.length}`;

        // 玩家栏：按当前视角排布（上方=对面、下方=自己）——PLAN §S6 复盘支持翻转
        // §F3 悬停信息卡：**必须设置 data-player-id**（reviewData 已返回 playerIds）。
        // 此前只设了 textContent，复盘页的悬停卡从未生效——与对局页「重进看不到 id」是两个独立缺陷。
        const names = review.names || ['先手', '後手'];
        const pids = review.playerIds || {};
        const topIdx = viewpoint === 'b' ? 1 : 0;     // 先手视角：上方 = 后手
        const bottomIdx = viewpoint === 'b' ? 0 : 1;  // 先手视角：下方 = 先手
        $('topName').textContent = names[topIdx] || (topIdx === 0 ? '先手' : '後手');
        $('topName').setAttribute('data-player-id', (topIdx === 0 ? pids.b : pids.w) || '');
        $('topRating').textContent = '';
        $('bottomName').textContent = names[bottomIdx] || (bottomIdx === 0 ? '先手' : '後手');
        $('bottomName').setAttribute('data-player-id', (bottomIdx === 0 ? pids.b : pids.w) || '');
        $('bottomRating').textContent = '';
        $('topClock').textContent = '';
        $('bottomClock').textContent = '';

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
        const el = $('rvMoveList');
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
            navigate(no);
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
        const el = $('rvMoveList');
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
      // ---- 变着：本地草稿（需求 A，2026-10-03）----
      // 变着不再写服务端：`POST /api/records/:id/variation` 只允许「谱主/管理员」，普通浏览者必 403
      //（这正是此前「保存不了、只能本地看」的根因）。按需求改为**纯本地草稿**——存在本浏览器，
      // 刷新/重进仍在，别人看不到，也不影响主棋谱或服务器数据。
      // 存储：localStorage['tdshogi_variations'] = { [recordId]: { [parent手数]: [{ move }] } }
      const VARIATION_LS_KEY = 'tdshogi_variations';

      /** 读某手数的本地草稿（每次现读，避免与其他标签/页面不同步） */
      function localVariations(no) {
        try {
          const all = JSON.parse(localStorage.getItem(VARIATION_LS_KEY) || '{}') || {};
          const mine = (all[recordId] && all[recordId][no]) || [];
          return Array.isArray(mine) ? mine.filter((v) => v && typeof v.move === 'string') : [];
        } catch (_) { return []; }
      }

      /** 写回某手数的本地草稿；空数组则顺手清理，避免残留空记录。返回是否写入成功。 */
      function writeLocalVariations(no, list) {
        try {
          const all = JSON.parse(localStorage.getItem(VARIATION_LS_KEY) || '{}') || {};
          const mine = all[recordId] || {};
          if (list.length) mine[no] = list;
          else delete mine[no];
          if (Object.keys(mine).length) all[recordId] = mine;
          else delete all[recordId];
          localStorage.setItem(VARIATION_LS_KEY, JSON.stringify(all));
          return true;
        } catch (_) { return false; } // 隐私模式 / 存储被禁用
      }

      /**
       * 合并展示：服务端已有变着（谱主/管理员保存的，只读）+ 本地草稿（可删除）。
       * 同一手数同一步以本地为准（本地项标记为可删）。
       */
      function variationsFor(no) {
        const srv = ((review.variations || {})[no] || []).map((v) => ({ move: v.move, local: false }));
        const loc = localVariations(no).map((v) => ({ move: v.move, local: true }));
        const localMoves = new Set(loc.map((v) => v.move));
        return srv.filter((v) => !localMoves.has(v.move)).concat(loc);
      }

      function hasVariation(no) { return variationsFor(no).length > 0; }

      function renderAnnotations() {
        const no = cursor;
        $('btnBookmark').classList.toggle('active', isBookmarked(no));
        $('btnComment').classList.toggle('active', hasComment(no));
        $('rvHasVariation').style.display = hasVariation(no) ? 'block' : 'none';
        // 评论展示
        const cm = $('rvComments');
        const cmInput = $('rvCommentInput');
        // 编辑态才回填内容；新增态保持为空（comments 现在是数组，不能当字符串用）
        if (cm.style.display !== 'none' && editingCommentId) {
          const hit = commentsAt(no).find((c) => c.id === editingCommentId);
          cmInput.value = hit ? hit.text : '';
        }
      }

      // 变着预览状态：{ parent, usi } | null —— 本地试走，不入谱、不写回服务端
      let varPreview = null;

      /**
       * 变着列表（含交互）。
       *
       * ⚠️ 2026-10-02 体验修复：变着此前**只能看、不能用**，补上「载入」试走与「退出预览」。
       * ⚠️ 2026-10-03 需求变更（本地草稿）：变着一律存本机浏览器——所有人都能加（不再受
       *    服务端「仅谱主/管理员」限制），本地项可删除；服务端已有的变着照常只读展示。
       */
      function renderVariations() {
        const el = $('rvVariations');
        const list = variationsFor(cursor);
        if (!list.length) { el.innerHTML = ''; return; }
        const rows = list.map((v, i) => {
          const on = !!(varPreview && varPreview.parent === cursor && varPreview.usi === v.move);
          const badge = v.local
            ? '<span style="color:var(--gold-light);font-size:11px;" title="保存在本机浏览器，仅自己可见，不入服务器">💾 本地</span>'
            : '';
          const del = v.local ? `<button class="btn btn-ghost btn-sm" data-var-del="${i}" title="删除这条本地变着">🗑</button>` : '';
          return `<div style="font-size:13px;margin-top:4px;padding:6px 10px;background:var(--bg-3);border-radius:6px;display:flex;align-items:center;gap:8px;">
        <span style="flex:1;">↪ ${esc(formatMove(v.move))} <span style="color:var(--text-dim);font-size:11px;">(${esc(v.move)})</span> ${badge}</span>
        <button class="btn btn-ghost btn-sm" data-var-idx="${i}">${on ? '✕ 退出预览' : '▶ 载入'}</button>
        ${del}
      </div>`;
        });
        el.innerHTML = `<div style="font-size:12px;color:var(--text-dim);">变着（参考，不影响主棋谱；「载入」为本地试走；💾 本地项保存在本机、仅自己可见）：</div>` + rows.join('');
        // 交互用委托之外的直接绑定：列表每次重建，绑在节点上不会泄漏（与 .rv-mv 同一做法）
        el.querySelectorAll('[data-var-idx]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const v = list[Number(btn.getAttribute('data-var-idx'))];
            if (!v) return;
            const on = !!(varPreview && varPreview.parent === cursor && varPreview.usi === v.move);
            if (on) clearVariationPreview();
            else loadVariation(cursor, v.move);
          });
        });
        el.querySelectorAll('[data-var-del]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const v = list[Number(btn.getAttribute('data-var-del'))];
            if (!v || !v.local) return;
            const rest = localVariations(cursor).filter((x) => x.move !== v.move);
            if (!writeLocalVariations(cursor, rest)) return toast('无法写入本地存储（浏览器隐私模式？）');
            if (varPreview && varPreview.usi === v.move) varPreview = null;
            render();
            toast('已删除本地变着');
          });
        });
      }

      /** 载入某变着到棋盘做本地试走（把变着走法应用到 parent 手后的局面，不改主谱） */
      function loadVariation(parent, usi) {
        const base = positions[parent];
        if (!base) return toast('局面尚未加载，无法载入变着');
        ensureFb();
        const model = {
          board: JSON.parse(JSON.stringify(base.board)),
          hands: JSON.parse(JSON.stringify(base.hands || { b: [], w: [] })),
        };
        const color = parent % 2 === 0 ? 'b' : 'w'; // positions[k] 之后轮到的一方
        try {
          window.FreeBoard.applyUsiOnModel(model, usi, color);
        } catch (_) {
          return toast('该变着无法应用到当前局面（走法或局面不匹配）');
        }
        const to = /^[PLNSGBR]\*/.test(usi) ? usi.slice(2) : usi.slice(2, 4);
        fb.setViewpoint(viewpoint);
        fb.setModel(model, to);
        varPreview = { parent, usi };
        renderVariations();
        toast('已载入变着（本地预览，未写回棋谱）');
      }

      /** 退出变着预览：棋盘回到当前手（render() 会清 varPreview） */
      function clearVariationPreview() {
        varPreview = null;
        render();
        toast('已退出变着预览');
      }

      // ---- 操作 ----
      // ⚠️ 2026-10-02 审查 P3：review 初始为 null、load() 异步——加载完成前按键/点击读 review.moves 会 TypeError。
      on($('btnFirst'), 'click', () => { if (!review) return; navigate(0); });
      on($('btnPrev'), 'click', () => { if (!review) return; if (cursor > 0) navigate(cursor - 1); });
      on($('btnNext'), 'click', () => { if (!review) return; if (cursor < review.moves.length) navigate(cursor + 1); });
      on($('btnLast'), 'click', () => { if (!review) return; navigate(review.moves.length); });
      onDoc('keydown', (e) => {
        if (!review) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft') { if (cursor > 0) navigate(cursor - 1); }
        else if (e.key === 'ArrowRight') { if (cursor < review.moves.length) navigate(cursor + 1); }
        else if (e.key === 'Home') navigate(0);
        else if (e.key === 'End') navigate(review.moves.length);
      });

      on($('rvDisplayMode'), 'change', (e) => {
        displayMode = e.target.value;
        renderMoveList();
      });

      // 书签
      on($('btnBookmark'), 'click', async () => {
        if (!cursor) return toast('初始局面无法加书签');
        const onBm = !isBookmarked(cursor);
        const r = await fetch(`/api/records/${recordId}/bookmark`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guest: guest.id, moveNo: cursor, on: onBm }),
        }).then((res) => res.json());
        if (!alive) return;
        if (r.ok) {
          review.bookmarks = r.bookmarks;
          render();
          toast(onBm ? '已加书签' : '已取消书签');
        } else toast(r.error || '操作失败');
      });

      // ---- 评论（§L3）：展示在手数下方，新增/编辑/删除统一走 /api/records/:id/comment ----
      const commentPanel = $('rvComments');
      const commentInput = $('rvCommentInput');

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

      // 管理员就地编辑 / 删除（手数列表里的按钮）——句柄挂 Views.review._handlers（见文件末尾 onAction 派发）

      on($('btnComment'), 'click', () => {
        if (!cursor) return toast('初始局面无法评论');
        if (commentPanel.style.display === 'block' && !editingCommentId) {
          commentPanel.style.display = 'none';
          return;
        }
        openCommentPanel(cursor, null);
      });
      on($('btnCancelComment'), 'click', () => {
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
          if (!alive) return;
          if (r.ok) {
            review.comments = r.comments;
            commentPanel.style.display = 'none';
            editingCommentId = null;
            render();
            toast(commentId ? (String(text).trim() ? '评论已更新' : '评论已删除') : '评论已保存');
          } else toast(r.error || '操作失败');
        } catch (_) { if (alive) toast('网络错误'); }
      }

      on($('btnSaveComment'), 'click', () => {
        postComment(cursor, commentInput.value, editingCommentId);
      });

      // 变着
      const varPanel = $('rvVariationPanel');
      on($('btnVariation'), 'click', () => {
        if (!cursor) return toast('初始局面无法添加变着');
        varPanel.style.display = varPanel.style.display === 'none' ? 'block' : 'none';
        if (varPanel.style.display === 'block') {
          $('rvVariationInput').focus();
        }
      });
      on($('btnCancelVariation'), 'click', () => { varPanel.style.display = 'none'; });
      // ⚠️ 2026-10-02 体验修复：变着此前**不做任何前端校验**——写错要等服务端回一句「变着走法非法」。
      // 这里沿用服务端同一正则（`src/records.js` addVariation）先做本地校验并给中文提示。
      // ⚠️ 2026-10-03 需求变更（本地草稿）：保存**不再发请求**（`POST .../variation` 仅谱主/管理员，
      // 非谱主必 403 → 这就是「保存不了」的根因），改为写入本机 localStorage，仅自己可见。
      const VARIATION_USI = /^([1-9][a-i])([1-9][a-i])\+?$|^[PLNSGBR]\*[1-9][a-i]$/;
      on($('btnSaveVariation'), 'click', () => {
        const input = $('rvVariationInput');
        const move = input.value.trim();
        if (!move) return toast('请输入变着走法（USI）');
        if (!cursor) return toast('初始局面无法添加变着');
        if (!VARIATION_USI.test(move)) {
          return toast('走法格式不正确：应为 USI，如 7g7f、7g7f+（升变）或 P*5e（打子）');
        }
        const cur = localVariations(cursor);
        if (cur.some((v) => v.move === move)
          || ((review.variations || {})[cursor] || []).some((v) => v.move === move)) {
          return toast('该变着已存在，无需重复添加');
        }
        if (!writeLocalVariations(cursor, cur.concat([{ move }]))) {
          return toast('无法写入本地存储（浏览器隐私模式？）');
        }
        varPanel.style.display = 'none';
        input.value = '';
        render();
        toast('已保存到本地（仅本机可见，不影响他人与服务器）');
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
        $('btnFreePlace').classList.add('active');
        $('btnUndoFree').style.display = 'inline-block';
        toast('自由摆放已开启：可移动棋子 / 从驹台放入 / 双击升变；再次点击「自由摆放」退出（翻页会丢弃改动）');
      }

      function stopFreePlace() {
        freeMode = false;
        // 回到 review 只读模式（保留实例，翻页继续用）
        if (fb) {
          fb.setMode('review');
          fb.setInteractive(false);
        }
        $('btnFreePlace').classList.remove('active');
        $('btnUndoFree').style.display = 'none';
        render();
      }

      on($('btnFreePlace'), 'click', () => {
        if (freeMode) stopFreePlace();
        else startFreePlace();
      });

      function undoFreePlace() {
        if (!freeMode || !fb) return toast('自由摆放未开启');
        if (!fb.undo()) toast('没有可撤销的操作');
      }
      on($('btnUndoFree'), 'click', undoFreePlace);
      onDoc('keydown', (e) => {
        if (!freeMode) return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoFreePlace(); }
      });

      // ==================================================================
      // ⚠️ 2026-10-04 新功能：自由摆放棋子编辑面板 —— 面板逻辑与插入点
      // ------------------------------------------------------------------
      // 规格：自由摆放（freeMode）下单击选中棋盘一格后，在棋盘下方（#boardContainer
      // 之后，即 review.html 里的 #freePalette 空容器）显示面板，提供
      //   ① 棋种选择（基本 8 种 / 成駒 6 种）→ 就地替换该格棋种
      //   ② 成 / 不成 切换（等价于原双击升变，只是多了一个显式按钮）
      //   ③ 翻转归属（先手 ⇄ 后手）——**真的改数据**：free 模型 cell 本就有 color 字段，
      //      board.js 渲染时按 piece.color 决定棋子朝向，翻转后视觉朝向随之改变；
      //      若模型无法表达归属才该禁用此按钮，本仓库并不属于那种情况。
      //   ④ 清空该格 / 关闭面板（Esc 亦可）
      // 写入一律经 FreeBoard.getSquare / setSquare（复用 _pushHistory + _afterOp，
      // 故 Ctrl+Z 同样能回退面板的编辑）；仍遵守自由摆放原语义：不入谱，
      // 翻页 / 退出自由摆放时由 render() 重装局面丢弃。
      // 按钮全部是真 <button>（Tab 可达、Enter/空格触发），样式全 inline（禁止改 CSS）。
      // ==================================================================
      const PALETTE_BASE = ['歩', '香', '桂', '銀', '金', '角', '飛', '玉'];
      const PALETTE_PROMO = ['と', '杏', '圭', '全', '馬', '龍'];
      const PK = window.PieceKinds || {}; // 棋种映射的单一来源（promoteOf / DEMOTE / isPromoted）
      let paletteSq = null;               // 面板当前作用的格名（跟随 fb.selectedSq）

      /** 面板宿主：优先用 review.html 的 #freePalette，缺失时兜底动态插到 #boardContainer 之后 */
      function paletteHost() {
        let host = $('freePalette');
        if (host) return host;
        const bc = $('boardContainer');
        if (!bc || !bc.parentNode) return null;
        host = document.createElement('div');
        host.id = 'freePalette';
        bc.parentNode.insertBefore(host, bc.nextSibling);
        return host;
      }

      /** 面板当前是否可见（Esc 用它判断这次按键要不要处理） */
      function paletteVisible() {
        const host = $('freePalette');
        return !!host && host.style.display !== 'none';
      }

      /** 创建面板骨架：幂等（按钮只建一次，之后靠 refreshPalette 改状态） */
      function buildPalette() {
        const host = paletteHost();
        if (!host || host.dataset.fpBuilt === '1') return host;
        host.dataset.fpBuilt = '1';
        host.style.cssText = 'display:none;margin-top:10px;padding:10px 12px;'
          + 'border:1px solid var(--border, #3a3f47);border-radius:10px;'
          + 'background:rgba(255,255,255,0.03);font-size:13px;';

        const mkRow = () => {
          const d = document.createElement('div');
          d.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;';
          return d;
        };
        const mkLabel = (text) => {
          const s = document.createElement('span');
          s.textContent = text;
          s.style.cssText = 'font-size:12px;color:var(--text-dim, #999);';
          return s;
        };
        const mkBtn = (label, title) => {
          const b = document.createElement('button');
          b.type = 'button'; // 真按钮：可 Tab 聚焦、Enter/空格触发
          b.className = 'btn btn-ghost btn-sm';
          b.textContent = label;
          b.style.minWidth = '38px';
          if (title) b.title = title;
          return b;
        };

        // 标题行：作用格 + 当前棋子状态（翻归属 / 升变后立刻反馈）
        const head = mkRow();
        const headTxt = mkLabel('');
        headTxt.id = 'fpHead';
        headTxt.style.cssText = 'font-weight:700;font-size:13px;color:var(--gold-light, #e0c46c);';
        head.appendChild(headTxt);
        const closeBtn = mkBtn('✕ 关闭', '关闭面板（Esc 亦可）');
        closeBtn.id = 'fpClose';
        closeBtn.style.marginLeft = 'auto';
        closeBtn.addEventListener('click', () => hidePalette());
        head.appendChild(closeBtn);
        host.appendChild(head);

        // 棋种行（上）：基本 8 种
        const rowBase = mkRow();
        rowBase.style.marginTop = '8px';
        rowBase.appendChild(mkLabel('基本：'));
        PALETTE_BASE.forEach((name) => {
          const b = mkBtn(name, `替换为「${name}」（保留原归属与成 / 不成）`);
          b.dataset.piece = name;
          b.addEventListener('click', () => applyPieceSel(name));
          rowBase.appendChild(b);
        });
        host.appendChild(rowBase);

        // 棋种行（下）：成駒 6 种
        const rowPromo = mkRow();
        rowPromo.style.marginTop = '6px';
        rowPromo.appendChild(mkLabel('成駒：'));
        PALETTE_PROMO.forEach((name) => {
          const b = mkBtn(name, `替换为「${name}」（保留原归属）`);
          b.dataset.piece = name;
          b.addEventListener('click', () => applyPieceSel(name));
          rowPromo.appendChild(b);
        });
        host.appendChild(rowPromo);

        // 操作行：成 / 不成 · 翻转归属 · 清空该格
        const rowOps = mkRow();
        rowOps.style.marginTop = '10px';
        const tgBtn = mkBtn('成 / 不成', '切换该格棋子的升变状态（金、玉不可成）');
        tgBtn.id = 'fpPromote';
        tgBtn.addEventListener('click', togglePromoteSel);
        rowOps.appendChild(tgBtn);
        const flipBtn = mkBtn('翻转（先手↔后手）', '把该格棋子的所属方取反，棋子朝向随之翻转');
        flipBtn.id = 'fpFlip';
        flipBtn.addEventListener('click', flipOwnerSel);
        rowOps.appendChild(flipBtn);
        const clrBtn = mkBtn('清空该格', '移除该格棋子（可继续用上方棋种按钮放新子）');
        clrBtn.id = 'fpClear';
        clrBtn.addEventListener('click', clearSquareSel);
        rowOps.appendChild(clrBtn);
        host.appendChild(rowOps);

        const hint = mkLabel('自由摆放是本地草稿，不入谱；翻页 / 退出自由摆放即丢弃。');
        hint.style.cssText = 'display:block;margin-top:8px;font-size:11px;color:var(--text-dim, #999);';
        host.appendChild(hint);
        return host;
      }

      /** 刷新面板状态：标题（格 / 归属 / 成不成）+ 成不成按钮可用性 + 棋种按钮高亮 */
      function refreshPalette() {
        if (!paletteSq || !fb) return;
        const p = fb.getSquare(paletteSq);
        const host = $('freePalette');
        const head = $('fpHead');
        if (head) {
          head.textContent = (p && p.piece)
            ? `${paletteSq} · ${p.color === 'b' ? '先手 ▲' : '后手 △'} ${p.piece}${p.promoted ? '（成）' : '（不成）'}`
            : `${paletteSq} · 空格（点上方棋种放置；归属默认当前视角方）`;
        }
        const tg = $('fpPromote');
        if (tg) {
          tg.disabled = !(p && p.piece);
          tg.style.opacity = tg.disabled ? '0.5' : '';
        }
        if (host && host.querySelectorAll) {
          host.querySelectorAll('button[data-piece]').forEach((b) => {
            b.style.outline = (p && p.piece && p.piece === b.dataset.piece) ? '2px solid var(--gold, #c9a227)' : '';
          });
        }
      }

      /** 显示面板并绑定作用格 */
      function showPalette(sq) {
        const host = buildPalette();
        if (!host || !sq) return;
        paletteSq = sq;
        host.style.display = 'block';
        refreshPalette();
      }

      /** 隐藏面板（不动棋盘选中态） */
      function hidePalette() {
        const host = $('freePalette');
        paletteSq = null;
        if (host) host.style.display = 'none';
      }

      /**
       * 显隐同步：只有「自由摆放中 + 棋盘上选中了某格」才显示。两个触发源覆盖全部路径：
       *   1) 棋盘点击 / 键盘 Enter 选格 → freeboard-dnd 的 _activateSq 回执 fb.onSqSelect；
       *   2) 页面其它点击（点驹台、点棋盘空白、点工具按钮）→ 本监听（冒泡在 freeboard 的
       *      处理器之后，读到的 fb.selectedSq 已是最终值）。
       */
      function syncPalette() {
        if (fb && fb.onSqSelect !== syncPalette) fb.onSqSelect = syncPalette; // 幂等接线
        if (!freeMode || !fb || !fb.selectedSq) { hidePalette(); return; }
        showPalette(fb.selectedSq);
      }
      onDoc('click', syncPalette);

      /** 棋种按钮：就地替换该格棋种（保留原归属）；空格则以当前视角方归属放一枚 */
      function applyPieceSel(name) {
        if (!freeMode || !fb || !paletteSq) return;
        const cur = fb.getSquare(paletteSq);
        const promoted = typeof PK.isPromoted === 'function'
          ? PK.isPromoted(name)
          : /^(と|成香|杏|成桂|圭|成銀|全|馬|龍)$/.test(name);
        fb.setSquare(paletteSq, {
          piece: name,
          color: (cur && cur.color) ? cur.color : viewpoint, // 空格：归属取当前视角方
          promoted,
        });
        refreshPalette();
      }

      /** 成 / 不成：复用 freeboard.togglePromote（与双击升变同一条路径，归属不变） */
      function togglePromoteSel() {
        if (!freeMode || !fb || !paletteSq) return;
        const p = fb.getSquare(paletteSq);
        if (!p || !p.piece) return toast('该格没有棋子，无法升变');
        // 可成判定：未成駒查 PROMOTE，成駒查 DEMOTE；金 / 玉两边都查不到 → 不可成
        const can = !!((PK.promoteOf && PK.promoteOf(p.piece)) || (PK.DEMOTE && PK.DEMOTE[p.piece]));
        if (!can) return toast(`「${p.piece}」不能升变 / 降级（金、玉没有成駒形态）`);
        fb.togglePromote(paletteSq);
        refreshPalette();
      }

      /** 翻转归属：真的把模型里的 color 取反（先手 ⇄ 后手），重绘后朝向随之翻转 */
      function flipOwnerSel() {
        if (!freeMode || !fb || !paletteSq) return;
        const p = fb.getSquare(paletteSq);
        if (!p || !p.piece) return toast('该格没有棋子，无法翻转归属');
        const next = p.color === 'b' ? 'w' : 'b';
        fb.setSquare(paletteSq, { piece: p.piece, color: next, promoted: p.promoted });
        refreshPalette();
        toast(`已翻转归属：${next === 'b' ? '先手 ▲' : '后手 △'}`);
      }

      /** 清空该格（面板保留，紧接着可用棋种按钮放新子） */
      function clearSquareSel() {
        if (!freeMode || !fb || !paletteSq) return;
        if (!fb.getSquare(paletteSq)) return toast('该格已是空格');
        fb.setSquare(paletteSq, null);
        refreshPalette();
      }

      // Esc 关闭面板（沿用页面「Esc 取消」的习惯，同时清掉棋盘上的选中态）
      onDoc('keydown', (e) => {
        if (e.key !== 'Escape' || !paletteVisible()) return;
        if (freeMode && fb && fb.clearSelection) fb.clearSelection();
        hidePalette();
      });

      // 导出棋谱（KIF / CSA）
      //
      // ⚠️ 2026-10-02 体验修复：此前直接 `window.location.href = url`——失败时（403 无权 / 404 不存在）
      // 浏览器会整页跳到一段 JSON 上，既没有下载、也没有任何提示。改为 fetch 取 blob 再触发下载：
      //   1) 失败时能读服务端 `{ error }` 用 toast 说明（不是无声无息或跳走）；
      //   2) 文件名优先用服务端 Content-Disposition 的 `filename*`（"先手_后手_日期.kif"，RFC 5987），
      //      拿不到再退回本地拼的默认名，保证「另存为」有可读文件名。
      async function doExport(fmt) {
        const q = `fmt=${fmt}&guest=${encodeURIComponent(guest.id)}${adminToken ? `&token=${encodeURIComponent(adminToken)}` : ''}`;
        try {
          const res = await fetch(`/api/records/${recordId}/export?${q}`);
          if (!alive) return;
          if (!res.ok) {
            let msg = `导出失败（${res.status}）`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
            return toast(msg);
          }
          const blob = await res.blob();
          if (!alive) return;
          let name = `record_${recordId}.${fmt}`;
          const cd = res.headers.get('Content-Disposition') || '';
          const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const mPlain = /filename="?([^";]+)"?/i.exec(cd);
          if (mStar) { try { name = decodeURIComponent(mStar[1]); } catch (_) {} }
          else if (mPlain) name = mPlain[1];
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objUrl;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          const revokeTimer = setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
          teardown.push(() => clearTimeout(revokeTimer)); // 定时器记入 teardown（铁律4）
          toast(`已导出 ${fmt.toUpperCase()}：${name}`);
        } catch (_) {
          if (alive) toast('网络错误，导出失败');
        }
      }
      on($('btnExportKif'), 'click', () => doExport('kif'));
      on($('btnExportCsa'), 'click', () => doExport('csa'));

      // §S6：复盘视角翻转（先手 ⇄ 后手）——与对局页观战视角同一套 FreeBoard.setViewpoint
      on($('btnFlipView'), 'click', () => {
        viewpoint = viewpoint === 'b' ? 'w' : 'b';
        render();
      });

      // 设置变更 → 重渲染棋盘（坐标 §S4；图集 2026-10-08 迁入装扮，走 tdshogi-appearance）
      if (window.Settings) {
        teardown.push(window.Settings.subscribe((all, key) => {
          if (['showCoords', 'highlightLastMove'].indexOf(key) < 0) return;
          if (alive && review) render();
        }));
      }
      const onAppearance = () => { if (alive && review) render(); };
      document.addEventListener('tdshogi-appearance', onAppearance);
      teardown.push(() => document.removeEventListener('tdshogi-appearance', onAppearance));

      // ---- 跨页全局句柄收敛（原 window.rvEditComment / window.rvDeleteComment）----
      // 挂到 window.Views.review._handlers 命名空间：mount 挂载、unmount 置空。
      // 离开复盘页后 _handlers 为 null，cm-edit / cm-del 委托静默忽略，旧句柄不会被误调用。
      this._handlers = {
        rvEditComment: (no, cid) => { if (alive) openCommentPanel(no, cid); },
        rvDeleteComment: async (no, cid) => {
          if (!alive) return;
          if (!confirm('删除这条评论？')) return;
          await postComment(no, '', cid);
        },
      };

      load();
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
      // 旧句柄失效：离开页面后 cm-edit / cm-del 委托不再派发到本页逻辑
      this._handlers = null;
    },
  };

  // 评论「编辑 / 删除」按钮：从 inline onclick 改为 `data-act` 委托（2026-09-23，审查项 13f）。
  // 这两个值（手数 + 评论 id）原先被拼进 `onclick="rvEditComment(3, 'abc')"` 里 ——
  // 那正是 P1-3「单引号逃逸 → 存储型 XSS」的形态。现在值为**属性文本**，逃不出属性。
  // SPA：委托注册在模块级只做一次，处理器经 `Views.review._handlers` 中转——
  // 未挂载 / 已离开复盘页时 _handlers 为空，静默忽略（不误调用、不报错）。
  UI.onAction('cm-edit', (el) => {
    const H = View._handlers;
    if (H && H.rvEditComment) {
      H.rvEditComment(Number(el.getAttribute('data-no')), el.getAttribute('data-id'));
    }
  });
  UI.onAction('cm-del', (el) => {
    const H = View._handlers;
    if (H && H.rvDeleteComment) {
      H.rvDeleteComment(Number(el.getAttribute('data-no')), el.getAttribute('data-id'));
    }
  });

  global.Views.review = View;
})(window);
