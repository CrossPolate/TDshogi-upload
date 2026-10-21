/**
 * admin-items.js — 管理后台「商城 / 道具发放」两个 tab（2026-10-03 创建，2026-10-21 拆分）
 *
 * 商城 tab（#tab-shop）：
 *   1. 上传素材（头像 / 立绘 / 棋子 / 棋盘 / BGM / 读秒音）
 *   2. 素材库（预览 / 试听 / 复制 URL / 用于新商品 / 删除；被引用时服务端拒绝）
 *   3. 新建 / 覆盖商品（含 BGM 场景与「限定」标记）
 *   4. BGM 三轨（只列已上传音频，默认静音）
 *
 * 发放 tab（#tab-items）：
 *   查账号 → 发道具 / 加减货币 / 定义兑换码 / 查看流水。
 *
 * ⚠️ 2026-10-21 商城化：目录默认空，代码仓库不再自带 BGM / 头像素材。
 * 所有商品必须由管理员先上传素材、再录入目录；未上传时玩家侧全部为「无」。
 *
 * SPA 迁移（2026-10-09）：改为**被 admin View 的 mount/unmount 驱动**的函数集合
 * （`window.AdminParts.items`）——加载本文件零副作用：
 *   mount(ctx)  → 绑定表单按钮、导出 loadShopAdmin / loadItemsAdmin 到 ctx.hub
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
    let ROLES = { menu: '', game: '', endgame: '' };
    const BY_ID = new Map();
    const KIND_LABEL = { avatar: '头像', sprite: '立绘', pieces: '棋子', board: '棋盘', bgm: 'BGM', byoyomi: '读秒音' };
    const KIND_TO_TYPE = { avatar: 'avatar', sprite: 'sprite', pieces: 'pieces', board: 'board', bgm: 'bgm', byoyomi: 'byoyomi' };

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

    /** 拉目录并刷新商品列表 / 发放下拉（不碰素材与流水） */
    async function fetchCatalog() {
      const data = await apiGet('/api/admin/items/catalog');
      if (!alive()) return false;
      CATALOG = data.catalog || [];
      BY_ID.clear();
      for (const it of CATALOG) BY_ID.set(it.id, it);
      renderCatalog();
      fillItemSelect();
      return true;
    }

    /** 商城 tab：目录 + 素材库 + BGM 三轨 */
    async function loadShopAdmin() {
      const box = $('itemsCatalogList');
      if (box) box.innerHTML = loading('正在加载商品目录…');
      try {
        await fetchCatalog();
        await loadBgmRoles();   // 先拿三轨，素材下拉才知道要保留哪些“当前值”
        await loadAssets();
      } catch (e) {
        if (!alive()) return;
        if (box) box.innerHTML = empty('加载商城数据失败');
        onErr(e);
      }
    }

    /** 发放 tab：目录（供下拉）+ 流水 */
    async function loadItemsAdmin() {
      const box = $('itemAccountResult');
      try {
        await fetchCatalog();
        await loadItemsLogs();
      } catch (e) {
        if (!alive()) return;
        if (box) box.innerHTML = empty('加载道具目录失败');
        onErr(e);
      }
    }

    function renderCatalog() {
      const box = $('itemsCatalogList');
      if (!box) return;
      const cnt = $('itemsCatalogCount');
      if (cnt) cnt.textContent = CATALOG.length;
      if (!CATALOG.length) { box.innerHTML = empty('目录为空'); return; }
      const rows = CATALOG.map((it) => {
        const role = it.type === 'bgm' && it.role ? ` · ${esc({ menu: '菜单', game: '开局', endgame: '终盘' }[it.role] || it.role)}` : '';
        return `
        <div class="record-item" style="font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <span style="flex:1;min-width:180px;">${esc(it.name || it.id)}
            <span style="color:var(--text-dim);font-size:11px;">${esc(it.id)} · ${esc(it.type)}${it.rarity ? ' · ' + esc(it.rarity) : ''}${role}${it.limited ? ' · <b style="color:var(--gold-light);">限定</b>' : ''}</span></span>
          <span style="color:${it.price === null ? 'var(--green)' : 'var(--gold-light)'};font-size:12px;">${it.price === null ? '免费' : esc(String(it.price)) + ' 币'}</span>
          <button class="btn btn-ghost btn-sm" data-edit-item="${esc(it.id)}" type="button">编辑</button>
          <button class="btn btn-ghost btn-sm" data-del-item="${esc(it.id)}" type="button">删除</button>
        </div>`;
      }).join('');
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
      const limitedEl = $('itemEditLimited');
      if (limitedEl) limitedEl.checked = !!it.limited;
    }

    /** 清空商品表单（不删除已保存的商品） */
    function resetItemForm() {
      for (const id of ['itemEditId', 'itemEditName', 'itemEditDesc', 'itemEditPrice', 'itemEditAsset']) {
        const el = $(id);
        if (el) el.value = '';
      }
      const typeEl = $('itemEditType');
      if (typeEl) typeEl.value = 'avatar';
      const rarityEl = $('itemEditRarity');
      if (rarityEl) rarityEl.value = 'N';
      const roleEl = $('itemEditBgmRole');
      if (roleEl) { roleEl.value = ''; roleEl.style.display = 'none'; }
      const limitedEl = $('itemEditLimited');
      if (limitedEl) limitedEl.checked = false;
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
      const kind = itemAssetKind(type, assetVal);
      if (!kind) return toast('读秒音必须是音频文件或 default（合成音）');
      const roleVal = type === 'bgm' && $('itemEditBgmRole') ? (($('itemEditBgmRole').value) || '').trim() : '';
      // ⚠️ 2026-10-12（P1-④）：BGM 商品**必须选场景**——缺 role 的 BGM 用户买了/收到也装不上
      //（装备请求槽位退化成 'bgm' → BAD_SLOT）。服务端另有归一兜底，这里给到明确提示。
      if (type === 'bgm' && !roleVal) return toast('BGM 商品请选择使用场景（菜单 / 开局 / 终盘）');
      try {
        const body = {
          id, type, name: name || id, desc, rarity, price,
          asset: { kind, value: assetVal },
          limited: !!($('itemEditLimited') && $('itemEditLimited').checked),
        };
        if (type === 'bgm' && roleVal) body.role = roleVal;
        const r = await apiPost('/api/admin/items/catalog', body);
        if (!alive()) return;
        toast(`已保存商品「${(r.item && r.item.name) || id}」`);
        await fetchCatalog();
      } catch (e) { onErr(e); }
    }

    /** 商品表单的素材 URL → asset.kind（与服务端 normalizeItem 同口径） */
    function itemAssetKind(type, value) {
      const v = String(value || '');
      if (type === 'bgm') return 'audio';
      if (type === 'byoyomi') {
        if (/\.json(\?|$)/i.test(v)) return 'audiopack';
        if (/\.(mp3|ogg|wav)(\?|$)/i.test(v) || v.startsWith('/')) return 'audio';
        if (v === 'default' || v === 'synth') return 'synth';
        return null;
      }
      return v.startsWith('/') ? 'image' : 'glyph';
    }

    async function deleteItem(id) {
      if (!confirm(`确认删除商品 ${id}？玩家已拥有的记录不会回收，但将无法再获得/装备。`)) return;
      try {
        await apiPost(`/api/admin/items/catalog/${encodeURIComponent(id)}/delete`, {});
        if (!alive()) return;
        toast('已删除');
        await fetchCatalog();
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
        // 回填到商品表单（上传即“准备好上架”，管理员只需补价格/场景）
        const assetInput = $('itemEditAsset');
        if (assetInput) assetInput.value = a.url || '';
        const type = KIND_TO_TYPE[kind] || 'avatar';
        const typeSel = $('itemEditType');
        if (typeSel) typeSel.value = type;
        const roleEl = $('itemEditBgmRole');
        if (roleEl) {
          roleEl.style.display = type === 'bgm' ? '' : 'none';
          if (type === 'bgm' && !roleEl.value) roleEl.value = 'game';
        }
        const idInput = $('itemEditId');
        if (idInput && !idInput.value.trim()) idInput.value = `${type}-${String(a.id || '').slice(0, 8)}`;
        const nameInput = $('itemEditName');
        if (nameInput && !nameInput.value) nameInput.value = a.name || '';
        await loadAssets();
        toast('素材已上传，可直接保存商品');
      } catch (e) {
        if (!alive()) return;
        if (out) out.innerHTML = `<span style="color:var(--danger);">${esc(e.message || '上传失败')}</span>`;
        onErr(e);
      }
    }

    // ---------------- 素材库 ----------------

    async function loadAssets() {
      const box = $('shopAssetList');
      if (box && !ASSETS.length) box.innerHTML = loading('正在加载素材…');
      try {
        const d = await apiGet('/api/admin/items/assets');
        if (!alive()) return;
        ASSETS = (d.assets || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        renderAssets();
        loadAssetOptions();
      } catch (e) {
        if (!alive()) return;
        if (box) box.innerHTML = empty('素材加载失败');
        onErr(e);
      }
    }

    const KIND_ICON = { avatar: '🧑', sprite: '🎭', pieces: '♟', board: '🪵', bgm: '🎵', byoyomi: '⏱' };

    function renderAssets() {
      const box = $('shopAssetList');
      if (!box) return;
      const filter = ($('shopAssetKind') && $('shopAssetKind').value) || '';
      const list = filter ? ASSETS.filter((a) => a.kind === filter) : ASSETS;
      const cnt = $('shopAssetCount');
      if (cnt) cnt.textContent = String(ASSETS.length);
      if (!list.length) {
        box.innerHTML = empty(filter ? `暂无${KIND_LABEL[filter] || ''}素材` : '素材库为空：先在上方上传文件');
        return;
      }
      box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;">`
        + list.map((a) => {
          const isAudio = a.kind === 'bgm' || a.kind === 'byoyomi';
          const preview = isAudio
            ? `<audio controls preload="none" src="${esc(a.url)}" style="width:100%;height:32px;"></audio>`
            : `<img src="${esc(a.url)}" alt="${esc(a.name || a.id)}" loading="lazy"
                 style="max-width:100%;max-height:76px;object-fit:contain;display:block;margin:0 auto;">`;
          const meta = [
            KIND_LABEL[a.kind] || a.kind,
            a.width ? `${a.width}×${a.height}` : '',
            a.size ? `${Math.round(a.size / 1024)} KB` : '',
          ].filter(Boolean).join(' · ');
          return `<div class="record-item" style="margin:0;padding:10px;display:flex;flex-direction:column;gap:6px;cursor:default;">
            <div style="height:76px;display:flex;align-items:center;justify-content:center;background:var(--bg);border-radius:6px;overflow:hidden;">${preview}</div>
            <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(a.name || a.id)}">${KIND_ICON[a.kind] || '📦'} ${esc(a.name || a.id)}</div>
            <div style="font-size:10px;color:var(--text-dim);">${esc(meta)}</div>
            <div style="font-size:10px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(a.url)}">${esc(a.url)}</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:auto;">
              <button class="btn btn-primary btn-sm" data-use-asset="${esc(a.id)}" type="button" style="flex:1;padding:4px 6px;">用于新商品</button>
              <button class="btn btn-ghost btn-sm" data-copy-asset="${esc(a.id)}" type="button" style="padding:4px 8px;" title="复制素材 URL">复制</button>
              <button class="btn btn-ghost btn-sm" data-del-asset="${esc(a.id)}" type="button" style="padding:4px 8px;color:var(--red-light);" title="删除素材（被商品引用时会拒绝）">删除</button>
            </div>
          </div>`;
        }).join('') + '</div>';

      // 列表整块重建、容器是静态元素 —— 用 onclick 赋值（每次覆盖，不累积监听器）
      box.onclick = (e) => {
        const use = e.target.closest && e.target.closest('[data-use-asset]');
        if (use) return useAsset(use.getAttribute('data-use-asset'));
        const cp = e.target.closest && e.target.closest('[data-copy-asset]');
        if (cp) return copyAsset(cp.getAttribute('data-copy-asset'));
        const del = e.target.closest && e.target.closest('[data-del-asset]');
        if (del) return deleteAsset(del.getAttribute('data-del-asset'));
      };
    }

    function useAsset(id) {
      const a = ASSETS.find((x) => x.id === id);
      if (!a) return;
      const type = KIND_TO_TYPE[a.kind] || 'avatar';
      const setv = (fid, v) => { const n = $(fid); if (n) n.value = v; };
      setv('itemEditId', `${type}-${String(a.id).slice(0, 8)}`);
      setv('itemEditType', type);
      setv('itemEditName', a.name || a.id);
      setv('itemEditAsset', a.url);
      const roleEl = $('itemEditBgmRole');
      if (roleEl) {
        roleEl.style.display = type === 'bgm' ? '' : 'none';
        if (type === 'bgm' && !roleEl.value) roleEl.value = 'game';
      }
      const target = $('itemEditId');
      if (target && target.scrollIntoView) {
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { target.scrollIntoView(); }
      }
      toast('已填入商品表单，请补价格后保存');
    }

    async function copyAsset(id) {
      const a = ASSETS.find((x) => x.id === id);
      if (!a) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(a.url);
        } else {
          const ta = document.createElement('textarea');
          ta.value = a.url;
          ta.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        toast('素材 URL 已复制');
      } catch (_) { toast('复制失败，请手动选择 URL'); }
    }

    async function deleteAsset(id) {
      const a = ASSETS.find((x) => x.id === id);
      if (!confirm(`确认删除素材「${(a && (a.name || a.id)) || id}」？被商品 / BGM 三轨引用时会被拒绝。`)) return;
      try {
        await apiPost(`/api/admin/items/assets/${encodeURIComponent(id)}/delete`, {});
        if (!alive()) return;
        toast('素材已删除');
        await loadAssets();
      } catch (e) { onErr(e); }
    }

    // ---------------- BGM 三轨 ----------------

    /** 只列已上传 BGM + 三轨当前值（仓库不再有内置曲） */
    function loadAssetOptions() {
      const uploaded = (ASSETS || []).filter((a) => a.kind === 'bgm').map((a) => [a.url, `${a.name || a.id}（上传）`]);
      const extra = Object.values(ROLES || {}).filter((u) => u && !uploaded.some(([v]) => v === u));
      const opts = [['', '（静音）']].concat(uploaded, extra.map((u) => [u, `${u}（当前）`]));
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
        ROLES = Object.assign({ menu: '', game: '', endgame: '' }, d.roles || {});
        loadAssetOptions();   // 先补上“当前值”选项，再回填（否则外置曲会被清空）
        if ($('bgmMenu')) $('bgmMenu').value = ROLES.menu || '';
        if ($('bgmGame')) $('bgmGame').value = ROLES.game || '';
        if ($('bgmEndgame')) $('bgmEndgame').value = ROLES.endgame || '';
      } catch (e) { onErr(e); }
    }

    async function saveBgmRoles() {
      const menu = ($('bgmMenu') && $('bgmMenu').value) || '';
      const game = ($('bgmGame') && $('bgmGame').value) || '';
      const endgame = ($('bgmEndgame') && $('bgmEndgame').value) || '';
      try {
        const r = await apiPost('/api/admin/items/bgm-roles', { menu, game, endgame });
        if (!alive()) return;
        ROLES = Object.assign({ menu: '', game: '', endgame: '' }, r.roles || { menu, game, endgame });
        loadAssetOptions();
        toast('BGM 三轨已保存');
      } catch (e) { onErr(e); }
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
      // ⚠️ 2026-10-12：支持「账号 id / 令牌 / 用户名」三种输入（服务端 resolveItemTarget 终检存在性）
      if (!raw) { if (box) box.innerHTML = empty('请填写账号 id / 令牌 / 用户名'); return null; }
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
          <div>账号：<b>${esc(data.toName || data.accountId)}</b><span style="color:var(--text-dim);font-size:11px;margin-left:8px;">${esc(data.accountId)}</span></div>
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
        toast(`已发放给「${r.toName || raw}」（现拥有 ${r.owned.length} 件）`);
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
        toast(`已${amount > 0 ? '加币' : '扣币'}给「${r.toName || raw}」，货币现为 ${r.wallet.coin}`);
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

    // ---------------- 发放记录（流水）----------------

    /**
     * 拉取发放流水并渲染 —— 2026-10-12 补齐（此前只有 API 没有界面，等于看不到）。
     * 每条含：时间 / 类型 / 内容 / 收件人 / **操作人**（操作人缺失时流水无法对账）。
     */
    async function loadItemsLogs() {
      const box = $('itemsLogList');
      if (!box) return;
      box.innerHTML = loading('正在加载发放记录…');
      try {
        const d = await apiGet('/api/admin/items/logs?n=50');
        if (!alive()) return;
        const logs = d.logs || [];
        if (!logs.length) { box.innerHTML = empty('暂无发放记录'); return; }
        const KIND = { item: '发放道具', coin: '加减货币', buy: '玩家购买', redeem: '兑换码' };
        box.innerHTML = logs.map((l) => {
          const when = new Date(l.at).toLocaleString();
          const what = l.kind === 'coin'
            ? `💰 ${Number(l.coinDelta) > 0 ? '+' : ''}${l.coinDelta} 币`
            : `🎁 ${esc(l.itemId || l.kind)}`;
          return '<div class="record-item" style="font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">'
            + `<span style="color:var(--text-dim);min-width:132px;">${esc(when)}</span>`
            + `<span style="min-width:64px;">${esc(KIND[l.kind] || l.kind)}</span>`
            + `<span style="flex:1;min-width:120px;">${what}</span>`
            + `<span style="color:var(--text-dim);min-width:150px;">→ ${esc(l.accountId || '—')}</span>`
            + `<span style="color:var(--gold-light);min-width:96px;">操作人 ${esc(l.adminId || '—')}</span>`
            + '</div>';
        }).join('');
      } catch (e) {
        if (!alive()) return;
        box.innerHTML = empty('发放记录加载失败');
        onErr(e);
      }
    }

    // ---------------- 事件绑定（本模块自己绑，句柄记 teardown 由 unmount 全清）----------------
    const bind = (id, fn) => { on($(id), 'click', fn); };
    bind('btnItemsRefresh', () => loadItemsAdmin());
    bind('btnItemsLogs', () => loadItemsLogs());
    bind('btnItemLookup', () => lookupAccount());
    bind('btnItemGrant', () => doGrant());
    bind('btnItemCoin', () => doCoin());
    bind('btnItemCode', () => doCode());
    bind('btnUpload', () => doUpload());
    bind('btnItemUpsert', () => upsertItem());
    bind('btnBgmRoles', () => saveBgmRoles());
    bind('btnShopRefresh', () => loadShopAdmin());
    bind('btnShopAssetsRefresh', () => loadAssets());
    bind('btnItemReset', () => resetItemForm());

    // 素材类型筛选（纯前端过滤，不再多打一次接口）
    const assetKindEl = $('shopAssetKind');
    if (assetKindEl) on(assetKindEl, 'change', () => renderAssets());

    // 类型切换时显示/隐藏 BGM 场景选择器
    const typeEl = $('itemEditType');
    if (typeEl) on(typeEl, 'change', () => {
      const roleEl = $('itemEditBgmRole');
      if (roleEl) roleEl.style.display = typeEl.value === 'bgm' ? '' : 'none';
    });

    // 供 admin-shell 的 tab 派发调用（走 hub，不再挂 window.loadItemsAdmin）
    hub.loadShopAdmin = loadShopAdmin;
    hub.loadItemsAdmin = loadItemsAdmin;
  }

  function unmount() {
    _td.forEach((fn) => { try { fn(); } catch (_) {} });
    _td = [];
  }

  global.AdminParts = global.AdminParts || {};
  global.AdminParts.items = { mount, unmount };
})(typeof window !== 'undefined' ? window : globalThis);
