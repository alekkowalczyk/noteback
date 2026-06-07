/**
 * Noteback runtime — diff.js  (PURE-LOGIC; dual-export)
 *
 * The diff "brain": a generic LCS sequence diff plus word- and block-level
 * helpers built on it. No DOM, no chrome.*, no localStorage — runs in the
 * browser (`NotebackRuntime.diff`) and under Node tests (`module.exports`).
 * The DOM-aware renderer that consumes this lives in `diff-render.js`.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.diff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Bail out of the O(n*m) LCS table above this many cells (pathological inputs)
  // and emit a coarse del-run + ins-run instead. Real docs are far smaller.
  var LCS_BUDGET = 4000000;

  function normalize(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  // Split into alternating runs of whitespace / non-whitespace, KEEPING the
  // separators, so tokens.join('') === input.
  function tokenizeWords(text) {
    var s = String(text == null ? '' : text);
    return s.match(/\s+|\S+/g) || [];
  }

  // Generic LCS diff over two arrays. `eq` defaults to ===. Returns coalesced
  // runs: [{ op:'eq'|'del'|'ins', items:[...] }]. Size-capped (see LCS_BUDGET).
  function diffSequences(a, b, eq) {
    a = a || []; b = b || [];
    eq = eq || function (x, y) { return x === y; };
    var n = a.length, m = b.length;
    if (n === 0 && m === 0) return [];
    if (n === 0) return [{ op: 'ins', items: b.slice() }];
    if (m === 0) return [{ op: 'del', items: a.slice() }];
    if (n * m > LCS_BUDGET) return [{ op: 'del', items: a.slice() }, { op: 'ins', items: b.slice() }];

    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var ops = [];
    function push(op, item) {
      var last = ops[ops.length - 1];
      if (last && last.op === op) last.items.push(item);
      else ops.push({ op: op, items: [item] });
    }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { push('eq', a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) { push('del', a[i]); i++; }
    while (j < m) { push('ins', b[j]); j++; }
    return ops;
  }

  // Word-level diff of two strings → [{ op, text }], adjacent same-op tokens
  // coalesced and rejoined.
  function diffWords(baseText, targetText) {
    return diffSequences(tokenizeWords(baseText), tokenizeWords(targetText))
      .map(function (r) { return { op: r.op, text: r.items.join('') }; });
  }

  // 0..1 similarity by shared-word ratio (Dice over normalized word multisets).
  function similarity(aText, bText) {
    var aw = normalize(aText).split(' ').filter(Boolean);
    var bw = normalize(bText).split(' ').filter(Boolean);
    if (aw.length === 0 && bw.length === 0) return 1;
    if (aw.length === 0 || bw.length === 0) return 0;
    var counts = {};
    aw.forEach(function (w) { counts[w] = (counts[w] || 0) + 1; });
    var shared = 0;
    bw.forEach(function (w) { if (counts[w] > 0) { counts[w]--; shared++; } });
    return (2 * shared) / (aw.length + bw.length);
  }

  // Plan a block-level diff over two arrays of block texts. Returns ordered steps:
  //   { type:'eq',   baseIndex, targetIndex }
  //   { type:'ins',  targetIndex }
  //   { type:'del',  baseIndex }
  //   { type:'edit', baseIndex, targetIndex }   // similar del+ins pair → word diff
  // A del-run immediately followed by an ins-run is paired position-by-position;
  // a pair whose similarity >= editThreshold (default .5) becomes an 'edit'.
  function planBlocks(baseTexts, targetTexts, opts) {
    opts = opts || {};
    var threshold = (opts.editThreshold == null) ? 0.5 : opts.editThreshold;
    var ops = diffSequences(baseTexts || [], targetTexts || []);
    var steps = [];
    var bi = 0, ti = 0;
    for (var k = 0; k < ops.length; k++) {
      var run = ops[k];
      if (run.op === 'eq') {
        for (var e = 0; e < run.items.length; e++) steps.push({ type: 'eq', baseIndex: bi++, targetIndex: ti++ });
      } else if (run.op === 'del') {
        var next = ops[k + 1];
        var dels = run.items;
        var inss = (next && next.op === 'ins') ? next.items : [];
        var paired = Math.min(dels.length, inss.length);
        var p = 0;
        for (; p < paired; p++) {
          if (similarity(dels[p], inss[p]) >= threshold) {
            steps.push({ type: 'edit', baseIndex: bi++, targetIndex: ti++ });
          } else {
            steps.push({ type: 'del', baseIndex: bi++ });
            steps.push({ type: 'ins', targetIndex: ti++ });
          }
        }
        for (var d = p; d < dels.length; d++) steps.push({ type: 'del', baseIndex: bi++ });
        if (next && next.op === 'ins') {
          for (var s = p; s < inss.length; s++) steps.push({ type: 'ins', targetIndex: ti++ });
          k++; // consumed the paired ins run
        }
      } else { // 'ins' with no preceding del
        for (var q = 0; q < run.items.length; q++) steps.push({ type: 'ins', targetIndex: ti++ });
      }
    }
    return steps;
  }

  return {
    tokenizeWords: tokenizeWords,
    diffSequences: diffSequences,
    diffWords: diffWords,
    similarity: similarity,
    planBlocks: planBlocks,
    normalize: normalize
  };
});
