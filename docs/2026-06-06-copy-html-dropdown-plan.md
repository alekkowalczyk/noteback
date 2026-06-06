# Copy-html split-dropdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ▾ split-dropdown beside "Copy feedback" (in both the sidebar and the popup) offering "Copy html (with feedback)" and "Copy html (clean)", which put the same bytes as the Save menu's two HTML artifacts onto the clipboard. Also enhance the noteback skill to offer opening the wrapped canvas in the browser.

**Architecture:** Reuse the existing HTML builders, redirect them to the clipboard. One mode-agnostic hook `exporter.onCopyHtml(state, {clean}) → Promise<string>` drives the sidebar (overlay does the clipboard write); the popup sends `NOTEBACK_COPY_HTML {clean}` to the content script. The only new plumbing is a worker `NOTEBACK_BUILD_CANVAS` that returns the assembled canvas string (extension mode); canvas mode builds in-page already.

**Tech Stack:** Vanilla JS, MV3 Chrome extension, no build step, zero runtime deps. Tests: Node built-in runner via `npm run test:unit` (149 tests; `npm test` additionally runs a Playwright e2e for an unrelated feature that needs chromium — use `test:unit` as the guard).

**Spec:** `docs/2026-06-06-copy-html-dropdown.md`

**Testing reality:** No new pure logic — the pure `exporter.buildCanvasHtml` is reused unchanged (covered by `test/exporter.test.js`) and the worker refactor is extract-only. The rest is chrome/DOM glue (no Node-testable seam), verified live in Task 8. `npm run test:unit` is the regression guard after every code task; `node --check <file>` confirms a file still parses.

**Sidebar footer note:** `.nb-foot` is `display:flex; flex-direction:column` — so "Copy feedback" and "Save ▾" are **stacked full-width rows**, not side-by-side. The new split button is a full-width row: `[ Copy feedback │▾ ]` with the main button (`flex:1`) glued to a small caret button; the menu grows upward (reusing `.nb-menu`).

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/background/service-worker.js` | modify | Extract `assembleCanvasHtml()`; add `NOTEBACK_BUILD_CANVAS` returning the string. |
| `src/content/content-script.js` | modify | `onCopyHtml` hook (clean in-page / canvas via worker) + `NOTEBACK_COPY_HTML` handler. |
| `src/runtime/overlay.js` | modify | Split-button markup, copy-menu CSS, open/close (mirror Save), handlers, mutual close, listeners + teardown, `copyHtml`. |
| `src/canvas/exporter.js` | modify | Add `onCopyHtml` to the inlined `exporterHooks`. |
| `src/popup/popup.html` / `popup.js` / `popup.css` | modify | Split button + dropdown beside `#nb-copy-markdown`. |
| `CONTRACTS.md` | modify | Document `onCopyHtml` + the Copy ▾ menu mapping. |
| `skills/noteback/SKILL.md` | modify | Offer to open the canvas in the browser + reaffirm paste-back loop. |

Dependency order: worker (T1) → content-script (T2) → overlay (T3) → exporter (T4) → popup (T5) → CONTRACTS (T6) → SKILL (T7) → live verify (T8).

---

## Task 1: Service worker — `assembleCanvasHtml()` + `NOTEBACK_BUILD_CANVAS`

**Files:** Modify `src/background/service-worker.js`

- [ ] **Step 1: Extract the assembler from `exportCanvas`**

Find the current `exportCanvas` function:

```js
function exportCanvas(input) {
  input = input || {};
  const exporter = getExporter();
  if (!exporter || typeof exporter.buildCanvasHtml !== 'function') {
    return Promise.reject(new Error('exporter unavailable in service worker'));
  }

  return Promise.all([fetchInlinedRuntime(), fetchTemplate()]).then(function (parts) {
    const inlinedRuntime = parts[0];
    const templateHtml = parts[1];

    const html = exporter.buildCanvasHtml({
      docHtml: input.docHtml || '',
      state: input.state || { schemaVersion: 1, docId: input.docId || '', docTitle: input.docTitle || 'document', comments: [] },
      templateHtml: templateHtml,
      inlinedRuntime: inlinedRuntime
    });

    const filename = suggestedFilename(input.docTitle, input.docId);
    return triggerDownload(html, filename);
  });
}
```

Replace it with these two functions:

```js
/**
 * Assemble the self-contained feedback canvas HTML for a document (no download).
 * Shared by the download path (exportCanvas) and the copy path
 * (NOTEBACK_BUILD_CANVAS → clipboard in the page).
 * @param {{docId:string, docTitle:string, docHtml:string, state:Object}} input
 * @returns {Promise<string>} the assembled canvas HTML.
 */
function assembleCanvasHtml(input) {
  input = input || {};
  const exporter = getExporter();
  if (!exporter || typeof exporter.buildCanvasHtml !== 'function') {
    return Promise.reject(new Error('exporter unavailable in service worker'));
  }
  return Promise.all([fetchInlinedRuntime(), fetchTemplate()]).then(function (parts) {
    const inlinedRuntime = parts[0];
    const templateHtml = parts[1];
    return exporter.buildCanvasHtml({
      docHtml: input.docHtml || '',
      state: input.state || { schemaVersion: 1, docId: input.docId || '', docTitle: input.docTitle || 'document', comments: [] },
      templateHtml: templateHtml,
      inlinedRuntime: inlinedRuntime
    });
  });
}

/**
 * Assemble the canvas and download it.
 * @param {{docId:string, docTitle:string, docHtml:string, state:Object}} input
 * @returns {Promise<number>} the downloads API download id.
 */
function exportCanvas(input) {
  input = input || {};
  return assembleCanvasHtml(input).then(function (html) {
    const filename = suggestedFilename(input.docTitle, input.docId);
    return triggerDownload(html, filename);
  });
}
```

- [ ] **Step 2: Add the `NOTEBACK_BUILD_CANVAS` message case**

In the `chrome.runtime.onMessage.addListener` switch, immediately AFTER the `case 'NOTEBACK_EXPORT_CANVAS':` block (the one ending with `return true; // async response`), insert:

```js
    case 'NOTEBACK_BUILD_CANVAS':
      // Like EXPORT_CANVAS but returns the assembled HTML string instead of
      // downloading it — the content script writes it to the clipboard.
      assembleCanvasHtml({
        docId: msg.docId,
        docTitle: msg.docTitle,
        docHtml: msg.docHtml,
        state: msg.state
      }).then(
        function (html) { sendResponse({ ok: true, html: html }); },
        function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
      );
      return true; // async response
```

- [ ] **Step 3: Update the file header comment**

In the top comment block, find the line describing the export responsibility (it mentions `NOTEBACK_EXPORT_CANVAS`). After that responsibility bullet, add a short note so the header stays accurate:

```js
 *   - "Build canvas string" (NOTEBACK_BUILD_CANVAS): same assembly as the export
 *     path, but returns the HTML to the caller (for clipboard) instead of
 *     triggering a download.
```

- [ ] **Step 4: Verify parse + regression**

Run: `node --check src/background/service-worker.js`
Expected: exit 0, no output.

Run: `npm run test:unit`
Expected: 149 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat(worker): assembleCanvasHtml() + NOTEBACK_BUILD_CANVAS (return string)

Extract the canvas assembly so download (exportCanvas) and the new
copy-to-clipboard path share one builder; the new message returns the
assembled HTML instead of downloading.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Content script — `onCopyHtml` hook + `NOTEBACK_COPY_HTML`

**Files:** Modify `src/content/content-script.js`

- [ ] **Step 1: Add the `onCopyHtml` builder**

Find the `onSaveClean` function (it ends with the `}` before `const exporter = {`). Immediately AFTER `onSaveClean` and BEFORE `const exporter = {`, insert:

```js
  /**
   * Build the requested HTML for the clipboard (shared by the sidebar's
   * onCopyHtml hook and the popup's NOTEBACK_COPY_HTML message). Clean HTML is
   * built in-page; the with-feedback canvas is assembled by the service worker
   * (only it can fetch the runtime files) and returned as a string. The caller
   * writes the result to the clipboard.
   * @param {Object} state
   * @param {{clean?:boolean}} [opts]
   * @returns {Promise<string>}
   */
  function onCopyHtml(state, opts) {
    if (opts && opts.clean) {
      return Promise.resolve('<!DOCTYPE html>\n' + docContentHtml());
    }
    return sendToWorker({
      type: 'NOTEBACK_BUILD_CANVAS',
      docId: docId,
      docTitle: docTitle,
      docHtml: collectDocHtml(),
      state: state
    }).then(function (resp) {
      if (resp && resp.ok && typeof resp.html === 'string') return resp.html;
      throw new Error((resp && resp.error) || 'canvas build failed');
    });
  }
```

- [ ] **Step 2: Register the hook on the exporter object**

Find:

```js
  const exporter = {
    onCopyMarkdown: onCopyMarkdown,
    onSaveCanvas: onSaveCanvas,
    onSaveClean: onSaveClean
  };
```

Replace with:

```js
  const exporter = {
    onCopyMarkdown: onCopyMarkdown,
    onCopyHtml: onCopyHtml,
    onSaveCanvas: onSaveCanvas,
    onSaveClean: onSaveClean
  };
```

- [ ] **Step 3: Add the `NOTEBACK_COPY_HTML` message handler**

In the `chrome.runtime.onMessage.addListener` switch, find the `case 'NOTEBACK_COPY_MARKDOWN':` block (it ends with `return true;`). Immediately AFTER it, insert:

```js
      case 'NOTEBACK_COPY_HTML':
        ready.then(function (c) {
          const state = c ? c.getState() : null;
          onCopyHtml(state, { clean: !!msg.clean })
            .then(function (html) { return copyToClipboard(html); })
            .then(function (ok) {
              if (!ok) throw new Error('clipboard write failed');
              sendResponse({ ok: true });
            })
            .catch(function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); });
        });
        return true;
```

- [ ] **Step 4: Update the header message-protocol comment**

In the top comment block, find the inbound message list line:

```js
 *   { type: 'NOTEBACK_COPY_MARKDOWN' }   -> { ok:true, markdown } (also copies)
```

Immediately after it, add:

```js
 *   { type: 'NOTEBACK_COPY_HTML', clean } -> { ok:true } (builds + copies HTML)
```

And find the outbound line:

```js
 *   { type: 'NOTEBACK_EXPORT_CANVAS', docId, docTitle, docHtml, state }
```

Immediately after it, add:

```js
 *   { type: 'NOTEBACK_BUILD_CANVAS', docId, docTitle, docHtml, state } -> { ok, html }
```

- [ ] **Step 5: Verify parse + regression**

Run: `node --check src/content/content-script.js`
Expected: exit 0.

Run: `npm run test:unit`
Expected: 149 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/content/content-script.js
git commit -m "feat(content): onCopyHtml hook + NOTEBACK_COPY_HTML message

Clean HTML built in-page; with-feedback canvas assembled via the worker
(NOTEBACK_BUILD_CANVAS). Both the sidebar hook and the popup message
funnel through one builder; the page does the clipboard write.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Overlay — split button, copy menu, handlers

**Files:** Modify `src/runtime/overlay.js`

- [ ] **Step 1: Footer markup — wrap copy in a split button**

Find:

```js
      '<div class="nb-foot">' +
      '  <button type="button" class="nb-btn nb-secondary nb-copy">Copy feedback</button>' +
      '  <div class="nb-save-wrap">' +
```

Replace with:

```js
      '<div class="nb-foot">' +
      '  <div class="nb-copy-wrap">' +
      '    <button type="button" class="nb-btn nb-secondary nb-copy">Copy feedback</button>' +
      '    <button type="button" class="nb-btn nb-secondary nb-copy-caret-btn" aria-haspopup="menu" aria-expanded="false" aria-label="More copy options"><span class="nb-caret" aria-hidden="true">▾</span></button>' +
      '    <div class="nb-copy-menu nb-menu" role="menu" aria-label="Copy options">' +
      '      <button type="button" class="nb-menu-item nb-copy-canvas" role="menuitem">' +
      '        <span class="nb-mi-label">Copy html (with feedback)</span>' +
      '        <span class="nb-mi-sub">re-openable canvas</span></button>' +
      '      <div class="nb-menu-sep" role="none"></div>' +
      '      <button type="button" class="nb-menu-item nb-copy-clean" role="menuitem">' +
      '        <span class="nb-mi-label">Copy html (clean)</span>' +
      '        <span class="nb-mi-sub">the original, no Noteback</span></button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="nb-save-wrap">' +
```

- [ ] **Step 2: Add copy-menu CSS**

Find the save-menu CSS line:

```js
    '.nb-menu-sep{height:1px;background:var(--nb-line);margin:4px 9px;}',
```

Immediately after it, insert:

```js
    /* copy split-button — main keeps its action; the caret opens this menu */
    '.nb-copy-wrap{position:relative;display:flex;}',
    '.nb-copy-wrap .nb-copy{flex:1;border-top-right-radius:0;border-bottom-right-radius:0;}',
    '.nb-copy-caret-btn{flex:none;padding:0 10px;border-left:none;border-top-left-radius:0;border-bottom-left-radius:0;}',
    '.nb-copy-caret-btn .nb-caret{font-size:10px;line-height:1;opacity:.85;transition:transform .18s var(--dropdown-ease);}',
    '.nb-copy-wrap.nb-menu-open .nb-copy-caret-btn .nb-caret{transform:rotate(180deg);}',
```

- [ ] **Step 3: Capture copy-menu element refs**

Find:

```js
    const saveWrap = sidebar.querySelector('.nb-save-wrap');
    const saveBtn = sidebar.querySelector('.nb-save-btn');
    const saveMenu = sidebar.querySelector('.nb-menu');
```

Immediately after, insert:

```js
    const copyWrap = sidebar.querySelector('.nb-copy-wrap');
    const copyCaretBtn = sidebar.querySelector('.nb-copy-caret-btn');
    const copyMenu = sidebar.querySelector('.nb-copy-menu');
```

- [ ] **Step 4: Wire the caret + menu items**

Find:

```js
    sidebar.querySelector('.nb-copy').addEventListener('click', copyMarkdown);
```

Immediately after, insert:

```js
    copyCaretBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleCopyMenu(); });
    sidebar.querySelector('.nb-copy-canvas').addEventListener('click', function () { closeCopyMenu(); copyHtmlCanvas(); });
    sidebar.querySelector('.nb-copy-clean').addEventListener('click', function () { closeCopyMenu(); copyHtmlClean(); });
```

- [ ] **Step 5: Add the copy functions next to `copyMarkdown`**

Find the end of `copyMarkdown` (the line `    }` closing it, right before `    async function saveCanvas() {`). Immediately AFTER `copyMarkdown`'s closing brace and BEFORE `async function saveCanvas()`, insert:

```js
    function copyHtmlCanvas() { return copyHtml(false); }
    function copyHtmlClean() { return copyHtml(true); }

    // "Copy html" — the same artifacts as the Save menu, to the clipboard.
    // The hook returns the HTML string; we do the clipboard write here so both
    // runtime modes share one path (incl. the file:// execCommand fallback).
    async function copyHtml(clean) {
      const s = getState();
      if (exporter && typeof exporter.onCopyHtml === 'function') {
        try {
          const html = await exporter.onCopyHtml(s, { clean: clean });
          const ok = await copyToClipboard(html);
          if (ok) toast(clean ? 'Copied clean HTML' : 'Copied HTML with feedback', { success: true });
          else toast('Copy failed — select & copy manually');
        } catch (e) {
          toast('Copy failed');
        }
        return;
      }
      toast(clean ? 'Clean HTML copy needs the extension or saved canvas.'
                  : 'HTML copy needs the extension or saved canvas.');
    }
```

- [ ] **Step 6: Add copy-menu open/close (mirror the save menu) + mutual exclusivity**

Find the `toggleSaveMenu` function:

```js
    function toggleSaveMenu() {
      if (saveMenuOpen) closeSaveMenu();
      else openSaveMenu();
    }
```

Immediately AFTER it, insert:

```js
    let copyMenuOpen = false;
    let copyMenuCloseTimer = null;

    function openCopyMenu() {
      if (copyMenuOpen) return;
      closeSaveMenu();           // the two footer menus are mutually exclusive
      copyMenuOpen = true;
      if (copyMenuCloseTimer) {
        (win && win.clearTimeout ? win.clearTimeout : clearTimeout)(copyMenuCloseTimer);
        copyMenuCloseTimer = null;
      }
      copyMenu.classList.remove('is-closing');
      copyWrap.classList.add('nb-menu-open');
      copyCaretBtn.setAttribute('aria-expanded', 'true');
      void copyMenu.offsetWidth; // reflow so the closed scale applies before growing
      copyMenu.classList.add('is-open');
    }

    function closeCopyMenu() {
      if (!copyMenuOpen) return;
      copyMenuOpen = false;
      copyWrap.classList.remove('nb-menu-open');
      copyCaretBtn.setAttribute('aria-expanded', 'false');
      copyMenu.classList.remove('is-open');
      copyMenu.classList.add('is-closing');
      const settle = function () { copyMenu.classList.remove('is-closing'); copyMenuCloseTimer = null; };
      const ms = reduceMotion() ? 0 : POPOVER_CLOSE_MS;
      if (ms && win && win.setTimeout) copyMenuCloseTimer = win.setTimeout(settle, ms);
      else settle();
    }

    function toggleCopyMenu() {
      if (copyMenuOpen) closeCopyMenu();
      else openCopyMenu();
    }
```

- [ ] **Step 7: Make opening the save menu close the copy menu**

Find `openSaveMenu`'s first lines:

```js
    function openSaveMenu() {
      if (saveMenuOpen) return;
      saveMenuOpen = true;
```

Replace with:

```js
    function openSaveMenu() {
      if (saveMenuOpen) return;
      closeCopyMenu();           // the two footer menus are mutually exclusive
      saveMenuOpen = true;
```

- [ ] **Step 8: Close the copy menu when the sidebar closes**

Find:

```js
    function closeSidebar() {
      closeSaveMenu();
```

Replace with:

```js
    function closeSidebar() {
      closeSaveMenu();
      closeCopyMenu();
```

- [ ] **Step 9: Outside-click + Escape for the copy menu**

Find:

```js
    doc.addEventListener('click', onDocClickSaveMenu);
    doc.addEventListener('keydown', onDocKeydownSaveMenu);
```

Immediately BEFORE those two lines, insert:

```js
    // The copy menu closes on any click outside its wrapper; the caret stops
    // propagation so its own toggle click never reaches here.
    const onDocClickCopyMenu = function (e) {
      if (!copyMenuOpen) return;
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      if (path.indexOf(copyWrap) !== -1) return;
      closeCopyMenu();
    };
    const onDocKeydownCopyMenu = function (e) {
      if (e.key === 'Escape' && copyMenuOpen) {
        closeCopyMenu();
        if (copyCaretBtn && copyCaretBtn.focus) copyCaretBtn.focus();
      }
    };
    doc.addEventListener('click', onDocClickCopyMenu);
    doc.addEventListener('keydown', onDocKeydownCopyMenu);
```

- [ ] **Step 10: Tear down the copy-menu listeners in `destroy`**

Find:

```js
      doc.removeEventListener('click', onDocClickSaveMenu);
      doc.removeEventListener('keydown', onDocKeydownSaveMenu);
```

Immediately after, insert:

```js
      doc.removeEventListener('click', onDocClickCopyMenu);
      doc.removeEventListener('keydown', onDocKeydownCopyMenu);
```

- [ ] **Step 11: Verify parse + regression**

Run: `node --check src/runtime/overlay.js`
Expected: exit 0.

Run: `npm run test:unit`
Expected: 149 tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/runtime/overlay.js
git commit -m "feat(overlay): Copy ▾ split-dropdown (copy html with feedback / clean)

Main 'Copy feedback' keeps copying Markdown; a new caret opens a menu
that calls exporter.onCopyHtml and writes the returned HTML to the
clipboard. Mirrors the Save menu (open/close/outside-click/Escape) and
is mutually exclusive with it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Canvas exporter — `onCopyHtml` in the inlined hooks

**Files:** Modify `src/canvas/exporter.js`

- [ ] **Step 1: Add `onCopyHtml` to `exporterHooks`**

Find (inside the inlined boot-script string array):

```js
    '      onSaveClean: function () {',
    '        var html = rebuildCleanHtml();',
    '        var name = suggestedName();',
    '        if (exporterApi.saveCanvasInPlace) return exporterApi.saveCanvasInPlace(html, name);',
    '        if (exporterApi.downloadCanvas) return exporterApi.downloadCanvas(html, name);',
    '        return Promise.resolve();',
    '      }',
    '      // PDF needs no hook: the overlay falls back to window.print(), and the',
    '      // runtime @media print rules render the clean document.',
    '    };',
```

Replace with:

```js
    '      onSaveClean: function () {',
    '        var html = rebuildCleanHtml();',
    '        var name = suggestedName();',
    '        if (exporterApi.saveCanvasInPlace) return exporterApi.saveCanvasInPlace(html, name);',
    '        if (exporterApi.downloadCanvas) return exporterApi.downloadCanvas(html, name);',
    '        return Promise.resolve();',
    '      },',
    '      onCopyHtml: function (state, opts) {',
    '        var clean = !!(opts && opts.clean);',
    '        return Promise.resolve(clean ? rebuildCleanHtml() : rebuildHtml());',
    '      }',
    '      // PDF needs no hook: the overlay falls back to window.print(), and the',
    '      // runtime @media print rules render the clean document.',
    '    };',
```

(Note the added comma after `onSaveClean`'s closing `}`; `onCopyHtml` is now the last property and reuses the same `rebuildHtml`/`rebuildCleanHtml` helpers the save hooks use.)

- [ ] **Step 2: Verify parse + the inlined script is well-formed in a real canvas**

Run: `node --check src/canvas/exporter.js`
Expected: exit 0.

Run: `npm run test:unit`
Expected: 149 tests pass (incl. `test/exporter.test.js` covering the builder).

Run: `node bin/noteback.js wrap examples/spec.html -o /tmp/nb-copyhtml-check.canvas.html && grep -c "onCopyHtml" /tmp/nb-copyhtml-check.canvas.html`
Expected: prints `1` or more (the hook is inlined into the built canvas), and the wrap command exits 0 (proves the inlined boot script still assembles).

- [ ] **Step 3: Commit**

```bash
git add src/canvas/exporter.js
git commit -m "feat(canvas): onCopyHtml hook in the inlined exporter

Embedded canvas builds both copy variants in-page (rebuildHtml /
rebuildCleanHtml) and returns the string for the overlay to copy.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Popup — split button + dropdown

**Files:** Modify `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/popup.css`

- [ ] **Step 1: popup.html — wrap the copy button in a split control**

Find:

```html
    <button id="nb-copy-markdown" type="button" class="nb-btn">
      Copy feedback
    </button>
```

Replace with:

```html
    <div class="nb-copy-wrap">
      <button id="nb-copy-markdown" type="button" class="nb-btn nb-copy-main">
        Copy feedback
      </button>
      <button id="nb-copy-caret" type="button" class="nb-btn nb-copy-caret"
              aria-haspopup="menu" aria-expanded="false" aria-label="More copy options">
        <span class="nb-caret" aria-hidden="true">▾</span>
      </button>
      <div id="nb-copy-menu" class="nb-copy-menu" role="menu" aria-label="Copy options" hidden>
        <button type="button" class="nb-menu-item" data-copy="canvas" role="menuitem">Copy html (with feedback)</button>
        <button type="button" class="nb-menu-item" data-copy="clean" role="menuitem">Copy html (clean)</button>
      </div>
    </div>
```

- [ ] **Step 2: popup.css — split button + dropdown styles**

Find the Save-dropdown block opener:

```css
/* --- Save dropdown ------------------------------------------------------- */
.nb-save-wrap { position: relative; }
```

Immediately BEFORE that comment, insert:

```css
/* --- Copy split button + dropdown --------------------------------------- */
.nb-copy-wrap { position: relative; display: flex; }
.nb-copy-main { flex: 1; border-top-right-radius: 0; border-bottom-right-radius: 0; }
.nb-copy-caret {
  flex: none; width: auto; padding: 8px 10px;
  border-left: none; border-top-left-radius: 0; border-bottom-left-radius: 0;
}
.nb-copy-caret .nb-caret { font-size: 10px; opacity: 0.8; }
.nb-copy-menu {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 10;
  display: flex; flex-direction: column; background: #fff;
  border: 1px solid var(--nb-border); border-radius: 6px; overflow: hidden;
  box-shadow: 0 6px 18px rgba(0,0,0,0.12);
}
.nb-copy-menu[hidden] { display: none; }
```

(The menu items reuse the existing `.nb-menu-item` rules already defined for the Save menu.)

- [ ] **Step 3: popup.js — refs**

Find:

```js
  const btnCopy = byId('nb-copy-markdown');
```

Immediately after, insert:

```js
  const copyCaret = byId('nb-copy-caret');
  const copyMenu = byId('nb-copy-menu');
```

- [ ] **Step 4: popup.js — wire the caret + items (in `init`)**

Find the existing save-menu wiring in `init`:

```js
    saveMenu.addEventListener('click', function (e) {
      const item = e.target.closest('[data-save]');
      if (!item) return;
      closeSaveMenu();
      doSave(item.getAttribute('data-save'));
    });
    document.addEventListener('click', function () { closeSaveMenu(); });
```

Replace with:

```js
    saveMenu.addEventListener('click', function (e) {
      const item = e.target.closest('[data-save]');
      if (!item) return;
      closeSaveMenu();
      doSave(item.getAttribute('data-save'));
    });

    copyCaret.addEventListener('click', function (e) {
      e.stopPropagation();
      if (copyMenu.hasAttribute('hidden')) openCopyMenu(); else closeCopyMenu();
    });
    copyMenu.addEventListener('click', function (e) {
      const item = e.target.closest('[data-copy]');
      if (!item) return;
      closeCopyMenu();
      doCopyHtml(item.getAttribute('data-copy'));
    });
    document.addEventListener('click', function () { closeSaveMenu(); closeCopyMenu(); });
```

- [ ] **Step 5: popup.js — open/close + action helpers**

Find the save-dropdown helpers:

```js
  function openSaveMenu() { saveMenu.removeAttribute('hidden'); saveBtn.setAttribute('aria-expanded', 'true'); }
  function closeSaveMenu() { saveMenu.setAttribute('hidden', ''); saveBtn.setAttribute('aria-expanded', 'false'); }
```

Immediately after, insert:

```js
  function openCopyMenu() { closeSaveMenu(); copyMenu.removeAttribute('hidden'); copyCaret.setAttribute('aria-expanded', 'true'); }
  function closeCopyMenu() { copyMenu.setAttribute('hidden', ''); copyCaret.setAttribute('aria-expanded', 'false'); }

  function doCopyHtml(kind) {
    if (!activeTab || activeTab.id == null) { setStatus('No active document.'); return; }
    const clean = (kind === 'clean');
    setStatus(clean ? 'Copying clean HTML…' : 'Copying HTML with feedback…');
    sendToTab(activeTab.id, { type: 'NOTEBACK_COPY_HTML', clean: clean }).then(
      function (resp) { setStatus(resp && resp.ok ? (clean ? 'Copied clean HTML.' : 'Copied HTML with feedback.') : 'Copy failed.'); },
      function () { setStatus('Could not reach the page. Reload and try again.'); }
    );
  }
```

Also make `openSaveMenu` close the copy menu, so the two are mutually exclusive. Replace:

```js
  function openSaveMenu() { saveMenu.removeAttribute('hidden'); saveBtn.setAttribute('aria-expanded', 'true'); }
```

with:

```js
  function openSaveMenu() { closeCopyMenu(); saveMenu.removeAttribute('hidden'); saveBtn.setAttribute('aria-expanded', 'true'); }
```

- [ ] **Step 6: popup.js — disable the caret with the other actions**

Find:

```js
  function disableActions(disabled) {
    [btnToggle, btnCopy, saveBtn].forEach(function (b) { if (b) b.disabled = !!disabled; });
    if (disabled) closeSaveMenu();
  }
```

Replace with:

```js
  function disableActions(disabled) {
    [btnToggle, btnCopy, copyCaret, saveBtn].forEach(function (b) { if (b) b.disabled = !!disabled; });
    if (disabled) { closeSaveMenu(); closeCopyMenu(); }
  }
```

- [ ] **Step 7: Verify parse + regression**

Run: `node --check src/popup/popup.js`
Expected: exit 0.

Run: `npm run test:unit`
Expected: 149 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.js
git commit -m "feat(popup): Copy ▾ split-dropdown (copy html with feedback / clean)

Caret beside 'Copy feedback' opens a menu whose items send
NOTEBACK_COPY_HTML to the content script; mutually exclusive with Save ▾
and disabled with the other actions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: CONTRACTS.md — document `onCopyHtml`

**Files:** Modify `CONTRACTS.md`

- [ ] **Step 1: Add `onCopyHtml` to the ExporterHooks typedef**

Find:

```
 * @property {(state: State) => void|Promise<void>}   [onCopyMarkdown] Copy feedback as Markdown.
```

Immediately after it, insert:

```
 * @property {(state: State, opts: {clean?: boolean}) => Promise<string>} [onCopyHtml] Build HTML for the clipboard — the clean document (clean:true) or the full feedback canvas (clean:false). Returns the string; the overlay/popup writes it to the clipboard.
```

- [ ] **Step 2: Document the Copy ▾ menu mapping**

Find:

```
Footer **Save…** menu → hooks: *HTML · with comments* → `onSaveCanvas`,
*HTML · clean copy* → `onSaveClean`, *PDF/Print* → `onSavePdf` (default `window.print()`).
```

Immediately after that sentence (before the "PDF cleanliness…" sentence), insert:

```
Footer **Copy ▾** menu → `onCopyHtml`: *Copy html (with feedback)* →
`onCopyHtml(state, {clean:false})` (same bytes as `onSaveCanvas`), *Copy html
(clean)* → `onCopyHtml(state, {clean:true})` (same bytes as `onSaveClean`). The
main "Copy feedback" button still uses `onCopyMarkdown`. In extension mode the
with-feedback variant is assembled by the service worker (`NOTEBACK_BUILD_CANVAS`)
and returned as a string; the page writes it to the clipboard.
```

- [ ] **Step 3: Note the embedded canvas supplies the hook**

Find:

```
the clean document without needing a hook. The embedded canvas supplies `onSaveCanvas`
+ `onSaveClean`; both serialize the live document
```

Replace `onSaveCanvas`\n`+ onSaveClean` with the three-hook list:

```
the clean document without needing a hook. The embedded canvas supplies `onSaveCanvas`,
`onSaveClean`, and `onCopyHtml`; the save hooks serialize the live document
```

- [ ] **Step 4: Commit**

```bash
git add CONTRACTS.md
git commit -m "docs(contracts): document onCopyHtml + the Copy ▾ menu mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: SKILL.md — offer to open the canvas + reaffirm paste-back

**Files:** Modify `skills/noteback/SKILL.md`

- [ ] **Step 1: Insert the "offer to open it" guidance**

Find the end of the "Tell the user (after wrapping)" section:

```markdown
Adjust the filename, but keep the three beats: *open it · comment · copy the markdown
back to me*.
```

Immediately AFTER that line (it is followed by a blank line and then `## Closing the loop`), insert:

```markdown

**Offer to open it — don't make them hunt for the file.** After wrapping, ask
whether you should open it in their browser right now rather than assuming they'll
locate and open it, e.g. *"Want me to open it in your browser now?"* If they say
yes, open it with the platform opener (`open <file>` on macOS, `xdg-open <file>` on
Linux, `start "" <file>` on Windows). And in a line, remind them the loop is
paste-based: they can click **Copy feedback** and paste it **straight back into
this chat** — no need to save or send a file.
```

- [ ] **Step 2: Sanity-check the section reads well**

Run: `sed -n '77,96p' skills/noteback/SKILL.md`
Expected: the new paragraph sits between the "Tell the user" message and the `## Closing the loop` heading, with blank-line separation.

- [ ] **Step 3: Commit**

```bash
git add skills/noteback/SKILL.md
git commit -m "skill: offer to open the wrapped canvas in the browser + reaffirm paste-back

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Live verification

No code; this proves the copy paths in **both** runtime modes and **both** UIs. Because Task 3/Task 4 edited `src/runtime/overlay.js` and `src/canvas/exporter.js`, the canvas must be **rebuilt + cache-busted** (CLAUDE.md). Reload the unpacked extension after the edits.

- [ ] **Step 1: Final unit regression**

Run: `npm run test:unit`
Expected: 149 tests pass.

- [ ] **Step 2: Rebuild the canvas**

```bash
cd /Users/aleksanderkowalczyk/a7/noteback
node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html
```
Expected: exit 0 (the file is gitignored; rebuilt each time).

- [ ] **Step 3: Reload the extension + serve**

`chrome://extensions` → reload Noteback. Then:
```bash
cd /Users/aleksanderkowalczyk/a7/noteback/examples
python3 -m http.server 8000
```

- [ ] **Step 4: Extension mode (sidebar) — `http://localhost:8000/spec.html`**

Open the sidebar. Click the **▾** beside "Copy feedback":
- **Copy html (with feedback)** → paste into a new `.html` file → it opens as a working canvas (highlight/comment UI boots). Toast: "Copied HTML with feedback".
- **Copy html (clean)** → paste → it's the original doc, no Noteback. Toast: "Copied clean HTML".
- Main **Copy feedback** still copies Markdown; **Save ▾** still works; opening one menu closes the other.

- [ ] **Step 5: Extension mode (popup) — same tab**

Open the toolbar popup → **▾** beside "Copy feedback" → both items copy; status confirms. Optionally compare bytes to the Save menu's downloads (should match the respective artifact).

- [ ] **Step 6: Canvas mode — `http://localhost:8000/spec.canvas.html?v=1`**

The embedded runtime boots (extension stands down via the boot guard). Open the sidebar → **▾** → both items copy **in-page** (no worker). Paste & verify the with-feedback paste re-opens as a canvas and the clean paste is Noteback-free.

- [ ] **Step 7: file:// fallback (optional)**

Open `examples/spec.canvas.html` via `file://` → copy both → confirm the `execCommand` clipboard fallback still copies (insecure context).

---

## Self-review notes (reconciled)

- **Footer is stacked, not side-by-side** — corrected here vs. the spec's illustrative ASCII; the feature is identical, the arrangement is dictated by existing `.nb-foot` CSS.
- **No `boot.js` change** — the popup goes through `NOTEBACK_COPY_HTML`; the sidebar calls `exporter.onCopyHtml` directly. The controller need not expose `copyHtml`.
- **Name consistency** — `onCopyHtml(state, {clean})`, `NOTEBACK_COPY_HTML {clean}`, `NOTEBACK_BUILD_CANVAS → {ok, html}`, `assembleCanvasHtml`, `.nb-copy-wrap`/`.nb-copy-caret-btn`/`.nb-copy-menu` (sidebar) and `#nb-copy-caret`/`#nb-copy-menu`/`.nb-copy-main` (popup) are used identically across tasks.
- **No new unit tests** — chrome/DOM glue; the reused pure builder stays covered by `test/exporter.test.js`. `npm run test:unit` guards regressions; Task 8 is the behavioral proof.
