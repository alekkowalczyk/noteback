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
const path = require('node:path');
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
