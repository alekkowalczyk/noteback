# Inline version viewing (read-only + navigation) — design

**Date:** 2026-06-07
**Branch:** `feat/snapshot-history`
**Status:** approved (brainstorm) → ready for implementation plan

## Problem

Opening a past version from the history timeline launches it as a
`window.open(URL.createObjectURL(blob))` tab. When the source canvas is loaded
over `file://` — the primary canvas use case — that blob document gets an
**opaque ("null") origin**, and `window.localStorage` access **throws**
`SecurityError: Access is denied for this document` (reproduced with the repo's
own Chromium via Playwright).

Consequence chain in the opened tab:

1. `EMBEDDED_BOOT`'s `lsStore` factory catches the throw → `lsStore = null`
   (`src/canvas/exporter.js`).
2. The adapter degrades to `InFileStateAdapter`, which has **no `getHistory`**
   (`src/adapters/infile-state-adapter.js`).
3. Boot passes `history: null` to the overlay (`exporter.js` history facade is
   gated on `adapter.getHistory`).
4. `overlay.js renderVersions()` hits `if (!history) return;` and renders
   **nothing** — no "you are here", no "Open current", no timeline.

So the opened version tab shows no history panel at all. Even if the rows were
force-rendered, "Open current"/"open another version" call `history.getVersion`,
whose snapshot data lives in the unreachable parent `localStorage`.

**Why CI never caught it:** `test/e2e/version-timeline.e2e.test.js` re-serves the
checkout over the *same HTTP origin*, simulating a localhost `blob:` tab (which
*does* share `localStorage`). A `file://` `blob:` tab gets an opaque origin and
is denied. The bug ships while the test stays green.

## Decision

Replace the new-tab ("checkout") model with an **in-tab, side-by-side,
read-only** version view. Because it never leaves the tab, it stays on the same
origin and the existing `localStorage`-backed `history` adapter just works — the
opaque-origin problem is structurally avoided rather than worked around.

Scope decisions (confirmed with the user):

- **Read-only + navigation**, not annotatable. Viewing a past version never adds
  comments to it, so the content-hash version-scoping model is untouched.
- **No new-tab escape hatch.** The new-tab checkout is removed *entirely*.

## Key insight

On a live `file://` canvas the direct page's `localStorage` works (proven by
`version-scoping-file.e2e.test.js` reading `localStorage`, and by the probe
above where the parent `file://` page wrote `localStorage` fine). So `history`
is non-null in the live tab and the **timeline already renders there today**.
The bug lived *only* in the spawned blob tab. Inline viewing never spawns a tab,
so `history.getHistory`/`getVersion` are fully available. **The entire fix is
UI/UX inside `src/runtime/overlay.js`; no storage plumbing changes.**

## Design

### 1. Layout — inline view coexists with the sidebar

Today `openVersionPeek` renders a centered modal
(`.nb-hist-backdrop{position:fixed;inset:0;z-index:2147483647}`) that *covers*
the sidebar (`.nb-sidebar{position:fixed;top:0;right:0;width:360px}`).

Change the version view to a **side panel** that fills the document area beside
the sidebar:

- Panel: `position:fixed; top:0; left:0; right:360px; bottom:0;` at a z-index
  **below** the sidebar, so the 360px sidebar remains visible on the right with
  the live timeline.
- Entering a version view **force-opens** the sidebar (so the timeline shows).
- A slim top bar on the iframe: `Viewing v{n} · <date>` + a `← Back to current`
  button.
- Narrow viewport: the sidebar is `max-width:88vw`; on narrow screens the inline
  panel insets by the sidebar width and may be narrow. Acceptable for the
  desktop document-review use case; no special responsive mode in this pass.

### 2. Inline view mechanics — `openVersionPeek` → `openVersionInline(key)`

Reuse the existing snapshot internals verbatim:

`history.getVersion({versionKey})` → `DOMParser` parse → `paintHighlights` into
the parsed doc → re-inject `HIGHLIGHT_CSS + PEEK_POP_CSS` → `buildPeekPopoverScript`
(click-a-highlight-shows-its-comment still works) → `iframe.srcdoc`.

Differences from today's peek:

- Renders into the side panel (above), not a centered modal.
- Sets a new in-tab `viewingKey`.
- Re-renders the timeline so the sidebar reflects the current selection.
- Switching versions = call `openVersionInline` again with another key (swaps
  `srcdoc` + re-renders timeline).
- **The live document is never mutated**, so "Back to current"
  (`closeVersionInline()`) is just removing the panel and clearing `viewingKey`.

### 3. Viewing-aware timeline — generalize checkout logic to `viewingKey`

Introduce `let viewingKey = null` (the version key shown inline; null = live
draft). `renderVersions` / `renderNowRow` / `renderVersionRow` already contain
the "viewing / you are here / `nb-ver-viewing`" machinery — today driven by the
baked `checkoutCurrentKey`. Repoint that logic at `viewingKey`:

- `viewingKey` set:
  - the viewed version's row → **"you are here"** + `nb-ver-viewing` styling;
  - a **"Viewing an earlier version — Back to current"** bar (today's
    `renderCheckoutBar`, repurposed) that calls `closeVersionInline()`;
  - every other version row stays clickable to switch the inline view.
- `viewingKey` null → the timeline renders exactly as today (live-draft "now"
  row, no bar).

### 4. Remove the broken new-tab checkout

Delete from `src/runtime/overlay.js`:

- `openVersionTab`
- `buildVersionCanvasHtml`
- the `data-noteback-checkout` baking + the mount-time read/strip
- `checkoutCurrentKey`

Version-row chevron menu: drop the **"Open"** item (the broken new-tab path);
keep **"Copy feedback"**. Row-click opens the inline view.

No changes needed in `src/canvas/exporter.js`, `src/runtime/boot.js`, or
`src/content/content-script.js` — inline viewing uses the same-origin `history`
adapter that already exists.

### 5. Error handling

- Pruned snapshot (`html === ''`) → toast "This version has no saved snapshot";
  do not enter the view.
- `getVersion` rejects → toast; stay on current.

### 6. Testing

- **Rewrite `test/e2e/version-timeline.e2e.test.js`** for the inline flow — one
  page, no `window.open`/blob/re-serve: click a version row → the iframe view
  appears, the sidebar marks that version "viewing / you are here", "Back to
  current" is present, the sidebar stays visible; click another row → the view
  switches; "Back to current" → the iframe is gone and the live draft is
  restored. The `</script>`-breakout assertion stays, now against the peek
  `srcdoc` (already escaped by `buildPeekPopoverScript`).
- **Add a `file://` e2e** (reuse `version-scoping-file.e2e.test.js` infra): open
  a version inline and assert the timeline + "you are here" render — the direct
  regression guard for *this* bug, on the real environment the old test
  sidestepped.
- Node unit suite (pure-logic `anchor`/`state`/`markdown`) is unaffected.

### 7. Docs

- `CLAUDE.md`: remove/replace the now-obsolete gotchas about the checkout, the
  `data-noteback-checkout` marker, the blob-shares-localStorage tradeoff, and the
  iframe-height note insofar as it referenced the checkout. Add a short note that
  version viewing is in-tab, same-origin, read-only.
- `CONTRACTS.md`: update any checkout/`openVersionTab` references.
- `docs/design.md §14`: update the snapshot-history section to describe inline
  viewing instead of new-tab checkout.

## Files touched

- `src/runtime/overlay.js` — net **deletion** of the blob machinery; inline view
  + viewing-aware timeline.
- `test/e2e/version-timeline.e2e.test.js` — rewrite for the inline flow.
- A `file://` e2e (new or extended `version-scoping-file.e2e.test.js`).
- `CLAUDE.md`, `CONTRACTS.md`, `docs/design.md`.

## Out of scope (YAGNI)

- Annotating past versions.
- Any new-tab / separate-window version view.
- Approach A's embedded-history + in-memory-store fallback (only needed to make
  the *new-tab* model work on `file://`; obviated by going in-tab).
