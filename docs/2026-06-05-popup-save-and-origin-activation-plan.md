# Popup Save dropdown + per-origin activation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the sidebar's three-way Save menu to the toolbar popup (and make "clean copy" actually export in extension mode), and add per-site / per-type activation toggles so Noteback can go dormant on local dev servers without touching stored comments.

**Architecture:** A new DOM-free `origin-policy` module computes "should Noteback be active on this page?" and is shared by both the content script (to gate mounting) and the popup (to render toggles). The content script becomes mount/unmount-capable and reacts live to `chrome.storage.onChanged`. Clean-HTML export reuses the existing service-worker download path. Settings persist under one `nb:settings` key in `chrome.storage.local`.

**Tech Stack:** Vanilla JS (no build, no deps, no TS). Tests on the Node built-in runner (`node --test`). Chrome MV3 (content script, popup page, service worker, `chrome.storage.local`).

---

## Spec

`docs/2026-06-05-popup-save-and-origin-activation.md`

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/content/origin-policy.js` | Pure: classify origin, normalize settings, decide active/dormant, compute origin string | **Create** |
| `test/origin-policy.test.js` | Unit tests for the pure module | **Create** |
| `src/background/service-worker.js` | Add `NOTEBACK_EXPORT_CLEAN` → download clean HTML | Modify |
| `src/content/content-script.js` | `onSaveClean` hook; mount/unmount lifecycle; storage subscription; new PING fields; `SAVE_CLEAN`/`SAVE_PDF` messages | Modify |
| `src/runtime/boot.js` | Forward `saveClean`/`savePdf` on the boot controller | Modify |
| `src/popup/popup.html` | Save dropdown, gear, settings panel, per-site row; load `origin-policy.js` | Modify |
| `src/popup/popup.css` | Styles for dropdown, switches, settings panel, site row | Modify |
| `src/popup/popup.js` | Dropdown logic, settings read/write, per-site + per-type toggles, dormant-state rendering | Modify |
| `manifest.json` | Add `origin-policy.js` to `content_scripts.js` | Modify |
| `CONTRACTS.md` | Document `nb:settings` schema + activation predicate | Modify |

**Note on testability:** Only `origin-policy` is unit-testable (pure). Everything touching `chrome.*`, the DOM, or downloads is verified manually by loading the unpacked extension — those tasks give exact click-by-click verification steps instead of red/green.

**Live-test reminder (from CLAUDE.md):** This plan touches `src/runtime/boot.js`. If you live-test a *canvas* file, rebuild it and cache-bust the URL first. For the *extension*, just reload it at `chrome://extensions` after each change.

---

## Task 1: `origin-policy` pure module (TDD)

**Files:**
- Create: `src/content/origin-policy.js`
- Test: `test/origin-policy.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/origin-policy.test.js`:

```js
/**
 * Noteback tests — origin-policy.test.js
 * Runs under the Node built-in runner ONLY:  node --test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../src/content/origin-policy.js');

test('module exposes its API and a stable settings key', () => {
  assert.strictEqual(policy.SETTINGS_KEY, 'nb:settings');
  assert.deepStrictEqual(policy.TYPES, ['file', 'localhost', '127.0.0.1']);
  assert.strictEqual(typeof policy.classifyOrigin, 'function');
  assert.strictEqual(typeof policy.originOf, 'function');
  assert.strictEqual(typeof policy.normalizeSettings, 'function');
  assert.strictEqual(typeof policy.isActive, 'function');
});

test('classifyOrigin maps protocol/hostname to type', () => {
  assert.strictEqual(policy.classifyOrigin({ protocol: 'file:', hostname: '' }), 'file');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'http:', hostname: 'localhost' }), 'localhost');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), '127.0.0.1');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'https:', hostname: 'example.com' }), 'other');
});

test('originOf returns "file://" for file pages and origin otherwise', () => {
  assert.strictEqual(policy.originOf({ protocol: 'file:', hostname: '' }), 'file://');
  assert.strictEqual(
    policy.originOf({ protocol: 'http:', host: 'localhost:3000', origin: 'http://localhost:3000' }),
    'http://localhost:3000'
  );
});

test('isActive defaults to true when settings are absent', () => {
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, null), true);
  assert.strictEqual(policy.isActive({ type: 'file', origin: 'file://' }, undefined), true);
});

test('per-type switch off suppresses the whole type', () => {
  const s = { origins: { localhost: false } };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
  assert.strictEqual(policy.isActive({ type: 'file', origin: 'file://' }, s), true);
});

test('per-site entry subtracts one origin while its type stays on', () => {
  const s = { disabledSites: ['http://localhost:3000'] };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:8000' }, s), true);
});

test('type-off wins regardless of disabledSites', () => {
  const s = { origins: { localhost: false }, disabledSites: [] };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:8000' }, s), false);
});

test('unknown/other origin type is never active', () => {
  assert.strictEqual(policy.isActive({ type: 'other', origin: 'https://example.com' }, null), false);
});

test('normalizeSettings fills defaults and is shape-stable', () => {
  const n = policy.normalizeSettings(null);
  assert.deepStrictEqual(n.origins, { file: true, localhost: true, '127.0.0.1': true });
  assert.deepStrictEqual(n.disabledSites, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/origin-policy.test.js`
Expected: FAIL — `Cannot find module '../src/content/origin-policy.js'`.

- [ ] **Step 3: Write the module**

Create `src/content/origin-policy.js`:

```js
/**
 * Noteback — origin-policy.js  (PURE; Node + browser dual export)
 *
 * Extension-only. Decides whether Noteback should ACTIVATE (mount its UI) on a
 * given page, from the page's origin and the user's settings. Shared by the
 * content script (gating) and the popup (rendering the toggles). DOM-free and
 * chrome-free so it unit-tests under `node --test`.
 *
 *   classifyOrigin(loc)      -> 'file' | 'localhost' | '127.0.0.1' | 'other'
 *   originOf(loc)            -> canonical origin string ('file://' for file pages)
 *   normalizeSettings(s)     -> { origins:{file,localhost,'127.0.0.1'}, disabledSites:[] }
 *   isActive({type,origin},s)-> boolean   (per-type master gate, per-site subtract)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;                       // Node (tests)
  }
  if (root) {
    root.NotebackRuntime = root.NotebackRuntime || {};
    root.NotebackRuntime.originPolicy = api;    // browser (content script + popup)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SETTINGS_KEY = 'nb:settings';
  const TYPES = ['file', 'localhost', '127.0.0.1'];

  function classifyOrigin(loc) {
    loc = loc || {};
    if (String(loc.protocol || '') === 'file:') return 'file';
    const host = String(loc.hostname || '');
    if (host === 'localhost') return 'localhost';
    if (host === '127.0.0.1') return '127.0.0.1';
    return 'other';
  }

  // Canonical per-site identity. file:// pages share the single origin "file://";
  // http(s) pages use scheme+host+port. Computed identically on both sides so a
  // per-site disable entry matches whether written by the popup or read by the
  // content script.
  function originOf(loc) {
    loc = loc || {};
    if (String(loc.protocol || '') === 'file:') return 'file://';
    if (loc.origin) return String(loc.origin);
    const host = String(loc.host || loc.hostname || '');
    return String(loc.protocol || '') + '//' + host;
  }

  function normalizeSettings(settings) {
    const s = settings || {};
    const o = s.origins || {};
    return {
      origins: {
        file: o.file !== false,
        localhost: o.localhost !== false,
        '127.0.0.1': o['127.0.0.1'] !== false
      },
      disabledSites: Array.isArray(s.disabledSites) ? s.disabledSites.slice() : []
    };
  }

  function isActive(info, settings) {
    info = info || {};
    if (TYPES.indexOf(info.type) === -1) return false;          // 'other'/unknown
    const norm = normalizeSettings(settings);
    if (norm.origins[info.type] === false) return false;        // per-type master gate
    if (info.origin && norm.disabledSites.indexOf(info.origin) !== -1) return false; // per-site subtract
    return true;
  }

  return {
    SETTINGS_KEY: SETTINGS_KEY,
    TYPES: TYPES,
    classifyOrigin: classifyOrigin,
    originOf: originOf,
    normalizeSettings: normalizeSettings,
    isActive: isActive
  };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/origin-policy.test.js`
Expected: PASS — all assertions green.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all prior tests still pass, plus the new file.

- [ ] **Step 6: Commit**

```bash
git add src/content/origin-policy.js test/origin-policy.test.js
git commit -m "policy: pure origin-policy module (classify + activation predicate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Clean-HTML export in extension mode

Makes "HTML · clean copy" actually download in the extension (fixes the sidebar too). The content script already strips Noteback via `docContentHtml()`; we hand that to the worker to download.

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/content/content-script.js`

- [ ] **Step 1: Add the worker download handler**

In `src/background/service-worker.js`, add a `case` to the `onMessage` switch, immediately after the `NOTEBACK_EXPORT_CANVAS` case (after its `return true;`, around line 69):

```js
    case 'NOTEBACK_EXPORT_CLEAN':
      // Content script supplies the already-cleaned HTML (Noteback UI stripped,
      // highlights unwrapped). We only name it and trigger the download.
      exportClean({
        docId: msg.docId,
        docTitle: msg.docTitle,
        cleanHtml: msg.cleanHtml
      }).then(
        function (result) { sendResponse({ ok: true, downloadId: result }); },
        function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
      );
      return true; // async response
```

- [ ] **Step 2: Add the `exportClean` function**

In `src/background/service-worker.js`, add this function right after `exportCanvas` (after its closing `}`, around line 161):

```js
/**
 * Download a clean (Noteback-free) copy of the document. The content script has
 * already stripped our UI and unwrapped highlights, so there is no assembly to
 * do — just name it and hand it to the downloads API.
 * @param {{docId:string, docTitle:string, cleanHtml:string}} input
 * @returns {Promise<number>} the downloads API download id.
 */
function exportClean(input) {
  input = input || {};
  const html = String(input.cleanHtml || '');
  if (!html) return Promise.reject(new Error('no clean HTML provided'));
  const filename = suggestedFilename(input.docTitle, input.docId);
  return triggerDownload(html, filename);
}
```

- [ ] **Step 3: Wire the `onSaveClean` hook in the content script**

In `src/content/content-script.js`, add this function right after `onSaveCanvas` (after its closing `}`, around line 95):

```js
  /**
   * Save a clean copy: the document with Noteback's UI removed and highlight
   * <mark> wrappers unwrapped (docContentHtml), downloaded as a standalone .html.
   * The worker has the `downloads` privilege; we just supply the bytes.
   */
  function onSaveClean(state) {
    return sendToWorker({
      type: 'NOTEBACK_EXPORT_CLEAN',
      docId: docId,
      docTitle: docTitle,
      cleanHtml: '<!DOCTYPE html>\n' + docContentHtml()
    });
  }
```

- [ ] **Step 4: Register the hook on the exporter object**

In `src/content/content-script.js`, replace the `exporter` object (lines 97-100):

```js
  const exporter = {
    onCopyMarkdown: onCopyMarkdown,
    onSaveCanvas: onSaveCanvas
  };
```

with:

```js
  const exporter = {
    onCopyMarkdown: onCopyMarkdown,
    onSaveCanvas: onSaveCanvas,
    onSaveClean: onSaveClean
  };
```

- [ ] **Step 5: Verify the full suite still passes**

Run: `npm test`
Expected: unchanged — all green (no logic under test changed).

- [ ] **Step 6: Manual verification**

1. `chrome://extensions` → reload Noteback.
2. Serve and open a doc: `python3 -m http.server 8000` then `http://localhost:8000/examples/spec.html`.
3. Add one comment, open the sidebar, click **Save ▾ → HTML · clean copy**.
4. Expected: a `.html` file downloads. Open it — it renders the document with **no** Noteback launcher/sidebar and **no** highlight tint (a clean copy). Previously this only showed a toast.

- [ ] **Step 7: Commit**

```bash
git add src/background/service-worker.js src/content/content-script.js
git commit -m "export: clean-HTML save now works in extension mode (worker download)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Plumb saveClean/savePdf to the controller + new save messages

**Files:**
- Modify: `src/runtime/boot.js`
- Modify: `src/content/content-script.js`

- [ ] **Step 1: Forward saveClean/savePdf on the boot controller**

In `src/runtime/boot.js`, replace the `bootApi` object's `saveCanvas` line (line 149):

```js
      saveCanvas: function () { return controller.saveCanvas(); }
```

with all three:

```js
      saveCanvas: function () { return controller.saveCanvas(); },
      saveClean: function () { return controller.saveClean(); },
      savePdf: function () { return controller.savePdf(); }
```

- [ ] **Step 2: Add SAVE_CLEAN / SAVE_PDF message handlers**

In `src/content/content-script.js`, add two cases to the `onMessage` switch, immediately after the `NOTEBACK_SAVE_CANVAS` case (after its `return true;`, around line 188):

```js
      case 'NOTEBACK_SAVE_CLEAN':
        ready.then(function (c) {
          if (!c) { sendResponse({ ok: false, error: 'not booted' }); return; }
          Promise.resolve(c.saveClean()).then(
            function () { sendResponse({ ok: true }); },
            function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
          );
        });
        return true;

      case 'NOTEBACK_SAVE_PDF':
        ready.then(function (c) {
          if (!c) { sendResponse({ ok: false, error: 'not booted' }); return; }
          Promise.resolve(c.savePdf()).then(
            function () { sendResponse({ ok: true }); },
            function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
          );
        });
        return true;
```

- [ ] **Step 3: Verify the suite still passes**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/boot.js src/content/content-script.js
git commit -m "plumb: expose saveClean/savePdf on controller + SAVE_CLEAN/SAVE_PDF messages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Popup Save dropdown (Feature 1 UI)

This task adds only the Save dropdown (settings UI comes in Task 6). It also loads `origin-policy.js` into the popup so later tasks can reuse it.

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.css`
- Modify: `src/popup/popup.js`

- [ ] **Step 1: Mark up the dropdown + load origin-policy**

In `src/popup/popup.html`, replace the single Save button (lines 31-33):

```html
    <button id="nb-save-canvas" type="button" class="nb-btn">
      Save as HTML with comments
    </button>
```

with the dropdown:

```html
    <div class="nb-save-wrap">
      <button id="nb-save-btn" type="button" class="nb-btn nb-save-btn"
              aria-haspopup="menu" aria-expanded="false">
        Save<span class="nb-caret" aria-hidden="true">▾</span>
      </button>
      <div id="nb-save-menu" class="nb-save-menu" role="menu" aria-label="Save options" hidden>
        <button type="button" class="nb-menu-item" data-save="comments" role="menuitem">HTML · with comments</button>
        <button type="button" class="nb-menu-item" data-save="clean" role="menuitem">HTML · clean copy</button>
        <button type="button" class="nb-menu-item" data-save="pdf" role="menuitem">PDF/Print</button>
      </div>
    </div>
```

Then add the shared module before `popup.js`. Replace (line 44):

```html
  <script src="popup.js"></script>
```

with:

```html
  <script src="../content/origin-policy.js"></script>
  <script src="popup.js"></script>
```

- [ ] **Step 2: Style the dropdown**

In `src/popup/popup.css`, append:

```css
/* --- Save dropdown ------------------------------------------------------- */
.nb-save-wrap { position: relative; }

.nb-save-btn { display: flex; align-items: center; justify-content: space-between; }
.nb-caret { margin-left: 6px; font-size: 10px; opacity: 0.8; }

.nb-save-menu {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--nb-border);
  border-radius: 6px;
  overflow: hidden;
}
.nb-save-menu[hidden] { display: none; }

.nb-menu-item {
  padding: 8px 10px;
  font: inherit;
  text-align: left;
  background: #fff;
  border: none;
  border-bottom: 1px solid var(--nb-border);
  cursor: pointer;
  color: var(--nb-fg);
}
.nb-menu-item:last-child { border-bottom: none; }
.nb-menu-item:hover { background: #fffbeb; }
```

- [ ] **Step 3: Replace popup.js with dropdown-aware logic**

Replace the entire contents of `src/popup/popup.js` with the file below. (It keeps every existing behavior — onboarding, toggle, copy — and adds the Save dropdown. The settings/per-site code is added in Task 6; this version is complete and correct on its own.)

```js
/**
 * Noteback — popup.js  (toolbar popup logic)
 *
 * Wires the popup buttons to the active tab's content script / the service
 * worker, renders the file-URL onboarding card, and drives the Save dropdown.
 */
'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const byId = function (id) { return document.getElementById(id); };

  const btnToggle = byId('nb-toggle-sidebar');
  const btnCopy = byId('nb-copy-markdown');
  const saveBtn = byId('nb-save-btn');
  const saveMenu = byId('nb-save-menu');
  const onboardingEl = byId('nb-onboarding');
  const statusEl = byId('nb-status');

  let activeTab = null;

  init();

  function init() {
    getActiveTab()
      .then(function (tab) { activeTab = tab; return refreshState(tab); })
      .catch(function () {
        setStatus('Open a local HTML document to start annotating.');
        disableActions(true);
      });

    btnToggle.addEventListener('click', function () {
      runAction('NOTEBACK_TOGGLE_SIDEBAR', 'Toggling sidebar…', function () { window.close(); });
    });

    btnCopy.addEventListener('click', function () {
      runAction('NOTEBACK_COPY_MARKDOWN', 'Copying Markdown…', function (resp) {
        setStatus(resp && resp.ok ? 'Copied feedback as Markdown.' : 'Copy failed.');
      }, /*keepOpen*/ true);
    });

    saveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (saveMenu.hasAttribute('hidden')) openSaveMenu(); else closeSaveMenu();
    });
    saveMenu.addEventListener('click', function (e) {
      const item = e.target.closest('[data-save]');
      if (!item) return;
      closeSaveMenu();
      doSave(item.getAttribute('data-save'));
    });
    document.addEventListener('click', function () { closeSaveMenu(); });
  }

  /* --- save dropdown ----------------------------------------------------- */

  function openSaveMenu() { saveMenu.removeAttribute('hidden'); saveBtn.setAttribute('aria-expanded', 'true'); }
  function closeSaveMenu() { saveMenu.setAttribute('hidden', ''); saveBtn.setAttribute('aria-expanded', 'false'); }

  function doSave(kind) {
    const map = {
      comments: { type: 'NOTEBACK_SAVE_CANVAS', pending: 'Saving HTML with comments…' },
      clean: { type: 'NOTEBACK_SAVE_CLEAN', pending: 'Saving clean HTML…' },
      pdf: { type: 'NOTEBACK_SAVE_PDF', pending: 'Opening print…' }
    };
    const m = map[kind];
    if (!m) return;
    runAction(m.type, m.pending, function (resp) {
      setStatus(resp && resp.ok ? m.pending : 'Save failed.');
      if (resp && resp.ok && kind !== 'pdf') setTimeout(function () { window.close(); }, 600);
    }, /*keepOpen*/ true);
  }

  /* --- state ------------------------------------------------------------- */

  function refreshState(tab) {
    const url = (tab && tab.url) || '';
    const isFile = /^file:\/\//i.test(url);
    const isLocalHttp = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url);
    if (!(isFile || isLocalHttp)) {
      setStatus('Noteback works on local file:// and localhost documents.');
      disableActions(true);
      return Promise.resolve();
    }
    return ping(tab.id).then(function (pong) {
      if (pong && pong.booted) {
        disableActions(false);
        setStatus(countLabel(pong));
        hideOnboarding();
        return;
      }
      return handleNotBooted(isFile);
    }).catch(function () { return handleNotBooted(isFile); });
  }

  function handleNotBooted(isFile) {
    if (isFile) {
      return checkFileAccess().then(function (allowed) {
        if (!allowed) {
          showOnboarding();
          disableActions(true);
          setStatus('Action needed to annotate local files.');
        } else {
          disableActions(true);
          setStatus('Reload the page, then reopen Noteback.');
        }
      });
    }
    disableActions(true);
    setStatus('Reload the page, then reopen Noteback.');
    return Promise.resolve();
  }

  function countLabel(pong) {
    const title = (pong && pong.docTitle) || 'document';
    return 'Ready on “' + truncate(title, 28) + '”.';
  }

  /* --- actions ----------------------------------------------------------- */

  function runAction(type, pending, onDone, keepOpen) {
    if (!activeTab || activeTab.id == null) { setStatus('No active document.'); return; }
    setStatus(pending);
    sendToTab(activeTab.id, { type: type }).then(
      function (resp) { if (typeof onDone === 'function') onDone(resp); void keepOpen; },
      function (err) { setStatus('Could not reach the page. Reload and try again.'); void err; }
    );
  }

  function disableActions(disabled) {
    [btnToggle, btnCopy, saveBtn].forEach(function (b) { if (b) b.disabled = !!disabled; });
    if (disabled) closeSaveMenu();
  }

  /* --- onboarding card --------------------------------------------------- */

  function showOnboarding() {
    onboardingEl.hidden = false;
    onboardingEl.innerHTML =
      '<div class="nb-card">' +
      '  <div class="nb-card__title">Allow access to file URLs</div>' +
      '  <p class="nb-card__lead">To annotate local <code>file://</code> documents,' +
      '   enable Noteback on its extension details page:</p>' +
      '  <ol class="nb-card__steps">' +
      '    <li>Open the extension details page (button below).</li>' +
      '    <li>Turn on <strong>“Allow access to file URLs.”</strong></li>' +
      '    <li>Reload your document tab.</li>' +
      '  </ol>' +
      '  <button id="nb-open-details" type="button" class="nb-btn nb-btn--primary">' +
      '    Open extension details' +
      '  </button>' +
      '  <p class="nb-card__note">Serving docs from <code>localhost</code> or' +
      '   <code>127.0.0.1</code> needs no toggle.</p>' +
      '</div>';
    const openBtn = document.getElementById('nb-open-details');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        sendToWorker({ type: 'NOTEBACK_OPEN_EXTENSION_DETAILS' }).then(
          function () { window.close(); },
          function () { setStatus('Could not open the details page.'); }
        );
      });
    }
  }

  function hideOnboarding() { onboardingEl.hidden = true; onboardingEl.innerHTML = ''; }

  /* --- messaging --------------------------------------------------------- */

  function ping(tabId) { return sendToTab(tabId, { type: 'NOTEBACK_PING' }); }

  function checkFileAccess() {
    return sendToWorker({ type: 'NOTEBACK_CHECK_FILE_ACCESS' })
      .then(function (resp) { return !!(resp && resp.allowed); })
      .catch(function () { return false; });
  }

  function getActiveTab() {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) { reject(new Error(err.message || String(err))); return; }
        const tab = tabs && tabs[0];
        if (!tab) { reject(new Error('no active tab')); return; }
        resolve(tab);
      });
    });
  }

  function sendToTab(tabId, message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.sendMessage(tabId, message, function (resp) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  function sendToWorker(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  /* --- misc -------------------------------------------------------------- */

  function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
});
```

- [ ] **Step 4: Manual verification**

1. `chrome://extensions` → reload Noteback.
2. Open `http://localhost:8000/examples/spec.html`, add a comment.
3. Click the toolbar icon → **Save ▾**. The menu shows three items.
4. **HTML · with comments** → downloads a canvas file. **HTML · clean copy** → downloads a bare doc. **PDF/Print** → opens the print dialog.
5. Toggle sidebar and Copy still work as before.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.js
git commit -m "popup: Save dropdown with the three sidebar export options

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Activation lifecycle in the content script (Feature 2 core)

**Files:**
- Modify: `manifest.json`
- Modify: `src/content/content-script.js`

- [ ] **Step 1: Load origin-policy before the content script**

In `manifest.json`, in `content_scripts[0].js`, add `"src/content/origin-policy.js"` immediately before `"src/content/content-script.js"` (it must load first so `NotebackRuntime.originPolicy` exists). The array becomes:

```json
        "src/adapters/chrome-storage-adapter.js",
        "src/content/origin-policy.js",
        "src/content/content-script.js"
```

(Do NOT add it to `web_accessible_resources` — the canvas never uses settings.)

- [ ] **Step 2: Replace the one-shot boot with a mount/unmount lifecycle**

In `src/content/content-script.js`, replace the `/* --- boot --- */` block (lines 102-120):

```js
  let controller = null;
  const ready = RT.boot
    .boot({
      root: document.body || document.documentElement,
      adapter: adapter,
      exporter: exporter,
      docId: docId,
      docTitle: docTitle
    })
    .then(function (c) {
      controller = c;
      return c;
    })
    .catch(function () {
      controller = null;
      return null;
    });
```

with:

```js
  /* --- activation lifecycle ----------------------------------------------- */

  const policy = RT.originPolicy || null;
  const SETTINGS_KEY = (policy && policy.SETTINGS_KEY) || 'nb:settings';
  const originType = policy ? policy.classifyOrigin(location) : 'other';
  const origin = policy ? policy.originOf(location) : location.origin;

  let controller = null;
  let active = false;
  let ready = Promise.resolve(null); // always resolves to the current controller (or null)

  function mount() {
    if (active) return ready;
    active = true;
    ready = RT.boot
      .boot({
        root: document.body || document.documentElement,
        adapter: adapter,
        exporter: exporter,
        docId: docId,
        docTitle: docTitle
      })
      .then(function (c) { controller = c; return c; })
      .catch(function () { controller = null; return null; });
    return ready;
  }

  function unmount() {
    if (!active) return;
    active = false;
    if (controller && typeof controller.destroy === 'function') {
      try { controller.destroy(); } catch (e) { /* ignore */ }
    }
    controller = null;
    ready = Promise.resolve(null);
  }

  function shouldActivate(settings) {
    if (!policy) return true; // fail open if the module is somehow missing
    return policy.isActive({ type: originType, origin: origin }, settings);
  }

  function applySettings(settings) {
    if (shouldActivate(settings)) mount();
    else unmount();
  }

  // Initial decision from stored settings.
  readSettings().then(applySettings);

  // React live to popup-driven changes (no page reload needed).
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      applySettings(changes[SETTINGS_KEY].newValue || null);
    });
  }

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(SETTINGS_KEY, function (items) {
          const err = chrome.runtime && chrome.runtime.lastError;
          resolve((!err && items && items[SETTINGS_KEY]) || null);
        });
      } catch (e) { resolve(null); }
    });
  }
```

- [ ] **Step 3: Extend the PING response with activation status**

In `src/content/content-script.js`, replace the `NOTEBACK_PING` case (lines 128-130):

```js
      case 'NOTEBACK_PING':
        sendResponse({ ok: true, booted: true, docId: docId, docTitle: docTitle });
        return false;
```

with:

```js
      case 'NOTEBACK_PING':
        sendResponse({
          ok: true,
          booted: active,
          dormant: !active,
          originType: originType,
          origin: origin,
          docId: docId,
          docTitle: docTitle
        });
        return false;
```

- [ ] **Step 4: Verify the suite still passes**

Run: `npm test`
Expected: all green (pure tests unaffected).

- [ ] **Step 5: Manual verification (storage-driven, no popup UI yet)**

1. `chrome://extensions` → reload Noteback. Open `http://localhost:8000/examples/spec.html`. The launcher appears (active by default).
2. Open the **service worker** console (the "Inspect views: service worker" link on the card) and run:

```js
chrome.storage.local.set({ 'nb:settings': { origins: { localhost: false } } })
```

   Expected: on the localhost tab the Noteback launcher/UI **disappears live** (no reload).
3. Re-enable:

```js
chrome.storage.local.set({ 'nb:settings': { origins: { localhost: true } } })
```

   Expected: the launcher comes back live. Any comment you made is still there.
4. Per-site:

```js
chrome.storage.local.set({ 'nb:settings': { disabledSites: ['http://localhost:8000'] } })
```

   Expected: dormant on `:8000` only; a doc served on a different port stays active.
5. Clean up: `chrome.storage.local.remove('nb:settings')` → back to all-active.

- [ ] **Step 6: Commit**

```bash
git add manifest.json src/content/content-script.js
git commit -m "content: per-origin activation lifecycle (mount/unmount, live storage sync)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Popup settings UI (gear + per-type + per-site)

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.css`
- Modify: `src/popup/popup.js`

- [ ] **Step 1: Add the gear, settings panel, and per-site row to the markup**

In `src/popup/popup.html`, replace the header (lines 20-22):

```html
  <header class="nb-popup__header">
    <h1 class="nb-popup__title">Noteback</h1>
  </header>
```

with:

```html
  <header class="nb-popup__header">
    <h1 class="nb-popup__title">Noteback</h1>
    <button id="nb-gear" type="button" class="nb-gear" aria-label="Settings" aria-expanded="false">⚙︎</button>
  </header>
```

Then, inside `<main class="nb-popup__body">`, add the per-site row immediately after the `.nb-save-wrap` div (before `</main>`):

```html
    <div id="nb-site-row" class="nb-site-row" hidden>
      <span class="nb-site-label">Active on <code id="nb-site-origin"></code></span>
      <label class="nb-switch">
        <input id="nb-site-toggle" type="checkbox" />
        <span class="nb-switch__slider"></span>
      </label>
      <span id="nb-site-hint" class="nb-site-hint" hidden></span>
    </div>
```

Then add the settings panel immediately after `</main>` (before the `#nb-onboarding` section):

```html
  <section id="nb-settings" class="nb-popup__settings" hidden>
    <div class="nb-settings__title">Run Noteback on…</div>
    <label class="nb-setting-row"><span>file://</span>
      <span class="nb-switch"><input id="nb-type-file" type="checkbox" /><span class="nb-switch__slider"></span></span>
    </label>
    <label class="nb-setting-row"><span>localhost</span>
      <span class="nb-switch"><input id="nb-type-localhost" type="checkbox" /><span class="nb-switch__slider"></span></span>
    </label>
    <label class="nb-setting-row"><span>127.0.0.1</span>
      <span class="nb-switch"><input id="nb-type-127" type="checkbox" /><span class="nb-switch__slider"></span></span>
    </label>
  </section>
```

- [ ] **Step 2: Style the header, gear, switches, site row, settings panel**

In `src/popup/popup.css`, replace the `.nb-popup__header` rule (lines 26-29):

```css
.nb-popup__header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--nb-border);
}
```

with:

```css
.nb-popup__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--nb-border);
}

.nb-gear {
  border: none;
  background: none;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  color: #666;
}
.nb-gear:hover { background: #f0f0f0; }
```

Then append to the end of `src/popup/popup.css`:

```css
/* --- toggle switch ------------------------------------------------------- */
.nb-switch { position: relative; display: inline-block; width: 34px; height: 20px; flex: none; }
.nb-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.nb-switch__slider {
  position: absolute; inset: 0; cursor: pointer;
  background: #ccc; border-radius: 20px; transition: background .15s;
}
.nb-switch__slider::before {
  content: ""; position: absolute; height: 16px; width: 16px; left: 2px; top: 2px;
  background: #fff; border-radius: 50%; transition: transform .15s;
}
.nb-switch input:checked + .nb-switch__slider { background: #2563eb; }
.nb-switch input:checked + .nb-switch__slider::before { transform: translateX(14px); }
.nb-switch input:disabled + .nb-switch__slider { opacity: 0.45; cursor: not-allowed; }

/* --- per-site row -------------------------------------------------------- */
.nb-site-row {
  display: flex; align-items: center; gap: 8px;
  margin-top: 4px; padding: 6px 2px;
  border-top: 1px solid var(--nb-border);
}
.nb-site-row[hidden] { display: none; }
.nb-site-label { flex: 1; font-size: 12px; color: #444; }
.nb-site-label code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; background: rgba(0,0,0,0.06); padding: 0 3px; border-radius: 3px;
}
.nb-site-hint { flex-basis: 100%; font-size: 11px; color: #92400e; }
.nb-site-hint[hidden] { display: none; }

/* --- settings panel ------------------------------------------------------ */
.nb-popup__settings { padding: 8px 12px 12px; border-top: 1px solid var(--nb-border); }
.nb-popup__settings[hidden] { display: none; }
.nb-settings__title { font-size: 12px; font-weight: 600; color: #444; margin-bottom: 6px; }
.nb-setting-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 0; font-size: 13px;
}
```

- [ ] **Step 3: Extend popup.js with settings + per-site logic**

Make four edits to `src/popup/popup.js` (the file from Task 4).

(a) Replace the element lookups block at the top of the `DOMContentLoaded` callback:

```js
  const byId = function (id) { return document.getElementById(id); };

  const btnToggle = byId('nb-toggle-sidebar');
  const btnCopy = byId('nb-copy-markdown');
  const saveBtn = byId('nb-save-btn');
  const saveMenu = byId('nb-save-menu');
  const onboardingEl = byId('nb-onboarding');
  const statusEl = byId('nb-status');

  let activeTab = null;
```

with:

```js
  const byId = function (id) { return document.getElementById(id); };
  const policy = (window.NotebackRuntime || {}).originPolicy || null;
  const SETTINGS_KEY = (policy && policy.SETTINGS_KEY) || 'nb:settings';

  const btnToggle = byId('nb-toggle-sidebar');
  const btnCopy = byId('nb-copy-markdown');
  const saveBtn = byId('nb-save-btn');
  const saveMenu = byId('nb-save-menu');
  const onboardingEl = byId('nb-onboarding');
  const statusEl = byId('nb-status');
  const gearBtn = byId('nb-gear');
  const settingsPanel = byId('nb-settings');
  const siteRow = byId('nb-site-row');
  const siteOriginEl = byId('nb-site-origin');
  const siteToggle = byId('nb-site-toggle');
  const siteHint = byId('nb-site-hint');
  const typeInputs = {
    file: byId('nb-type-file'),
    localhost: byId('nb-type-localhost'),
    '127.0.0.1': byId('nb-type-127')
  };

  let activeTab = null;
  let tabInfo = { type: 'other', origin: '' };
  let settings = null;
```

(b) Replace the `init()` function body's first statement and add the new listeners. Replace:

```js
  function init() {
    getActiveTab()
      .then(function (tab) { activeTab = tab; return refreshState(tab); })
      .catch(function () {
        setStatus('Open a local HTML document to start annotating.');
        disableActions(true);
      });
```

with:

```js
  function init() {
    getSettings().then(function (s) { settings = s; renderTypeSwitches(); });

    getActiveTab()
      .then(function (tab) { activeTab = tab; tabInfo = deriveTabInfo(tab); return refreshState(tab); })
      .catch(function () {
        setStatus('Open a local HTML document to start annotating.');
        disableActions(true);
      });

    gearBtn.addEventListener('click', function () {
      const opening = settingsPanel.hasAttribute('hidden');
      if (opening) { settingsPanel.removeAttribute('hidden'); gearBtn.setAttribute('aria-expanded', 'true'); }
      else { settingsPanel.setAttribute('hidden', ''); gearBtn.setAttribute('aria-expanded', 'false'); }
    });

    Object.keys(typeInputs).forEach(function (type) {
      const input = typeInputs[type];
      if (!input) return;
      input.addEventListener('change', function () {
        settings = withType(settings, type, input.checked);
        saveSettings(settings).then(function () { renderTypeSwitches(); refreshState(activeTab); });
      });
    });

    siteToggle.addEventListener('change', function () {
      if (!tabInfo || tabInfo.type === 'other') return;
      settings = withSite(settings, tabInfo.origin, siteToggle.checked);
      saveSettings(settings).then(function () { refreshState(activeTab); });
    });
```

(c) Replace the whole `refreshState` function:

```js
  function refreshState(tab) {
    const url = (tab && tab.url) || '';
    const isFile = /^file:\/\//i.test(url);
    const isLocalHttp = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url);
    if (!(isFile || isLocalHttp)) {
      setStatus('Noteback works on local file:// and localhost documents.');
      disableActions(true);
      return Promise.resolve();
    }
    return ping(tab.id).then(function (pong) {
      if (pong && pong.booted) {
        disableActions(false);
        setStatus(countLabel(pong));
        hideOnboarding();
        return;
      }
      return handleNotBooted(isFile);
    }).catch(function () { return handleNotBooted(isFile); });
  }
```

with:

```js
  function refreshState(tab) {
    if (!tab) return Promise.resolve();
    if (!tabInfo || tabInfo.type === 'other') {
      hideSiteRow();
      setStatus('Noteback works on local file:// and localhost documents.');
      disableActions(true);
      return Promise.resolve();
    }
    return ping(tab.id).then(function (pong) {
      // Content script is injected (PING answered).
      hideOnboarding();
      if (pong && pong.booted) {
        disableActions(false);
        showSiteRow(true);
        setStatus(countLabel(pong));
      } else {
        // Injected but dormant by settings.
        disableActions(true);
        showSiteRow(false);
        setStatus('Noteback is off on this site.');
      }
    }).catch(function () {
      // Not injected at all (file access off, or page still loading).
      hideSiteRow();
      return handleNotBooted(tabInfo.type === 'file');
    });
  }
```

(d) Add the settings/site helpers. Insert this block immediately before the `/* --- misc --- */` comment near the end of the file:

```js
  /* --- settings + per-origin --------------------------------------------- */

  function deriveTabInfo(tab) {
    const url = (tab && tab.url) || '';
    try {
      const u = new URL(url);
      const loc = { protocol: u.protocol, hostname: u.hostname, host: u.host, origin: u.origin };
      return {
        type: policy ? policy.classifyOrigin(loc) : 'other',
        origin: policy ? policy.originOf(loc) : u.origin
      };
    } catch (e) { return { type: 'other', origin: '' }; }
  }

  function typeOn(type) {
    const norm = policy ? policy.normalizeSettings(settings) : { origins: { file: true, localhost: true, '127.0.0.1': true } };
    return norm.origins[type] !== false;
  }

  function renderTypeSwitches() {
    const norm = policy ? policy.normalizeSettings(settings) : { origins: { file: true, localhost: true, '127.0.0.1': true } };
    if (typeInputs.file) typeInputs.file.checked = norm.origins.file;
    if (typeInputs.localhost) typeInputs.localhost.checked = norm.origins.localhost;
    if (typeInputs['127.0.0.1']) typeInputs['127.0.0.1'].checked = norm.origins['127.0.0.1'];
  }

  function showSiteRow(active) {
    if (!tabInfo || tabInfo.type === 'other') { hideSiteRow(); return; }
    siteRow.removeAttribute('hidden');
    siteOriginEl.textContent = tabInfo.origin;
    if (!typeOn(tabInfo.type)) {
      // Per-site can't override a type that's switched off.
      siteToggle.checked = false;
      siteToggle.disabled = true;
      siteHint.textContent = tabInfo.type + ' is off in settings';
      siteHint.hidden = false;
    } else {
      siteToggle.disabled = false;
      siteToggle.checked = !!active;
      siteHint.hidden = true;
      siteHint.textContent = '';
    }
  }

  function hideSiteRow() { siteRow.setAttribute('hidden', ''); }

  function withType(s, type, on) {
    const norm = policy ? policy.normalizeSettings(s) : { origins: { file: true, localhost: true, '127.0.0.1': true }, disabledSites: [] };
    norm.origins[type] = !!on;
    return norm;
  }

  function withSite(s, origin, on) {
    const norm = policy ? policy.normalizeSettings(s) : { origins: { file: true, localhost: true, '127.0.0.1': true }, disabledSites: [] };
    const list = norm.disabledSites.slice();
    const idx = list.indexOf(origin);
    if (on) { if (idx !== -1) list.splice(idx, 1); }   // enable site → remove from disabled
    else { if (idx === -1) list.push(origin); }        // disable site → add to disabled
    norm.disabledSites = list;
    return norm;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(SETTINGS_KEY, function (items) {
          const err = chrome.runtime && chrome.runtime.lastError;
          resolve((!err && items && items[SETTINGS_KEY]) || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function saveSettings(s) {
    return new Promise(function (resolve, reject) {
      const bag = {}; bag[SETTINGS_KEY] = s;
      try {
        chrome.storage.local.set(bag, function () {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }
```

- [ ] **Step 4: Manual verification (end-to-end)**

1. `chrome://extensions` → reload Noteback. Open `http://localhost:8000/examples/spec.html`.
2. Click the toolbar icon. The body shows **Active on `http://localhost:8000`** with the switch ON; status "Ready on …".
3. Flip the per-site switch OFF → the page's launcher disappears **live**; status flips to "Noteback is off on this site." Flip ON → it returns. Comments persist.
4. Click the **⚙︎** gear → the per-type panel appears. Turn **localhost** OFF → page goes dormant; reopen the popup → the per-site switch is disabled with hint "localhost is off in settings". Turn localhost back ON.
5. Open a `file://` doc with file access OFF → popup still shows the onboarding card (unchanged), not the dormant state.
6. Open a normal `https://` site → popup shows "works on local file:// and localhost documents", everything disabled, no site row.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.js
git commit -m "popup: settings gear with per-type switches + per-site activation toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Document the contract

**Files:**
- Modify: `CONTRACTS.md`

- [ ] **Step 1: Add a settings section**

In `CONTRACTS.md`, add a new subsection documenting the activation contract. Place it after the StorageAdapter/State sections (search for the storage-key convention `"noteback:" + docId` and add this after that subsection):

```markdown
### Settings: per-origin activation (extension mode only)

Stored in `chrome.storage.local` under the single key **`nb:settings`** (distinct
from per-document state keyed `"noteback:" + docId`). Shape:

```jsonc
{
  "version": 1,
  "origins": { "file": true, "localhost": true, "127.0.0.1": true },
  "disabledSites": []   // canonical origins, e.g. "http://localhost:3000"; "file://" for file pages
}
```

A missing/partial object reads as **all-on, nothing disabled** (current behavior;
zero migration). `src/content/origin-policy.js` is the single source of truth:

- `classifyOrigin(loc) -> 'file' | 'localhost' | '127.0.0.1' | 'other'`
- `originOf(loc) -> canonical origin` (`"file://"` for file pages)
- `isActive({type, origin}, settings)` — **active** iff `origins[type] !== false`
  **and** `origin ∉ disabledSites`. Per-type is the master gate; per-site only
  subtracts a single origin. `'other'` is never active.

**Active** → the content script mounts the overlay. **Dormant** → injected but
mounts nothing (no chip, launcher, or listeners); stored comments are untouched.
The content script re-evaluates live on `chrome.storage.onChanged`, so popup
toggles take effect without a page reload. `NOTEBACK_PING` reports
`{ booted, dormant, originType, origin }` so the popup distinguishes "off by
settings" from "no file access".

The embedded canvas is unaffected — it has no settings and always shows its UI.
```

- [ ] **Step 2: Commit**

```bash
git add CONTRACTS.md
git commit -m "docs: contract for nb:settings + per-origin activation predicate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` — all green (including `origin-policy.test.js`).
- [ ] Reload the extension; run the manual checks from Tasks 4 and 6 once more end to end.
- [ ] Confirm: turning a type off makes its pages dormant live; per-site off kills only that origin; comments always survive dormancy; the three popup Save options all download/print; the file-access onboarding card is unchanged.

## Self-review notes (coverage)

- Spec Feature 1 (popup Save dropdown) → Tasks 3, 4; clean-copy actually works → Task 2.
- Spec Feature 2 (activation): predicate + module → Task 1; live gating + PING fields → Task 5; gear/per-type/per-site/dormant body → Task 6; storage schema + contract → Task 7.
- Precedence (type-master/site-subtract), live apply, per-site-when-type-off hint, default-all-on — all covered and tested (`origin-policy.test.js`) or manually verified.
