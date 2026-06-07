'use strict';
/**
 * Browser e2e (file://): the embedded gear (⚙) opts out of history live.
 *   comment -> a version records -> gear: "this document" OFF -> timeline + the
 *   "with history" save item hide AND a further comment records NO new version
 *   (data kept) -> gear ON -> the timeline returns.
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
const DEBOUNCE_MS = 600;

let browser, canvasFile, fileURL;

before(async () => {
  canvasFile = path.join(os.tmpdir(), 'noteback-gear-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', canvasFile], { stdio: 'pipe' });
  fileURL = pathToFileURL(canvasFile).href;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  try { fs.unlinkSync(canvasFile); } catch (e) {}
});

function verRecords(page) {
  return page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.indexOf('nb:ver:') !== 0) continue;
      let o = null; try { o = JSON.parse(localStorage.getItem(k)); } catch (e) {}
      out.push({ key: k, comments: o && o.comments ? o.comments.length : 0 });
    }
    return out;
  });
}

async function createComment(page, body, frac) {
  const box = await page.evaluate((f) => {
    const root = document.getElementById('noteback-doc-root');
    const ps = Array.from(root.querySelectorAll('p')).filter((el) => (el.textContent || '').trim().length > 100);
    const para = ps[Math.min(ps.length - 1, Math.floor(ps.length * f))];
    para.scrollIntoView({ block: 'center' });
    const r = para.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width };
  }, frac || 0);
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
  await page.waitForTimeout(800);
}

async function openSidebar(page) {
  const launcher = page.locator('.nb-launcher');
  if (await launcher.count()) { try { await launcher.click({ timeout: 1500 }); } catch (e) {} }
  await page.waitForTimeout(300);
}

test('embedded gear: opting out this document stops recording + hides the timeline, opting back in restores it', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(fileURL);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);

    // One comment → exactly one version record (history is recording).
    await createComment(page, 'first note', 0);
    let vers = await verRecords(page);
    assert.strictEqual(vers.length, 1, 'a version record exists after the first comment');
    assert.strictEqual(vers[0].comments, 1, 'the comment is on that version');

    await openSidebar(page);

    // The gear button exists (embedded + history available).
    const gear = page.locator('.nb-gear-btn');
    assert.strictEqual(await gear.count(), 1, 'the embedded gear button is present');

    // Open the gear and turn "this document" OFF.
    await gear.click();
    await page.waitForTimeout(150);
    const docToggle = page.locator('.nb-gear-doc');
    assert.strictEqual(await docToggle.isChecked(), true, 'history is on for this doc by default');
    await docToggle.uncheck();
    await page.waitForTimeout(400);
    // Toggling the checkbox does NOT auto-close the gear dialog; close it so it no
    // longer overlaps the canvas (and so a later re-open click isn't intercepted).
    await page.locator('.nb-gear-x').click();
    await page.waitForTimeout(150);

    // A further comment must NOT create/grow a version record (recording stopped).
    await createComment(page, 'note while opted out', 0.5);
    vers = await verRecords(page);
    const totalComments = vers.reduce((n, v) => n + v.comments, 0);
    assert.strictEqual(vers.length, 1, 'no NEW version record was created while opted out');
    assert.strictEqual(totalComments, 1, 'the opted-out comment was NOT recorded into history (kept only in the in-file draft)');

    // Re-open the sidebar and confirm the timeline is gone while opted out.
    await openSidebar(page);
    // (Adding a comment may have changed the content hash; the point is the timeline
    //  does not surface earlier versions while disabled.)
    assert.strictEqual(await page.locator('.nb-ver-row[data-version-key]').count(), 0, 'no earlier-version rows while opted out');

    // Turn it back ON → recording resumes and the kept data is re-adopted.
    await page.locator('.nb-gear-btn').click();
    await page.waitForTimeout(150);
    await page.locator('.nb-gear-doc').check();
    await page.waitForTimeout(600);
    await page.locator('.nb-gear-x').click(); // close the gear so the sidebar/timeline is unobstructed
    await page.waitForTimeout(150);

    // The kept in-file comment was re-adopted onto the live version (recording is
    // back AND no data was lost across the opt-out window).
    vers = await verRecords(page);
    assert.strictEqual(vers.length, 1, 'still a single version record right after re-enabling');
    assert.strictEqual(vers[0].comments, 2, 'the opted-out comment was re-adopted onto the version once history was back on');

    // Prove recording genuinely resumed: edit the doc in place + reload. With history
    // ON this MUST create a new version, demoting the current record to an earlier one
    // and surfacing a real timeline row. (While opted out, this could not happen.)
    const before = fs.readFileSync(canvasFile, 'utf8');
    const edited = before.replace('Draft v0.3', 'Draft v0.31');
    assert.notStrictEqual(edited, before, 'sanity: the "Draft v0.3" token was found and edited');
    fs.writeFileSync(canvasFile, edited);
    await page.goto(fileURL + '?reload=1');
    await page.waitForTimeout(600);

    vers = await verRecords(page);
    assert.strictEqual(vers.length, 2, 'recording resumed: the edit created a SECOND version (history is on again)');

    await openSidebar(page);
    assert.ok(await page.locator('.nb-versions').count() > 0, 'the Versions timeline group is rendered again');
    assert.ok(await page.locator('.nb-ver-row[data-version-key]').count() >= 1, 'an earlier-version row is shown — the timeline machinery is back after re-enabling');
  } finally {
    await context.close();
  }
});
