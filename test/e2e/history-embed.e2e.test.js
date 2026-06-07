'use strict';
/**
 * Browser e2e: "Save · HTML with comments and history".
 *
 * The version timeline normally lives only in the browser's localStorage, so a saved
 * canvas opened on a fresh machine shows comments but an empty timeline. This Save
 * option embeds the doc's FULL history (every version record + gzipped snapshot) into
 * a #noteback-history JSON block in the file; on reopen the embedded runtime seeds
 * localStorage from that block (only keys not already present), so the timeline
 * rehydrates from the file itself.
 *
 * The test: create two drafts (draft 1 becomes an earlier version of draft 2), assert
 * the "with comments and history" item only appears once there IS history, trigger the
 * save (capturing the produced HTML via a stubbed in-place saver), assert the embedded
 * block carries the doc + both version records, then reopen that HTML with localStorage
 * CLEARED and assert the timeline rehydrates (and a plain "with comments" save does NOT
 * carry the block).
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

let browser, server, originURL, baseURL, canvasHtml, serveMode = 'd1', savedHtml = null;

before(async () => {
  const out = path.join(os.tmpdir(), 'noteback-histembed-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // The captured "save with history" HTML is re-served at /saved.html.
    if (req.url && req.url.indexOf('/saved') === 0 && savedHtml) { res.end(savedHtml); return; }
    let body = canvasHtml;
    if (serveMode === 'd2') body = body.split('Technical Spec').join('Technical Spec — Revision 2');
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  originURL = 'http://127.0.0.1:' + server.address().port;
  baseURL = originURL + '/spec.canvas.html';
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
  await page.waitForTimeout(700);
}

/** Find the open overlay shadow root (the one carrying the footer). */
function timelineRows(page) {
  return page.evaluate(() => {
    function find(node) {
      if (node.shadowRoot && node.shadowRoot.querySelector('.nb-foot')) return node.shadowRoot;
      if (node.shadowRoot) { for (const c of node.shadowRoot.querySelectorAll('*')) { const r = find(c); if (r) return r; } }
      for (const c of node.children || []) { const r = find(c); if (r) return r; }
      return null;
    }
    const root = find(document.documentElement);
    if (!root) return { err: 'no shadow' };
    const rows = Array.from(root.querySelectorAll('.nb-ver-row')).map((r) => ({
      active: r.classList.contains('active'),
      name: (r.querySelector('.nb-ver-name') || {}).textContent
    }));
    let lsVer = 0;
    for (let i = 0; i < localStorage.length; i++) { if ((localStorage.key(i) || '').indexOf('nb:ver:') === 0) lsVer++; }
    return { rows, lsVer };
  });
}

test('Save "with comments and history" embeds history; reopen rehydrates the timeline', { timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // --- Draft 1 + comment (creates version 1) ---
    serveMode = 'd1';
    await page.goto(baseURL + '?v=d1');
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);
    await createComment(page, 'Draft 1 note');

    // With only the current draft (no earlier versions), the "with comments and
    // history" option must be HIDDEN — there is no history to embed yet.
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);
    await page.locator('.nb-save-btn').click();
    await page.waitForTimeout(250);
    assert.strictEqual(await page.locator('.nb-save-history').isVisible(), false,
      'with-history save is hidden when there is no earlier history');
    await page.keyboard.press('Escape');

    // --- Draft 2 + comment (draft 1 becomes an earlier version → history exists) ---
    serveMode = 'd2';
    await page.goto(baseURL + '?v=d2');
    await page.waitForTimeout(400);
    await createComment(page, 'Draft 2 note');
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);

    // Now the option is visible.
    await page.locator('.nb-save-btn').click();
    await page.waitForTimeout(250);
    assert.strictEqual(await page.locator('.nb-save-history').isVisible(), true,
      'with-history save appears once there is earlier history');

    // A PLAIN "with comments" save must NOT carry the embedded history block.
    await page.evaluate(() => {
      window.NotebackRuntime.exporter.saveCanvasInPlace = (html) => { window.__saved = html; return Promise.resolve(); };
      window.NotebackRuntime.exporter.downloadCanvas = (html) => { window.__saved = html; };
    });
    await page.locator('.nb-save-comments').click();
    await page.waitForTimeout(400);
    const plainHtml = await page.evaluate(() => window.__saved || '');
    assert.ok(plainHtml.length > 0, 'plain save produced HTML');
    const plainHasBlock = await page.evaluate((h) => !!new DOMParser().parseFromString(h, 'text/html').getElementById('noteback-history'), plainHtml);
    assert.strictEqual(plainHasBlock, false, '"with comments" save does NOT embed history');

    // The "with comments and history" save embeds the doc + both version records.
    await page.locator('.nb-save-btn').click();
    await page.waitForTimeout(250);
    await page.locator('.nb-save-history').click();
    await page.waitForTimeout(500);
    savedHtml = await page.evaluate(() => window.__saved || null);
    assert.ok(savedHtml, 'with-history save produced HTML');
    const embed = await page.evaluate((h) => {
      const el = new DOMParser().parseFromString(h, 'text/html').getElementById('noteback-history');
      if (!el) return { block: false };
      let data = null;
      try { data = JSON.parse(el.textContent); } catch (e) { return { block: true, parseError: e.message }; }
      const keys = Object.keys((data && data.entries) || {});
      return { block: true, docKeys: keys.filter((k) => k.indexOf('nb:doc:') === 0).length, verKeys: keys.filter((k) => k.indexOf('nb:ver:') === 0).length };
    }, savedHtml);
    assert.strictEqual(embed.block, true, 'the saved file carries a #noteback-history block');
    assert.ok(!embed.parseError, 'the embedded history is valid JSON (got ' + embed.parseError + ')');
    assert.strictEqual(embed.docKeys, 1, 'embeds the doc record');
    assert.strictEqual(embed.verKeys, 2, 'embeds both version records (draft 1 + draft 2)');

    // --- Reopen the with-history file with localStorage CLEARED (a "fresh machine").
    // The embedded runtime seeds localStorage from the block, so the timeline
    // rehydrates from the file itself. ---
    const page2 = await context.newPage();
    try {
      await page2.goto(originURL + '/saved.html');
      await page2.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
      await page2.reload();
      await page2.locator('.nb-launcher').waitFor({ state: 'attached', timeout: 8000 });
      await page2.locator('.nb-launcher').click();
      await page2.waitForTimeout(500);

      const t = await timelineRows(page2);
      assert.ok(!t.err, 'the reopened overlay mounted');
      // The seed repopulated localStorage with both version records.
      assert.strictEqual(t.lsVer, 2, 'history rehydrated into localStorage from the embedded block');
      // The timeline shows the current draft ("now") + the earlier version row.
      assert.ok(t.rows.some((r) => r.active), 'the "now" row is present');
      assert.ok(t.rows.some((r) => !r.active && /v\d/.test(r.name || '')), 'an earlier-version row rehydrated (got ' + JSON.stringify(t.rows) + ')');
    } finally {
      await page2.close();
    }
  } finally {
    savedHtml = null;
    await context.close();
  }
});
