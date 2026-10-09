/**
 * admin.js — 管理后台 View：管理员登录、全部棋谱 / 用户 / 赛事 / 审计 / 审核 / 道具管理
 *
 * SPA 迁移（2026-10-09）：从「IIFE 加载即自启」改为**有生命周期的 View**——
 *   render()                → 返回 `<main class="container">…`（原 admin.html 的主体，逐字保留）
 *   mount(container, params)→ 装配 8 个 admin-* 子模块、绑事件 / 订阅 WS，句柄记 this._teardown
 *   unmount()               → 统一清理（含各子模块 unmount 与 hub 清空），切页零泄漏
 *
 * 范式（照 home.js）：
 *   - 不再调用 `NAV.renderNav`（外壳已渲染一次，router 更新 active）→ 改 `NAV.getGuest()`。
 *   - 不再调用 `api.connect`（外壳持有唯一 WS）。
 *   - `location.href = 'xxx.html?…'` → `Router.navigate('…')`（指向 /api/... 的导出/下载除外）。
 *   - 所有 setInterval / setTimeout / api.on / document|window 监听，统一在 unmount 清理。
 *
 * 子模块（§M5：admin-shell / admin-records / admin-users / admin-audit / admin-tournaments /
 * admin-moderation / admin-console / admin-items）不再是「加载即自启」的 IIFE：各自导出
 * `window.AdminParts.<name> = { mount(ctx), unmount() }`，由本 View 的 mount/unmount 驱动；
 * 跨模块函数统一走 `ctx.hub`（原 `window.adminPage` / `window.loadXxx` / `window.viewUser`
 * 等全局名收敛到 `this._handlers` 命名空间，unmount 清空，单文档下不再跨页冲突）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;
  // 与 nav.js 的 ADMIN_KEY 保持一致（后台鉴权走 localStorage）
  const ADMIN_KEY = (global.NAV && global.NAV.ADMIN_KEY) || 'tdshogi_admin_token';

  function getToken() {
    try { return localStorage.getItem(ADMIN_KEY); } catch (_) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(ADMIN_KEY, t);
      else localStorage.removeItem(ADMIN_KEY);
    } catch (_) {}
  }

  /**
   * IP 掩码（PLAN §U6）：后台**默认**只显示到网段，点击才展开完整地址。
   *
   * 原始 IP 属隐私数据，后台又是最容易被截图的页面——
   * 默认掩码能挡掉"随手截图外流"这类低级泄露，同时不影响管理员排查（点一下就能看全）。
   */
  function maskIp(ip) {
    const s = String(ip || '');
    if (!s) return '';
    if (s.includes(':')) {                            // IPv6：保留前两组
      return s.split(':').slice(0, 2).join(':') + ':*';
    }
    const seg = s.split('.');
    if (seg.length === 4) return `${seg[0]}.${seg[1]}.${seg[2]}.*`;
    return s;                                         // 非预期格式：原样返回（显示出来总比留空好）
  }

  // ==================================================================
  // 分页（PLAN §W1 / 需求 13）：后台每个列表最多显示 20 条
  // ==================================================================
  const PAGE_SIZE = 20;

  const View = {
    title: '管理后台 · TDShogi',

    render() {
      // —— 原 admin.html 的 <main class="container"> … </main> 主体，逐字保留 ——
      return `
  <main class="container">
    <div class="section-title" style="font-size:24px;">🛡️ 管理后台</div>
    <!--
      ⚠️ 2026-10-02 体验修复（入口带 ?k=）：本页是**后台入口页**，关于进入参数的现有约定说明如下——
        1. 服务端入口门禁：设置环境变量 ADMIN_ENTRY_KEY 后，\`/admin.html\` 必须带 \`?k=<key>\`
           才放行，否则直接 404（见 src/http/middleware.js 的 adminEntryGate）。没设该变量时保持开放。
        2. 页面内的鉴权 token 走 **localStorage**（键 \`tdshogi_admin_token\`，见 public/js/admin.js 的
           ADMIN_KEY 与 nav.js 的 isAdminSession）——即"先进得来页面、再由本页向服务端证明身份"。
        因此这里**不硬改鉴权**：?k= 只负责"能不能打开这个页面"，token 负责"是不是管理员"，两者不要混。
      📌 待办（不在本次改动范围）：渲染后台入口链接的是 public/js/nav.js 的 adminEntryHtml()，
        目前写作 \`href="admin.html"\`（未带 k）。若生产启用了 ADMIN_ENTRY_KEY，入口需要改为带上
        \`?k=<key>\`；但该 key 是服务端环境变量、不应下发到前端页面，正确做法是让服务端渲染入口，
        或在 nav.js 里从一个"前端可得的入口标识"拼参数。nav.js 不在本次修复的文件白名单内，未改。
    -->

    <!-- 管理员未登录时 -->
    <div class="card" id="adminLoginCard" style="max-width:420px;padding:28px;">
      <div class="section-title">管理员登录</div>
      <div style="font-size:13px;color:var(--text-dim);margin:10px 0 16px;">请输入管理密码以访问全部棋谱与用户数据</div>
      <input type="password" class="input" id="adminPassword" placeholder="管理密码" style="width:100%;">
      <button class="btn btn-primary" id="btnAdminLogin" style="margin-top:14px;width:100%;">登录</button>
    </div>

    <!-- 管理员已登录 -->
    <div id="adminPanel" style="display:none;">
      <!-- ⚠️ 2026-10-02 体验修复：退出按钮原在登录卡片内（登录后整卡隐藏 → 永远点不到），移到面板顶部 -->
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
        <button class="btn btn-ghost btn-sm" id="btnAdminLogout">退出管理员</button>
      </div>
      <!-- 标签切换 -->
      <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm tab-btn active" data-tab="overview">📊 总览</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="records">全部棋谱</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="users">全部用户</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="tournaments">赛事管理</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="announcements">📢 公告</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="rooms">🕹 对局干预</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="audit">操作审计</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="ipbans">🚫 IP 封禁</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="reports">🚩 举报</button>
        <button class="btn btn-ghost btn-sm tab-btn" data-tab="items">🎒 道具</button>
      </div>

      <!-- 总览仪表盘（§C1）：进后台第一眼看到全局 -->
      <div class="card" id="tab-overview" style="padding:20px;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>平台总览</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshOverview">刷新</button>
        </div>
        <div id="ovStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;">
          <div>
            <div style="font-size:13px;font-weight:700;margin-bottom:8px;">🕒 最近管理操作</div>
            <div id="ovAudit"></div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:700;margin-bottom:8px;">⚔️ 最新对局</div>
            <div id="ovBattles"></div>
          </div>
        </div>
      </div>

      <!-- 全部棋谱 -->
      <div class="card" id="tab-records" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>全部棋谱（<span id="recordCount">0</span>）</span>
          <div style="display:flex;gap:8px;">
            <input class="input" id="recordSearch" placeholder="按选手名/ID 搜索棋谱" style="width:220px;padding:6px 10px;font-size:13px;">
            <input type="file" id="kifFileInput" accept=".kif,.txt" style="display:none;" multiple>
            <button class="btn btn-ghost btn-sm" id="btnImportKif">📥 导入 KIF</button>
            <!-- ⚠️ 2026-10-02 体验修复：补手动刷新按钮（原先只能重进页面/切 tab 才能刷新） -->
            <button class="btn btn-ghost btn-sm" id="btnRefreshRecords">刷新</button>
          </div>
        </div>
        <div id="importResult" style="font-size:12px;color:var(--green);margin:6px 0;"></div>
        <div id="adminRecordList" style="max-height:70vh;overflow-y:auto;"></div>
        <!-- 分页条（PLAN §W1 / 需求 13）：内容由 admin.js 的 renderPaged 填充 -->
        <div id="recordPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 全部用户 -->
      <div class="card" id="tab-users" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>全部用户（<span id="userCount">0</span>）</span>
          <span style="display:flex;gap:8px;align-items:center;">
            <input class="input" id="userSearch" placeholder="按名字/ID 搜索用户" style="width:220px;padding:6px 10px;font-size:13px;">
            <!-- ⚠️ 2026-10-02 体验修复：补手动刷新按钮 -->
            <button class="btn btn-ghost btn-sm" id="btnRefreshUsers">刷新</button>
          </span>
        </div>
        <div id="adminUserList" style="max-height:70vh;overflow-y:auto;"></div>
        <div id="userPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 赛事管理 -->
      <div class="card" id="tab-tournaments" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>赛事管理（<span id="tnCount">0</span>）</span>
          <span id="tnStats" style="font-size:12px;color:var(--text-dim);"></span>
        </div>
        <div style="margin-bottom:18px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">🕐 待审核</div>
          <div id="tnPendingList"></div>
          <div id="tnPendingPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:8px;flex-wrap:wrap;"></div>
        </div>
        <div style="margin-bottom:18px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">▶️ 进行中</div>
          <div id="tnActiveList"></div>
          <div id="tnActivePager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:8px;flex-wrap:wrap;"></div>
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;margin-bottom:8px;">📜 历史</div>
          <!-- 分页后不需要长滚动条（需求 13：一页只显示 20 个） -->
          <div id="tnHistoryList"></div>
          <div id="tnHistoryPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:8px;flex-wrap:wrap;"></div>
        </div>
      </div>

      <!-- 道具发放（2026-10-03 新功能：道具系统） + 商品管理（2026-10-07） -->
      <div class="card" id="tab-items" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>🎒 商品与道具（目录 <span id="itemsCatalogCount">0</span> 件）</span>
          <button class="btn btn-ghost btn-sm" id="btnItemsRefresh">刷新目录</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.7;">
          管理商品目录、上传素材（头像 256×256 / 立绘 / BGM）、调整 BGM 三轨，并给账号发道具 / 加减货币 / 定义兑换码。
          所有操作都会记入「操作审计」（含操作人）。
        </div>

        <!-- A. BGM 三轨 -->
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px;">🎵 BGM 三轨（菜单 / 开局 / 终盘）</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <label style="font-size:12px;">菜单（无对局）<br>
              <select class="input" id="bgmMenu" style="min-width:180px;"></select></label>
            <label style="font-size:12px;">开局（对局中循环）<br>
              <select class="input" id="bgmGame" style="min-width:180px;"></select></label>
            <label style="font-size:12px;">终盘（进入读秒）<br>
              <select class="input" id="bgmEndgame" style="min-width:180px;"></select></label>
            <button class="btn btn-primary btn-sm" id="btnBgmRoles">保存三轨</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">
            玩家在「装扮」装备的 BGM 会覆盖「开局」轨；菜单 / 终盘轨全局生效。下拉里含 OST 内置曲与已上传音频。
          </div>
        </div>

        <!-- B. 上传素材 -->
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px;">📤 上传素材</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <select class="input" id="uploadKind" style="width:140px;">
              <option value="avatar">头像（256×256）</option>
              <option value="sprite">立绘</option>
              <option value="bgm">BGM 音频</option>
            </select>
            <input class="input" id="uploadName" placeholder="显示名（可选）" style="width:160px;">
            <input type="file" id="uploadFile" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/ogg,audio/wav" style="font-size:12px;">
            <button class="btn btn-primary btn-sm" id="btnUpload">上传</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.7;">
            格式：头像 png/jpg/webp 且必须 <b>256×256</b>；立绘 png/jpg/webp（64–2048）；BGM mp3/ogg/wav（≤12MB）。
            上传后在下方「新建商品」里引用素材 URL。
          </div>
          <div id="uploadResult" style="margin-top:8px;font-size:12px;"></div>
        </div>

        <!-- C. 新建 / 编辑商品 -->
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;margin-bottom:8px;">🛒 新建 / 覆盖商品</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input class="input" id="itemEditId" placeholder="id（唯一，如 bgm-custom-1）" style="width:180px;">
            <select class="input" id="itemEditType" style="width:110px;">
              <option value="avatar">头像</option>
              <option value="bgm">BGM</option>
              <option value="sprite">立绘</option>
              <option value="pieces">棋子</option>
              <option value="board">棋盘</option>
              <option value="byoyomi">读秒音</option>
            </select>
            <select class="input" id="itemEditBgmRole" style="width:110px;display:none;" title="BGM 使用场景（每首曲对应唯一场景）">
              <option value="">— 选场景 —</option>
              <option value="menu">菜单曲</option>
              <option value="game">开局曲</option>
              <option value="endgame">终盘曲</option>
            </select>
            <input class="input" id="itemEditName" placeholder="名称" style="width:140px;">
            <input class="input" id="itemEditDesc" placeholder="描述" style="width:180px;">
            <select class="input" id="itemEditRarity" style="width:90px;">
              <option value="N">N</option>
              <option value="R">R</option>
              <option value="SR">SR</option>
            </select>
            <input class="input" id="itemEditPrice" placeholder="价格（空=免费）" style="width:130px;">
            <input class="input" id="itemEditAsset" placeholder="素材 URL，如 /uploads/items/xxx.png" style="width:240px;">
            <button class="btn btn-primary btn-sm" id="btnItemUpsert">保存商品</button>
          </div>
        </div>

        <!-- ① 查账号 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <input class="input" id="itemAccountId" placeholder="账号 id" style="min-width:260px;">
          <button class="btn btn-ghost btn-sm" id="btnItemLookup">查询该账号</button>
        </div>
        <div id="itemAccountResult" style="margin-bottom:14px;"></div>

        <!-- ② 发道具 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <span style="font-size:12px;color:var(--text-dim);">发道具</span>
          <select class="input" id="itemGrantId" style="min-width:220px;"></select>
          <button class="btn btn-primary btn-sm" id="btnItemGrant">发放</button>
        </div>

        <!-- ③ 加减货币 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <span style="font-size:12px;color:var(--text-dim);">货币</span>
          <input class="input" id="itemCoinAmount" placeholder="±整数，如 500 / -100" style="width:200px;">
          <button class="btn btn-ghost btn-sm" id="btnItemCoin">执行</button>
        </div>

        <!-- ④ 定义兑换码 -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;color:var(--text-dim);">兑换码</span>
          <input class="input" id="itemCode" placeholder="码，如 WELCOME2026" style="width:180px;">
          <select class="input" id="itemCodeId" style="min-width:200px;"></select>
          <input class="input" id="itemCodeCoin" placeholder="赠币(可选)" style="width:120px;">
          <input class="input" id="itemCodeMax" placeholder="可用次数(默认1)" style="width:150px;">
          <button class="btn btn-primary btn-sm" id="btnItemCode">定义</button>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:14px;">兑换码由用户在自己的「我的装扮」页兑换；同码可重复定义（覆盖）。</div>

        <!-- ⑤ 目录 -->
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">道具目录（点「编辑」回填上方表单；内置项只能覆盖不能删）</div>
        <div id="itemsCatalogList" style="max-height:42vh;overflow-y:auto;"></div>
      </div>

      <!-- 操作审计（PLAN §K4） -->
      <div class="card" id="tab-audit" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>操作审计（<span id="auditCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshAudit">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">管理员的全部写操作记录（最近 200 条）：封禁/解封、改名、重置、资料修改、删除等</div>
        <!-- ⚠️ 2026-10-02 体验修复：补「动作 / 结果 / 时间」筛选（此前只能从头翻到第 N 页人工找） -->
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <label style="font-size:12px;color:var(--text-dim);">动作
            <select class="input" id="auditAction" style="font-size:12px;padding:5px 8px;margin-left:4px;">
              <option value="">全部</option>
            </select></label>
          <label style="font-size:12px;color:var(--text-dim);">结果
            <select class="input" id="auditOk" style="font-size:12px;padding:5px 8px;margin-left:4px;">
              <option value="">全部</option>
              <option value="1">仅成功</option>
              <option value="0">仅失败</option>
            </select></label>
          <label style="font-size:12px;color:var(--text-dim);">时间
            <select class="input" id="auditRange" style="font-size:12px;padding:5px 8px;margin-left:4px;">
              <option value="">全部</option>
              <option value="1">近 1 小时</option>
              <option value="24">近 24 小时</option>
              <option value="168">近 7 天</option>
            </select></label>
          <button class="btn btn-ghost btn-sm" id="btnAuditReset">清除筛选</button>
          <span id="auditFilterHint" style="font-size:11px;color:var(--text-dim);"></span>
        </div>
        <div id="auditList" style="max-height:70vh;overflow-y:auto;"></div>
        <div id="auditPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- IP 封禁（PLAN §X） -->
      <div class="card" id="tab-ipbans" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>IP 封禁（<span id="ipbCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshIpBan">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.7;">
          封禁同时作用于<b>网页</b>与 <b>WebSocket（对局通道）</b>。
          ⚠️ 家庭 / 学校 / 公司常共用出口 IP，封一个可能误伤一大片——
          建议<b>优先封账号</b>，其次才用短时 IP 封禁。
        </div>
        <div id="ipbMyIp" style="font-size:12px;color:var(--text-dim);margin-bottom:10px;"></div>
        <div class="card" style="padding:14px;margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;background:var(--bg-2);">
          <label style="font-size:12px;">IP 或网段<br>
            <input class="input" id="ipbIp" placeholder="203.0.113.7 或 203.0.113.0/24" style="width:230px;padding:6px 10px;font-size:13px;"></label>
          <label style="font-size:12px;">理由（必填）<br>
            <input class="input" id="ipbReason" placeholder="如：刷接口 / 开小号" style="width:210px;padding:6px 10px;font-size:13px;"></label>
          <label style="font-size:12px;">时长<br>
            <select class="input" id="ipbHours" style="padding:6px 10px;font-size:13px;"></select></label>
          <button class="btn btn-primary btn-sm" id="btnIpBan">🚫 封禁</button>
        </div>
        <div id="ipbList" style="max-height:60vh;overflow-y:auto;"></div>
        <div id="ipbPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 举报处理（2026-09-20）：玩家在对局页提交，这里处理 -->
      <div class="card" id="tab-reports" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>举报处理（<span id="rpPending">0</span> 待处理 / 共 <span id="rpCount">0</span>）</span>
          <span style="display:flex;gap:8px;">
            <select class="input" id="rpFilter" style="font-size:12px;padding:5px 8px;">
              <option value="pending">仅待处理</option>
              <option value="">全部</option>
              <option value="handled">已处理</option>
              <option value="rejected">已驳回</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="btnRefreshReports">刷新</button>
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.7;">
          被举报人的名字由<b>服务端查会话</b>写入（不接受客户端传的名字），所以记录里的对象是可信的。
          ⚠️ 处理请以<b>证据</b>为准：这里的记录本身不是证据，棋谱才是（可从对局页导出）。
        </div>
        <div id="rpList" style="max-height:60vh;overflow-y:auto;"></div>
        <!-- 分页条：与其余 tab 一致（20 条/页） -->
        <div id="rpPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 公告管理（§C5）：此前只能手改 data/announcements.json -->
      <div class="card" id="tab-announcements" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>公告管理（<span id="anCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshAnn">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
          公告展示在首页与大厅。置顶的排在最前，其余按发布时间倒序。
        </div>
        <div class="card" style="padding:14px;margin-bottom:16px;background:var(--bg-2);">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
            <label style="font-size:12px;">标题<br>
              <input class="input" id="anTitle" placeholder="公告标题" style="width:240px;padding:6px 10px;font-size:13px;"></label>
            <label style="font-size:12px;display:flex;align-items:center;gap:6px;padding-bottom:6px;">
              <input type="checkbox" id="anPinned"> 置顶
            </label>
            <button class="btn btn-primary btn-sm" id="btnAnnAdd">＋ 发布公告</button>
            <button class="btn btn-ghost btn-sm" id="btnAnnCancelEdit" style="display:none;">取消编辑</button>
          </div>
          <label style="font-size:12px;display:block;margin-top:10px;">内容<br>
            <textarea class="input" id="anContent" rows="3" placeholder="公告内容" style="width:100%;padding:8px 10px;font-size:13px;resize:vertical;"></textarea></label>
          <div id="anEditHint" style="font-size:12px;color:var(--gold-light);margin-top:6px;display:none;"></div>
        </div>
        <div id="anList"></div>
        <div id="anPager" style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:10px;flex-wrap:wrap;"></div>
      </div>

      <!-- 对局干预（§C6）：看在线房间并强制解散 / 强制下线 -->
      <div class="card" id="tab-rooms" style="padding:20px;display:none;">
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
          <span>在线房间（<span id="rmCount">0</span>）</span>
          <button class="btn btn-ghost btn-sm" id="btnRefreshRooms">刷新</button>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">
          含私人房（大厅看不到的那种）。⚠️ 强制解散会立刻中断对局，房内的人会收到提示。
        </div>
        <div id="rmList" style="max-height:65vh;overflow-y:auto;"></div>
      </div>

      <!-- 用户详情弹层 -->
      <div class="modal-overlay" id="userDetailModal" role="dialog" aria-modal="true" aria-label="用户详情" style="display:none;">
        <div class="card" style="width:720px;max-width:94vw;max-height:86vh;overflow:auto;padding:24px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="font-size:20px;font-weight:800;" id="detailUserName"></div>
            <button class="btn btn-ghost btn-sm" data-act="modal-close">关闭</button>
          </div>
          <div id="detailBody"></div>
        </div>
      </div>
    </div>
  </main>`;
    },

    mount(container, params) {
      this._teardown = [];
      // 存活标志：所有异步回调恢复处先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入
      let alive = true;
      this._teardown.push(() => { alive = false; });

      const guest = global.NAV.getGuest();   // 铁律1：替代原 NAV.renderNav(null)（导航由外壳渲染）
      const api = global.API;                // 铁律2：不再 api.connect（外壳持有唯一 WS）
      const $ = (id) => UI.$(id);
      const esc = (s) => UI.esc(s);
      const toast = (m) => UI.toast(m);

      // 管理令牌（PLAN §J5）：`mount(container, params)` 的 params.adminToken 优先，
      // 回退 URL `?adminToken=`，均无则沿用 localStorage 里的 `tdshogi_admin_token`。
      // URL 里带 token 时回填 localStorage（原多页版「?adminToken= 或 localStorage 取 token」的约定）。
      try {
        const urlToken = (params && params.adminToken)
          || new URLSearchParams(global.location.search).get('adminToken');
        if (urlToken) setToken(urlToken);
      } catch (_) {}

      // 各列表的当前页。赛事那三个（待审核/进行中/历史）也在这里，**不要再另起一个 tnPages**
      // ——两套页码状态并存时，翻页行为会出现"这个列表记住了、那个列表没记住"的怪象（2026-09-14 归并）。
      //（每次 mount 重置：重新进入后台回到第 1 页，避免沿用旧页码停在空页。）
      const pages = {
        records: 1, users: 1, audit: 1, tournaments: 1,
        tnPending: 1, tnActive: 1, tnHistory: 1, ipbans: 1, announcements: 1, reports: 1,
      };

      // 跨模块函数表（原 window.adminPage / window.loadXxx / window.viewUser 等全局名）：
      // 单文档下挂 window 会跨页互相覆盖 → 收敛到本 View 的 _handlers 命名空间，unmount 清空。
      const hub = (this._handlers = this._handlers || {});

      /** 时间戳 → 「—」/本地时间（原 admin-users.js 的 fmtTime，audit / 用户详情弹层共用） */
      const fmtTime = (ts) => (ts ? global.I18N.fmt(ts) : '—');
      /** 时间戳 → 本地短格式；空值显示「不限」（申请表允许不填时间）（原 admin-tournaments.js 的 fmtTs） */
      function fmtTs(ts) {
        if (!ts) return '不限';
        return global.I18N.fmt(ts, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      }

      // 空/加载态统一（原 admin-shell.js 里的 global.AdminUI）：
      // ⚠️ 2026-10-02 体验修复（空状态/加载态统一）：此前每个 tab 各写各的话术——
      // 「暂无棋谱」/「没有符合条件的举报。」/「当前没有在线房间。」有的带句号有的不带，
      // "加载中"更是各页皆无（点开 tab 先是一片空白，看起来像坏了）。这里集中一份，
      // 由各子模块在渲染时取用，保证全后台两句话一个样。
      const AdminUI = {
        /** 统一空状态（各模块传入更具体的说明） */
        empty(text) {
          return `<div class="admin-empty" style="color:var(--text-dim);font-size:13px;padding:6px 2px;">${esc(text || '暂无数据')}</div>`;
        },
        /** 统一加载态占位 */
        loading(text) {
          return `<div class="admin-loading" style="color:var(--text-dim);font-size:13px;padding:6px 2px;">${esc(text || '加载中…')}</div>`;
        },
      };

      /**
       * 把"全量数据 → 列表渲染"包成分页渲染。
       *
       * **四个 tab 共用这一个函数**——同一份翻页逻辑抄四遍，迟早只改三处。
       * 刻意做成"包裹"而不是改各 render 函数内部：这样 render 只管画一页，
       * 分页状态集中在这里，两边职责不混。
       * 服务端目前仍全量下发；真到十万级数据时再改服务端分页，那时也只需动这一处。
       *
       * @param {string} key         tab 标识（用来记当前页码）
       * @param {Array}  items       全量数据
       * @param {string} pagerElId   分页条容器 id
       * @param {(slice:Array)=>void} render 只负责渲染传入的这一页
       * @param {boolean} [reset]    数据来源变了（如搜索）→ 回到第 1 页
       */
      function renderPaged(key, items, pagerElId, render, reset) {
        if (reset) pages[key] = 1;
        // 统一到 `UI.paginate`（2026-09-14）：admin 原先自己实现了一份分页条，
        // 与前台三处 + 赛事详情页那份并存——两边的按钮风格与边界行为（单页时显不显"共 N 条"、
        // 页码越界怎么夹）迟早会不一致。现在这里只是它的薄封装，只负责"用已有 items 重画"。
        const pg = UI.paginate({
          items,
          page: pages[key],
          size: PAGE_SIZE,
          container: pagerElId,
          onPage: (n) => adminPage(key, n), // 翻页走统一入口（会重拉数据，保持与刷新一致）
        });
        pages[key] = pg.page; // 页码被夹回时同步回来，避免停在空页
        render(pg.slice);
      }

      /**
       * 翻页：更新页码后重跑该 tab 的加载（保持与刷新一致的数据来源）。
       *（原 `window.adminPage` —— 现收敛进 hub，不再挂 window，unmount 后不可被误调用。）
       */
      function adminPage(key, page) {
        pages[key] = page;
        const load = {
          records: hub.loadRecords,
          users: hub.loadUsers,
          audit: hub.loadAudit,
          tournaments: hub.loadTournaments,
          ipbans: hub.loadIpBans,
          announcements: hub.loadAnnouncements,
          reports: hub.loadReports,
        }[key];
        if (load) load();
      }
      hub.adminPage = adminPage;

      // 元素事件统一登记（元素虽随 DOM 销毁，仍一并记录，双保险）
      const on = (el, ev, fn) => {
        if (!el) return;
        el.addEventListener(ev, fn);
        this._teardown.push(() => el.removeEventListener(ev, fn));
      };

      // `target="_blank"` 的「详情 ↗」链接：保留原行为——**新标签**打开赛事详情、管理员留在后台。
      //（router 会把 a[href] 站内跳转接管为 SPA 导航，这里在容器上先行拦截并 window.open。）
      const onBlankLink = (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[target="_blank"][href]');
        if (!a) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        try { global.open(a.getAttribute('href'), '_blank'); } catch (_) {}
      };
      container.addEventListener('click', onBlankLink);
      this._teardown.push(() => container.removeEventListener('click', onBlankLink));

      // ==================================================================
      // §M5（2026-09-28）：管理后台按 tab 拆到 admin-*.js
      // ==================================================================
      // 共用工具（token / esc / maskIp / toast / 分页 / AdminUI）在此注入各子模块；
      // 子模块只导出 `{ mount, unmount }`，由本 View 的生命周期驱动，**绝不自启**。
      const ctx = {
        api, UI, $, esc, toast,
        getToken, setToken, maskIp,
        pages, renderPaged, fmtTime, fmtTs, AdminUI,
        hub, guest,
        isAlive: () => alive,
        on,
      };
      const PARTS = ['shell', 'records', 'users', 'audit', 'tournaments', 'moderation', 'console', 'items'];
      for (const name of PARTS) {
        const part = global.AdminParts && global.AdminParts[name];
        if (!part || typeof part.mount !== 'function') {
          throw new Error('admin-' + name + '.js 必须在 admin.js 之前加载（<script> 顺序错了）');
        }
        part.mount(ctx);
        // 子模块自己的定时器 / 监听 / api.on 在其 unmount 内清 —— 一并记进本 View 的 teardown
        this._teardown.push(() => { try { part.unmount(); } catch (_) {} });
      }

      // 底部初始化（原文件末尾的 initUI()）：此时各模块已装配完毕，
      // 登录态检测 / 标签切换 / data-act 分派都由 AdminParts.shell 注册好了。
      if (hub.initUI) hub.initUI();
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
      // 跨模块句柄清空：离开后台后，原 window.xxx 风格的旧句柄不再可被误调用
      this._handlers = {};
    },
  };

  global.Views = global.Views || {};
  global.Views.admin = View;
})(typeof window !== 'undefined' ? window : globalThis);
