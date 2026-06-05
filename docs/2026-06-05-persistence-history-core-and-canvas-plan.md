# Persistence & Draft History — Plan 1: Shared Core + Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Noteback *canvas's* comments survive browser refresh and turn document regenerations into a read-only per-draft feedback history, via a storage-agnostic core backed by `localStorage`.

**Architecture:** A pure, storage-agnostic `draft-history-core` (content-hash identity, lineage grouping, GC) talks to an injected async key-value `store` and `codec`. A `localStorage`-backed `LocalStorageStateAdapter` decorates the existing `InFileStateAdapter` and wires the core into the canvas at `boot()` time. A `snapshot` module captures clean per-section HTML so a history comment can be viewed in the context it was made. The shared `overlay` gains a read-only "Earlier feedback" section, a snapshot popup, and a "Clear my comments" item. No wrap-time/CLI logic change — the only `bin`/`manifest` edits add the new runtime files to the inlined-runtime lists.

**Tech Stack:** Vanilla JS (no deps, no build), `node --test` (built-in runner), UMD-lite dual-export modules, `NotebackRuntime` global, Playwright for live DOM checks.

**Reference spec:** `docs/2026-06-05-canvas-comment-persistence-and-history.md` (§3 identity, §4 storage, §5 architecture, §6 snapshots, §7 UI, §6.4 GC, §9 degradation). This plan implements the **canvas** half (Plan 2 will add the extension binding, gating, and popup, reusing this core).

**Conventions for every task:** run tests with `npm test` (expands to `node --test "test/**/*.test.js"`). Never commit to `main` (we are on branch `feat/canvas-comment-persistence-history`). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File structure

**New files**
- `src/runtime/draft-history-core.js` — pure-ish, dual-export (`NotebackRuntime.draftHistory`). Owns `normalizeText`, `contentHash`, `MIN_HASH_CHARS`, and `createDraftHistory({store, now, mintId, codec, limits})` returning `resolve/persist/history/section/clearCurrent`. No DOM, no `localStorage`, no `chrome.*`.
- `src/runtime/snapshot.js` — DOM module (`NotebackRuntime.snapshot`) for section extraction; pure sub-helpers `findNearestHeading`, `pickSectionNodes`, and an `identityCodec` are dual-exported for tests.
- `src/adapters/localstorage-state-adapter.js` — DOM adapter (`NotebackRuntime.localStorageStateAdapter`). `createLocalStorageStateAdapter({ doc, storage, inner, now, draftHistory, snapshot })` → a `StorageAdapter` plus `getHistory/getSection/clearCurrent`. Includes the `localStorage`-backed `store` and a `CompressionStream` codec with identity fallback.
- `test/draft-history-core.test.js`, `test/snapshot.test.js`, `test/localstorage-adapter.test.js`.

**Modified files**
- `src/canvas/exporter.js` — `EMBEDDED_BOOT` composes the new adapter and passes `getHistory/getSection/clearCurrent` to the overlay.
- `src/runtime/overlay.js` — accept `history` hooks in `mountOverlay`; render the "Earlier feedback" section; snapshot popup; "Clear my comments" save-menu item; expose `clearCurrent`/`getController` parity.
- `bin/noteback.js`, `examples/build-canvas.js`, `manifest.json`, `CONTRACTS.md`, `CLAUDE.md` — add the three new runtime modules to the inlined-runtime / dependency-order lists (mechanical).

---

## Task 1: Content hash + normalization (pure)

**Files:**
- Create: `src/runtime/draft-history-core.js`
- Test: `test/draft-history-core.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/draft-history-core.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/runtime/draft-history-core.js');

test('normalizeText trims and collapses whitespace, preserves case', () => {
  assert.strictEqual(core.normalizeText('  Hello\n\n  World  '), 'Hello World');
  assert.strictEqual(core.normalizeText('A\tB\r\nC'), 'A B C');
});

test('contentHash is stable and whitespace-insensitive', () => {
  const a = core.contentHash('The system uses a single Redis instance.');
  const b = core.contentHash('The   system uses a single   Redis instance.');
  assert.strictEqual(a, b, 'whitespace differences do not change the hash');
  assert.strictEqual(typeof a, 'string');
  assert.ok(a.length > 0);
});

test('contentHash differs when visible text changes', () => {
  const a = core.contentHash('use a single Redis instance');
  const b = core.contentHash('use a Redis cluster');
  assert.notStrictEqual(a, b);
});

test('contentHash returns null below the small-content guard', () => {
  assert.strictEqual(core.contentHash('tiny'), null);
  assert.ok(core.contentHash('x'.repeat(core.MIN_HASH_CHARS)) !== null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/draft-history-core.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/draft-history-core.js'`.

- [ ] **Step 3: Write the minimal module with hash + normalize**

Create `src/runtime/draft-history-core.js`:

```js
/**
 * Noteback runtime — draft-history-core.js  (PURE-ISH; dual-export)
 *
 * Storage-agnostic core for content-hash draft identity, lineage grouping, and
 * GC. Talks to an injected async key-value `store` + `codec`; never touches the
 * DOM, localStorage, or chrome.*. Runs in the browser
 * (`NotebackRuntime.draftHistory`) and under Node tests (`module.exports`).
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.draftHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_HASH_CHARS = 32;

  /** Trim + collapse all whitespace runs to a single space (case preserved). */
  function normalizeText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /** cyrb53 — fast 53-bit non-crypto string hash (public domain). */
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0);
    let h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /**
   * Content hash over normalized visible text. Returns null when the normalized
   * text is below the small-content guard (no stable identity).
   * @returns {string|null}
   */
  function contentHash(text) {
    const norm = normalizeText(text);
    if (norm.length < MIN_HASH_CHARS) return null;
    // Two seeds → ~106-bit key, base36, for collision headroom on the file://
    // shared bucket.
    return cyrb53(norm, 0).toString(36) + '-' + cyrb53(norm, 0x9e3779b9).toString(36);
  }

  return { MIN_HASH_CHARS, normalizeText, contentHash, cyrb53 };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/draft-history-core.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/draft-history-core.js test/draft-history-core.test.js
git commit -m "feat(core): content-hash identity + text normalization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Draft-history store operations (resolve / persist / history / clearCurrent)

**Files:**
- Modify: `src/runtime/draft-history-core.js`
- Test: `test/draft-history-core.test.js`

This task adds `createDraftHistory(...)`. Identity/lineage/persistence; GC is Task 3.

- [ ] **Step 1: Write the failing test**

Append to `test/draft-history-core.test.js`:

```js
/** Map-backed async store implementing the core's store interface. */
function fakeStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); return Promise.resolve(); },
    remove: (k) => { m.delete(k); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(m.keys())),
    _dump: () => m
  };
}
const idCodec = { compress: (s) => Promise.resolve(s), decompress: (s) => Promise.resolve(s) };
function makeCore(store, t0) {
  let n = 0;
  return core.createDraftHistory({
    store,
    now: () => '2026-06-05T00:00:0' + (n % 10) + 'Z',
    mintId: () => 'lin_' + (++n),
    codec: idCodec,
    limits: { snapshotDrafts: 5, metaDrafts: 15, ttlDays: 99999, maxBytes: 1e9 }
  });
}

test('resolve seeds a fresh draft from fallback comments and mints a lineage', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const r = await dh.resolve({
    contentText: 'x'.repeat(40), attachKey: 'file:///a.html',
    fallbackComments: [], docTitle: 'A'
  });
  assert.strictEqual(r.degraded, false);
  assert.ok(r.contentHash);
  assert.ok(r.lineageId);
  assert.deepStrictEqual(r.comments, []);
  const lin = await store.get('nb:lin:' + r.lineageId);
  assert.deepStrictEqual(lin.generations, [r.contentHash]);
  assert.deepStrictEqual(lin.attachKeys, ['file:///a.html']);
});

test('resolve degrades below the content guard', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ contentText: 'tiny', attachKey: 'k', fallbackComments: [] });
  assert.strictEqual(r.degraded, true);
});

test('persist then resolve again (refresh) returns the saved comments', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const text = 'The system uses a single Redis instance to coordinate.';
  const r1 = await dh.resolve({ contentText: text, attachKey: 'file:///a.html', fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'hi', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: text, attachKey: 'file:///a.html', fallbackComments: [] });
  assert.strictEqual(r2.contentHash, r1.contentHash);
  assert.strictEqual(r2.comments.length, 1);
  assert.strictEqual(r2.comments[0].body, 'hi');
});

test('a content change makes a new draft in the same lineage; history shows the old one', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'use a single Redis instance here', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'old note', anchor: { quote: 'Redis', prefix: '', suffix: '', occurrence: 0 }, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: 'use a Redis cluster here instead', attachKey: key, fallbackComments: [] });
  assert.notStrictEqual(r2.contentHash, r1.contentHash);
  assert.strictEqual(r2.lineageId, r1.lineageId, 'same lineage via attach key');
  assert.deepStrictEqual(r2.comments, [], 'new draft starts clean');
  const hist = await dh.history({ lineageId: r2.lineageId, exceptHash: r2.contentHash });
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].comments[0].body, 'old note');
});

test('move (same content, new attach key) keeps comments and history', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const text = 'The system uses a single Redis instance to coordinate workers.';
  const r1 = await dh.resolve({ contentText: text, attachKey: 'file:///old.html', fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'kept', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: text, attachKey: 'file:///new.html', fallbackComments: [] });
  assert.strictEqual(r2.comments.length, 1, 'comments found by content hash after move');
  const lin = await store.get('nb:lin:' + r2.lineageId);
  assert.ok(lin.attachKeys.indexOf('file:///new.html') !== -1, 'new path recorded');
});

test('history lists only drafts with >=1 comment, newest first', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'draft one body text here padding', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'one', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: 'draft two body text here padding', attachKey: key, fallbackComments: [] });
  // r2 has no comments → not in history
  const r3 = await dh.resolve({ contentText: 'draft three body text padding', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r3.contentHash, comments: [{ id: 'c3', body: 'three', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const hist = await dh.history({ lineageId: r3.lineageId, exceptHash: r3.contentHash });
  assert.deepStrictEqual(hist.map((d) => d.comments[0].body), ['one']);
});

test('clearCurrent empties the draft (kept out of history) but leaves siblings', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'first draft body padding text x', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'one', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: 'second draft body padding text x', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r2.contentHash, comments: [{ id: 'c2', body: 'two', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  await dh.clearCurrent({ contentHash: r2.contentHash });
  const gen = await store.get('nb:gen:' + r2.contentHash);
  assert.deepStrictEqual(gen.comments, []);
  const hist = await dh.history({ lineageId: r2.lineageId, exceptHash: r2.contentHash });
  assert.deepStrictEqual(hist.map((d) => d.comments[0].body), ['one']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/draft-history-core.test.js`
Expected: FAIL — `dh.resolve is not a function` (`createDraftHistory` undefined).

- [ ] **Step 3: Implement `createDraftHistory`**

In `src/runtime/draft-history-core.js`, add before the final `return {...}` and extend the export:

```js
  const GEN = 'nb:gen:';
  const LIN = 'nb:lin:';
  const ATTACH = 'nb:attach';

  function defaultLimits(l) {
    l = l || {};
    return {
      snapshotDrafts: l.snapshotDrafts || 5,
      metaDrafts: l.metaDrafts || 15,
      ttlDays: l.ttlDays || 90,
      maxBytes: l.maxBytes || 3000000
    };
  }

  /**
   * @param {Object} cfg
   * @param {Object} cfg.store    async kv: get/set/remove/keys
   * @param {() => string} cfg.now  ISO timestamp
   * @param {() => string} cfg.mintId  unique lineage id
   * @param {Object} cfg.codec    { compress(str)->Promise<str>, decompress(str)->Promise<str> }
   * @param {Object} [cfg.limits]
   */
  function createDraftHistory(cfg) {
    const store = cfg.store;
    const now = cfg.now || (function () { return new Date().toISOString(); });
    const mintId = cfg.mintId || (function () {
      return 'lin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    });
    const codec = cfg.codec || { compress: function (s) { return Promise.resolve(s); }, decompress: function (s) { return Promise.resolve(s); } };
    const limits = defaultLimits(cfg.limits);

    function genKey(h) { return GEN + h; }
    function linKey(id) { return LIN + id; }

    function loadAttach() { return store.get(ATTACH).then(function (m) { return m || {}; }); }

    /**
     * Boot entry: resolve the current draft, seed/attach lineage, return comments.
     * @returns {Promise<{degraded:boolean, contentHash:?string, lineageId:?string, comments:Array}>}
     */
    function resolve(opts) {
      const hash = contentHash(opts.contentText);
      if (hash == null) {
        return Promise.resolve({ degraded: true, contentHash: null, lineageId: null, comments: opts.fallbackComments || [] });
      }
      const attachKey = String(opts.attachKey || '');
      let gen, lineageId;
      return store.get(genKey(hash)).then(function (existing) {
        gen = existing;
        if (gen) {
          lineageId = gen.lineageId;
          return ensureLineage(lineageId, hash, attachKey);
        }
        // New draft: attach to an existing lineage by attach key, else mint one.
        return loadAttach().then(function (map) {
          lineageId = map[attachKey];
          if (!lineageId) lineageId = mintId();
          gen = {
            schemaVersion: 1, contentHash: hash, lineageId: lineageId,
            docTitle: String(opts.docTitle || ''),
            firstSeenAt: now(), lastEditedAt: now(),
            comments: (opts.fallbackComments || []).slice(), sections: [], styles: ''
          };
          return store.set(genKey(hash), gen).then(function () {
            return ensureLineage(lineageId, hash, attachKey);
          });
        });
      }).then(function () {
        return pruneLineage(lineageId).then(function () {
          return { degraded: false, contentHash: hash, lineageId: lineageId, comments: (gen.comments || []).slice() };
        });
      });
    }

    /** Ensure the lineage record exists and records this hash + attach key. */
    function ensureLineage(lineageId, hash, attachKey) {
      return store.get(linKey(lineageId)).then(function (lin) {
        lin = lin || { schemaVersion: 1, lineageId: lineageId, attachKeys: [], generations: [] };
        if (lin.generations.indexOf(hash) === -1) lin.generations.push(hash);
        if (attachKey && lin.attachKeys.indexOf(attachKey) === -1) lin.attachKeys.push(attachKey);
        return store.set(linKey(lineageId), lin);
      }).then(function () {
        if (!attachKey) return;
        return loadAttach().then(function (map) {
          if (map[attachKey] === lineageId) return;
          map[attachKey] = lineageId;
          return store.set(ATTACH, map);
        });
      });
    }

    /** Write the current draft's comments + snapshot. */
    function persist(p) {
      return store.get(genKey(p.contentHash)).then(function (gen) {
        if (!gen) return; // resolve() must run first
        gen.comments = (p.comments || []).slice();
        gen.sections = p.sections || gen.sections || [];
        gen.styles = (p.styles != null) ? p.styles : (gen.styles || '');
        gen.sectionByCommentId = p.sectionByCommentId || gen.sectionByCommentId || {};
        gen.lastEditedAt = now();
        return store.set(genKey(p.contentHash), gen).then(function () {
          return pruneLineage(gen.lineageId);
        });
      });
    }

    /** Other drafts in the lineage with >=1 comment, newest first. */
    function history(q) {
      return store.get(linKey(q.lineageId)).then(function (lin) {
        if (!lin) return [];
        const hashes = lin.generations.slice().reverse(); // newest last in array
        const out = [];
        return hashes.reduce(function (chain, h) {
          return chain.then(function () {
            if (h === q.exceptHash) return;
            return store.get(genKey(h)).then(function (gen) {
              if (gen && gen.comments && gen.comments.length > 0) {
                const map = gen.sectionByCommentId || {};
                out.push({
                  contentHash: h, lineageId: gen.lineageId, docTitle: gen.docTitle,
                  firstSeenAt: gen.firstSeenAt, lastEditedAt: gen.lastEditedAt,
                  hasSnapshot: !!(gen.sections && gen.sections.length),
                  comments: gen.comments.map(function (c) {
                    const cc = {}; for (const k in c) cc[k] = c[k];
                    cc.sectionId = map[c.id] || null; return cc;
                  })
                });
              }
            });
          });
        }, Promise.resolve()).then(function () { return out; });
      });
    }

    /** Decompress one history comment's section snapshot for the popup. */
    function section(q) {
      return store.get(genKey(q.contentHash)).then(function (gen) {
        if (!gen || !gen.sections) return null;
        const sec = gen.sections.filter(function (s) { return s.id === q.sectionId; })[0];
        if (!sec) return null;
        return Promise.all([codec.decompress(sec.html), codec.decompress(gen.styles || '')])
          .then(function (parts) { return { html: parts[0], styles: parts[1] }; });
      });
    }

    /** Empty the current draft's comments + snapshot (history kept). */
    function clearCurrent(q) {
      return store.get(genKey(q.contentHash)).then(function (gen) {
        if (!gen) return;
        gen.comments = [];
        gen.sections = [];
        gen.lastEditedAt = now();
        return store.set(genKey(q.contentHash), gen);
      });
    }

    function pruneLineage() { return Promise.resolve(); } // implemented in Task 3

    return { resolve: resolve, persist: persist, history: history, section: section, clearCurrent: clearCurrent };
  }
```

Then update the module's return to expose it:

```js
  return { MIN_HASH_CHARS, normalizeText, contentHash, cyrb53, createDraftHistory };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/draft-history-core.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/draft-history-core.js test/draft-history-core.test.js
git commit -m "feat(core): draft resolve/persist/history/clearCurrent with lineage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Garbage collection (`pruneLineage`)

**Files:**
- Modify: `src/runtime/draft-history-core.js` (replace the stub `pruneLineage`)
- Test: `test/draft-history-core.test.js`

GC rules (spec §6.4): keep `sections`/`styles` for the last `snapshotDrafts`; keep comment metadata for `metaDrafts`; drop drafts older than `ttlDays`; evict oldest under `maxBytes` (snapshots first). Drafts ordered oldest→newest in `lin.generations`.

- [ ] **Step 1: Write the failing test**

Append to `test/draft-history-core.test.js`:

```js
function coreWithLimits(store, limits) {
  let n = 0;
  return core.createDraftHistory({
    store,
    now: () => '2026-06-05T00:00:00Z',
    mintId: () => 'lin_fixed',
    codec: idCodec,
    limits
  });
}

test('GC drops snapshots beyond snapshotDrafts but keeps metadata', async () => {
  const store = fakeStore();
  const dh = coreWithLimits(store, { snapshotDrafts: 1, metaDrafts: 10, ttlDays: 99999, maxBytes: 1e9 });
  const key = 'file:///a.html';
  const texts = ['alpha draft body padding text one', 'beta draft body padding text two', 'gamma draft body padding text three'];
  const hashes = [];
  for (const t of texts) {
    const r = await dh.resolve({ contentText: t, attachKey: key, fallbackComments: [] });
    hashes.push(r.contentHash);
    await dh.persist({ contentHash: r.contentHash, comments: [{ id: 'c', body: t, anchor: null, createdAt: 'x', author: null }], sections: [{ id: 's1', html: 'frag' }], styles: 'css' });
  }
  const oldest = await store.get('nb:gen:' + hashes[0]);
  assert.deepStrictEqual(oldest.sections, [], 'oldest snapshot pruned');
  assert.strictEqual(oldest.comments.length, 1, 'oldest metadata kept');
  const newest = await store.get('nb:gen:' + hashes[2]);
  assert.strictEqual(newest.sections.length, 1, 'newest snapshot kept');
});

test('GC removes drafts beyond metaDrafts entirely', async () => {
  const store = fakeStore();
  const dh = coreWithLimits(store, { snapshotDrafts: 1, metaDrafts: 2, ttlDays: 99999, maxBytes: 1e9 });
  const key = 'file:///a.html';
  const texts = ['alpha draft body padding text one', 'beta draft body padding text two', 'gamma draft body padding text three'];
  const hashes = [];
  for (const t of texts) {
    const r = await dh.resolve({ contentText: t, attachKey: key, fallbackComments: [] });
    hashes.push(r.contentHash);
    await dh.persist({ contentHash: r.contentHash, comments: [{ id: 'c', body: t, anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  }
  assert.strictEqual(await store.get('nb:gen:' + hashes[0]), null, 'oldest draft removed');
  const lin = await store.get('nb:lin:lin_fixed');
  assert.strictEqual(lin.generations.indexOf(hashes[0]), -1, 'removed from lineage list');
  assert.strictEqual(lin.generations.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/draft-history-core.test.js`
Expected: FAIL — oldest snapshot still present (stub `pruneLineage` is a no-op).

- [ ] **Step 3: Implement `pruneLineage`**

In `src/runtime/draft-history-core.js`, replace `function pruneLineage() { return Promise.resolve(); }` with:

```js
    /**
     * Enforce retention for a lineage: snapshot window, metadata window, TTL,
     * and a coarse byte cap. `lin.generations` is oldest→newest.
     */
    function pruneLineage(lineageId) {
      return store.get(linKey(lineageId)).then(function (lin) {
        if (!lin) return;
        const gens = lin.generations.slice(); // oldest -> newest
        const ttlCutoff = Date.parse(now()) - limits.ttlDays * 86400000;

        return gens.reduce(function (chain, h, idx) {
          return chain.then(function () {
            return store.get(genKey(h)).then(function (gen) {
              if (!gen) return { h: h, drop: true };
              const ageFromNewest = gens.length - 1 - idx; // 0 = newest
              const tooOld = isFinite(ttlCutoff) && Date.parse(gen.lastEditedAt) < ttlCutoff;
              const beyondMeta = ageFromNewest >= limits.metaDrafts;
              const beyondSnapshot = ageFromNewest >= limits.snapshotDrafts;
              if (beyondMeta || tooOld) {
                return store.remove(genKey(h)).then(function () { return { h: h, drop: true }; });
              }
              if (beyondSnapshot && (gen.sections.length || gen.styles)) {
                gen.sections = [];
                gen.styles = '';
                return store.set(genKey(h), gen).then(function () { return { h: h, drop: false }; });
              }
              return { h: h, drop: false };
            });
          });
        }, Promise.resolve({})).then(function () {
          // Re-read survivors to rebuild the lineage list in order.
          const kept = [];
          return gens.reduce(function (chain, h) {
            return chain.then(function () {
              return store.get(genKey(h)).then(function (gen) { if (gen) kept.push(h); });
            });
          }, Promise.resolve()).then(function () {
            lin.generations = kept;
            return store.set(linKey(lineageId), lin);
          });
        }).then(function () { return enforceByteCap(); });
      });
    }

    /** Coarse global byte cap: evict oldest drafts' snapshots, then drafts. */
    function enforceByteCap() {
      return store.keys().then(function (keys) {
        const genKeys = keys.filter(function (k) { return k.indexOf(GEN) === 0; });
        return Promise.all(genKeys.map(function (k) {
          return store.get(k).then(function (g) { return { key: k, gen: g }; });
        })).then(function (entries) {
          function total() {
            return entries.reduce(function (sum, e) {
              return sum + (e.gen ? JSON.stringify(e.gen).length : 0);
            }, 0);
          }
          entries.sort(function (a, b) {
            return Date.parse((a.gen && a.gen.lastEditedAt) || 0) - Date.parse((b.gen && b.gen.lastEditedAt) || 0);
          });
          const ops = [];
          for (let i = 0; i < entries.length && total() > limits.maxBytes; i++) {
            const e = entries[i];
            if (!e.gen) continue;
            if (e.gen.sections.length || e.gen.styles) { e.gen.sections = []; e.gen.styles = ''; ops.push(store.set(e.key, e.gen)); }
          }
          for (let j = 0; j < entries.length && total() > limits.maxBytes; j++) {
            const e = entries[j];
            if (!e.gen) continue;
            ops.push(store.remove(e.key)); e.gen = null;
          }
          return Promise.all(ops);
        });
      });
    }
```

> Note: `enforceByteCap` does not rewrite lineage lists (a removed gen simply
> resolves to `null` and is skipped by `history`); lineage lists are tidied on the
> next `pruneLineage` for that lineage. This keeps the byte-cap path O(genKeys).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/draft-history-core.test.js`
Expected: PASS (all core tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/draft-history-core.js test/draft-history-core.test.js
git commit -m "feat(core): GC — snapshot/metadata windows, TTL, byte cap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Snapshot section selection (pure helpers)

**Files:**
- Create: `src/runtime/snapshot.js`
- Test: `test/snapshot.test.js`

Pure helpers operate on node-like objects (mirroring how `anchor.js` is tested with `{textContent}`): `{ tagName, textContent, previousElementSibling, nextElementSibling, parentElement }`.

- [ ] **Step 1: Write the failing test**

Create `test/snapshot.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const snap = require('../src/runtime/snapshot.js');

/** Build a fake element graph: array of siblings under a parent. */
function el(tag, text) { return { tagName: tag, textContent: text || '', previousElementSibling: null, nextElementSibling: null, parentElement: null }; }
function siblings(parent, list) {
  for (let i = 0; i < list.length; i++) {
    list[i].parentElement = parent;
    list[i].previousElementSibling = list[i - 1] || null;
    list[i].nextElementSibling = list[i + 1] || null;
  }
  return list;
}

test('findNearestHeading walks back through previous siblings', () => {
  const parent = el('SECTION');
  const [h, p1, p2] = siblings(parent, [el('H2', 'Arch'), el('P', 'first'), el('P', 'second')]);
  assert.strictEqual(snap.findNearestHeading(p2), h);
  assert.strictEqual(snap.findNearestHeading(p1), h);
});

test('findNearestHeading climbs to an ancestor section heading', () => {
  const root = el('DIV');
  const [h, sect] = siblings(root, [el('H1', 'Top'), el('SECTION')]);
  const [p] = siblings(sect, [el('P', 'body')]);
  assert.strictEqual(snap.findNearestHeading(p), h);
});

test('findNearestHeading returns null when none exists', () => {
  const parent = el('DIV');
  const [p] = siblings(parent, [el('P', 'lonely')]);
  assert.strictEqual(snap.findNearestHeading(p), null);
});

test('pickSectionNodes returns [heading, prev, block, next] without nulls', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'H'), el('P', 'prev'), el('P', 'block'), el('P', 'next')]);
  const block = list[2];
  const picked = snap.pickSectionNodes(block);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['H', 'prev', 'block', 'next']);
});

test('pickSectionNodes dedupes when heading is also the previous sibling', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'H'), el('P', 'block'), el('P', 'next')]);
  const block = list[1];
  const picked = snap.pickSectionNodes(block);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['H', 'block', 'next']);
});

test('identityCodec round-trips', async () => {
  const c = snap.identityCodec;
  assert.strictEqual(await c.decompress(await c.compress('hi <b>x</b>')), 'hi <b>x</b>');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/snapshot.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/snapshot.js'`.

- [ ] **Step 3: Implement the pure helpers**

Create `src/runtime/snapshot.js`:

```js
/**
 * Noteback runtime — snapshot.js  (DOM module; pure sub-helpers dual-exported)
 *
 * Captures clean per-section HTML for the draft-history context popup. The DOM
 * extraction (`extractSections`) is browser-only; the section-selection helpers
 * are pure and dual-exported so they unit-test under Node.
 *
 * Attaches to `NotebackRuntime.snapshot`; exports the pure parts under Node.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.snapshot = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADINGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };

  function isHeading(node) {
    if (!node || !node.tagName) return false;
    if (HEADINGS[String(node.tagName).toUpperCase()]) return true;
    const role = node.getAttribute && node.getAttribute('role');
    return role === 'heading';
  }

  /** Nearest preceding heading: back through prev siblings, then up ancestors. */
  function findNearestHeading(block) {
    let node = block;
    while (node) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (isHeading(sib)) return sib;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  /** [heading?, prev?, block, next?] in document order, deduped, no nulls. */
  function pickSectionNodes(block) {
    const out = [];
    const heading = findNearestHeading(block);
    const prev = block.previousElementSibling;
    const next = block.nextElementSibling;
    [heading, prev, block, next].forEach(function (n) {
      if (n && out.indexOf(n) === -1) out.push(n);
    });
    // Keep document order (heading may equal prev; dedup handled above).
    return out;
  }

  const identityCodec = {
    compress: function (s) { return Promise.resolve(String(s == null ? '' : s)); },
    decompress: function (s) { return Promise.resolve(String(s == null ? '' : s)); }
  };

  return {
    isHeading: isHeading,
    findNearestHeading: findNearestHeading,
    pickSectionNodes: pickSectionNodes,
    identityCodec: identityCodec
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/snapshot.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/snapshot.js test/snapshot.test.js
git commit -m "feat(snapshot): pure section-selection helpers + identity codec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Snapshot DOM extraction (browser glue)

**Files:**
- Modify: `src/runtime/snapshot.js`

`extractSections` runs at save time against the live, painted root (highlight
`<mark data-noteback-id>` wrappers present), locates each comment's enclosing block
via its mark, builds the section fragment with `pickSectionNodes`, cleans Noteback
nodes out of a clone, dedupes per draft, and returns `{ sections, styles,
sectionByCommentId }`. DOM-only → verified live (Playwright) in Task 9, not Node.

- [ ] **Step 1: Implement `extractSections` + `collectInlineStyles`**

In `src/runtime/snapshot.js`, add before the final `return {...}`:

```js
  const UI_ATTR = 'data-noteback-ui';
  const HL_CLASS = 'noteback-highlight';

  /** Nearest block-level ancestor of a node (fallback: the node itself). */
  function enclosingBlock(node, rootNode) {
    const BLOCK = /^(P|LI|PRE|BLOCKQUOTE|TD|TH|TR|DIV|SECTION|ARTICLE|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|FIGURE)$/;
    let el = (node.nodeType === 1) ? node : node.parentElement;
    while (el && el !== rootNode) {
      if (el.tagName && BLOCK.test(String(el.tagName).toUpperCase())) return el;
      el = el.parentElement;
    }
    return (node.nodeType === 1) ? node : node.parentElement;
  }

  /** Clone a node and strip Noteback UI + unwrap highlight marks inside it. */
  function cleanClone(node) {
    const clone = node.cloneNode(true);
    const ui = clone.querySelectorAll ? clone.querySelectorAll('[' + UI_ATTR + ']') : [];
    for (let i = 0; i < ui.length; i++) { if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]); }
    const marks = clone.querySelectorAll ? clone.querySelectorAll('mark.' + HL_CLASS) : [];
    for (let j = 0; j < marks.length; j++) {
      const m = marks[j], p = m.parentNode; if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    }
    return clone;
  }

  /** Inline <style> text from the document head (for snapshot styling). */
  function collectInlineStyles(doc) {
    const styles = doc.querySelectorAll ? doc.querySelectorAll('head style, style') : [];
    let out = '';
    for (let i = 0; i < styles.length; i++) {
      if (styles[i].getAttribute && styles[i].getAttribute(UI_ATTR)) continue; // skip our own
      out += (styles[i].textContent || '') + '\n';
    }
    return out;
  }

  /**
   * Build per-section snapshots for the given comments.
   * @param {Object} cfg
   * @param {Node} cfg.root        the painted content root (#noteback-doc-root)
   * @param {Document} cfg.doc
   * @param {Array} cfg.comments   current State.comments
   * @param {number} [cfg.maxSectionChars=8000]
   * @returns {{ sections: Array<{id,html}>, styles: string, sectionByCommentId: Object }}
   */
  function extractSections(cfg) {
    const root = cfg.root, doc = cfg.doc;
    const maxChars = cfg.maxSectionChars || 8000;
    const sections = [];
    const byBlock = []; // [{block, id}]
    const sectionByCommentId = {};

    (cfg.comments || []).forEach(function (c) {
      if (!c || c.anchor == null) return; // doc-level note: no section
      const mark = root.querySelector('mark.' + HL_CLASS + '[data-noteback-id="' + c.id + '"]');
      if (!mark) return; // orphaned / not painted
      const block = enclosingBlock(mark, root);
      let existing = null;
      for (let i = 0; i < byBlock.length; i++) { if (byBlock[i].block === block) { existing = byBlock[i]; break; } }
      if (existing) { sectionByCommentId[c.id] = existing.id; return; }

      const nodes = pickSectionNodes(block);
      const wrap = doc.createElement('div');
      nodes.forEach(function (n) { wrap.appendChild(cleanClone(n)); });
      let html = wrap.innerHTML;
      if (html.length > maxChars) { wrap.textContent = ''; wrap.appendChild(cleanClone(block)); html = wrap.innerHTML; }
      const id = 's' + (sections.length + 1);
      sections.push({ id: id, html: html });
      byBlock.push({ block: block, id: id });
      sectionByCommentId[c.id] = id;
    });

    return { sections: sections, styles: collectInlineStyles(doc), sectionByCommentId: sectionByCommentId };
  }
```

Extend the export object to include the new functions:

```js
  return {
    isHeading: isHeading,
    findNearestHeading: findNearestHeading,
    pickSectionNodes: pickSectionNodes,
    enclosingBlock: enclosingBlock,
    extractSections: extractSections,
    collectInlineStyles: collectInlineStyles,
    identityCodec: identityCodec
  };
```

- [ ] **Step 2: Run the existing tests (no regressions)**

Run: `node --test test/snapshot.test.js`
Expected: PASS (the Task 4 tests still pass; new DOM functions are exercised live in Task 9).

- [ ] **Step 3: Commit**

```bash
git add src/runtime/snapshot.js
git commit -m "feat(snapshot): extractSections — clean per-section capture from painted DOM

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Canvas adapter (localStorage store + decorator)

**Files:**
- Create: `src/adapters/localstorage-state-adapter.js`
- Test: `test/localstorage-adapter.test.js`

The adapter decorates `InFileStateAdapter`, owns a `localStorage`-backed `store`, a
`CompressionStream` codec (identity fallback), and exposes `getHistory/getSection/
clearCurrent` for the overlay. It compresses section HTML on save and decompresses on
read.

- [ ] **Step 1: Write the failing test**

Create `test/localstorage-adapter.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('../src/adapters/localstorage-state-adapter.js');

/** Fake synchronous localStorage. */
function fakeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; }
  };
}
/** Fake in-file inner adapter capturing the last saved state. */
function fakeInner(initial) {
  let saved = initial || null;
  return { load: () => Promise.resolve(saved), save: (s) => { saved = s; return Promise.resolve(); }, _saved: () => saved };
}
const text = 'The system uses a single Redis instance to coordinate workers daily.';
function fakeDoc() {
  return { getElementById: () => ({ textContent: text }), title: 'Plan' };
}

test('load() returns inner state on first open, then localStorage after save', async () => {
  const storage = fakeLocalStorage();
  const inner = fakeInner({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [] });
  const a = mod.createLocalStorageStateAdapter({
    doc: fakeDoc(), storage, inner, attachKey: 'file:///a.html', now: () => '2026-06-05T00:00:00Z'
  });
  const first = await a.load();
  assert.deepStrictEqual(first.comments, []);
  await a.save({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [{ id: 'c1', body: 'hey', anchor: null, createdAt: 'x', author: null }] });
  const again = await a.load();
  assert.strictEqual(again.comments.length, 1);
  assert.strictEqual(inner._saved().comments.length, 1, 'write-through to inner');
});

test('degrades to inner when storage is missing', async () => {
  const inner = fakeInner({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [{ id: 'c', body: 'x', anchor: null, createdAt: 'x', author: null }] });
  const a = mod.createLocalStorageStateAdapter({ doc: fakeDoc(), storage: null, inner, attachKey: 'file:///a.html' });
  const s = await a.load();
  assert.strictEqual(s.comments.length, 1);
  await a.save({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [] });
  assert.deepStrictEqual(inner._saved().comments, [], 'still writes through to inner');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/localstorage-adapter.test.js`
Expected: FAIL — `Cannot find module '../src/adapters/localstorage-state-adapter.js'`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/localstorage-state-adapter.js`:

```js
/**
 * Noteback — localstorage-state-adapter.js  (DOM; browser global)
 *
 * Canvas binding for draft persistence + history. Decorates InFileStateAdapter:
 * persists the current draft's comments in localStorage (keyed by content hash)
 * AND writes through to the in-file block so the re-share path is unaffected.
 * Exposes getHistory/getSection/clearCurrent for the overlay. Degrades to the
 * inner adapter when localStorage is unavailable or the content guard fails.
 *
 * Attaches to NotebackRuntime.localStorageStateAdapter. No module.exports (the
 * pure logic lives in draft-history-core, which IS tested) — but the factory is
 * exported for tests via dual-export since its branching (degrade/write-through)
 * is worth covering directly.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.localStorageStateAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function rt() { const g = (typeof globalThis !== 'undefined') ? globalThis : this; return (g && g.NotebackRuntime) || {}; }

  /** Async kv store over window.localStorage (sync wrapped in Promises). */
  function localStorageStore(storage) {
    return {
      get: function (k) { try { const v = storage.getItem(k); return Promise.resolve(v == null ? null : JSON.parse(v)); } catch (e) { return Promise.resolve(null); } },
      set: function (k, v) { try { storage.setItem(k, JSON.stringify(v)); } catch (e) {} return Promise.resolve(); },
      remove: function (k) { try { storage.removeItem(k); } catch (e) {} return Promise.resolve(); },
      keys: function () { const out = []; try { for (let i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (e) {} return Promise.resolve(out); }
    };
  }

  /** gzip codec via CompressionStream when available; identity otherwise. */
  function makeCodec() {
    const hasCS = (typeof CompressionStream !== 'undefined') && (typeof Response !== 'undefined');
    if (!hasCS) { const s = rt().snapshot; return (s && s.identityCodec) || { compress: function (x) { return Promise.resolve(x); }, decompress: function (x) { return Promise.resolve(x); } }; }
    function toB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return 'gz:' + btoa(bin); }
    function fromB64(s) { const bin = atob(s.slice(3)); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
    return {
      compress: function (str) {
        try {
          const cs = new CompressionStream('gzip');
          const blobStream = new Response(str).body.pipeThrough(cs);
          return new Response(blobStream).arrayBuffer().then(function (buf) { return toB64(new Uint8Array(buf)); });
        } catch (e) { return Promise.resolve(String(str)); }
      },
      decompress: function (str) {
        if (typeof str !== 'string' || str.slice(0, 3) !== 'gz:') return Promise.resolve(String(str == null ? '' : str));
        try {
          const ds = new DecompressionStream('gzip');
          const stream = new Response(fromB64(str)).body.pipeThrough(ds);
          return new Response(stream).text();
        } catch (e) { return Promise.resolve(''); }
      }
    };
  }

  /**
   * @param {Object} cfg
   * @param {Document} cfg.doc
   * @param {Storage|null} cfg.storage   window.localStorage (null → degrade)
   * @param {Object} cfg.inner           InFileStateAdapter (load/save)
   * @param {string} cfg.attachKey       normalized location.href
   * @param {() => string} [cfg.now]
   * @param {Object} [cfg.draftHistory]  override (tests); else rt().draftHistory
   * @param {Object} [cfg.snapshot]      override (tests); else rt().snapshot
   */
  function createLocalStorageStateAdapter(cfg) {
    const doc = cfg.doc;
    const inner = cfg.inner;
    const dhMod = cfg.draftHistory || rt().draftHistory;
    const snapMod = cfg.snapshot || rt().snapshot;
    const now = cfg.now || function () { return new Date().toISOString(); };
    const usable = !!(cfg.storage && dhMod && dhMod.createDraftHistory);
    const codec = makeCodec();
    const dh = usable ? dhMod.createDraftHistory({ store: localStorageStore(cfg.storage), now: now, codec: codec }) : null;

    let resolved = null;       // { degraded, contentHash, lineageId, comments }
    let sectionByCommentId = {};

    function contentRoot() { return doc && doc.getElementById ? doc.getElementById('noteback-doc-root') : null; }
    function contentText() { const r = contentRoot(); return (r && r.textContent) || (doc && doc.body && doc.body.textContent) || ''; }

    function ensureResolved() {
      if (resolved) return Promise.resolve(resolved);
      if (!usable) return inner.load().then(function (s) { resolved = { degraded: true, comments: (s && s.comments) || [] }; return resolved; });
      return inner.load().then(function (innerState) {
        return dh.resolve({ contentText: contentText(), attachKey: cfg.attachKey, fallbackComments: (innerState && innerState.comments) || [], docTitle: (doc && doc.title) || '' });
      }).then(function (r) { resolved = r; return r; });
    }

    return {
      load: function () {
        return ensureResolved().then(function (r) {
          return inner.load().then(function (base) {
            base = base || { schemaVersion: 1, docId: '', docTitle: (doc && doc.title) || '', comments: [] };
            return { schemaVersion: 1, docId: base.docId, docTitle: base.docTitle, comments: (r.comments || []).slice() };
          });
        });
      },

      save: function (state) {
        const writeThrough = inner.save(state);
        if (!usable) return writeThrough;
        return ensureResolved().then(function (r) {
          if (r.degraded) return writeThrough;
          // Rebuild section snapshots from the painted root, compress once.
          let sections = [], styles = '';
          try {
            if (snapMod && snapMod.extractSections) {
              const ex = snapMod.extractSections({ root: contentRoot() || doc.body, doc: doc, comments: state.comments || [] });
              sectionByCommentId = ex.sectionByCommentId || {};
              styles = ex.styles || '';
              sections = ex.sections || [];
            }
          } catch (e) { sections = []; styles = ''; }
          return Promise.all([
            Promise.all(sections.map(function (s) { return codec.compress(s.html).then(function (h) { return { id: s.id, html: h }; }); })),
            codec.compress(styles)
          ]).then(function (parts) {
            return dh.persist({ contentHash: r.contentHash, comments: state.comments || [], sections: parts[0], styles: parts[1], sectionByCommentId: sectionByCommentId });
          }).then(function () { return writeThrough; });
        });
      },

      getHistory: function () {
        if (!usable) return Promise.resolve([]);
        return ensureResolved().then(function (r) {
          if (r.degraded) return [];
          return dh.history({ lineageId: r.lineageId, exceptHash: r.contentHash });
        });
      },

      getSection: function (commentRef) {
        if (!usable) return Promise.resolve(null);
        return dh.section({ contentHash: commentRef.contentHash, sectionId: commentRef.sectionId });
      },

      clearCurrent: function () {
        if (!usable) return Promise.resolve();
        return ensureResolved().then(function (r) {
          if (r.degraded) return; r.comments = [];
          return dh.clearCurrent({ contentHash: r.contentHash });
        });
      },

      // Exposed so the overlay can label a current comment's snapshot id if needed.
      sectionIdFor: function (commentId) { return sectionByCommentId[commentId] || null; }
    };
  }

  return { createLocalStorageStateAdapter: createLocalStorageStateAdapter, localStorageStore: localStorageStore };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/localstorage-adapter.test.js`
Expected: PASS (2 tests). Under Node there is no `CompressionStream`, so `makeCodec()`
falls back to the snapshot identity codec.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS (existing + new). No regressions.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/localstorage-state-adapter.js test/localstorage-adapter.test.js
git commit -m "feat(adapter): localStorage canvas binding decorating InFileStateAdapter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Add the new runtime modules to the inlined-runtime lists

**Files:**
- Modify: `bin/noteback.js:39-48` (`RUNTIME_FILES`)
- Modify: `examples/build-canvas.js` (its runtime-file list)
- Modify: `manifest.json` (`web_accessible_resources`)
- Modify: `CONTRACTS.md` §4 dependency-order table
- Test: `test/cli-wrap.test.js`

Order: `draft-history-core.js` and `snapshot.js` are dependencies of
`localstorage-state-adapter.js`; all three go after `infile-state-adapter.js` and
before `exporter.js` / `boot.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-wrap.test.js`:

```js
test('wrapHtml inlines the draft-history runtime modules', () => {
  const html = cli.wrapHtml(DOC, { sourceName: 'plan.html' });
  assert.match(html, /NotebackRuntime\.draftHistory/);
  assert.match(html, /NotebackRuntime\.snapshot/);
  assert.match(html, /NotebackRuntime\.localStorageStateAdapter/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli-wrap.test.js`
Expected: FAIL — the three identifiers are not present in the inlined runtime.

- [ ] **Step 3: Update `RUNTIME_FILES` in `bin/noteback.js`**

Replace the `RUNTIME_FILES` array (`bin/noteback.js:39-48`) with:

```js
const RUNTIME_FILES = [
  'src/runtime/anchor.js',
  'src/runtime/state.js',
  'src/runtime/markdown.js',
  'src/runtime/highlight.js',
  'src/runtime/overlay.js',
  'src/runtime/draft-history-core.js',
  'src/runtime/snapshot.js',
  'src/adapters/infile-state-adapter.js',
  'src/adapters/localstorage-state-adapter.js',
  'src/canvas/exporter.js',
  'src/runtime/boot.js'
];
```

- [ ] **Step 4: Mirror the order in `examples/build-canvas.js`**

Open `examples/build-canvas.js`, find its runtime-file array (the same list the
service worker/manifest mirror), and insert the same three entries in the same
positions: `draft-history-core.js` and `snapshot.js` after `overlay.js`, and
`localstorage-state-adapter.js` immediately after `infile-state-adapter.js`.

- [ ] **Step 5: Add to `manifest.json` `web_accessible_resources`**

In `manifest.json`, add `"src/runtime/draft-history-core.js"`,
`"src/runtime/snapshot.js"`, and `"src/adapters/localstorage-state-adapter.js"` to the
`web_accessible_resources[].resources` array (so the service worker can fetch them
when assembling a canvas).

- [ ] **Step 6: Update `CONTRACTS.md` §4 dependency-order block**

In `CONTRACTS.md`, in the "Runtime dependency order" code block (§4), insert the same
three files in the same positions, and add three rows to the namespace table:
`draft-history-core.js` → `draftHistory` (yes module.exports, pure-ish),
`snapshot.js` → `snapshot` (yes, mixed), `localstorage-state-adapter.js` →
`localStorageStateAdapter` (yes for tests, DOM).

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS, including the new `cli-wrap` assertion and the idempotency test
(`re-wrapping a canvas is idempotent`) still green.

- [ ] **Step 8: Commit**

```bash
git add bin/noteback.js examples/build-canvas.js manifest.json CONTRACTS.md test/cli-wrap.test.js
git commit -m "build: inline draft-history-core, snapshot, localStorage adapter into canvases

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire the canvas binding + history hooks (EMBEDDED_BOOT + overlay)

**Files:**
- Modify: `src/canvas/exporter.js` (`EMBEDDED_BOOT`, around `src/canvas/exporter.js:51-170`)
- Modify: `src/runtime/overlay.js` (`mountOverlay` cfg, `renderSidebar`, Save menu, controller return)

This wires the localStorage adapter into the canvas and surfaces history + clear in
the shared overlay. DOM-only → verified live in Task 9.

- [ ] **Step 1: Compose the adapter in `EMBEDDED_BOOT`**

In `src/canvas/exporter.js`, inside `EMBEDDED_BOOT`'s `start()`, replace the line that
builds `adapter`:

```js
    '    var adapter = RT.infileStateAdapter.createInFileStateAdapter(document, {',
    '      onChange: function (s) { latestState = s; }',
    '    });',
```

with a composition that prefers the localStorage binding (falling back to the in-file
adapter if the new module is absent — e.g. an old inlined runtime):

```js
    '    var inner = RT.infileStateAdapter.createInFileStateAdapter(document, {',
    '      onChange: function (s) { latestState = s; }',
    '    });',
    '    function normHref() {',
    '      try { var l = location; return (l.origin || (l.protocol + "//" + l.host)) + l.pathname; } catch (e) { return (typeof location !== "undefined" ? location.href : ""); }',
    '    }',
    '    var adapter = (RT.localStorageStateAdapter && typeof window !== "undefined" && window.localStorage)',
    '      ? RT.localStorageStateAdapter.createLocalStorageStateAdapter({',
    '          doc: document,',
    '          storage: window.localStorage,',
    '          inner: inner,',
    '          attachKey: normHref()',
    '        })',
    '      : inner;',
```

- [ ] **Step 2: Pass history hooks into `boot()` in `EMBEDDED_BOOT`**

In the `RT.boot.boot({ ... })` call inside `EMBEDDED_BOOT`, add a `history` field after
`exporter: exporterHooks,`:

```js
    '      history: (adapter.getHistory ? {',
    '        getHistory: function () { return adapter.getHistory(); },',
    '        getSection: function (ref) { return adapter.getSection(ref); },',
    '        clearCurrent: function () { return adapter.clearCurrent(); }',
    '      } : null),',
```

- [ ] **Step 3: Forward `history` from `boot()` to `mountOverlay`**

In `src/runtime/boot.js`, in the `overlayApi.mountOverlay({ ... })` call, add:

```js
      history: cfg.history || null,
```

(Place it alongside the existing `exporter: cfg.exporter || {}` entry.)

- [ ] **Step 4: Accept `history` and add the "Clear my comments" menu item (overlay.js)**

In `src/runtime/overlay.js`, in `mountOverlay(cfg)`, read the hooks near the other cfg
reads (after `const getState = ...`):

```js
    const history = cfg.history || null;
```

In the sidebar `innerHTML` Save menu (after the `.nb-save-pdf` item block, before the
menu's closing `</div>`), add a separator + clear item:

```js
      '      <div class="nb-menu-sep" role="none"></div>' +
      '      <button type="button" class="nb-menu-item nb-clear-comments" role="menuitem">' +
      '        <span class="nb-mi-label">Clear my comments (this draft)</span>' +
      '      </button>' +
```

After the existing `sidebar.querySelector('.nb-save-pdf')...` wiring (~overlay.js:518),
wire the clear item (hidden when there are no history hooks):

```js
    const clearBtn = sidebar.querySelector('.nb-clear-comments');
    if (!history) { clearBtn.style.display = 'none'; }
    else {
      clearBtn.addEventListener('click', function () {
        closeSaveMenu();
        Promise.resolve(history.clearCurrent()).then(function () {
          const empty = { schemaVersion: 1, docId: (getState() || {}).docId || '', docTitle: (getState() || {}).docTitle || '', comments: [] };
          setState(empty);
          repaintHighlights();
          renderSidebar();
        });
      });
    }
```

- [ ] **Step 5: Render the "Earlier feedback" section**

In `src/runtime/overlay.js`, at the end of `renderSidebar()` (after the orphan group
block, before the reveal animation code ~overlay.js:1145), append a call:

```js
      renderHistory();
```

Then add the `renderHistory` function next to `renderSidebar`:

```js
    let historyLoaded = false;
    function renderHistory() {
      if (!history) return;
      const existing = elList.querySelector('.nb-history');
      if (existing) existing.remove();
      const wrap = doc.createElement('div');
      wrap.className = 'nb-history';
      wrap.setAttribute('data-noteback-ui', 'history');
      elList.appendChild(wrap);
      Promise.resolve(history.getHistory()).then(function (drafts) {
        if (!drafts || drafts.length === 0) { wrap.remove(); return; }
        const label = doc.createElement('div');
        label.className = 'nb-group-label';
        label.textContent = 'Earlier feedback (' + drafts.length + (drafts.length === 1 ? ' draft)' : ' drafts)');
        wrap.appendChild(label);
        drafts.forEach(function (d) {
          const dl = doc.createElement('div');
          dl.className = 'nb-hist-draft';
          dl.textContent = 'Draft · ' + formatWhen(d.lastEditedAt || d.firstSeenAt) + ' (' + d.comments.length + ')';
          wrap.appendChild(dl);
          d.comments.forEach(function (c) {
            const item = doc.createElement('button');
            item.type = 'button';
            item.className = 'nb-hist-item';
            const quote = (c.anchor && c.anchor.quote) ? condense(c.anchor.quote) : '(note on the whole document)';
            item.textContent = '“' + quote + '” — ' + (c.body || '');
            if (c.anchor && d.hasSnapshot && c.sectionId) {
              item.addEventListener('click', function () { openHistoryPopup(d.contentHash, c); });
            } else {
              item.disabled = true;
            }
            wrap.appendChild(item);
          });
        });
      });
    }

    function condense(q) {
      if (rt().markdown && rt().markdown.condenseQuote) return rt().markdown.condenseQuote(q);
      return q.length > 80 ? q.slice(0, 77) + '…' : q;
    }
    function formatWhen(iso) {
      const d = new Date(iso || 0);
      if (isNaN(d.getTime())) return 'earlier';
      return d.toLocaleString();
    }
```

> Note: each history comment already carries a `sectionId` — the core `persist`
> stores `sectionByCommentId` and `history()` attaches `c.sectionId` (Task 2, fixed),
> and the adapter's `save` passes `sectionByCommentId` from `extractSections`
> (Task 6). So the popup gating on `c.sectionId` works with no extra plumbing here.
> Add one core test (in `test/draft-history-core.test.js`) to lock it in:

```js
test('history attaches sectionId from the persisted map', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'draft body padding text here xx', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'n', anchor: { quote: 'x', prefix: '', suffix: '', occurrence: 0 }, createdAt: 'x', author: null }], sections: [{ id: 's1', html: 'f' }], styles: '', sectionByCommentId: { c1: 's1' } });
  const r2 = await dh.resolve({ contentText: 'a different draft body padding xx', attachKey: key, fallbackComments: [] });
  const hist = await dh.history({ lineageId: r2.lineageId, exceptHash: r2.contentHash });
  assert.strictEqual(hist[0].comments[0].sectionId, 's1');
});
```

- [ ] **Step 6: Implement the snapshot popup**

In `src/runtime/overlay.js`, add the popup builder (uses an `<iframe srcdoc>`):

```js
    function openHistoryPopup(contentHash, comment) {
      Promise.resolve(history.getSection({ contentHash: contentHash, sectionId: comment.sectionId })).then(function (sec) {
        const back = doc.createElement('div');
        back.className = 'nb-hist-backdrop';
        back.setAttribute('data-noteback-ui', 'history-popup');
        const panel = doc.createElement('div');
        panel.className = 'nb-hist-panel';
        const close = doc.createElement('button');
        close.type = 'button'; close.className = 'nb-hist-close'; close.textContent = '✕';
        close.addEventListener('click', function () { back.remove(); });
        back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
        const frame = doc.createElement('iframe');
        frame.className = 'nb-hist-frame';
        const quote = (comment.anchor && comment.anchor.quote) || '';
        const safeQuote = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const styles = (sec && sec.styles) || '';
        const bodyHtml = (sec && sec.html) || '<p>(context no longer stored)</p>';
        const script = '<scr' + 'ipt>(function(){try{var q=' + JSON.stringify(quote) + ';if(!q)return;var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);var n;while(n=w.nextNode()){var i=n.nodeValue.indexOf(q);if(i>=0){var r=document.createRange();r.setStart(n,i);r.setEnd(n,i+q.length);var m=document.createElement("mark");m.style.background="#fde68a";r.surroundContents(m);m.scrollIntoView({block:"center"});break;}}}catch(e){}})();</scr' + 'ipt>';
        frame.srcdoc = '<!DOCTYPE html><html><head><base href="' + (typeof location !== 'undefined' ? location.href : '') + '"><style>' + styles + '</style></head><body>' + bodyHtml + script + '</body></html>';
        panel.appendChild(close); panel.appendChild(frame);
        back.appendChild(panel); uiRoot.appendChild(back);
        void safeQuote;
      });
    }
```

- [ ] **Step 7: Add minimal CSS for the history UI**

In `src/runtime/overlay.js`, in the `BUTTON_CSS`/styles string block (where `.nb-menu`
etc. are defined), append rules:

```js
    '.nb-history{margin-top:10px;border-top:1px solid var(--nb-line);padding-top:8px;}',
    '.nb-hist-draft{font-size:12px;color:var(--nb-ink-soft,#6b7280);margin:8px 0 4px;}',
    '.nb-hist-item{display:block;width:100%;text-align:left;border:none;background:none;cursor:pointer;padding:6px 8px;border-radius:8px;font:inherit;color:inherit;}',
    '.nb-hist-item:hover:not(:disabled){background:var(--nb-accent-wash);}',
    '.nb-hist-item:disabled{opacity:.55;cursor:default;}',
    '.nb-hist-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
    '.nb-hist-panel{position:relative;width:min(820px,92vw);height:min(80vh,720px);background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);}',
    '.nb-hist-close{position:absolute;top:8px;right:8px;z-index:2;border:none;background:#0001;border-radius:50%;width:28px;height:28px;cursor:pointer;}',
    '.nb-hist-frame{width:100%;height:100%;border:0;background:#fff;}',
```

- [ ] **Step 8: Expose `clearCurrent`/parity on the controller**

In `src/runtime/overlay.js` `mountOverlay`'s returned controller object (~overlay.js:1647),
no new method is strictly required (clear is wired to the menu), but add for testability:

```js
      getController: function () { return controller; },
```

only if a `getController` is referenced elsewhere; otherwise skip. (CONTRACTS.md lists
`getController` on the boot controller — verify it already exists in `boot.js`; if so,
no change here.)

- [ ] **Step 9: Build a canvas and sanity-check it loads**

Run:

```bash
node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html
node -e "const fs=require('fs');const h=fs.readFileSync('examples/spec.canvas.html','utf8');if(!/NotebackRuntime\.localStorageStateAdapter/.test(h))throw new Error('adapter missing');if(!/nb-clear-comments/.test(h))throw new Error('clear item missing');console.log('canvas OK',h.length,'bytes');"
```

Expected: `canvas OK <n> bytes` (no throw).

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS (including the new core `sectionId` test from Step 5).

- [ ] **Step 11: Commit**

```bash
git add src/canvas/exporter.js src/runtime/overlay.js src/runtime/boot.js src/runtime/draft-history-core.js test/draft-history-core.test.js
git commit -m "feat(canvas): wire localStorage adapter, history section, snapshot popup, clear

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Live verification (Playwright, localhost)

**Files:** none (manual/automated live check). Per `CLAUDE.md`: serve over localhost
(not `file://`), and after editing `src/runtime/*` rebuild the canvas and cache-bust
the URL.

- [ ] **Step 1: Rebuild the canvas fixture**

Run:

```bash
node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html
```

- [ ] **Step 2: Serve and open**

Run (background): `python3 -m http.server 8099` (from the repo root).
Open `http://localhost:8099/examples/spec.canvas.html?v=1`.

- [ ] **Step 3: Verify refresh persistence**

Select text → add a comment via the 💬 chip → reload the page (bump `?v=2`).
Expected: the comment is still present after reload (loaded from localStorage).

- [ ] **Step 4: Verify draft history on content change**

In DevTools console, change the document text to simulate regeneration:
`document.getElementById('noteback-doc-root').querySelector('p').textContent = 'Completely different sentence to force a new content hash here.'` then reload.
Expected: current comments are empty (new draft); the sidebar shows an "Earlier
feedback (1 draft)" section listing the prior comment.

- [ ] **Step 5: Verify the snapshot popup**

Click the earlier-feedback comment.
Expected: a modal opens with the section's HTML, styled, and the quoted passage
highlighted in yellow.

- [ ] **Step 6: Verify clear**

Open Save ▾ → "Clear my comments (this draft)".
Expected: the current draft's comments are removed; the earlier-feedback history
remains.

- [ ] **Step 7: Verify degradation**

Open the same canvas as a `file://` URL in a browser where `file://` localStorage is
blocked (or stub `window.localStorage = null` before boot in a console-injected copy).
Expected: comments behave as before (in-file only), no console errors; the Clear item
is hidden.

- [ ] **Step 8: Commit any fixes**

```bash
git add -A
git commit -m "fix(canvas): address issues found in live verification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(If no fixes were needed, skip this commit.)

---

## Task 10: Docs — CLAUDE.md gotchas + spec status

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/2026-06-05-canvas-comment-persistence-and-history.md`

- [ ] **Step 1: Add gotchas to `CLAUDE.md`**

Under "Gotchas that already bit us", add:

```markdown
- **Draft identity is hashed from the CLEAN, pre-paint content root.** The
  localStorage adapter resolves the content hash from `#noteback-doc-root`
  `textContent` at construction, before highlights are painted — never recompute it
  from the live DOM after `<mark>` wrappers are added, or the hash shifts.
- **`file://` localStorage is one shared bucket** across all local canvases (Chrome).
  Keys are content-hashed and namespaced (`nb:gen:`/`nb:lin:`/`nb:attach`) precisely
  so distinct documents don't collide in that shared bucket.
- **History snapshots render in an `<iframe srcdoc>`** with the draft's inline
  `<style>` only; external stylesheets/remote images won't load there. That's
  expected — the popup shows structure + text + the highlight, not a pixel-perfect
  reproduction.
```

- [ ] **Step 2: Mark the spec's canvas half implemented**

In `docs/2026-06-05-canvas-comment-persistence-and-history.md`, change the Status line
to: `**Status:** canvas half implemented (Plan 1); extension half pending (Plan 2).`

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/2026-06-05-canvas-comment-persistence-and-history.md
git commit -m "docs: persistence/history gotchas + spec status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (for the implementer)

- After Task 8 Step 5 you MUST have added `sectionByCommentId` plumbing to
  `draft-history-core.js` (`persist` saves it; `history` attaches `c.sectionId`) and
  to the adapter's `dh.persist(...)` call — the overlay's popup gating depends on
  `c.sectionId`. Don't skip the core test for it.
- Verify name consistency across tasks: `createDraftHistory`, `resolve`, `persist`,
  `history`, `section`, `clearCurrent`; `createLocalStorageStateAdapter` with
  `getHistory`/`getSection`/`clearCurrent`; `extractSections` returns
  `{ sections, styles, sectionByCommentId }`.
- Keys are exactly `nb:gen:<hash>`, `nb:lin:<lineageId>`, `nb:attach`.
- The inlined-runtime order (Task 7) must keep `draft-history-core.js` + `snapshot.js`
  before `localstorage-state-adapter.js`, and all of them before `exporter.js`/`boot.js`.
