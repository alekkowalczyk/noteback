'use strict';
/**
 * Browser e2e for the EMBEDDED canvas over file:// — the user-reported flow that
 * the http version-timeline test never exercised:
 *
 *   open spec.canvas.html (file://) -> add a comment -> edit the SAME file in
 *   place (change visible doc text, e.g. "v0.3" -> "v0.31") -> reload the SAME
 *   URL -> the comment must become an EARLIER VERSION, and the current draft must
 *   be EMPTY. The comment is version-scoped, not document-scoped.
 *
 * This reproduces the literal manual steps (one file, edited & reloaded), not the
 * two-distinct-paths shortcut. It runs over file:// (real localStorage, the
 * primary canvas use case) rather than http.
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
  canvasFile = path.join(os.tmpdir(), 'noteback-vsf-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', canvasFile], { stdio: 'pipe' });
  fileURL = pathToFileURL(canvasFile).href;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  try { fs.unlinkSync(canvasFile); } catch (e) {}
});

/** Read every nb:* localStorage record as {key, comments, hasSnapshot, versions}. */
function readNbKeys(page) {
  return page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.indexOf('nb:') !== 0) continue;
      let o = null; try { o = JSON.parse(localStorage.getItem(k)); } catch (e) {}
      out.push({
        key: k,
        comments: o && Array.isArray(o.comments) ? o.comments.length : null,
        hasSnapshot: !!(o && o.snapshotHtml),
        versions: o && Array.isArray(o.versions) ? o.versions.length : null
      });
    }
    return out;
  });
}

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
  await page.waitForTimeout(800); // async persist (snapshot compress + write)
}

async function openSidebar(page) {
  const launcher = page.locator('.nb-launcher');
  if (await launcher.count()) { try { await launcher.click({ timeout: 1500 }); } catch (e) {} }
  await page.waitForTimeout(300);
}

test('file://: editing the doc in place moves the comment to an earlier version (version-scoped)', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // --- open the canvas, clean slate, add ONE comment ---
    await page.goto(fileURL);
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);
    await createComment(page, 'feedback on draft v0.3');

    // The comment persisted to a version under the doc lineage (file:// localStorage).
    let keys = await readNbKeys(page);
    const vers1 = keys.filter((k) => k.key.indexOf('nb:ver:') === 0);
    const doc1 = keys.find((k) => k.key.indexOf('nb:doc:') === 0);
    assert.ok(doc1, 'a nb:doc lineage record exists');
    assert.strictEqual(doc1.versions, 1, 'lineage has exactly one version after the first comment');
    assert.strictEqual(vers1.length, 1, 'exactly one nb:ver record exists');
    assert.strictEqual(vers1[0].comments, 1, 'the comment persisted on that version (file:// localStorage works)');
    assert.strictEqual(vers1[0].hasSnapshot, true, 'a snapshot was captured at the first comment');
    const v1key = vers1[0].key;

    // --- edit the SAME file in place: "Draft v0.3" -> "Draft v0.31" ---
    const before = fs.readFileSync(canvasFile, 'utf8');
    const edited = before.replace('Draft v0.3 ', 'Draft v0.31 ');
    assert.notStrictEqual(edited, before, 'sanity: the "Draft v0.3" token was found and edited');
    fs.writeFileSync(canvasFile, edited);

    // reload the SAME url (mirrors Cmd+R / Cmd+Shift+R on the same file)
    await page.goto(fileURL + '?reload=' + 1); // query is ignored for the file path; forces a fresh nav
    await page.waitForTimeout(500);

    // The freshly-loaded doc really hashes the NEW text.
    const liveHasV031 = await page.evaluate(() => /v0\.31/.test(document.getElementById('noteback-doc-root').textContent || ''));
    assert.ok(liveHasV031, 'after reload the live doc-root contains the edited "v0.31" text');

    keys = await readNbKeys(page);
    const vers2 = keys.filter((k) => k.key.indexOf('nb:ver:') === 0);
    const doc2 = keys.find((k) => k.key.indexOf('nb:doc:') === 0);
    assert.strictEqual(doc2.versions, 2, 'the edit created a SECOND version in the lineage');

    const oldVer = vers2.find((k) => k.key === v1key);
    const newVer = vers2.find((k) => k.key !== v1key);
    assert.ok(oldVer && newVer, 'both the original and the new version records exist');
    assert.strictEqual(oldVer.comments, 1, 'the comment STAYED on the original (v0.3) version');
    assert.strictEqual(newVer.comments, 0, 'the new (v0.31) current version is EMPTY — comment did NOT bleed forward');

    // --- the UI reflects it: empty current draft + a Versions timeline ---
    await openSidebar(page);
    const currentCards = await page.locator('.nb-list > .nb-item').count();
    assert.strictEqual(currentCards, 0, 'the current draft shows NO comment cards (it is the empty v0.31)');
    assert.ok(await page.locator('.nb-versions').count() > 0, 'the Versions timeline group is rendered');
    assert.ok(await page.locator('.nb-ver-row:not(.active)').count() >= 1, 'an earlier-version row (v0.3) is shown');
  } finally {
    await context.close();
  }
});
