# Design — Click-to-activate Noteback on any (https) site

Date: 2026-06-05
Status: approved (brainstorm), pending implementation plan
Branch context: stacks on `feat/canvas-comment-persistence-history` (orthogonal —
touches `popup.js` + `content-script.js`, which that branch does not).

## Summary

Let the user annotate their **own hosted documents served over https** (or any
non-`file://`/`localhost` origin) with the same highlight → comment → copy-Markdown
loop they already have locally. The popup gains an **"Annotate this page"** button
that appears on otherwise-unsupported origins. Clicking it injects the extension
runtime into the current tab **on demand**, using the existing `activeTab`
permission — so there is **no new host permission and no install-time "read data on
all sites" prompt.**

Activation is **ephemeral per visit** (click each page load); annotation *data*
persists per-URL in `chrome.storage.local` exactly as it does on `file://`/
`localhost`. This is extension-only; the embedded canvas runtime is unaffected.

Builds directly on the per-origin activation machinery from
[`2026-06-05-popup-save-and-origin-activation.md`](./2026-06-05-popup-save-and-origin-activation.md)
(the `'other'` origin class, the `PING` `booted`/`dormant` fields, the
`mount()`/`unmount()` lifecycle).

## Motivation

Today the manifest only injects on `file:///*`, `http://localhost/*`, and
`http://127.0.0.1/*`, and `origin-policy.classifyOrigin` buckets everything else as
`'other'` (never active). A user who deploys an AI-generated spec/report to an
https URL — a preview deploy, a gist, an artifact viewer, an internal host — gets a
dead end: the popup says *"Noteback works on local file:// and localhost
documents"* and every control is disabled. The content they want to review is
**static HTML they authored**; only the *delivery scheme* differs. They want to
turn Noteback on there with one click.

## Non-goals (YAGNI)

- **No persistent per-host opt-in.** No `chrome.permissions.request`, no
  `chrome.scripting.registerContentScripts`. Activation is click-per-visit. The
  persistent path is a clean future follow-up that would touch only these same two
  files. *(Explicitly deferred per the brainstorm.)*
- **No broad `host_permissions`** (`<all_urls>`, `*://*/*`) and therefore **no
  install-time all-sites permission prompt.** The install footprint is unchanged.
- **No master on/off setting.** The button is always available on `'other'`
  origins (it is gesture-gated and harmless).
- **No first-class support for dynamic SPAs.** Anchoring/highlighting is built for
  static documents; on pages that constantly re-render, highlights may not survive.
  Best-effort only.
- **No change** to the `file://`/`localhost`/`127.0.0.1` paths, to
  `origin-policy.js`, to settings, or to the canvas runtime.

---

## Mechanism

`activeTab` + `chrome.scripting.executeScript`.

When the user invokes the extension (clicks its toolbar icon → the popup opens),
Chrome grants the extension temporary host access to **that one active tab** — no
prompt. With that grant the popup can `executeScript` into the tab. We inject the
same ordered runtime the manifest would normally auto-inject, but programmatically
and only on the user's gesture.

The activation predicate in `origin-policy.js` is **untouched**: `'other'` still
classifies as not-active. We do **not** add an allowlist or consult settings.
Instead, the injection sets a one-shot flag — `window.__notebackForceActivate` —
that tells the content script "the user's click *is* the opt-in; mount
unconditionally." The click is the consent; nothing is persisted to gate it.

### Flow

1. User is on `https://mydoc.example.com/spec.html` and clicks the Noteback
   toolbar icon → popup opens → `activeTab` granted for this tab.
2. Popup `PING`s the tab. No content script was auto-injected on an `'other'`
   origin, so the `PING` rejects (no receiver).
3. Popup sees `tabInfo.type === 'other'` and **not booted** → renders the
   **"Annotate this page"** primary button (replacing today's disabled dead end).
4. User clicks it. The popup injects, in order:
   - `executeScript({ target:{tabId}, func })` where `func` sets
     `window.__notebackForceActivate = true`;
   - `executeScript({ target:{tabId}, files })` with the runtime file list.
5. The injected `content-script.js` sees the force flag → calls `mount()`
   immediately, **skipping** the origin/settings gate. Overlay mounts.
6. Popup re-runs `refreshState`; the `PING` now succeeds (`booted`) → the normal
   Toggle / Copy / Save controls light up. Reopening the popup later on the same
   (still-loaded) page shows those controls directly.

### Injection list = single source of truth

The file list is read from
**`chrome.runtime.getManifest().content_scripts[0].js`**, not hard-coded in the
popup. This guarantees the injected set can never drift from the auto-injected set
as files are added (e.g. the persistence/history branch). Note this is the
**extension** runtime list (`anchor`, `state`, `markdown`, `highlight`, `overlay`,
`infile-state-adapter`, `exporter`, `boot`, `chrome-storage-adapter`,
`origin-policy`, `content-script`). It deliberately **excludes** canvas-only files
(`draft-history-core`, `snapshot`, `localstorage-state-adapter`), which live in
`web_accessible_resources` — so an https injection behaves **identically to a
`localhost` injection today**, inheriting whatever the persistence branch does in
extension mode. The two features compose without interacting.

---

## Changes

### 1. Manifest — none

`activeTab` and `scripting` are already present. No `host_permissions` change, no
`content_scripts` match change. This is the central property of this approach.

### 2. `src/content/content-script.js` — honor the force flag

The activation block today is:

```js
readSettings().then(applySettings);
if (chrome.storage && chrome.storage.onChanged) { /* re-evaluate live */ }
```

Wrap it:

```js
if (window.__notebackForceActivate) {
  mount();                       // click-to-activate: the gesture is the opt-in
} else {
  readSettings().then(applySettings);
  if (chrome.storage && chrome.storage.onChanged) { /* …unchanged… */ }
}
```

A force-activated page is therefore **not** governed by `nb:settings` (the per-type
switches and per-site toggle don't apply to `'other'` origins, by design) and does
not subscribe to settings changes. Everything else in the file — the message
listener, the export hooks, the `__notebackBooted` re-injection guard — is
untouched. A second injection (second click in a new popup session) re-runs the
file list, hits `if (window.__notebackBooted) return;` at the top, and is a safe
no-op.

### 3. `src/popup/popup.js` — PING-first state + injection

- **Restructure `refreshState`** to `PING` regardless of origin type, instead of
  short-circuiting `'other'` to a disabled message:
  - `booted` → normal controls (`disableActions(false)`; the per-site row already
    no-ops for `'other'`, so it stays hidden).
  - not injected **and** `type === 'other'` → render **"Annotate this page"**.
  - not injected **and** `type ∈ {file,localhost,127}` → existing onboarding /
    "reload" path, unchanged.
  - injected-but-dormant → existing "off on this site" path, unchanged.
- **New `annotateThisPage()`**: reads the file list from `getManifest()`,
  `executeScript`s the force-flag `func` then the `files`, and on success re-runs
  `refreshState(activeTab)` so the popup flips to the active controls. On rejection
  (a privileged page) sets status *"Can't annotate this page."*

  > Driven from the popup (it holds the `activeTab` grant) rather than the service
  > worker — simplest, no new message type. A worker-driven `NOTEBACK_INJECT`
  > message is an equivalent alternative if we later want the toolbar-click (no
  > popup) path to inject too.

### 4. `src/popup/popup.html` / `popup.css` — the button

Add an "Annotate this page" primary button (reusing the existing onboarding-card
visuals) shown in the body slot for the `'other'`-not-booted state. Minimal markup
+ styling; no new layout.

### 5. Docs

- **`CONTRACTS.md`** — document the click-to-activate path: the
  `window.__notebackForceActivate` flag, that `'other'` origins mount via
  `activeTab` injection and are **not** governed by `nb:settings`, and that the
  injection list is sourced from `content_scripts[0].js`.
- **`CLAUDE.md`** — add a one-line gotcha: the injection list must stay sourced
  from `getManifest()` (never hard-copied) so it can't drift.

---

## Popup states (body slot)

```
type='other', not booted          type='other', booted (after click)
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ Noteback              ⓘ ⚙︎ │   │ Noteback              ⓘ ⚙︎ │
├─────────────────────────────┤   ├─────────────────────────────┤
│  Annotate documents on any  │   │ [ Toggle sidebar          ] │
│  site you open.             │   │ [ Copy feedback           ] │
│                             │   │ [ Save ▾                  ] │
│  [ Annotate this page     ] │   │                             │
├─────────────────────────────┤   ├─────────────────────────────┤
│ status line                 │   │ Ready on "spec".            │
└─────────────────────────────┘   └─────────────────────────────┘
```

The per-site toggle row stays hidden for `'other'` (no settings governance);
the gear panel (file/localhost/127 switches) is unchanged.

## State interactions / edge cases

- **Privileged pages** (`chrome://`, Web Store, `view-source:`, the PDF viewer):
  `executeScript` rejects → *"Can't annotate this page."* No crash.
- **Re-click / already booted:** idempotent via the top-of-file `__notebackBooted`
  guard; the second injection mounts nothing new.
- **Reload = ephemeral:** a page reload drops the injected runtime; the popup shows
  "Annotate this page" again. Re-clicking re-mounts and the highlights **re-render
  from `chrome.storage.local`** (keyed on `location.href`) — data persists, only
  the injection is per-visit. *(This is the activeTab tradeoff, chosen
  deliberately.)*
- **Clipboard:** https is a secure context, so `navigator.clipboard.writeText`
  works directly — no `execCommand` fallback needed (unlike `file://`).
- **Strict CSP (`style-src`):** an injected overlay `<style>` *could* be blocked on
  a locked-down site. For the user's own hosted docs (they control the CSP) this is
  a non-issue; documented as best-effort, not a code concern.
- **Dynamic SPAs:** out of scope (see Non-goals).
- **`activeTab` window:** the grant lasts until the tab navigates; injection fires
  immediately on click, well inside it.
- **Persistence/history branch:** no interaction — the injected list excludes
  canvas-only files, so https injection == localhost injection in extension mode.

## Testing

- **Unit (`node --test`):** none added. `origin-policy.js` is unchanged, so its
  existing truth-table tests stand. The new logic is `chrome.*` glue
  (`executeScript`, `getManifest`, popup wiring) that the Node harness can't
  exercise; no fake coverage will be written for it.
- **Manual / live (per `CLAUDE.md` live-verification notes):**
  - Open a static doc over a real **non-localhost https host** → popup shows
    "Annotate this page" → click → overlay mounts → select text → leave a comment
    → **Copy feedback** produces Markdown → **Save ▾** exports a canvas.
  - **Reload** the page → overlay gone; reopen popup → "Annotate this page"
    → click → prior highlights **re-render from storage** (persistence proof).
  - **`chrome://extensions`** → click → status reads *"Can't annotate this page."*
  - **Regression:** a `localhost` doc still **auto-activates** with no click
    (manifest match path untouched).

## Files touched (anticipated)

- `manifest.json` — **none**.
- `src/content/content-script.js` — force-flag short-circuit in the activation
  block.
- `src/content/origin-policy.js` — **none** (explicitly unchanged).
- `src/popup/popup.js` — PING-first `refreshState`, `annotateThisPage()` injection
  helper, "Annotate this page" render.
- `src/popup/popup.html` / `src/popup/popup.css` — the button.
- `CONTRACTS.md` — document the click-to-activate path + force flag.
- `CLAUDE.md` — one-line gotcha (injection list sourced from `getManifest()`).
- `test/` — **no new unit tests** (chrome-glue); manual/live verification only.
