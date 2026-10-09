/**
 * play.js — 对局页 View：状态同步 / 走子交互 / 升变 / 棋钟 / 认输 / 再来一局 / 观战 / 感想战
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render(params)          → 返回原 play.html 的主体（<main> + 升变弹层 + 胜负横幅，逐字保留）
 *   mount(container, params)→ 组装棋盘/子模块、订阅 WS、绑事件，句柄记进 this._teardown
 *   confirmLeave()          → ★离开守卫：对局进行中弹确认，取消则阻断导航（router 契约）
 *   unmount()               → 统一清理（含 4 个子模块与 FreeBoard），切页零泄漏
 *
 * 范式（照 home.js / lobby.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）；`api.on('open', enterRoom)` 只管断线重连
 *     后重进房间，mount 时**主动** enterRoom() 一次（WS 可能早已建立，open 不会再触发）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`。
 *   - 所有 setInterval / setTimeout / api.on / Settings 订阅 / document|window 监听 /
 *     棋盘观察器（FreeBoard.destroy），统一在 unmount 清理。
 *
 * 子模块（play-clock / play-chat / play-demo / play-views）：**绝不自启**，由本 View 的
 * mount/unmount 驱动 init/mount ↔ destroy；棋盘栈（board/pieces/piece-kinds/freeboard/
 * freeboard-dnd）是 play 与 review 共用的纯库，一字未改。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  // 时间控制预设（与服务端 TIME_CONTROLS 对应）
  const TIME_CONTROLS = {
    '15+60': { name: '15分钟 + 60秒' },
    '10+30': { name: '10分钟 + 30秒' },
    '10:00': { name: '10分钟包干' },
    '10sec': { name: '10秒快棋' },
  };

  const View = {
    title: '对局 · TDShogi',

    render() {
      // —— 原 play.html 的主体（<header class="nav"> 之后到 </footer> 之前）：逐字保留 ——
      // <main class="container"> + 升变弹层 + 胜负横幅；导航/页脚/toast 由外壳承载。
      return `
  <main class="container">
    <div id="roomTop" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div style="font-size:14px;color:var(--text-dim);">
        <span id="roomCodeLabel"></span>
        <span id="spectatorTag" style="display:none;margin-left:12px;background:var(--bg-3);padding:3px 10px;border-radius:6px;color:var(--gold-light);font-size:12px;">👁 观战中</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" id="btnViewpoint" style="display:none;" title="切换观战视角（先手 / 后手）">🔄 视角·先手</button>
        <button class="btn btn-ghost btn-sm" id="btnSound" title="音效开关">🔊 音效</button>
        <!-- 举报（2026-09-20）：移到顶部交互栏（原先埋在右侧「操作」卡里，要滚动才看得到）。
             只在对局中、对面确实有人时出现；类别清单由服务端在 hello 里下发（src/reports.js）。 -->
        <button class="btn btn-ghost btn-sm" id="btnReport" style="display:none;"
          title="举报对手：作弊 / 辱骂 / 恶意挂机等">🚩 举报</button>
        <!-- ⚠️ 2026-10-02 体验修复：补 tooltip（此前退出对局按钮无任何说明，易与「认输」混淆） -->
        <button class="btn btn-ghost btn-sm" id="btnLeave" title="退出对局并返回大厅（不影响已开始的棋局）">退出对局</button>
      </div>
    </div>

    <div class="play-layout">
      <div class="play-main">
        <!-- 感想战工具条（终局自动进入，PLAN §G v6） -->
        <div id="demoBar" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;margin-bottom:10px;background:var(--bg-2);border:1px solid rgba(201,162,39,0.35);border-radius:10px;">
          <span id="demoStatus" style="font-size:13px;font-weight:700;color:var(--gold-light);">🎤 感想战中</span>
          <span id="turnHint" style="font-size:12px;color:var(--text-dim);"></span>
          <!-- ⚠️ 2026-10-02 体验修复：演示工具条若干按钮补 tooltip（此前只有「撤销」有说明） -->
          <button class="btn btn-primary btn-sm" id="btnDemoClaim" style="display:none;" title="取得演示权：由你按规则走棋演示（不入正式棋谱）">🙋 我来演示</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoTransfer" style="display:none;" title="把演示权交给对方">🤝 交给对方</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoUndo" style="display:none;" title="撤销一手（推演谱为空时回退原谱一手）">↩️ 撤销</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoClear" style="display:none;" title="清空当前推演，回到原谱">🗑 清空推演</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoLatest" style="display:none;" title="跳到推演谱最新一手">⏭ 回到最新</button>
          <button class="btn btn-ghost btn-sm" id="btnDemoRematch" style="display:none;" title="向对手发起再来一局">🔁 再来一局</button>
          <button class="btn btn-ghost btn-sm" id="btnFreeMode" style="display:none;" title="自由摆棋：不校验规则、不入谱，可随意摆放棋子">✋ 自由摆棋</button>
          <span style="font-size:11px;color:var(--text-dim);margin-left:auto;">按规则行棋 · 不计入棋谱</span>
        </div>

        <!-- 上方玩家栏（对面）—— 由 play.js 按视角动态渲染 -->
        <div class="player-bar" id="topPlayerBar">
          <!-- 头像（2026-09-20）：由 play.js 从 state.players[].avatar 填充 -->
          <span class="player-avatar" id="topAvatar"></span>
          <div>
            <div class="name" id="topName">—</div>
            <div class="rating" id="topRating"></div>
          </div>
          <div class="player-clock" id="topClock">10:00</div>
        </div>

        <!-- ⚠️ 2026-10-03 新功能：道具系统骨架 —— 立绘舞台（相对定位容器，供棋盘两侧的立绘绝对定位，不改动现有布局） -->
        <div id="spriteStage" style="position:relative;width:100%;display:flex;justify-content:center;">
        <!-- 棋盘区：左=对手持驹，中=棋盘，右=自己持驹（由 play.js 按视角摆放） -->
        <div class="board-area">
          <div class="hand-row" id="oppHand">
            <span class="hand-label">持驹</span>
            <div class="hand-pieces" id="oppHandPieces"></div>
          </div>
          <div class="board-wrap" id="boardContainer"></div>
          <div class="hand-row" id="myHand">
            <span class="hand-label">持驹</span>
            <div class="hand-pieces" id="myHandPieces"></div>
          </div>
        </div>
        <!-- ⚠️ 2026-10-03 新功能：道具系统骨架 —— 左右立绘（b=先手方 / w=后手方，由 play.js 按视角填充；空则隐藏） -->
        <div id="spriteB" style="position:absolute;left:0;top:50%;transform:translateY(-50%);width:150px;display:none;align-items:center;pointer-events:none;"></div>
        <div id="spriteW" style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:150px;display:none;align-items:center;justify-content:flex-end;pointer-events:none;"></div>
        </div>

        <!-- 下方玩家栏（自己） -->
        <div class="player-bar" id="bottomPlayerBar">
          <span class="player-avatar" id="bottomAvatar"></span>
          <div>
            <div class="name" id="bottomName">—</div>
            <div class="rating" id="bottomRating"></div>
          </div>
          <div class="player-clock" id="bottomClock">10:00</div>
        </div>
      </div>

      <!-- 右侧面板 -->
      <div class="play-side">
        <div class="panel">
          <h3>走子记录</h3>
          <div class="move-list" id="moveList"></div>
        </div>
        <div class="panel">
          <h3>观众（<span id="spectatorCount">0</span>）</h3>
          <div id="spectatorList" style="font-size:13px;min-height:20px;color:var(--text);"><div style="color:var(--text-dim);font-size:12px;">暂无观众</div></div>
        </div>
        <div class="panel">
          <h3>操作</h3>
          <div style="display:flex;flex-direction:column;gap:10px;">
            <!-- ⚠️ 2026-10-02 体验修复：认输 / 再来一局补 tooltip（此前无说明） -->
            <button class="btn btn-danger" id="btnResign" title="认输：本局立即判负并结束">认输</button>
            <button class="btn btn-ghost" id="btnDeclare" style="display:none;"
              title="入玉宣言：玉在敌阵 + 敌阵内 10 枚以上 + 点数先手 28 / 后手 27 以上，且自己手番、未被王手 → 宣言方胜（AJSA 规则）">🏯 入玉宣言</button>
            <button class="btn btn-primary" id="btnRematch" style="display:none;" title="向对手发起再来一局">再来一局</button>
          </div>
          <div id="reportPanel" style="display:none;margin-top:10px;">
            <select class="input" id="reportCategory" style="font-size:12px;padding:5px 8px;"></select>
            <input class="input" id="reportDetail" maxlength="200" placeholder="补充说明（可选）"
              style="margin-top:6px;font-size:12px;padding:5px 8px;">
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button class="btn btn-primary btn-sm" id="btnReportSubmit" title="把举报提交给管理员审核">提交举报</button>
              <button class="btn btn-ghost btn-sm" id="btnReportCancel" title="取消并收起举报表单">取消</button>
            </div>
          </div>
        </div>
        <!-- 聊天：§R2 kibitz 分区（全部 / 对局 / 观战），并按发言者身份配色区分 -->
        <div class="panel">
          <h3>聊天</h3>
          <div class="chat-tabs" id="chatTabs">
            <button class="chat-tab active" data-tab="all">全部</button>
            <button class="chat-tab" data-tab="players">对局</button>
            <button class="chat-tab" data-tab="spectators">观战</button>
          </div>
          <div class="chat-box" id="chatBox"></div>
          <!-- 快捷语（2026-09-20）：高频寒暄点一下直接发，省去对局中打字。
               内容与渲染见 js/play-chat.js 的 QUICK_PHRASES -->
          <div class="chat-quick" id="chatQuick"></div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <input class="input" id="chatInput" placeholder="说点什么…" style="padding:6px 10px;font-size:13px;">
            <button class="btn btn-primary btn-sm" id="btnChatSend" style="flex-shrink:0;">发送</button>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- 升变弹层 -->
  <div class="promote-overlay" id="promoteOverlay" role="dialog" aria-modal="true" aria-label="选择是否升变">
    <div class="promote-box">
      <h3>是否升变？</h3>
      <div class="promote-actions">
        <!-- ⚠️ 2026-10-02 体验修复：「成」放前（成为默认焦点/主按钮），并加「取消」——
             此前「不成」在前导致回车默认选「不成」，且弹层无法取消、误触即强制落子。 -->
        <button class="btn btn-primary btn-lg" id="btnPromote">成</button>
        <button class="btn btn-ghost btn-lg" id="btnNoPromote">不成</button>
      </div>
      <div style="margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="btnPromoteCancel">取消</button>
      </div>
    </div>
  </div>

  <!-- 胜负横幅 -->
  <div class="banner" id="banner">
    <div id="bannerText" style="font-size:28px;font-weight:900;margin-bottom:16px;font-family:var(--font-serif);"></div>
    <div style="display:flex;gap:12px;justify-content:center;">
      <button class="btn btn-primary" id="bannerRematch" title="向对手发起再来一局">再来一局</button>
      <button class="btn btn-ghost" data-act="banner-close">关闭</button>
    </div>
  </div>`;
    },

    mount(container, params) {
      this._teardown = [];
      const teardown = this._teardown;
      const self = this;
      self._forceLeave = false;   // 「退出对局」等已确认离开 → confirmLeave 直接放行
      self._handlers = null;

      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav('play')（导航由外壳渲染）
      const api = global.API;                // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 元素事件统一登记（unmount 一并解绑，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        teardown.push(() => el.removeEventListener(ev, fn));
      };

      // ==================================================================
      // 页面级状态（原 IIFE 闭包变量）
      // ==================================================================
      let state = null;       // 最新对局状态
      let mySeat = null;      // 'b' | 'w' | null（观战）
      let isPlayer = false;
      let selected = null;    // 当前选中的起点（格名或打子符号）
      let targets = [];       // 当前选中起点的合法目标
      let pendingPromote = null; // { usi, nonPromoteUsi, promoteUsi }
      // 棋钟状态与逻辑已抽到 play-clock.js（PLAN §M5）：本时剩余 / 读秒 / tick 都在那边
      // 统一棋盘组件（PLAN §G v6）：play 模式行棋 / 终局切感想战（demo-rules）/ 自由摆棋
      let fb = null;                  // FreeBoard 控制器（棋盘交互与拖拽）
      let spectatorViewpoint = 'b';   // 观战视角（PLAN §R1）：仅观战者生效，可切 'b' / 'w'
      let lastMoveCount = 0;          // 上次已知手数（用于音效触发）
      let lastPieceCount = null;      // 上次棋盘棋子总数（吃子判定）；null = 尚未收到首帧

      // confirmLeave / unmount 在闭包外也要读到这几个关键状态 → 镜像到实例属性
      self._state = null;
      self._isPlayer = false;
      self._fb = null;

      // 感想战的状态（推演谱 / 光标 / 原谱缓存 / 自由摆棋 / 升变待选）已整体搬进
      // **play-demo.js**（PLAN §M5）——包括此前漏写声明、被 eslint 抓出的隐式全局
      // `window.freeMode`：现在它位于模块内部，跨脚本污染的隐患从根上消失。

      /**
       * 重要提示（PLAN §U3）：**弹窗 + 聊天区留痕**。
       *
       * 背景：弹窗 2.5 秒就消失，玩家低头看棋盘就错过了；聊天区能回看。
       * 所以**信息类**提示（对局开始 / 结束、对手请求再来一局、服务端报错）走这里；
       * **断线类**（"此身份已在其他窗口登录"）刻意仍用 `toast` ——
       * 页面都断了，往聊天区写一条没人会看的消息只会误导。
       */
      function notify(msg) {
        toast(msg);
        if (global.PlayChat) global.PlayChat.system(msg);
      }

      // ==================================================================
      // §M5（2026-09-28）：渲染/弹层视图层已拆到 play-views.js
      // ==================================================================
      // ⚠️ 该文件必须在本文件**之前**加载（bundle 顺序，见 scripts/pack.js）。
      // 缺了就当场抛错——否则症状会是"界面不刷新"这种静默故障。
      if (!global.PlayViews) {
        throw new Error('play-views.js 必须在 play.js 之前加载（脚本顺序错了）');
      }
      const board = new global.ShogiBoard($('boardContainer'), {});

      /** 「退出对局」按钮：确认 → 发 leave → 路由回大厅/赛事页（原 btnLeave 内联逻辑搬入）。 */
      function leaveGame() {
        const inGame = isPlayer && state && state.status === 'PLAYING';
        // ⚠️ 2026-10-02 体验修复：对局中「退出对局」会被服务端判「接続切断」负，
        // 此前无任何确认、一点即判负并跳走（认输反有确认）——补一次确认。
        if (inGame && !global.confirm('退出将对局判负（相当于认输），确定退出吗？')) return;
        self._forceLeave = true; // 已确认过 → 放行 confirmLeave，避免离开守卫二次弹窗
        api.send({ type: 'leave' });
        // 赛事对局退出回赛事页，其余回大厅（铁律3：整页跳转改路由）
        global.Router.navigate((state && state.roomType === 'tournament') ? 'tournaments.html' : 'lobby.html');
      }

      const views = global.PlayViews.make({
        $, toast, api, guest, TIME_CONTROLS, ensureBoard, onSelectPiece, leaveGame,
        // ⚠️ 必须是 **getter**：这些是会在对局中被重新赋值的 `let`，
        // 按值捕获会让视图层永远停在初始值（症状：切了视角棋盘不翻、换座位后按钮不变）。
        ctx: {
          get state() { return state; },
          get mySeat() { return mySeat; },
          get isPlayer() { return isPlayer; },
          get fb() { return fb; },
          get spectatorViewpoint() { return spectatorViewpoint; },
          // ⚠️ 写回也必须走 ctx：视图层里的 `ctx.spectatorViewpoint = ...`（切观战视角）
          // 若没有 setter，在 'use strict' 下会直接抛 TypeError —— 那是一个"点了没反应"的静默故障。
          set spectatorViewpoint(v) { spectatorViewpoint = v; },
        },
      });
      self._views = views;

      // 调试句柄：收敛到 `window.PlayParts` 命名空间（mount 挂、unmount 删）。
      // 原 `window.__playViews` 跨页全局不再创建，避免单文档下互相覆盖。
      global.PlayParts = {
        clock: global.PlayClock,
        chat: global.PlayChat,
        demo: global.PlayDemo,
        views,
      };

      // 棋钟已抽到 play-clock.js（PLAN §M5）：此处只做一次依赖注入。
      // 注入的是模块内读不到的两个"外部状态"——在 play.js 里它们是闭包变量：
      //   state → 最新对局状态（判断是否 PLAYING、谁的回合）
      //   视角  → 与棋盘**共用 `views.currentViewpoint()`**，保证两者永远同一口径
      //          （对局者固定自己视角；观战者跟随可切换的 spectatorViewpoint）
      global.PlayClock.init({
        getState: function () { return state; },
        getViewpoint: function () { return views.currentViewpoint(); },
        // §U2：每次棋钟刷新时同步「危险外框」。
        // ⚠️ 需求明确「观战者不显示」，而 PlayClock.isDanger() 只报告**时间事实**
        // （当前手番方是否读秒 ≤10 秒）——"必须是本人且轮到本人"这条判断必须在这里做：
        // 观战者 mySeat 为 null，天然被排除；若把判断挪进棋钟，观战者会跟着变红。
        onTick: function (st) {
          if (!fb) return;
          fb.setDanger(
            mySeat !== null && !!st && st.status === 'PLAYING'
            && st.turn === mySeat && global.PlayClock.isDanger()
          );
        },
      });

      // ==================================================================
      // 走子交互
      // ==================================================================
      function onSelectPiece(pieceName, color) {
        if (color !== mySeat) return;      // 只能操作自己持驹
        if (state.turn !== mySeat) return; // 未轮到自己
        const sym = global.DROP_SYMBOLS && Object.keys(global.DROP_SYMBOLS).find((k) => global.DROP_SYMBOLS[k] === pieceName);
        if (!sym) return;
        setSelection(sym);
      }

      function setSelection(from) {
        selected = from;
        const legalBySq = (state && state.legalTargetsBySq) || {};
        targets = legalBySq[from] || [];
        // 重绘高亮
        reapplySelection();
      }

      function reapplySelection() {
        const st = state;
        const checkSqs = st.check ? [views.findKingSq(st, st.turn)] : [];
        const viewpoint = mySeat === 'w' ? 'w' : 'b';
        board.render(st, {
          lastMove: st.lastMove,
          check: checkSqs,
        }, viewpoint);
        // 叠加选中与目标
        if (selected) board.highlightSq(selected, 'sel');
        targets.forEach((t) => {
          const cell = board._findCell(t.to);
          if (cell) {
            // 先清旧类再添加：避免残留 has-piece（方块）污染空格目标（应为绿点）
            cell.classList.remove('target', 'has-piece');
            cell.classList.add('target');
            // 有棋子的目标格 → 绿色方块；空位 → 绿点
            if (cell.innerHTML) cell.classList.add('has-piece');
          }
        });
      }

      // ⚠️ 审查 P3：原 `bindBoardClicks` / `handleTarget` 旧走子交互簇**经全仓 grep 确认无任何调用点**
      // （棋盘交互已统一由 FreeBoard 承担，见 play-demo.js / freeboard.js），属死代码，已删除。
      // 其中 `setSelection` / `reapplySelection` 仍被 `onSelectPiece`（持驹点选，被 play-views.js 引用）调用，保留。
      // `sendMove` 仍被升变/打子按钮复用，保留于此。
      function sendMove(usi) {
        api.send({ type: 'move', data: { usi } });
        selected = null;
        targets = [];
        // 立即移除本地高亮（否则走子后绿点/方块残留直到服务器推送）
        clearHighlights();
      }

      /** 清除棋盘上的选中/目标/方块高亮类 */
      function clearHighlights() {
        if (!board || !board.boardEl) return;
        board.boardEl.querySelectorAll('.cell.sel, .cell.target, .cell.has-piece').forEach((c) => {
          c.classList.remove('sel', 'target', 'has-piece');
        });
      }

      /** §6.3：升变弹层的显示/隐藏统一走这里——顺带把焦点管理交给 `A11y`。
       *  ⚠️ 2026-10-02 体验修复：注册 Esc/取消（此前 Esc 被刻意禁用、又没有取消按钮 →
       *  点到会升变的目标格就只能二选一、无法退出）。「成」已在 HTML 中置前并带 autofocus。 */
      function cancelPromote() {
        if (global.PlayDemo && global.PlayDemo.takePendingPromo) global.PlayDemo.takePendingPromo(); // 清掉感想战暂存
        pendingPromote = null;
        if (selected) { selected = null; targets = []; clearHighlights(); }
        hidePromoteOverlay();
      }
      function showPromoteOverlay() {
        const el = $('promoteOverlay');
        if (!el) return;
        el.classList.add('show');
        if (global.A11y) global.A11y.onDialogOpen(el, { onClose: cancelPromote });
      }
      function hidePromoteOverlay() {
        const el = $('promoteOverlay');
        if (!el) return;
        el.classList.remove('show');
        if (global.A11y) global.A11y.onDialogClose(el);
      }

      // 升变按钮（对局走子 / 感想战演示共用弹层）
      // 感想战分支必须走 demo_move 通道（带光标 index）；sendMove() 硬编码 type:'move' 不能复用
      on($('btnPromote'), 'click', () => {
        // §M5：感想战的升变选择存放在 play-demo.js，用 takePendingPromo() 取出并清空
        const demoPromo = global.PlayDemo.takePendingPromo();
        if (demoPromo) global.PlayDemo.sendMove(demoPromo.usiPromote);
        else if (pendingPromote) sendMove(pendingPromote.promoteUsi);
        hidePromoteOverlay();
        pendingPromote = null;
      });
      on($('btnNoPromote'), 'click', () => {
        const demoPromo = global.PlayDemo.takePendingPromo();
        if (demoPromo) global.PlayDemo.sendMove(demoPromo.usiMove);
        else if (pendingPromote) sendMove(pendingPromote.nonPromoteUsi);
        hidePromoteOverlay();
        pendingPromote = null;
      });
      on($('btnPromoteCancel'), 'click', cancelPromote);

      // 认输 / 再来一局 / 退出
      // 结算横幅的「关闭」：原先写在 play.html 的 inline onclick 里，
      // 改为 data-act + 整页委托（2026-09-23，审查项 13f）。
      // SPA：`UI.onAction` 是**全局单槽**委托（模块级只注册一次，见文件末尾），
      // 处理器经 `Views.play._handlers` 中转——mount 挂、unmount 置空，旧句柄不被误调用。
      self._handlers = {
        bannerClose() {
          const b = $('banner');
          if (b) b.classList.remove('show');
        },
      };

      on($('btnResign'), 'click', () => {
        if (confirm('确定认输吗？')) api.send({ type: 'resign' });
      });
      // 入玉宣言（§P1 R-d）：条件一律由服务端判定，成功即宣言方胜；失败会收到具体原因
      on($('btnDeclare'), 'click', () => {
        api.send({ type: 'declare_nyugyoku' });
      });

      // ==================================================================
      // 举报（2026-09-20 用户要求）
      //
      // ⚠️ 类别清单来自服务端（`hello.reportCategories`，源头是 `src/reports.js` 的 `CATEGORIES`），
      // 前端**不另抄一份**——抄了就会出现"前端能选、服务端不认"或反之。
      // ⚠️ 被举报人取**对面座位**的 id，而不是"当前视角那个人"写死成先手/后手；
      // 视角可翻转，取错就会举报到自己。
      // ⚠️ 服务端还会做去重与配额（同一目标 30 分钟内只收一条），这里只负责发起。
      // → 表单交互与提交已整体在 play-views.js（make 装配，destroy 全清）。
      // ==================================================================

      // ==================================================================
      // WS 事件
      // ==================================================================
      function countPieces(st) {
        let n = 0;
        const b = st.board;
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
          if (b[r][c] && b[r][c].piece) n++;
        }
        return n;
      }
      // 首次交互解锁音频（浏览器自动播放策略）
      const unlockAudio = () => { if (global.Sound) global.Sound.ensureCtx(); };
      document.addEventListener('pointerdown', unlockAudio, { once: true });
      teardown.push(() => document.removeEventListener('pointerdown', unlockAudio));

      // 音效开关
      const btnSound = $('btnSound');
      function refreshSoundBtn() {
        if (!btnSound) return;
        btnSound.textContent = (global.Sound && global.Sound.isEnabled()) ? '🔊 音效' : '🔇 静音';
      }
      on(btnSound, 'click', () => {
        if (!global.Sound) return;
        global.Sound.setEnabled(!global.Sound.isEnabled());
        refreshSoundBtn();
        if (global.Sound.isEnabled()) global.Sound.playMove();  // 反馈音
      });
      refreshSoundBtn();

      teardown.push(api.on('state', (data) => {
        const prevMoves = lastMoveCount;
        lastMoveCount = (data.moves || []).length;
        // 走子音效：手数增加（自己或对手走子）。
        // ⚠️ 审查 P3：**首帧不发**。进入 / 重连时的第一条 state 可能一次性带着几十手历史，
        //   会被当成"刚走的一手"；且旧代码 lastPieceCount 初值 81 恒大于实际子数 → 必误播吃子音。
        //   这里以 lastPieceCount===null 标记"尚未收到首帧"：首帧只做基线初始化，之后才参与吃子判定。
        if (global.Sound && data.moves && data.moves.length > prevMoves && lastPieceCount !== null) {
          const pieces = countPieces(data);
          if (pieces < lastPieceCount) global.Sound.playCapture();  // 吃子
          else global.Sound.playMove();                             // 普通落子
        }
        lastPieceCount = countPieces(data);
        state = data;
        mySeat = data.seat || null;
        isPlayer = data.isPlayer === true;
        // confirmLeave / unmount 在闭包外读取 → 同步镜像
        self._state = data;
        self._isPlayer = isPlayer;
        global.PlayClock.resetTick(); // 以"此刻"为倒计时基准（原 `lastTickTs = Date.now()`）
        views.scrollBoardIntoViewOnce(); // §S2：手机端首屏直接落到棋盘
        // §U4 对局 BGM：进行中开、终局停（刷新/中途进房也走这里）
        // ⚠️ 2026-10-08：把对手开局曲交给 Sound（设置里「播放对手 BGM」时交替循环）
        if (global.Sound) {
          if (global.Sound.setOpponentTrack) {
            const oppSeat = mySeat === 'b' ? 'w' : 'b';
            const opp = state.players && state.players[oppSeat];
            global.Sound.setOpponentTrack(opp && opp.bgm ? opp.bgm : null);
          }
          if (state.status === 'PLAYING') global.Sound.bgmStart();
          else if (state.status === 'FINISHED') global.Sound.bgmStop();
        }
        // 感想战路由（PLAN §G v6）：终局自动进入；新对局自动退出（§M5：实现在 play-demo.js）
        if (state.status === 'FINISHED' && state.result) {
          global.PlayDemo.enter(state);
          // ⚠️ 2026-10-02 体验修复：终局也必须渲染一次——胜负横幅在 render() 内，
          // 此前直接 return 导致「进入感想战」吞掉了正式结果呈现（只剩一闪而过的 toast）。
          views.render(state);
          return;
        }
        if (global.PlayDemo.isActive()) global.PlayDemo.exit();
        // 收到新状态时清空选中（如果对方走子则清）
        if (selected && mySeat !== state.turn) {
          selected = null;
          targets = [];
        }
        views.render(state);
      }));

      // 棋钟校准（PLAN §M5：处理逻辑已抽到 play-clock.js）
      teardown.push(api.on('clock', (data) => global.PlayClock.syncFromServer(data)));
      // 观众列表（PLAN §R）：渲染实现与 `spectator_update` 订阅均已抽到 play-chat.js（§M5），
      // 此处不再保留副本——避免"两份实现、改一处漏一处"。

      // ==================================================================
      // 感想战（PLAN §G v6 单页）：终局自动进入，同一棋盘组件切 demo-rules
      // ==================================================================
      // 整块（推演谱 / 光标浏览 / 演示权 / 自由摆棋 / 历史手合法走法）已抽到 **play-demo.js**（§M5）。
      // 下面的 `ensureBoard` 属于通用棋盘，**留在 core**——对战与感想战共用同一个 FreeBoard 实例；
      // 模块的依赖注入见本段末尾的 `PlayDemo.init(...)`。

      function ensureBoard(viewpoint) {
        if (fb) return;
        fb = new global.FreeBoard({
          board,
          viewpoint,
          interactive: false,
          mode: 'play',
          hands: {
            my: $('myHandPieces'), myColor: viewpoint,
            opp: $('oppHandPieces'), oppColor: viewpoint === 'b' ? 'w' : 'b',
          },
          onMove: (usi) => {
            // §M5：感想战走子（带光标 index）由 play-demo.js 负责
            if (global.PlayDemo.isActive()) global.PlayDemo.sendMove(usi);
            else api.send({ type: 'move', data: { usi } });
          },
          onPromoteChoice: ({ usiMove, usiPromote }) => {
            if (global.PlayDemo.isActive()) global.PlayDemo.setPendingPromo({ usiMove, usiPromote });
            else pendingPromote = { promoteUsi: usiPromote, nonPromoteUsi: usiMove };
            showPromoteOverlay();
          },
        });
        fb.attach();
        fb.bindHands($('myHandPieces'), viewpoint, $('oppHandPieces'), viewpoint === 'b' ? 'w' : 'b');
        self._fb = fb;   // unmount 要 fb.destroy()（解除 resize/orientationchange/拖拽监听）
      }

      // `ensureOriginalPositions()`（原谱逐手局面缓存）与 `applyDemoMode()`（联合谱渲染 + §J4 权威覆盖）
      // 已搬到 **play-demo.js**（§M5）。其中 §J4 的「最新一手用服务端局面覆盖本地重放」逻辑原样保留。

      // `renderDemoMoveList()`（推演谱列表）与 `updateDemoUI()`（演示栏状态）已搬到 play-demo.js（§M5）。
      // core 里的 `escHtml` 也随之移除——原本只有这两处用它，两个模块各自持有一份转发。

      // 历史手合法走法（demo_legal）、demo 按钮交互、demo_state 订阅均已搬到 play-demo.js（§M5）。

      // ---- 依赖注入（与 play-clock.js 同一模式）----
      // 注入的是模块内读不到的 core 闭包状态与三个既有函数：
      //   getState / getFb / getSeat / getViewpoint   → 状态读取
      //   ensureBoard / renderPlayerBars / clearSelection → core 既有函数
      // 之后 core 只在「进入 / 退出 / 重绘」三个时机反向调用它（见 views.render() 与 api.on('state')）。
      // SPA：init 里注册的订阅/监听由 PlayDemo.destroy() 清（unmount 调）。
      global.PlayDemo.init({
        getState: function () { return state; },
        getFb: function () { return fb; },
        getSeat: function () { return { mySeat: mySeat, isPlayer: isPlayer }; },
        getViewpoint: function () { return views.currentViewpoint(); },
        ensureBoard: ensureBoard,
        renderPlayerBars: views.renderPlayerBars,
        clearSelection: function () { selected = null; targets = []; },
      });

      // ==================================================================
      // 对局事件
      // ==================================================================
      teardown.push(api.on('game_over', (data) => {
        notify('对局结束：' + (data.resultDetail || ''));
        if (global.Sound) { global.Sound.bgmStop(); } // §U4 终局停 BGM —— 终局音效统一由演示栏进入时播放（此前两处都播 → 双响）
        // 终局不跳页——state 推送（含 demo）会触发自动进入感想战模式
      }));
      teardown.push(api.on('game_start', (data) => {
        notify('对局开始！');
        if (global.Sound) { global.Sound.playStart(); global.Sound.bgmStart(); } // §U4 开局起 BGM
      }));
      // 对手请求再来一局：提示并高亮「再来一局」按钮
      teardown.push(api.on('rematch_requested', (data) => {
        const name = (data && data.requesterName) || '对手';
        notify(`${name} 请求再来一局，点击「再来一局」应战`);
        const btn = $('btnRematch');
        const bannerBtn = $('bannerRematch');
        btn.style.display = 'inline';
        btn.classList.add('pulse');
        if (bannerBtn) {
          bannerBtn.style.display = 'inline';
          bannerBtn.classList.add('pulse');
        }
        const t = setTimeout(() => {
          btn.classList.remove('pulse');
          if (bannerBtn) bannerBtn.classList.remove('pulse');
        }, 4000);
        teardown.push(() => clearTimeout(t));
      }));
      teardown.push(api.on('error', (data) => {
        if (data && data.message) notify(data.message);
        // 私人房观战需要密码（PLAN §T2）：本页没有密码输入框 → 提示后回大厅的
        // 「👁 观战」入口补填密码（那里有房间码与密码框）。否则用户只会停在一片空白对局页。
        if (data && data.needPassword) {
          self._forceLeave = true; // 服务端权威指示离开 → 不再弹离开确认
          const t = setTimeout(() => { global.Router.navigate('lobby.html'); }, 1200);
          teardown.push(() => clearTimeout(t));
        }
      }));

      // 服务端明确回执「没有可进入的房间」（历史 bug 修复，2026-09-13）：
      // 从大厅点一张"自己是选手"的卡片时走的是 request_state（不带 spectate），
      // 若那局已结束 / 房间已销毁，服务端原先**静默不响应** → 页面一片白且没有任何提示。
      // 现在改为明确告知 + 送返大厅（与上面 needPassword 的处理风格一致）。
      teardown.push(api.on('no_room', () => {
        notify('该对局已结束或不存在，即将返回大厅');
        self._forceLeave = true; // 房间已没了 → 自动跳转不弹离开确认
        const t = setTimeout(() => { global.Router.navigate('lobby.html'); }, 1600);
        teardown.push(() => clearTimeout(t));
      }));
      // 同身份在别处登录：本页被顶替，提示并停止操作
      teardown.push(api.on('replaced', () => {
        toast('此身份已在其他窗口登录，本页已断开');
        board.setInteractive(false);
      }));

      // ==================================================================
      // 聊天（§R2 分区 / §R3 观众进出提示）
      // ==================================================================
      // 整块已抽到 **play-chat.js**（PLAN §M5）：聊天记录、分区 tab、观众名单及其 WS 事件
      // 都在那边，由 `PlayChat.mount()` 统一注册（destroy 在 unmount 一并清）。
      global.PlayChat.mount();

      // 仅当显式带 spectate=1 参数时才进入观战（来自观战列表/随机观战入口）
      // 玩家（建房/加入/匹配/重连）跳转不带 spectate，走 request_state，由服务端按连接身份返回对应状态
      // URL 参数：优先 router 传入的 params，回退 location.search（两者同源、必然一致）
      const qs = new URLSearchParams(location.search);
      const pick = (k) => (params && params[k] != null && params[k] !== '') ? String(params[k]) : qs.get(k);
      const isSpectate = !!pick('spectate');
      const isTournamentJoin = !!pick('join');
      const roomParam = pick('room');
      function enterRoom() {
        if (isSpectate) {
          // 私人房间观战密码（PLAN §T2）：由大厅放进 sessionStorage，随本连接提交。
          // 取完即删——避免残留在会话里被下一次观战误用。
          let pw = '';
          try {
            pw = window.sessionStorage.getItem('tdshogi_spectate_pw') || '';
            if (pw) window.sessionStorage.removeItem('tdshogi_spectate_pw');
          } catch (_) { /* 隐私模式下 sessionStorage 可能不可用，忽略即可 */ }
          api.send({ type: 'spectate', data: { roomId: roomParam, password: pw } });
        } else if (isTournamentJoin) {
          // 赛事对局：玩家主动进入（建局时可能不在线）
          api.send({ type: 'join_tournament_match', data: { roomId: roomParam } });
        } else {
          // 请求当前状态（可能是重连，也可能是玩家跳转进来）；
          // 带 URL 里的 roomId：服务端回位优先绑定该房间（重新匹配后不被旧对局的
          // 复盘中座位按插入顺序劫持——幽灵房修复）
          api.send({ type: 'request_state', data: roomParam ? { roomId: roomParam } : {} });
        }
      }
      // WS 首次连接与断线重连统一在此进入房间；
      // 观战者重连后服务端不会主动重推 state，必须重新发起 spectate/request_state。
      // ⚠️ SPA：外壳持有唯一 WS，本页挂载时连接**早已建立**（open 不会再触发）→
      // mount 主动 enterRoom() 一次；`api.on('open')` 专管断线重连后的重新进房（重拉状态）。
      teardown.push(api.on('open', enterRoom));
      enterRoom();
      // 设置变更 → 重渲染棋盘（坐标 §S4 / 图集 §S5 / 上一步高亮，PLAN §S1）
      if (global.Settings) {
        teardown.push(global.Settings.subscribe((all, key) => {
          if (['showCoords', 'highlightLastMove'].indexOf(key) >= 0) {
            if (state) views.render(state);
            else if (fb) fb.render();
          }
        }));
      }
      // ⚠️ 2026-10-08：棋子图集迁入装扮 —— 装备变化后按新图集重画
      const onAppearance = () => {
        if (state) views.render(state);
        else if (fb) fb.render();
      };
      document.addEventListener('tdshogi-appearance', onAppearance);
      teardown.push(() => document.removeEventListener('tdshogi-appearance', onAppearance));

      // ==================================================================
      // ⚠️ 2026-10-03 新功能：道具系统骨架 —— 对局立绘渲染
      //
      // 独立处理器：**不改动既有的 state 渲染主逻辑**（play-views.js），只在本页额外
      // 挂一个 state 监听，把 `state.players[b|w].sprite` 画到棋盘两侧（见 DESIGN §9）。
      //   kind==='glyph' → 大号字形；kind==='image' → <img src=value>；空 → 容器留空（不占视觉）。
      // 视角无关：先手(b)恒在右、后手(w)恒在左（与各自持驹所在方位一致，不随观战视角翻转）。
      // 移动端（<900px，与 CSS 断点对齐）不展示，直接隐藏。
      // ==================================================================
      const escHtml = UI.esc;
      function renderSprites(st) {
        const boxes = { b: $('spriteB'), w: $('spriteW') };
        if (!boxes.b || !boxes.w) return; // HTML 里没插立绘容器就直接跳过
        const narrow = window.innerWidth < 900;
        for (const seat of ['b', 'w']) {
          const box = boxes[seat];
          const sp = st && st.players && st.players[seat] ? st.players[seat].sprite : null;
          if (narrow || !sp || !sp.value) { box.style.display = 'none'; box.innerHTML = ''; continue; }
          if (sp.kind === 'image') {
            box.innerHTML = `<img src="${escHtml(sp.value)}" alt="" style="max-height:220px;max-width:100%;object-fit:contain;">`;
          } else {
            // 字形（glyph）占位立绘：大号衬线字
            box.innerHTML = `<span style="font-size:72px;line-height:1;font-family:var(--font-serif);color:var(--gold-light);">${escHtml(sp.value)}</span>`;
          }
          box.style.display = 'flex';
        }
      }
      teardown.push(api.on('state', (data) => renderSprites(data)));

      // ==================================================================
      // ★离开拦截（SPA）：对局进行中离开要提醒「离开即判负」
      //   - confirmLeave()：router 的 navigate / onPopState 在离开前调用，取消则阻断导航；
      //   - beforeunload：浏览器关闭 / 刷新时的原生提示，unmount 时解绑。
      // ==================================================================
      const onBeforeUnload = (e) => {
        if (!(isPlayer && state && state.status === 'PLAYING')) return;
        e.preventDefault();
        e.returnValue = '对局进行中，离开/刷新将判负（相当于认输）'; // 旧浏览器需要赋值才弹
        return '对局进行中，离开/刷新将判负（相当于认输）';
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      teardown.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
    },

    /**
     * ★离开守卫（router 契约）：返回 false 则**阻断**本次导航。
     * 对局进行中（有自己在下的、未结束的对局）→ 弹确认框，用户取消则留在原地；
     * 对局已结束 / 观战 / 非进行中 / 用户已通过「退出对局」确认过 → 直接放行。
     */
    confirmLeave() {
      if (this._forceLeave) return true;
      const st = this._state;
      const ongoing = this._isPlayer && st && st.status === 'PLAYING';
      if (!ongoing) return true;
      // UI.alert 是异步模态、拿不到"确定/取消"结果；离开守卫需要同步布尔 → 用原生 confirm
      return global.confirm('对局进行中，离开本页将被判负（相当于认输）。确定离开吗？') === true;
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
      this._handlers = null;
      // 子模块（4 个）：退订 WS / 解绑 DOM / 停定时器 / 复位内部状态
      if (global.PlayDemo && global.PlayDemo.destroy) { try { global.PlayDemo.destroy(); } catch (_) {} }
      if (global.PlayChat && global.PlayChat.destroy) { try { global.PlayChat.destroy(); } catch (_) {} }
      if (global.PlayClock && global.PlayClock.destroy) { try { global.PlayClock.destroy(); } catch (_) {} }
      if (this._views && this._views.destroy) { try { this._views.destroy(); } catch (_) {} }
      this._views = null;
      // 棋盘观察器：FreeBoard.destroy() 解除 resize/orientationchange 与 document 拖拽监听
      if (this._fb && this._fb.destroy) { try { this._fb.destroy(); } catch (_) {} }
      this._fb = null;
      // 对局 BGM：离开对局页即回菜单曲（原多页跳转时页面销毁自然停，SPA 文档常驻需手动停）
      if (global.Sound && global.Sound.bgmStop) { try { global.Sound.bgmStop(); } catch (_) {} }
      // 收敛命名空间：mount 挂的调试句柄一并清掉
      delete global.PlayParts;
      this._state = null;
      this._isPlayer = false;
      this._forceLeave = false;
    },
  };

  global.Views.play = View;

  // SPA：`UI.onAction` 是全局单槽委托（整页一个 click 监听），**模块级只注册一次**；
  // 处理器经 `Views.play._handlers` 中转——未挂载 / 已离开对局页时为空，静默忽略。
  UI.onAction('banner-close', () => {
    const H = View._handlers;
    if (H && typeof H.bannerClose === 'function') H.bannerClose();
  });
})(window);
