'use strict';
/**
 * Browser e2e for the canvas version-timeline UI (snapshot-history-design §3).
 *
 * The history ENGINE is unit-tested (Node); this guards the OVERLAY DOM that the
 * Node suite has no equivalent for: the "Versions" group, its rows, and the
 * open / copy-feedback actions. It drives a REAL drag-select comment on draft 1,
 * then reloads the SAME document with changed visible text (draft 2) — a new
 * content hash under the same baked doc-id, so draft 1 becomes an EARLIER version
 * — and asserts the timeline renders that earlier version as a peekable row with
 * enabled open + copy-feedback buttons.
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
  const out = path.join(os.tmpdir(), 'noteback-vt-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    // serveMode 'd2' rewrites visible text -> new content hash, same baked doc-id
    // -> same lineage, so the 'd1' comment shows up as an earlier version.
    let body = canvasHtml;
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

test('the Versions timeline renders an earlier version row with working open + copy actions', { timeout: 90000 }, async () => {
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

    // A version snapshot must be captured under the doc lineage at create time.
    const draft1 = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.indexOf('nb:ver:') === 0) {
          const v = JSON.parse(localStorage.getItem(k));
          out.push({ comments: (v.comments || []).length, hasSnapshot: !!v.snapshotHtml });
        }
      }
      return out;
    });
    assert.strictEqual(draft1.length, 1, 'one version persisted');
    assert.strictEqual(draft1[0].comments, 1, 'comment persisted on the version');
    assert.strictEqual(draft1[0].hasSnapshot, true, 'snapshot captured at create time');

    // --- Draft 2: same doc-id, different visible text -> draft 1 is now history ---
    serveMode = 'd2';
    await page.goto(baseURL + '?v=d2');
    await page.waitForTimeout(400);
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);

    // The Versions group + label is present.
    const versions = page.locator('.nb-versions');
    assert.strictEqual(await versions.count(), 1, 'the Versions group is rendered');
    const groupLabel = await versions.locator('.nb-group-label').first().textContent();
    assert.strictEqual((groupLabel || '').trim(), 'Versions', 'the group carries the "Versions" label');

    // The "now" row exists (current draft, no actions).
    assert.strictEqual(await page.locator('.nb-ver-row.active').count(), 1, 'the "now" row is present');
    assert.strictEqual(
      await page.locator('.nb-ver-row.active .nb-ver-actions').count(), 0,
      'the "now" row has no action buttons'
    );

    // At least one EARLIER-version row (not the active "now" row).
    const earlier = page.locator('.nb-ver-row:not(.active)');
    assert.ok(await earlier.count() >= 1, 'at least one earlier-version row is rendered');
    const row = earlier.first();

    // Its version label is v1 (one earlier version => oldest == newest == v1).
    const vname = await row.locator('.nb-ver-name').first().textContent();
    assert.ok(/v1/.test(vname || ''), 'the earlier version is labelled v1 (got "' + vname + '")');

    // open + copy-feedback buttons exist and are ENABLED (snapshot present).
    const openBtn = row.locator('.nb-ver-open');
    const copyBtn = row.locator('.nb-ver-copy');
    assert.strictEqual(await openBtn.count(), 1, 'the open button exists');
    assert.strictEqual(await copyBtn.count(), 1, 'the copy-feedback button exists');
    assert.strictEqual(await openBtn.isDisabled(), false, 'open is enabled (snapshot stored)');
    assert.strictEqual(await copyBtn.isDisabled(), false, 'copy feedback is enabled');

    // The row body shows a pointer cursor (it peeks on click).
    const cursor = await row.locator('.nb-ver-line').first().evaluate((el) => getComputedStyle(el).cursor);
    assert.strictEqual(cursor, 'pointer', 'the row body shows a pointer cursor (peekable)');

    // Peek: clicking the row body opens the snapshot modal with content.
    await row.locator('.nb-ver-line').first().click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-hist-backdrop').count(), 1, 'clicking the row opens the snapshot peek');
    const peekText = await page.evaluate(() => {
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
      return (f.contentDocument.body.textContent || '').length;
    });
    assert.ok(peekText && peekText > 0, 'the peek iframe shows the captured snapshot');
  } finally {
    await context.close();
  }
});
