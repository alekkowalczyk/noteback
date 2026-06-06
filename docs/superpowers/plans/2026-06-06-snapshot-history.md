# Snapshot-based Document History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Noteback's two divergent persistence/history models with a single engine — a per-document timeline of *full-document* version snapshots — that behaves identically in embedded (canvas) and extension modes.

**Architecture:** One storage-agnostic core (`draft-history-core`) keyed by an explicit **doc-id** (baked into the canvas, or stored per-URL in the extension), with versions keyed by content hash (falling back to the doc-id when content is too short to hash). At a version's first comment, the whole clean document is gzipped and stored once. The same core runs over two kv backends — `localStorage` (embedded) and `chrome.storage.local` (extension) — via thin stores. The overlay renders a version timeline; peeking re-uses the *live* highlight painter against a parsed snapshot (retiring the section-extraction subsystem and the cross-node re-highlighter). Migration is a **clean break** (new key namespaces; old data ignored).

**Tech Stack:** Vanilla ES5-ish browser JS (zero deps, no build), UMD-lite dual exports, Node built-in test runner (`node --test`) for pure/DI-tested modules, Playwright for DOM/e2e. CompressionStream gzip with an identity fallback.

**Source of truth:** the design doc `snapshot-history-design.html` (locked decisions in §7). Read it before starting.

---

## Locked decisions (from design §7)

- **Checkout depth:** full — inline peek + **open as a live canvas tab** + copy feedback.
- **Re-wrap continuity:** `wrap` preserves the baked `doc-id` (reuse from the `-o` target; plus a `--id` flag).
- **"Return to live" wording:** **"Back to current"**.
- **Sequencing:** both modes at once (one shared engine; build is still phased by task).
- **Collapsed history:** show the most-recent earlier version inline; collapse the rest under "+N older versions" (hidden at 0 earlier versions, inline at exactly 1, collapsed at 2+).
- **Retention:** reuse existing limits (≈5 full snapshots · 15 metadata · 90-day TTL · ~3 MB cap).
- **Migration:** clean break — no migration code. Embedded current comments still load from the in-file block; extension per-URL comments reset on upgrade.
- **Identity:** baked `doc-id` wins; extension URL→id map otherwise. `unlimitedStorage` deferred.
- **Snapshot scope:** on by default for `file://` / `localhost` / `127.0.0.1` / wrapped canvases; per-site **opt-in** for arbitrary `http(s)` (rides `nb:settings`).

---

## File structure (decomposition)

**Rewrite**
- `src/runtime/draft-history-core.js` — re-keyed to doc-id + version-key, stores one gzipped full-doc snapshot per version. New API: `resolve / persist / history / version / clearCurrent` (+ internal `prune`). Drops `attach`/`lineage`/`section` concepts and `mintId`.

**New**
- `src/adapters/chrome-kv-store.js` — async `{get,set,remove,keys}` over `chrome.storage.local` (the extension backend for the core). Dual-export.
- `src/adapters/history-state-adapter.js` — mode-agnostic StorageAdapter that wraps an inner adapter + a kv store + the core; captures the full-doc snapshot at first comment; exposes `getHistory / getVersion / clearCurrent`. Dual-export. (Generalizes today's `localstorage-state-adapter.js`.)
- `src/runtime/snapshot-capture.js` — tiny DOM util: `captureCleanDoc(doc)` → full clean-document HTML (no Noteback UI / runtime / state block / marks). Replaces the per-mode copies inline in `content-script.js` and `EMBEDDED_BOOT`. Holds the `identityCodec` no-op too.

**Modify**
- `src/runtime/overlay.js` — replace `renderHistory`/`openHistoryPopup`/`nbHistHighlight` with the version timeline + peek (live painter) + checkout + "Back to current" banner.
- `src/canvas/canvas-template.html` — bake `data-noteback-doc-id="{{DOC_ID}}"` on `#noteback-doc-root`.
- `src/canvas/exporter.js` — `buildCanvasHtml` substitutes `{{DOC_ID}}`; `EMBEDDED_BOOT` wires the new adapter (localStorage store) + reads the baked id + snapshot capture + version-checkout builder.
- `bin/noteback.js` — `wrapHtml`/`wrapFile` mint/thread a `doc-id`; `--id` flag; idempotent reuse of the id from the `-o` target.
- `src/content/content-script.js` — wire the new adapter over `chrome-kv-store`; resolve doc-id (baked attr if canvas, else `nb:url` map); gate snapshot/history by per-site opt-in; pass `history` config to boot.
- `src/content/origin-policy.js` — add `historyAllowed(info, settings)` + `historySites` to `normalizeSettings`.
- `manifest.json` — add `draft-history-core.js`, `chrome-kv-store.js`, `history-state-adapter.js`, `snapshot-capture.js` to `content_scripts[0].js`; keep `web_accessible_resources` in sync.
- `CONTRACTS.md`, `CLAUDE.md` — document the new model and gotchas.

**Delete**
- `src/runtime/snapshot.js` and `test/snapshot.test.js` (section-extraction subsystem retired).
- `src/adapters/localstorage-state-adapter.js` and `test/localstorage-adapter.test.js` (superseded by `history-state-adapter.js`).

---

## Data model (new)

Key namespaces in the kv store (replaces `nb:gen:`/`nb:lin:`/`nb:attach`):

| Key | Holds |
|---|---|
| `nb:doc:<docId>` | `{ schemaVersion:1, docId, docTitle, versions:[versionKey,…] }` (oldest→newest) |
| `nb:ver:<versionKey>` | `{ schemaVersion:1, versionKey, docId, contentHash, comments:[], snapshotHtml:<gz str|''>, createdAt, lastEditedAt, docTitle }` |
| `nb:url:<normalizedHref>` | `<docId>` (extension only; minted when no baked id) |

`versionKey = contentHash(contentText) || ('h0:' + docId)` — deterministic, so a sub-32-char document still gets a stable single version (this is the "fallback identity" from design Q1; no random GUIDs needed). `comment` shape is unchanged (`state.js`: `{id, anchor|null, body, createdAt, author:null}`).

---

# Phase 0 — Doc-id baking (template + exporter + wrap)

### Task 1: Template + exporter substitute a baked `data-noteback-doc-id`

**Files:**
- Modify: `src/canvas/canvas-template.html:33`
- Modify: `src/canvas/exporter.js` (`buildCanvasHtml` 212–237; export list 597–609)
- Test: `test/exporter.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/exporter.test.js`:

```js
test('buildCanvasHtml bakes data-noteback-doc-id onto #noteback-doc-root', () => {
  const html = exporter.buildCanvasHtml({
    docHtml: '<html><body><p>hello world this is the body</p></body></html>',
    state: { schemaVersion: 1, docId: 'D7a', docTitle: 'x', comments: [] },
    templateHtml: '<div id="noteback-doc-root" data-noteback-doc-id="{{DOC_ID}}">{{DOC_BODY}}</div>',
    inlinedRuntime: ''
  });
  assert.ok(html.includes('data-noteback-doc-id="D7a"'), 'baked id present');
  assert.ok(!html.includes('{{DOC_ID}}'), 'token consumed');
});
```

- [ ] **Step 2: Run it, verify it fails** — `node --test test/exporter.test.js` → FAIL (token not replaced).

- [ ] **Step 3: Implement** — in `src/canvas/exporter.js` `buildCanvasHtml`, after the `DOC_TITLE` replace (line ~232) add:

```js
  out = replaceToken(out, 'DOC_ID', escapeHtml(String(state.docId == null ? '' : state.docId)));
```

In `src/canvas/canvas-template.html` line 33 change to:

```html
  <div id="noteback-doc-root" data-noteback-doc-id="{{DOC_ID}}">
```

- [ ] **Step 4: Run it, verify it passes** — `node --test test/exporter.test.js` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(canvas): bake data-noteback-doc-id onto #noteback-doc-root"`

---

### Task 2: `wrap` CLI mints/threads doc-id, `--id` flag, idempotent `-o` reuse

**Files:**
- Modify: `bin/noteback.js` (`parseArgs` 237–250; `wrapHtml` 88–105; `wrapFile` 111–117; `main` ~276; exports 292)
- Test: `test/cli-wrap.test.js`

- [ ] **Step 1: Write failing tests** — append to `test/cli-wrap.test.js`:

```js
test('wrapHtml mints a doc-id when none is given', () => {
  const html = cli.wrapHtml('<html><body><p>some adequately long document body text here</p></body></html>', { sourceName: 'a.html' });
  const m = /data-noteback-doc-id="([^"]+)"/.exec(html);
  assert.ok(m && m[1] && m[1] !== 'a.html', 'a real minted id, not the basename');
});

test('wrapHtml honors an explicit docId', () => {
  const html = cli.wrapHtml('<html><body><p>body text that is long enough</p></body></html>', { sourceName: 'a.html', docId: 'FIXED1' });
  assert.ok(html.includes('data-noteback-doc-id="FIXED1"'));
});

test('re-wrap reuses the doc-id already in the -o target', () => {
  const tmp = path.join(os.tmpdir(), 'nb-id-' + process.pid + '.canvas.html');
  fs.writeFileSync(tmp, cli.wrapHtml('<html><body><p>first body long enough to hash</p></body></html>', { sourceName: 'a.html', docId: 'KEEPME' }));
  const r = cli.wrapFile(path.join(__dirname, 'fixtures', 'plain.html'), tmp); // see note
  const out = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  assert.ok(out.includes('data-noteback-doc-id="KEEPME"'), 'id preserved across re-wrap');
});
```

> If `test/fixtures/plain.html` doesn't exist, create it: `<!DOCTYPE html><html><body><p>a different body, also long enough to hash nicely</p></body></html>`. Confirm `os`/`fs`/`path` are required at the top of the test file (add `const os = require('node:os');` if missing).

- [ ] **Step 2: Run, verify failure** — `node --test test/cli-wrap.test.js` → FAIL.

- [ ] **Step 3: Implement** in `bin/noteback.js`:

`parseArgs` — add `id: null` to the initial `args` (line 238) and a branch (after line 242):

```js
    else if (a === '--id') args.id = argv[++i];
```

Add a doc-id helper near `deriveTitle`:

```js
function mintDocId() {
  // Stable, URL-safe, no deps. Time + two random chunks.
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}
function readBakedDocId(html) {
  const m = /id\s*=\s*["']noteback-doc-root["'][^>]*\bdata-noteback-doc-id\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  return m ? m[1] : null;
}
```

`wrapHtml` — set `docId` from the option, else mint (line 95):

```js
      docId: o.docId != null && String(o.docId) !== '' ? String(o.docId) : mintDocId(),
```

`wrapFile` — resolve precedence (explicit → existing `-o` id → mint), pass it through (rewrite 111–117):

```js
function wrapFile(inputPath, outputPath, explicitId) {
  const out = outputPath || inputPath;
  const docHtml = fs.readFileSync(inputPath, 'utf8');
  let docId = explicitId || null;
  if (!docId && fs.existsSync(out)) docId = readBakedDocId(fs.readFileSync(out, 'utf8'));
  if (!docId) docId = readBakedDocId(docHtml); // re-wrap in place keeps its own id
  const html = wrapHtml(docHtml, { sourceName: path.basename(inputPath), docId: docId || undefined });
  fs.writeFileSync(out, html);
  return { out: out, bytes: html.length, title: deriveTitle(docHtml, path.basename(inputPath)) };
}
```

`main` (line ~276) — pass the flag: `const r = wrapFile(args.input, args.out, args.id);`

Add `mintDocId, readBakedDocId` to `module.exports` (line 292).

- [ ] **Step 4: Run, verify pass** — `node --test test/cli-wrap.test.js` → PASS. Also update any existing assertion in this file that expects `docId` to equal the basename.

- [ ] **Step 5: Commit** — `git commit -am "feat(wrap): mint/thread a stable doc-id (--id, -o reuse, in-place preserve)"`

---

# Phase 1 — History core rework (pure, full TDD)

### Task 3: Rewrite `draft-history-core` keyed by doc-id + full-doc snapshots

**Files:**
- Rewrite: `src/runtime/draft-history-core.js`
- Rewrite: `test/draft-history-core.test.js`

Keep `normalizeText`, `cyrb53`, `contentHash`, `MIN_HASH_CHARS` exactly as today (`draft-history-core.js:19–47`). Replace everything from `const GEN = …` onward.

- [ ] **Step 1: Write failing tests** — rewrite `test/draft-history-core.test.js` around the new API. Core cases:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/runtime/draft-history-core.js');

const idCodec = { compress: (s) => Promise.resolve(String(s)), decompress: (s) => Promise.resolve(String(s)) };
function fakeStore() {
  const m = new Map();
  return {
    get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); return Promise.resolve(); },
    remove: (k) => { m.delete(k); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(m.keys()))
  };
}
function makeCore(store) {
  let n = 0;
  return core.createDraftHistory({ store, now: () => '2026-06-05T00:00:0' + (n++ % 10) + 'Z', codec: idCodec,
    limits: { snapshotDrafts: 5, metaDrafts: 15, ttlDays: 99999, maxBytes: 1e9 } });
}
const LONG = 'The design uses a single Redis instance to coordinate the workers.';

test('resolve creates a version and lists it under the doc', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.docId, 'D1');
  assert.ok(r.versionKey);
  assert.deepStrictEqual(r.comments, []);
});

test('a content change makes a new version in the same doc; history shows the old one', async () => {
  const dh = makeCore(fakeStore());
  const r1 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r1.versionKey, comments: [{ id: 'c1', body: 'old', anchor: { quote: 'Redis', prefix: '', suffix: '', occurrence: 0 }, createdAt: 'x', author: null }], snapshotHtml: '<html>OLD</html>' });
  const r2 = await dh.resolve({ docId: 'D1', contentText: LONG + ' Now changed materially here.', fallbackComments: [], docTitle: 'T' });
  assert.notStrictEqual(r2.versionKey, r1.versionKey);
  const hist = await dh.history({ docId: 'D1', exceptVersionKey: r2.versionKey });
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].comments[0].body, 'old');
  assert.strictEqual(hist[0].hasSnapshot, true);
});

test('version() decompresses the stored full-doc snapshot + comments', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>SNAP</html>' });
  const v = await dh.version({ versionKey: r.versionKey });
  assert.strictEqual(v.html, '<html>SNAP</html>');
  assert.strictEqual(v.comments.length, 1);
});

test('snapshot is captured once; a later persist without snapshot keeps it', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>FIRST</html>' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1' }, { id: 'c2' }], snapshotHtml: '<html>SECOND</html>' });
  const v = await dh.version({ versionKey: r.versionKey });
  assert.strictEqual(v.html, '<html>FIRST</html>', 'first snapshot is immutable');
});

test('short content still gets a stable deterministic version key (no degrade)', async () => {
  const dh = makeCore(fakeStore());
  const a = await dh.resolve({ docId: 'D1', contentText: 'hi', fallbackComments: [], docTitle: 'T' });
  const b = await dh.resolve({ docId: 'D1', contentText: 'hi', fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(a.degraded, false);
  assert.strictEqual(a.versionKey, b.versionKey);
  assert.strictEqual(a.versionKey, 'h0:D1');
});

test('no docId → degraded, returns fallback comments, no history', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: '', contentText: LONG, fallbackComments: [{ id: 'c1' }] });
  assert.strictEqual(r.degraded, true);
  assert.deepStrictEqual(r.comments, [{ id: 'c1' }]);
});

test('clearCurrent empties the current version but keeps history', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>S</html>' });
  await dh.clearCurrent({ docId: 'D1', versionKey: r.versionKey });
  const v = await dh.version({ versionKey: r.versionKey });
  assert.deepStrictEqual(v.comments, []);
});

test('prune drops versions beyond metaDrafts, never the newest/protected', async () => {
  const dh = core.createDraftHistory({ store: fakeStore(), now: () => '2026-06-05T00:00:00Z', codec: idCodec,
    limits: { snapshotDrafts: 1, metaDrafts: 2, ttlDays: 99999, maxBytes: 1e9 } });
  let last;
  for (let i = 0; i < 5; i++) {
    const r = await dh.resolve({ docId: 'D1', contentText: LONG + ' rev ' + i + ' padding padding padding', fallbackComments: [], docTitle: 'T' });
    await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c' + i }], snapshotHtml: '<html>S' + i + '</html>' });
    last = r.versionKey;
  }
  const hist = await dh.history({ docId: 'D1', exceptVersionKey: last });
  assert.ok(hist.length <= 2, 'metadata window enforced');
});
```

- [ ] **Step 2: Run, verify failure** — `node --test test/draft-history-core.test.js` → FAIL (`resolve` shape changed / methods missing).

- [ ] **Step 3: Implement** — rewrite `src/runtime/draft-history-core.js` factory. Keep the header IIFE + `normalizeText/cyrb53/contentHash/MIN_HASH_CHARS`. New body:

```js
  const DOC = 'nb:doc:';
  const VER = 'nb:ver:';

  function defaultLimits(l) {
    l = l || {};
    return { snapshotDrafts: l.snapshotDrafts || 5, metaDrafts: l.metaDrafts || 15, ttlDays: l.ttlDays || 90, maxBytes: l.maxBytes || 3000000 };
  }

  function createDraftHistory(cfg) {
    const store = cfg.store;
    const now = cfg.now || (() => new Date().toISOString());
    const codec = cfg.codec || { compress: (s) => Promise.resolve(s), decompress: (s) => Promise.resolve(s) };
    const limits = defaultLimits(cfg.limits);

    const docKey = (id) => DOC + id;
    const verKey = (k) => VER + k;

    function ensureDoc(docId, versionKey, docTitle) {
      return store.get(docKey(docId)).then((d) => {
        d = { schemaVersion: 1, docId: docId, docTitle: (d && d.docTitle) || String(docTitle || ''), versions: (d && d.versions ? d.versions.slice() : []) };
        if (d.versions.indexOf(versionKey) === -1) d.versions.push(versionKey);
        return store.set(docKey(docId), d);
      });
    }

    function resolve(opts) {
      const docId = String(opts.docId == null ? '' : opts.docId);
      if (!docId) return Promise.resolve({ degraded: true, docId: null, versionKey: null, contentHash: null, comments: opts.fallbackComments || [] });
      const hash = contentHash(opts.contentText);
      const versionKey = hash || ('h0:' + docId);
      return store.get(verKey(versionKey)).then((ver) => {
        if (ver) {
          return ensureDoc(docId, versionKey, opts.docTitle).then(() => prune(docId, versionKey))
            .then(() => ({ degraded: false, docId: docId, versionKey: versionKey, contentHash: hash, comments: (ver.comments || []).slice() }));
        }
        ver = { schemaVersion: 1, versionKey: versionKey, docId: docId, contentHash: hash,
          comments: (opts.fallbackComments || []).slice(), snapshotHtml: '', createdAt: now(), lastEditedAt: now(), docTitle: String(opts.docTitle || '') };
        return store.set(verKey(versionKey), ver).then(() => ensureDoc(docId, versionKey, opts.docTitle)).then(() => prune(docId, versionKey))
          .then(() => ({ degraded: false, docId: docId, versionKey: versionKey, contentHash: hash, comments: (opts.fallbackComments || []).slice() }));
      });
    }

    function persist(p) {
      return store.get(verKey(p.versionKey)).then((ver) => {
        if (!ver) return; // resolve() must run first
        ver = Object.assign({}, ver);
        ver.comments = (p.comments || []).slice();
        if (p.snapshotHtml != null && p.snapshotHtml !== '' && !ver.snapshotHtml) ver.snapshotHtml = p.snapshotHtml; // capture once
        ver.lastEditedAt = now();
        return store.set(verKey(p.versionKey), ver).then(() => prune(ver.docId || p.docId, p.versionKey));
      });
    }

    function history(q) {
      return store.get(docKey(q.docId)).then((doc) => {
        if (!doc) return [];
        const keys = doc.versions.slice().reverse(); // newest first
        const out = [];
        return keys.reduce((chain, k) => chain.then(() => {
          if (k === q.exceptVersionKey) return;
          return store.get(verKey(k)).then((ver) => {
            if (ver && ver.comments && ver.comments.length > 0) {
              out.push({ versionKey: k, docId: ver.docId, docTitle: ver.docTitle, createdAt: ver.createdAt, lastEditedAt: ver.lastEditedAt, hasSnapshot: !!ver.snapshotHtml, comments: ver.comments.slice() });
            }
          });
        }), Promise.resolve()).then(() => out);
      });
    }

    function version(q) {
      return store.get(verKey(q.versionKey)).then((ver) => {
        if (!ver) return null;
        return codec.decompress(ver.snapshotHtml || '').then((html) => ({ html: html, comments: (ver.comments || []).slice(), docTitle: ver.docTitle, contentHash: ver.contentHash }));
      });
    }

    function clearCurrent(q) {
      return store.get(verKey(q.versionKey)).then((ver) => {
        if (!ver) return;
        ver = Object.assign({}, ver, { comments: [], snapshotHtml: '', lastEditedAt: now() });
        return store.set(verKey(q.versionKey), ver);
      });
    }

    // Retention: snapshot window, metadata window, TTL, then a coarse global byte cap.
    function prune(docId, protectedKey) {
      return store.get(docKey(docId)).then((doc) => {
        if (!doc) return;
        const vers = doc.versions.slice(); // oldest→newest
        const newest = vers[vers.length - 1];
        const ttlCutoff = Date.parse(now()) - limits.ttlDays * 86400000;
        return vers.reduce((chain, k, idx) => chain.then(() => store.get(verKey(k)).then((ver) => {
          if (!ver) return;
          if (k === protectedKey || k === newest) return;
          const ageFromNewest = vers.length - 1 - idx;
          const tooOld = isFinite(ttlCutoff) && Date.parse(ver.lastEditedAt) < ttlCutoff;
          if (ageFromNewest >= limits.metaDrafts || tooOld) return store.remove(verKey(k));
          if (ageFromNewest >= limits.snapshotDrafts && ver.snapshotHtml) {
            ver = Object.assign({}, ver, { snapshotHtml: '' });
            return store.set(verKey(k), ver);
          }
        })), Promise.resolve()).then(() => {
          const kept = [];
          return vers.reduce((chain, k) => chain.then(() => store.get(verKey(k)).then((ver) => { if (ver) kept.push(k); })), Promise.resolve())
            .then(() => store.set(docKey(docId), { schemaVersion: 1, docId: doc.docId, docTitle: doc.docTitle, versions: kept }));
        }).then(() => enforceByteCap(protectedKey));
      });
    }

    function enforceByteCap(protectedKey) {
      return store.keys().then((allKeys) => {
        const vKeys = allKeys.filter((k) => k.indexOf(VER) === 0);
        return Promise.all(vKeys.map((k) => store.get(k).then((g) => ({ key: k, ver: g })))).then((all) => {
          const entries = all.filter((e) => e.ver);
          const newestByDoc = {};
          entries.forEach((e) => { const t = Date.parse(e.ver.lastEditedAt) || 0; const d = e.ver.docId;
            if (!newestByDoc[d] || t >= newestByDoc[d].t) newestByDoc[d] = { t: t, key: e.key }; });
          const protectedKeys = {};
          Object.keys(newestByDoc).forEach((d) => { protectedKeys[newestByDoc[d].key] = true; });
          if (protectedKey) protectedKeys[VER + protectedKey] = true;
          const total = () => entries.reduce((s, e) => s + (e.ver ? JSON.stringify(e.ver).length : 0), 0);
          entries.sort((a, b) => (Date.parse(a.ver.lastEditedAt) || 0) - (Date.parse(b.ver.lastEditedAt) || 0));
          const setOps = [], removeKeys = {};
          for (let i = 0; i < entries.length && total() > limits.maxBytes; i++) {
            const e = entries[i];
            if (e.key === VER + protectedKey) continue;
            if (e.ver && e.ver.snapshotHtml) { e.ver = Object.assign({}, e.ver, { snapshotHtml: '' }); setOps.push(e); }
          }
          for (let j = 0; j < entries.length && total() > limits.maxBytes; j++) {
            const e = entries[j];
            if (!e.ver || protectedKeys[e.key]) continue;
            removeKeys[e.key] = true; e.ver = null;
          }
          const sets = setOps.filter((e) => !removeKeys[e.key]);
          return Promise.all(sets.map((e) => store.set(e.key, e.ver)))
            .then(() => Promise.all(Object.keys(removeKeys).map((k) => store.remove(k))));
        });
      });
    }

    return { resolve, persist, history, version, clearCurrent };
  }

  return { MIN_HASH_CHARS, normalizeText, contentHash, cyrb53, createDraftHistory };
```

- [ ] **Step 4: Run, verify pass** — `node --test test/draft-history-core.test.js` → all PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(history-core): re-key to doc-id + full-doc version snapshots"`

---

# Phase 2 — kv backends

### Task 4: `chrome-kv-store.js` over `chrome.storage.local`

**Files:**
- Create: `src/adapters/chrome-kv-store.js`
- Test: `test/chrome-kv-store.test.js`

- [ ] **Step 1: Write failing test** — create `test/chrome-kv-store.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('../src/adapters/chrome-kv-store.js');

function fakeChrome() {
  const m = new Map();
  return { runtime: {}, storage: { local: {
    get: (k, cb) => { if (k === null) { const o = {}; m.forEach((v, kk) => { o[kk] = v; }); return cb(o); } const o = {}; if (m.has(k)) o[k] = m.get(k); cb(o); },
    set: (bag, cb) => { Object.keys(bag).forEach((kk) => m.set(kk, bag[kk])); cb(); },
    remove: (k, cb) => { m.delete(k); cb(); }
  } } };
}

test('chrome-kv-store get/set/remove/keys round-trip', async () => {
  const kv = mod.createChromeKvStore(fakeChrome());
  assert.strictEqual(await kv.get('nb:doc:D1'), null);
  await kv.set('nb:doc:D1', { a: 1 });
  assert.deepStrictEqual(await kv.get('nb:doc:D1'), { a: 1 });
  await kv.set('nb:ver:V1', { b: 2 });
  assert.deepStrictEqual((await kv.keys()).sort(), ['nb:doc:D1', 'nb:ver:V1']);
  await kv.remove('nb:doc:D1');
  assert.strictEqual(await kv.get('nb:doc:D1'), null);
});
```

- [ ] **Step 2: Run, verify failure** — `node --test test/chrome-kv-store.test.js` → FAIL.

- [ ] **Step 3: Implement** — create `src/adapters/chrome-kv-store.js` (model the promise-wrap on `chrome-storage-adapter.js:49–93`, support callback + promise forms):

```js
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.chromeKvStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createChromeKvStore(chromeApi) {
    const api = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    const local = api && api.storage && api.storage.local;
    if (!local) throw new Error('chromeKvStore requires chrome.storage.local');
    function call(fn, arg) {
      return new Promise(function (resolve, reject) {
        let p;
        try { p = fn(arg, function (res) { const e = api.runtime && api.runtime.lastError; if (e) reject(new Error(e.message || String(e))); else resolve(res); }); }
        catch (e) { reject(e); return; }
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    }
    return {
      get: function (k) { return call(local.get.bind(local), k).then(function (items) { const v = items ? items[k] : undefined; return v == null ? null : v; }); },
      set: function (k, v) { const bag = {}; bag[k] = v; return call(local.set.bind(local), bag).then(function () {}); },
      remove: function (k) { return call(local.remove.bind(local), k).then(function () {}); },
      keys: function () { return call(local.get.bind(local), null).then(function (items) { return items ? Object.keys(items) : []; }); }
    };
  }
  return { createChromeKvStore: createChromeKvStore };
});
```

- [ ] **Step 4: Run, verify pass** — `node --test test/chrome-kv-store.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(adapters): chrome.storage.local kv store for the history engine"`

---

# Phase 3 — snapshot capture util + unified adapter

### Task 5: `snapshot-capture.js` (clean full-doc capture + identity codec)

**Files:**
- Create: `src/runtime/snapshot-capture.js`
- Test: `test/snapshot-capture.test.js`

This consolidates the clean-doc serialization currently duplicated in `content-script.js:333` (`docContentHtml`) and `EMBEDDED_BOOT` `rebuildCleanHtml` (exporter.js:114–149). It is DOM-only at runtime but the *string-cleaning* part is testable by passing a parsed document; to keep it Node-testable without jsdom, expose a pure string fallback too.

- [ ] **Step 1: Write failing test** — create `test/snapshot-capture.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const cap = require('../src/runtime/snapshot-capture.js');

test('identityCodec is a no-op string round-trip', async () => {
  assert.strictEqual(await cap.identityCodec.compress('x'), 'x');
  assert.strictEqual(await cap.identityCodec.decompress('x'), 'x');
});

test('stripNotebackFromHtml removes UI, marks, state block, runtime script', () => {
  const dirty = '<!DOCTYPE html><html><head><style>p{}</style></head><body>' +
    '<div data-noteback-ui="sidebar">UI</div>' +
    '<p>Hello <mark class="noteback-highlight" data-noteback-id="c1">world</mark>!</p>' +
    '<script type="application/json" id="noteback-state">{"x":1}</script>' +
    '<script>window.NotebackRuntime={};</script>' +
    '</body></html>';
  const clean = cap.stripNotebackFromHtml(dirty);
  assert.ok(!clean.includes('data-noteback-ui'));
  assert.ok(!clean.includes('noteback-state'));
  assert.ok(!clean.includes('NotebackRuntime'));
  assert.ok(clean.includes('Hello world!'), 'mark unwrapped, text preserved');
});
```

- [ ] **Step 2: Run, verify failure** — `node --test test/snapshot-capture.test.js` → FAIL.

- [ ] **Step 3: Implement** — create `src/runtime/snapshot-capture.js`. Reuse the exporter's regex strippers conceptually (`exporter.js:292–410`), but as a self-contained module. `captureCleanDoc(doc)` clones `documentElement`, removes `[data-noteback-ui]`, unwraps `mark.noteback-highlight`, removes the `#noteback-state` block and the runtime `<script>` (non-`src`, body matches `/NotebackRuntime/`), and returns `'<!DOCTYPE html>\n' + clone.outerHTML`. `stripNotebackFromHtml(html)` is the string-only equivalent for tests/Node:

```js
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.snapshotCapture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const identityCodec = {
    compress: function (s) { return Promise.resolve(String(s == null ? '' : s)); },
    decompress: function (s) { return Promise.resolve(String(s == null ? '' : s)); }
  };
  function captureCleanDoc(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return '';
    const clone = d.documentElement.cloneNode(true);
    const ui = clone.querySelectorAll('[data-noteback-ui]');
    for (let i = 0; i < ui.length; i++) if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]);
    const marks = clone.querySelectorAll('mark.noteback-highlight');
    for (let j = 0; j < marks.length; j++) { const m = marks[j]; const p = m.parentNode; if (!p) continue; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); }
    const st = clone.querySelector('#noteback-state'); if (st && st.parentNode) st.parentNode.removeChild(st);
    const scripts = clone.querySelectorAll('script');
    for (let k = 0; k < scripts.length; k++) { const sc = scripts[k]; if (!sc.getAttribute('src') && /NotebackRuntime/.test(sc.textContent || '')) { if (sc.parentNode) sc.parentNode.removeChild(sc); } }
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }
  function stripNotebackFromHtml(html) {
    let out = String(html || '');
    out = out.replace(/<[a-z0-9]+\b[^>]*\bdata-noteback-ui\b[\s\S]*?<\/[a-z0-9]+\s*>/gi, '');
    out = out.replace(/<script\b[^>]*\bid\s*=\s*["']noteback-state["'][\s\S]*?<\/script\s*>/gi, '');
    out = out.replace(/<script\b(?![^>]*\bsrc=)[^>]*>(?:(?![<]\/script)[\s\S])*?NotebackRuntime[\s\S]*?<\/script\s*>/gi, '');
    out = out.replace(/<mark\b[^>]*\bnoteback-highlight\b[^>]*>([\s\S]*?)<\/mark\s*>/gi, '$1');
    return out;
  }
  return { identityCodec: identityCodec, captureCleanDoc: captureCleanDoc, stripNotebackFromHtml: stripNotebackFromHtml };
});
```

> Note: tune the `stripNotebackFromHtml` regexes against the test until green; nested `data-noteback-ui` subtrees in real canvases are shallow, but verify against `examples/spec.html` output during Task 12 e2e.

- [ ] **Step 4: Run, verify pass** — `node --test test/snapshot-capture.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(runtime): snapshot-capture util (clean full-doc + identity codec)"`

---

### Task 6: `history-state-adapter.js` (mode-agnostic, captures snapshot at first comment)

**Files:**
- Create: `src/adapters/history-state-adapter.js`
- Test: `test/history-state-adapter.test.js`
- Delete (later, Task 11): `src/adapters/localstorage-state-adapter.js`, `test/localstorage-adapter.test.js`

Interface:

```
createHistoryStateAdapter({
  doc,                 // Document (for title/fallback)
  store,               // kv store (localStorage or chrome)
  inner,               // inner StorageAdapter or null (embedded: InFileStateAdapter; extension: null)
  docId,               // resolved doc-id string (required; '' → degrade)
  contentText,         // () => string  (clean visible text for hashing; read once)
  captureSnapshot,     // () => string  (clean full-doc HTML; called at first comment)
  draftHistory,        // override (tests); else rt().draftHistory
  codec,               // override; else gzip-or-identity
  now                  // () => ISO
}) -> { load, save, getHistory, getVersion, clearCurrent }
```

Behavior: `load()` resolves once (caches `{degraded, docId, versionKey, comments, hasSnapshot}`), returns `{schemaVersion:1, docId, docTitle, comments}`. `save(state)` writes through `inner` (if present), then — if usable — updates the cached comments and calls `dh.persist`, passing a freshly captured+compressed snapshot **only when** the version has no snapshot yet and `state.comments.length > 0` (first comment). `getHistory()` → `dh.history`. `getVersion(ref)` → `dh.version`. `clearCurrent()` → `dh.clearCurrent`.

- [ ] **Step 1: Write failing test** — create `test/history-state-adapter.test.js` (DI fakes; require core + snapshot-capture so they self-register):

```js
const { test } = require('node:test');
const assert = require('node:assert');
require('../src/runtime/draft-history-core.js');
require('../src/runtime/snapshot-capture.js');
const mod = require('../src/adapters/history-state-adapter.js');
const core = require('../src/runtime/draft-history-core.js');

const idCodec = { compress: (s) => Promise.resolve(String(s)), decompress: (s) => Promise.resolve(String(s)) };
function fakeStore() { const m = new Map(); return { get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); return Promise.resolve(); }, remove: (k) => { m.delete(k); return Promise.resolve(); }, keys: () => Promise.resolve(Array.from(m.keys())) }; }
function fakeInner() { let s = null; return { load: () => Promise.resolve(s), save: (x) => { s = x; return Promise.resolve(); } }; }
const LONG = 'A document body that is comfortably longer than the small-content guard.';

function build(store, snapHtml) {
  return mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner: fakeInner(), docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => (snapHtml || '<html>SNAP</html>'),
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z'
  });
}

test('load returns the current version comments (empty initially)', async () => {
  const a = build(fakeStore());
  const s = await a.load();
  assert.strictEqual(s.docId, 'D1');
  assert.deepStrictEqual(s.comments, []);
});

test('save captures a full-doc snapshot at the first comment; getHistory/getVersion see it', async () => {
  const store = fakeStore();
  const a = build(store, '<html>FIRST</html>');
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  // simulate a NEW draft (content change) so the first becomes history:
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>SECOND</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:01Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].hasSnapshot, true);
  const v = await b.getVersion({ versionKey: hist[0].versionKey });
  assert.strictEqual(v.html, '<html>FIRST</html>');
});

test('degrades when docId is empty (no history, comments still flow via inner)', async () => {
  const a = mod.createHistoryStateAdapter({ doc: { title: 'T' }, store: fakeStore(), inner: fakeInner(), docId: '', contentText: () => LONG, captureSnapshot: () => '<html>S</html>', draftHistory: core, codec: idCodec, now: () => 'x' });
  const s0 = await a.load();
  assert.deepStrictEqual(s0.comments, []);
  await a.save({ schemaVersion: 1, docId: '', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  assert.deepStrictEqual(await a.getHistory(), []);
});
```

- [ ] **Step 2: Run, verify failure** — `node --test test/history-state-adapter.test.js` → FAIL.

- [ ] **Step 3: Implement** — create `src/adapters/history-state-adapter.js`. Model the gzip codec + resolve-once caching on `localstorage-state-adapter.js:34–91`, but generalize and capture full HTML:

```js
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.historyStateAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function rt() { const g = (typeof globalThis !== 'undefined') ? globalThis : this; return (g && g.NotebackRuntime) || {}; }

  function makeCodec() {
    const hasCS = (typeof CompressionStream !== 'undefined') && (typeof Response !== 'undefined');
    const sc = rt().snapshotCapture;
    if (!hasCS) return (sc && sc.identityCodec) || { compress: (x) => Promise.resolve(x), decompress: (x) => Promise.resolve(x) };
    function toB64(b) { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return 'gz:' + btoa(s); }
    function fromB64(s) { const bin = atob(s.slice(3)); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
    return {
      compress: (str) => { try { const cs = new CompressionStream('gzip'); return new Response(new Response(str).body.pipeThrough(cs)).arrayBuffer().then((buf) => toB64(new Uint8Array(buf))); } catch (e) { return Promise.resolve(String(str)); } },
      decompress: (str) => { if (typeof str !== 'string' || str.slice(0, 3) !== 'gz:') return Promise.resolve(String(str == null ? '' : str)); try { return new Response(new Response(fromB64(str)).body.pipeThrough(new DecompressionStream('gzip'))).text(); } catch (e) { return Promise.resolve(''); } }
    };
  }

  function createHistoryStateAdapter(cfg) {
    const doc = cfg.doc, inner = cfg.inner || null;
    const dhMod = cfg.draftHistory || rt().draftHistory;
    const now = cfg.now || (() => new Date().toISOString());
    const docId = String(cfg.docId == null ? '' : cfg.docId);
    const usable = !!(cfg.store && dhMod && dhMod.createDraftHistory && docId);
    const codec = cfg.codec || makeCodec();
    const dh = usable ? dhMod.createDraftHistory({ store: cfg.store, now: now, codec: codec }) : null;
    let resolved = null;

    function docTitle() { return (doc && doc.title) || ''; }
    function ensureResolved() {
      if (resolved) return Promise.resolve(resolved);
      const innerLoad = inner ? inner.load() : Promise.resolve(null);
      return innerLoad.then((innerState) => {
        const fallback = (innerState && innerState.comments) || [];
        if (!usable) { resolved = { degraded: true, comments: fallback.slice(), versionKey: null, hasSnapshot: true }; return resolved; }
        return dh.resolve({ docId: docId, contentText: cfg.contentText ? cfg.contentText() : '', fallbackComments: fallback, docTitle: docTitle() })
          .then((r) => { resolved = { degraded: r.degraded, docId: r.docId, versionKey: r.versionKey, comments: r.comments, hasSnapshot: (r.comments && r.comments.length > 0) }; return resolved; });
      });
    }

    return {
      load: function () {
        return ensureResolved().then((r) => ({ schemaVersion: 1, docId: docId, docTitle: docTitle(), comments: (r.comments || []).slice() }));
      },
      save: function (state) {
        const writeThrough = inner ? inner.save(state) : Promise.resolve();
        return ensureResolved().then((r) => {
          const comments = (state.comments || []).slice();
          r.comments = comments;
          if (!usable || r.degraded) return writeThrough;
          const needSnapshot = comments.length > 0 && !r.hasSnapshot;
          const snapP = needSnapshot && cfg.captureSnapshot ? codec.compress(cfg.captureSnapshot()) : Promise.resolve('');
          return snapP.then((snap) => { if (snap) r.hasSnapshot = true; return dh.persist({ docId: docId, versionKey: r.versionKey, comments: comments, snapshotHtml: snap }); }).then(() => writeThrough);
        });
      },
      getHistory: function () { if (!usable) return Promise.resolve([]); return ensureResolved().then((r) => r.degraded ? [] : dh.history({ docId: docId, exceptVersionKey: r.versionKey })); },
      getVersion: function (ref) { if (!usable) return Promise.resolve(null); return dh.version({ versionKey: ref.versionKey }); },
      clearCurrent: function () { if (!usable) return Promise.resolve(); return ensureResolved().then((r) => { if (r.degraded) return; r.comments = []; r.hasSnapshot = false; return dh.clearCurrent({ docId: docId, versionKey: r.versionKey }); }); }
    };
  }
  return { createHistoryStateAdapter: createHistoryStateAdapter, makeCodec: makeCodec };
});
```

- [ ] **Step 4: Run, verify pass** — `node --test test/history-state-adapter.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(adapters): unified history-state-adapter (snapshot-at-first-comment)"`

---

# Phase 4 — origin-policy per-site history opt-in

### Task 7: `historyAllowed` + `historySites`

**Files:**
- Modify: `src/content/origin-policy.js` (`normalizeSettings` 50–61; exports 72–79)
- Test: `test/origin-policy.test.js`

- [ ] **Step 1: Write failing tests** — append to `test/origin-policy.test.js`:

```js
test('historyAllowed: on by default for file/localhost/127, off for other', () => {
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, null), false);
});

test('historyAllowed: an other-origin opts in via historySites', () => {
  const s = { historySites: ['https://example.com'] };
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, s), true);
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://evil.com' }, s), false);
});
```

- [ ] **Step 2: Run, verify failure** — `node --test test/origin-policy.test.js` → FAIL.

- [ ] **Step 3: Implement** — in `normalizeSettings` (line 50) add `historySites` to the returned object:

```js
    historySites: Array.isArray(s.historySites) ? s.historySites.slice() : []
```

Add the predicate and export it:

```js
  function historyAllowed(info, settings) {
    info = info || {};
    if (info.type === 'file' || info.type === 'localhost' || info.type === '127.0.0.1') return true;
    const norm = normalizeSettings(settings);
    return !!(info.origin && norm.historySites.indexOf(info.origin) !== -1);
  }
```

Add `historyAllowed` to the export object (line ~78).

- [ ] **Step 4: Run, verify pass** — `node --test test/origin-policy.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(origin-policy): per-site history opt-in (historyAllowed/historySites)"`

---

# Phase 5 — Mode wiring (embedded + extension)

### Task 8: Embedded boot uses the new adapter + baked id + snapshot capture + checkout

**Files:**
- Modify: `src/canvas/exporter.js` — `EMBEDDED_BOOT` (51–191), specifically the adapter wiring (61–75), the runtime concat order, and add a version-checkout builder.
- Modify: `bin/noteback.js` — `RUNTIME_FILES` (39–51): add the new modules to the inline order.
- Verify: `test/cli-wrap.test.js` (canvas still builds + boots).

The `EMBEDDED_BOOT` adapter block currently builds `localStorageStateAdapter`. Replace with `historyStateAdapter` over a `localStorage` kv store, reading the baked id.

- [ ] **Step 1:** Add the new runtime files to `bin/noteback.js` `RUNTIME_FILES` (so they inline into the canvas), in dependency order — `draft-history-core.js` and `snapshot-capture.js` **before** `history-state-adapter.js`, all before `boot.js`. Remove `snapshot.js` and `localstorage-state-adapter.js` from the list.

- [ ] **Step 2:** In `EMBEDDED_BOOT` (exporter.js ~61–75), replace the adapter construction with:

```js
'    var rootEl = document.getElementById("noteback-doc-root") || document.body;',
'    var docId = (rootEl && rootEl.getAttribute && rootEl.getAttribute("data-noteback-doc-id")) || "";',
'    var lsStore = (function () { try { var ls = window.localStorage; return { get: function (k) { try { var v = ls.getItem(k); return Promise.resolve(v == null ? null : JSON.parse(v)); } catch (e) { return Promise.resolve(null); } }, set: function (k, v) { try { ls.setItem(k, JSON.stringify(v)); } catch (e) {} return Promise.resolve(); }, remove: function (k) { try { ls.removeItem(k); } catch (e) {} return Promise.resolve(); }, keys: function () { var o = []; try { for (var i = 0; i < ls.length; i++) o.push(ls.key(i)); } catch (e) {} return Promise.resolve(o); } }; } catch (e) { return null; } })();',
'    var cleanText = function () { try { return rootEl.textContent || ""; } catch (e) { return ""; } };',
'    var snap = (RT.snapshotCapture && RT.snapshotCapture.captureCleanDoc) ? function () { return RT.snapshotCapture.captureCleanDoc(document); } : function () { return ""; };',
'    var adapter = (RT.historyStateAdapter && lsStore && docId)',
'      ? RT.historyStateAdapter.createHistoryStateAdapter({ doc: document, store: lsStore, inner: inner, docId: docId, contentText: cleanText, captureSnapshot: snap })',
'      : inner;',
```

Keep the existing `history:` wiring on the `RT.boot.boot({...})` call but change `getSection` → `getVersion`:

```js
'      history: (adapter.getHistory ? {',
'        getHistory: function () { return adapter.getHistory(); },',
'        getVersion: function (ref) { return adapter.getVersion(ref); },',
'        clearCurrent: function () { return adapter.clearCurrent(); }',
'      } : null),',
```

- [ ] **Step 3:** Run the CLI build + the existing wrap test: `node --test test/cli-wrap.test.js`. Fix the assertion that expects `NotebackRuntime.snapshot` (change to `NotebackRuntime.snapshotCapture` and `NotebackRuntime.historyStateAdapter`).

- [ ] **Step 4:** Manually rebuild + eyeball: `node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html`; grep the output for `data-noteback-doc-id=`, `historyStateAdapter`, `draftHistory`.

- [ ] **Step 5: Commit** — `git commit -am "feat(embedded): boot the unified history adapter (baked id + full snapshot)"`

---

### Task 9: Extension content-script wires the engine over chrome.storage

**Files:**
- Modify: `src/content/content-script.js` (identity 50–65; adapter 63–65; mount 130–144)
- Modify: `manifest.json` (`content_scripts[0].js` 37–49; `web_accessible_resources` 53–75)

- [ ] **Step 1:** In `manifest.json`, add to `content_scripts[0].js` (after `infile-state-adapter.js`, before `boot.js`): `src/runtime/draft-history-core.js`, `src/runtime/snapshot-capture.js`, `src/adapters/chrome-kv-store.js`, `src/adapters/history-state-adapter.js`. Remove `snapshot.js`/`localstorage-state-adapter.js` if present anywhere. Mirror the additions in `web_accessible_resources` (so click-to-activate injection stays complete — see CLAUDE.md).

- [ ] **Step 2:** In `content-script.js`, add doc-id resolution + history gating. After `originType`/`origin` are computed (~124), add an async resolver:

```js
  // doc-id: baked attribute (a canvas) wins; else a per-URL minted id in chrome.storage.
  function resolveDocId() {
    var rootEl = document.getElementById('noteback-doc-root');
    var baked = rootEl && rootEl.getAttribute && rootEl.getAttribute('data-noteback-doc-id');
    if (baked) return Promise.resolve(baked);
    var urlKey = 'nb:url:' + location.href;
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(urlKey, function (items) {
        var id = items && items[urlKey];
        if (id) return resolve(id);
        id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var bag = {}; bag[urlKey] = id; chrome.storage.local.set(bag, function () { resolve(id); });
      }); } catch (e) { resolve(''); }
    });
  }
```

- [ ] **Step 3:** Replace the eager `adapter` (line 65) with a per-mount async build inside `mount()` (130–144): when `policy.historyAllowed({type:originType, origin:origin}, settings)` is true, build `RT.historyStateAdapter.createHistoryStateAdapter({ doc: document, store: RT.chromeKvStore.createChromeKvStore(chrome), inner: null, docId: <resolved>, contentText: () => (document.getElementById('noteback-doc-root')||document.body).textContent||'', captureSnapshot: () => RT.snapshotCapture.captureCleanDoc(document) })` and pass `history:` (getHistory/getVersion/clearCurrent) to `boot`. Otherwise fall back to `RT.chromeStorageAdapter.createChromeStorageAdapter(docId)` with no `history` (current behavior, comments only). `mount()` becomes async (resolve docId, read settings, then boot).

> Keep `ChromeStorageAdapter` for the non-history (opt-out) path; it is not deleted.

- [ ] **Step 4: Verify** — load the unpacked extension; on a `file://` canvas confirm the version timeline appears; on an arbitrary site confirm no snapshot until opted in (Task 12 covers the e2e; manual smoke here).

- [ ] **Step 5: Commit** — `git commit -am "feat(extension): run the shared history engine over chrome.storage (gated by opt-in)"`

---

# Phase 6 — Overlay version-timeline UI

> Overlay is DOM-only (no Node tests; covered by Playwright). Each task ends with an e2e assertion. Run `npm run test:e2e` (needs `npx playwright install chromium` once).

### Task 10: Replace the history renderer with the version timeline + collapse rule

**Files:**
- Modify: `src/runtime/overlay.js` — `renderHistory` (1217–1251) → `renderVersions`; call site (1213, 1196); the four `history.*` call sites (564, 1225, 1315); CSS (265–274).
- Test: `test/e2e/history-popup.e2e.test.js` (extend) + new `test/e2e/version-timeline.e2e.test.js`.

- [ ] **Step 1:** Rename/replace `renderHistory()` with `renderVersions()` that calls `history.getHistory()` and builds:
  - the rule: 0 earlier → render nothing; exactly 1 → one inline version row; 2+ → newest earlier inline + a `.nb-disclose` "+N older versions" that, on click, expands the remaining rows.
  - each version row: status dot, label (derive `v1/v2/…/now` by ordinal position; newest history entry is the latest *earlier* version), `formatWhen`, comment count, and action buttons **open** / **copy feedback**; clicking the row body = peek (Task 11).
  - update `history.getSection` references to `history.getVersion`.
- [ ] **Step 2:** Add CSS classes mirroring the design mockup (`.nb-versions`, `.nb-ver-row`, `.nb-ver-dot`, `.nb-disclose`, `.nb-ver-actions`). Keep all elements `data-noteback-ui`.
- [ ] **Step 3:** e2e: extend the harness (it already serves `d1`/`d2` to create two drafts). Create comments in d1, reload as d2, open the sidebar, assert: a `.nb-ver-row` for the earlier version is present and its `open`/`copy feedback` buttons exist and are enabled.
- [ ] **Step 4:** Run `npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(overlay): version timeline with collapse rule"`

---

### Task 11: Peek (live painter) + checkout (open as canvas tab) + "Back to current"

**Files:**
- Modify: `src/runtime/overlay.js` — delete `nbHistHighlight` (1272–1312) and `openHistoryPopup` (1314–1335); add `openVersionPeek(versionKey)` and `openVersionTab(versionKey)`; add the "Back to current" banner.
- Test: `test/e2e/version-timeline.e2e.test.js`.

- [ ] **Step 1 (peek):** `openVersionPeek` calls `history.getVersion({versionKey})` → `{html, comments}`. Parse with `new DOMParser().parseFromString(v.html, 'text/html')`, run `highlightApi.paintHighlights(parsed.body, {schemaVersion:1, comments:v.comments}, {})` to inject real `<mark>`s, then set the existing `.nb-hist-frame` iframe `srcdoc` to `'<!DOCTYPE html>' + parsed.documentElement.outerHTML` plus a tiny injected scroll-to-first-mark script (escape `</` as before). This retires `nbHistHighlight` entirely — the **live painter** does the work.
- [ ] **Step 2 (back to current):** The peek panel/banner shows **"← Back to current"** (locked wording) that closes the peek.
- [ ] **Step 3 (checkout):** `openVersionTab` builds a canvas from the snapshot and opens it: clone `document.documentElement`, strip `[data-noteback-ui]`, replace `#noteback-doc-root` inner with the snapshot's doc-root inner (parse `v.html`, take its `#noteback-doc-root` or `body`), set `#noteback-state` `textContent` to `JSON.stringify({schemaVersion:1, docId, docTitle, comments:v.comments})`, serialize, `Blob`→`URL.createObjectURL`→`window.open(url, '_blank')`. (This reuses the current page's inlined runtime + template + styles, so the opened tab is a real, annotatable canvas.) For the extension non-canvas case, fall back to `RT.exporter.buildCanvasHtml({docHtml:v.html, state, templateHtml: <fetched via chrome.runtime.getURL('src/canvas/canvas-template.html')>, inlinedRuntime: <concatenated web_accessible runtime>})` — note this branch needs the template fetched; gate behind `typeof chrome !== 'undefined' && chrome.runtime`.
- [ ] **Step 4:** e2e: from the earlier-version row, click the row → assert `iframe.nb-hist-frame` appears and (piercing shadow DOM per the existing `findFrame` helper) its body contains a `<mark>` around the commented quote and the "Back to current" control. Clicking it closes the peek. (Checkout `window.open` is hard to assert in headless; assert the built HTML string via a unit-style `page.evaluate` that calls the builder and checks it contains `noteback-state` + the comment body.)
- [ ] **Step 5: Commit** — `git commit -am "feat(overlay): snapshot peek via live painter + open-as-canvas checkout"`

---

# Phase 7 — Retire snapshot.js + old adapter; docs; verify

### Task 12: Delete the retired modules + tests

**Files:**
- Delete: `src/runtime/snapshot.js`, `test/snapshot.test.js`, `src/adapters/localstorage-state-adapter.js`, `test/localstorage-adapter.test.js`.
- Modify: `manifest.json` `web_accessible_resources` (remove `snapshot.js`, `localstorage-state-adapter.js`); confirm `bin/noteback.js` `RUNTIME_FILES` no longer lists them (Task 8).
- Grep: ensure nothing else references them.

- [ ] **Step 1:** `grep -rn "snapshot.js\|localstorage-state-adapter\|extractSections\|NotebackRuntime.snapshot\b\|localStorageStateAdapter" src test manifest.json bin` — expect only the lines you're about to remove.
- [ ] **Step 2:** Delete the four files; remove the manifest entries.
- [ ] **Step 3:** `npm test` → all green (no missing-module errors).
- [ ] **Step 4:** `node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html` → builds clean; grep confirms no `NotebackRuntime.snapshot=` (only `snapshotCapture`).
- [ ] **Step 5: Commit** — `git commit -am "refactor: retire snapshot.js + localstorage-state-adapter (superseded)"`

---

### Task 13: Update CONTRACTS.md + CLAUDE.md

**Files:** `CONTRACTS.md`, `CLAUDE.md`

- [ ] **Step 1:** CONTRACTS.md: update §1 (adapter now also exposes `getHistory/getVersion/clearCurrent` in history mode), §2 (note `docId` is the baked/stored doc-id; add the version/doc record shapes), §4 (runtime module list: add the 4 new modules, remove snapshot.js), §5 (note `data-noteback-doc-id` on `#noteback-doc-root`). Add a short "§8 Snapshot history" describing the doc-id/version-key model, the kv namespaces, and the snapshot-at-first-comment rule.
- [ ] **Step 2:** CLAUDE.md "Gotchas": replace the snapshot/section/paint-before-persist notes with the new reality — full-doc snapshot captured once at first comment; peek re-renders via the **live painter** on a parsed snapshot (no cross-node matcher); doc-id is baked on `#noteback-doc-root` and `wrap` preserves it; extension uses an `nb:url:` map; history is gated by `historyAllowed`. Keep the still-true notes (CSS keyframe entrance, chip debounce, composer-vs-sidebar, markdown line refs, file:// localStorage throwing — the last still applies to the embedded kv store).
- [ ] **Step 3: Commit** — `git commit -am "docs: CONTRACTS + CLAUDE for the snapshot-history model"`

---

### Task 14: Full verification

- [ ] **Step 1:** `npm test` (unit) → all PASS. Capture output.
- [ ] **Step 2:** `npm run test:e2e` → all PASS (run `npx playwright install chromium` first if needed).
- [ ] **Step 3:** Manual live check per CLAUDE.md "Live verification": rebuild `examples/spec.canvas.html`, serve over localhost with `?v=N`, create comments, edit content, reload, confirm the earlier version appears in the timeline, peek renders with highlights, "open" launches an annotatable tab, "Back to current" returns.
- [ ] **Step 4:** Extension smoke: load unpacked; `file://` canvas shows history; arbitrary site shows no history until opted in.
- [ ] **Step 5: Commit** — `git commit -am "test: verify snapshot-history end to end"` (if any fixups), then the branch is ready for review/merge per superpowers:finishing-a-development-branch.

---

## Self-review

- **Spec coverage:** identity (Tasks 1,2,8,9) ✓; version timeline + collapse (10) ✓; peek via live painter (11) ✓; checkout (11) ✓; "Back to current" (11) ✓; both modes (8,9) ✓; retention (3) ✓; clean-break migration (no task = correct; new namespaces in Task 3) ✓; opt-in (7,9) ✓; retire section subsystem (12) ✓; docs (13) ✓.
- **Type consistency:** `versionKey` used everywhere (not `contentHash` as the key); adapter exposes `getVersion` (not `getSection`) and overlay calls `getVersion` (Tasks 8,9,11); `history()` returns `{versionKey, hasSnapshot, comments}` consumed by overlay (10) and tests (3).
- **Placeholder scan:** DOM tasks (10,11) are spec-level by necessity (no Node DOM); each has a concrete e2e assertion and exact file/line targets — not vague "add the UI."
- **Open risk:** Task 11 checkout in the extension non-canvas branch needs the template+runtime fetched via `chrome.runtime.getURL`; flagged inline. Task 5's `stripNotebackFromHtml` regexes need tuning against real output (noted).
