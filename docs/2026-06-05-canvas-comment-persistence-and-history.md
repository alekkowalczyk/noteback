# Browser-persistent comments + per-draft feedback history

**Status:** design (approved in brainstorm; pending spec review)
**Date:** 2026-06-05
**Scope:** embedded canvas only (`npx noteback wrap` output). Extension mode untouched.

---

## 1. Problem

A Noteback feedback canvas (`npx noteback wrap plan.html`) keeps its comments in
the in-file `<script id="noteback-state">` block, and `InFileStateAdapter.save()`
only mutates the **in-memory** DOM — it never writes to disk. So:

- **Refresh loses everything.** Reloading the file re-reads the unchanged on-disk
  copy, and the reviewer's comments are gone unless they explicitly saved the
  canvas.
- **No memory across drafts.** When the agent regenerates the document and re-wraps
  it, there is no record of the feedback the reviewer left on previous drafts.

We want two things, which turn out to be one feature:

1. Comments **survive a browser refresh** automatically.
2. When the agent **regenerates** the document, the current view starts clean — but
   the feedback from earlier drafts is **retained and viewable** as read-only
   history, including the ability to see each old comment's highlighted passage in
   the context of the draft it was made on.

Both are achieved by adding a browser-side persistence layer keyed on **document
content**, with a per-draft history model layered on top.

---

## 2. Goals / non-goals

**Goals**
- Comments persist across refresh, per document, in the browser (no save step).
- A real content change to the document = a new "draft": the current comment view
  starts clean; the prior draft's comments move to read-only history.
- Read-only **"Earlier feedback"** history in the sidebar, grouped by draft.
- Click a history comment → see its quoted passage **highlighted in the cleaned
  HTML of the section it was made in**, styled to resemble the original.
- Survive **file moves/renames** for both current comments and history.
- Graceful, silent degradation where browser storage is unavailable.
- **No CLI or template change** — the feature is entirely in the runtime that
  `wrap` already inlines.

**Non-goals (v1)**
- No "bring forward into the current draft" / restore action. History is read-only.
- No history for **extension-mode** annotations (see §10). Different stack,
  different identity signal, separate effort.
- No cross-device sync. localStorage is per-browser, per-origin.
- No change to the Markdown copy-back loop or the re-shareable "Save with comments"
  download.

---

## 3. Identity model

Two identifiers.

### 3.1 Draft identity — content hash

A **draft** is identified by a hash of the document's **normalized visible text**,
computed in the browser at boot:

- Source: `textContent` of `#noteback-doc-root`.
- Normalize: trim, collapse all runs of whitespace to a single space. (Case
  preserved.)
- Hash: a vendored non-crypto string hash (cyrb53-style, 53-bit; optionally doubled
  with a second seed for a 106-bit key). `crypto.subtle` is **not** used — it is not
  guaranteed on `file://`.

Rationale (decided in brainstorm):
- Refresh → identical content → same hash → comments reload.
- Real edit (typo, changed number, rewritten sentence) → new hash → new draft,
  clean current view, prior draft archived to history.
- Cosmetic/markup churn (re-indentation, attribute reordering, class/style changes)
  does **not** reset feedback, because only visible words are hashed.
- A revert to previous content re-surfaces that content's draft (accepted, conscious
  behavior).
- Identical content shares identity (accepted as a feature for real documents).

**Small-content guard.** If the normalized text is shorter than a threshold
(`MIN_HASH_CHARS`, default 32), the document has no stable identity → the adapter
falls back to in-file-only behavior (no persistence, no history). This avoids
conflating near-empty / boilerplate stubs in the shared `file://` bucket.

### 3.2 Lineage — grouping drafts into a history

A **lineage** groups the drafts of one document so history can be shown. Because
successive drafts have *different* content (and thus different hashes), they need an
explicit link:

- Each generation record stores a `lineageId`.
- A `lineage` record holds an ordered list of its draft hashes plus the set of
  `hrefs` it has been seen at.
- An href index (`location.href` normalized to `origin + pathname`, dropping query
  and hash) maps a path → `lineageId`, used **only** to attach a freshly-seen draft
  to an existing lineage.

This makes both current comments and history **survive a move/rename**: on reopen at
a new path, the draft is found by its content hash, its `lineageId` yields the full
history, and the new href is added to the lineage. The one unrecoverable corner case
is *move **and** regenerate at the new path before reopening* — acceptable, and no
worse under any alternative identity scheme.

---

## 4. Storage layout (localStorage)

All keys are namespaced; all values are JSON. Snapshots are compressed (see §6.3).

```jsonc
// One per draft, keyed by content hash.
"nb:gen:<contentHash>" = {
  "schemaVersion": 1,
  "contentHash": "<hash>",
  "lineageId": "<id>",
  "docTitle": "RealtimeSync Plan",
  "firstSeenAt": "<ISO-8601>",     // when this draft was first opened in this browser
  "lastEditedAt": "<ISO-8601>",
  "comments": [ /* State.comments per CONTRACTS.md §2 */ ],
  "sections": [ { "id": "s1", "html": "<compressed clean fragment>" } ],
  "styles": "<compressed inline <style> text from the draft's <head>>"
}

// One per lineage (document).
"nb:lin:<lineageId>" = {
  "schemaVersion": 1,
  "lineageId": "<id>",
  "hrefs": [ "file:///Users/.../plan.html" ],
  "generations": [ "<hashOldest>", "...", "<hashNewest>" ]
}

// Path → lineage, for attaching new drafts.
"nb:href" = { "file:///Users/.../plan.html": "<lineageId>" }
```

`lineageId` is a runtime-minted random id (`c_`-style, like comment ids). No
timestamps come from the system clock inside pure functions — the adapter passes
`new Date().toISOString()` at the call site, mirroring `state.js`'s discipline.

---

## 5. Architecture

Approach: a **decorator adapter** over the existing `InFileStateAdapter`. It
satisfies the same `StorageAdapter` contract (CONTRACTS.md §1), so `boot()` is
unchanged.

```
EMBEDDED_BOOT builds:
  LocalStorageStateAdapter ── decorates ──► InFileStateAdapter
        │                                          │
   window.localStorage                      #noteback-state block
   nb:gen / nb:lin / nb:href                (in-memory; re-share path intact)
```

### 5.1 New module — `src/adapters/localstorage-state-adapter.js`

DOM adapter, attaches to `NotebackRuntime.localStorageStateAdapter`. Factory takes
injectable `doc` and `storage` so the **pure** parts are unit-testable under Node
(dual-export for the pure helpers; see §8).

```js
createLocalStorageStateAdapter({ doc, storage, inner, now, snapshotFns }) -> {
  load(): Promise<State|null>,
  save(state): Promise<void>,
  // history + clear extensions (consumed by the overlay, see §7):
  getHistory(): Array<DraftSummary>,     // other drafts in this lineage, newest first
  getSection(commentRef): SectionView|null,  // decompress + return a history comment's snapshot
  clearCurrent(): Promise<void>          // wipe THIS draft's comments (history kept)
}
```

Behavior:
- **Resolve identity** once at construction (DOM is clean pre-paint): compute
  `contentHash`; if guard fails or `storage` is unavailable → set a `degraded` flag
  and delegate everything to `inner`.
- **load()**: if `nb:gen:<hash>` exists → return its `comments` (refresh / revert /
  moved copy). Else → `inner.load()` (fresh wrap → empty; saved annotated canvas →
  its in-file comments). Either way, ensure the lineage + href index are wired
  (§5.2) and prune (§6.4).
- **save(state)**: write `comments` (+ rebuilt `sections`/`styles`) into
  `nb:gen:<hash>`, bump `lastEditedAt`, persist lineage; **and** call `inner.save`
  (keeps the in-file block current so "Save with comments" / re-share still reflect
  the latest comments).
- **clearCurrent()**: set this draft's `comments` to `[]` and `sections` to `[]`,
  persist, and `inner.save(emptyState)`.

All `storage` access is wrapped in try/catch; any failure flips `degraded` and
delegates to `inner` (today's behavior).

### 5.2 Boot-time lineage wiring

On first `load()`:
1. `hash = contentHash`.
2. If `nb:gen:<hash>` exists → `lineageId = gen.lineageId`; add current normalized
   href to `nb:lin:<lineageId>.hrefs` and to `nb:href`.
3. Else (new draft):
   a. `lineageId = nb:href[normHref]` if present, else mint a new lineage.
   b. Create `nb:gen:<hash>` seeded from `inner.load()` (usually empty).
   c. Append `hash` to `nb:lin:<lineageId>.generations`; record href.

### 5.3 `EMBEDDED_BOOT` change (`src/canvas/exporter.js`)

Compose the new adapter around the existing in-file adapter and pass the history +
clear hooks into the overlay's exporter/menu config:

```js
var inner = RT.infileStateAdapter.createInFileStateAdapter(document, { onChange: ... });
var adapter = RT.localStorageStateAdapter
  ? RT.localStorageStateAdapter.createLocalStorageStateAdapter({
      doc: document,
      storage: (typeof window !== 'undefined' && window.localStorage) || null,
      inner: inner,
      now: function () { return new Date().toISOString(); },
      snapshotFns: RT.snapshot
    })
  : inner;
```

There is **no wrap-time logic change**: no id is minted, no template token is added,
`buildCanvasHtml` and `canvas-template.html` are untouched, and the hash is computed
at runtime. The only `bin/noteback.js` / manifest edit is mechanical — the two new
runtime modules must be added to every list that defines the inlined runtime so they
reach the canvas (see §11): `RUNTIME_FILES` in `bin/noteback.js`, the service
worker's concatenation order, `web_accessible_resources` in `manifest.json`, and the
dependency-order table in CONTRACTS.md §4. They go in embedded-mode position
(alongside `infile-state-adapter.js`, before `boot.js`); they are not needed in the
live extension's `content_scripts`.

---

## 6. Section snapshots (history context popup)

Per draft that has comments, store a small clean snapshot of just the commented
sections, so a history comment can be viewed in the context it was made in.

### 6.1 What a section is

For each comment, locate the block containing its anchored quote (in a **cleaned
clone** of `#noteback-doc-root` — no runtime, no state block, no `<mark>` wrappers,
no `[data-noteback-ui]`). Capture:

- the **enclosing block** element (`<p>`, `<li>`, `<pre>`, `<td>`/`<tr>`, `<section>`
  child, etc.),
- its **immediate previous and next sibling** blocks (surrounding context),
- the **nearest preceding section heading** — the closest `h1`–`h6` /
  `[role="heading"]` walking backward through previous siblings and up ancestors — if
  one is found, prepended for orientation.

A size cap (`MAX_SECTION_CHARS`) prevents a comment inside a huge block/table from
dragging in the whole thing; over the cap, fall back to a smaller slice around the
quote.

Sections are **deduped within a draft** (two comments in one paragraph → one
section); each comment references its section `id`. Whole-document notes
(`anchor === null`) get **no** section — the popup shows "note on the whole
document".

### 6.2 Styling fidelity

Stash the draft's inline `<head>` `<style>` text **once** per draft (`styles`).
Render a section in a sandboxed `<iframe srcdoc>` whose `<head>` contains those
styles and a `<base href="...">` (the lineage href) so relative assets resolve. The
highlight is painted with the existing anchor against the snapshot text — it always
resolves, because the snapshot is the very text the anchor was built from.

Caveat: external stylesheets (`<link rel=stylesheet>`) and remote/relative images
may not load in the snapshot. Inline `<style>` — the norm for agent-generated review
docs — does.

### 6.3 Capture + compression

- Capture runs on save (debounced with the existing persistence), from the cleaned
  clone, reusing `exporter`'s existing UI/mark-stripping logic where practical.
- Fragments and styles are compressed before storage. Preferred: native
  `CompressionStream('gzip')` + base64 when available; fallback: a vendored
  LZ-string-style compressor (≈3 KB, no npm dependency — consistent with the repo's
  zero-dependency rule). If neither is available, store uncompressed and rely on §6.4
  budgeting.
- New module `src/runtime/snapshot.js` (DOM; attaches to `NotebackRuntime.snapshot`)
  owns section extraction and (de)compression. Pure sub-helpers (block selection
  rules over an injected node, dedupe, compressor round-trip) are dual-exported for
  Node tests.

### 6.4 Garbage collection / limits

Pruned on boot and after each save:
- **Snapshots:** keep `sections`/`styles` for the **last `SNAPSHOT_DRAFTS` (5)**
  drafts per lineage; older drafts keep comment metadata only.
- **Metadata:** keep comment metadata (quote + body) for the last
  `META_DRAFTS` (15) drafts per lineage.
- **TTL:** drop drafts whose `lastEditedAt` is older than `TTL_DAYS` (90).
- **Byte cap:** an overall `MAX_BYTES` budget across all Noteback keys; evict oldest
  drafts (snapshots first, then metadata) until under budget.
- A draft whose snapshot was evicted still renders in history as quote + body, with
  no "view in context" affordance. **No silent total loss** of a comment's text
  until it ages past `META_DRAFTS` / `TTL_DAYS`.

All limits are module constants, easy to tune.

---

## 7. UI (`src/runtime/overlay.js`)

### 7.1 "Earlier feedback" history section

A collapsed-by-default, **read-only** section in the sidebar beneath the current
draft's comments. Source: `adapter.getHistory()`. Grouped by draft, newest first:

```
── This draft (3)                       [editable, as today]
   • "a single Redis instance"  use a cluster
   ...
▾ Earlier feedback (2 drafts)            [read-only]
   Draft · Jun 4, 14:30 (4)
     • "single worker pool"  what about HA?
   Draft · Jun 3, 09:10 (1)
     • "polls every 5s"  too chatty
```

- Draft label: relative/absolute time from `firstSeenAt` (or `lastEditedAt`) +
  comment count.
- Each item shows the condensed quote + body (reusing `markdown.condenseQuote`),
  read-only (no edit/delete).
- Whole-document notes show as "note on the whole document".
- Only drafts with **≥1 comment** are listed; a cleared or never-commented draft does
  not appear. Hidden entirely when there is no such history or when the adapter is
  degraded.

### 7.2 History comment popup

Clicking a history item opens a popover/modal (`[data-noteback-ui]`, so it is
hidden from print/clean exports) containing the `<iframe srcdoc>` snapshot (§6.2)
with the quote highlighted and scrolled into view. If the section was GC'd, show the
quote + body as text with a small "context no longer stored" note.

### 7.3 "Clear my comments"

A new item in the footer **Save…/▾** menu: **"Clear my comments (this draft)"**.
Calls `adapter.clearCurrent()`, then resets the live State to empty and repaints
(removes highlights). History from other drafts is **retained**. Hidden when
degraded.

---

## 8. Testing

Node built-in runner only (`node --test`), zero dependencies — consistent with the
repo.

**Pure helpers (new unit tests):**
- `normalizeText` + `contentHash`: determinism; whitespace/markup-insensitivity;
  text changes ⇒ different hash; small-content guard threshold.
- Lineage logic: new draft mints/attaches lineage; refresh hits existing gen; move
  (same hash, new href) preserves comments + history and records the new href.
- `load`/`save` precedence: localStorage hit vs. in-file fallback; write-through to
  `inner.save`.
- GC: snapshot vs. metadata retention, TTL, byte-cap eviction order; evicted
  snapshot still yields quote + body.
- Compression round-trip (fragment in == fragment out).
- Section selection rules over an injected lightweight node graph (enclosing block +
  siblings + nearest heading; size-cap fallback; dedupe).

Tests inject a fake `storage` (Map-backed) and, where needed, a minimal fake `doc`,
so no real DOM is required. DOM-only glue (iframe rendering, sidebar wiring) follows
the repo's existing convention of being exercised via live Playwright rather than
Node unit tests.

**CLI/exporter:** unchanged behavior must still pass (`cli-wrap.test.js`,
`exporter.test.js`); add an assertion that a wrapped canvas references
`localStorageStateAdapter` in its inlined runtime.

**Live (Playwright, localhost):** refresh restores comments; a content edit + reload
starts clean and files the prior draft under history; a history comment opens the
styled snapshot popup with the highlight; "Clear my comments" empties the current
draft and keeps history. (Per CLAUDE.md: rebuild the canvas and cache-bust the URL
after editing `src/runtime/*`.)

---

## 9. Degradation matrix

| Condition                                   | Behavior                                  |
|---------------------------------------------|-------------------------------------------|
| `localStorage` throws / unavailable (Safari `file://`, private mode) | Pure in-file behavior (today). No errors. |
| Normalized content below `MIN_HASH_CHARS`   | No persistence / history for that doc.    |
| Snapshot GC'd but metadata kept             | History shows quote + body; no popup.     |
| `CompressionStream` + LZ both absent        | Store uncompressed; byte cap governs.     |
| Old canvas wrapped before this feature      | Has the old runtime → behaves as before.  |

---

## 10. Why extension mode is out of scope

Extension mode uses `ChromeStorageAdapter` (`chrome.storage.local`, keyed by page
URL) and annotates arbitrary pages. It already persists across refresh, and it has
no `wrap` step and no doc-root content boundary to anchor a draft model to cleanly.
Per-draft history there would require a different identity signal (a content hash at
load time over an arbitrary page) and a parallel implementation in the content
script + chrome.storage GC — and is questionable for non-document pages. A wrapped
canvas opened **with** the extension installed still gets this feature, because the
embedded canvas wins the single-mount guard (CONTRACTS.md §3.7). Extension-native
history is a possible follow-up, not part of this spec.

---

## 11. Files

**New**
- `src/adapters/localstorage-state-adapter.js` — decorator adapter + lineage/GC +
  history/clear API (pure helpers dual-exported for tests).
- `src/runtime/snapshot.js` — section extraction + (de)compression (pure sub-helpers
  dual-exported).
- `test/localstorage-adapter.test.js`, `test/snapshot.test.js`.

**Modified**
- `src/canvas/exporter.js` — `EMBEDDED_BOOT` composes the new adapter and passes
  history/clear hooks.
- `src/runtime/overlay.js` — "Earlier feedback" read-only section, history popup,
  "Clear my comments" menu item.
- **Inlined-runtime lists** — add the two new modules (embedded-mode position,
  before `boot.js`) to each place that defines the inlined runtime:
  `RUNTIME_FILES` in `bin/noteback.js`, `examples/build-canvas.js`, the service
  worker's concatenation order, and `web_accessible_resources` in `manifest.json`.
  This is the *only* `bin/noteback.js` / `manifest.json` change — no wrap-time logic,
  no stamping.
- `CONTRACTS.md` — new adapter, localStorage schema, content-hash identity, snapshot
  model; runtime dependency-order/global-namespace tables gain the two modules.
- `CLAUDE.md` — gotchas (hash from clean pre-paint DOM; `file://` shared bucket;
  iframe `srcdoc` styling caveat).

**Unchanged**
- `src/canvas/canvas-template.html` (nothing is stamped into the file).
- Extension *behavior*: `content-script.js`, `chrome-storage-adapter.js`, and the
  live `content_scripts` mounting are untouched (the new modules are inlined-only).

---

## 12. Open questions / future

- "Bring forward" a history comment into the current draft (re-anchored where text
  matches) — explicitly deferred.
- Full-document snapshots (vs. section-only) — the data model already allows an
  optional per-draft `fullSnapshot` field to be added later with no migration.
- Tunable limits (§6.4) could later move to a small in-canvas settings affordance.
