/**
 * admin-items.js — 「道具发放」tab（admin 子模块）（2026-10-03 新功能：道具系统）
 *
 * 一期没有独立的道具后台：把 `tools/item-admin.js` 的三个动作搬到这里——
 *   1. 查目录（拿 itemId / 价格 / 稀有度）
 *   2. 按账号查「钱包 / 拥有 / 装备」
 *   3. 发道具（grant）/ 加减货币（coin）/ 定义兑换码（code）
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.items`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定表单按钮、导出 loadItemsAdmin 到 ctx.hub，句柄记内部 teardown
 *   unmount()   → 统一清理；hub 条目由 admin.unmount 清空。
 * 异步回调恢复处一律先查 `ctx.isAlive()`，切页后不向已销毁 DOM 写入。
 *
 * ⚠️ 共用工具（esc / getToken / setToken / toast / AdminUI）由 `admin.js` 的 mount 注入；
 * 鉴权走 `x-admin-token` 头（POST）与 `?token=`（GET），与 admin-users.js 一致。
 */
(function (global) {
  'use strict';

  /** 本模块的副作用句柄（unmount 全清） */
  let _td = [];

  function mount(ctx) {
    const { $, esc, getToken, setToken, toast, hub } = ctx;
    const on = ctx.on;
    const alive = () => ctx.isAlive();
    // 空/加载态统一走 admin.js 注入的 AdminUI
    const empty = (t) => (ctx.AdminUI ? ctx.AdminUI.empty(t) : '');
    const loading = (t) => (ctx.AdminUI ? ctx.AdminUI.loading(t) : '');

    let CATALOG = [];
    let ASSETS = [];
    const BY_ID = new Map();

    function authHeaders() {
      return { 'Content-Type': 'application/json', 'x-admin-token': getToken() };
    }

    async function apiGet(path) {
      const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken() || '')}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
      return data;
    }
    async function apiPost(path, body) {
      const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
      return data;
    }
    // 令牌失效 → 退回登录态（与 admin-users/admin-audit 同一处理）
    function onErr(e) {
      if (!alive()) return;
      const msg = (e && e.message) || '操作失败';
      if (/40[13]|无权|令牌|登录/.test(msg)) {
        setToken(null);
        toast('管理员登录已失效，请重新登录');
        if (hub.initUI) hub.initUI();
        return;
      }
      toast(msg);
    }

    // ---------------- 目录 ----------------

    async function loadItemsAdmin() {
      const box = $('itemsCatalogList');
      if (box) box.innerHTML = loading('正在加载道具目录…');
      try {
        const data = await apiGet('/api/admin/items/catalog');
        if (!alive()) return;
        CATALOG = data.catalog || [];
        BY_ID.clear();
        for (const it of CATALOG) BY_ID.set(it.id, it);
        renderCatalog();
        fillItemSelect();
        loadAssets();
        loadBgmRoles();
      } catch (e) {
        if (!alive()) return;
        if (box) box.innerHTML = empty('加载道具目录失败');
        onErr(e);
      }
    }

    function renderCatalog() {
      const box = $('itemsCatalogList');
      if (!box) return;
      if (!CATALOG.length) { box.innerHTML = empty('目录为空'); return; }
      const cnt = $('itemsCatalogCount');
      if (cnt) cnt.textContent = CATALOG.length;
      const rows = CATALOG.map((it) => `
        <div class="record-item" style="font-size:13px;display:flex;gap:10px;align-items:center;">
          <span style="flex:1;">${esc(it.name || it.id)}
            <span style="color:var(--text-dim);font-size:11px;">${esc(it.id)} · ${esc(it.type)}${it.rarity ? ' · ' + esc(it.rarity) : ''}</span></span>
          <span style="color:${it.price === null ? 'var(--green)' : 'var(--gold-light)'};font-size:12px;">${it.price === null ? '免费' : esc(String(it.price)) + ' 币'}</span>
          <button class="btn btn-ghost btn-sm" data-edit-item="${esc(it.id)}" type="button">编辑</button>
          <button class="btn btn-ghost btn-sm" data-del-item="${esc(it.id)}" type="button">删除</button>
        </div>`).join('');
      box.innerHTML = rows;
      // 目录列表整块重建、容器是静态元素 —— 用 onclick 赋值（每次覆盖，不累积监听器）
      box.onclick = (e) => {
        const ed = e.target.closest && e.target.closest('[data-edit-item]');
        if (ed) return fillItemForm(ed.getAttribute('data-edit-item'));
        const del = e.target.closest && e.target.closest('[data-del-item]');
        if (del) return deleteItem(del.getAttribute('data-del-item'));
      };
    }

    function fillItemForm(id) {
      const it = BY_ID.get(id);
      if (!it) return;
      const setv = (fid, v) => { const n = $(fid); if (n) n.value = v == null ? '' : String(v); };
      setv('itemEditId', it.id);
      setv('itemEditType', it.type);
      setv('itemEditName', it.name);
      setv('itemEditDesc', it.desc);
      setv('itemEditRarity', it.rarity || 'N');
      setv('itemEditPrice', it.price === null || it.price === undefined ? '' : it.price);
      setv('itemEditAsset', it.asset && it.asset.value);
      // BGM 场景选择
      const roleEl = $('itemEditBgmRole');
      if (roleEl) {
        roleEl.style.display = it.type === 'bgm' ? '' : 'none';
        roleEl.value = it.role || '';
      }
    }

    async function upsertItem() {
      const id = (($('itemEditId') && $('itemEditId').value) || '').trim();
      const type = $('itemEditType') && $('itemEditType').value;
      const name = (($('itemEditName') && $('itemEditName').value) || '').trim();
      const desc = (($('itemEditDesc') && $('itemEditDesc').value) || '').trim();
      const rarity = $('itemEditRarity') && $('itemEditRarity').value;
      const priceRaw = (($('itemEditPrice') && $('itemEditPrice').value) || '').trim();
      const assetVal = (($('itemEditAsset') && $('itemEditAsset').value) || '').trim();

      if (!id || !type || !assetVal) return toast('请填写 id / 类型 / 素材 URL');
      const price = priceRaw === '' ? null : Number(priceRaw);
      if (price !== null && !Number.isFinite(price)) return toast('价格必须是数字或留空（免费）');
      const kind = type === 'bgm' ? 'audio' : (assetVal.charAt(0) === '/' ? 'image' : 'glyph');
      const roleVal = type === 'bgm' && $('itemEditBgmRole') ? (($('itemEditBgmRole').value) || '').trim() : '';
      try {
        const body = {
          id, type: type === 'bgm' ? 'bgm' : type, name: name || id, desc, rarity, price,
          asset: { kind, value: assetVal },
        };
        if (type === 'bgm' && roleVal) body.role = roleVal;
        const r = await apiPost('/api/admin/items/catalog', body);
        if (!alive()) return;
        toast(`已保存商品「${(r.item && r.item.name) || id}」`);
        loadItemsAdmin();
      } catch (e) { onErr(e); }
    }

    async function deleteItem(id) {
      if (!confirm(`确认删除商品 ${id}？（内置项会提示不可删）`)) return;
      try {
        await apiPost(`/api/admin/items/catalog/${encodeURIComponent(id)}/delete`, {});
        if (!alive()) return;
        toast('已删除');
        loadItemsAdmin();
      } catch (e) { onErr(e); }
    }

    // ---------------- 素材上传 ----------------

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || '');
          const i = s.indexOf(',');
          resolve(i >= 0 ? s.slice(i + 1) : s);
        };
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
    }

    async function doUpload() {
      const kind = $('uploadKind') && $('uploadKind').value;
      const name = (($('uploadName') && $('uploadName').value) || '').trim();
      const input = $('uploadFile');
      const file = input && input.files && input.files[0];
      const out = $('uploadResult');
      if (!file) return toast('请选择文件');
      if (out) out.textContent = '上传中…';
      try {
        const data = await fileToBase64(file);
        const r = await apiPost('/api/admin/items/upload', {
          kind, filename: name || file.name, data,
        });
        if (!alive()) return;
        const a = r.asset || {};
        if (out) {
          out.innerHTML = `<span style="color:var(--green);">上传成功</span> `
            + `素材 URL：<code>${esc(a.url || '')}</code>`
            + (a.width ? ` · ${a.width}×${a.height}` : '')
            + ` · ${a.id}`;
        }
        // 回填到商品表单
        const assetInput = $('itemEditAsset');
        if (assetInput) assetInput.value = a.url || '';
        const typeSel = $('itemEditType');
        if (typeSel) typeSel.value = kind === 'bgm' ? 'bgm' : kind === 'sprite' ? 'sprite' : 'avatar';
        const nameInput = $('itemEditName');
        if (nameInput && !nameInput.value) nameInput.value = a.name || '';
        loadAssetOptions();
        toast('素材已上传');
      } catch (e) {
        if (!alive()) return;
        if (out) out.innerHTML = `<span style="color:var(--danger);">${esc(e.message || '上传失败')}</span>`;
        onErr(e);
      }
    }

    // ---------------- BGM 三轨 ----------------

    /** 内置 OST + 已上传音频，灌进三个下拉 */
    function loadAssetOptions() {
      const builtin = [
        ['/music/loop.mp3', 'loop（内置）'],
        ['/music/静弈.mp3', '静弈（内置）'],
        ['/music/制勝.mp3', '制勝（内置）'],
        ['/music/深层沉浸.mp3', '深层沉浸（内置）'],
        ['/music/空弦.mp3', '空弦（内置）'],
      ];
      const uploaded = (ASSETS || []).filter((a) => a.kind === 'bgm').map((a) => [a.url, `${a.name || a.id}（上传）`]);
      const opts = [['', '（静音）']].concat(builtin, uploaded);
      for (const id of ['bgmMenu', 'bgmGame', 'bgmEndgame']) {
        const sel = $(id);
        if (!sel) continue;
        const keep = sel.value;
        sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
        if (keep) sel.value = keep;
      }
    }

    async function loadBgmRoles() {
      try {
        const d = await apiGet('/api/admin/items/bgm-roles');
        if (!alive()) return;
        const r = d.roles || {};
        if ($('bgmMenu')) $('bgmMenu').value = r.menu || '';
        if ($('bgmGame')) $('bgmGame').value = r.game || '';
        if ($('bgmEndgame')) $('bgmEndgame').value = r.endgame || '';
      } catch (e) { onErr(e); }
    }

    async function saveBgmRoles() {
      const menu = ($('bgmMenu') && $('bgmMenu').value) || '';
      const game = ($('bgmGame') && $('bgmGame').value) || '';
      const endgame = ($('bgmEndgame') && $('bgmEndgame').value) || '';
      try {
        await apiPost('/api/admin/items/bgm-roles', { menu, game, endgame });
        if (!alive()) return;
        toast('BGM 三轨已保存');
      } catch (e) { onErr(e); }
    }

    async function loadAssets() {
      try {
        const d = await apiGet('/api/admin/items/assets');
        if (!alive()) return;
        ASSETS = d.assets || [];
        loadAssetOptions();
      } catch (_) { /* 素材列表失败不阻断目录 */ }
    }

    /** 把目录灌进「发道具 / 兑换码」两个下拉 */
    function fillItemSelect() {
      for (const id of ['itemGrantId', 'itemCodeId']) {
        const sel = $(id);
        if (!sel) continue;
        const keep = sel.value;
        sel.innerHTML = (id === 'itemCodeId' ? '<option value="">（仅发币，不发道具）</option>' : '')
          + CATALOG.map((it) => `<option value="${esc(it.id)}">${esc(it.name || it.id)}（${esc(it.type)}）</option>`).join('');
        if (keep && BY_ID.has(keep)) sel.value = keep;
      }
    }

    // ---------------- 查账号 ----------------

    async function lookupAccount() {
      const raw = (($('itemAccountId') && $('itemAccountId').value) || '').trim();
      const box = $('itemAccountResult');
      if (!raw) { if (box) box.innerHTML = empty('请填写账号 id'); return null; }
      if (box) box.innerHTML = loading('正在查询…');
      try {
        const data = await apiGet(`/api/admin/items/account/${encodeURIComponent(raw)}`);
        if (!alive()) return null;
        renderAccount(data);
        return data;
      } catch (e) {
        if (!alive()) return null;
        if (box) box.innerHTML = empty(e.message || '查询失败');
        return null;
      }
    }

    function renderAccount(data) {
      const box = $('itemAccountResult');
      if (!box) return;
      const owned = (data.owned || []).map((id) => {
        const it = BY_ID.get(id);
        return `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:6px;background:var(--bg-3);font-size:12px;">${esc(it ? (it.name || id) : id)}</span>`;
      }).join('') || '<span style="color:var(--text-dim);font-size:12px;">（无）</span>';
      const eq = Object.entries(data.equipped || {}).filter(([, v]) => v)
        .map(([k, v]) => {
          const it = BY_ID.get(v);
          return `${esc(k)} = ${esc(it ? (it.name || v) : v)}`;
        }).join('、') || '（无）';
      box.innerHTML = `
        <div style="font-size:13px;line-height:1.9;">
          <div>账号：<b>${esc(data.accountId)}</b></div>
          <div>💰 货币：<b style="color:var(--gold-light);">${esc(String(data.wallet && data.wallet.coin || 0))}</b></div>
          <div>拥有（${(data.owned || []).length} 件）：${owned}</div>
          <div style="color:var(--text-dim);font-size:12px;">已装备：${eq}</div>
        </div>`;
    }

    // ---------------- 发放动作 ----------------

    async function doGrant() {
      const raw = (($('itemAccountId') && $('itemAccountId').value) || '').trim();
      const itemId = $('itemGrantId') && $('itemGrantId').value;
      if (!raw || !itemId) return toast('请先填写账号并选择道具');
      if (!confirm(`确认给 ${raw} 发放「${(BY_ID.get(itemId) || {}).name || itemId}」？`)) return;
      try {
        const r = await apiPost(`/api/admin/items/account/${encodeURIComponent(raw)}/grant`, { itemId });
        if (!alive()) return;
        toast(`已发放（该账号现拥有 ${r.owned.length} 件）`);
        lookupAccount();
      } catch (e) { onErr(e); }
    }

    async function doCoin() {
      const raw = (($('itemAccountId') && $('itemAccountId').value) || '').trim();
      const amount = Number((($('itemCoinAmount') && $('itemCoinAmount').value) || '').trim());
      if (!raw || !Number.isFinite(amount) || amount === 0) return toast('请填写账号与非零整数金额');
      if (!confirm(`确认给 ${raw} ${amount > 0 ? '增加' : '扣减'} ${Math.abs(amount)} 货币？`)) return;
      try {
        const r = await apiPost(`/api/admin/items/account/${encodeURIComponent(raw)}/coin`, { amount });
        if (!alive()) return;
        toast(`已处理，该账号货币现为 ${r.wallet.coin}`);
        lookupAccount();
      } catch (e) { onErr(e); }
    }

    async function doCode() {
      const code = (($('itemCode') && $('itemCode').value) || '').trim();
      const itemId = (($('itemCodeId') && $('itemCodeId').value)) || '';
      const coin = Number((($('itemCodeCoin') && $('itemCodeCoin').value) || '').trim()) || 0;
      const maxUses = Number((($('itemCodeMax') && $('itemCodeMax').value) || '').trim()) || 1;
      if (!code) return toast('请填写兑换码');
      if (!itemId && !coin) return toast('兑换码至少要发一件道具或一些货币');
      try {
        const r = await apiPost('/api/admin/items/code', { code, itemId: itemId || null, coin, maxUses });
        if (!alive()) return;
        toast(`兑换码已定义：道具=${(BY_ID.get(itemId) || {}).name || '（无）'} 币=${r.code.coin} 上限=${r.code.maxUses}`);
      } catch (e) { onErr(e); }
    }

    // ---------------- 事件绑定（本模块自己绑，句柄记 teardown 由 unmount 全清）----------------
    const bind = (id, fn) => { on($(id), 'click', fn); };
    bind('btnItemsRefresh', () => loadItemsAdmin());
    bind('btnItemLookup', () => lookupAccount());
    bind('btnItemGrant', () => doGrant());
    bind('btnItemCoin', () => doCoin());
    bind('btnItemCode', () => doCode());
    bind('btnUpload', () => doUpload());
    bind('btnItemUpsert', () => upsertItem());
    bind('btnBgmRoles', () => saveBgmRoles());

    // 类型切换时显示/隐藏 BGM 场景选择器
    const typeEl = $('itemEditType');
    if (typeEl) on(typeEl, 'change', () => {
      const roleEl = $('itemEditBgmRole');
      if (roleEl) roleEl.style.display = typeEl.value === 'bgm' ? '' : 'none';
    });

    // 供 admin-shell 的 tab 派发调用（走 hub，不再挂 window.loadItemsAdmin）
    hub.loadItemsAdmin = loadItemsAdmin;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.items = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);
