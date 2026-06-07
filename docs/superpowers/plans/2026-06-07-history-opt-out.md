# History opt-out controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users stop recording version history — from the extension popup (global / this site / this page) and from an embedded canvas (gear ⚙ button: this document / all embedded docs here) — taking effect live, hiding the timeline while keeping stored data.

**Architecture:** A single opt-out subtract layer on top of the existing `historyAllowed` gate. The extension reacts live by **re-mounting** (it picks adapter *type* at mount); the embedded canvas gates its already-built history adapter **in place** via a new `isEnabled()` predicate fed by a `historyControl` object that the gear flips. Opt-out state lives in `nb:settings` (extension) and `nb:nohist:*` localStorage flags (embedded).

**Tech Stack:** Vanilla JS (ES5-ish, zero runtime deps, no build step). Node built-in test runner (`node --test`). Playwright for browser e2e (devDependency only).

**Spec:** `docs/superpowers/specs/2026-06-07-history-opt-out-design.md`

---

## File Structure

| File | Responsibility / change |
| --- | --- |
| `src/content/origin-policy.js` | PURE gate. `normalizeSettings` carries 3 new fields; `historyAllowed` gains the opt-out subtract layer + `info.docKey`. |
| `test/origin-policy.test.js` | Unit tests for the new gate + normalize fields. |
| `src/adapters/history-state-adapter.js` | Optional `cfg.isEnabled()` predicate; when false the adapter passes through to `inner` and reports empty history. |
| `test/history-state-adapter.test.js` | Unit test for the `isEnabled` gate (off → no version; flip on → history returns). |
| `src/canvas/exporter.js` | `EMBEDDED_BOOT` builds `historyControl` (reads/writes `nb:nohist:*`), passes `isEnabled` to the adapter and `historyControl` into `boot()`. |
| `test/exporter.test.js` | String assertions that `EMBEDDED_BOOT` wires `historyControl` + `isEnabled`. |
| `src/runtime/boot.js` | Forward `cfg.historyControl` into `mountOverlay`. |
| `src/runtime/overlay.js` | Embedded-only gear button + dialog with 2 toggles; live `renderSidebar()` / re-enable resync. CSS for the toggle rows. |
| `src/content/content-script.js` | Memoize `resolveDocId`; cache `historyDocId`; pass `docKey` to the gate; re-mount on history-gate flip in `applySettings`; return `historyDocId` in `NOTEBACK_PING`. |
| `src/popup/popup.html` / `popup.css` / `popup.js` | "Version history" opt-out section (3 cascading toggles) scoped to the active tab. |
| `test/e2e/history-gear.e2e.test.js` | NEW. Embedded gear: off → no version + timeline hidden; on → reappears. |
| `test/e2e/extension-history-optout.e2e.test.js` | NEW. Extension live opt-out via chrome.storage (skip-gated like the standdown e2e). |
| `CONTRACTS.md`, `CLAUDE.md`, `docs/design.md` | Document the gate, the flags, the gear, the asymmetric live mechanism. |

**Test commands:**
- Single unit file: `node --test test/origin-policy.test.js`
- All unit: `npm run test:unit`
- Single e2e: `node --test test/e2e/history-gear.e2e.test.js` (needs `npx playwright install chromium`)
- Everything: `npm test`

---

## Task 1: Policy gate — opt-out subtract layer (`origin-policy.js`)

**Files:**
- Modify: `src/content/origin-policy.js:53-72` (`normalizeSettings`, `historyAllowed`) and the header doc comment at `:11-14`.
- Test: `test/origin-policy.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/origin-policy.test.js`:

```js
test('normalizeSettings carries the history opt-out fields with safe defaults', () => {
  const n = policy.normalizeSettings(null);
  assert.strictEqual(n.historyDisabledGlobal, false);
  assert.deepStrictEqual(n.historyDisabledSites, []);
  assert.deepStrictEqual(n.historyDisabledDocs, []);
  // garbage shapes coerce to safe defaults
  const g = policy.normalizeSettings({ historyDisabledGlobal: 'yes', historyDisabledSites: 'x', historyDisabledDocs: 5 });
  assert.strictEqual(g.historyDisabledGlobal, false); // only boolean true counts
  assert.deepStrictEqual(g.historyDisabledSites, []);
  assert.deepStrictEqual(g.historyDisabledDocs, []);
});

test('historyAllowed: global opt-out turns history off everywhere', () => {
  const s = { historyDisabledGlobal: true };
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, s), false);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
});

test('historyAllowed: per-site opt-out subtracts one origin (others stay on)', () => {
  const s = { historyDisabledSites: ['file://'] };
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, s), false);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, s), true);
});

test('historyAllowed: per-doc opt-out subtracts one document by its docKey', () => {
  const s = { historyDisabledDocs: ['doc-123'] };
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://', docKey: 'doc-123' }, s), false);
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://', docKey: 'doc-999' }, s), true);
  // no docKey supplied → per-doc list can't match → stays on
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, s), true);
});

test('historyAllowed: opt-out beats the base allow and the opt-in', () => {
  // local type would normally be on, but a global opt-out wins
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, { historyDisabledGlobal: true }), false);
  // an opted-in other origin is overridden by a per-site opt-out
  const s = { historySites: ['https://example.com'], historyDisabledSites: ['https://example.com'] };
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, s), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/origin-policy.test.js`
Expected: FAIL — `historyDisabledGlobal` is `undefined` (not `false`) and the opt-out asserts return `true` where `false` is expected.

- [ ] **Step 3: Implement the gate**

In `src/content/origin-policy.js`, replace `normalizeSettings` (lines 53-65) with:

```js
  function normalizeSettings(settings) {
    const s = settings || {};
    const o = s.origins || {};
    return {
      origins: {
        file: o.file !== false,
        localhost: o.localhost !== false,
        '127.0.0.1': o['127.0.0.1'] !== false
      },
      disabledSites: Array.isArray(s.disabledSites) ? s.disabledSites.slice() : [],
      historySites: Array.isArray(s.historySites) ? s.historySites.slice() : [],
      historyDisabledGlobal: s.historyDisabledGlobal === true,
      historyDisabledSites: Array.isArray(s.historyDisabledSites) ? s.historyDisabledSites.slice() : [],
      historyDisabledDocs: Array.isArray(s.historyDisabledDocs) ? s.historyDisabledDocs.slice() : []
    };
  }
```

Replace `historyAllowed` (lines 67-72) with:

```js
  // History gate: opt-OUT layer (global / per-origin / per-doc) wins, then the base
  // rule (on for file/localhost/127; opt-in via historySites for other origins).
  // `info.docKey` is the resolved history doc-id (baked id or nb:url minted id).
  function historyAllowed(info, settings) {
    info = info || {};
    const norm = normalizeSettings(settings);
    if (norm.historyDisabledGlobal) return false;
    if (info.origin && norm.historyDisabledSites.indexOf(info.origin) !== -1) return false;
    if (info.docKey && norm.historyDisabledDocs.indexOf(info.docKey) !== -1) return false;
    if (TYPES.indexOf(info.type) !== -1) return true;
    return !!(info.origin && norm.historySites.indexOf(info.origin) !== -1);
  }
```

Update the header doc comment line `:12` so the `normalizeSettings` shape note reads:

```js
   *   normalizeSettings(s)     -> { origins:{…}, disabledSites:[], historySites:[], historyDisabledGlobal, historyDisabledSites:[], historyDisabledDocs:[] }
```

and line `:14` so the `historyAllowed` note reads:

```js
   *   historyAllowed({type,origin,docKey},s) -> boolean (base on for file/localhost/127 + historySites opt-in; opt-out subtract: global/site/doc)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/origin-policy.test.js`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/content/origin-policy.js test/origin-policy.test.js
git commit -m "feat: history opt-out gate (global/site/doc) in origin-policy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Adapter `isEnabled()` gate (`history-state-adapter.js`)

The embedded canvas gates its already-built history adapter in place. When `isEnabled()` is false the adapter behaves exactly like its existing `degraded` path: comments flow through `inner`, no version/snapshot is written, and `getHistory()` returns `[]`. The gate is re-checked on every `ensureResolved()` and the memoized `resolved` is invalidated whenever the enabled-state flips, so a live toggle takes effect immediately.

**Files:**
- Modify: `src/adapters/history-state-adapter.js:53-74` (constructor head + `ensureResolved`) and `:114-117` (`getVersion`), plus the param doc block at `:41-52`.
- Test: `test/history-state-adapter.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/history-state-adapter.test.js`:

```js
test('isEnabled()=false makes the adapter pass through to inner (no version), flip on restores history', async () => {
  const store = fakeStore();
  let on = false; // start DISABLED
  const inner = fakeInner();
  const a = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner, docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => '<html>SNAP</html>',
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z',
    isEnabled: () => on
  });
  // Disabled: a save writes through inner but records NO version.
  await a.load();
  const comments = [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }];
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: comments });
  assert.deepStrictEqual(await a.getHistory(), [], 'no history while disabled');
  assert.strictEqual((await inner.load()).comments.length, 1, 'comment still written through inner');
  const verKeysWhileOff = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeysWhileOff.length, 0, 'no version record created while disabled');

  // Flip ON: the same adapter now records the current draft as a version.
  on = true;
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: comments });
  const verKeysWhileOn = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeysWhileOn.length, 1, 'a version record exists once re-enabled');
  // It is the CURRENT version (excluded from getHistory), so a fresh sibling draft sees it as history.
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>OTHER</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:02Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1, 'the re-enabled draft is visible as history to a later version');
  assert.strictEqual(hist[0].comments.length, 1);
});

test('isEnabled defaults to true (omitted → unchanged behavior)', async () => {
  const store = fakeStore();
  const a = build(store, '<html>FIRST</html>'); // build() passes no isEnabled
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  const verKeys = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeys.length, 1, 'history records normally when isEnabled is omitted');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/history-state-adapter.test.js`
Expected: FAIL — without the gate, the disabled adapter still creates a `nb:ver:` record, so `verKeysWhileOff.length` is `1` not `0`.

- [ ] **Step 3: Implement the gate**

In `src/adapters/history-state-adapter.js`, inside `createHistoryStateAdapter`, after the existing `let resolved = null;` (line 61) add:

```js
    const isEnabled = cfg.isEnabled || function () { return true; };
    function currentlyEnabled() { try { return !!isEnabled(); } catch (e) { return true; } }
    let lastEnabled = currentlyEnabled();
```

Replace `ensureResolved` (lines 65-74) with:

```js
    function ensureResolved() {
      const en = currentlyEnabled();
      if (en !== lastEnabled) { resolved = null; lastEnabled = en; } // enabled flipped → re-resolve
      if (resolved) return Promise.resolve(resolved);
      const innerLoad = inner ? inner.load() : Promise.resolve(null);
      return innerLoad.then((innerState) => {
        const fallback = (innerState && innerState.comments) || [];
        // !usable OR disabled → degrade to inner: comments flow, no version written.
        if (!usable || !en) { resolved = { degraded: true, comments: fallback.slice(), versionKey: null, hasSnapshot: true }; return resolved; }
        return dh.resolve({ docId: docId, contentText: cfg.contentText ? cfg.contentText() : '', fallbackComments: fallback, docTitle: docTitle() })
          .then((r) => { resolved = { degraded: r.degraded, docId: r.docId, versionKey: r.versionKey, comments: r.comments, hasSnapshot: !!r.hasSnapshot }; return resolved; });
      });
    }
```

Replace `getVersion` (lines 114-117) with:

```js
      getVersion: function (ref) {
        if (!usable || !currentlyEnabled()) return Promise.resolve(null);
        return dh.version({ versionKey: ref.versionKey });
      },
```

Update the `@param` doc block (after line 51) by adding:

```js
   * @param {() => boolean} [cfg.isEnabled]  when it returns false the adapter passes
   *   through to inner (no version/snapshot) and getHistory()/getVersion() report
   *   empty — used by the embedded gear's live opt-out. Defaults to always-true.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/history-state-adapter.test.js`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/history-state-adapter.js test/history-state-adapter.test.js
git commit -m "feat: isEnabled() gate on history-state-adapter (live opt-out)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Embedded boot `historyControl` (`exporter.js`)

`EMBEDDED_BOOT` reads/writes the two `nb:nohist:*` localStorage flags synchronously (always in try/catch — `window.localStorage` can throw on `file://`), exposes them as `historyControl`, feeds `isEnabled` to the adapter, and passes `historyControl` into `boot()` so the overlay gear can flip it.

**Files:**
- Modify: `src/canvas/exporter.js` — `EMBEDDED_BOOT` array: insert the `historyControl` block after line 72 (the `snap` definition), change the adapter call (lines 73-75), and add `historyControl` to the `RT.boot.boot({...})` call (after line 222 `mode: "embedded",`).
- Test: `test/exporter.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/exporter.test.js`:

```js
test('EMBEDDED_BOOT wires historyControl + isEnabled for the live opt-out gear', () => {
  const boot = exporter.EMBEDDED_BOOT;
  assert.ok(/nb:nohist:global/.test(boot), 'reads the global opt-out flag key');
  assert.ok(/nb:nohist:doc:/.test(boot), 'reads the per-doc opt-out flag key');
  assert.ok(/var historyControl =/.test(boot), 'builds a historyControl object');
  assert.ok(/isEnabled:\s*function/.test(boot), 'passes isEnabled into the history adapter');
  assert.ok(/historyControl:\s*historyControl/.test(boot), 'passes historyControl into boot()');
  assert.ok(/available:/.test(boot), 'historyControl exposes an availability flag');
});
```

(`exporter` is already required at the top of `test/exporter.test.js`. If the local variable is named differently there, use that name — check the file's existing `require(...)` line.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/exporter.test.js`
Expected: FAIL — none of those strings exist in `EMBEDDED_BOOT` yet.

- [ ] **Step 3: Implement the wiring**

In `src/canvas/exporter.js`, in the `EMBEDDED_BOOT` array, **after** line 72 (`'    var snap = ...'`) and **before** line 73 (`'    var adapter = ...'`), insert:

```js
    '    // History opt-out flags (gear ⚙). Read/written synchronously via raw',
    '    // localStorage in try/catch — never the async lsStore wrapper, and never raw',
    '    // outside a guard (file:// localStorage can THROW).',
    '    var NOHIST_GLOBAL = "nb:nohist:global";',
    '    var NOHIST_DOC = "nb:nohist:doc:" + docId;',
    '    function nbHistGet(k) { try { return window.localStorage.getItem(k) === "1"; } catch (e) { return false; } }',
    '    function nbHistSet(k, off) { try { if (off) window.localStorage.setItem(k, "1"); else window.localStorage.removeItem(k); } catch (e) {} }',
    '    var historyControl = {',
    '      available: !!(RT.historyStateAdapter && lsStore && docId),',
    '      globalOff: function () { return nbHistGet(NOHIST_GLOBAL); },',
    '      docOff: function () { return nbHistGet(NOHIST_DOC); },',
    '      enabled: function () { return !(nbHistGet(NOHIST_GLOBAL) || nbHistGet(NOHIST_DOC)); },',
    '      setGlobal: function (off) { nbHistSet(NOHIST_GLOBAL, off); },',
    '      setDoc: function (off) { nbHistSet(NOHIST_DOC, off); }',
    '    };',
```

Replace the adapter creation (lines 73-75) with:

```js
    '    var adapter = (RT.historyStateAdapter && lsStore && docId)',
    '      ? RT.historyStateAdapter.createHistoryStateAdapter({ doc: document, store: lsStore, inner: inner, docId: docId, contentText: cleanText, captureSnapshot: snap, isEnabled: function () { return historyControl.enabled(); } })',
    '      : inner;',
```

In the `RT.boot.boot({...})` call, after the line `'      mode: "embedded",'` (line 222), add:

```js
    '      historyControl: historyControl,',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/exporter.test.js`
Expected: PASS.

- [ ] **Step 5: Verify the embedded boot is still syntactically valid JS**

The exporter test suite already includes a check that the inlined runtime + boot blob parses (the "syntactically valid JavaScript" test mentioned in the file header). Confirm the whole file passes:

Run: `node --test test/exporter.test.js`
Expected: PASS (including the existing "valid JavaScript" assertion).

- [ ] **Step 6: Commit**

```bash
git add src/canvas/exporter.js test/exporter.test.js
git commit -m "feat: historyControl + isEnabled wiring in EMBEDDED_BOOT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Embedded gear UI (`overlay.js` + `boot.js`)

A `⚙` button beside `ⓘ` (embedded mode only, only when `historyControl.available`) opens a small card with two opt-out toggles. Toggling persists via `historyControl` and updates the UI live: turning off hides the timeline (`getHistory()` → `[]`); turning back on re-saves the current draft so the freshly-enabled version adopts the live comments, then repaints.

**Files:**
- Modify: `src/runtime/boot.js:136-148` (forward `historyControl`).
- Modify: `src/runtime/overlay.js` — destructure `historyControl` (~line 514); add gear CSS near the info-dialog CSS (~after line 218); inject the gear button + dialog and wire it (after the info-dialog wiring, ~line 720).
- Test: covered by Task 5 (e2e). No unit test (shadow-DOM overlay).

- [ ] **Step 1: Forward `historyControl` through boot**

In `src/runtime/boot.js`, in the `overlayApi.mountOverlay({...})` call (lines 136-148), after the `history: cfg.history || null,` line add:

```js
      historyControl: cfg.historyControl || null,
```

- [ ] **Step 2: Destructure `historyControl` in the overlay**

In `src/runtime/overlay.js`, after `const history = cfg.history || null;` (line 514) add:

```js
    const historyControl = cfg.historyControl || null;
```

- [ ] **Step 3: Add gear CSS**

In `src/runtime/overlay.js`, immediately after the `'.nb-info-mode::before{...}'` rule (line ~218, the last info-dialog CSS line), insert these CSS array entries:

```js
    /* gear dialog (history opt-out) — reuses .nb-info-dialog/.nb-info-card styling */
    '.nb-gear-btn[hidden]{display:none;}',
    '.nb-gear-row{display:flex;align-items:center;justify-content:space-between;gap:12px;',
    '  padding:9px 2px;font:500 12.5px/1.4 var(--nb-ui);color:var(--nb-ink);cursor:pointer;}',
    '.nb-gear-row + .nb-gear-row{border-top:1px solid var(--nb-line);}',
    '.nb-gear-label{flex:1;min-width:0;}',
    '.nb-gear-row input[type=checkbox]{flex:none;width:16px;height:16px;cursor:pointer;accent-color:var(--nb-accent);}',
    '.nb-gear-row input[type=checkbox]:disabled{opacity:.45;cursor:not-allowed;}',
    '.nb-gear-hint{margin:9px 2px 0;font:400 11px/1.45 var(--nb-ui);color:var(--nb-ink-faint);}',
```

- [ ] **Step 4: Inject + wire the gear (embedded only)**

In `src/runtime/overlay.js`, after the info-dialog wiring block (the `infoCopyBtns` loop ends around line 720; place this immediately after that loop, still inside `mountOverlay`), insert:

```js
    /* --- gear: history opt-out (EMBEDDED only) -------------------------- */
    if (runMode === 'embedded' && historyControl && historyControl.available) {
      const headCtrls = sidebar.querySelector('.nb-head-ctrls');
      const gearBtn = doc.createElement('button');
      gearBtn.type = 'button';
      gearBtn.className = 'nb-info nb-gear-btn'; // reuse .nb-info button styling
      gearBtn.setAttribute('title', 'Version history');
      gearBtn.setAttribute('aria-label', 'Version history');
      gearBtn.setAttribute('aria-expanded', 'false');
      gearBtn.textContent = '⚙';
      headCtrls.insertBefore(gearBtn, headCtrls.firstChild);

      const gearDialog = doc.createElement('div');
      gearDialog.className = 'nb-info-dialog nb-gear-dialog'; // reuse dialog styling
      gearDialog.setAttribute('role', 'dialog');
      gearDialog.setAttribute('aria-label', 'Version history');
      gearDialog.hidden = true;
      gearDialog.innerHTML =
        '<div class="nb-info-card">' +
        '  <div class="nb-info-head">' +
        '    <span class="nb-info-title">Version history</span>' +
        '    <button type="button" class="nb-info-x nb-gear-x" title="Close" aria-label="Close">×</button>' +
        '  </div>' +
        '  <label class="nb-gear-row"><span class="nb-gear-label">Record history for this document</span>' +
        '    <input type="checkbox" class="nb-gear-doc" /></label>' +
        '  <label class="nb-gear-row"><span class="nb-gear-label">Record history for all docs here</span>' +
        '    <input type="checkbox" class="nb-gear-global" /></label>' +
        '  <p class="nb-gear-hint">“Here” means documents this browser stores for this location.</p>' +
        '</div>';
      sidebar.appendChild(gearDialog);

      const gearDocCb = gearDialog.querySelector('.nb-gear-doc');
      const gearGlobalCb = gearDialog.querySelector('.nb-gear-global');
      const syncGear = function () {
        gearGlobalCb.checked = !historyControl.globalOff();
        gearDocCb.checked = !historyControl.docOff();
        gearDocCb.disabled = historyControl.globalOff(); // global off → per-doc is moot
      };
      let gearOpen = false;
      const openGear = function () { syncGear(); gearDialog.hidden = false; gearOpen = true; gearBtn.setAttribute('aria-expanded', 'true'); };
      const closeGear = function () { gearDialog.hidden = true; gearOpen = false; gearBtn.setAttribute('aria-expanded', 'false'); };
      gearBtn.addEventListener('click', function (e) { e.stopPropagation(); if (gearOpen) closeGear(); else openGear(); });
      gearDialog.querySelector('.nb-gear-x').addEventListener('click', closeGear);
      gearDialog.addEventListener('click', function (e) { if (e.target === gearDialog) closeGear(); });

      const onGearToggle = function (wasEnabled) {
        syncGear();
        const nowEnabled = historyControl.enabled();
        if (!nowEnabled) {
          closeVersionInline();        // leave any inline version view
          renderSidebar();             // timeline hides (getHistory → [])
        } else if (!wasEnabled) {
          // re-enabled: re-save the live draft so the now-enabled version adopts the
          // current comments (closes the divergence window), then repaint.
          Promise.resolve(persist(getState())).then(function () { renderSidebar(); });
        } else {
          renderSidebar();
        }
      };
      gearDocCb.addEventListener('change', function () { const was = historyControl.enabled(); historyControl.setDoc(!gearDocCb.checked); onGearToggle(was); });
      gearGlobalCb.addEventListener('change', function () { const was = historyControl.enabled(); historyControl.setGlobal(!gearGlobalCb.checked); onGearToggle(was); });
    }
```

> Note: `closeVersionInline`, `renderSidebar`, `persist`, `getState` are all in `mountOverlay`'s scope (function declarations / destructured cfg), so this block can reference them even though some are defined later in the file.

- [ ] **Step 5: Rebuild the example canvas and verify it boots (manual smoke)**

The runtime is inlined into the canvas, so rebuild before any live check:

```bash
node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html
```

Expected: command succeeds, no error. (Live click-through is exercised by Task 5's e2e.)

- [ ] **Step 6: Commit**

```bash
git add src/runtime/overlay.js src/runtime/boot.js
git commit -m "feat: embedded gear button for live history opt-out

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Embedded gear e2e (`test/e2e/history-gear.e2e.test.js`)

Models the existing `version-scoping-file.e2e.test.js` harness (file://, real localStorage). Verifies: comment records a version → open the gear, turn **this document** off → the timeline + history-save item disappear and a further comment records **no new** version → turn it back on → the timeline returns.

**Files:**
- Create: `test/e2e/history-gear.e2e.test.js`

- [ ] **Step 1: Write the test**

Create `test/e2e/history-gear.e2e.test.js`:

```js
'use strict';
/**
 * Browser e2e (file://): the embedded gear (⚙) opts out of history live.
 *   comment -> a version records -> gear: "this document" OFF -> timeline + the
 *   "with history" save item hide AND a further comment records NO new version
 *   (data kept) -> gear ON -> the timeline returns.
 *
 * Runtime stays zero-dependency; Playwright is a devDependency used only here.
 * Requires the chromium binary: `npx playwright install chromium`.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..', '..');
const DEBOUNCE_MS = 600;

let browser, canvasFile, fileURL;

before(async () => {
  canvasFile = path.join(os.tmpdir(), 'noteback-gear-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', canvasFile], { stdio: 'pipe' });
  fileURL = pathToFileURL(canvasFile).href;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  try { fs.unlinkSync(canvasFile); } catch (e) {}
});

function verRecords(page) {
  return page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.indexOf('nb:ver:') !== 0) continue;
      let o = null; try { o = JSON.parse(localStorage.getItem(k)); } catch (e) {}
      out.push({ key: k, comments: o && o.comments ? o.comments.length : 0 });
    }
    return out;
  });
}

async function createComment(page, body, frac) {
  const box = await page.evaluate((f) => {
    const root = document.getElementById('noteback-doc-root');
    const ps = Array.from(root.querySelectorAll('p')).filter((el) => (el.textContent || '').trim().length > 100);
    const para = ps[Math.min(ps.length - 1, Math.floor(ps.length * f))];
    para.scrollIntoView({ block: 'center' });
    const r = para.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width };
  }, frac || 0);
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
  await page.waitForTimeout(800);
}

async function openSidebar(page) {
  const launcher = page.locator('.nb-launcher');
  if (await launcher.count()) { try { await launcher.click({ timeout: 1500 }); } catch (e) {} }
  await page.waitForTimeout(300);
}

test('embedded gear: opting out this document stops recording + hides the timeline, opting back in restores it', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(fileURL);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);

    // One comment → exactly one version record (history is recording).
    await createComment(page, 'first note', 0);
    let vers = await verRecords(page);
    assert.strictEqual(vers.length, 1, 'a version record exists after the first comment');
    assert.strictEqual(vers[0].comments, 1, 'the comment is on that version');

    await openSidebar(page);

    // The gear button exists (embedded + history available).
    const gear = page.locator('.nb-gear-btn');
    assert.strictEqual(await gear.count(), 1, 'the embedded gear button is present');

    // Open the gear and turn "this document" OFF.
    await gear.click();
    await page.waitForTimeout(150);
    const docToggle = page.locator('.nb-gear-doc');
    assert.strictEqual(await docToggle.isChecked(), true, 'history is on for this doc by default');
    await docToggle.uncheck();
    await page.waitForTimeout(400);

    // A further comment must NOT create/grow a version record (recording stopped).
    await createComment(page, 'note while opted out', 0.5);
    vers = await verRecords(page);
    const totalComments = vers.reduce((n, v) => n + v.comments, 0);
    assert.strictEqual(vers.length, 1, 'no NEW version record was created while opted out');
    assert.strictEqual(totalComments, 1, 'the opted-out comment was NOT recorded into history (kept only in the in-file draft)');

    // Re-open the sidebar and confirm the timeline is gone while opted out.
    await openSidebar(page);
    // (Adding a comment may have changed the content hash; the point is the timeline
    //  does not surface earlier versions while disabled.)
    assert.strictEqual(await page.locator('.nb-ver-row[data-version-key]').count(), 0, 'no earlier-version rows while opted out');

    // Turn it back ON → the timeline returns from the kept data.
    await page.locator('.nb-gear-btn').click();
    await page.waitForTimeout(150);
    await page.locator('.nb-gear-doc').check();
    await page.waitForTimeout(600);
    await openSidebar(page);
    assert.ok(await page.locator('.nb-versions').count() > 0 || await page.locator('.nb-ver-row').count() > 0, 'the timeline machinery is back after re-enabling');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/e2e/history-gear.e2e.test.js`
Expected: PASS. (If chromium is missing: `npx playwright install chromium` first.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e/history-gear.e2e.test.js
git commit -m "test(e2e): embedded gear live history opt-out

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Extension live re-mount + PING (`content-script.js`)

The extension picks adapter type at mount, so a live history-gate change re-mounts. Memoize `resolveDocId`, cache `historyDocId`, pass it as `docKey` to the gate (per-doc opt-out), track `lastHistoryOk`, and re-mount when the gate flips while active. Expose `historyDocId` in `NOTEBACK_PING` so the popup can offer the per-page toggle.

**Files:**
- Modify: `src/content/content-script.js` — `resolveDocId` (memoize, lines 82-101); add `historyDocId` cache; `buildAdapter` gate call (line 210-211); `applySettings` (lines 287-293); boot tail (lines 300-313); `NOTEBACK_PING` (lines 332-342).
- Test: covered by Task 8 (e2e, skip-gated) + manual. No unit test (IIFE, no exports — matches the existing file).

- [ ] **Step 1: Memoize `resolveDocId` and cache `historyDocId`**

In `src/content/content-script.js`, replace `resolveDocId` (lines 82-101) with a memoized version and add a module-level cache. First, just after `const docTitle = deriveTitle();` (line 66) add:

```js
  // The resolved history doc-id (baked attribute or nb:url minted id). Cached so the
  // settings re-evaluation and NOTEBACK_PING can read it synchronously after boot.
  let historyDocId = null;
  let docIdPromise = null;
```

Then replace the `resolveDocId` function body (lines 82-101) with:

```js
  function resolveDocId() {
    if (docIdPromise) return docIdPromise;
    docIdPromise = new Promise(function (resolve) {
      const rootEl = document.getElementById('noteback-doc-root');
      const baked = rootEl && rootEl.getAttribute && rootEl.getAttribute('data-noteback-doc-id');
      if (baked) { resolve(baked); return; }
      // fragment-independent: same doc across #hash routes
      const normHref = (location.href || '').split('#')[0];
      const urlKey = 'nb:url:' + normHref;
      try {
        chrome.storage.local.get(urlKey, function (items) {
          let id = items && items[urlKey];
          if (id) { resolve(id); return; }
          id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          const bag = {};
          bag[urlKey] = id;
          chrome.storage.local.set(bag, function () { resolve(id); });
        });
      } catch (e) { resolve(''); }
    });
    return docIdPromise;
  }
```

- [ ] **Step 2: Pass `docKey` to the gate in `buildAdapter` (and de-shadow the inner param)**

In `buildAdapter` (lines 209-211), replace the `historyOk` computation with (note it now reads the module-level `historyDocId` cache):

```js
  function buildAdapter(settings) {
    const historyOk = !!(policy && policy.historyAllowed &&
      policy.historyAllowed({ type: originType, origin: origin, docKey: historyDocId }, settings));
```

The existing inner resolve callback (line 218) is named `historyDocId`, which now shadows the module-level cache. Rename that inner param to `resolvedId` and update its two uses. Replace lines 218-239 (`return resolveDocId().then(function (historyDocId) { … });`) so the callback reads:

```js
    return resolveDocId().then(function (resolvedId) {
      // createChromeKvStore THROWS eagerly if chrome.storage.local is missing —
      // catch (don't .catch()) and degrade to the comments-only path.
      let kv = null;
      try { kv = RT.chromeKvStore.createChromeKvStore(chrome); } catch (e) { kv = null; }
      if (!kv || !resolvedId) {
        return {
          adapter: RT.chromeStorageAdapter.createChromeStorageAdapter(docId),
          history: null
        };
      }
      const adapter = RT.historyStateAdapter.createHistoryStateAdapter({
        doc: document,
        store: kv,
        inner: null,
        docId: resolvedId,
        contentText: function () {
          try { return (document.getElementById('noteback-doc-root') || document.body).textContent || ''; }
          catch (e) { return ''; }
        },
        captureSnapshot: function () { return RT.snapshotCapture.captureCleanDoc(document); }
      });
```

(Leave the `return { adapter, history: (adapter.getHistory ? {…} : null) };` tail that follows unchanged.)

- [ ] **Step 3: Re-mount on gate flip in `applySettings`**

Replace `applySettings` (lines 287-293) with:

```js
  let lastHistoryOk = null;

  function applySettings(settings) {
    // History gate is decided at mount (the adapter TYPE differs). To honor a live
    // history opt-out we re-mount when the gate flips while active — comments survive
    // (they live in chrome.storage); the rebuilt adapter shows/hides the timeline.
    const histOk = !!(policy && policy.historyAllowed &&
      policy.historyAllowed({ type: originType, origin: origin, docKey: historyDocId }, settings));
    if (!shouldActivate(settings)) { unmount(); lastHistoryOk = histOk; return; }
    if (active && histOk !== lastHistoryOk) unmount(); // gate flipped → rebuild adapter
    lastHistoryOk = histOk;
    mount(settings);
  }
```

- [ ] **Step 4: Resolve the doc-id before the first settings decision**

Replace the boot tail (lines 300-313) with:

```js
  // Click-to-activate (unsupported origins). When the popup injects us on an
  // 'other' origin via activeTab, it first sets window.__notebackForceActivate.
  // The user's click IS the opt-in, so we mount unconditionally and do NOT
  // consult nb:settings. Such pages also ignore live settings changes.
  if (window.__notebackForceActivate) {
    mount();
  } else {
    // Resolve the history doc-id once (needed for the per-doc opt-out gate + PING),
    // THEN make the initial settings decision and subscribe to live changes.
    resolveDocId().then(function (id) {
      historyDocId = id || null;
      readSettings().then(applySettings);

      // React live to popup-driven changes (no page reload needed).
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local' || !changes[SETTINGS_KEY]) return;
          applySettings(changes[SETTINGS_KEY].newValue || null);
        });
      }
    });
  }
```

- [ ] **Step 5: Return `historyDocId` in PING**

In the `NOTEBACK_PING` case (lines 332-342), add `historyDocId` to the response object:

```js
      case 'NOTEBACK_PING':
        sendResponse({
          ok: true,
          booted: active,
          dormant: !active,
          originType: originType,
          origin: origin,
          docId: docId,
          historyDocId: historyDocId,
          docTitle: docTitle
        });
        return false;
```

- [ ] **Step 6: Verify the unit suite still passes (no regressions)**

Run: `npm run test:unit`
Expected: PASS (content-script has no unit tests; this confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add src/content/content-script.js
git commit -m "feat: extension live history opt-out via re-mount + historyDocId in PING

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Popup "Version history" opt-out section (`popup.html` / `popup.css` / `popup.js`)

Three cascading opt-out toggles scoped to the active tab, inside the existing settings panel. Shown only when the page is booted (so we have `origin` + `historyDocId`) and base history can run for it. Writes go through `getSettings()`/`saveSettings()`; the resulting `chrome.storage.onChanged` drives the content-script re-mount from Task 6.

**Files:**
- Modify: `src/popup/popup.html:67-78` (settings panel).
- Modify: `src/popup/popup.css` (history rows; append near the existing `.nb-setting-row` styles ~line 234).
- Modify: `src/popup/popup.js` — element refs (~line 30), normalize-backed helpers, `renderHistorySection`, listeners, and capture `pong` in `refreshState`.
- Test: manual (load unpacked extension). The data model it writes is covered by Task 1's unit tests; the live effect by Task 8's e2e. (Popup JS is an un-exported IIFE, like the existing `withSite`/`withType` — no unit harness.)

- [ ] **Step 1: Add the HTML rows**

In `src/popup/popup.html`, inside `<section id="nb-settings" ...>` after the three type rows (after line 77, before the closing `</section>` on line 78), insert:

```html
    <div id="nb-hist-block" hidden>
      <div class="nb-settings__title nb-settings__title--hist">Version history</div>
      <label class="nb-setting-row"><span>Record history</span>
        <span class="nb-switch"><input id="nb-hist-global" type="checkbox" /><span class="nb-switch__slider"></span></span>
      </label>
      <label class="nb-setting-row" id="nb-hist-site-row"><span>On this site <code id="nb-hist-site-origin"></code></span>
        <span class="nb-switch"><input id="nb-hist-site" type="checkbox" /><span class="nb-switch__slider"></span></span>
      </label>
      <label class="nb-setting-row" id="nb-hist-doc-row"><span>On this page</span>
        <span class="nb-switch"><input id="nb-hist-doc" type="checkbox" /><span class="nb-switch__slider"></span></span>
      </label>
      <p id="nb-hist-hint" class="nb-hist-hint" hidden></p>
    </div>
```

- [ ] **Step 2: Add the CSS**

In `src/popup/popup.css`, after the `.nb-settings__title { ... }` rule (line 234), append:

```css
.nb-settings__title--hist { margin-top: 12px; }
.nb-hist-hint { font-size: 11px; color: #92400e; margin: 4px 0 0; }
.nb-hist-hint[hidden] { display: none; }
#nb-hist-block[hidden] { display: none; }
```

- [ ] **Step 3: Add element refs + capture pong**

In `src/popup/popup.js`, after the `typeInputs` block (line 34) add:

```js
  const histBlock = byId('nb-hist-block');
  const histGlobal = byId('nb-hist-global');
  const histSiteRow = byId('nb-hist-site-row');
  const histSiteOrigin = byId('nb-hist-site-origin');
  const histSite = byId('nb-hist-site');
  const histDocRow = byId('nb-hist-doc-row');
  const histDoc = byId('nb-hist-doc');
  const histHint = byId('nb-hist-hint');
```

After `let settings = null;` (line 38) add:

```js
  let lastPong = null;
```

In `refreshState`, in the booted branch (line 160-163), capture the pong and render the history section. Replace:

```js
      if (pong && pong.booted) {
        disableActions(false);
        showSiteRow(true);              // no-ops for 'other' origins
        setStatus(countLabel(pong));
      } else {
```

with:

```js
      if (pong && pong.booted) {
        lastPong = pong;
        disableActions(false);
        showSiteRow(true);              // no-ops for 'other' origins
        renderHistorySection();
        setStatus(countLabel(pong));
      } else {
```

And in the dormant branch + the catch (`.catch`), hide the history block. In the `else {` dormant branch (after line 168 `showSiteRow(false);`) add `hideHistorySection();`, and at the top of the `.catch(function () {` body (after line 174 `hideSiteRow();`) add `hideHistorySection();`.

- [ ] **Step 4: Add the normalize-backed helpers**

In `src/popup/popup.js`, after `withSite` (line 404) add:

```js
  function withHistoryGlobal(s, off) {
    const norm = policy ? policy.normalizeSettings(s) : { historyDisabledGlobal: false, historyDisabledSites: [], historyDisabledDocs: [] };
    norm.historyDisabledGlobal = !!off;
    return norm;
  }

  function withHistoryList(s, listName, value, off) {
    const norm = policy ? policy.normalizeSettings(s) : { historyDisabledSites: [], historyDisabledDocs: [] };
    const list = (norm[listName] || []).slice();
    const idx = list.indexOf(value);
    if (off) { if (idx === -1) list.push(value); }   // opt OUT → add
    else { if (idx !== -1) list.splice(idx, 1); }    // opt IN  → remove
    norm[listName] = list;
    return norm;
  }
```

- [ ] **Step 5: Add render + hide helpers**

In `src/popup/popup.js`, after `hideSiteRow` (line 388) add:

```js
  function historyBaseAllowed() {
    // Mirrors origin-policy: base history runs for local types, or an other-origin
    // that opted in via historySites. (We surface opt-OUT only; no opt-in UI.)
    if (!lastPong) return false;
    if ((policy ? policy.TYPES : ['file', 'localhost', '127.0.0.1']).indexOf(lastPong.originType) !== -1) return true;
    const norm = policy ? policy.normalizeSettings(settings) : { historySites: [] };
    return !!(lastPong.origin && norm.historySites.indexOf(lastPong.origin) !== -1);
  }

  function renderHistorySection() {
    if (!lastPong) { hideHistorySection(); return; }
    histBlock.removeAttribute('hidden');
    const norm = policy ? policy.normalizeSettings(settings) : { historyDisabledGlobal: false, historyDisabledSites: [], historyDisabledDocs: [] };

    if (!historyBaseAllowed()) {
      // Off for this site type and not opted in: nothing to subtract. Show a hint,
      // disable the toggles.
      histGlobal.checked = false; histGlobal.disabled = true;
      histSite.checked = false; histSite.disabled = true;
      histDoc.checked = false; histDoc.disabled = true;
      histSiteRow.setAttribute('hidden', ''); histDocRow.setAttribute('hidden', '');
      histHint.textContent = 'Version history isn’t recorded on this site.';
      histHint.hidden = false;
      return;
    }
    histHint.hidden = true;
    histSiteRow.removeAttribute('hidden');
    histDocRow.removeAttribute('hidden');

    const globalOff = norm.historyDisabledGlobal;
    const siteOff = !!(lastPong.origin && norm.historyDisabledSites.indexOf(lastPong.origin) !== -1);
    const docOff = !!(lastPong.historyDocId && norm.historyDisabledDocs.indexOf(lastPong.historyDocId) !== -1);

    histGlobal.disabled = false;
    histGlobal.checked = !globalOff;

    histSiteOrigin.textContent = lastPong.origin || '';
    histSite.disabled = globalOff;                 // cascade: global off → site moot
    histSite.checked = !globalOff && !siteOff;

    histDoc.disabled = globalOff || siteOff;        // cascade: global/site off → doc moot
    histDoc.checked = !globalOff && !siteOff && !docOff;
    // No historyDocId (page not a resolvable history doc): hide the per-page row.
    if (!lastPong.historyDocId) histDocRow.setAttribute('hidden', '');
  }

  function hideHistorySection() { histBlock.setAttribute('hidden', ''); }
```

- [ ] **Step 6: Wire the toggle listeners**

In `src/popup/popup.js`, inside `init()` after the `siteToggle.addEventListener(...)` block (line 85), add:

```js
    histGlobal.addEventListener('change', function () {
      settings = withHistoryGlobal(settings, !histGlobal.checked);
      saveSettings(settings).then(function () { renderHistorySection(); });
    });
    histSite.addEventListener('change', function () {
      if (!lastPong || !lastPong.origin) return;
      settings = withHistoryList(settings, 'historyDisabledSites', lastPong.origin, !histSite.checked);
      saveSettings(settings).then(function () { renderHistorySection(); });
    });
    histDoc.addEventListener('change', function () {
      if (!lastPong || !lastPong.historyDocId) return;
      settings = withHistoryList(settings, 'historyDisabledDocs', lastPong.historyDocId, !histDoc.checked);
      saveSettings(settings).then(function () { renderHistorySection(); });
    });
```

- [ ] **Step 7: Manual verification (load unpacked extension)**

There is no popup test harness, so verify by hand:

```
1. chrome://extensions → Developer mode → Load unpacked → select the repo root.
2. Serve a doc on localhost (e.g. `python3 -m http.server` over examples/), open it.
3. Open the Noteback popup → ⚙ → confirm the "Version history" section shows
   "Record history" (on), "On this site <origin>" (on), "On this page" (on).
4. Add a comment (sidebar) → confirm a version is being tracked.
5. Toggle "On this page" OFF → the sidebar timeline disappears live (re-mount);
   a new comment records no version. Toggle ON → timeline returns.
6. Toggle "Record history" (global) OFF → site + page toggles grey out (cascade).
7. Open a plain https:// page → the section shows the "isn’t recorded" hint.
```

Expected: each step behaves as described. (Automated coverage: Task 1 for the data model, Task 8 for the live re-mount.)

- [ ] **Step 8: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.js
git commit -m "feat: popup Version history opt-out section (global/site/page)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Extension live opt-out e2e (`test/e2e/extension-history-optout.e2e.test.js`)

Skip-gated like `extension-standdown.e2e.test.js` (loads the real unpacked extension; skips when it can't inject). Uses the extension's **service worker** to read/write `chrome.storage.local` (the page world can't). Verifies: on a plain localhost page the extension records a version; setting `historyDisabledGlobal` makes a further comment record **no** new version (history stopped live).

**Files:**
- Create: `test/e2e/extension-history-optout.e2e.test.js`

- [ ] **Step 1: Write the test**

Create `test/e2e/extension-history-optout.e2e.test.js`:

```js
'use strict';
/**
 * Browser e2e (skip-gated): the EXTENSION honors a live history opt-out.
 *
 * On a plain localhost page the extension mounts and records version history into
 * chrome.storage. Writing nb:settings.historyDisabledGlobal=true (as the popup
 * would) fires chrome.storage.onChanged; the content script re-mounts with the
 * comments-only adapter, so a further comment records NO new version.
 *
 * chrome.storage is privileged — the page world can't touch it — so we drive it
 * through the extension's service worker (extContext.serviceWorkers()).
 *
 * Loading an unpacked extension is environment-sensitive; this SKIPS rather than
 * fails when the extension can't inject. Requires `npx playwright install chromium`.
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

let server, baseURL;

const PLAIN_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>plain</title></head>' +
  '<body>' +
  '<p>First paragraph long enough to select comfortably. Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.</p>' +
  '<p>Second paragraph also long enough to select comfortably. Ut enim ad minim veniam quis nostrud exercitation ullamco laboris.</p>' +
  '</body></html>';

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PLAIN_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function getWorker(ctx) {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch (e) { sw = null; } }
  return sw;
}

function readVerCount(sw) {
  return sw.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      let n = 0, comments = 0;
      Object.keys(all || {}).forEach((k) => {
        if (k.indexOf('nb:ver:') !== 0) return;
        n++; comments += ((all[k] && all[k].comments) || []).length;
      });
      resolve({ records: n, comments: comments });
    });
  }));
}

async function createComment(page, body, frac) {
  const box = await page.evaluate((f) => {
    const ps = Array.from(document.querySelectorAll('p')).filter((el) => (el.textContent || '').trim().length > 80);
    const para = ps[Math.min(ps.length - 1, Math.floor(ps.length * f))];
    para.scrollIntoView({ block: 'center' });
    const r = para.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width };
  }, frac || 0);
  const y = box.y + 6;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.w - 8, 220), y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(DEBOUNCE_MS);
  const fab = page.locator('button.noteback-fab');
  await fab.waitFor({ state: 'visible', timeout: 3000 });
  await fab.click();
  const ta = page.locator('.nb-popover textarea');
  await ta.waitFor({ state: 'visible', timeout: 3000 });
  await ta.fill(body);
  await page.locator('.nb-savecomment').click();
  await page.waitForTimeout(900);
}

test('extension: live history opt-out stops recording new versions', { timeout: 120000 }, async (t) => {
  let ctx = null;
  try {
    try {
      ctx = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`],
        viewport: { width: 1280, height: 900 }
      });
    } catch (e) { t.skip('could not launch Chromium with an unpacked extension: ' + (e && e.message)); return; }

    const page = await ctx.newPage();
    await page.goto(baseURL + '/');
    let injected = false;
    try { await page.locator('[data-noteback-ui="panel"]').first().waitFor({ state: 'attached', timeout: 6000 }); injected = true; } catch (e) {}
    if (!injected) { t.skip('the unpacked extension did not inject in this environment'); return; }

    const sw = await getWorker(ctx);
    if (!sw) { t.skip('extension service worker unavailable'); return; }

    // History on by default for localhost: a comment records exactly one version.
    await createComment(page, 'recorded while history on', 0);
    let v = await readVerCount(sw);
    assert.strictEqual(v.records, 1, 'a version record exists while history is on');
    assert.strictEqual(v.comments, 1, 'the comment is in history');

    // Opt out globally (as the popup would) and wait for the live re-mount.
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ 'nb:settings': { historyDisabledGlobal: true } }, res)));
    await page.waitForTimeout(1200);
    // Exactly one overlay remains (re-mount, not a double-mount).
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-noteback-ui="panel"]').length), 1, 'still exactly one overlay after re-mount');

    // A further comment must NOT add to history (recording stopped).
    await createComment(page, 'made while opted out', 1);
    v = await readVerCount(sw);
    assert.strictEqual(v.records, 1, 'no NEW version record was created after opting out');
    assert.strictEqual(v.comments, 1, 'history still holds only the pre-opt-out comment (data kept, recording stopped)');
  } finally {
    if (ctx) await ctx.close();
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/e2e/extension-history-optout.e2e.test.js`
Expected: PASS, or SKIP if the unpacked extension/service worker can't load in this environment (acceptable — it never false-fails, matching the standdown e2e).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/extension-history-optout.e2e.test.js
git commit -m "test(e2e): extension live history opt-out (skip-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Documentation

Record the gate, the flags, the gear, and the asymmetric live mechanism in the canonical docs.

**Files:**
- Modify: `CONTRACTS.md` (history gate section + the embedded boot / overlay cfg).
- Modify: `CLAUDE.md` (gotchas list).
- Modify: `docs/design.md` (history opt-out subsection).

- [ ] **Step 1: CONTRACTS.md**

Find the section describing `historyAllowed` / the history gate (search `historyAllowed`) and add the opt-out layer + the new `nb:settings` fields:

```markdown
- `historyAllowed({type, origin, docKey}, settings)` applies an opt-out subtract
  layer above the base rule: `historyDisabledGlobal` (kill switch),
  `historyDisabledSites` (origins), and `historyDisabledDocs` (history doc-ids) each
  force `false`. Base rule unchanged (on for file/localhost/127; `historySites`
  opt-in for other origins). `nb:settings` gains those three fields (normalized:
  bool / [] / []).
- Embedded mode carries no settings; it opts out via two localStorage flags,
  `nb:nohist:global` and `nb:nohist:doc:<docId>`, surfaced as `historyControl`
  (`available/globalOff/docOff/enabled/setGlobal/setDoc`) on the embedded boot.
- `createHistoryStateAdapter` accepts an optional `isEnabled()` predicate; false ⇒
  pass-through to `inner`, empty `getHistory()`/`getVersion()` (data kept). Live
  toggle invalidates the memoized resolution.
- `boot()` / `mountOverlay()` cfg gains `historyControl` (embedded only); the overlay
  renders the gear ⚙ when `runMode === 'embedded' && historyControl.available`.
```

- [ ] **Step 2: CLAUDE.md**

Add a bullet to the "Gotchas" list:

```markdown
- **History opt-out is a SUBTRACT layer, and the two surfaces go live differently.**
  `origin-policy.historyAllowed` subtracts `historyDisabledGlobal` /
  `historyDisabledSites` / `historyDisabledDocs` (keyed on the resolved history
  doc-id, passed as `info.docKey`) above the base rule. The **extension** can't gate
  in place (it picks adapter TYPE at mount), so a live opt-out **re-mounts**
  (`content-script.js` `applySettings` compares `lastHistoryOk` and unmount+mounts on
  a flip) — the "gate read once at mount" invariant still holds (a re-mount is a new
  mount). The **embedded** canvas always builds the history adapter, so it gates **in
  place** via `createHistoryStateAdapter`'s `isEnabled()` (fed by `historyControl`
  over `nb:nohist:global` / `nb:nohist:doc:<docId>`, read/written with **guarded**
  raw localStorage). Opt-out HIDES the timeline and stops recording but KEEPS stored
  snapshots; re-enabling the gear re-saves the live draft (`persist(getState())`) so
  the now-enabled version adopts comments added while off.
```

- [ ] **Step 3: docs/design.md**

In the history section (search `§14` / "History"), add a subsection summarizing the opt-out controls (the three extension scopes + the embedded gear, both live, stop+hide+keep) — 1–2 short paragraphs mirroring the spec's §"Decisions".

- [ ] **Step 4: Commit**

```bash
git add CONTRACTS.md CLAUDE.md docs/design.md
git commit -m "docs: history opt-out (gate, flags, gear, live mechanism)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Run the full unit suite:** `npm run test:unit` → all PASS.
- [ ] **Run the e2e suite:** `npm run test:e2e` → PASS or SKIP (never fail). Ensure `npx playwright install chromium` has been run.
- [ ] **Rebuild the example canvas:** `node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html` succeeds.
- [ ] **Dispatch a final code review** over the whole branch diff before finishing.
```
