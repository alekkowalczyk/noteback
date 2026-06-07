'use strict';
/**
 * Browser e2e: the comment chip is anchored to the CURSOR (the selection's focus
 * point — where the user finishes dragging), not centered over the whole
 * selection above its first line.
 *
 *   forward drag  -> chip sits BELOW the cursor, centered on the cursor's x.
 *   backward drag -> chip flips ABOVE the cursor (so it never covers the
 *                    just-selected text), still centered on the cursor's x.
 *
 * Positioning is overlay DOM behaviour the Node suite can't observe. Runtime
 * stays zero-dependency; Playwright is a devDependency used only here.
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

before(async () => {
  // Build the canvas exactly as `npx noteback wrap` does, then serve it from memory.
  const out = path.join(os.tmpdir(), 'noteback-chip-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(canvasHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = 'http://127.0.0.1:' + server.address().port + '/spec.canvas.html';

  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

/** Scroll a long paragraph into view and return its viewport box. */
async function longParagraphBox(page) {
  return page.evaluate(() => {
    const root = document.getElementById('noteback-doc-root');
    const para = Array.from(root.querySelectorAll('p')).find((el) => (el.textContent || '').trim().length > 100);
    para.scrollIntoView({ block: 'center' });
    const r = para.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width };
  });
}

/**
 * Read the live selection's cursor (focus) x and vertical band, in viewport
 * coords — the same frame Playwright's boundingBox() reports in. The cursor is
 * the right edge of the last line for a forward drag, the left edge of the first
 * line for a backward one.
 */
async function selectionInfo(page, backward) {
  return page.evaluate((isBackward) => {
    const sel = getSelection();
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const edge = isBackward ? rects[0] : rects[rects.length - 1];
    const box = range.getBoundingClientRect();
    return { cursorX: isBackward ? edge.left : edge.right, selTop: box.top, selBottom: box.bottom };
  }, backward);
}

test('forward drag: chip sits below the cursor, centered on the cursor x', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(baseURL);
    await page.waitForTimeout(300);

    const box = await longParagraphBox(page);
    const y = box.y + 6;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.w - 8, 240), y, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(DEBOUNCE_MS);

    const info = await selectionInfo(page, false);
    const fab = page.locator('button.noteback-fab');
    await fab.waitFor({ state: 'visible', timeout: 3000 });
    const chip = await fab.boundingBox();

    const chipCenterX = chip.x + chip.width / 2;
    assert.ok(Math.abs(chipCenterX - info.cursorX) <= 24,
      `chip center x ${chipCenterX} should be near cursor x ${info.cursorX}`);
    assert.ok(chip.y >= info.selBottom - 2,
      `chip top ${chip.y} should sit below selection bottom ${info.selBottom}`);
  } finally {
    await context.close();
  }
});

test('backward drag: chip flips above the cursor, centered on the cursor x', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(baseURL);
    await page.waitForTimeout(300);

    const box = await longParagraphBox(page);
    const y = box.y + 6;
    const right = box.x + Math.min(box.w - 8, 280);
    // End the (backward) drag mid-paragraph, clear of the viewport's left edge,
    // so the chip centres on the cursor instead of clamping to the edge.
    await page.mouse.move(right, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, y, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(DEBOUNCE_MS);

    const info = await selectionInfo(page, true);
    const fab = page.locator('button.noteback-fab');
    await fab.waitFor({ state: 'visible', timeout: 3000 });
    const chip = await fab.boundingBox();

    const chipCenterX = chip.x + chip.width / 2;
    assert.ok(Math.abs(chipCenterX - info.cursorX) <= 24,
      `chip center x ${chipCenterX} should be near cursor x ${info.cursorX}`);
    assert.ok(chip.y + chip.height <= info.selTop + 2,
      `chip bottom ${chip.y + chip.height} should sit above selection top ${info.selTop}`);
  } finally {
    await context.close();
  }
});
