'use strict';
/**
 * Browser e2e for the canvas version-timeline UI + INLINE version viewing
 * (docs/2026-06-07-inline-version-viewing-design.md).
 *
 * The history ENGINE is unit-tested (Node); this guards the OVERLAY DOM: the
 * "History" group, its rows, and the read-only INLINE view (a side panel beside
 * the sidebar). It drives real drag-select comments across three drafts (same
 * baked doc-id, changing visible text → new content hash each time), so two
 * EARLIER versions exist, then exercises: open a version inline (the sidebar marks
 * it the active "viewing" row while staying visible), switch to another version,
 * return to the current draft, and the version chevron's Copy/Save actions.
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

test('inline version viewing: timeline rows, viewing state, switch versions, back to current, save actions', { timeout: 120000 }, async () => {
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

    // Exactly one active "now" row (the live draft), no actions chevron, no "you are here" text.
    assert.strictEqual(await page.locator('.nb-ver-row.active').count(), 1, 'exactly one active "now" row');
    assert.strictEqual(await page.locator('.nb-ver-row.active .nb-ver-menu-btn').count(), 0, 'the "now" row has no actions chevron');
    assert.strictEqual(await page.locator('.nb-ver-here').count(), 0, 'no "you are here" text anywhere (removed)');
    assert.strictEqual(((await page.locator('.nb-ver-row.active .nb-ver-name').first().textContent()) || '').trim(), 'now', 'the active row is the live "now" draft when not viewing');

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

    // The viewed version is the active "viewing" row; "now" is no longer active.
    const viewingRow = page.locator('.nb-ver-row.active.nb-ver-viewing');
    assert.strictEqual(await viewingRow.count(), 1, 'the viewed version is the active "viewing" row');
    assert.strictEqual(await viewingRow.getAttribute('data-version-key'), v2key, 'the viewing row is v2 (the one clicked)');
    assert.strictEqual(await page.locator('.nb-ver-here').count(), 0, 'still no "you are here" text (removed)');
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

    // --- Version chevron menu: Copy feedback + the two Save options. ---
    // Stub the save primitives so the "download" is captured in-page (the headless
    // pattern history-embed.e2e uses) instead of hitting disk.
    await page.evaluate(() => {
      const RT = window.NotebackRuntime;
      window.__saved = null;
      RT.exporter.saveCanvasInPlace = (html) => { window.__saved = html; return Promise.resolve(); };
      RT.exporter.downloadCanvas = (html) => { window.__saved = html; };
    });
    // Operate on v1 — it carries the </script> breakout payload; reach it via the disclosure.
    await page.locator('.nb-disclose').click();
    await page.waitForTimeout(200);
    const v1row = page.locator('.nb-ver-row[data-version-key="' + v1key + '"]');
    await v1row.locator('.nb-ver-menu-btn').click();
    await page.waitForTimeout(250);
    const vmenu = page.locator('.nb-ver-menu.is-open');
    assert.strictEqual(await vmenu.count(), 1, 'the version chevron opens the actions menu');
    assert.strictEqual(await vmenu.locator('.nb-vm-copy').count(), 1, 'menu has Copy feedback');
    assert.strictEqual(await vmenu.locator('.nb-vm-save').count(), 1, 'menu has "Save HTML with comments"');
    assert.strictEqual(await vmenu.locator('.nb-vm-saveclean').count(), 1, 'menu has "Save clean HTML"');
    assert.strictEqual(await vmenu.locator('.nb-vm-save').isDisabled(), false, 'Save with comments is enabled (snapshot stored)');
    assert.strictEqual(await vmenu.locator('.nb-vm-saveclean').isDisabled(), false, 'Save clean is enabled (snapshot stored)');

    // "Save HTML with comments" → a re-openable canvas of THIS version (runtime + its comment).
    await vmenu.locator('.nb-vm-save').click();
    await page.waitForTimeout(300);
    const savedCanvas = await page.evaluate(() => window.__saved);
    assert.ok(savedCanvas && savedCanvas.indexOf('noteback-state') !== -1, 'the saved canvas carries the #noteback-state block');
    assert.ok(savedCanvas.indexOf('NotebackRuntime') !== -1, 'the saved canvas carries the inlined runtime (re-openable)');
    assert.ok(savedCanvas.indexOf('Draft-1 feedback note') !== -1, 'the saved canvas embeds the version\'s comment body');
    assert.ok(!savedCanvas.includes('</script><img src=x onerror=alert(1)>'), 'the </script> breakout is NOT present unescaped in the saved canvas');
    assert.ok(savedCanvas.includes('<\\/script'), 'the </script> in the comment body is escaped in the re-seeded state block');

    // "Save clean HTML" → the version's clean snapshot (no runtime, no state block).
    await v1row.locator('.nb-ver-menu-btn').click();
    await page.waitForTimeout(250);
    await page.locator('.nb-ver-menu.is-open .nb-vm-saveclean').click();
    await page.waitForTimeout(300);
    const savedClean = await page.evaluate(() => window.__saved);
    assert.ok(savedClean && savedClean.indexOf('noteback-state') === -1, 'the clean save has NO #noteback-state block');
    assert.ok(savedClean.indexOf('NotebackRuntime') === -1, 'the clean save has NO inlined runtime');
  } finally {
    await context.close();
  }
});
