'use strict';

/**
 * puzzles.js — 每日诘将棋 / 下一手（1.6）。
 *
 * 棋盘复用 FreeBoard 的对局交互模式；题型/解法由服务端校验，客户端只拿局面与合法走法。
 * 数据接口受 FEATURE_PUZZLES 保护；引擎不参与（题库是预先校验好的题目）。
 */
(function (global) {
  'use strict';

  const UI = global.UI;

  const View = {
    title: '每日诘将棋 · TDShogi',

    render() {
      return `
  <main class="container">
    <div class="card pz-card">
      <div class="pz-head">
        <div>
          <div class="pz-title">每日诘将棋 / 下一手</div>
          <div class="pz-sub" id="pzMeta">正在加载…</div>
        </div>
        <div class="pz-stat">
          <span id="pzStreak">连续 0 天</span>
          <span id="pzSolved">今日未完成</span>
        </div>
      </div>

      <div id="pzLoading" class="pz-placeholder">加载今日题目…</div>
      <div id="pzEmpty" class="pz-placeholder" style="display:none;"></div>

      <div id="pzGame" style="display:none;">
        <div class="pz-board-area play-main">
          <div class="board-area">
            <div class="hand-row" id="pzOppHand">
              <span class="hand-label">持驹</span>
              <div class="hand-pieces" id="pzOppHandPieces"></div>
            </div>
            <div class="board-wrap" id="pzBoard"></div>
            <div class="hand-row" id="pzMyHand">
              <span class="hand-label">持驹</span>
              <div class="hand-pieces" id="pzMyHandPieces"></div>
            </div>
          </div>
        </div>
        <div class="pz-msg" id="pzMsg" role="status" aria-live="polite"></div>
        <div class="pz-actions">
          <button class="btn btn-ghost btn-sm" id="pzReset" type="button">重新开始</button>
          <button class="btn btn-ghost btn-sm" id="pzShowSolution" type="button" style="display:none;">查看解法</button>
          <a class="btn btn-ghost btn-sm" href="index.html">返回首页</a>
        </div>
        <div class="pz-hint">提示：先找王手与必至；答错不会泄露答案。每日题按日本时间零点切换。</div>
      </div>
    </div>
  </main>`;
    },

    mount(container) {
      this._teardown = [];
      let alive = true;
      this._teardown.push(() => { alive = false; });
      const $ = (id) => UI.$(id);
      const teardown = this._teardown;
      const guest = global.NAV.getGuest();
      const baseQ = `guest=${encodeURIComponent(guest.id)}`;

      let puzzle = null;
      let state = null;
      let moves = [];
      let solved = false;
      let solutionList = null;
      let board = null;
      let fb = null;
      let viewpoint = 'b';
      let initial = null;

      function setMsg(text, isErr) {
        const el = $('pzMsg');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'pz-msg' + (isErr ? ' err' : '');
      }

      function setMeta() {
        const el = $('pzMeta');
        if (!el || !puzzle) return;
        el.textContent = `${puzzle.type === 'tsume' ? '诘将棋' : '下一手'} · 难度 ${puzzle.difficulty || 1}/5`
          + (puzzle.tags && puzzle.tags.length ? ` · ${puzzle.tags.join(' / ')}` : '');
      }

      function updateStats(data) {
        if ($('pzStreak')) $('pzStreak').textContent = `连续 ${data && data.streak ? data.streak : 0} 天`;
        if ($('pzSolved')) $('pzSolved').textContent = data && data.solvedToday ? '今日已完成' : '今日未完成';
      }

      async function loadStats() {
        try {
          const r = await fetch(`/api/puzzles/me?${baseQ}`);
          const d = await r.json().catch(() => ({}));
          if (alive && r.ok) updateStats(d);
        } catch (_) { /* 统计失败不影响做题 */ }
      }

      function ensureBoard(st) {
        if (fb) return;
        board = new global.ShogiBoard($('pzBoard'), {});
        viewpoint = st.turn === 'w' ? 'w' : 'b';
        fb = new global.FreeBoard({
          board,
          viewpoint,
          interactive: false,
          mode: 'play',
          hands: {
            my: $('pzMyHandPieces'), myColor: viewpoint,
            opp: $('pzOppHandPieces'), oppColor: viewpoint === 'b' ? 'w' : 'b',
          },
          onMove: (usi) => submitMove(usi),
          onPromoteChoice: ({ usiMove, usiPromote }) => {
            submitMove(global.confirm(`这手可以升变，升变吗？\n不成：${usiMove}\n升变：${usiPromote}`) ? usiPromote : usiMove);
          },
        });
        fb.attach();
        fb.bindHands($('pzMyHandPieces'), viewpoint, $('pzOppHandPieces'), viewpoint === 'b' ? 'w' : 'b');
      }

      function applyState(st) {
        state = st;
        if (!fb) ensureBoard(st);
        const vp = st.turn === 'w' ? 'w' : 'b';
        if (vp !== viewpoint) { viewpoint = vp; fb.setViewpoint(vp); }
        fb.setModel({ board: st.board, hands: st.hands || { b: [], w: [] } }, st.lastMove || null);
        fb.setLegalTargets(st.legalTargetsBySq || {});
        fb.setInteractive(!solved);
      }

      function showGame() {
        $('pzLoading').style.display = 'none';
        $('pzEmpty').style.display = 'none';
        $('pzGame').style.display = '';
        setMeta();
        applyState(initial);
        setMsg(solved ? '今日已完成；可以重新走一遍看手顺。' : '轮到你走。');
        const solBtn = $('pzShowSolution');
        if (solBtn) {
          solBtn.style.display = solved && solutionList ? '' : 'none';
          if (solutionList) solBtn.dataset.solution = JSON.stringify(solutionList);
        }
      }

      function showEmpty(text) {
        $('pzLoading').style.display = 'none';
        $('pzGame').style.display = 'none';
        $('pzEmpty').style.display = '';
        $('pzEmpty').textContent = text;
      }

      async function loadDaily() {
        $('pzLoading').style.display = '';
        $('pzEmpty').style.display = 'none';
        $('pzGame').style.display = 'none';
        try {
          const r = await fetch(`/api/puzzles/daily?${baseQ}`);
          const d = await r.json().catch(() => ({}));
          if (!alive) return;
          if (!r.ok) { showEmpty(d.error || '每日题暂不可用'); return; }
          if (!d.puzzle) { showEmpty('题库尚未配置，请稍后再来。'); return; }
          puzzle = d.puzzle;
          initial = d.state;
          moves = [];
          solved = !!d.solved;
          solutionList = d.solution || null;
          showGame();
          loadStats();
        } catch (_) {
          if (alive) showEmpty('每日题加载失败，请刷新重试。');
        }
      }

      async function submitMove(usi) {
        if (!puzzle || !alive || solved) return;
        const next = moves.concat(usi);
        setMsg('校验中…');
        try {
          const r = await fetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/attempt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guest: guest.id, key: guest.key, moves: next }),
          });
          const d = await r.json().catch(() => ({}));
          if (!alive) return;
          if (!r.ok) {
            setMsg(d.error || '这手不对，再试试。', true);
            return;
          }
          moves = d.reply ? next.concat(d.reply) : next;
          applyState(d.state || state);
          if (d.complete) {
            solved = true;
            fb.setInteractive(false);
            setMsg('完成！今天这题解出来了。');
            const solBtn = $('pzShowSolution');
            solutionList = d.solution || [];
            if (solBtn) { solBtn.style.display = ''; solBtn.dataset.solution = JSON.stringify(solutionList); }
            loadStats();
          } else {
            setMsg(d.reply ? `正确，对手应手 ${d.reply}。继续。` : '正确，继续下一手。');
          }
        } catch (_) {
          if (alive) setMsg('提交失败，请稍后重试。', true);
        }
      }

      function reset() {
        if (!puzzle || !initial) return;
        moves = [];
        solved = false;
        applyState(initial);
        setMsg('已重新开始。');
        solutionList = null;
        const solBtn = $('pzShowSolution');
        if (solBtn) { solBtn.style.display = 'none'; delete solBtn.dataset.solution; }
      }

      function showSolution() {
        const btn = $('pzShowSolution');
        if (!btn || !btn.dataset.solution) return;
        try {
          const sol = JSON.parse(btn.dataset.solution);
          setMsg(`解法：${sol.join(' → ')}`);
        } catch (_) { setMsg('解法读取失败。'); }
      }

      function on(el, ev, fn) {
        if (!el) return;
        el.addEventListener(ev, fn);
        teardown.push(() => el.removeEventListener(ev, fn));
      }
      on($('pzReset'), 'click', reset);
      on($('pzShowSolution'), 'click', showSolution);

      loadDaily();

      teardown.push(() => { if (fb) { try { fb.destroy(); } catch (_) {} fb = null; } });
    },

    unmount() {
      (this._teardown || []).forEach((fn) => { try { fn(); } catch (_) {} });
      this._teardown = [];
    },
  };

  global.Views = global.Views || {};
  global.Views.puzzles = View;
})(window);
