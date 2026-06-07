# Inline Diff View for Version History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Diff" toggle to the read-only inline version view that re-renders the document as an inline, formatting-preserving diff of the viewed version against the next chronological version (the most-recent earlier version diffs against the live current draft).

**Architecture:** A new pure-logic `src/runtime/diff.js` (LCS over arrays + word/block planning; Node-unit-tested, DOM-free, dual-export) plus a thin DOM-aware `src/runtime/diff-render.js` (`NotebackRuntime.diffRender`; clones the target body, annotates changed blocks in place, injects deleted blocks positionally; browser-only, e2e-tested like `highlight.js`). `src/runtime/overlay.js` gains the toggle, a diff render path, `DIFF_CSS`, and `resolveTargetSnapshot`. Both new files are registered in the four parity-locked runtime lists and `manifest.json`.

**Tech Stack:** Vanilla ES5-ish JS (zero runtime deps, no build step), UMD-lite dual export, Node built-in test runner (`node --test`), Playwright (devDependency) for browser e2e.

**Read first:** `docs/2026-06-07-version-diff-view-design.md` (the approved spec). Key invariants from `CLAUDE.md`: everything in `src/runtime/` runs in BOTH the extension content script and the inlined canvas (no `chrome.*`); pure-logic modules stay DOM-free; the runtime file list is duplicated in four places that a parity test keeps byte-identical.

**Spec deviation (intentional, minor):** the spec said a pruned diff target → toggle "disabled with tooltip". To avoid an async pre-check on every mount, this plan instead always shows the toggle and, if the target turns out unavailable on activation, toasts "No snapshot to diff against" and reverts to snapshot view. Same user-visible outcome (you can't see a diff that has no data), simpler code.

---

## File Structure

| File | Responsibility | Test |
| --- | --- | --- |
| `src/runtime/diff.js` (new) | Pure diff brain: `tokenizeWords`, `diffSequences` (generic LCS), `diffWords`, `similarity`, `planBlocks`. DOM-free, dual-export. | `test/diff.test.js` (Node) |
| `src/runtime/diff-render.js` (new) | DOM glue: `extractBlocks`, `renderInlineDiff`. Browser-only (`NotebackRuntime.diffRender`, no `module.exports`). | e2e (Task 6) |
| `src/runtime/overlay.js` (modify) | Diff toggle UI, diff render path, `DIFF_CSS`, toggle/header CSS, `resolveTargetSnapshot`, `diffMode` state. | e2e (Task 6) |
| `bin/noteback.js`, `examples/build-canvas.js`, `src/background/service-worker.js`, `manifest.json` (modify) | Register the two new runtime files (parity-locked + extension manifest). | `test/canvas-runtime-parity.test.js` |
| `test/diff.test.js` (new) | Unit tests for the pure brain. | — |
| `test/e2e/version-diff.e2e.test.js` (new) | Browser integration: toggle on → ins/del markers + comment marks + header label; toggle off → plain snapshot. | — |
| `CONTRACTS.md`, `CLAUDE.md` (modify) | Document the diff toggle + the new modules' registration requirement. | — |

---

## Task 1: `diff.js` — tokenizeWords, diffSequences, diffWords

**Files:**
- Create: `src/runtime/diff.js`
- Test: `test/diff.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/diff.test.js`:

```js
/**
 * Noteback tests — diff.test.js
 * Runs under the Node built-in runner ONLY:  node --test
 * Covers the pure diff brain (src/runtime/diff.js): word tokenizing, generic
 * LCS sequence diff, word-level diff, similarity, and block planning.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const diff = require('../src/runtime/diff.js');

test('diff module loads with its API surface', () => {
  assert.strictEqual(typeof diff.tokenizeWords, 'function');
  assert.strictEqual(typeof diff.diffSequences, 'function');
  assert.strictEqual(typeof diff.diffWords, 'function');
  assert.strictEqual(typeof diff.similarity, 'function');
  assert.strictEqual(typeof diff.planBlocks, 'function');
});

test('tokenizeWords keeps separators so join reproduces the input', () => {
  const s = 'the  quick brown\tfox';
  assert.strictEqual(diff.tokenizeWords(s).join(''), s);
  assert.deepStrictEqual(diff.tokenizeWords('a b'), ['a', ' ', 'b']);
  assert.deepStrictEqual(diff.tokenizeWords(''), []);
  assert.deepStrictEqual(diff.tokenizeWords(null), []);
});

test('diffSequences: identical arrays are all eq', () => {
  const ops = diff.diffSequences(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.deepStrictEqual(ops, [{ op: 'eq', items: ['a', 'b', 'c'] }]);
});

test('diffSequences: empty sides', () => {
  assert.deepStrictEqual(diff.diffSequences([], []), []);
  assert.deepStrictEqual(diff.diffSequences([], ['x']), [{ op: 'ins', items: ['x'] }]);
  assert.deepStrictEqual(diff.diffSequences(['x'], []), [{ op: 'del', items: ['x'] }]);
});

test('diffSequences: a middle insert and a middle delete', () => {
  // insert 'X' between a and b
  assert.deepStrictEqual(
    diff.diffSequences(['a', 'b'], ['a', 'X', 'b']),
    [{ op: 'eq', items: ['a'] }, { op: 'ins', items: ['X'] }, { op: 'eq', items: ['b'] }]
  );
  // delete 'b' from the middle
  assert.deepStrictEqual(
    diff.diffSequences(['a', 'b', 'c'], ['a', 'c']),
    [{ op: 'eq', items: ['a'] }, { op: 'del', items: ['b'] }, { op: 'eq', items: ['c'] }]
  );
});

test('diffSequences: fully disjoint → del-run then ins-run', () => {
  assert.deepStrictEqual(
    diff.diffSequences(['a', 'b'], ['x', 'y']),
    [{ op: 'del', items: ['a', 'b'] }, { op: 'ins', items: ['x', 'y'] }]
  );
});

test('diffWords: word-level edit coalesces runs and rejoins text', () => {
  const runs = diff.diffWords('the quick brown fox', 'the slow brown fox');
  // 'the ' eq, 'quick' del, 'slow' ins, ' brown fox' eq
  const eq = runs.filter((r) => r.op === 'eq').map((r) => r.text).join('|');
  assert.ok(eq.includes('the'), 'keeps the unchanged "the"');
  assert.ok(runs.some((r) => r.op === 'del' && r.text === 'quick'), 'marks "quick" deleted');
  assert.ok(runs.some((r) => r.op === 'ins' && r.text === 'slow'), 'marks "slow" inserted');
  // Reconstructing eq+ins reproduces the target; eq+del reproduces the base.
  assert.strictEqual(runs.filter((r) => r.op !== 'del').map((r) => r.text).join(''), 'the slow brown fox');
  assert.strictEqual(runs.filter((r) => r.op !== 'ins').map((r) => r.text).join(''), 'the quick brown fox');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/diff.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/diff.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/runtime/diff.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/diff.test.js`
Expected: PASS (all tests in the file green).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/diff.js test/diff.test.js
git commit -m "feat(diff): pure-logic LCS core — tokenizeWords, diffSequences, diffWords

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `diff.js` — similarity + planBlocks tests

**Files:**
- Modify: `test/diff.test.js` (append)
- (`src/runtime/diff.js` already implements `similarity`/`planBlocks` from Task 1 — this task locks them with tests.)

- [ ] **Step 1: Write the failing test**

Append to `test/diff.test.js`:

```js
test('similarity: identical=1, disjoint=0, partial in between, empty-empty=1', () => {
  assert.strictEqual(diff.similarity('alpha beta gamma', 'alpha beta gamma'), 1);
  assert.strictEqual(diff.similarity('alpha beta', 'x y z'), 0);
  assert.strictEqual(diff.similarity('', ''), 1);
  assert.strictEqual(diff.similarity('alpha', ''), 0);
  const partial = diff.similarity('the quick brown fox', 'the quick red fox');
  assert.ok(partial > 0.5 && partial < 1, 'a one-word change is highly similar (got ' + partial + ')');
});

test('planBlocks: unchanged blocks are all eq', () => {
  const steps = diff.planBlocks(['A', 'B'], ['A', 'B']);
  assert.deepStrictEqual(steps, [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'eq', baseIndex: 1, targetIndex: 1 }
  ]);
});

test('planBlocks: a pure insert and a pure delete', () => {
  assert.deepStrictEqual(diff.planBlocks(['A'], ['A', 'B']), [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'ins', targetIndex: 1 }
  ]);
  assert.deepStrictEqual(diff.planBlocks(['A', 'B'], ['A']), [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'del', baseIndex: 1 }
  ]);
});

test('planBlocks: a similar replaced block becomes an edit', () => {
  const steps = diff.planBlocks(
    ['Ship in Q2 and early Q3 with a small team'],
    ['Ship in Q2 and late Q3 with a small team']
  );
  assert.deepStrictEqual(steps, [{ type: 'edit', baseIndex: 0, targetIndex: 0 }]);
});

test('planBlocks: a dissimilar replaced block stays del + ins', () => {
  const steps = diff.planBlocks(['totally unrelated alpha'], ['completely different beta']);
  assert.deepStrictEqual(steps, [
    { type: 'del', baseIndex: 0 },
    { type: 'ins', targetIndex: 0 }
  ]);
});

test('planBlocks: edit in the middle keeps surrounding eq blocks aligned', () => {
  const steps = diff.planBlocks(
    ['intro para', 'the quick brown fox', 'outro para'],
    ['intro para', 'the quick red fox', 'outro para']
  );
  assert.deepStrictEqual(steps, [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'edit', baseIndex: 1, targetIndex: 1 },
    { type: 'eq', baseIndex: 2, targetIndex: 2 }
  ]);
});
```

- [ ] **Step 2: Run the test to verify it passes (implementation already exists)**

Run: `node --test test/diff.test.js`
Expected: PASS. (If `planBlocks`/`similarity` are wrong, these fail — fix `src/runtime/diff.js` until green. This is the red/green for these functions.)

- [ ] **Step 3: Run the unit suite to confirm no regressions**

Run: `npm run test:unit`  (this is the fast top-level suite — `node --test test/*.test.js`; it excludes the browser e2e in `test/e2e/`. `npm test` globs `test/**/*.test.js` and also runs the Playwright e2e.)
Expected: PASS — the prior unit tests (148) + the new `diff.test.js` cases, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add test/diff.test.js
git commit -m "test(diff): lock similarity + planBlocks (eq/ins/del/edit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `diff-render.js` — DOM renderer

**Files:**
- Create: `src/runtime/diff-render.js`

This module is DOM-aware (uses `cloneNode`, `querySelectorAll`, `createElement`) and therefore browser-only with NO `module.exports` — exactly like `src/runtime/highlight.js`. It is covered by the e2e in Task 6, not a Node unit test (the Node runner has no DOM; `highlight.js` follows the same pattern).

- [ ] **Step 1: Create the module**

Create `src/runtime/diff-render.js`:

```js
/**
 * Noteback runtime — diff-render.js  (DOM-aware; browser-only)
 *
 * Renders an inline, formatting-preserving unified diff of two document bodies,
 * using the pure planner in `NotebackRuntime.diff`. Strategy: start from a FULL
 * deep clone of the TARGET body (so all structure / non-block content / wrappers
 * survive), then annotate changed blocks in place and inject deleted (base-only)
 * blocks positionally. Edited blocks are re-rendered with word-level ins/del runs
 * (inline formatting inside an edited block is flattened — a v1 simplification).
 *
 * Browser-only: attaches to `NotebackRuntime.diffRender`. No module.exports — it
 * touches the DOM, so it is exercised by the browser e2e, not the Node suite.
 */
(function (root) {
  'use strict';
  root.NotebackRuntime = root.NotebackRuntime || {};

  var BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dt,dd,figcaption';

  function diffApi() {
    var g = root.NotebackRuntime || {};
    return g.diff;
  }

  // Leaf block-level elements in document order, each with its normalized text.
  // "Leaf" = a matched block that does NOT itself contain another matched block,
  // so we diff paragraphs/list-items, not their containers.
  function extractBlocks(body) {
    var els = [], texts = [];
    if (!body) return { els: els, texts: texts };
    var all = body.querySelectorAll(BLOCK_SELECTOR);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.querySelector(BLOCK_SELECTOR)) continue; // not a leaf block
      els.push(el);
      texts.push((el.textContent || '').replace(/\s+/g, ' ').trim());
    }
    return { els: els, texts: texts };
  }

  // Replace an edited block's children with word-diff runs (eq text / ins / del).
  function applyWordDiff(el, baseText, targetText, doc, diff) {
    while (el.firstChild) el.removeChild(el.firstChild);
    el.classList.add('nb-diff-edit-block');
    var runs = diff.diffWords(baseText, targetText);
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (r.op === 'eq') { el.appendChild(doc.createTextNode(r.text)); continue; }
      var span = doc.createElement(r.op === 'ins' ? 'ins' : 'del');
      span.className = r.op === 'ins' ? 'nb-diff-ins' : 'nb-diff-del';
      span.textContent = r.text;
      el.appendChild(span);
    }
  }

  // Render the inline diff. Returns { body, hasChanges }: a deep clone of the
  // target body carrying .nb-diff-* markup. `doc` is the target's ownerDocument.
  function renderInlineDiff(baseBody, targetBody, doc) {
    var diff = diffApi();
    var outBody = targetBody.cloneNode(true); // full clone — preserves structure
    if (!diff) return { body: outBody, hasChanges: false };

    var base = extractBlocks(baseBody);
    var target = extractBlocks(targetBody);
    var outBlocks = extractBlocks(outBody).els; // aligns 1:1 with target.els
    var steps = diff.planBlocks(base.texts, target.texts);
    var changed = false;

    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s.type === 'eq') {
        continue; // unchanged — leave the cloned block as-is
      }
      if (s.type === 'ins') {
        if (outBlocks[s.targetIndex]) outBlocks[s.targetIndex].classList.add('nb-diff-ins-block');
        changed = true;
        continue;
      }
      if (s.type === 'edit') {
        if (outBlocks[s.targetIndex]) applyWordDiff(outBlocks[s.targetIndex], base.texts[s.baseIndex], target.texts[s.targetIndex], doc, diff);
        changed = true;
        continue;
      }
      // 'del': inject the base-only block before the next surviving target block.
      var anchor = null;
      for (var j = i + 1; j < steps.length; j++) {
        var nj = steps[j];
        if (nj.type !== 'del' && nj.targetIndex != null && outBlocks[nj.targetIndex]) { anchor = outBlocks[nj.targetIndex]; break; }
      }
      var delEl = base.els[s.baseIndex].cloneNode(true);
      delEl.classList.add('nb-diff-del-block');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(delEl, anchor);
      else outBody.appendChild(delEl);
      changed = true;
    }

    return { body: outBody, hasChanges: changed };
  }

  root.NotebackRuntime.diffRender = {
    extractBlocks: extractBlocks,
    renderInlineDiff: renderInlineDiff
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 2: Sanity-check it parses under Node (loads without throwing)**

Run: `node -e "require('./src/runtime/diff-render.js'); console.log(typeof globalThis.NotebackRuntime.diffRender.renderInlineDiff)"`
Expected: prints `function` (the UMD wrapper only attaches to the global at load — no DOM is touched until a function runs).

- [ ] **Step 3: Commit**

```bash
git add src/runtime/diff-render.js
git commit -m "feat(diff): DOM renderer — inline unified diff over two doc bodies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Register the two new runtime files (4 lists + manifest)

**Files:**
- Modify: `bin/noteback.js` (`RUNTIME_FILES`)
- Modify: `examples/build-canvas.js` (`RUNTIME_FILES`)
- Modify: `src/background/service-worker.js` (`CANVAS_RUNTIME_FILES`)
- Modify: `manifest.json` (BOTH `content_scripts[].js` arrays)

Load order for both new files: `diff.js` goes right after `markdown.js` (with the other pure modules); `diff-render.js` goes right after `highlight.js` and before `overlay.js` (the other DOM painter, and overlay consumes it). `overlay.js` reads them via `modules.diff` / `modules.diffRender` at call time, so this ordering is sufficient.

- [ ] **Step 1: Edit `bin/noteback.js`**

In the `RUNTIME_FILES` array, make these two insertions:

```js
const RUNTIME_FILES = [
  'src/runtime/anchor.js',
  'src/runtime/state.js',
  'src/runtime/markdown.js',
  'src/runtime/diff.js',          // <-- add
  'src/runtime/highlight.js',
  'src/runtime/diff-render.js',   // <-- add
  'src/runtime/overlay.js',
  'src/runtime/draft-history-core.js',
  'src/runtime/snapshot-capture.js',
  'src/adapters/infile-state-adapter.js',
  'src/adapters/history-state-adapter.js',
  'src/canvas/exporter.js',
  'src/runtime/boot.js'
];
```

- [ ] **Step 2: Edit `examples/build-canvas.js`**

Apply the identical two insertions to its `RUNTIME_FILES` array (same surrounding entries: `diff.js` after `markdown.js`, `diff-render.js` after `highlight.js`).

- [ ] **Step 3: Edit `src/background/service-worker.js`**

Apply the identical two insertions to its `CANVAS_RUNTIME_FILES` array (same surrounding entries).

- [ ] **Step 4: Run the parity test**

Run: `node --test test/canvas-runtime-parity.test.js`
Expected: PASS — the three lists agree (each got the same two insertions in the same positions).

- [ ] **Step 5: Edit `manifest.json` — first `content_scripts` block**

In the FIRST `js` array (the one that also lists `chrome-storage-adapter.js` / `content-script.js`), insert `"src/runtime/diff.js"` after `"src/runtime/markdown.js"` and `"src/runtime/diff-render.js"` after `"src/runtime/highlight.js"`:

```json
        "src/runtime/anchor.js",
        "src/runtime/state.js",
        "src/runtime/markdown.js",
        "src/runtime/diff.js",
        "src/runtime/highlight.js",
        "src/runtime/diff-render.js",
        "src/runtime/overlay.js",
```

- [ ] **Step 6: Edit `manifest.json` — second `content_scripts` block**

Apply the identical two insertions to the SECOND `js` array (the shorter one ending in `boot.js`). After this both blocks list `diff.js` after `markdown.js` and `diff-render.js` after `highlight.js`.

- [ ] **Step 7: Verify the manifest is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest OK')"`
Expected: prints `manifest OK`.

- [ ] **Step 8: Commit**

```bash
git add bin/noteback.js examples/build-canvas.js src/background/service-worker.js manifest.json
git commit -m "build: register diff.js + diff-render.js in runtime file lists + manifest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `overlay.js` — diff toggle, render path, CSS, state

**Files:**
- Modify: `src/runtime/overlay.js`

All edits are inside the `mountOverlay` closure (so `doc`, `uiRoot`, `UI_ATTR`, `getState`, `openSidebar`, `toast`, `history`, `highlightApi`, `buildPeekPopoverScript`, `closeVersionMenu`, `renderVersions` are in scope) except the CSS string constants. Behavior is verified by the e2e in Task 6.

- [ ] **Step 1: Add `DIFF_CSS` next to the other iframe-injected CSS**

After the `PEEK_POP_CSS` constant (ends ~line 95, just before `BUTTON_CSS`), add:

```js
  // Diff coloring injected INTO the version-view iframe when diff mode is on.
  // Separate visual channels from the comment highlight (honey background): adds
  // are green with an inset underline, deletes are red strike-through, so the two
  // schemes layer without colliding.
  const DIFF_CSS =
    'ins.nb-diff-ins{background:#e3f5e3;color:#137333;text-decoration:none;' +
    '  box-shadow:inset 0 -2px 0 #4faa52;border-radius:2px;}' +
    'del.nb-diff-del{background:#fbe4e2;color:#a50e0e;text-decoration:line-through;' +
    '  text-decoration-color:#d2655a;border-radius:2px;}' +
    '.nb-diff-ins-block{background:#eef8ee;box-shadow:inset 3px 0 0 #4faa52;border-radius:3px;}' +
    '.nb-diff-del-block{background:#fdeeec;box-shadow:inset 3px 0 0 #d2655a;border-radius:3px;' +
    '  text-decoration:line-through;text-decoration-color:rgba(165,14,14,.45);opacity:.82;}' +
    '.nb-diff-edit-block{background:#fffdf3;border-radius:3px;}' +
    '.nb-diff-nochange{margin:0 0 14px;padding:9px 13px;border-radius:8px;' +
    '  background:#eef1f4;color:#54606c;' +
    '  font:600 13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}';
```

- [ ] **Step 2: Add the header-bar + diff-toggle CSS to `PANEL_CSS`**

Immediately after the `.nb-hist-back:hover` rule (the `.nb-hist-view` group, ~line 368), insert these rules into the `PANEL_CSS` array:

```js
    /* the inline-view header is now a flex bar holding the back button (left) and
       the diff toggle (right); the bar owns the bottom border. */
    '.nb-hist-bar{flex:0 0 auto;display:flex;align-items:stretch;',
    '  border-bottom:1px solid var(--nb-line);background:var(--nb-accent-wash);}',
    '.nb-hist-bar .nb-hist-back{flex:1 1 auto;border-bottom:none;}',
    '.nb-diff-toggle{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;',
    '  border:none;border-left:1px solid rgba(18,122,114,.25);background:transparent;',
    '  color:var(--nb-accent-deep);font:700 12px/1 var(--nb-round);letter-spacing:.01em;',
    '  padding:0 14px;cursor:pointer;transition:background .14s ease,color .14s ease;}',
    '.nb-diff-toggle:hover{background:var(--nb-accent);color:#fffdf8;}',
    '.nb-diff-icon{font-size:13px;line-height:1;}',
    '.nb-diff-switch{position:relative;width:30px;height:16px;border-radius:999px;',
    '  background:var(--nb-line-strong);transition:background .16s ease;flex:none;}',
    '.nb-diff-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;',
    '  border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .16s ease;}',
    '.nb-diff-toggle.nb-on .nb-diff-switch{background:var(--nb-accent);}',
    '.nb-diff-toggle.nb-on:hover .nb-diff-switch{background:#fff;}',
    '.nb-diff-toggle.nb-on .nb-diff-switch::after{transform:translateX(14px);}',
```

- [ ] **Step 3: Grab the new module APIs + add `diffMode` state**

Near the other module grabs (after `const markdownApi = modules.markdown;`, ~line 505) add:

```js
    const diffApi = modules.diff;
    const diffRenderApi = modules.diffRender;
    const snapshotApi = modules.snapshotCapture;
```

Near the `let viewingKey = null;` / `let inlineView = null;` declarations (~line 525) add:

```js
    // Diff mode for the inline version view: when true, the panel renders a diff
    // of the viewed version against the next chronological version. Sticky while
    // browsing versions; reset on closeVersionInline.
    let diffMode = false;
```

- [ ] **Step 4: Replace `openVersionInline` + `closeVersionInline` with the refactored versions**

Replace the entire existing `openVersionInline(versionKey)` function (the one from the doc-comment `/** Open a past version inline ... */` through the end of `closeVersionInline`, ~lines 1647–1725) with:

```js
    /**
     * Open a past version inline (read-only) in the side panel. Branches on
     * diffMode: snapshot view (default) or a diff against the next version.
     */
    function openVersionInline(versionKey) {
      closeVersionMenu(true); // a row chevron may have opened it
      if (diffMode) { openVersionDiff(versionKey); return; }
      Promise.resolve(history.getVersion({ versionKey: versionKey })).then(function (v) {
        if (!v || !v.html) { toast('This version has no saved snapshot'); return; } // pruned
        mountInlineView(versionKey, buildSnapshotSrcdoc(v), null);
      });
    }

    /** Open a past version inline showing a DIFF vs the next chronological version. */
    function openVersionDiff(versionKey) {
      Promise.all([
        Promise.resolve(history.getVersion({ versionKey: versionKey })),
        resolveTargetSnapshot(versionKey)
      ]).then(function (res) {
        const baseV = res[0];
        const target = res[1];
        if (!baseV || !baseV.html) { toast('This version has no saved snapshot'); diffMode = false; openVersionInline(versionKey); return; }
        if (!target || !target.html) { toast('No snapshot to diff against'); diffMode = false; openVersionInline(versionKey); return; }
        const cmpLabel = 'v' + target.baseOrdinal + ' → ' + target.label;
        mountInlineView(versionKey, buildDiffSrcdoc(baseV, target), cmpLabel);
      });
    }

    /**
     * Resolve the diff TARGET for a viewed version: the next chronological version.
     * For the most-recent earlier version (index 0, newest-first), the target is
     * the LIVE current draft (captured clean) labelled "now"; otherwise it is the
     * next-newer stored snapshot. Returns { html, comments, label, baseOrdinal }.
     */
    function resolveTargetSnapshot(versionKey) {
      return Promise.resolve(history.getHistory()).then(function (versions) {
        versions = versions || [];
        const total = versions.length;
        let idx = -1;
        for (let i = 0; i < total; i++) { if (versions[i].versionKey === versionKey) { idx = i; break; } }
        if (idx === -1) return null;
        const baseOrdinal = total - idx;
        if (idx === 0) {
          let html = '';
          try { html = snapshotApi ? snapshotApi.captureCleanDoc(doc) : ''; } catch (e) { html = ''; }
          const s = getState();
          const comments = (s && Array.isArray(s.comments)) ? s.comments.slice() : [];
          return { html: html, comments: comments, label: 'now', baseOrdinal: baseOrdinal };
        }
        const targetKey = versions[idx - 1].versionKey;
        const targetOrdinal = total - (idx - 1);
        return Promise.resolve(history.getVersion({ versionKey: targetKey })).then(function (tv) {
          return { html: (tv && tv.html) || '', comments: (tv && tv.comments) || [], label: 'v' + targetOrdinal, baseOrdinal: baseOrdinal };
        });
      });
    }

    /** Build the read-only snapshot srcdoc for a version (live highlights + peek). */
    function buildSnapshotSrcdoc(v) {
      let painted = '<!DOCTYPE html>' + v.html;
      try {
        const parsed = new DOMParser().parseFromString(v.html, 'text/html');
        try { highlightApi.paintHighlights(parsed.body, { schemaVersion: 1, comments: v.comments || [] }, {}); } catch (e) {}
        try {
          const hlStyle = parsed.createElement('style');
          hlStyle.setAttribute(UI_ATTR, 'peek-highlight-style');
          hlStyle.textContent = HIGHLIGHT_CSS + PEEK_POP_CSS;
          (parsed.head || parsed.documentElement).appendChild(hlStyle);
        } catch (e) {}
        const scrollScript =
          '<scr' + 'ipt>(function(){var m=document.querySelector("mark.noteback-highlight");' +
          'if(m)m.scrollIntoView({block:"center"});})();</scr' + 'ipt>';
        const peekScript = buildPeekPopoverScript(v.comments || []);
        painted = '<!DOCTYPE html>' + parsed.documentElement.outerHTML + scrollScript + peekScript;
      } catch (e) { /* fall back to raw snapshot */ }
      return painted;
    }

    /** Build the DIFF srcdoc: target doc with diff markup + target comments painted. */
    function buildDiffSrcdoc(baseV, target) {
      let result = '<!DOCTYPE html>' + target.html;
      try {
        const parsedBase = new DOMParser().parseFromString(baseV.html, 'text/html');
        const parsedTarget = new DOMParser().parseFromString(target.html, 'text/html');
        const rendered = diffRenderApi.renderInlineDiff(parsedBase.body, parsedTarget.body, parsedTarget);
        if (parsedTarget.body && parsedTarget.body.parentNode) {
          parsedTarget.body.parentNode.replaceChild(rendered.body, parsedTarget.body);
        }
        try { highlightApi.paintHighlights(rendered.body, { schemaVersion: 1, comments: target.comments || [] }, {}); } catch (e) {}
        try {
          const st = parsedTarget.createElement('style');
          st.setAttribute(UI_ATTR, 'peek-diff-style');
          st.textContent = DIFF_CSS + HIGHLIGHT_CSS + PEEK_POP_CSS;
          (parsedTarget.head || parsedTarget.documentElement).appendChild(st);
        } catch (e) {}
        if (!rendered.hasChanges) {
          try {
            const banner = parsedTarget.createElement('div');
            banner.className = 'nb-diff-nochange';
            banner.textContent = 'No changes in this version compared with the next.';
            rendered.body.insertBefore(banner, rendered.body.firstChild);
          } catch (e) {}
        }
        const scrollScript =
          '<scr' + 'ipt>(function(){var m=document.querySelector(".nb-diff-ins,.nb-diff-del,' +
          '.nb-diff-ins-block,.nb-diff-del-block,mark.noteback-highlight");' +
          'if(m)m.scrollIntoView({block:"center"});})();</scr' + 'ipt>';
        const peekScript = buildPeekPopoverScript(target.comments || []);
        result = '<!DOCTYPE html>' + parsedTarget.documentElement.outerHTML + scrollScript + peekScript;
      } catch (e) { /* fall back to raw target */ }
      return result;
    }

    /**
     * Build + mount the inline view panel (header bar with back button + diff
     * toggle, then the iframe). `diffLabel` non-null → diff mode is active and the
     * toggle shows "Diff: v{base} → {target}".
     */
    function mountInlineView(versionKey, srcdocHtml, diffLabel) {
      if (inlineView && inlineView.parentNode) inlineView.parentNode.removeChild(inlineView);
      inlineView = null;
      viewingKey = versionKey;

      const view = doc.createElement('div');
      view.className = 'nb-hist-view';
      view.setAttribute(UI_ATTR, 'version-view');

      const bar = doc.createElement('div');
      bar.className = 'nb-hist-bar';
      bar.setAttribute(UI_ATTR, 'version-view-bar');

      const backBtn = doc.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'nb-hist-back';
      backBtn.setAttribute(UI_ATTR, 'version-view-back');
      backBtn.textContent = '← Back to current draft';
      backBtn.addEventListener('click', function () { closeVersionInline(); });
      bar.appendChild(backBtn);

      if (diffApi && diffRenderApi) bar.appendChild(buildDiffToggle(versionKey, diffLabel));

      const frame = doc.createElement('iframe');
      frame.className = 'nb-hist-frame';
      frame.srcdoc = srcdocHtml;

      view.appendChild(bar);
      view.appendChild(frame);
      uiRoot.appendChild(view);
      inlineView = view;

      openSidebar();    // ensure the timeline (with "you are here") is visible
      renderVersions(); // re-render so the viewed row is marked + the bar shows
    }

    /** The Diff on/off switch in the inline-view header. */
    function buildDiffToggle(versionKey, diffLabel) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'nb-diff-toggle' + (diffMode ? ' nb-on' : '');
      btn.setAttribute(UI_ATTR, 'diff-toggle');
      btn.setAttribute('aria-pressed', diffMode ? 'true' : 'false');
      btn.title = diffMode ? 'Hide changes' : 'Show changes vs the next version';
      const icon = doc.createElement('span');
      icon.className = 'nb-diff-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '⇄';
      const label = doc.createElement('span');
      label.className = 'nb-diff-label';
      label.textContent = (diffMode && diffLabel) ? ('Diff: ' + diffLabel) : 'Diff';
      const sw = doc.createElement('span');
      sw.className = 'nb-diff-switch';
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.appendChild(sw);
      btn.addEventListener('click', function () { diffMode = !diffMode; openVersionInline(versionKey); });
      return btn;
    }

    /** Close the inline version view and return to the live current draft. */
    function closeVersionInline() {
      if (inlineView && inlineView.parentNode) inlineView.parentNode.removeChild(inlineView);
      inlineView = null;
      const had = viewingKey;
      viewingKey = null;
      diffMode = false; // reset on exit; "Back to current" is a clean reset
      if (had) renderVersions();
    }
```

- [ ] **Step 5: Rebuild the example canvas and run the full Node suite**

Run:
```bash
node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html
npm run test:unit
```
Expected: the wrap succeeds (no missing-file error → the new runtime files inline correctly) and `npm run test:unit` passes (148 + diff unit tests, 0 failures). The unit suite does not exercise overlay DOM — that is Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/overlay.js
git commit -m "feat(overlay): inline diff toggle for version view (this -> next)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Playwright e2e for the diff view

**Files:**
- Create: `test/e2e/version-diff.e2e.test.js`

Mirrors `test/e2e/version-timeline.e2e.test.js`: it wraps `examples/spec.html`, serves three drafts under one doc-id (the served title text changes per draft → new content hash → new version), creates a comment in each so two earlier versions exist, opens the newest earlier version inline, toggles Diff, and asserts the diff markup + layered comment highlight + comparison label, then toggles back.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/version-diff.e2e.test.js`:

```js
'use strict';
/**
 * Browser e2e for the INLINE DIFF VIEW (docs/2026-06-07-version-diff-view-design.md).
 *
 * Drives three drafts under one baked doc-id (changing the visible title each time
 * → new content hash → new version), so two EARLIER versions exist. Opens the
 * newest earlier version inline, toggles "Diff", and asserts: the diff renders
 * ins/del markup against the next version (here: the live "now" draft), the
 * commented passage's highlight is still painted (layering), and the toggle shows
 * the "Diff: v.. -> now" comparison label. Toggling off restores the plain snapshot.
 *
 * Runtime stays zero-dependency; Playwright is a devDependency used only here.
 * Requires the chromium binary: `npx playwright install chromium`.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..', '..');
const DEBOUNCE_MS = 600;

let browser, server, baseURL, canvasHtml, serveMode = 'd1';

before(async () => {
  const out = path.join(os.tmpdir(), 'noteback-vd-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    let body = canvasHtml;
    if (serveMode === 'd2') body = body.split('Technical Spec').join('Technical Spec — Revision 2');
    else if (serveMode === 'd3') body = body.split('Technical Spec').join('Technical Spec — Revision 3');
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port + '/spec.canvas.html';

  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function createComment(page, body) {
  const box = await page.evaluate(() => {
    const root = document.getElementById('noteback-doc-root');
    const para = Array.from(root.querySelectorAll('p')).find((el) => (el.textContent || '').trim().length > 100);
    para.scrollIntoView({ block: 'center' });
    const r = para.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width };
  });
  const y = box.y + 6;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.w - 8, 240), y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(DEBOUNCE_MS);
  const fab = page.locator('button.noteback-fab');
  await fab.waitFor({ state: 'visible', timeout: 3000 });
  await fab.click();
  const ta = page.locator('.nb-popover textarea');
  await ta.waitFor({ state: 'visible', timeout: 3000 });
  await ta.fill(body);
  await page.locator('.nb-savecomment').click();
  await page.waitForTimeout(500);
}

/** Read diff-relevant facts out of the inline view iframe (it lives in a shadow root). */
function readDiffFrame(page) {
  return page.evaluate(() => {
    function findFrame(node) {
      if (node.shadowRoot) {
        const f = node.shadowRoot.querySelector('iframe.nb-hist-frame');
        if (f) return f;
        for (const c of node.shadowRoot.querySelectorAll('*')) { const r = findFrame(c); if (r) return r; }
      }
      for (const c of node.children || []) { const r = findFrame(c); if (r) return r; }
      return null;
    }
    const f = findFrame(document.documentElement);
    if (!f) return null;
    const cd = f.contentDocument;
    return {
      ins: cd.querySelectorAll('ins.nb-diff-ins').length,
      del: cd.querySelectorAll('del.nb-diff-del').length,
      insBlock: cd.querySelectorAll('.nb-diff-ins-block').length,
      delBlock: cd.querySelectorAll('.nb-diff-del-block').length,
      editBlock: cd.querySelectorAll('.nb-diff-edit-block').length,
      marks: cd.querySelectorAll('mark.noteback-highlight').length
    };
  });
}

test('inline diff view: toggle shows ins/del vs next version, keeps comment highlights, toggle off restores snapshot', { timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    serveMode = 'd1';
    await page.goto(baseURL + '?v=d1');
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);
    await createComment(page, 'Note on draft 1');

    serveMode = 'd2';
    await page.goto(baseURL + '?v=d2');
    await page.waitForTimeout(400);
    await createComment(page, 'Note on draft 2');

    serveMode = 'd3';
    await page.goto(baseURL + '?v=d3');
    await page.waitForTimeout(400);
    await createComment(page, 'Note on draft 3 (current)');
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);

    // Open the newest earlier version (v2) inline.
    const earlierRows = page.locator('.nb-ver-row[data-version-key]');
    assert.ok(await earlierRows.count() >= 1, 'at least one earlier-version row exists');
    await earlierRows.nth(0).locator('.nb-ver-line').first().click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 1, 'the inline version view opened');

    // The diff toggle is present and OFF; no diff markup yet.
    const toggle = page.locator('.nb-diff-toggle');
    assert.strictEqual(await toggle.count(), 1, 'the diff toggle is present in the inline-view header');
    assert.strictEqual(await toggle.getAttribute('aria-pressed'), 'false', 'the toggle starts off');
    let frame = await readDiffFrame(page);
    assert.ok(frame, 'the inline iframe is present');
    assert.strictEqual(frame.ins + frame.del + frame.insBlock + frame.delBlock + frame.editBlock, 0, 'no diff markup while the toggle is off');
    assert.ok(frame.marks >= 1, 'the snapshot view paints the comment highlight');

    // Toggle Diff ON: diff vs the next version (the live "now" draft).
    await toggle.click();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.locator('.nb-diff-toggle').getAttribute('aria-pressed'), 'true', 'the toggle is now on');
    assert.ok(/Diff:\s*v\d+\s*→\s*now/.test((await page.locator('.nb-diff-toggle .nb-diff-label').textContent()) || ''), 'the toggle shows the "Diff: vN -> now" comparison label');

    frame = await readDiffFrame(page);
    // v2 ("Revision 2") -> now ("Revision 3"): the heading is an edited block with a
    // word-level "2"->"3" change, so an edit block with both an ins and a del run.
    assert.ok(frame.editBlock >= 1, 'the changed heading renders as an edited block (got ' + frame.editBlock + ')');
    assert.ok(frame.ins >= 1, 'the diff shows at least one inserted word run (got ' + frame.ins + ')');
    assert.ok(frame.del >= 1, 'the diff shows at least one deleted word run (got ' + frame.del + ')');
    assert.ok(frame.marks >= 1, 'comment highlights remain painted in diff mode (layering)');

    // Toggle Diff OFF: the plain snapshot returns, no diff markup.
    await page.locator('.nb-diff-toggle').click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-diff-toggle').getAttribute('aria-pressed'), 'false', 'the toggle is off again');
    frame = await readDiffFrame(page);
    assert.strictEqual(frame.ins + frame.del + frame.insBlock + frame.delBlock + frame.editBlock, 0, 'no diff markup after toggling off');
    assert.ok(frame.marks >= 1, 'the snapshot highlight is back');

    // Back to current resets diff mode.
    await page.locator('.nb-backbar').click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 0, '"Back to current" closes the inline view');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Ensure the chromium binary is installed**

Run: `npx playwright install chromium`
Expected: chromium present (no-op if already installed).

- [ ] **Step 3: Run the diff e2e**

Run: `node --test test/e2e/version-diff.e2e.test.js`
(The repo runs e2e via the Node built-in runner — these `*.e2e.test.js` files `require('playwright')` and launch chromium themselves; `npm run test:e2e` runs all of them.)
Expected: PASS — the diff toggle renders ins/del + an edit block, keeps the comment mark, shows "Diff: v.. → now", and toggling off clears the markup.

If it fails because the served drafts produce a `del`-block instead of an `editBlock` (similarity below threshold for the heading), confirm the heading text actually differs by one word; the assertion `frame.ins >= 1 && frame.del >= 1` still holds for the del-block + ins-block fallback — relax `editBlock >= 1` to `(editBlock >= 1 || (insBlock >= 1 && delBlock >= 1))` only if the heading isn't treated as an edit.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/version-diff.e2e.test.js
git commit -m "test(e2e): inline diff view — ins/del vs next version, layered highlights

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Docs + final verification

**Files:**
- Modify: `CONTRACTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CONTRACTS.md`**

Find the overlay version-view section (search for `openVersionInline` or "inline version"). Add a paragraph:

```markdown
- **Diff view.** While viewing an earlier version inline, a "Diff" toggle in the
  panel header re-renders the document as an inline, formatting-preserving diff of
  the viewed version (base) against the **next chronological version** (target):
  the most-recent earlier version diffs against the live current draft ("now").
  Added runs are green `<ins class="nb-diff-ins">` / `.nb-diff-ins-block`, removed
  runs red `<del class="nb-diff-del">` / `.nb-diff-del-block`, edited paragraphs
  `.nb-diff-edit-block` (word-level). Comment highlights stay painted (layered on a
  separate visual channel). The toggle is sticky while switching version rows and
  resets on "Back to current". Pure diff logic lives in `NotebackRuntime.diff`
  (`src/runtime/diff.js`); DOM rendering in `NotebackRuntime.diffRender`
  (`src/runtime/diff-render.js`).
```

- [ ] **Step 2: Update `CLAUDE.md`**

Add a gotcha near the version-viewing notes:

```markdown
- **The diff view diffs THIS version against the NEXT one, not the previous.**
  `overlay.openVersionDiff` resolves the target via `resolveTargetSnapshot`: the
  most-recent earlier version (index 0 of `getHistory`, newest-first) diffs against
  the LIVE current draft (`snapshotCapture.captureCleanDoc(document)`, labelled
  "now"); any older version diffs against the next-newer stored snapshot. The pure
  diff brain is `src/runtime/diff.js` (DOM-free, Node-tested); the DOM renderer is
  `src/runtime/diff-render.js` (browser-only, e2e-tested, like `highlight.js`).
  BOTH new files must be registered in the FOUR parity-locked runtime lists
  (`bin/noteback.js`, `examples/build-canvas.js`,
  `src/background/service-worker.js` — guarded by
  `test/canvas-runtime-parity.test.js`) AND in `manifest.json`'s two
  `content_scripts` blocks, ordered `diff.js` after `markdown.js` and
  `diff-render.js` after `highlight.js` (before `overlay.js`). Comment highlights
  are painted AFTER the diff wraps words, so a comment whose quote straddles a
  changed region may not re-anchor — unchanged-region highlights always do.
```

- [ ] **Step 3: Run the FULL test suite (Node + e2e)**

Run:
```bash
npm run test:unit
node --test test/e2e/version-diff.e2e.test.js test/e2e/version-timeline.e2e.test.js
```
Expected: unit suite green (148 + diff unit tests); both e2e files green (the new diff e2e AND the existing version-timeline e2e — confirming the `openVersionInline` refactor didn't regress plain inline viewing). `npm test` runs everything (unit + all e2e) in one shot if you prefer.

- [ ] **Step 4: Commit**

```bash
git add CONTRACTS.md CLAUDE.md
git commit -m "docs: diff view (this->next) + new diff modules' registration rule

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes (carried from spec → plan)

- **Spec coverage:** toggle (Task 5) · base→target this→next via `resolveTargetSnapshot` (Task 5) · inline unified block+word diff (`diff.js` Tasks 1-2, `diff-render.js` Task 3) · comment-highlight layering (Task 5 `buildDiffSrcdoc` paints target comments + `DIFF_CSS` separate channel) · zero-dep/dual-mode (pure `diff.js`, no `chrome.*`) · wiring 4 lists + manifest (Task 4) · edge cases: pruned target toast (Task 5), no-changes banner (Task 5), size guard (`LCS_BUDGET`, Task 1), DOMParser/​module-missing fallbacks (Task 5) · Node unit + Playwright e2e (Tasks 1-2, 6) · docs (Task 7).
- **Type consistency:** `planBlocks` step shape `{type, baseIndex?, targetIndex?}`, `diffWords` run shape `{op, text}`, `renderInlineDiff` returns `{body, hasChanges}`, `resolveTargetSnapshot` returns `{html, comments, label, baseOrdinal}` — used consistently across `diff-render.js` and `overlay.js`.
- **Known v1 limitations (documented):** inline formatting inside an *edited* block is flattened to text+ins/del; a comment quote straddling a changed region may not re-anchor.
```
