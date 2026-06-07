'use strict';
/**
 * Browser e2e for the canvas version-timeline UI (docs/design.md §14.4).
 *
 * The history ENGINE is unit-tested (Node); this guards the OVERLAY DOM that the
 * Node suite has no equivalent for: the "Versions" group, its rows, and the
 * open / copy-feedback actions. It drives a REAL drag-select comment on draft 1,
 * then reloads the SAME document with changed visible text (draft 2) — a new
 * content hash under the same baked doc-id, so draft 1 becomes an EARLIER version
 * — and asserts the timeline renders that earlier version as a peekable row with
 * enabled open + copy-feedback buttons.
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

let browser, server, baseURL, originURL, canvasHtml, serveMode = 'd1', checkoutServed = null;

before(async () => {
  // Build the canvas exactly as `npx noteback wrap` does, then serve it from memory.
  const out = path.join(os.tmpdir(), 'noteback-vt-e2e-' + process.pid + '.canvas.html');
  execFileSync('node', [path.join(REPO, 'bin', 'noteback.js'), 'wrap', path.join(REPO, 'examples', 'spec.html'), '-o', out], { stdio: 'pipe' });
  canvasHtml = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // The captured checkout HTML is re-served at /checkout.html on the SAME origin,
    // so the opened-version tab shares the canvas's localStorage history (exactly
    // what window.open(blob:) gives a localhost-served canvas).
    if (req.url && req.url.indexOf('/checkout') === 0 && checkoutServed) { res.end(checkoutServed); return; }
    // serveMode 'd2' rewrites visible text -> new content hash, same baked doc-id
    // -> same lineage, so the 'd1' comment shows up as an earlier version.
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
  await page.waitForTimeout(500); // let async persist (snapshot compress + write) settle
}

test('the Versions timeline renders an earlier version row with working open + copy actions', { timeout: 90000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // --- Draft 1: create a real anchored comment ---
    serveMode = 'd1';
    await page.goto(baseURL + '?v=d1');
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload();
    await page.waitForTimeout(300);

    // Body carries a </script> breakout payload: if the checkout builder serialized
    // the state <script> without escaping, this would close the state block early
    // and inject live markup into the opened tab (self-XSS). The escaping is
    // asserted below.
    const D1_BODY = 'Draft-1 feedback note </script><img src=x onerror=alert(1)>';
    await createComment(page, D1_BODY);

    // A version snapshot must be captured under the doc lineage at create time.
    const draft1 = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.indexOf('nb:ver:') === 0) {
          const v = JSON.parse(localStorage.getItem(k));
          out.push({ comments: (v.comments || []).length, hasSnapshot: !!v.snapshotHtml });
        }
      }
      return out;
    });
    assert.strictEqual(draft1.length, 1, 'one version persisted');
    assert.strictEqual(draft1[0].comments, 1, 'comment persisted on the version');
    assert.strictEqual(draft1[0].hasSnapshot, true, 'snapshot captured at create time');

    // --- Draft 2: same doc-id, different visible text -> draft 1 is now history ---
    serveMode = 'd2';
    await page.goto(baseURL + '?v=d2');
    await page.waitForTimeout(400);
    // Comment on draft 2 so the CURRENT draft is itself a stored version with a
    // snapshot — that's what lets a checkout tab later "open current" and rebuild it.
    await createComment(page, 'Comment on draft 2 (current)');
    await page.locator('.nb-launcher').click();
    await page.waitForTimeout(300);

    // The Versions group + label is present.
    const versions = page.locator('.nb-versions');
    assert.strictEqual(await versions.count(), 1, 'the History group is rendered');
    const groupLabel = await versions.locator('.nb-group-label').first().textContent();
    assert.strictEqual((groupLabel || '').trim(), 'History', 'the group carries the "History" label');

    // The timeline docks at the BOTTOM (its own band above the action buttons), not
    // inside the scrolling comment list, so the comments keep the available room.
    assert.strictEqual(await page.locator('.nb-versions-dock .nb-versions').count(), 1, 'the timeline lives in the bottom versions dock');
    assert.strictEqual(await page.locator('.nb-list .nb-versions').count(), 0, 'the timeline is NOT inside the scrolling comment list');

    // The info dialog carries the run-mode indicator (this is a saved canvas).
    assert.strictEqual(
      ((await page.locator('.nb-info-mode').textContent()) || '').trim(),
      'embedded mode',
      'the info dialog shows the embedded-mode indicator'
    );

    // The "now" row exists (current draft, no actions chevron).
    assert.strictEqual(await page.locator('.nb-ver-row.active').count(), 1, 'the "now" row is present');
    assert.strictEqual(
      await page.locator('.nb-ver-row.active .nb-ver-menu-btn').count(), 0,
      'the "now" row has no actions chevron'
    );

    // At least one EARLIER-version row (not the active "now" row).
    const earlier = page.locator('.nb-ver-row:not(.active)');
    assert.ok(await earlier.count() >= 1, 'at least one earlier-version row is rendered');
    const row = earlier.first();

    // Its version label is v1 (one earlier version => oldest == newest == v1).
    const vname = await row.locator('.nb-ver-name').first().textContent();
    assert.ok(/v1/.test(vname || ''), 'the earlier version is labelled v1 (got "' + vname + '")');

    // The per-row actions now live behind a chevron next to the version label. The
    // portaled .nb-ver-menu starts closed; clicking the chevron opens it with Open +
    // Copy feedback items, both ENABLED (the snapshot is stored).
    const chevron = row.locator('.nb-ver-menu-btn');
    assert.strictEqual(await chevron.count(), 1, 'the row has an actions chevron');
    assert.strictEqual(await page.locator('.nb-ver-menu.is-open').count(), 0, 'the actions menu starts closed');
    await chevron.click();
    await page.waitForTimeout(250);
    const verMenu = page.locator('.nb-ver-menu');
    assert.strictEqual(await page.locator('.nb-ver-menu.is-open').count(), 1, 'clicking the chevron opens the actions menu');
    const openItem = verMenu.locator('.nb-vm-open');
    const copyItem = verMenu.locator('.nb-vm-copy');
    assert.strictEqual(await openItem.count(), 1, 'the menu has an Open item');
    assert.strictEqual(await copyItem.count(), 1, 'the menu has a Copy feedback item');
    assert.strictEqual(await openItem.isDisabled(), false, 'Open is enabled (snapshot stored)');
    assert.strictEqual(await copyItem.isDisabled(), false, 'Copy feedback is enabled');
    // Escape closes the menu (so the next row-click peeks instead of re-toggling).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.nb-ver-menu.is-open').count(), 0, 'Escape closes the actions menu');

    // The row body shows a pointer cursor (it peeks on click).
    const cursor = await row.locator('.nb-ver-line').first().evaluate((el) => getComputedStyle(el).cursor);
    assert.strictEqual(cursor, 'pointer', 'the row body shows a pointer cursor (peekable)');

    // Peek: clicking the row body opens the snapshot modal with content.
    await row.locator('.nb-ver-line').first().click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.nb-hist-backdrop').count(), 1, 'clicking the row opens the snapshot peek');
    // The peek iframe shows the captured snapshot AND the LIVE painter ran on it,
    // wrapping the commented quote in a <mark class="noteback-highlight">.
    const peek = await page.evaluate(() => {
      function findFrame(node) {
        if (node.shadowRoot) {
          const f = node.shadowRoot.querySelector('iframe.nb-hist-frame');
          if (f) return f;
          for (const c of node.shadowRoot.querySelectorAll('*')) { const r = findFrame(c); if (r) return r; }
        }
        for (const c of node.children || []) { const r = findFrame(c); if (r) return r; }
        return null;
      }
      const f = findFrame(document.documentElement);
      if (!f) return null;
      const cd = f.contentDocument;
      const mark = cd.querySelector('mark.noteback-highlight');
      const panel = f.parentElement; // .nb-hist-panel (panel > backBar + frame)
      return {
        textLen: (cd.body.textContent || '').length,
        marks: cd.querySelectorAll('mark.noteback-highlight').length,
        frameH: Math.round(f.getBoundingClientRect().height),
        panelH: Math.round(panel.getBoundingClientRect().height),
        markBg: mark ? f.contentWindow.getComputedStyle(mark).backgroundColor : null
      };
    });
    assert.ok(peek && peek.textLen > 0, 'the peek iframe shows the captured snapshot');
    assert.ok(peek.marks >= 1, 'the live painter wrapped the commented quote in a <mark.noteback-highlight> (got ' + (peek && peek.marks) + ')');

    // The iframe FILLS the panel below the back bar. Regression: an iframe is a
    // replaced element, so top+bottom+height:auto did NOT stretch it — it collapsed
    // to the intrinsic ~150px and the doc sat in a thin strip at the top (~20%). An
    // explicit height:calc(100% - 38px) fixes it.
    assert.ok(
      peek.frameH >= peek.panelH * 0.8,
      'the snapshot iframe fills the panel (frame ' + peek.frameH + 'px of panel ' + peek.panelH + 'px — was ~150px)'
    );
    // The peek highlight matches the LIVE document (HIGHLIGHT_CSS is re-injected into
    // the clean snapshot): honey #ffe7a3, not a bare browser <mark> yellow.
    assert.strictEqual(peek.markBg, 'rgb(255, 231, 163)', 'the peek highlight uses the live honey styling (got ' + peek.markBg + ')');

    // Clicking a highlight inside the peek shows that comment in an in-place popover
    // (the comment body is rendered via textContent — never parsed as HTML). That the
    // popover appears AT ALL also proves the injected peek script survived the comment
    // body's literal "</script>" (escaped to "<\/script" before it lands in the srcdoc).
    const popInfo = await page.evaluate(() => {
      function findFrame(node) {
        if (node.shadowRoot) {
          const f = node.shadowRoot.querySelector('iframe.nb-hist-frame');
          if (f) return f;
          for (const c of node.shadowRoot.querySelectorAll('*')) { const r = findFrame(c); if (r) return r; }
        }
        for (const c of node.children || []) { const r = findFrame(c); if (r) return r; }
        return null;
      }
      const f = findFrame(document.documentElement);
      if (!f) return null;
      const cd = f.contentDocument;
      const mark = cd.querySelector('mark.noteback-highlight[data-noteback-id]');
      if (!mark) return null;
      mark.click(); // routes through the injected capture-phase click handler
      const pop = cd.querySelector('.nb-peek-pop.nb-show');
      return {
        shown: !!pop,
        body: pop ? ((pop.querySelector('.nb-peek-pop-body') || {}).textContent || '') : null,
        hasQuote: pop ? !!pop.querySelector('.nb-peek-pop-quote') : false,
        liveImg: !!cd.querySelector('img[src="x"]') // the </script> payload must NOT have rendered as live markup
      };
    });
    assert.ok(popInfo && popInfo.shown, 'clicking a peek highlight shows the comment popover');
    assert.ok(
      popInfo.body && popInfo.body.indexOf('Draft-1 feedback note') !== -1,
      'the peek popover shows the comment body as text (got "' + (popInfo && popInfo.body) + '")'
    );
    assert.ok(popInfo.hasQuote, 'the peek popover shows the quoted passage');
    assert.strictEqual(popInfo.liveImg, false, 'the </script> payload did not become live markup inside the peek');

    // "Back" control: present, reads "Back" (not "Back to current"), and closes the
    // peek. The redundant ✕ close button is gone (the full-width bar replaces it).
    const backCtrl = page.locator('.nb-hist-back');
    assert.strictEqual(await backCtrl.count(), 1, 'the "Back" control is present');
    const backText = (await backCtrl.first().textContent()) || '';
    assert.ok(/Back/.test(backText) && !/current/.test(backText), 'the control reads "Back" (got "' + backText + '")');
    assert.strictEqual(await page.locator('.nb-hist-close').count(), 0, 'the redundant ✕ close button is removed');
    await backCtrl.first().click();
    await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('.nb-hist-backdrop').count(), 0, 'clicking "Back" closes the peek');

    // --- Checkout: "open" builds a real annotatable canvas of the version. ---
    // window.open is unobservable headless, so capture the blob URL it's handed,
    // fetch the blob text, and assert the built canvas carries the version's
    // state block + comment body + the baked doc-id.
    await page.evaluate(() => {
      window.__nbOpenOriginal = window.open;
      window.__nbOpened = [];
      window.open = (url) => { window.__nbOpened.push(url); return null; };
    });
    let checkoutHtml = null;
    try {
      // Re-open the row's actions menu and click Open (checks out the version).
      await chevron.click();
      await page.waitForTimeout(250);
      await verMenu.locator('.nb-vm-open').click();
      await page.waitForTimeout(300);
      checkoutHtml = await page.evaluate(async () => {
        const url = (window.__nbOpened || [])[0];
        if (!url) return null;
        return await (await fetch(url)).text();
      });
    } finally {
      // Restore the real window.open so any later appended assertion doesn't
      // inherit the stub.
      await page.evaluate(() => { if (window.__nbOpenOriginal) window.open = window.__nbOpenOriginal; });
    }
    assert.ok(checkoutHtml, 'open() handed window.open a blob URL');
    assert.ok(
      checkoutHtml.indexOf('noteback-state') !== -1,
      'the checkout canvas carries the #noteback-state block'
    );
    assert.ok(
      checkoutHtml.indexOf('Draft-1 feedback note') !== -1,
      'the checkout canvas embeds the version\'s comment body'
    );
    assert.ok(
      checkoutHtml.indexOf('data-noteback-doc-id') !== -1,
      'the checkout canvas keeps the baked doc-id (it is a real canvas)'
    );

    // --- Safety: the </script> breakout payload must NOT survive unescaped. ---
    // The raw sequence would close the state <script> early (truncating the JSON
    // AND making the trailing markup live in the opened tab). The checkout builder
    // escapes "</script" -> "<\/script" before it lands in the script textContent.
    assert.ok(
      !checkoutHtml.includes('</script><img src=x onerror=alert(1)>'),
      'the raw </script> breakout sequence does NOT appear unescaped in the checkout HTML'
    );
    assert.ok(
      checkoutHtml.includes('<\\/script'),
      'the </script> in the comment body is escaped to <\\/script in the state block'
    );
    // Sanity: the comment data still round-trips (it lives safely inside the
    // escaped JSON string, not as live markup).
    assert.ok(
      checkoutHtml.includes('onerror=alert(1)'),
      'the comment body data survives (inside the escaped JSON state block)'
    );

    // --- Opened-version tab: timeline with "you are here" + open-current. ---
    // The checkout canvas bakes data-noteback-checkout=<live current key> so the
    // opened tab can mark the opened version "you are here" and offer a way back.
    assert.ok(
      checkoutHtml.indexOf('data-noteback-checkout') !== -1,
      'the checkout canvas bakes the data-noteback-checkout marker (the live current key)'
    );

    // Re-serve the captured checkout HTML on the SAME origin and open it in a fresh
    // page — that shares the canvas's localStorage history (as a localhost blob: tab
    // does), so the opened tab can render the timeline + offer "open current".
    checkoutServed = checkoutHtml;
    const page2 = await context.newPage();
    try {
      await page2.goto(originURL + '/checkout.html');
      await page2.locator('.nb-launcher').waitFor({ state: 'attached', timeout: 8000 });
      await page2.locator('.nb-launcher').click();
      await page2.waitForTimeout(400);

      // The "you are here" row is the OPENED version, relabelled "viewing".
      const viewing = page2.locator('.nb-ver-row.active.nb-ver-viewing');
      assert.strictEqual(await viewing.count(), 1, 'the opened version is the active "viewing" row');
      assert.strictEqual(
        ((await viewing.locator('.nb-ver-name').first().textContent()) || '').trim(),
        'viewing',
        'the now-row is relabelled "viewing" in a checkout'
      );
      assert.strictEqual(
        ((await viewing.locator('.nb-ver-here').first().textContent()) || '').trim(),
        'you are here',
        'the opened version is marked "you are here"'
      );

      // The "Open current" banner is present with its CTA.
      const bar = page2.locator('.nb-checkout-bar');
      assert.strictEqual(await bar.count(), 1, 'the checkout bar (open current) is present');
      assert.ok(
        /Open current/.test((await bar.locator('.nb-checkout-cta').textContent()) || ''),
        'the checkout bar offers "Open current"'
      );

      // The live/current draft appears below, badged "current".
      const curRow = page2.locator('.nb-ver-row.nb-ver-is-current');
      assert.strictEqual(await curRow.count(), 1, 'the live current draft is shown as a row');
      assert.strictEqual(
        ((await curRow.locator('.nb-ver-current').first().textContent()) || '').trim(),
        'current',
        'the live current draft row is badged "current"'
      );

      // Clicking the bar opens the CURRENT draft (d2 / "Revision 2") as a new canvas,
      // and that canvas is NOT itself marked a checkout (you can't check out current
      // from current). Stub window.open and inspect the produced blob.
      await page2.evaluate(() => {
        window.__nbOpenOriginal = window.open;
        window.__nbOpened = [];
        window.open = (url) => { window.__nbOpened.push(url); return null; };
      });
      let currentHtml = null;
      try {
        await bar.click();
        await page2.waitForTimeout(300);
        currentHtml = await page2.evaluate(async () => {
          const url = (window.__nbOpened || [])[0];
          return url ? await (await fetch(url)).text() : null;
        });
      } finally {
        await page2.evaluate(() => { if (window.__nbOpenOriginal) window.open = window.__nbOpenOriginal; });
      }
      assert.ok(currentHtml, 'clicking "Open current" opened a canvas');
      assert.ok(
        currentHtml.indexOf('Revision 2') !== -1,
        'the "Open current" canvas carries the CURRENT draft content (the d2 revision)'
      );
      // Parse the produced doc to check the ACTUAL attribute (the runtime SOURCE
      // mentions the attr name in a comment, so a substring check would false-match).
      const reCheckedOut = await page2.evaluate((h) => {
        const d = new DOMParser().parseFromString(h, 'text/html');
        const r = d.getElementById('noteback-doc-root');
        return r ? r.getAttribute('data-noteback-checkout') : 'NO-ROOT';
      }, currentHtml);
      assert.strictEqual(reCheckedOut, null, 'opening current from current does not re-mark it a checkout');
    } finally {
      await page2.close();
      checkoutServed = null;
    }
  } finally {
    await context.close();
  }
});
