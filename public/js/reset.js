'use strict';

/**
 * reset.js — 密码找回 / 重置页（1.7）。
 * 无 token：输入用户名或已验证邮箱申请重置；带 token：设置新密码。
 */
(function (global) {
  'use strict';

  const View = {
    title: '找回密码 · TDShogi',
    render() {
      const token = new URLSearchParams(location.search).get('token') || '';
      return `
  <main class="container">
    <div class="card" style="padding:22px;max-width:480px;margin:32px auto;">
      <div style="font-size:18px;font-weight:800;color:var(--gold-light);margin-bottom:8px;">找回密码</div>
      <div id="resetNoToken" style="display:${token ? 'none' : 'block'};">
        <div style="font-size:12px;color:var(--text-dim);line-height:1.8;margin-bottom:12px;">
          输入账号用户名或已验证邮箱。若账号存在且邮箱已验证，会收到重置链接。
        </div>
        <input class="input" id="resetIdentifier" placeholder="用户名或邮箱" style="margin-bottom:10px;">
        <button class="btn btn-primary" id="btnForgot" style="width:100%;">发送重置邮件</button>
      </div>
      <div id="resetWithToken" style="display:${token ? 'block' : 'none'};">
        <div style="font-size:12px;color:var(--text-dim);line-height:1.8;margin-bottom:12px;">
          设置新密码。提交后该账号所有旧会话会立即失效。
        </div>
        <input type="password" class="input" id="resetPassword" placeholder="新密码（至少 8 位）" style="margin-bottom:10px;">
        <input type="password" class="input" id="resetPassword2" placeholder="确认新密码" style="margin-bottom:10px;">
        <button class="btn btn-primary" id="btnReset" style="width:100%;">设置新密码</button>
      </div>
      <div id="resetMsg" role="status" aria-live="polite" style="margin-top:12px;font-size:12px;color:var(--gold-light);line-height:1.7;"></div>
      <div style="margin-top:16px;"><a class="btn btn-ghost btn-sm" href="index.html">返回首页</a></div>
    </div>
  </main>`;
    },
    mount() {
      this._teardown = [];
      const $ = (id) => global.UI.$(id);
      const toast = (m) => global.UI.toast(m);
      const token = new URLSearchParams(location.search).get('token') || '';
      const teardown = this._teardown;
      const msg = (text, err) => {
        const el = $('resetMsg');
        if (!el) return;
        el.textContent = text;
        el.style.color = err ? 'var(--red-light)' : 'var(--gold-light)';
      };
      const on = (id, fn) => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('click', fn);
        teardown.push(() => el.removeEventListener('click', fn));
      };

      on('btnForgot', async () => {
        const identifier = (($('resetIdentifier') && $('resetIdentifier').value) || '').trim();
        if (!identifier) return msg('请输入用户名或邮箱', true);
        msg('正在发送…');
        try {
          const r = await fetch('/api/account/password/forgot', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return msg(d.error || '发送失败', true);
          msg(d.message || '如果该账号存在，重置邮件会很快送达');
        } catch (_) { msg('发送失败，请稍后重试', true); }
      });

      on('btnReset', async () => {
        const p1 = (($('resetPassword') && $('resetPassword').value) || '');
        const p2 = (($('resetPassword2') && $('resetPassword2').value) || '');
        if (!p1 || p1 !== p2) return msg('两次密码不一致', true);
        msg('正在重置…');
        try {
          const r = await fetch('/api/account/password/reset', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password: p1 }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return msg(d.error || '重置失败', true);
          toast('密码已重置，请重新登录');
          msg('密码已重置。旧会话已失效，请用新密码登录。');
          setTimeout(() => global.Router.navigate('profile.html'), 800);
        } catch (_) { msg('重置失败，请稍后重试', true); }
      });
    },
    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.reset = View;
})(window);
