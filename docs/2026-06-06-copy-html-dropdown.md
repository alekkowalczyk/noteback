# Design — "Copy html" split-dropdown beside "Copy feedback"

Date: 2026-06-06
Status: approved (brainstorm), pending implementation plan
Branch context: adds onto `feat/canvas-comment-persistence-history` (the branch
behind open PR #3); independent of the click-to-activate work already on it.

## Summary

Turn the **"Copy feedback"** control — in **both** the in-page sidebar footer and
the toolbar popup — into a **split button**. The main button keeps its current
action (copy feedback as Markdown). A new **▾ chevron** to its right opens a small
dropdown (mirroring the existing **Save ▾**) with two new actions:

- **Copy html (with feedback)** → the full self-contained feedback canvas (the
  same bytes as *Save → HTML · with comments*: highlights + notes + inlined
  runtime, re-openable), placed on the clipboard.
- **Copy html (clean)** → the original document with all Noteback stripped (the
  same bytes as *Save → HTML · clean copy*), placed on the clipboard.

Both write the **HTML source as plain text** (`writeText`, with the existing
`execCommand` fallback for `file://`) so it can be pasted into a file or editor.
Each ends with a toast: *"Copied HTML with feedback"* / *"Copied clean HTML"* /
*"Copy failed"*.

## Motivation

The Save ▾ menu already produces exactly these two HTML artifacts, but only as
**downloads**. Pasting the HTML straight into an editor, a gist, a chat, or a file
is a faster loop than save-then-reopen — especially for the "with feedback" canvas
the user wants to hand back to an AI or a colleague. "Copy feedback" already lives
right there; the artifacts already exist; we only need to redirect them to the
clipboard.

## Non-goals (YAGNI)

- **No new HTML artifacts.** The two payloads are byte-identical to the existing
  Save menu's "with comments" and "clean copy". We reuse the builders; we do not
  invent a third "lighter" format.
- **No rich-clipboard (`text/html` MIME).** "Copy html" means the **source**, as
  text — paste-into-an-editor, not paste-rendered-into-a-doc.
- **No PDF/clear in the copy menu.** Those stay in Save ▾ only.
- **No change** to the main button's Markdown action, to the Save menu, or to the
  per-mode line-number semantics.

---

## Architecture — reuse the builders, change only the sink

The save flows already build these strings; we redirect them to the clipboard. One
**mode-agnostic exporter hook** drives the sidebar in both runtime modes:

```
exporter.onCopyHtml(state, { clean }) -> Promise<string>
```

It **returns** the requested HTML string; the **overlay** performs the clipboard
write (via its existing `copyToClipboard`, which already handles secure-context
`navigator.clipboard` and the `file://` `execCommand` fallback). Keeping the write
in the overlay means one clipboard path for both modes and both menu items.

### Per-mode data flow

| | Clean copy | With-feedback (canvas) copy |
|---|---|---|
| **Canvas mode** (`exporter.js` inlined hooks) | built in-page → return string | built in-page (`buildCanvasHtml`) → return string |
| **Extension mode** (`content-script.js` hook) | built in-page (`'<!DOCTYPE html>\n' + docContentHtml()`) → return string | **service worker** assembles → returns string |

Only the extension-mode "with feedback" path needs a round-trip, because assembling
the canvas requires fetching the runtime files via `chrome.runtime.getURL`, which
only the service worker can do reliably across origins. We add a worker message
**`NOTEBACK_BUILD_CANVAS`** that returns `{ ok, html }`, and refactor the worker so
download and copy share one builder:

- `buildCanvasHtml(input) -> Promise<string>` — the assembly (fetch inlined runtime
  + template, `exporter.buildCanvasHtml(...)`), no download.
- `exportCanvas(input)` becomes `buildCanvasHtml(input).then(triggerDownload)`.
- `NOTEBACK_BUILD_CANVAS` → `buildCanvasHtml(input)` → `{ ok, html }`.

No builder is duplicated; the existing pure `exporter.buildCanvasHtml` (already
unit-tested) is reused unchanged.

### Popup path (extension only)

The popup has no overlay/exporter, so its two menu items send
**`NOTEBACK_COPY_HTML { clean }`** to the content script, which **builds and copies
in the page** (reusing the same `onCopyHtml` builder + the page's `copyToClipboard`)
and returns `{ ok }`. This is exactly how the popup's existing "Copy feedback"
delegates to `NOTEBACK_COPY_MARKDOWN` — so the popup and the sidebar funnel through
**one** content-script implementation; nothing is written twice.

---

## Components & names

**`src/runtime/overlay.js`** (shared runtime, both modes)
- Footer markup: wrap the copy control in `.nb-copy-wrap` containing the existing
  `.nb-copy` button, a new `.nb-copy-caret-btn` (the ▾, `aria-haspopup="menu"`),
  and a `.nb-copy-menu.nb-menu` with two items `.nb-copy-canvas` /
  `.nb-copy-clean` (each with `.nb-mi-label` + `.nb-mi-sub`, like Save items).
- CSS: reuse the `.nb-menu` / `.nb-caret` / dropdown-animation rules; add
  `.nb-copy-wrap { position: relative; }` and split-button joining (shared radius,
  no gap between `.nb-copy` and the caret).
- Wiring: main `.nb-copy` → `copyMarkdown` (unchanged); caret →
  `toggleCopyMenu` (`stopPropagation`); items → `closeCopyMenu` then
  `copyHtmlCanvas()` / `copyHtmlClean()`. Outside-click closes both menus;
  opening the copy menu closes the save menu and vice-versa.
- New `copyHtml(clean)` (with `copyHtmlCanvas`/`copyHtmlClean` wrappers): calls
  `exporter.onCopyHtml(state, { clean })`, then `copyToClipboard(html)`, then the
  success/fail toast. Defensive fallback toast when no hook is present (mirrors
  `saveCanvas`).

**`src/canvas/exporter.js`** — add `onCopyHtml(state, { clean })` to the inlined
`exporterHooks`, building the same html the inlined `onSaveCanvas`/`onSaveClean`
build and returning it (no download).

**`src/content/content-script.js`** — add `onCopyHtml(state, { clean })` to the
`exporter` object (clean → in-page string; with-feedback → `NOTEBACK_BUILD_CANVAS`
round-trip), and a `NOTEBACK_COPY_HTML { clean }` message handler that builds +
copies in the page and responds `{ ok }`.

**`src/background/service-worker.js`** — extract `buildCanvasHtml()`; add the
`NOTEBACK_BUILD_CANVAS` handler returning `{ ok, html }`.

**`src/popup/popup.html` / `popup.js` / `popup.css`** — wrap `#nb-copy-markdown`
in a `.nb-copy-wrap` with a caret button + `#nb-copy-menu` (two items,
`data-copy="canvas"` / `data-copy="clean"`), reusing the popup's existing
`nb-save-menu` styles; items send `NOTEBACK_COPY_HTML`.

## Footer layout (sidebar)

```
┌───────────────────────────── nb-foot ─────────────────────────────┐
│  [ Copy feedback │▾ ]            [ Save ▾ ]                         │
│         │                                                          │
│         └─ ▾ opens ─┐                                              │
│            ┌────────────────────────────────┐                      │
│            │ Copy html (with feedback)      │  re-openable canvas  │
│            │ ───────────────────────────────│                      │
│            │ Copy html (clean)              │  the original, no NB │
│            └────────────────────────────────┘ (grows upward)       │
└────────────────────────────────────────────────────────────────────┘
```

Main "Copy feedback" still copies Markdown; only the ▾ opens this menu. The popup
mirrors the layout under its existing "Copy feedback" button.

## Edge cases & notes

- **Large payload:** the canvas is tens of KB; both `writeText` and the
  `execCommand` fallback handle it.
- **Not booted / no hook:** defensive "Copy failed" (or "needs the extension /
  saved canvas") toast; never throws into the page.
- **Two dropdowns in the footer** (Copy ▾ + Save ▾): mutually exclusive open
  state; both grow upward as today; outside-click closes either.
- **`file://` clipboard:** insecure context → `execCommand` path (already present
  for Markdown copy).
- **Worker absent (defensive):** `NOTEBACK_BUILD_CANVAS` rejection → "Copy failed".
- **Popup caret enabled state:** the popup's new ▾ shares the disabled state of
  "Copy feedback" (`disableActions` already disables `#nb-copy-markdown` when the
  page isn't booted) — so the copy menu is only reachable when Noteback is active.

## Testing

- **Unit (`node --test`, run via `npm run test:unit`):** the pure
  `exporter.buildCanvasHtml` is reused unchanged and stays covered; the worker
  refactor keeps it pure (extract-only). No new pure logic is introduced — the
  copy paths are chrome/DOM glue, verified live (consistent with the repo's
  testing pattern). Existing suite must stay green (149).
- **Live (per CLAUDE.md):** this edits `src/runtime/overlay.js` **and**
  `src/canvas/exporter.js`, so the canvas must be **rebuilt and cache-busted**
  (`node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html`,
  bump `?v=N`). Verify in **both** modes and **both** UIs:
  - Sidebar (extension, on a localhost doc) → Copy ▾ → *with feedback* → paste into
    a new file → it opens as a working canvas; *clean* → paste → it's the original,
    no Noteback.
  - Popup → Copy ▾ → both items copy the same bytes (compare against the Save menu's
    downloads).
  - Sidebar (canvas mode, the rebuilt `spec.canvas.html`) → both items copy in-page
    with no extension.
  - Main "Copy feedback" still copies Markdown; Save ▾ unchanged.

## Files touched (anticipated)

- `src/runtime/overlay.js` — split-button markup, copy menu, handlers, mutual
  close.
- `src/canvas/exporter.js` — `onCopyHtml` in the inlined `exporterHooks`.
- `src/content/content-script.js` — `onCopyHtml` hook + `NOTEBACK_COPY_HTML`.
- `src/background/service-worker.js` — extract `buildCanvasHtml()`, add
  `NOTEBACK_BUILD_CANVAS`.
- `src/popup/popup.html` / `popup.js` / `popup.css` — split button + dropdown.
- `CONTRACTS.md` — document `onCopyHtml`, `NOTEBACK_COPY_HTML`,
  `NOTEBACK_BUILD_CANVAS` in the messaging/exporter contracts.
