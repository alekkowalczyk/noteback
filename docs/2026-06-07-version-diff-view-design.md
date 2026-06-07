# Inline diff view for version history — design

**Date:** 2026-06-07
**Branch:** `feat/version-diff-view` (off `feat/snapshot-history`)
**Status:** approved (brainstorm) → ready for implementation plan

## Problem

The history timeline lets you open a past version inline (read-only) in a side
panel beside the sidebar (`overlay.openVersionInline` → `.nb-hist-view` iframe;
see `2026-06-07-inline-version-viewing-design.md`). You can *read* an old
version, but you can't see **what changed** between it and the next one. To
compare, you mentally diff two snapshots by eye.

Add a **diff toggle** to the inline view: while viewing an earlier version, flip
"Diff" on and the panel re-renders the document as an inline, formatting-preserving
diff against the **next chronological version**.

## Decision (confirmed with the user)

- **Base → target = "this version → next chronological version."** Viewing
  version `vK`, the diff compares `vK` (base) against the version immediately
  newer than it (target). For the **most-recent earlier version**, "next" is the
  **live current draft** (captured on the fly), labelled `now`. So the targets
  form the chain `v1→v2→…→vN→now`.
- **Inline unified, single panel, formatting preserved.** One rendered document
  (the target), with inserted runs highlighted and removed runs struck through
  inline where they used to be; word-level granularity inside edited blocks.
  Reuses the existing single-iframe `.nb-hist-view` panel — not side-by-side, not
  a plain-text `+/-` dump.
- **Comment highlights stay painted in diff mode**, layered with the diff
  coloring on **separate visual channels** (comment highlight = background tint;
  diff add = green underline; diff remove = red strikethrough) so the two color
  schemes coexist without fighting. Peek popovers still work (target version's
  comments).
- **The toggle is sticky** while browsing: switching to another version row keeps
  diff mode on. "Back to current" / closing the view returns to the live draft as
  today.

## Hard constraints (from `CLAUDE.md`)

- **Zero runtime dependencies, no build step** — no `diff`/`htmldiff` npm
  package. The diff is hand-written pure JS under `src/runtime/`.
- **Dual-mode runtime** — everything in `src/runtime/` must run as both the
  extension content script and the inlined canvas script. No `chrome.*`, no
  extension-only globals.
- **Pure-logic modules run under Node and the browser** (UMD-lite dual export),
  DOM-free, so they stay unit-testable on the Node built-in runner.

## Engine strategy: block-level structure diff + intra-block word diff

Rejected alternative — *full htmldiff token-stream* (tokenize both docs into one
linear stream of words+tags, LCS the whole thing, reconstruct HTML wrapping
inserted/deleted runs): finest granularity, but balancing tags when a `<del>`
run crosses element boundaries is the famously fiddly part — hundreds of lines of
edge cases, high risk to hand-roll with no deps.

Chosen — **block-level + word-level**:

1. Walk each document body into a sequence of **block elements**
   (`<p> <li> <h1>…<h6> <blockquote> <pre> <td> <th> <dt> <dd> <figcaption>`, plus
   a sensible default for other leaf-ish blocks): `extractBlocks(body)` →
   `[{ el, text }]`, where `text` is normalized visible text.
2. **LCS over block `text`** classifies each block as `eq` / `ins` (target only)
   / `del` (base only).
3. **Edited-block pairing:** an adjacent `del`-then-`ins` pair whose `similarity`
   ratio clears a threshold (≈0.5) is treated as **one edited block** and gets an
   intra-block **word diff** (`tokenizeWords` + LCS) instead of a wholesale
   delete+insert.
4. **Render by cloning real nodes** from each document, so the carried document
   styling (headings, lists, inline styles from `extractHeadStyles`) is preserved
   for free:
   - `eq` block → clone the target block unchanged.
   - `ins` block → clone target block, add `.nb-diff-ins-block`.
   - `del` block → clone the **base** block, add `.nb-diff-del-block`, placed at
     the corresponding position in the flow.
   - edited block → render the **target** block; wrap inserted words in
     `<ins class="nb-diff-ins">` and deleted words in `<del class="nb-diff-del">`.

Worst case (a fully rewritten block that fails the similarity threshold) degrades
gracefully to `del` block + `ins` block — still correct, just coarser.

**Why block-level over full htmldiff:** the pure-logic core is just LCS over
arrays (small inputs: blocks per doc, words per block), trivially Node-testable;
cloning nodes sidesteps tag-balancing entirely; and it composes cleanly with the
existing per-block highlight painter.

## Architecture (new units kept small)

### 1. `src/runtime/diff.js` — NEW, pure-logic, DOM-free, dual-export

The unit-tested core. No DOM, no `chrome.*`. Attaches to `NotebackRuntime.diff`
and `module.exports`.

- `tokenizeWords(text)` → array of word / whitespace tokens (split that keeps
  separators, so re-joining reproduces the text).
- `diffSequences(a, b, eq?)` → LCS-based op list
  `[{ op: 'eq'|'ins'|'del', items: [...] }]`, generic over arrays. Used for both
  the block sequence (eq by normalized text) and the word sequence (eq by exact
  token). Classic DP LCS; **size-capped** (e.g. `a.length * b.length` over a
  budget → fall back to a coarse "all-del then all-ins" op so a pathological
  input can't hang).
- `similarity(aText, bText)` → `0..1` (word-overlap ratio) for edited-block
  pairing.

### 2. `src/runtime/diff-render.js` — NEW, browser-only, DOM-aware

Attaches to `NotebackRuntime.diffRender` (no `module.exports`; DOM-dependent, so
covered by e2e, not the Node suite — mirrors how the DOM-heavy paths are tested).

- `extractBlocks(body)` → `[{ el, text }]` (block walk described above).
- `renderInlineDiff(baseBody, targetBody, doc)` → mutates/returns a **clone of
  the target body** carrying `.nb-diff-*` block classes and inline
  `<ins>/<del>` word spans. Uses `NotebackRuntime.diff` for the LCS/word work.
- `hasChanges` signal (so the caller can show a "No changes" banner).

Lives **outside** `overlay.js` deliberately — `overlay.js` is already ~2,600
lines; the DOM diff renderer is a self-contained unit with one clear job.

### 3. `src/runtime/overlay.js` — MODIFIED

- New state `let diffMode = false;` beside `viewingKey` / `inlineView`.
- **Toggle control** in the `.nb-hist-view` header (the bar with
  `← Back to current draft`): a diff glyph + a switch labelled `Diff`, right-
  aligned. Click flips `diffMode` and re-renders the current `viewingKey`.
  Disabled (with a tooltip) when the target snapshot is unavailable.
- Split the inline render: `openVersionInline(key)` keeps the snapshot path;
  factor the "build srcdoc + paint comments + inject CSS + peek script + set
  iframe" tail into a shared helper so both snapshot and diff paths reuse it.
  A new `renderDiffInline(key)` path:
  1. `resolveTargetSnapshot(key)` → `{ html, comments, label }` for the next
     chronological version (or the live draft for the most-recent earlier
     version — `snapshotCapture.captureCleanDoc(document)` + current-state
     comments + label `now`).
  2. `history.getVersion({versionKey:key})` → base `{ html, comments }`.
  3. `DOMParser` parse base + target; `diffRender.renderInlineDiff(...)`.
  4. Build the srcdoc from the **target's** `documentElement` (keeps its head /
     carried styles) with the diffed body; inject `DIFF_CSS + HIGHLIGHT_CSS +
     PEEK_POP_CSS`; `paintHighlights` the **target's** comments; add peek +
     scroll scripts; set `iframe.srcdoc`.
  - Header label reflects the comparison, e.g. `Diff: v2 → v3` / `Diff: v3 → now`.
- `resolveTargetSnapshot(key)`: read `history.getHistory()` (earlier versions
  newest-first). Find `key`'s index `i`. `i === 0` (most-recent earlier) → live
  draft target; else → `getVersion(versions[i-1])`. Ordinal labels mirror
  `renderVersionRow`'s `total - i` scheme so base/target labels are consistent
  with the timeline.
- New `DIFF_CSS` (ins/del block + inline styling, chosen to read through the
  comment-highlight background).

### 4. Wiring

Register the two new files in **load order before `overlay.js`** in:

- `manifest.json` — **both** `content_scripts` `js` arrays.
- `bin/noteback.js` — the `RUNTIME_FILES` list (canvas inlining).

`overlay.js` reads them via the existing `modules = rt()` pattern
(`modules.diff`, `modules.diffRender`), exactly like `modules.highlight` /
`modules.markdown`. No `boot.js` change required (overlay grabs them itself).
If either module is absent (defensive), the toggle is hidden.

## Data flow (diff render)

```
toggle Diff ON  (viewingKey = vK)
  └─ resolveTargetSnapshot(vK)
        i = indexOf(vK) in getHistory()  (newest-first)
        i === 0 ? { html: captureCleanDoc(document), comments: state.comments, label:'now' }
                : getVersion(versions[i-1]) → { html, comments, label:'v{…}' }
  └─ getVersion(vK) → base { html, comments }
  └─ DOMParser(base.html), DOMParser(target.html)
  └─ diffRender.renderInlineDiff(baseBody, targetBody, doc) → diffed target body
  └─ build srcdoc from target.documentElement + diffed body
        + DIFF_CSS + HIGHLIGHT_CSS + PEEK_POP_CSS
        + paintHighlights(target.comments) + peek/scroll scripts
  └─ iframe.srcdoc = …   (header: "Diff: v{K} → {label}")
toggle Diff OFF → existing snapshot render of vK
```

## Edge cases / error handling

- **Target snapshot pruned** (`html === ''`, only possible for an *older* version
  whose successor snapshot was evicted by retention) → toggle **disabled** with
  tooltip "No snapshot to diff against". The most-recent-earlier case targets the
  live draft and is never pruned.
- **No changes** between base and target → render the document with a small
  "No changes between v{K} and {label}" banner at the top (still shows the doc).
- **Diff size guard** — `diffSequences` caps `a.length * b.length`; an enormous
  block falls back to coarse del+ins (no word diff) rather than hanging.
- **`DOMParser` unavailable** → toast and stay in the snapshot view.
- **`diff` / `diffRender` module missing** → toggle hidden (feature absent, view
  still works).
- Deleted blocks come from the **base** version, which has no *target* comments —
  they render struck-through with no highlight, which is correct.
- **Highlight anchoring over changed text:** comments are painted **after** the
  diff wraps words in `<ins>/<del>`, so a comment whose quote straddles a changed
  region may fail to re-anchor (the quote is no longer a contiguous text run).
  Comments in **unchanged** regions anchor exactly as in snapshot view — that is
  the guaranteed-correct case the e2e asserts. A changed-region highlight that
  doesn't resolve simply doesn't paint (no crash); acceptable for v1 since the
  changed text is exactly where "the old quote" no longer exists verbatim.

## Testing

- **Node unit — `test/diff.test.js`** (pure-logic `src/runtime/diff.js`):
  `diffSequences` eq/ins/del classification; identical inputs → all-`eq`, no
  changes; fully-disjoint inputs → del-then-ins; `tokenizeWords` round-trips via
  join; `similarity` ordering (near-identical > unrelated); the size-cap
  fallback path. Runs on `node --test`, no DOM.
- **Playwright e2e — `test/e2e/version-diff.e2e.test.js`**: a canvas with ≥2
  commented versions (reuse the `version-timeline` / `history-popup` fixtures) →
  open an earlier version inline → toggle Diff → assert `ins.nb-diff-ins` /
  `del.nb-diff-del` (and/or `.nb-diff-*-block`) appear, comment `mark`s are still
  present (layering), the header reads `Diff: v… → …` → toggle Diff off restores
  the plain snapshot (no diff markers). `diff-render.js` is DOM-aware, so this is
  its coverage.
- Existing Node suite (148 tests) and the version-timeline / file:// e2e stay
  green.

## Docs

- `CONTRACTS.md` — extend the overlay version-view section with the diff toggle
  (base→target = this→next, sticky, comment-highlight layering).
- `CLAUDE.md` — add a gotcha: diff base/target semantics; the new `diff.js` /
  `diff-render.js` modules must be registered in `manifest.json` (both blocks)
  **and** `bin/noteback.js` `RUNTIME_FILES`, before `overlay.js`; comment
  highlights are layered on a separate visual channel from diff coloring.

## Files touched

- `src/runtime/diff.js` — **new** (pure-logic core).
- `src/runtime/diff-render.js` — **new** (DOM diff renderer).
- `src/runtime/overlay.js` — diff toggle + diff render path + `DIFF_CSS` +
  `resolveTargetSnapshot`.
- `manifest.json`, `bin/noteback.js` — register the two new runtime files.
- `test/diff.test.js` — **new** (Node unit).
- `test/e2e/version-diff.e2e.test.js` — **new** (Playwright).
- `CONTRACTS.md`, `CLAUDE.md` — docs.

## Out of scope (YAGNI)

- Side-by-side / two-pane diff.
- Arbitrary "compare any A vs any B" version picker (the diff is always
  this→next).
- Diffing against the live draft from an *older* (non-most-recent) version.
- Character-level (sub-word) diff; word granularity is the floor.
- Persisting diff output or exporting a diff to Markdown.
