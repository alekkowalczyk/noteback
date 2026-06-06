# Click-to-activate on any (https) site — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user activate Noteback on any origin (their own https-hosted docs) with a one-click "Annotate this page" button in the popup, using the existing `activeTab` permission — no new host permission, no install-time prompt.

**Architecture:** When the popup opens on an origin Noteback doesn't auto-inject (`classifyOrigin` → `'other'`), it shows an "Annotate this page" button. Clicking it `chrome.scripting.executeScript`s a flag-setter (`window.__notebackForceActivate = true`) and then the manifest's `content_scripts[0].js` list into the tab. `content-script.js` reads the flag and mounts unconditionally, bypassing the `nb:settings` predicate. Activation is ephemeral per visit; annotation data persists per-URL in `chrome.storage.local`.

**Tech Stack:** Vanilla JS, MV3 Chrome extension (`activeTab` + `chrome.scripting`), Node built-in test runner. Zero dependencies, no build step (per `CLAUDE.md` hard constraints).

**Testing reality (read first):** This feature is `chrome.*` glue across `popup.js` and `content-script.js` — neither has Node-testable seams, and both have **zero** unit tests today (the repo's pattern: pure modules like `origin-policy` are unit-tested; popup/content-script are verified live). `origin-policy.js` is **intentionally unchanged**, so there is no new pure logic to TDD. Verification is therefore: **`npm run test:unit`** as a **regression guard** (proves the shared/pure modules still pass) + the structured **live verification** in Task 5. Do not invent fake unit tests for the chrome glue.

> **Branch note (test command changed):** the branch advanced — plain `npm test`
> now also runs a Playwright browser e2e (`test/e2e/`) that needs the chromium
> binary and is about the *unrelated* history feature. Use **`npm run test:unit`**
> (`node --test "test/*.test.js"`, top-level only) as the regression guard for
> this work; it requires no Playwright and currently passes **149** tests.

**Spec:** `docs/2026-06-05-extension-click-to-activate-any-site.md`

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/content/content-script.js` | modify | Honor `window.__notebackForceActivate`: mount unconditionally, skip settings. |
| `src/popup/popup.js` | modify | PING-first `refreshState`; render "Annotate this page"; inject runtime on click. |
| `src/popup/popup.css` | modify | Two small style rules for the annotate prompt. |
| `CONTRACTS.md` | modify | New §1.4 documenting the click-to-activate path. |
| `CLAUDE.md` | modify | One gotcha: injection list sourced from `getManifest()`, never copied. |
| `manifest.json` | **none** | `activeTab` + `scripting` already present; no host permission added. |
| `src/popup/popup.html` | **none** | The prompt reuses the existing `#nb-onboarding` slot (like the file-access card). |
| `src/content/origin-policy.js` | **none** | Predicate unchanged; `'other'` still not active. We bypass it via the flag. |

---

## Task 1: Force-activate flag in the content script

**Files:**
- Modify: `src/content/content-script.js` (the activation-lifecycle block, ~lines 166–186)

- [ ] **Step 1: Replace the activation block**

Find this block (it begins right after the `applySettings` function):

```js
  function applySettings(settings) {
    if (shouldActivate(settings)) mount();
    else unmount();
  }

  // Initial decision from stored settings.
  readSettings().then(applySettings);

  // React live to popup-driven changes (no page reload needed).
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      applySettings(changes[SETTINGS_KEY].newValue || null);
    });
  }
```

Replace it with:

```js
  function applySettings(settings) {
    if (shouldActivate(settings)) mount();
    else unmount();
  }

  // Click-to-activate (unsupported origins). When the popup injects us on an
  // 'other' origin via activeTab, it first sets window.__notebackForceActivate.
  // The user's click IS the opt-in, so we mount unconditionally and do NOT
  // consult nb:settings (the per-type/per-site predicate governs only
  // file/localhost/127). Such pages also ignore live settings changes.
  if (window.__notebackForceActivate) {
    mount();
  } else {
    // Initial decision from stored settings.
    readSettings().then(applySettings);

    // React live to popup-driven changes (no page reload needed).
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[SETTINGS_KEY]) return;
        applySettings(changes[SETTINGS_KEY].newValue || null);
      });
    }
  }
```

- [ ] **Step 2: Sanity-check the file parses (no syntax break)**

Run: `node --check src/content/content-script.js`
Expected: no output, exit 0. (`--check` parses without executing; `chrome.*` is never touched.)

- [ ] **Step 3: Regression — unit suite still green**

Run: `npm run test:unit`
Expected: 149 tests pass (this change touches no pure module; `origin-policy.test.js` and the rest are unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/content/content-script.js
git commit -m "feat(content): mount unconditionally on window.__notebackForceActivate

Click-to-activate path: when the popup injects us on an unsupported
origin via activeTab, the gesture is the opt-in — mount without
consulting nb:settings.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Popup — PING-first state + on-demand injection

**Files:**
- Modify: `src/popup/popup.js` (`refreshState` ~lines 129–155; new functions after `hideOnboarding` ~line 227)

- [ ] **Step 1: Make `refreshState` PING-first (handle `'other'` in the catch)**

Replace the whole `refreshState` function:

```js
  function refreshState(tab) {
    if (!tab) return Promise.resolve();
    if (!tabInfo || tabInfo.type === 'other') {
      hideSiteRow();
      setStatus('Noteback works on local file:// and localhost documents.');
      disableActions(true);
      return Promise.resolve();
    }
    return ping(tab.id).then(function (pong) {
      // Content script is injected (PING answered).
      hideOnboarding();
      if (pong && pong.booted) {
        disableActions(false);
        showSiteRow(true);
        setStatus(countLabel(pong));
      } else {
        // Injected but dormant by settings.
        disableActions(true);
        showSiteRow(false);
        setStatus('Noteback is off on this site.');
      }
    }).catch(function () {
      // Not injected at all (file access off, or page still loading).
      hideSiteRow();
      return handleNotBooted(tabInfo.type === 'file');
    });
  }
```

with:

```js
  function refreshState(tab) {
    if (!tab) return Promise.resolve();
    return ping(tab.id).then(function (pong) {
      // Content script is injected (PING answered).
      hideOnboarding();
      if (pong && pong.booted) {
        disableActions(false);
        showSiteRow(true);              // no-ops for 'other' origins
        setStatus(countLabel(pong));
      } else {
        // Injected but dormant by settings (file/localhost/127 only).
        disableActions(true);
        showSiteRow(false);
        setStatus('Noteback is off on this site.');
      }
    }).catch(function () {
      // Not injected. Unsupported ('other') origins can be click-activated;
      // supported origins that didn't boot keep the existing path (file access
      // off, or page still loading).
      hideSiteRow();
      if (tabInfo && tabInfo.type === 'other') return showAnnotatePrompt();
      return handleNotBooted(tabInfo && tabInfo.type === 'file');
    });
  }
```

- [ ] **Step 2: Add the prompt + injection functions**

Immediately after the `hideOnboarding` function (`function hideOnboarding() { ... }`, ~line 227), insert:

```js
  /* --- annotate-this-page (unsupported origins) -------------------------- */

  /**
   * On an origin Noteback doesn't auto-inject (anything that isn't file://,
   * localhost, or 127.0.0.1), offer one-click activation. activeTab grants us
   * access to this tab the moment the user opened the popup, so we inject the
   * runtime on demand — no host permission, no prompt.
   */
  function showAnnotatePrompt() {
    disableActions(true);
    setStatus('');
    onboardingEl.hidden = false;
    onboardingEl.innerHTML =
      '<div class="nb-annotate">' +
      '  <p class="nb-annotate__lead">Annotate any document you open — highlight text and leave comments, then copy the feedback as Markdown.</p>' +
      '  <button id="nb-annotate-btn" type="button" class="nb-btn nb-btn--primary">Annotate this page</button>' +
      '  <p class="nb-annotate__note">Stays on until you reload. Comments are saved for this page.</p>' +
      '</div>';
    const btn = document.getElementById('nb-annotate-btn');
    if (btn) btn.addEventListener('click', annotateThisPage);
    return Promise.resolve();
  }

  /**
   * Inject the extension runtime into the active tab on the user's click. We set
   * window.__notebackForceActivate (read by content-script.js to mount
   * unconditionally), then inject the SAME ordered file list the manifest would
   * auto-inject — sourced from getManifest() so it can never drift.
   */
  function annotateThisPage() {
    if (!activeTab || activeTab.id == null) { setStatus('No active document.'); return; }
    const cs = (chrome.runtime.getManifest().content_scripts || [])[0] || {};
    const files = cs.js || [];
    if (!files.length) { setStatus('Could not load Noteback.'); return; }
    setStatus('Activating Noteback…');
    chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: setForceActivate })
      .then(function () {
        return chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: files });
      })
      .then(function () { hideOnboarding(); return refreshState(activeTab); })
      .catch(function () { setStatus("Can't annotate this page."); });
  }

  /** Injected into the page's isolated world before the runtime files. */
  function setForceActivate() { window.__notebackForceActivate = true; }
```

> Note: `setForceActivate` is passed to `executeScript({ func })`, which serializes
> it via `.toString()` and runs it in the page's **isolated** world — the same
> world the injected content scripts use, so the flag is visible to them. It must
> reference no closure variables; it references only `window`. Leave it as a
> standalone function declaration.

- [ ] **Step 3: Sanity-check the file parses**

Run: `node --check src/popup/popup.js`
Expected: no output, exit 0.

- [ ] **Step 4: Regression — unit suite still green**

Run: `npm run test:unit`
Expected: 149 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.js
git commit -m "feat(popup): 'Annotate this page' click-to-activate on any origin

PING-first refreshState; on an unsupported origin, render an inject
button that executeScripts the manifest content_scripts list (read from
getManifest) into the active tab via activeTab.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Popup styles for the prompt

**Files:**
- Modify: `src/popup/popup.css` (append after the onboarding-card styles, ~line 139)

- [ ] **Step 1: Add the two rules**

After the `.nb-card .nb-btn { margin-top: 2px; }` rule, insert:

```css
/* --- annotate-this-page prompt (unsupported origins) -------------------- */
.nb-annotate__lead { margin: 0 0 10px; color: #3f3f46; }
.nb-annotate__note { margin: 8px 0 0; color: #6b7280; font-size: 11px; }
```

(The prompt renders inside `#nb-onboarding`, which already supplies `padding: 0 12px 12px` and `font-size: 12px`; the button reuses `.nb-btn .nb-btn--primary`. No other CSS is needed.)

- [ ] **Step 2: Commit**

```bash
git add src/popup/popup.css
git commit -m "style(popup): annotate-this-page prompt spacing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Documentation

**Files:**
- Modify: `CONTRACTS.md` (insert a new §1.4 after §1.3, which ends ~line 129)
- Modify: `CLAUDE.md` (add one bullet to "Gotchas that already bit us")

- [ ] **Step 1: Add CONTRACTS §1.4**

In `CONTRACTS.md`, find the end of §1.3 — the paragraph ending:

```
settings and always shows its UI.
```

Immediately after that line (before the `---` separator), insert:

```markdown

### 1.4 Click-to-activate on unsupported origins (extension mode only)

Noteback auto-injects only on `file://`, `localhost`, and `127.0.0.1` (the
manifest match list). On any **other** origin — e.g. a doc the user hosts over
https — the content script never loads, so `classifyOrigin` returns `'other'`
and `isActive` is `false` (§1.3). The popup offers a manual escape hatch:

- On an `'other'` origin whose `NOTEBACK_PING` goes unanswered, the popup shows
  an **"Annotate this page"** button instead of the disabled state.
- Clicking it uses the existing **`activeTab`** grant (no host permission, no
  install-time prompt) to `chrome.scripting.executeScript` two things into the
  tab: first a function that sets **`window.__notebackForceActivate = true`**,
  then the **same ordered file list the manifest would auto-inject**, read from
  `chrome.runtime.getManifest().content_scripts[0].js` (single source of truth —
  it must never be hard-copied, or it will drift).
- `content-script.js` reads the flag and calls `mount()` **unconditionally**,
  bypassing the `nb:settings` predicate — the click *is* the opt-in. Such pages
  do not subscribe to `chrome.storage.onChanged` (settings don't govern them).

Activation is **ephemeral**: a reload drops the injected runtime and the user
re-clicks. Annotation **data** persists per-URL in `chrome.storage.local`
(keyed `"noteback:" + docId`, §1.1), so highlights re-render on the next
activation. The injected list is the extension runtime only; canvas-only files
(`draft-history-core`, `snapshot`, `localstorage-state-adapter`) are excluded.
```

- [ ] **Step 2: Add the CLAUDE.md gotcha**

In `CLAUDE.md`, under the heading **"## Gotchas that already bit us"**, append this bullet to the list:

```markdown
- **The click-to-activate injection list is sourced from the manifest, never
  copied.** `popup.js` activates unsupported-origin pages by reading
  `chrome.runtime.getManifest().content_scripts[0].js` and `executeScript`-ing
  that exact list. Don't hard-code the file list in the popup — it would silently
  drift the next time a runtime file is added to the manifest, and the injected
  page would boot an incomplete runtime.
```

- [ ] **Step 3: Commit**

```bash
git add CONTRACTS.md CLAUDE.md
git commit -m "docs: document click-to-activate path (CONTRACTS §1.4 + CLAUDE gotcha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Live verification

No code; this is the real validation of the load-bearing assumption (`activeTab` + `executeScript` works with no `host_permissions`, the popup-open click being the qualifying gesture). We exercise the `'other'` path locally by serving over a **non-localhost** host so `classifyOrigin` returns `'other'`.

> We are NOT editing any `src/runtime/` file, so the `CLAUDE.md` "rebuild the
> canvas + cache-bust" step does **not** apply. We DO edit extension files, so
> after each change reload the unpacked extension, then reload the page.

- [ ] **Step 1: Load/reload the unpacked extension**

Open `chrome://extensions`, enable Developer mode, **Load unpacked** → the repo
root (`/Users/aleksanderkowalczyk/a7/noteback`). If already loaded, click its
reload ⟳. (Note: file-URL access is irrelevant here — we test an http origin.)

- [ ] **Step 2: Serve a doc on a non-localhost origin**

```bash
cd /Users/aleksanderkowalczyk/a7/noteback/examples
python3 -m http.server 8000 --bind 0.0.0.0
ipconfig getifaddr en0   # prints your LAN IP, e.g. 192.168.1.20
```

Open `http://<LAN-IP>:8000/spec.html` in Chrome. `classifyOrigin` sees the IP
hostname → `'other'`. (Alternative if no LAN: add `127.0.0.1 noteback.test` to
`/etc/hosts` and use `http://noteback.test:8000/spec.html`.)

- [ ] **Step 3: Activate via the button**

Click the Noteback toolbar icon. Expected: popup shows **"Annotate this page"**.
Click it. Expected: status → "Activating Noteback…", then the popup flips to the
normal Toggle / Copy / Save controls; the in-page launcher/overlay appears.

- [ ] **Step 4: Full annotation loop**

Select text in the doc, wait ~380 ms (the chip is debounced — `CLAUDE.md`), click
the chip, type a comment, Save. Open the sidebar → **Copy feedback** → confirm
Markdown is on the clipboard. (On an http LAN-IP origin `isSecureContext` is
false, so the `execCommand` clipboard fallback runs — it still works.) Then
**Save ▾ → HTML · with comments** → a canvas `.html` downloads.

- [ ] **Step 5: Persistence across reload (ephemeral injection, durable data)**

Reload the page. Expected: overlay gone (injection is per-visit). Reopen the
popup → "Annotate this page" again → click. Expected: the comment from Step 4
**re-renders from storage** (highlight reappears) — proving data persisted while
injection did not.

- [ ] **Step 6: Privileged page degrades gracefully**

Navigate to `chrome://extensions`. Click the toolbar icon → "Annotate this page"
→ click. Expected: status reads **"Can't annotate this page."** (no crash).

- [ ] **Step 7: Regression — supported origins unchanged**

```bash
python3 -m http.server 8000   # localhost bind (default)
```

Open `http://localhost:8000/spec.html`. Expected: Noteback **auto-activates with
no click** (the popup shows Toggle/Copy/Save immediately). Also reconfirm a
`file://` doc still works as before.

- [ ] **Step 8 (optional): Real https smoke test**

If a real https host is handy (a deploy / gist), repeat Steps 3–5 there. On https
(`isSecureContext` true) **Copy feedback** uses `navigator.clipboard` directly —
confirm it still copies.

- [ ] **Step 9: Final regression suite**

Run: `npm run test:unit`
Expected: 149 tests pass.

(Optional full suite incl. the unrelated history e2e: `npx playwright install
chromium` once, then `npm test`.)

---

## Self-review notes (already reconciled)

- **`popup.html` not in the file list** — the prompt renders into the existing
  `#nb-onboarding` slot via `innerHTML` (mirroring `showOnboarding`), so no HTML
  change is needed. This is a simplification from the spec's anticipated file
  list, in the reducing direction.
- **No new unit tests** — deliberate and consistent with the repo (chrome glue,
  `origin-policy` unchanged). `npm run test:unit` is the regression guard; Task 5
  is the behavioral proof.
- **Type/name consistency** — `window.__notebackForceActivate` (set by
  `setForceActivate` in Task 2, read in Task 1), `annotateThisPage`,
  `showAnnotatePrompt`, and the `getManifest().content_scripts[0].js` source are
  used identically across tasks and docs.
