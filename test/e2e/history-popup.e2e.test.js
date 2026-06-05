'use strict';
/**
 * Browser e2e for the canvas draft-history feature (Plan 1).
 *
 * Guards the one bug class the Node suite structurally cannot: the overlay's DOM
 * paint/persist ORDERING. snapshot.extractSections reads the painted <mark> nodes,
 * so a comment's history snapshot is only captured if its highlight is in the DOM
 * when persist() runs. This test drives a REAL selection -> comment -> reload (as a
 * new draft in the same lineage) -> click the "Earlier feedback" entry, and asserts
 * the snapshot popup opens. It fails on the pre-fix code (snapshot captured empty,
 * history entry disabled) and passes on the fix.
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
  // Build the canvas exactly as `npx noteback wrap` does, then serve it from memory.
  const out = path.join(os.tmpdir(), 'noteback-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  // Enrich the Overview section to 3 paragraphs so the whole-section snapshot has
  // multiple blocks to capture (spec.html ships one paragraph per section).
  const OVERVIEW_EXTRA =
    '<p>Context paragraph two of the Overview section, present so the snapshot has multiple blocks to capture.</p>' +
    '<p>Context paragraph three of the Overview section, immediately before the next heading.</p>';
  server = http.createServer((req, res) => {
    // serveMode 'd2' rewrites visible text -> new content hash, same path -> same
    // lineage, so the 'd1' comment shows up as "Earlier feedback".
    let body = canvasHtml.replace('<h2>Architecture</h2>', OVERVIEW_EXTRA + '<h2>Architecture</h2>');
    if (serveMode === 'd2') body = body.split('Technical Spec').join('Technical Spec — Revision 2');
    res.setHeader('content-type', 'text/html; charset=utf-8');
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

test('history snapshot is captured on create and the "Earlier feedback" entry opens the popup', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // --- Draft 1: create a real anchored comment ---
    serveMode = 'd1';
    await page.goto(baseURL + '?v=d1');
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);

    await createComment(page, 'Draft-1 feedback note');

    // The snapshot must be captured at create time (this is the core of the fix).
    const draft1 = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.indexOf('nb:gen:') === 0) {
          const g = JSON.parse(localStorage.getItem(k));
          out.push({ comments: (g.comments || []).length, sections: (g.sections || []).length });
        }
      }
      return out;
    });
    assert.strictEqual(draft1.length, 1, 'one draft persisted');
    assert.strictEqual(draft1[0].comments, 1, 'comment persisted');
    assert.strictEqual(draft1[0].sections, 1, 'section snapshot captured at create time (the fix)');

    // --- Draft 2: same path, different text -> draft 1 becomes history ---
    serveMode = 'd2';
    await page.goto(baseURL + '?v=d2');
    await page.waitForTimeout(400);
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);

    const item = page.locator('.nb-hist-item').first();
    assert.ok(await page.locator('.nb-hist-item').count() >= 1, 'earlier feedback item rendered');
    assert.strictEqual(await item.isDisabled(), false, 'history item is enabled (clickable)');
    assert.strictEqual(await item.evaluate((el) => getComputedStyle(el).cursor), 'pointer', 'history item shows a pointer cursor');

    // --- Click -> snapshot popup opens with the highlighted quote ---
    await item.click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-hist-backdrop').count(), 1, 'snapshot popup opened');

    const inner = await page.evaluate(() => {
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
      if (!f) return { error: 'no-iframe' };
      const d = f.contentDocument;
      const blocks = Array.from(d.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,table,pre,blockquote'));
      return {
        hasMark: !!d.querySelector('mark'),
        textLen: (d.body.textContent || '').length,
        blockCount: blocks.length,
        headings: blocks.filter((b) => /^H[1-6]$/.test(b.tagName)).map((b) => b.textContent.trim()),
        text: d.body.textContent || ''
      };
    });
    assert.ok(!inner.error, 'popup iframe present');
    assert.ok(inner.textLen > 0, 'popup shows the captured section text');
    assert.strictEqual(inner.hasMark, true, 'popup highlights the commented quote');
    // Whole-section context: the full Overview section (heading + 3 paragraphs)...
    assert.ok(inner.blockCount >= 4, 'popup shows the whole multi-block section (got ' + inner.blockCount + ' blocks)');
    assert.deepStrictEqual(inner.headings, ['Overview'], 'only the section heading — capture stops at the next heading');
    // ...but NOT the following section.
    assert.ok(!/Architecture/.test(inner.text), 'the next section is excluded');
  } finally {
    await context.close();
  }
});

/** Read the headings rendered inside the snapshot popup iframe (pierces shadow DOM). */
async function popupHeadings(page) {
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
    const d = f.contentDocument;
    return Array.from(d.body.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.textContent.trim());
  });
}

test('a selection spanning sections captures BOTH ends in the popup, not just the start', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  try {
    // --- Draft 1: drag-select from the Overview paragraph down into Architecture ---
    serveMode = 'd1';
    await page.goto(baseURL + '?v=ms1');
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);

    const pts = await page.evaluate(() => {
      const root = document.getElementById('noteback-doc-root');
      const ps = Array.from(root.querySelectorAll('p'));
      const start = ps.find((p) => /RealtimeSync keeps client/.test(p.textContent));
      const end = ps.find((p) => /Incoming edits are written/.test(p.textContent));
      start.scrollIntoView({ block: 'start' });
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      return { ax: a.left + 6, ay: a.top + 6, bx: b.left + 120, by: b.top + 6 };
    });
    await page.mouse.move(pts.ax, pts.ay);
    await page.mouse.down();
    await page.mouse.move((pts.ax + pts.bx) / 2, (pts.ay + pts.by) / 2, { steps: 8 });
    await page.mouse.move(pts.bx, pts.by, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    await page.locator('button.noteback-fab').click();
    const ta = page.locator('.nb-popover textarea');
    await ta.waitFor({ state: 'visible', timeout: 3000 });
    await ta.fill('comment spanning two sections');
    await page.locator('.nb-savecomment').click();
    await page.waitForTimeout(500);

    // --- Draft 2: open the earlier-feedback entry's popup ---
    serveMode = 'd2';
    await page.goto(baseURL + '?v=ms2');
    await page.waitForTimeout(400);
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);
    await page.locator('.nb-hist-item').first().click();
    await page.waitForTimeout(400);

    const headings = await popupHeadings(page);
    assert.ok(headings.includes('Overview'), 'start-of-selection section is present');
    assert.ok(headings.includes('Architecture'), 'end-of-selection section is present too (not just the start)');
  } finally {
    await context.close();
  }
});
