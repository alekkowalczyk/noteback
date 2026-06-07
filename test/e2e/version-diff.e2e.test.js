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
    assert.ok(frame.editBlock >= 1 || (frame.insBlock >= 1 && frame.delBlock >= 1), 'the changed heading renders as an edited block or ins+del blocks (edit ' + frame.editBlock + ', insBlock ' + frame.insBlock + ', delBlock ' + frame.delBlock + ')');
    assert.ok(frame.ins >= 1 || frame.insBlock >= 1, 'the diff shows at least one insertion (ins ' + frame.ins + ', insBlock ' + frame.insBlock + ')');
    assert.ok(frame.del >= 1 || frame.delBlock >= 1, 'the diff shows at least one deletion (del ' + frame.del + ', delBlock ' + frame.delBlock + ')');
    assert.ok(frame.marks >= 1, 'comment highlights remain painted in diff mode (layering)');

    // The diff is unmistakably framed as a comparison (not document content): a
    // sticky legend header, and an "Edited"/"Added"/"Removed" gutter tag rendered
    // via the block's ::after content. These guard the gutter+labels UI styling.
    const chrome = await page.evaluate(() => {
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
      const cd = f.contentDocument; const w = f.contentWindow;
      const legend = cd.querySelector('.nb-diff-legend');
      const block = cd.querySelector('.nb-diff-edit-block,.nb-diff-ins-block,.nb-diff-del-block');
      return {
        legendText: legend ? legend.textContent.trim() : null,
        tagContent: block ? w.getComputedStyle(block, '::after').content : null,
        badgeContent: block ? w.getComputedStyle(block, '::before').content : null,
        // Square corners (no rounding) on every diff-block type, and a tag filled
        // with the SAME saturated colour as the gutter rail (not a pale wash that
        // could read as document content).
        blockRadius: block ? w.getComputedStyle(block).borderTopRightRadius : null,
        tagBg: block ? w.getComputedStyle(block, '::after').backgroundColor : null,
        railColor: block ? w.getComputedStyle(block).borderLeftColor : null
      };
    });
    assert.ok(chrome.legendText && /Comparing\s*v\d+\s*→\s*now/.test(chrome.legendText), 'a legend header frames the diff ("Comparing vN → now"), got: ' + chrome.legendText);
    assert.ok(chrome.tagContent && /Edited|Added|Removed/.test(chrome.tagContent), 'a changed block carries an Edited/Added/Removed tag via ::after, got: ' + chrome.tagContent);
    assert.ok(chrome.badgeContent && chrome.badgeContent !== 'none' && chrome.badgeContent !== 'normal', 'a changed block carries a gutter badge via ::before, got: ' + chrome.badgeContent);
    assert.strictEqual(chrome.blockRadius, '0px', 'diff blocks have square (non-rounded) corners, got: ' + chrome.blockRadius);
    assert.strictEqual(chrome.tagBg, chrome.railColor, 'the diff tag is filled with the saturated rail colour (not a pale wash); tag ' + chrome.tagBg + ' vs rail ' + chrome.railColor);

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
