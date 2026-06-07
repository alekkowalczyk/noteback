'use strict';
/**
 * Browser e2e: the EXTENSION must stand down on a self-contained canvas.
 *
 * The bug (found in manual testing): opening a saved canvas while the Noteback
 * extension is installed mounts TWO overlays. The canvas's inlined runtime boots
 * in the page's MAIN world; the extension content script runs in an ISOLATED
 * world. boot.js's single-mount guard is a per-world JS global (__notebackBooted),
 * so neither world sees the other's flag and the extension double-mounts — routing
 * the user's comments to chrome.storage while the canvas's localStorage history
 * stays empty (comments appear, but no version is ever recorded).
 *
 * The fix wires the stand-down through the only shared channel — the DOM. boot.js
 * stamps a synchronous [data-noteback-ui] mount marker (before its first await, so
 * it is present by the extension's document_idle); the content script reads it via
 * originPolicy.overlayMounted(document) and stands down.
 *
 * Test 1 (always runs): boot stamps the marker and mounts exactly one overlay.
 * Test 2 (skip-gated): with the real unpacked extension loaded, the extension
 * stands down on a canvas — one overlay, and a new comment persists to the
 * canvas's localStorage (the embedded runtime won), not to chrome.storage.
 *
 * Loading an unpacked extension is environment-sensitive (needs a Chromium that
 * supports extensions in the current headless mode). Test 2 SKIPS rather than
 * fails when the extension does not inject, so it never false-fails `npm test`.
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

let browser, server, baseURL, canvasHtml;

const PLAIN_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>plain</title></head>' +
  '<body><p>A plain page with no embedded Noteback runtime, long enough to select. ' +
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod.</p></body></html>';

before(async () => {
  const out = path.join(os.tmpdir(), 'noteback-standdown-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url && req.url.indexOf('/plain') === 0 ? PLAIN_HTML : canvasHtml);
  });
  // localhost so the extension's content_scripts match (file:// needs a per-extension
  // "allow file URLs" toggle that launch args can't set).
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port;

  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

/** Create a comment on the first long paragraph via a real drag-selection. */
async function createComment(page, body) {
  const box = await page.evaluate(() => {
    const root = document.getElementById('noteback-doc-root') || document.body;
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
  await page.waitForTimeout(800); // async persist (snapshot compress + write)
}

/** Count light-DOM overlay hosts (one per mounted overlay). */
function panelCount(page) {
  return page.evaluate(() => document.querySelectorAll('[data-noteback-ui="panel"]').length);
}

test('boot stamps the cross-world mount marker and mounts exactly one overlay', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(baseURL + '/canvas');
    // The launcher only appears once the overlay has mounted; wait for it.
    await page.locator('.nb-launcher').waitFor({ state: 'attached', timeout: 8000 });

    // boot.js appended a synchronous [data-noteback-ui="mount"] marker — the
    // cross-world signal the extension's stand-down keys off.
    const markers = await page.evaluate(() => document.querySelectorAll('[data-noteback-ui="mount"]').length);
    assert.strictEqual(markers, 1, 'boot stamped exactly one cross-world mount marker');

    // Exactly one overlay host (no self-double-mount).
    assert.strictEqual(await panelCount(page), 1, 'exactly one overlay is mounted');
  } finally {
    await context.close();
  }
});

test('the extension stands down on a canvas (single overlay; comment -> localStorage)', { timeout: 90000 }, async (t) => {
  let extContext = null;
  try {
    // Load the real unpacked extension (manifest at the repo root). Environment-
    // sensitive: if it cannot launch with the extension, skip rather than fail.
    try {
      // `channel: 'chromium'` selects the new-headless Chromium, which (unlike the
      // default bundled headless) loads unpacked extensions.
      extContext = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        args: [
          `--disable-extensions-except=${REPO}`,
          `--load-extension=${REPO}`,
        ],
        viewport: { width: 1280, height: 900 },
      });
    } catch (e) {
      t.skip('could not launch Chromium with an unpacked extension: ' + (e && e.message));
      return;
    }

    // Skip-gate: confirm the extension actually injects in this environment by
    // mounting its overlay on a PLAIN page (no embedded runtime there, so the
    // overlay can only come from the extension).
    const probe = await extContext.newPage();
    await probe.goto(baseURL + '/plain');
    let injected = false;
    try {
      await probe.locator('[data-noteback-ui="panel"]').first().waitFor({ state: 'attached', timeout: 6000 });
      injected = true;
    } catch (e) { injected = false; }
    await probe.close();
    if (!injected) {
      t.skip('the unpacked extension did not inject in this environment');
      return;
    }

    // The real scenario: open the canvas with the extension active.
    const page = await extContext.newPage();
    await page.goto(baseURL + '/canvas');
    await page.locator('.nb-launcher').waitFor({ state: 'attached', timeout: 8000 });
    await page.waitForTimeout(800); // give a (buggy) second overlay time to appear if it would

    // Without the fix this is 2 (embedded + extension). With it, the extension
    // stands down on the canvas: exactly one overlay.
    assert.strictEqual(await panelCount(page), 1, 'the extension stood down — only the embedded overlay is mounted');

    // And the decisive symptom: a new comment must reach the canvas's OWN
    // localStorage history (embedded won), not chrome.storage (extension).
    await createComment(page, 'extension stand-down: comment must hit localStorage');
    const ver = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.indexOf('nb:ver:') !== 0) continue;
        const v = JSON.parse(localStorage.getItem(k) || 'null') || {};
        out.push({ comments: (v.comments || []).length, hasSnapshot: !!v.snapshotHtml });
      }
      return out;
    });
    assert.strictEqual(ver.length, 1, 'one version record exists in the canvas localStorage');
    assert.strictEqual(ver[0].comments, 1, 'the comment persisted to localStorage (the embedded runtime owns the page)');
    assert.strictEqual(ver[0].hasSnapshot, true, 'a snapshot was captured for the version');
  } finally {
    if (extContext) await extContext.close();
  }
});
