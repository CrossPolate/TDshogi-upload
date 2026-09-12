/**
 * piece-kinds.js — 棋种映射的单一来源（PLAN §M6 优化第一步）
 *
 * 背景：此前棋种映射散在三处且各自维护——
 *   - `board.js` 的 NAME_TO_KEY（渲染用）
 *   - `freeboard.js` 的 PROMOTE / DEMOTE / DROP_NAME（走子、吃子、升变用）
 *   - 服务端 `game.js` 的 KIND_NAME（权威命名）
 * 重复即风险：PLAN §J3 的「吃馬却多出飞车」就是 DEMOTE 表里 `'馬': '飛'` 写错一个字，
 * 潜伏到用户在棋盘上吃子才暴露。
 *
 * 对策：前端所有棋种映射收敛到本文件，并在加载时做**互逆自检**——
 * 只要有人再写错，控制台立刻报错，不等用户发现。
 * 纯数据 + 纯函数，可被 Node 单元测试直接加载（tests/piece-kinds.test.js）。
 */
(function (global) {
  /** 未成 → 成（中文名，与服务端 KIND_NAME 一致） */
  const PROMOTE = {
    '歩': 'と', '香': '成香', '桂': '成桂', '銀': '成銀', '角': '馬', '飛': '龍',
  };

  /**
   * 成 → 未成（吃子进驹台、双击降级用）。
   * 含日式别名：杏=成香、圭=成桂、全=成銀、馬=角成、龍=飛成。
   * ⚠️ 曾把 '馬' 错写成 '飛'（PLAN §J3），互逆自检会拦住这类错误。
   */
  const DEMOTE = {
    'と': '歩',
    '成香': '香', '杏': '香',
    '成桂': '桂', '圭': '桂',
    '成銀': '銀', '全': '銀',
    '馬': '角',
    '龍': '飛',
  };

  /** 打子符号 → 中文名（服务端 legalTargets 用 P/L/N/S/G/B/R） */
  const DROP_NAME = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛' };

  /** 中文名 → 打子符号（DROP_NAME 的反查） */
  const NAME_TO_DROP = {};
  for (const [sym, name] of Object.entries(DROP_NAME)) NAME_TO_DROP[name] = sym;

  /** 中文名 → shogi.js kind（渲染图集用；与服务端 KIND_NAME 对应） */
  const NAME_TO_KEY = {
    '歩': 'FU', '香': 'KY', '桂': 'KE', '銀': 'GI', '金': 'KI',
    '角': 'KA', '飛': 'HI', '玉': 'OU', '王': 'OU',
    'と': 'TO', '杏': 'NY', '圭': 'NK', '全': 'NG', '馬': 'UM', '龍': 'RY',
    '成香': 'NY', '成桂': 'NK', '成銀': 'NG',
  };

  /** 成駒名集合（用于 promoted 判定与降级） */
  const PROMOTED_NAMES = new Set([
    'と', '成香', '杏', '成桂', '圭', '成銀', '全', '馬', '龍',
  ]);

  /** 任意棋名 → 原始（未成）棋种：吃子进驹台时用它 */
  function rawOf(name) {
    return DEMOTE[name] || name;
  }

  /** 棋名 → 成駒名（不可升变返回 null，如金/玉） */
  function promoteOf(name) {
    return PROMOTE[name] || null;
  }

  /** 是否成駒 */
  function isPromoted(name) {
    return PROMOTED_NAMES.has(name);
  }

  /** 棋名 → 打子符号（不可打的成駒/玉返回 null） */
  function dropSymOf(name) {
    return NAME_TO_DROP[name] || null;
  }

  /** 打子符号 → 中文名 */
  function nameOfDrop(sym) {
    return DROP_NAME[sym] || null;
  }

  /**
   * 映射自检：PROMOTE 与 DEMOTE 必须严格互逆，且每个别名都要能还原。
   * @returns {string[]} 错误列表（空数组 = 健康）
   */
  function validate() {
    const errs = [];
    for (const [base, promo] of Object.entries(PROMOTE)) {
      if (DEMOTE[promo] !== base) {
        errs.push(`PROMOTE/DEMOTE 不互逆：${base} → ${promo} → ${DEMOTE[promo] || '(缺失)'}`);
      }
    }
    for (const [promo, base] of Object.entries(DEMOTE)) {
      if (PROMOTE[base] === undefined) {
        errs.push(`DEMOTE 的 ${promo} → ${base}，但 ${base} 不在 PROMOTE 中`);
      }
    }
    for (const [sym, name] of Object.entries(DROP_NAME)) {
      if (NAME_TO_DROP[name] !== sym) errs.push(`DROP_NAME 反查不一致：${sym} / ${name}`);
    }
    return errs;
  }

  global.PieceKinds = {
    PROMOTE, DEMOTE, DROP_NAME, NAME_TO_DROP, NAME_TO_KEY, PROMOTED_NAMES,
    rawOf, promoteOf, isPromoted, dropSymOf, nameOfDrop, validate,
  };

  // 加载即自检：写错映射会在控制台立刻报错（生产环境也只是多一次极小的计算）
  const errs = validate();
  if (errs.length && global.console && global.console.error) {
    global.console.error('[PieceKinds] 棋种映射自检失败：', errs);
  }
})(typeof window !== 'undefined' ? window : globalThis);
