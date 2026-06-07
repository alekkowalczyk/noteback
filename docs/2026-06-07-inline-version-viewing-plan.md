# Inline version viewing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken new-tab "checkout" of a past version (opaque `file://` blob origin → `localStorage` denied → empty sidebar) with an in-tab, read-only, side-by-side inline view whose sidebar shows the live timeline ("you are here", switch versions, back to current).

**Architecture:** Entirely within `src/runtime/overlay.js`. Inline viewing never leaves the tab, so the same-origin `localStorage`-backed `history` adapter stays reachable — no storage plumbing changes. A new in-tab `viewingKey` drives the timeline's "viewing"/"you are here" state (generalizing the old baked-attribute `checkoutCurrentKey`); the old peek modal becomes a side panel; the entire new-tab checkout (`openVersionTab`, `buildVersionCanvasHtml`, `data-noteback-checkout`, the chevron-menu "Open" item) is deleted.

**Tech Stack:** Zero-dependency vanilla JS runtime; Node built-in test runner for unit tests; Playwright (devDependency) for browser e2e. No build step.

**Design doc:** `docs/2026-06-07-inline-version-viewing-design.md`

---

## File structure

- **Modify** `src/runtime/overlay.js` — net deletion of the blob machinery; CSS side-panel + `nb-backbar` rename; `viewingKey`/`inlineView` state; `openVersionInline`/`closeVersionInline`; viewing-aware `renderVersions`/`renderNowRow`/`renderVersionRow`/`renderBackToCurrentBar`; menu "Open" removal.
- **Rewrite** `test/e2e/version-timeline.e2e.test.js` — inline flow (one page, no `window.open`/blob/re-serve).
- **Extend** `test/e2e/version-scoping-file.e2e.test.js` — add a `file://` inline-view regression test (the environment the old test sidestepped).
- **Update docs** `CLAUDE.md`, `CONTRACTS.md`, `docs/design.md`.

---

## Task 1: Rewrite the version-timeline e2e for the inline model (failing test)

**Files:**
- Test: `test/e2e/version-timeline.e2e.test.js` (full rewrite)

- [ ] **Step 1: Replace the whole test file with the inline-flow version**

Replace the entire contents of `test/e2e/version-timeline.e2e.test.js` with:

```javascript
'use strict';
/**
 * Browser e2e for the canvas version-timeline UI + INLINE version viewing
 * (docs/2026-06-07-inline-version-viewing-design.md).
 *
 * The history ENGINE is unit-tested (Node); this guards the OVERLAY DOM: the
 * "History" group, its rows, and the read-only INLINE view (a side panel beside
 * the sidebar). It drives real drag-select comments across three drafts (same
 * baked doc-id, changing visible text → new content hash each time), so two
 * EARLIER versions exist, then exercises: open a version inline, the sidebar
 * marks it "you are here" while staying visible, switch to another version, and
 * return to the current draft.
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
const DEBOUNCE_MS = 600; // comment chip is debounced ~340ms; wait comfortably past it

let browser, server, baseURL, canvasHtml, serveMode = 'd1';

before(async () => {
  const out = path.join(os.tmpdir(), 'noteback-vt-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Each serveMode rewrites the visible title → a new content hash under the same
    // baked doc-id, so prior drafts become earlier versions in one lineage.
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

/** Create a comment on the first long paragraph via a real drag-selection. */
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
  await page.waitForTimeout(500); // let async persist (snapshot compress + write) settle
}

/** Locate the version-view iframe + measure it (the panel lives in a shadow root). */
function readInlineFrame(page) {
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
    const mark = cd.querySelector('mark.noteback-highlight');
    const view = f.parentElement; // .nb-hist-view (view > backBar + frame)
    return {
      textLen: (cd.body.textContent || '').length,
      marks: cd.querySelectorAll('mark.noteback-highlight').length,
      frameH: Math.round(f.getBoundingClientRect().height),
      viewH: Math.round(view.getBoundingClientRect().height),
      markBg: mark ? f.contentWindow.getComputedStyle(mark).backgroundColor : null
    };
  });
}

test('inline version viewing: timeline rows, "you are here", switch versions, back to current', { timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // --- Draft 1: a real anchored comment carrying a </script> breakout payload ---
    serveMode = 'd1';
    await page.goto(baseURL + '?v=d1');
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);
    const D1_BODY = 'Draft-1 feedback note </script><img src=x onerror=alert(1)>';
    await createComment(page, D1_BODY);

    // --- Draft 2: same doc-id, new text → draft 1 becomes an earlier version ---
    serveMode = 'd2';
    await page.goto(baseURL + '?v=d2');
    await page.waitForTimeout(400);
    await createComment(page, 'Draft-2 feedback note');

    // --- Draft 3 (current): now TWO earlier versions exist (d1, d2) ---
    serveMode = 'd3';
    await page.goto(baseURL + '?v=d3');
    await page.waitForTimeout(400);
    await createComment(page, 'Comment on draft 3 (current)');
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);

    // The History group + label is present, docked at the bottom.
    const versions = page.locator('.nb-versions');
    assert.strictEqual(await versions.count(), 1, 'the History group is rendered');
    assert.strictEqual(((await versions.locator('.nb-group-label').first().textContent()) || '').trim(), 'History', 'the group carries the "History" label');
    assert.strictEqual(await page.locator('.nb-versions-dock .nb-versions').count(), 1, 'the timeline lives in the bottom versions dock');
    assert.strictEqual(await page.locator('.nb-list .nb-versions').count(), 0, 'the timeline is NOT inside the scrolling comment list');

    // Exactly one active "now" row (the live draft), no actions chevron, "you are here".
    assert.strictEqual(await page.locator('.nb-ver-row.active').count(), 1, 'exactly one active "now" row');
    assert.strictEqual(await page.locator('.nb-ver-row.active .nb-ver-menu-btn').count(), 0, 'the "now" row has no actions chevron');
    assert.strictEqual(((await page.locator('.nb-ver-row.active .nb-ver-here').first().textContent()) || '').trim(), 'you are here', 'the "now" row is "you are here" when not viewing');

    // The newest earlier version (v2) is shown inline; reveal the rest (v1) via disclosure.
    await page.locator('.nb-disclose').click();
    await page.waitForTimeout(200);
    const earlierRows = page.locator('.nb-ver-row[data-version-key]');
    assert.ok(await earlierRows.count() >= 2, 'two earlier-version rows are present (v1 + v2)');
    const v2key = await earlierRows.nth(0).getAttribute('data-version-key'); // newest earlier (inline)
    const v1key = await earlierRows.nth(1).getAttribute('data-version-key'); // oldest (under disclosure)
    assert.ok(v1key && v2key && v1key !== v2key, 'the two earlier versions have distinct keys');

    // The row body shows a pointer cursor (click-to-view).
    const cursor = await earlierRows.nth(0).locator('.nb-ver-line').first().evaluate((el) => getComputedStyle(el).cursor);
    assert.strictEqual(cursor, 'pointer', 'an earlier row shows a pointer cursor (click-to-view)');

    // --- Open v2 inline: side panel appears, sidebar STAYS visible, row "you are here". ---
    await earlierRows.nth(0).locator('.nb-ver-line').first().click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 1, 'clicking the row opens the inline version view');
    assert.strictEqual(await page.locator('.nb-hist-backdrop').count(), 0, 'the old centered modal is gone');
    assert.strictEqual(await page.locator('.nb-sidebar.nb-open').count(), 1, 'the sidebar stays open beside the inline view');

    // The viewed version is the active "viewing / you are here" row; "now" is no longer active.
    const viewingRow = page.locator('.nb-ver-row.active.nb-ver-viewing');
    assert.strictEqual(await viewingRow.count(), 1, 'the viewed version is the active "viewing" row');
    assert.strictEqual(await viewingRow.getAttribute('data-version-key'), v2key, 'the viewing row is v2 (the one clicked)');
    assert.strictEqual(((await viewingRow.locator('.nb-ver-here').first().textContent()) || '').trim(), 'you are here', 'the viewed version is marked "you are here"');
    assert.strictEqual(await page.locator('.nb-ver-row.active').count(), 1, 'still exactly one active row (now it is the viewed version)');

    // A "Back to current" bar is present.
    const backbar = page.locator('.nb-backbar');
    assert.strictEqual(await backbar.count(), 1, 'the "Back to current" bar is present while viewing');
    assert.ok(/Back to current/.test((await backbar.textContent()) || ''), 'the bar offers "Back to current"');

    // The iframe shows the snapshot, the live painter ran, and it FILLS the panel.
    const frame = await readInlineFrame(page);
    assert.ok(frame && frame.textLen > 0, 'the inline iframe shows the captured snapshot');
    assert.ok(frame.marks >= 1, 'the live painter wrapped the commented quote in a <mark.noteback-highlight> (got ' + (frame && frame.marks) + ')');
    assert.ok(frame.frameH >= frame.viewH * 0.8, 'the iframe fills the panel below the back bar (frame ' + frame.frameH + 'px of view ' + frame.viewH + 'px)');
    assert.strictEqual(frame.markBg, 'rgb(255, 231, 163)', 'the inline highlight uses the live honey styling (got ' + frame.markBg + ')');

    // Clicking a highlight shows the comment via textContent — and proves the </script>
    // payload was escaped (the popover script survived being inlined into the srcdoc).
    const popInfo = await page.evaluate(() => {
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
      const mark = cd.querySelector('mark.noteback-highlight[data-noteback-id]');
      if (!mark) return null;
      mark.click();
      const pop = cd.querySelector('.nb-peek-pop.nb-show');
      return {
        shown: !!pop,
        body: pop ? ((pop.querySelector('.nb-peek-pop-body') || {}).textContent || '') : null,
        liveImg: !!cd.querySelector('img[src="x"]')
      };
    });
    assert.ok(popInfo && popInfo.shown, 'clicking an inline highlight shows the comment popover');
    assert.strictEqual(popInfo.liveImg, false, 'the </script> payload did not become live markup inside the view');

    // --- Switch to ANOTHER version (v1) while viewing: the view + "you are here" move. ---
    // renderVersions rebuilt the dock when v2 opened, so the "+N older" disclosure is
    // collapsed again (.nb-ver-rest[hidden]) — re-expand to reach v1.
    await page.locator('.nb-disclose').click();
    await page.waitForTimeout(200);
    await page.locator('.nb-ver-row[data-version-key="' + v1key + '"]').locator('.nb-ver-line').first().click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 1, 'switching keeps a single inline view');
    const viewingRow2 = page.locator('.nb-ver-row.active.nb-ver-viewing');
    assert.strictEqual(await viewingRow2.getAttribute('data-version-key'), v1key, 'the viewing row switched to v1');

    // --- Back to current: the view closes and the live draft is restored. ---
    await page.locator('.nb-backbar').click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 0, '"Back to current" closes the inline view');
    assert.strictEqual(await page.locator('.nb-ver-row.nb-ver-viewing').count(), 0, 'no row is marked "viewing" after returning to current');
    assert.strictEqual(((await page.locator('.nb-ver-row.active .nb-ver-name').first().textContent()) || '').trim(), 'now', 'the active row is the live "now" draft again');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run the rewritten test to verify it FAILS**

Run: `npx playwright install chromium` (once, if not installed), then
`node --test test/e2e/version-timeline.e2e.test.js`
Expected: FAIL — the overlay still renders the old `.nb-hist-backdrop` modal (no `.nb-hist-view`), has no `.nb-backbar`, and the row still relabels the now-row "viewing" only in a baked checkout. Assertions like `.nb-hist-view count === 1` fail.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/e2e/version-timeline.e2e.test.js
git commit -m "test(e2e): rewrite version-timeline for inline (in-tab) viewing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement inline viewing in the overlay (make Task 1 pass)

**Files:**
- Modify: `src/runtime/overlay.js`

All edits below are in `src/runtime/overlay.js`. Apply them all, then run the test once and commit (the file must stay coherent — several edits are interdependent, e.g. removing `checkoutCurrentKey` and `openVersionTab` together).

- [ ] **Step 1: CSS — rename `.nb-checkout-*` → `.nb-backbar-*` and drop the unused `.nb-ver-current`**

Find (≈ lines 345–355):

```javascript
    /* checkout banner: this tab is an opened past version; click → open the live
       current draft in a new tab. Sits at the top of the versions dock. */
    '.nb-checkout-bar{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;',
    '  margin:2px 0 4px;padding:8px 11px;border:1px solid var(--nb-accent);border-radius:10px;',
    '  background:var(--nb-accent-wash);transition:background .14s ease,box-shadow .2s ease;}',
    '.nb-checkout-bar:hover{background:#dcebe8;box-shadow:0 6px 16px -12px rgba(15,98,89,.7);}',
    '.nb-checkout-txt{font:600 11.5px/1.3 var(--nb-ui);color:var(--nb-ink-soft);}',
    '.nb-checkout-cta{margin-left:auto;font:700 12px/1 var(--nb-round);color:var(--nb-accent-deep);white-space:nowrap;}',
    /* the "viewing" row (opened version, in checkout) and the "current" badge on the
       live draft’s row */
    '.nb-ver-current{color:var(--nb-ink-soft);}',
```

Replace with:

```javascript
    /* "Back to current" bar: shown atop the timeline while viewing an earlier
       version inline; one click returns to the live current draft. */
    '.nb-backbar{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;',
    '  margin:2px 0 4px;padding:8px 11px;border:1px solid var(--nb-accent);border-radius:10px;',
    '  background:var(--nb-accent-wash);transition:background .14s ease,box-shadow .2s ease;}',
    '.nb-backbar:hover{background:#dcebe8;box-shadow:0 6px 16px -12px rgba(15,98,89,.7);}',
    '.nb-backbar-txt{font:600 11.5px/1.3 var(--nb-ui);color:var(--nb-ink-soft);}',
    '.nb-backbar-cta{margin-left:auto;font:700 12px/1 var(--nb-round);color:var(--nb-accent-deep);white-space:nowrap;}',
```

- [ ] **Step 2: CSS — turn the centered peek modal into a side panel beside the sidebar**

Find (≈ lines 362–372):

```javascript
    '.nb-hist-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
    '.nb-hist-panel{position:relative;width:min(820px,92vw);height:min(80vh,720px);background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);}',
    '.nb-hist-back{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;align-items:center;gap:6px;',
    '  border:none;border-bottom:1px solid var(--nb-line);background:var(--nb-accent-wash);color:var(--nb-accent-deep);',
    '  font:700 12px/1 var(--nb-round);letter-spacing:.01em;padding:11px 14px;cursor:pointer;text-align:left;',
    '  transition:background .14s ease,color .14s ease;}',
    '.nb-hist-back:hover{background:var(--nb-accent);color:#fffdf8;}',
    // The iframe is a REPLACED element: top+bottom+height:auto does NOT stretch it
    // (it falls back to the intrinsic ~150px, leaving the doc in a thin strip at the
    // top). Give it an explicit height so it fills the panel below the back bar.
    '.nb-hist-frame{position:absolute;top:38px;left:0;right:0;width:100%;height:calc(100% - 38px);border:0;background:#fff;}',
```

Replace with:

```javascript
    /* inline version view: a read-only side panel filling the doc area BESIDE the
       sidebar (which stays at right:0 with the live timeline). z-index sits JUST
       BELOW the sidebar (2147483647) and the panel insets by the sidebar width, so
       "you are here" + back-to-current + switch stay reachable while viewing. */
    '.nb-hist-view{position:fixed;top:0;left:0;right:360px;bottom:0;z-index:2147483646;',
    '  background:#fff;display:flex;flex-direction:column;box-shadow:0 0 44px -20px rgba(40,40,38,.5);}',
    '.nb-hist-back{flex:0 0 auto;display:flex;align-items:center;gap:6px;border:none;',
    '  border-bottom:1px solid var(--nb-line);background:var(--nb-accent-wash);color:var(--nb-accent-deep);',
    '  font:700 12px/1 var(--nb-round);letter-spacing:.01em;padding:11px 14px;cursor:pointer;text-align:left;',
    '  transition:background .14s ease,color .14s ease;}',
    '.nb-hist-back:hover{background:var(--nb-accent);color:#fffdf8;}',
    // The iframe is a REPLACED element; as a column-flex child with flex:1 +
    // min-height:0 it resolves to a definite height and fills below the back bar.
    // (Do NOT switch to absolute top+bottom+height:auto — a replaced element falls
    // back to the intrinsic ~150px and collapses into a thin strip.)
    '.nb-hist-frame{flex:1 1 auto;min-height:0;width:100%;border:0;background:#fff;}',
```

- [ ] **Step 3: State — replace the baked `checkoutCurrentKey` read with in-tab `viewingKey`/`inlineView`**

Find (≈ lines 519–532):

```javascript
    // Checkout marker: a canvas opened from a version's "Open" action carries
    // data-noteback-checkout="<live current version key>" on #noteback-doc-root.
    // Read it ONCE here (then strip it from the live DOM so it never lands in a
    // later snapshot/export), so the timeline can mark "you are here" on the opened
    // version and offer "open current". Empty string when this isn't a checkout.
    const checkoutCurrentKey = (function () {
      try {
        const root = document.getElementById('noteback-doc-root');
        if (!root || !root.getAttribute) return '';
        const k = root.getAttribute('data-noteback-checkout') || '';
        if (k && root.removeAttribute) root.removeAttribute('data-noteback-checkout');
        return k;
      } catch (e) { return ''; }
    })();
```

Replace with:

```javascript
    // In-tab version viewing (read-only). `viewingKey` is the version key shown
    // inline (null = the live current draft); `inlineView` is its DOM panel.
    // Inline viewing stays on THIS tab/origin, so the localStorage-backed history
    // adapter remains reachable — unlike the old new-tab blob whose opaque file://
    // origin denied localStorage (the bug this replaced).
    let viewingKey = null;
    let inlineView = null;
```

- [ ] **Step 4: `renderVersions` — drive the bar + collapse rule off `viewingKey`**

Find (≈ line 1441):

```javascript
      if (checkoutCurrentKey) wrap.appendChild(renderCheckoutBar());
```

Replace with:

```javascript
      if (viewingKey) wrap.appendChild(renderBackToCurrentBar());
```

Then find (≈ line 1454):

```javascript
        if (versions.length === 0 && !checkoutCurrentKey) { wrap.remove(); return; }
```

Replace with:

```javascript
        if (versions.length === 0 && !viewingKey) { wrap.remove(); return; }
```

- [ ] **Step 5: Replace `renderCheckoutBar` with `renderBackToCurrentBar`**

Find the whole function (≈ lines 1508–1529):

```javascript
    /**
     * Checkout banner: this tab is an opened past version. One click re-opens the
     * live/current draft (the version key baked into the canvas at checkout). Mirrors
     * the peek's "← Back" affordance, but as a real new-tab checkout of the current.
     */
    function renderCheckoutBar() {
      const bar = doc.createElement('button');
      bar.type = 'button';
      bar.className = 'nb-checkout-bar';
      bar.setAttribute(UI_ATTR, 'checkout-bar');
      const txt = doc.createElement('span');
      txt.className = 'nb-checkout-txt';
      txt.textContent = 'Viewing an earlier version';
      const cta = doc.createElement('span');
      cta.className = 'nb-checkout-cta';
      cta.textContent = 'Open current →';
      bar.appendChild(txt);
      bar.appendChild(cta);
      bar.title = 'Open the current draft in a new tab';
      bar.addEventListener('click', function () { openVersionTab(checkoutCurrentKey); });
      return bar;
    }
```

Replace with:

```javascript
    /**
     * "Back to current" bar, shown atop the timeline while viewing an earlier
     * version inline. One click closes the inline view and returns to the live
     * current draft (same tab — no new tab, no blob).
     */
    function renderBackToCurrentBar() {
      const bar = doc.createElement('button');
      bar.type = 'button';
      bar.className = 'nb-backbar';
      bar.setAttribute(UI_ATTR, 'backbar');
      const txt = doc.createElement('span');
      txt.className = 'nb-backbar-txt';
      txt.textContent = 'Viewing an earlier version';
      const cta = doc.createElement('span');
      cta.className = 'nb-backbar-cta';
      cta.textContent = '← Back to current';
      bar.appendChild(txt);
      bar.appendChild(cta);
      bar.title = 'Return to the current draft';
      bar.addEventListener('click', function () { closeVersionInline(); });
      return bar;
    }
```

- [ ] **Step 6: `renderNowRow` — always the live draft; clickable-to-return when viewing**

Find the whole function (≈ lines 1538–1566):

```javascript
    function renderNowRow() {
      const s = getState();
      const count = (s && Array.isArray(s.comments)) ? s.comments.length : 0;
      const row = doc.createElement('div');
      row.className = 'nb-ver-row active' + (checkoutCurrentKey ? ' nb-ver-viewing' : '');
      row.setAttribute(UI_ATTR, 'version-now');
      const line = doc.createElement('div');
      line.className = 'nb-ver-line';
      const dot = doc.createElement('span');
      dot.className = 'nb-ver-dot';
      const name = doc.createElement('span');
      name.className = 'nb-ver-name';
      name.textContent = checkoutCurrentKey ? 'viewing' : 'now';
      const spacer = doc.createElement('span');
      spacer.className = 'nb-ver-spacer';
      const here = doc.createElement('span');
      here.className = 'nb-ver-here';
      here.textContent = 'you are here';
      const cnt = doc.createElement('span');
      cnt.className = 'nb-ver-count';
      cnt.textContent = String(count);
      line.appendChild(dot);
      line.appendChild(name);
      line.appendChild(spacer);
      line.appendChild(here);
      line.appendChild(cnt);
      row.appendChild(line);
      return row;
    }
```

Replace with:

```javascript
    function renderNowRow() {
      const s = getState();
      const count = (s && Array.isArray(s.comments)) ? s.comments.length : 0;
      const viewing = !!viewingKey;
      const row = doc.createElement('div');
      // The live current draft. When viewing an older version it is NOT the active
      // row (the viewed version is) and becomes click-to-return.
      row.className = 'nb-ver-row' + (viewing ? '' : ' active');
      row.setAttribute(UI_ATTR, 'version-now');
      const line = doc.createElement('div');
      line.className = 'nb-ver-line';
      const dot = doc.createElement('span');
      dot.className = 'nb-ver-dot';
      const name = doc.createElement('span');
      name.className = 'nb-ver-name';
      name.textContent = 'now';
      const spacer = doc.createElement('span');
      spacer.className = 'nb-ver-spacer';
      const cnt = doc.createElement('span');
      cnt.className = 'nb-ver-count';
      cnt.textContent = String(count);
      line.appendChild(dot);
      line.appendChild(name);
      line.appendChild(spacer);
      if (!viewing) {
        const here = doc.createElement('span');
        here.className = 'nb-ver-here';
        here.textContent = 'you are here';
        line.appendChild(here);
      }
      line.appendChild(cnt);
      row.appendChild(line);
      if (viewing) row.addEventListener('click', function () { closeVersionInline(); });
      return row;
    }
```

- [ ] **Step 7: `renderVersionRow` — mark the viewed version; click opens the inline view**

Find the whole function (≈ lines 1576–1629):

```javascript
    function renderVersionRow(d, ordinal) {
      const row = doc.createElement('div');
      // In a checkout tab, the live/current draft shows up here as a normal row —
      // flag it so we can badge it "current" (the checkout bar above is the primary
      // way back; this just orients the reader).
      const isCurrent = !!(checkoutCurrentKey && d.versionKey === checkoutCurrentKey);
      row.className = 'nb-ver-row' + (isCurrent ? ' nb-ver-is-current' : '');
      row.setAttribute(UI_ATTR, 'version');
      row.setAttribute('data-version-key', d.versionKey || '');

      const line = doc.createElement('div');
      line.className = 'nb-ver-line';
      const dot = doc.createElement('span');
      dot.className = 'nb-ver-dot';
      const name = doc.createElement('span');
      name.className = 'nb-ver-name';
      name.textContent = 'v' + ordinal;
      // Chevron next to the label: opens the actions menu (Open / Copy feedback).
      const menuBtn = doc.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'nb-ver-menu-btn';
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-label', 'Version actions');
      menuBtn.setAttribute('title', 'Version actions');
      menuBtn.innerHTML = '<span class="nb-caret" aria-hidden="true">▾</span>';
      menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleVersionMenu(menuBtn, d); });
      const meta = doc.createElement('span');
      meta.className = 'nb-ver-meta';
      meta.textContent = formatWhen(d.lastEditedAt || d.createdAt);
      const spacer = doc.createElement('span');
      spacer.className = 'nb-ver-spacer';
      const cnt = doc.createElement('span');
      cnt.className = 'nb-ver-count';
      cnt.textContent = String((d.comments && d.comments.length) || 0);
      line.appendChild(dot);
      line.appendChild(name);
      line.appendChild(menuBtn);
      line.appendChild(spacer);
      if (isCurrent) {
        const cur = doc.createElement('span');
        cur.className = 'nb-ver-here nb-ver-current';
        cur.textContent = 'current';
        line.appendChild(cur);
      }
      line.appendChild(meta); // date — right-aligned (after the flex spacer)
      line.appendChild(cnt);
      row.appendChild(line);

      // Peek lives on the whole row; the chevron's stopPropagation keeps a menu
      // click from also peeking.
      row.addEventListener('click', function () { openVersionPeek(d.versionKey); });
      return row;
    }
```

Replace with:

```javascript
    function renderVersionRow(d, ordinal) {
      const row = doc.createElement('div');
      // The version currently shown inline is the "you are here" row (active dot +
      // viewing badge); every other row is click-to-view.
      const isViewing = !!(viewingKey && d.versionKey === viewingKey);
      row.className = 'nb-ver-row' + (isViewing ? ' active nb-ver-viewing' : '');
      row.setAttribute(UI_ATTR, 'version');
      row.setAttribute('data-version-key', d.versionKey || '');

      const line = doc.createElement('div');
      line.className = 'nb-ver-line';
      const dot = doc.createElement('span');
      dot.className = 'nb-ver-dot';
      const name = doc.createElement('span');
      name.className = 'nb-ver-name';
      name.textContent = 'v' + ordinal;
      // Chevron next to the label: opens the actions menu (Copy feedback).
      const menuBtn = doc.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'nb-ver-menu-btn';
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.setAttribute('aria-label', 'Version actions');
      menuBtn.setAttribute('title', 'Version actions');
      menuBtn.innerHTML = '<span class="nb-caret" aria-hidden="true">▾</span>';
      menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleVersionMenu(menuBtn, d); });
      const meta = doc.createElement('span');
      meta.className = 'nb-ver-meta';
      meta.textContent = formatWhen(d.lastEditedAt || d.createdAt);
      const spacer = doc.createElement('span');
      spacer.className = 'nb-ver-spacer';
      const cnt = doc.createElement('span');
      cnt.className = 'nb-ver-count';
      cnt.textContent = String((d.comments && d.comments.length) || 0);
      line.appendChild(dot);
      line.appendChild(name);
      line.appendChild(menuBtn);
      line.appendChild(spacer);
      if (isViewing) {
        const here = doc.createElement('span');
        here.className = 'nb-ver-here';
        here.textContent = 'you are here';
        line.appendChild(here);
      }
      line.appendChild(meta); // date — right-aligned (after the flex spacer)
      line.appendChild(cnt);
      row.appendChild(line);

      // Click anywhere on the row (except the chevron, which stops propagation)
      // opens the read-only inline view of this version.
      row.addEventListener('click', function () { openVersionInline(d.versionKey); });
      return row;
    }
```

- [ ] **Step 8: Replace `openVersionPeek` with `openVersionInline` + add `closeVersionInline`**

Find the whole `openVersionPeek` function (≈ lines 1655–1716, from `function openVersionPeek(versionKey) {` through its closing `}` just before the `buildPeekPopoverScript` doc comment).

Replace the entire function with:

```javascript
    /**
     * Open a past version inline (read-only) in a side panel beside the sidebar.
     * Parses the version's clean snapshot, runs the LIVE highlight painter over it
     * (commented passages wrapped in the same <mark class="noteback-highlight">),
     * re-injects HIGHLIGHT_CSS + PEEK_POP_CSS, and shows it in an <iframe srcdoc>
     * under a "← Back to current draft" bar. Sets `viewingKey` and re-renders the
     * timeline so the sidebar marks this version "you are here" and offers a way
     * back / a switch to another version. Pruned snapshots (html === '') toast and
     * leave the current draft in place.
     */
    function openVersionInline(versionKey) {
      closeVersionMenu(true); // a row chevron may have opened it
      Promise.resolve(history.getVersion({ versionKey: versionKey })).then(function (v) {
        if (!v || !v.html) { toast('This version has no saved snapshot'); return; } // pruned

        // Parse the snapshot and paint REAL highlights into it via the live painter.
        // paintHighlights creates each <mark> with the parsed doc's own ownerDocument,
        // so the marks land inside `parsed` and survive serialization below.
        let painted = '<!DOCTYPE html>' + v.html;
        try {
          const parsed = new DOMParser().parseFromString(v.html, 'text/html');
          try {
            highlightApi.paintHighlights(parsed.body, { schemaVersion: 1, comments: v.comments || [] }, {});
          } catch (e) { /* keep the un-highlighted snapshot */ }
          // The clean snapshot dropped Noteback's styles; re-inject HIGHLIGHT_CSS so
          // the marks match the live document, plus PEEK_POP_CSS for the in-iframe
          // comment popover.
          try {
            const hlStyle = parsed.createElement('style');
            hlStyle.setAttribute(UI_ATTR, 'peek-highlight-style');
            hlStyle.textContent = HIGHLIGHT_CSS + PEEK_POP_CSS;
            (parsed.head || parsed.documentElement).appendChild(hlStyle);
          } catch (e) { /* styling is best-effort */ }
          const scrollScript =
            '<scr' + 'ipt>(function(){var m=document.querySelector("mark.noteback-highlight");' +
            'if(m)m.scrollIntoView({block:"center"});})();</scr' + 'ipt>';
          // Click a painted highlight → show that comment in an in-place popover.
          // The id->comment map is serialized into the iframe; comment bodies are
          // placed via textContent and any literal "</script>" in the JSON is escaped.
          const peekScript = buildPeekPopoverScript(v.comments || []);
          painted = '<!DOCTYPE html>' + parsed.documentElement.outerHTML + scrollScript + peekScript;
        } catch (e) { /* DOMParser unavailable — fall back to the raw snapshot */ }

        // Swap any existing inline view (switching versions) WITHOUT a redundant
        // timeline re-render — we re-render once below after viewingKey is set.
        if (inlineView && inlineView.parentNode) inlineView.parentNode.removeChild(inlineView);
        inlineView = null;
        viewingKey = versionKey;

        const view = doc.createElement('div');
        view.className = 'nb-hist-view';
        view.setAttribute(UI_ATTR, 'version-view');
        const backBar = doc.createElement('button');
        backBar.type = 'button';
        backBar.className = 'nb-hist-back';
        backBar.setAttribute(UI_ATTR, 'version-view-back');
        backBar.textContent = '← Back to current draft';
        backBar.addEventListener('click', function () { closeVersionInline(); });
        const frame = doc.createElement('iframe');
        frame.className = 'nb-hist-frame';
        frame.srcdoc = painted; // the snapshot with live highlights painted in
        view.appendChild(backBar);
        view.appendChild(frame);
        uiRoot.appendChild(view);
        inlineView = view;

        openSidebar();    // ensure the timeline (with "you are here") is visible
        renderVersions(); // re-render so the viewed row is marked + the bar shows
      });
    }

    /** Close the inline version view and return to the live current draft. */
    function closeVersionInline() {
      if (inlineView && inlineView.parentNode) inlineView.parentNode.removeChild(inlineView);
      inlineView = null;
      const had = viewingKey;
      viewingKey = null;
      if (had) renderVersions();
    }
```

- [ ] **Step 9: Delete `buildVersionCanvasHtml` and `openVersionTab` entirely**

Delete the whole `buildVersionCanvasHtml` function (its doc comment block beginning `/**` with `Build a REAL annotatable canvas of a past version` through `return '<!DOCTYPE html>\n' + clone.outerHTML; }`, ≈ lines 1767–1853) AND the whole `openVersionTab` function (its doc comment beginning `Checkout: open a past version as a real, live, annotatable canvas tab.` through its closing `}`, ≈ lines 1855–1905). Leave `buildPeekPopoverScript` (between them) and `formatWhen` (after them) intact.

After deletion, the region reads (the `buildPeekPopoverScript` function's closing `}` followed directly by `formatWhen`):

```javascript
        '}());</scr' + 'ipt>';
    }

    function formatWhen(iso) {
```

- [ ] **Step 10: Version actions menu — remove the "Open" (new-tab) item**

Find (≈ lines 2375–2382):

```javascript
    versionMenu.innerHTML =
      '<button type="button" class="nb-menu-item nb-vm-open" role="menuitem">' +
      '<span class="nb-mi-label">Open</span>' +
      '<span class="nb-mi-sub">check out as a canvas tab</span></button>' +
      '<div class="nb-menu-sep" role="none"></div>' +
      '<button type="button" class="nb-menu-item nb-vm-copy" role="menuitem">' +
      '<span class="nb-mi-label">Copy feedback</span>' +
      '<span class="nb-mi-sub">this version’s markdown</span></button>';
    uiRoot.appendChild(versionMenu);
    const vmOpenItem = versionMenu.querySelector('.nb-vm-open');
    const vmCopyItem = versionMenu.querySelector('.nb-vm-copy');
```

Replace with:

```javascript
    versionMenu.innerHTML =
      '<button type="button" class="nb-menu-item nb-vm-copy" role="menuitem">' +
      '<span class="nb-mi-label">Copy feedback</span>' +
      '<span class="nb-mi-sub">this version’s markdown</span></button>';
    uiRoot.appendChild(versionMenu);
    const vmCopyItem = versionMenu.querySelector('.nb-vm-copy');
```

- [ ] **Step 11: Remove the `vmOpenItem` click handler**

Find (≈ lines 2391–2396):

```javascript
    vmOpenItem.addEventListener('click', function (e) {
      e.stopPropagation();
      const d = versionMenuData;
      closeVersionMenu();
      if (d && d.hasSnapshot) openVersionTab(d.versionKey);
    });
    vmCopyItem.addEventListener('click', function (e) {
```

Replace with:

```javascript
    vmCopyItem.addEventListener('click', function (e) {
```

- [ ] **Step 12: Drop the `vmOpenItem` enable/disable in `openVersionMenu`**

Find (≈ lines 2429–2431):

```javascript
      // Pruned snapshot: nothing to open, but the feedback still copies.
      vmOpenItem.disabled = !d.hasSnapshot;
      vmOpenItem.title = d.hasSnapshot ? '' : 'Snapshot no longer stored';
      btn.setAttribute('aria-expanded', 'true');
```

Replace with:

```javascript
      btn.setAttribute('aria-expanded', 'true');
```

- [ ] **Step 13: `closeSidebar` — also close the inline view**

Find (≈ lines 2277–2283):

```javascript
    function closeSidebar() {
      closeSaveMenu();
      closeCopyMenu();
      closeVersionMenu(true);
      sidebar.classList.remove('nb-open');
      launcher.classList.remove('nb-hidden');
    }
```

Replace with:

```javascript
    function closeSidebar() {
      closeSaveMenu();
      closeCopyMenu();
      closeVersionMenu(true);
      closeVersionInline(); // a half-open version view with no timeline is a dead end
      sidebar.classList.remove('nb-open');
      launcher.classList.remove('nb-hidden');
    }
```

- [ ] **Step 14: Tidy two stale comments that name `openVersionPeek`**

Find (≈ line 60–61):

```javascript
  // Shared so the version-peek iframe paints highlights identically to the live
  // document (openVersionPeek injects this into the snapshot's <head>).
```

Replace with:

```javascript
  // Shared so the inline version-view iframe paints highlights identically to the
  // live document (openVersionInline injects this into the snapshot's <head>).
```

Then find (≈ line 80):

```javascript
  // clicked (openVersionPeek injects this into the snapshot's <head>). It lives in
```

Replace with:

```javascript
  // clicked (openVersionInline injects this into the snapshot's <head>). It lives in
```

- [ ] **Step 15: Sanity-check no dangling references remain**

Run: `grep -n "checkoutCurrentKey\|openVersionTab\|openVersionPeek\|buildVersionCanvasHtml\|renderCheckoutBar\|nb-checkout\|nb-hist-backdrop\|nb-hist-panel\|vmOpenItem\|data-noteback-checkout" src/runtime/overlay.js`
Expected: **no output** (every reference removed/renamed).

- [ ] **Step 16: Run the Node unit suite (guard against syntax/load errors)**

Run: `npm test`
Expected: PASS (pure-logic suites unaffected; this confirms `overlay.js` still parses/loads where required).

- [ ] **Step 17: Run the rewritten timeline e2e — now PASSES**

Run: `node --test test/e2e/version-timeline.e2e.test.js`
Expected: PASS — inline view opens, sidebar stays visible with "you are here", switching versions works, "Back to current" restores the live draft.

- [ ] **Step 18: Commit**

```bash
git add src/runtime/overlay.js
git commit -m "feat: inline (in-tab) read-only version viewing; remove new-tab checkout

Open a past version in a side panel beside the sidebar instead of a new
window.open(blob:) tab. The blob's opaque file:// origin denied localStorage,
which left the opened tab's history sidebar empty. Inline viewing stays on the
same origin so the history adapter (timeline, 'you are here', switch, back to
current) just works. Deletes openVersionTab / buildVersionCanvasHtml / the
data-noteback-checkout marker / the chevron-menu 'Open' item.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add a `file://` inline-view regression test

**Files:**
- Modify: `test/e2e/version-scoping-file.e2e.test.js` (append one test, reusing its `createComment`/`openSidebar`/`readNbKeys` helpers)

This is the direct guard for the original bug, on the real environment the http test sidesteps.

- [ ] **Step 1: Append the inline-view test at the end of the file**

Add, immediately before the final newline of `test/e2e/version-scoping-file.e2e.test.js` (after the existing test's closing `});`):

```javascript

test('file://: opening a version inline shows the timeline + "you are here", then returns to current', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // Clean slate, one comment (draft v0.3).
    await page.goto(fileURL);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);
    await createComment(page, 'feedback on draft v0.3');

    // Edit the file in place so the comment becomes an EARLIER version.
    const before = fs.readFileSync(canvasFile, 'utf8');
    const edited = before.replace('Draft v0.3', 'Draft v0.31');
    assert.notStrictEqual(edited, before, 'sanity: the "Draft v0.3" token was found and edited');
    fs.writeFileSync(canvasFile, edited);
    await page.goto(fileURL + '?reload=1');
    await page.waitForTimeout(500);

    // Sidebar shows the timeline with one earlier-version row.
    await openSidebar(page);
    assert.ok(await page.locator('.nb-versions').count() > 0, 'the Versions timeline group is rendered');
    const earlier = page.locator('.nb-ver-row[data-version-key]');
    assert.ok(await earlier.count() >= 1, 'an earlier-version row (v0.3) is shown on file://');

    // Open it INLINE. On file:// the live page's localStorage works, so the snapshot
    // is reachable — this is exactly what the old new-tab blob (opaque origin) could
    // not do, which is why the opened tab's sidebar was empty.
    await earlier.first().locator('.nb-ver-line').first().click();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 1, 'the inline version view opens on file://');
    assert.strictEqual(await page.locator('.nb-sidebar.nb-open').count(), 1, 'the sidebar stays visible beside the inline view');

    // The viewed version is the "you are here" row, and a "Back to current" bar shows.
    const viewingRow = page.locator('.nb-ver-row.active.nb-ver-viewing');
    assert.strictEqual(await viewingRow.count(), 1, 'the opened version is marked the active "viewing" row');
    assert.strictEqual(((await viewingRow.locator('.nb-ver-here').first().textContent()) || '').trim(), 'you are here', 'the opened version is marked "you are here"');
    assert.strictEqual(await page.locator('.nb-backbar').count(), 1, 'a "Back to current" bar is offered');

    // The inline iframe actually rendered the snapshot (history was reachable).
    const hasContent = await page.evaluate(() => {
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
      return !!(f && f.contentDocument && (f.contentDocument.body.textContent || '').length > 0);
    });
    assert.ok(hasContent, 'the inline iframe shows the captured snapshot (history reachable on file://)');

    // Back to current closes the view.
    await page.locator('.nb-backbar').click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.nb-hist-view').count(), 0, '"Back to current" closes the inline view');
    assert.strictEqual(await page.locator('.nb-ver-row.nb-ver-viewing').count(), 0, 'no row stays marked "viewing" after returning');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run the file:// e2e**

Run: `node --test test/e2e/version-scoping-file.e2e.test.js`
Expected: PASS — both the existing version-scoping test and the new inline-view test.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/version-scoping-file.e2e.test.js
git commit -m "test(e2e): file:// inline version view regression guard

Reproduces the original bug's environment (file://): opening a version shows
the inline view + timeline 'you are here' + back-to-current — the path that the
old new-tab blob (opaque origin, localStorage denied) left empty.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Update the docs

**Files:**
- Modify: `CLAUDE.md`, `CONTRACTS.md`, `docs/design.md`

- [ ] **Step 1: Find every doc reference to the removed checkout machinery**

Run: `grep -n "checkout\|data-noteback-checkout\|openVersionTab\|buildVersionCanvasHtml\|Open current\|new tab" CLAUDE.md CONTRACTS.md docs/design.md`
Read each hit in context before editing.

- [ ] **Step 2: `CLAUDE.md` — replace the obsolete gotchas**

Remove (or rewrite) the gotcha bullets that describe the new-tab checkout, specifically the bullets covering: "The version PEEK re-renders…" (the peek still exists but is now a side panel — update the closing details about the modal), "The peek `<iframe>` needs an EXPLICIT height…" (now a flex child — update), "CHECKOUT (`open`) re-seeds `#noteback-state`…", and "The checkout marker (`data-noteback-checkout`) is read ONCE at mount…". Replace them with a single bullet:

```markdown
- **Version viewing is IN-TAB and read-only.** Clicking a version row opens
  `overlay.openVersionInline` — a read-only `<iframe srcdoc>` side panel
  (`.nb-hist-view`) beside the sidebar (NOT a new tab, NOT a centered modal). It
  reuses the snapshot painter (`paintHighlights` + re-injected `HIGHLIGHT_CSS` +
  `buildPeekPopoverScript`). An in-tab `viewingKey` drives the timeline: the viewed
  row is the active "you are here" row, a "Back to current" bar
  (`renderBackToCurrentBar` → `closeVersionInline`) returns to the live draft, and
  other rows switch. There is NO new-tab "checkout": `openVersionTab` /
  `buildVersionCanvasHtml` / the `data-noteback-checkout` marker were removed
  because a `window.open(blob:)` tab from a `file://` canvas gets an opaque origin
  whose `localStorage` is denied, leaving the opened tab's history sidebar empty
  (the bug). The `.nb-hist-frame` iframe fills the panel as a column-flex child
  (`flex:1;min-height:0`), not via absolute `height:calc(...)`.
```

Also update the "**The 'viewing' row needs the opened tab to SHARE the canvas's history store.**" bullet and any `version-timeline.e2e.test.js` description to reflect that viewing is in-tab (no cross-origin store dependency).

- [ ] **Step 3: `CONTRACTS.md` — update checkout references**

The checkout appears in `CONTRACTS.md` at (approx.): line 67 (`getCurrentVersionKey` "used by checkout to bake…"), 78 (`data-noteback-checkout` baking), 83–84 ("Open current →" banner via `openVersionTab`, checkout-of-a-checkout), 451 (history block excluded from `buildVersionCanvasHtml` checkouts), and the whole **§8.7 "Overlay — version timeline + peek + checkout"** (lines ≈724–745, esp. the "Checkout (`openVersionTab` → `buildVersionCanvasHtml`)" bullet ≈742). Read each in context, then:
- Retitle §8.7 to "Overlay — version timeline + inline view".
- Replace the "Checkout" bullet with an "Inline view" bullet: clicking a row → `openVersionInline` opens a read-only `<iframe srcdoc>` side panel (`.nb-hist-view`) beside the sidebar; an in-tab `viewingKey` marks the viewed row "you are here", `renderBackToCurrentBar` → `closeVersionInline` returns to the live draft, other rows switch. Same tab, same origin; viewing never mutates the live doc and never spawns a tab.
- At lines 67/78/83–84/451, drop the `data-noteback-checkout`/`openVersionTab`/"Open current →"/`buildVersionCanvasHtml` references (the marker and both functions no longer exist). `getCurrentVersionKey` may still be documented as part of the history facade, but remove "used by checkout to bake…".

- [ ] **Step 4: `docs/design.md §14` — update the snapshot-history section**

§14 references the checkout at (approx.): line 320 (history block excluded from checkouts), 330 ("…version to a live canvas in a new tab"), 338 (`data-noteback-checkout=<live current key>` baking), 341 ("Open current →" banner), 406 ("Checkout self-XSS" — the `#noteback-state` re-seed). Rewrite these to describe the inline read-only view (no new tab, no `data-noteback-checkout`, no `#noteback-state` re-seed). Keep the `</script>`-escaping safety note but re-scope it to the peek popover script (`buildPeekPopoverScript`), which still serializes comment data into an iframe. Add one sentence on the rationale: a `window.open(blob:)` tab from a `file://` canvas gets an opaque origin whose `localStorage` is denied, so viewing was moved in-tab.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CONTRACTS.md docs/design.md
git commit -m "docs: version viewing is in-tab read-only; drop new-tab checkout notes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification

**Files:** none (verification only; commit only if a fix is needed)

- [ ] **Step 1: Run the complete Node suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Run the complete e2e suite**

Run: `npm run test:e2e`
Expected: PASS — all files, including `version-timeline.e2e.test.js`, `version-scoping-file.e2e.test.js`, `history-embed.e2e.test.js`, `extension-standdown.e2e.test.js`, `comment-chip-position.e2e.test.js`.

- [ ] **Step 3: Rebuild the example canvas and smoke-test live (per CLAUDE.md "Live verification")**

Run: `node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html`
Then serve over localhost (e.g. `npx http-server -p 8080` or `python3 -m http.server 8080`) and open `http://localhost:8080/examples/spec.canvas.html?v=1`. Make two comments, edit the served title to force a new version, reload, open the sidebar, click an earlier version row, and confirm: the side panel opens beside the sidebar, the row shows "you are here", "Back to current" returns to the live draft, and switching between versions works. (`examples/spec.canvas.html` is gitignored.)

- [ ] **Step 4: Confirm the working tree is clean**

Run: `git status`
Expected: clean (only the gitignored `examples/spec.canvas.html` may differ, which git ignores).

---

## Notes for the implementer

- **Run e2e individually while iterating** (`node --test test/e2e/<file>`) — each spins up Chromium and builds a canvas, so the full `npm run test:e2e` is slow. The browser binary is needed once: `npx playwright install chromium`.
- **The file must stay coherent within Task 2** — apply all of Steps 1–14 before running Step 16/17. Removing `checkoutCurrentKey` (Step 3) without removing `openVersionTab` (Step 9) would leave a dangling reference; the Step 15 grep catches any miss.
- **Do not** reintroduce a `[data-noteback-ui]` marker dependency for the inline view beyond what already exists — the inline panel rides `[data-noteback-ui]="version-view"` so existing export-strip paths drop it automatically.
- **Zero runtime dependencies, no build step** — keep all changes in plain ES5-compatible runtime style matching the surrounding `overlay.js` code (it is inlined verbatim into every canvas).
```
