/* global fmtTime */
/**
 * admin-audit.js — 操作审计
 *
 * §M5（2026-09-28）：从 `public/js/admin.js`（原 1254 行）按 tab **整段原样搬出**，
 * 逻辑一字未改，只整体左移 2 格缩进。共用工具（token / $ / esc / maskIp / 分页）仍由
 * `admin.js` 装配时注入（见下方 `make(deps)`）。
 *
 * ⚠️ 本文件必须在 `admin.js` **之前**加载（见 public/admin.html 的 <script> 顺序）；
 * `admin.js` 装配时会检查，缺失即抛错——不然症状是"某个 tab 点了没反应"这种静默故障。
 */
(function (global) {
  'use strict';

  function make(deps) {
    // 共用工具（由 admin.js 装配时注入）
    const { esc, getToken, maskIp, renderPaged, setToken, toast } = deps;

    // ---- 操作审计（PLAN §K4）----
    let allAudit = [];

    // ⚠️ 2026-10-02 体验修复（审计筛选 + 分页）：分页此前已有（renderPaged + auditPager），
    // 但只能从头一页页翻着找记录；这里补上「动作 / 结果 / 时间」三维筛选——
    // 三者都在**前端**对已下载的这批记录（接口一次最多 200 条）做过滤，不额外打服务端。
    // 筛选变化时回到第 1 页（否则筛选后停在旧页码上会看到"空列表"，与举报页同款取巧）。
    const auditFilter = { action: '', ok: '', hours: '' };
    let auditFilterReady = false;

    /** 统一取列表容器 */
    function auditListEl() { return document.getElementById('auditList'); }

    async function loadAudit() {
      // ⚠️ 2026-10-02 体验修复（加载态统一）：先铺"正在加载"占位——此前是上一轮的残留/一片空白，
      // 点开 tab 的头几百毫秒看起来像页面坏了（尤其这条接口是 heavy 限流档）。
      const box = auditListEl();
      if (box) box.innerHTML = window.AdminUI ? window.AdminUI.loading('正在加载审计记录…') : '';
      try {
        const data = await window.ApiUtils.get(`/api/admin/audit?token=${encodeURIComponent(getToken())}`);
        allAudit = data.events || [];
        initAuditFilters();
        renderAuditFiltered(false);
      } catch (e) {
        if (e.message && (e.message.includes('403') || e.message.includes('401'))) {
          setToken(null);
          // ⚠️ 2026-10-02 体验修复：令牌过期/失效时回退到登录态（此前只清 token，
          // 页面仍停在后台样式 → 后续每个请求继续 403，看起来像后台彻底坏了）
          location.reload();
          return;
        }
        toast('加载审计记录失败');
        if (box) box.innerHTML = window.AdminUI
          ? window.AdminUI.empty(`加载审计记录失败：${(e && e.message) || '网络错误'}`) : '';
      }
    }

    /** 时间范围（小时）→ 起始时间戳；未选则返回 0（不过滤） */
    function auditSince() {
      const h = parseFloat(auditFilter.hours);
      return Number.isFinite(h) && h > 0 ? Date.now() - h * 3600 * 1000 : 0;
    }

    /** 按当前筛选条件过滤全量记录 */
    function filteredAudit() {
      const since = auditSince();
      return allAudit.filter((e) => {
        if (auditFilter.action && String(e.action || '') !== auditFilter.action) return false;
        if (auditFilter.ok === '1' && !e.ok) return false;   // 仅成功
        if (auditFilter.ok === '0' && e.ok) return false;    // 仅失败
        if (since && !(Number(e.ts) >= since)) return false; // 时间窗
        return true;
      });
    }

    /**
     * 用当前筛选结果重画列表。
     * @param {boolean} reset 仅**筛选条件变化**时传 true（回到第 1 页）；
     *   翻页路径（adminPage → loadAudit）必须传 false，否则每次翻页都被重置回第 1 页。
     */
    function renderAuditFiltered(reset) {
      const list = filteredAudit();
      renderPaged('audit', list, 'auditPager', renderAudit, !!reset);
      const hint = document.getElementById('auditFilterHint');
      if (hint) {
        const active = !!(auditFilter.action || auditFilter.ok || auditFilter.hours);
        hint.textContent = active
          ? `已筛选：命中 ${list.length} / 共 ${allAudit.length} 条`
          : `共 ${allAudit.length} 条`;
      }
    }

    /**
     * 初始化筛选控件：动作下拉按**实际出现过的动作**填充；三个控件与"清除筛选"只绑一次。
     * 事件绑一次即可（控件是 admin.html 里的静态元素，不像列表那样整块重建）。
     */
    function initAuditFilters() {
      const actSel = document.getElementById('auditAction');
      const okSel = document.getElementById('auditOk');
      const rngSel = document.getElementById('auditRange');
      if (actSel) {
        const acts = [...new Set(allAudit.map((e) => String(e.action || '')).filter(Boolean))].sort();
        const keep = auditFilter.action;
        actSel.innerHTML = '<option value="">全部</option>'
          + acts.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
        actSel.value = acts.includes(keep) ? keep : '';
        auditFilter.action = actSel.value;
      }
      if (auditFilterReady) return;
      auditFilterReady = true;
      if (actSel) actSel.addEventListener('change', () => { auditFilter.action = actSel.value; renderAuditFiltered(true); });
      if (okSel) okSel.addEventListener('change', () => { auditFilter.ok = okSel.value; renderAuditFiltered(true); });
      if (rngSel) rngSel.addEventListener('change', () => { auditFilter.hours = rngSel.value; renderAuditFiltered(true); });
      const resetBtn = document.getElementById('btnAuditReset');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        auditFilter.action = '';
        auditFilter.ok = '';
        auditFilter.hours = '';
        if (actSel) actSel.value = '';
        if (okSel) okSel.value = '';
        if (rngSel) rngSel.value = '';
        renderAuditFiltered(true);
      });
    }

    /**
     * ⚠️ 2026-10-02 体验修复（审计 IP 掩码）：来源 IP 默认只显示到**网段**（maskIp），
     * 点击可展开完整地址。IP 属隐私数据，审计页又最容易被整屏截图——默认掩码挡掉
     * "随手截图外流"；保留网段则不牺牲可核对性（同一网段的操作仍能对上号）。
     * 复用与用户列表 / IP 封禁页同一个 `reveal-ip` 动作（admin-shell.js 已注册还原逻辑）。
     */
    function auditIpHtml(ip) {
      if (!ip) return '—';
      return `<span title="点击展开完整 IP" style="cursor:pointer;border-bottom:1px dashed var(--text-dim);" data-act="reveal-ip" data-text="${esc(ip)}">${esc(maskIp(ip))}</span>`;
    }

    function renderAudit(events) {
      // ⚠️ 2026-10-02 体验修复：标题数字用**总数**（此前用当页条数，恒 ≤20，管理员会误判量级）
      document.getElementById('auditCount').textContent = allAudit.length;
      const el = document.getElementById('auditList');
      if (!events.length) {
        // ⚠️ 2026-10-02 体验修复（空状态统一）：区分"本来就空"与"被筛空"，
        // 免得筛完没结果时让人以为审计坏了。
        const filtered = !!(auditFilter.action || auditFilter.ok || auditFilter.hours);
        const msg = filtered ? '没有符合当前筛选的操作记录（可点「清除筛选」）' : '暂无管理员操作记录';
        el.innerHTML = window.AdminUI ? window.AdminUI.empty(msg) : '';
        return;
      }
      el.innerHTML = events.map((e) => `
        <div class="record-item">
          <div style="font-size:13px;display:flex;justify-content:space-between;gap:10px;">
            <span>${esc(e.action)} ${e.targetId ? `<span style="color:var(--text-dim);font-size:11px;">→ ${esc(e.targetId)}</span>` : ''}</span>
            <span style="font-size:11px;color:${e.ok ? 'var(--green)' : 'var(--red-light)'};">${e.ok ? '成功' : '失败'}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
            ${fmtTime(e.ts)} · 来源 IP：${auditIpHtml(e.adminIp)}${e.detail ? ` · ${esc(JSON.stringify(e.detail))}` : ''}
          </div>
        </div>
      `).join('');
    }

    // ---- 供其它模块调用（admin.js 装配时按依赖顺序执行，见该文件）----
    global.loadAudit = loadAudit;

    return {
      allAudit,
      auditFilter,
      filteredAudit,
      loadAudit,
      renderAudit,
      renderAuditFiltered,
    };
  }

  global.AdminAudit = { make };
})(typeof window !== 'undefined' ? window : globalThis);
