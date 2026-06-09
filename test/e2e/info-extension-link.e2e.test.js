'use strict';
/**
 * Browser e2e (file://): the ⓘ "About" dialog shows the Chrome-extension link in
 * EMBEDDED mode (a saved canvas is a standalone file, so it points the reader to
 * the extension) — while the skill commands show in BOTH modes. The link is gated
 * to embedded mode; the extension-mode absence is covered in
 * extension-standdown.e2e.test.js (where the extension is actually loaded).
 *
 * Runtime stays zero-dependency; Playwright is a devDependency used only here.
 * Requires the chromium binary: `npx playwright install chromium`.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..', '..');
const STORE_URL = 'https://chromewebstore.google.com/detail/noteback/bgmcjepifnlgenbjlplaeapllkamcejc';

let browser, canvasFile, fileURL;

before(async () => {
  canvasFile = path.join(os.tmpdir(), 'noteback-infolink-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', canvasFile], { stdio: 'pipe' });
  fileURL = pathToFileURL(canvasFile).href;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  try { fs.unlinkSync(canvasFile); } catch (e) {}
});

test('embedded: the ⓘ dialog shows the skill commands AND a Chrome-extension link', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(fileURL);
    await page.waitForTimeout(300);

    // Open the sidebar, then the ⓘ "About" dialog.
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(250);
    // The gear (⚙) reuses the .nb-info class, so target the ⓘ button by aria-label.
    await page.locator('.nb-info[aria-label="About Noteback"]').click();
    const dialog = page.locator('.nb-info-dialog[aria-label="About Noteback"]');
    await dialog.waitFor({ state: 'visible', timeout: 3000 });

    // Skill commands show in both modes — present here.
    assert.ok(await dialog.locator('.nb-cmd-copy[data-cmd="npx noteback install-skill"]').count() >= 1,
      'the install-skill command is shown (skill info shows in both modes)');

    // Embedded-only: the Chrome Web Store link is present with the exact URL.
    const extLink = dialog.locator('.nb-info-ext a.nb-info-link');
    assert.strictEqual(await extLink.count(), 1, 'the Chrome-extension section/link is shown in embedded mode');
    assert.strictEqual(await extLink.getAttribute('href'), STORE_URL, 'the link points at the Chrome Web Store listing');
  } finally {
    await context.close();
  }
});
