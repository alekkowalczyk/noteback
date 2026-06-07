'use strict';
/**
 * Browser e2e (file://): the Noteback overlay is ALWAYS ON TOP of page content.
 *
 * Regression for: on some pages a high-z-index element painted OVER the sidebar /
 * the "Noteback" launcher button. Root cause — the shadow host
 * ([data-noteback-ui="panel"]) is position:fixed but had z-index:auto, so it lost
 * the root stacking context to any page element with a positive z-index. The huge
 * z-index values INSIDE the shadow (sidebar/launcher) only order things within the
 * host, so they couldn't lift the host above page content. Fix: the host carries
 * the maximal z-index.
 *
 * Proof: inject a full-viewport fixed page <div> with a near-max z-index over the
 * launcher, then hit-test the launcher's center — document.elementFromPoint must
 * return the Noteback host (shadow encapsulation retargets to the light-DOM host),
 * NOT the page overlay.
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
  canvasFile = path.join(os.tmpdir(), 'noteback-stack-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', canvasFile], { stdio: 'pipe' });
  fileURL = pathToFileURL(canvasFile).href;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  try { fs.unlinkSync(canvasFile); } catch (e) {}
});

test('a high-z-index page element does NOT cover the Noteback launcher (overlay is always on top)', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(fileURL);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);

    // The launcher is rendered (it lives inside the shadow host's uiRoot).
    const pt = await page.evaluate(() => {
      const host = document.querySelector('[data-noteback-ui="panel"]');
      if (!host || !host.shadowRoot) return null;
      const launcher = host.shadowRoot.querySelector('.nb-launcher');
      if (!launcher) return null;
      const r = launcher.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    assert.ok(pt, 'the launcher is present and painted (have its center point)');

    // A hostile page element: full-viewport, fixed, near-maximal z-index, covering
    // the launcher. (One below the 32-bit max so the fixed host can still win.)
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'evil-overlay';
      d.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(255,0,0,0.01);';
      document.body.appendChild(d);
    });

    // Hit-test the launcher's center. With the host at the maximal z-index it wins
    // the root stacking context, so the topmost light-DOM element there is the
    // Noteback host (shadow retargeting), not the page overlay.
    const topMark = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      if (!el) return null;
      return (el.getAttribute && el.getAttribute('data-noteback-ui')) || el.id || el.tagName;
    }, pt);

    assert.strictEqual(topMark, 'panel', 'the Noteback overlay host is on top of a high-z-index page element at the launcher');
  } finally {
    await context.close();
  }
});
