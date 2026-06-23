'use strict';
/**
 * Browser e2e (file://): a painted comment highlight stays readable in a DARK
 * document. The honey swatch (`mark.noteback-highlight`) has a FIXED light
 * background, so its text must always be a dark ink — never `color:inherit`.
 * Regression: inheriting let a dark-mode page's light text land on the light-
 * yellow swatch (white-on-honey, unreadable). The print path keeps `inherit`
 * (transparent background) and is intentionally not exercised here.
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

let browser, canvasFile, fileURL;

before(async () => {
  canvasFile = path.join(os.tmpdir(), 'noteback-darkhl-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', canvasFile], { stdio: 'pipe' });
  fileURL = pathToFileURL(canvasFile).href;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  try { fs.unlinkSync(canvasFile); } catch (e) {}
});

test('a painted highlight uses a dark ink, not the inherited (dark-mode) text colour', { timeout: 90000 }, async () => {
  // Emulate a dark-mode reader: prefers-color-scheme: dark.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await page.goto(fileURL);
    // Wait for the runtime to inject its light-DOM <style> (carries the highlight rule).
    await page.locator('style[data-noteback-ui="fab"]').waitFor({ state: 'attached', timeout: 5000 });

    const rgb = await page.evaluate(() => {
      // Simulate a dark document: a wrapper forcing WHITE text, with a highlight
      // inside it. If the highlight inherited, it would be white (unreadable on honey).
      const host = document.createElement('p');
      host.style.color = 'rgb(255, 255, 255)';
      const mark = document.createElement('mark');
      mark.className = 'noteback-highlight';
      mark.setAttribute('data-noteback-id', 'darktest');
      mark.textContent = 'readable?';
      host.appendChild(mark);
      document.body.appendChild(host);
      const c = getComputedStyle(mark).color;
      host.remove();
      const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    });

    assert.ok(rgb, 'the highlight has a computed text colour');
    // It must NOT have inherited the white page text.
    assert.ok(!(rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255),
      'highlight text did not inherit the page\'s white (dark-mode) colour');
    // It must be a dark ink — high contrast against the light honey swatch.
    const maxChannel = Math.max(rgb[0], rgb[1], rgb[2]);
    assert.ok(maxChannel < 110,
      'highlight text is a dark ink (max channel ' + maxChannel + ' < 110), readable on the honey swatch');
  } finally {
    await context.close();
  }
});
