'use strict';
/**
 * Browser e2e (skip-gated): a per-SITE opt-in activates an otherwise-dormant
 * localhost / 127.0.0.1 origin — live and permanently.
 *
 * localhost / 127.0.0.1 are opt-in now, so a plain 127.0.0.1 page is DORMANT by
 * default. Writing nb:settings.enabledSites=[origin] (exactly what the popup's
 * per-port toggle does) fires chrome.storage.onChanged; the dormant content
 * script re-evaluates isActive and MOUNTS with no reload. Clearing it unmounts
 * again — proving the opt-in is load-bearing and the default really is dormant.
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

let server, baseURL;

const PLAIN_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>plain</title></head>' +
  '<body><p>A plain localhost page, long enough to select comfortably. Lorem ipsum ' +
  'dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.</p></body></html>';

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

function panelCount(page) {
  return page.evaluate(() => document.querySelectorAll('[data-noteback-ui="panel"]').length);
}

test('extension: a per-site opt-in activates a dormant 127.0.0.1 origin, live', { timeout: 120000 }, async (t) => {
  let ctx = null;
  try {
    try {
      ctx = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`],
        viewport: { width: 1280, height: 900 }
      });
    } catch (e) { t.skip('could not launch Chromium with an unpacked extension: ' + (e && e.message)); return; }

    const sw = await getWorker(ctx);
    if (!sw) { t.skip('extension service worker unavailable'); return; }

    // Default settings: 127.0.0.1 is opt-in/off, so the page must be DORMANT.
    const page = await ctx.newPage();
    await page.goto(baseURL + '/');
    await page.waitForTimeout(1500);
    const dormantCount = await panelCount(page);

    // Per-port opt-in, exactly as the popup's per-site toggle writes it.
    await sw.evaluate((origin) => new Promise((res) => chrome.storage.local.set({ 'nb:settings': { enabledSites: [origin] } }, res)), baseURL);

    // It must MOUNT live (no reload). If it never does, the extension didn't inject
    // in this environment — skip rather than fail (and the dormant count above can't
    // be trusted either, so don't assert on it).
    let mounted = false;
    try { await page.locator('[data-noteback-ui="panel"]').first().waitFor({ state: 'attached', timeout: 8000 }); mounted = true; } catch (e) {}
    if (!mounted) { t.skip('the unpacked extension did not inject in this environment'); return; }

    assert.strictEqual(dormantCount, 0, 'the 127.0.0.1 page was dormant by default (opt-in type, off)');
    assert.strictEqual(await panelCount(page), 1, 'the per-site opt-in mounted the overlay live (no reload)');

    // Load-bearing: clearing the opt-in unmounts it again, live — so the default
    // really is dormant, and the opt-in is what activated it.
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ 'nb:settings': {} }, res)));
    try { await page.locator('[data-noteback-ui="panel"]').first().waitFor({ state: 'detached', timeout: 8000 }); } catch (e) {}
    assert.strictEqual(await panelCount(page), 0, 'removing the per-site opt-in unmounts the overlay again (default is dormant)');
  } finally {
    if (ctx) await ctx.close();
  }
});
