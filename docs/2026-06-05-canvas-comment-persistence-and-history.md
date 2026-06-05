# Browser-persistent comments + per-draft feedback history

**Status:** design (approved in brainstorm; pending spec review)
**Date:** 2026-06-05
**Scope:** both modes — embedded canvas (`npx noteback wrap`) **and** the extension —
via one shared, storage-agnostic core.

---

## 1. Problem

Noteback keeps a document's comments in an annotation State persisted by a
`StorageAdapter` (CONTRACTS.md §1). Today neither mode remembers feedback *across
drafts*, and the canvas additionally loses it on refresh:

- **Canvas:** `InFileStateAdapter.save()` only mutates the in-memory DOM, never disk
  — so a **refresh loses all comments** unless the reviewer explicitly saved the
  file.
- **Extension:** `ChromeStorageAdapter` keys by **URL** in `chrome.storage.local`, so
  comments *do* survive reload — but when the agent regenerates the document the
  comments persist against the same URL and silently re-anchor (often orphaning).
  There is **no clean-slate-on-regenerate and no record of earlier drafts.**

We want one feature in both modes:

1. Comments **survive a refresh/reload** automatically.
2. A real content change = a new **draft**: the current view starts clean; the prior
   draft's comments move to **read-only history**.
3. Read-only **"Earlier feedback"** in the sidebar, grouped by draft, where clicking
   an old comment shows its quoted passage **highlighted in the cleaned HTML of the
   section it was made in**, styled to resemble the original.

The identity is a hash of the document's **content**, computed at runtime — which is
mode-agnostic, so the same core powers both the canvas (`localStorage`) and the
extension (`chrome.storage`).

---

## 2. Goals / non-goals

**Goals**
- Comments persist across refresh/reload, per document, with no save step.
- Content change ⇒ new draft; prior draft archived to read-only history.
- "Earlier feedback" history UI (shared overlay) in **both** modes.
- Click a history comment ⇒ its quote highlighted in the cleaned HTML of its section,
  styled to resemble the original.
- Survive **file moves/renames** (canvas) for current comments and history.
- A single **storage-agnostic core** with thin `localStorage` and `chrome.storage`
  bindings.
- **Gating** so the draft model only engages where content is stable; dynamic pages
  keep today's behavior (see §3.3).
- Graceful, silent degradation where browser storage is unavailable.
- No wrap-time logic change (no id stamped into the file).

**Non-goals (v1)**
- No "bring forward into the current draft" / restore. History is read-only.
- No draft model on **dynamic** pages — those fall back to today's URL-keyed
  persistence (§3.3).
- No cross-device sync (storage is per-browser).
- No change to the Markdown copy-back loop or the re-shareable "Save with comments"
  export.

---

## 3. Identity model

Three concepts: **draft** (which version), **lineage** (which document, to group
drafts), and **gating** (whether the draft model engages at all).

### 3.1 Draft identity — content hash (mode-agnostic)

A draft is identified by a hash of the document's **normalized visible text**,
computed in the browser at boot from an injected **content root**:

- Content root: **canvas** → `#noteback-doc-root`; **extension** → `document.body`
  (the same root the overlay already annotates). The two never need to agree — a doc
  is reviewed in one mode at a time.
- Normalize: `textContent`, trimmed, runs of whitespace collapsed to one space (case
  preserved).
- Hash: a vendored non-crypto string hash (cyrb53-style, 53-bit; optionally doubled
  for a 106-bit key). `crypto.subtle` is **not** used — not guaranteed on `file://`.

Rationale (decided in brainstorm): refresh → same hash → comments reload; a real edit
→ new hash → new draft + clean view + prior draft archived; cosmetic/markup churn
doesn't reset (only visible words are hashed); a content revert re-surfaces that
draft (accepted); identical content shares identity (accepted as a feature for real
documents).

**Small-content guard:** below `MIN_HASH_CHARS` (default 32) of normalized text the
document has no stable identity → fall back to the binding's inner adapter (no
drafts/history).

### 3.2 Lineage — grouping drafts (mode-agnostic, via an injected attach key)

Successive drafts have different hashes, so they need an explicit link. Each
generation record stores a `lineageId`; a `lineage` record holds its ordered draft
hashes plus the set of **attach keys** it has been seen at. An attach-key index maps
attach key → `lineageId`, used only to bind a freshly-seen draft to an existing
lineage.

The **attach key** is supplied by the binding:
- **Canvas:** normalized `location.href` (`origin + pathname`, drop query/hash). This
  makes current comments **and** history survive a move/rename: on reopen, the draft
  is found by content hash, its `lineageId` yields the full history, and the new path
  is added to the lineage.
- **Extension:** the page **URL** (the existing `docId`). Stable per page.

The one unrecoverable corner case (canvas) is *move **and** regenerate at the new
path before reopening* — acceptable.

### 3.3 Gating — where the draft model engages

The content-hash model assumes content is **stable across reloads**. That holds for
static documents but not for dynamic pages (an SPA, anything with timestamps/ads),
where the hash would churn and every reload would look like a new draft — *worse*
than today. So the draft model is gated:

| Context | Draft model | Fallback when off |
|---|---|---|
| Canvas (wrapped file) | On (when storage available + content guard passes) | in-file only |
| Extension · `file://` | On by default | — |
| Extension · `localhost` / `127.0.0.1` | **Off by default; per-site opt-in** | URL-keyed (today) |
| Extension · `other` | n/a (extension inactive there — CONTRACTS.md §1.3) | — |

The predicate lives in `src/content/origin-policy.js` (the existing single source of
truth for activation), e.g. `draftModelActive({type, origin}, settings)`, and reuses
the `nb:settings` object (a new opt-in list of origins). When the draft model is
**off**, the extension behaves exactly as today (URL-keyed `ChromeStorageAdapter`).

---

## 4. Storage layout (logical keys)

The same logical keys back both modes — `localStorage` for the canvas,
`chrome.storage.local` for the extension. Snapshots are compressed (§6.3). Keys are
namespaced and never collide with the existing `noteback:<docId>` state or
`nb:settings`.

```jsonc
"nb:gen:<contentHash>" = {            // one per draft
  "schemaVersion": 1,
  "contentHash": "<hash>", "lineageId": "<id>",
  "docTitle": "RealtimeSync Plan",
  "firstSeenAt": "<ISO-8601>", "lastEditedAt": "<ISO-8601>",
  "comments": [ /* State.comments per CONTRACTS.md §2 */ ],
  "sections": [ { "id": "s1", "html": "<compressed clean fragment>" } ],
  "styles": "<compressed inline <style> text from the draft's <head>>"
}
"nb:lin:<lineageId>" = {              // one per document
  "schemaVersion": 1, "lineageId": "<id>",
  "attachKeys": [ "file:///Users/.../plan.html" ],
  "generations": [ "<hashOldest>", "...", "<hashNewest>" ]
}
"nb:attach" = { "<attachKey>": "<lineageId>" }   // attach key -> lineage
```

`chrome.storage.local` has a larger quota than `localStorage` (and can request
unlimited), so byte budgeting (§6.4) is looser in extension mode.

---

## 5. Architecture

A storage-agnostic **core** plus two thin **bindings**, each a decorator over the
mode's existing adapter (so `boot()` is unchanged and the existing persist/re-share
path stays intact).

```
            ┌─────────────────────────────────────────┐
            │  draft-history core  (pure-ish, async)   │
            │  hash · lineage · gen-store ops · GC      │
            └───────────────▲───────────────▲──────────┘
                            │               │
        ┌───────────────────┴──┐   ┌────────┴───────────────────┐
        │ LocalStorageBinding  │   │ ChromeStorageBinding        │
        │ store: localStorage  │   │ store: chrome.storage.local │
        │ inner: InFileState…  │   │ inner: ChromeStorage…       │
        │ attachKey: href      │   │ attachKey: URL · gated      │
        └──────────▲───────────┘   └───────────▲─────────────────┘
              canvas EMBEDDED_BOOT        extension content-script
```

### 5.1 Core — `src/runtime/draft-history-core.js`

Pure-ish, dual-export (`NotebackRuntime.draftHistory` + `module.exports`), so it's
unit-testable under Node. It owns identity, lineage, gen-store CRUD, history
assembly, and GC. It is **storage-agnostic**: it talks to an injected async
key-value `store` and an injected `now()`; it never touches `localStorage`,
`chrome.*`, or the DOM directly (the content root's text is passed in).

```js
createDraftHistory({ store, now, limits }) -> {
  resolve({ contentText, attachKey, fallbackComments, docTitle })
      -> { degraded, contentHash, lineageId, comments },   // boot: load/seed + wire lineage + GC
  persist({ contentHash, comments, sections, styles }) -> Promise<void>,
  history({ lineageId, exceptHash }) -> Promise<DraftSummary[]>,   // newest first, ≥1 comment
  section({ contentHash, sectionId }) -> Promise<SectionView|null>,
  clearCurrent({ contentHash }) -> Promise<void>
}
```

`store` interface (both bindings implement it): `get(key)`, `set(key, val)`,
`remove(key)`, `keys()` — all `Promise`-returning. The `localStorage` binding wraps
sync calls in resolved Promises; the `chrome.storage` binding is natively async.

### 5.2 Snapshot module — `src/runtime/snapshot.js`

DOM module (`NotebackRuntime.snapshot`); see §6. Pure sub-helpers (block-selection
rules over an injected node, dedupe, compressor round-trip) dual-exported for tests.

### 5.3 Canvas binding — `src/adapters/localstorage-state-adapter.js`

Decorator over `InFileStateAdapter`. Resolves identity once at construction
(`contentRoot = #noteback-doc-root`, `attachKey = normalized location.href`,
`store = localStorage`). `load()` → core seed/load; `save()` → core `persist`
(rebuilding sections via `snapshot`) **and** write-through `inner.save` (keeps the
in-file block current for "Save with comments"). Exposes `getHistory`/`getSection`/
`clearCurrent` for the overlay. Degraded (no storage / guard fails) → delegate to
`inner`.

### 5.4 Extension binding — `src/adapters/chrome-history-adapter.js`

Decorator over the existing `ChromeStorageAdapter`. Same shape, with
`contentRoot = document.body`, `attachKey = page URL`, `store = chrome.storage.local`.
**Gated:** if `draftModelActive(...)` is false (§3.3), it is a no-op pass-through to
`ChromeStorageAdapter` (today's behavior). When active, it layers the draft model and
write-throughs to the inner adapter (so the URL-keyed record mirrors the current
draft, preserving the re-share path and the fallback if gating later flips off).

### 5.5 Wiring

- **Canvas** (`exporter.js` `EMBEDDED_BOOT`): compose the localStorage binding around
  the in-file adapter; pass `getHistory`/`getSection`/`clearCurrent` into the
  overlay. No wrap-time/template change (§11).
- **Extension** (`content-script.js`): choose the adapter — when `draftModelActive`,
  wrap `ChromeStorageAdapter` in the chrome history binding; else use it directly.
  Pass `root = document.body`. Re-evaluate on settings change (the content script
  already listens to `chrome.storage.onChanged`).

---

## 6. Section snapshots (history context popup)

Per draft with comments, store a small clean snapshot of just the commented sections.

### 6.1 What a section is

For each comment, in a **cleaned clone** of the content root (no runtime, no state
block, no `<mark>`/`[data-noteback-ui]`), locate the block containing its anchored
quote and capture: the **enclosing block** + its **immediate previous/next sibling**
+ the **nearest preceding section heading** (`h1`–`h6` / `[role=heading]`, searching
back through previous siblings and up ancestors), if found. A size cap
(`MAX_SECTION_CHARS`) falls back to a smaller slice around the quote for huge
blocks/tables. Sections are **deduped within a draft**; each comment references its
section `id`. Whole-document notes (`anchor === null`) get no section ("note on the
whole document").

### 6.2 Styling fidelity

Stash the draft's inline `<head>` `<style>` text once (`styles`). Render a section in
a sandboxed `<iframe srcdoc>` whose head contains those styles and a
`<base href="...">` (the attach key) so relative assets resolve; paint the highlight
with the existing anchor against the snapshot text (always resolves — it's the very
text the anchor was built from). Caveat: external stylesheets and remote/relative
images may not load — inline `<style>` does. (More relevant in the extension, where
real pages lean on linked CSS.)

### 6.3 Capture + compression

Capture runs on save (debounced with persistence), from the cleaned clone, reusing
`exporter`'s UI/mark-stripping where practical. Compress before storage: prefer native
`CompressionStream('gzip')` + base64; else a vendored LZ-string-style compressor
(≈3 KB, no npm dep — consistent with the repo's zero-dependency rule); else store
uncompressed and rely on budgeting.

### 6.4 Garbage collection / limits

Pruned on boot and after save: snapshots kept for the last `SNAPSHOT_DRAFTS` (5)
drafts per lineage; comment metadata kept for `META_DRAFTS` (15); `TTL_DAYS` (90)
TTL; an overall `MAX_BYTES` budget (looser for `chrome.storage`) evicting oldest
drafts (snapshots first, then metadata). An evicted snapshot still renders as
quote + body with no "view in context". No silent total loss until metadata ages out.
All limits are module constants.

---

## 7. UI (`src/runtime/overlay.js` — shared by both modes)

### 7.1 "Earlier feedback" history section

Collapsed-by-default, **read-only** section beneath the current draft's comments,
sourced from `adapter.getHistory()`, grouped by draft (newest first) with a timestamp
(`firstSeenAt`/`lastEditedAt`) and count. Items show the condensed quote + body
(`markdown.condenseQuote`), read-only. Only drafts with **≥1 comment** appear; a
cleared/never-commented draft does not. Hidden when there's no such history or the
adapter is degraded/off. Because the overlay is shared, this appears in **both**
modes automatically.

### 7.2 History comment popup

Clicking a history item opens a popover (`[data-noteback-ui]`, hidden from
print/clean exports) containing the `<iframe srcdoc>` snapshot (§6.2) with the quote
highlighted and scrolled into view. GC'd section → quote + body text with a "context
no longer stored" note.

### 7.3 "Clear my comments"

New **Save…/▾** item — "Clear my comments (this draft)" — calls
`adapter.clearCurrent()`, resets the live State to empty, repaints. Other drafts'
history is retained. Hidden when degraded/off.

### 7.4 Extension popup opt-in (`src/popup/`)

For `localhost` / `127.0.0.1`, add a per-site toggle "Remember drafts & history on
this site" that writes the opt-in into `nb:settings`. `file://` is on by default and
needs no toggle. Reuses the existing popup settings UI and live `onChanged` sync.

---

## 8. Testing

Node built-in runner only (`node --test`), zero dependencies.

**Pure / core (new unit tests, fake async `store` + fake `chrome` where needed):**
- `normalizeText` + `contentHash`: determinism; whitespace/markup-insensitivity; text
  change ⇒ different hash; small-content guard.
- Core lineage: new draft mints/attaches lineage; refresh hits existing gen; move
  (same hash, new attach key) preserves comments + history and records the new key.
- `resolve`/`persist` precedence: store hit vs. inner fallback; write-through.
- GC: snapshot vs. metadata retention, TTL, byte-cap eviction order; evicted snapshot
  still yields quote + body.
- Compression round-trip; section selection rules (enclosing block + siblings +
  nearest heading; size-cap; dedupe).
- `draftModelActive` predicate: `file` on; `localhost`/`127.0.0.1` off until opted
  in; `other` off — mirrors `isActive` tests in `origin-policy.test.js`.

**Adapters:** canvas binding over a fake `localStorage` + fake `document`; extension
binding over a fake `chrome.storage` — gated off ⇒ pure pass-through to
`ChromeStorageAdapter`; gated on ⇒ draft model engaged.

**CLI/exporter:** unchanged behavior still passes; assert a wrapped canvas references
`localStorageStateAdapter` in its inlined runtime.

**Live (Playwright, localhost):** refresh restores comments; a content edit + reload
starts clean and files the prior draft under history; a history comment opens the
styled snapshot popup with the highlight; "Clear my comments" empties the current
draft and keeps history; (extension) the same on a `file://` page and the
`localhost` opt-in toggling the behavior. (Per CLAUDE.md: rebuild the canvas and
cache-bust the URL after editing `src/runtime/*`.)

---

## 9. Degradation matrix

| Condition | Behavior |
|---|---|
| `localStorage`/`chrome.storage` throws or unavailable | Inner adapter only (today). No errors. |
| Normalized content below `MIN_HASH_CHARS` | No drafts/history for that doc. |
| Extension gating off (dynamic/localhost not opted in) | URL-keyed `ChromeStorageAdapter` (today). |
| Snapshot GC'd but metadata kept | History shows quote + body; no popup. |
| `CompressionStream` + LZ both absent | Store uncompressed; byte cap governs. |
| Old canvas wrapped before this feature | Old runtime → behaves as before. |

---

## 10. Mode interplay & boundaries

- **Wrapped canvas opened with the extension installed:** the embedded canvas wins
  the single-mount guard (CONTRACTS.md §3.7) and provides the feature via
  `localStorage`; the extension stands down. No double history, no split state.
- **Non-wrapped `file://` doc with the extension:** the extension provides the
  feature via `chrome.storage`.
- **Content roots differ by mode** (`#noteback-doc-root` vs `document.body`), as do
  line-number semantics already (CLAUDE.md). A doc is reviewed in one mode at a time,
  so hashes never need to agree across modes.

---

## 11. Files

**New**
- `src/runtime/draft-history-core.js` — storage-agnostic core (dual-export; tested).
- `src/runtime/snapshot.js` — section extraction + (de)compression (pure sub-helpers
  dual-exported).
- `src/adapters/localstorage-state-adapter.js` — canvas binding.
- `src/adapters/chrome-history-adapter.js` — extension binding (gated).
- `test/draft-history-core.test.js`, `test/snapshot.test.js`,
  `test/history-adapters.test.js` (+ cases in `origin-policy.test.js`).

**Modified**
- `src/canvas/exporter.js` — `EMBEDDED_BOOT` composes the canvas binding + history
  hooks.
- `src/content/content-script.js` — choose gated chrome binding vs. plain
  `ChromeStorageAdapter`; pass `root = document.body`; re-evaluate on settings change.
- `src/content/origin-policy.js` — `draftModelActive(...)` predicate + settings
  normalization for the opt-in list.
- `src/runtime/overlay.js` — "Earlier feedback" section, history popup, "Clear my
  comments" item (shared by both modes).
- `src/popup/popup.{js,html,css}` — per-site draft-history opt-in toggle.
- **Inlined/loaded-runtime lists** — add the new runtime modules
  (`draft-history-core.js`, `snapshot.js`, both adapters) where each mode loads the
  runtime: `RUNTIME_FILES` in `bin/noteback.js`, `examples/build-canvas.js`, the
  service worker's concatenation order, and **both** `web_accessible_resources` and
  `content_scripts` in `manifest.json` (the extension now runs these live, not just
  inlined). Dependency order: core + snapshot before the adapters, all before
  `boot.js`.
- `CONTRACTS.md` — core + two new adapters, storage schema, content-hash identity,
  gating predicate/settings, snapshot model; runtime dependency-order/namespace
  tables.
- `CLAUDE.md` — gotchas (hash from clean pre-paint DOM; `file://` shared bucket;
  iframe `srcdoc` styling caveat; gating to avoid dynamic-page churn).

**Unchanged**
- `bin/noteback.js` wrap logic and `src/canvas/canvas-template.html` (nothing stamped;
  the only `bin`/manifest edits are the runtime-list additions above).
- `chrome-storage-adapter.js` core behavior (it becomes the extension binding's inner
  adapter and its untouched fallback).

---

## 12. Open questions / future

- "Bring forward" a history comment into the current draft (re-anchored where text
  matches) — deferred.
- Full-document snapshots vs. section-only — the model already allows an optional
  per-draft `fullSnapshot` field later with no migration.
- A heuristic to auto-detect "this localhost page is static" and offer the draft
  model proactively, instead of manual opt-in.
- Tunable limits (§6.4) could move to a small settings affordance.
