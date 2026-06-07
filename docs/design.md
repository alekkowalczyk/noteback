# Noteback — Design Spec

**Date:** 2026-06-03
**Status:** Approved for planning
**Repo:** `noteback/` (open source; license is the author's choice — MIT recommended for max adoption)

---

## 1. Overview

Noteback is a zero-backend Chrome extension for reviewing **local AI-generated HTML documents** (specs, plans, design docs). You highlight a passage, attach a comment anchored to that exact quote, and then either:

1. **Copy the feedback as Markdown** to paste back to an AI or a person, or
2. **Save the document as a self-contained "feedback canvas"** — a single HTML file with your highlights and comments baked in, that the recipient can open, read, *add their own comments to (no extension required)*, and re-share. An AI handed that file can act on the feedback directly.

It runs entirely locally. No server, no account, no telemetry.

### The workflow it serves

> An AI generates an HTML doc → you open it locally → you annotate it → you send the feedback back to the AI (next prompt) **or** to the human who shared it (who will likely paste it into *their* AI).

---

## 2. Goals & non-goals

### Goals (the two co-equal pillars)
- **G1 — Frictionless browser overlay.** Annotating a local HTML doc should feel as natural as commenting in Google Docs: select text, type a note, done. Zero setup beyond installing the extension.
- **G2 — Best-in-class feedback export.** The output must be excellent for *both* audiences it can travel to: a human reviewer and an AI model. This is what separates Noteback from generic web annotators.

### Non-goals (v1)
- Not a general "annotate any website" tool (the annotation space is saturated; we win the local-AI-doc niche).
- Not a PDF annotator.
- No cloud sync, accounts, or collaboration server.
- Not a replacement for Plannotator's local-URL flow — Noteback is the *zero-setup, works-on-any-open-tab* alternative.

---

## 3. Positioning & naming

- **Brand:** **Noteback** — "note it → send it back." Verified clear on the Chrome Web Store and GitHub (only adjacent note-takers exist; nobody owns the word). *To-do before launch: confirm npm package name + a domain are also free.*
- **Discoverability strategy:** the generic word "annotate" is unwinnable (Web Highlights, Glasp, Hypothesis, etc.). Instead, own the wide-open long-tail: *"feedback for AI / annotate AI docs / review LLM specs / copy feedback to Claude."*
  - **Web Store listing title:** `Noteback — Annotate AI Docs & Copy/Share Feedback for Claude, ChatGPT & co.`
  - **GitHub topics:** `chrome-extension`, `annotation`, `ai`, `llm`, `claude`, `chatgpt`, `feedback`, `code-review`, `manifest-v3`, `html`.
  - Do **not** put "Claude"/"ChatGPT" in the brand name (trademarks); naming them in the *description* is fine and good for search.

---

## 4. Architecture

Chrome **Manifest V3**, fully client-side.

### 4.1 The key architectural decision: one portable runtime, two modes

The annotation engine (selection → popover → highlight painting → comment list → serialization) is built **once** as a self-contained module, and runs in two modes:

| Mode | Host | State store | Used by |
|------|------|-------------|---------|
| **Extension mode** | Injected as a content script into local pages | `chrome.storage.local` | The original author (has the extension) |
| **Embedded mode** | Inlined as a `<script>` into a saved canvas file | In-file `<script type="application/json" id="noteback-state">` block | Recipients (no extension needed) |

This means the "anyone can collaborate on the canvas without installing anything" capability falls out of the *same codebase* that powers the extension. It is the heart of the design.

### 4.2 Components

- **`runtime/`** — the portable engine. No Chrome API calls directly; talks to an injected **storage adapter** so it works in both modes.
  - `StorageAdapter` interface: `load()`, `save(state)`. Two implementations: `ChromeStorageAdapter`, `InFileStateAdapter`.
- **`content-script.js`** (extension mode) — boots the runtime with `ChromeStorageAdapter`, mounts the overlay (floating button, popover, sidebar) into the page.
- **`background/service-worker.js`** — handles the toolbar action, "Save as HTML canvas" assembly (reads page HTML + state, produces the self-contained file), and onboarding checks.
- **`popup/`** — toolbar popup: toggle sidebar, "Copy as Markdown", "Save as HTML canvas", onboarding status.
- **`canvas-template/`** — the HTML shell used when exporting: original doc body + inlined runtime + `InFileStateAdapter` + state block + guiding comment.

### 4.3 Permissions (minimal — eases Web Store review)

- `storage` — persist comments.
- `activeTab` + `scripting` — inject/act on the current tab on demand.
- Host permissions limited to local docs: `file:///*`, `http://localhost/*`, `http://127.0.0.1/*`.
- `downloads` — for the "Download with my comments" export.
- Note: `file://` injection additionally requires the user to enable **"Allow access to file URLs"** on the extension's details page (see §9).

---

## 5. Data model

A document's annotation state:

```jsonc
{
  "schemaVersion": 1,
  "docId": "file:///Users/.../spec.html",   // path/URL = identity key
  "docTitle": "spec.html",
  "comments": [
    {
      "id": "c_<stable-id>",
      "anchor": {
        "quote": "a queue which decouples the producer and consumer",
        "prefix": "The system uses ",      // ~32 chars before
        "suffix": " so that bursts are",   // ~32 chars after
        "occurrence": 0                     // nth match of quote in doc text
      },
      "body": "use a stream here instead",
      "createdAt": "<ISO-8601>",            // stamped by runtime at save time
      "author": null                        // RESERVED for multi-author (v1.1)
    }
  ]
}
```

- **Identity:** keyed by `docId` (the file path/URL). Re-opening the same file restores its comments.
- **`author` is reserved now** so the schema doesn't break when multi-author attribution lands (§11). v1 leaves it `null`.

---

## 6. Annotation & anchoring

- **Interaction:** select text → a small floating **"💬 Comment"** button appears near the selection → click → popover with a textarea → save. The comment attaches to the exact quote.
- **Anchoring (text-quote, W3C / Hypothesis style):** store `quote` + `prefix`/`suffix` context + `occurrence` index. On load, re-find the text by searching the rendered document text and re-paint the highlight. Chosen over raw character offsets because it survives minor DOM/whitespace differences. (These AI docs rarely change once generated, but this keeps re-anchoring robust.)
- **Rendering:** matched ranges get a highlight style; clicking a highlight scrolls to / focuses its sidebar entry, and vice versa.
- **Orphans:** if a quote can no longer be found (doc was regenerated), the comment is kept and shown in the sidebar in an **"unanchored"** section rather than silently lost.

---

## 7. UI

```
┌────────────────────────────────────┬──────────────────────┐
│  spec.html (your AI-generated doc)  │  Noteback        [x] │
│                                     │  2 comments          │
│  ## Architecture                    │ ┌──────────────────┐ │
│  The system uses a ▓▓▓▓▓▓▓▓▓ which  │ │"...a queue which"│ │
│  ▓▓▓▓ queue which decouples...      │ │ ↳ use a stream   │ │
│        └ highlighted, click to      │ │   here instead   │ │
│          jump to its comment        │ └──────────────────┘ │
│                                     │ ┌──────────────────┐ │
│  ## Data Model              [💬]    │ │"single users..." │ │
│  Each user has a single...          │ │ ↳ should be many │ │
│                                     │ └──────────────────┘ │
│                                     │ [Copy as Markdown]   │
│                                     │ [Save as HTML canvas]│
└────────────────────────────────────┴──────────────────────┘
```

- **Floating comment button** on text selection.
- **Comment popover** for entry/editing.
- **Sidebar** (toggleable; injected, does not disturb doc layout): lists all comments with their quotes; edit/delete; the two export actions; an "unanchored" group when applicable.
- The sidebar UI **is the same component** that ships inside the embedded canvas (mode-agnostic).

---

## 8. Export

### 8.1 Copy as Markdown (the simple path)

Clean, neutral, readable by a human *and* an AI (no presumptuous instructions). Default format:

```markdown
# Feedback on spec.html
2 comments — 2026-06-03

1. > "a queue which decouples the producer and consumer"
   use a stream here instead

2. > "Each user has a single workspace"
   should support many
```

- Copied to clipboard via the Clipboard API.
- *Future enhancement (not v1):* optional "group under nearest heading" and an optional AI-instruction preamble toggle.

### 8.2 Save as HTML feedback canvas (the differentiator)

Produces **one self-contained `.html` file** = original doc + highlights + comments + embedded runtime. It is **fully interactive in v1**: a recipient with no extension can open it, read the feedback, **add/edit/delete their own comments**, and re-share.

The saved file contains:
1. The original document markup (so it renders identically).
2. Visible annotations (highlights + comment markers/sidebar) painted by the embedded runtime.
3. A machine-readable **state block**: `<script type="application/json" id="noteback-state">…</script>`.
4. A one-line **guiding HTML comment** at the top so any AI handed the file knows what it is:
   `<!-- Noteback feedback canvas: each item is a quoted passage + a note. Please revise the document accordingly. -->`
5. The inlined **portable runtime** + `InFileStateAdapter`.

**AI consumption:** an AI can act on the canvas whether it reads the visible annotated text or parses the JSON state block — both are present and consistent.

### 8.3 Re-sharing the canvas — self-modification mechanics

A saved HTML file **cannot silently overwrite itself** (browser security boundary). Re-sharing therefore works in tiers, feature-detected at runtime:

- **Baseline (always available, incl. `file://`): "Download with my comments."** The runtime serializes current state into a fresh HTML blob and triggers a download (suggested filename = original). Non-destructive — each round is its own versioned file.
- **Enhancement (secure contexts, e.g. `localhost`/`https`): in-place "Save."** If `'showSaveFilePicker' in window`, offer a real overwrite via the File System Access API (requires a user gesture + one-time permission prompt + the user pointing the picker at the file). Falls back to download if unavailable or declined. **Not** relied upon for the primary `file://` workflow.

**Asymmetry to remember:** the original author (with the extension) never touches this — their edits autosave to `chrome.storage.local`. The download/save flow exists only for *extension-less recipients*, which is exactly the canvas's audience.

---

## 9. Onboarding & permissions UX

- On first run / first local-doc visit, detect whether **"Allow access to file URLs"** is enabled. If not, show a one-time card with the exact steps to enable it (with a deep link to the extension's details page where possible).
- `localhost`/`127.0.0.1` need no such toggle — call that out so users serving docs locally get a frictionless path.

---

## 10. Privacy & open-source posture

- 100% local: no network calls, no analytics, no accounts. State lives in `chrome.storage.local` and inside saved files only.
- This is both a privacy selling point and a fast Web Store review (minimal permissions, no remote code).
- Repo includes README (with the keyword-rich description), LICENSE, and a short CONTRIBUTING; runtime is framework-light to keep the embedded canvas small.

---

## 11. MVP scope vs. future

### In v1 (MVP)
- Extension injects on `file://` + `localhost`; selection → comment; persistent highlights; sidebar.
- Robust text-quote anchoring with an "unanchored" fallback group.
- **Copy as Markdown.**
- **Save as fully-interactive HTML feedback canvas** (download baseline + feature-detected in-place save).
- Onboarding for "Allow access to file URLs."

### Explicitly out of scope for v1 (clean fast-follows)
- **Author attribution / multi-round threads** — distinguishing whose comment is whose, a color per author, "reply" to a comment. Data model already reserves `author`. *Likely first fast-follow.*
- Image/diagram pin comments (click-to-pin).
- "Any web page" mode (broaden host permissions).
- Custom export templates + AI-instruction preamble toggle + "group under heading."
- Severity/type tags (nit / question / change-request).
- Multi-doc dashboard, cloud sync.

---

## 12. Testing approach

- **Runtime unit tests** (mode-agnostic): anchoring (find/re-find/orphan), state serialization round-trip, Markdown export formatting.
- **Adapter tests:** `ChromeStorageAdapter` and `InFileStateAdapter` satisfy the same contract.
- **Canvas integration test:** export a canvas, re-open the produced HTML in a bare page (no extension), assert highlights render and a new comment can be added + re-serialized.
- **Manual smoke matrix:** `file://` doc, `localhost` doc, large doc, doc with duplicate phrases (occurrence index), regenerated doc (orphans).

---

## 13. Open questions (to resolve during planning)

- Markdown default: confirmed clean/neutral format above; revisit whether to include an optional heading-context line by default.
- Canvas size budget: target max inlined runtime size (keep the self-contained file lean).
- Build tooling: plain JS modules vs. a light bundler (needed to inline the runtime into the canvas template) — decide in the plan.

---

## 14. Snapshot-based document history (2026-06-06)

**Status:** implemented (PR #4). **Supersedes** the per-fragment "earlier feedback"
model and refines §5 (data model) and §8.3 (re-sharing): a document now owns an
ordered list of whole-document **versions**, and the canvas and extension share one
history engine. The enforced runtime contract for this lives in `CONTRACTS.md` §8;
the non-obvious gotchas live in `CLAUDE.md`. This section records the *design
decisions and rationale* so they aren't lost when the planning artifacts are removed.

### 14.1 The problem — two stories, one of them blank

There used to be two unrelated persistence stories, and only one had any history:

| | Extension | Embedded canvas |
|---|---|---|
| Identity | full URL (`location.href`) | content hash + normalized URL |
| Backend | `chrome.storage.local` | in-file JSON + `localStorage` |
| History | **none at all** | yes — but stored as padded fragments |

The embedded "earlier feedback" stored padded *sections* around each selection,
re-highlighted across text nodes with whitespace-loose matching, then trimmed to a
byte cap. That subsystem (`snapshot.js`, ~311 lines) is where several shipped bugs
lived: empty captures, first-mark-only unions, a paint-before-persist trap. Meanwhile
the extension — where the author's real iterate-and-re-comment loop happens — had no
history at all.

### 14.2 Mental model — one timeline of versions

Collapse "current comments" and "earlier feedback" into a single concept: **a
document owns an ordered list of versions, and each version is a complete, openable
document with its comments attached.** "Current" is just the newest node, not a
separate category. The per-version key is the **content hash**, or a minted id when
the content is too short to hash (`h0:<docId>`). A history entry is therefore the
*same kind of thing* as the live document — a whole doc you open and read in context,
not a clipped fragment that must be reconstructed. That equivalence is what removes
the complexity.

### 14.3 Identity — baked when we own the HTML, URL-mapped when we don't

Identity is one concept with two acquisition paths:

- **`wrap` / "Save as canvas"** bakes a stable `data-noteback-doc-id` onto
  `#noteback-doc-root`. It travels with the file, survives renames/moves, and `wrap`
  **preserves** it on re-export (precedence: explicit `--id` → the id baked in the
  `-o` target → the id baked in the input → mint).
- **Extension on a page it didn't author** looks up (or mints) a doc-id in a
  `chrome.storage` `nb:url:<href>` → doc-id map.

A baked id always **wins** over a URL lookup, so landing on a wrapped canvas chains
its history correctly; saving a bare page as a canvas is where a URL-keyed page first
gets a baked id minted into the output.

### 14.4 One sidebar, every stage of the doc's life

A single panel adapts to where you are:

- **Working state** — live comments pinned at top; every earlier version that
  received feedback is a timeline node below, newest first. Each past row offers
  **peek** (click the row — renders that version in context), **open** (checks it out
  as a full canvas tab), and **copy feedback** (that version's markdown).
- **Collapse rule (keep the panel calm):** the Versions group is **hidden at 0**
  earlier versions, shown **inline at exactly 1**, and at **2+** the most-recent
  earlier version stays inline while the rest tuck under a "+N older versions"
  disclosure. Last round of feedback is always zero-click; deeper history is one click;
  the current draft is never buried.
- **Layout:** the live comments (or the "No notes yet" empty state) own the scrollable
  space; the Versions timeline **docks at the bottom** — a bounded, self-scrolling band
  above the action buttons — so it never pushes the current draft's notes out of view.
- **Peek** renders that version full-bleed in a modal: the snapshot **fills the panel**
  (it's an `<iframe>`, a replaced element, so it needs an explicit height — top+bottom
  alone collapse it to a thin strip), with highlights **styled exactly like the live
  document** (the shared `HIGHLIGHT_CSS` is re-injected into the clean snapshot). A single
  pinned **"← Back"** banner spans the top and closes it (no separate ✕ — it'd be
  redundant). Clicking a highlight **inside** the peek pops that comment in place (the
  id→comment map is serialized into the iframe; bodies render via `textContent`, never
  parsed as HTML, and any literal `</script>` is escaped). **Open** promotes the same
  version to a live canvas in a new tab.
- **Per-row actions live behind a chevron** next to the v-label (same dropdown
  affordance as Save/Copy): **Open** (disabled when the snapshot is pruned) and **Copy
  feedback**. The menu is portaled to `uiRoot` and fixed-positioned in JS because the
  versions dock clips overflow. Clicking the row body still peeks.
- **Opened-version tab = the same sidebar, one stage back.** A checked-out version is
  *just a canvas*, so it boots the same overlay — its content hash makes the opened
  version the tab's "now". So the timeline already renders there; we only add
  orientation: the canvas bakes `data-noteback-checkout=<live current key>`, the overlay
  relabels the now-row **"viewing"** (still `you are here`, but it's the version you
  opened, not the live latest), badges the live draft's row **"current"**, and shows an
  **"Open current →"** banner that re-opens the current draft. (This needs the opened tab
  to share the canvas's history store — true for a localhost-served blob: tab; a `file://`
  blob with no shared storage degrades to comments-only, no timeline.)
- **Edge states:** first read (Versions list hidden until there's something in it);
  history unavailable (storage blocked or content too short to fingerprint — comments
  still save, only the timeline steps aside); a site you haven't opted into (no
  timeline until opted in); a version old enough to have been pruned (peek is a no-op).

### 14.5 How it works

- **One engine, two backends.** `draft-history-core.js` is storage-agnostic (it takes
  an injected kv store). Embedded uses an inline `localStorage` kv; the extension uses
  a thin `chrome.storage` kv shim (`chrome-kv-store.js`) feeding the *same* engine. The
  mode divergence disappears.
- **Snapshot trigger: first comment of a version.** When a version's comment count
  goes 0 → 1, capture the **clean full-doc HTML** (`snapshot-capture.captureCleanDoc`:
  clone the document, strip `[data-noteback-ui]`, unwrap `<mark>`, drop the runtime
  `<script>` + state block), gzip, and store. A version's content is fixed, so it's
  captured **once**; later comments only update the list.
- **Rendering history = the live painter.** Because we store the clean doc plus comment
  anchors (not painted marks), showing a historical version just runs the normal
  highlight painter against the snapshot. No cross-node whitespace-loose re-highlighter;
  no padded-section reconstruction.
- **Key spaces:** `nb:doc:<doc-id>` (lineage: title + ordered version list),
  `nb:ver:<version>` (one version: doc-id, contentHash, comments, gzipped clean
  snapshot, timestamps), `nb:url:<url>` → doc-id (extension only, when no baked id).

### 14.6 What it retired

- Most of `snapshot.js` (~311 lines): `extractSections`, `padContext`, `trimToCap`,
  section union/dedupe — deleted, along with `localstorage-state-adapter.js`.
- The cross-node, whitespace-loose `nbHistHighlight` re-highlighter — replaced by the
  normal painter.
- The **"paint before persist" bug class** — structurally impossible now; snapshots no
  longer read painted marks from the DOM.
- The embedded-vs-extension behavioral gap — one engine, one behavior.

### 14.7 Locked decisions

- **Checkout depth — full:** inline peek + open as a live canvas tab + copy feedback.
- **Re-wrap continuity — yes:** `wrap` preserves the baked doc-id (reuse from the `-o`
  target, plus a `--id` escape hatch). Worst case it mints a new lineage — graceful.
- **"Return to live" wording — "Back"** (one full-width banner; the redundant ✕ is gone).
- **Sequencing — both modes at once:** one cutover to the shared engine + both kv
  backends.
- **Collapsed history:** most-recent earlier version inline; rest under "+N older
  versions".
- **Retention:** reuse existing limits (≈5 full snapshots · 15 metadata · 90-day TTL ·
  ~3 MB cap). The embedded `file://` path shares one `localStorage` bucket across all
  local canvases, so the cap matters most there; the extension's `chrome.storage` is
  per-extension (no shared-bucket pressure). `unlimitedStorage` deferred.
- **Migration — clean break:** no migration code. Embedded current comments still load
  from the in-file block; extension per-URL comments reset on upgrade.
- **Extension snapshot scope:** on by default for `file://`/`localhost`/wrapped
  canvases; **opt-in per site** for arbitrary http(s) pages, riding the existing
  `origin-policy` / `nb:settings` per-origin mechanism (no new settings system).

### 14.8 Implementation learnings

Captured during execution (the value of two-stage + whole-branch review):

- **Snapshot suppression bug.** `hasSnapshot` must be seeded from the *real stored
  snapshot* (`!!ver.snapshotHtml`), **not** `comments.length > 0`. Seeding from the
  comment count wrongly suppressed capture for a version pre-seeded with in-file
  comments. Now regression-tested.
- **Checkout self-XSS.** The checkout tab re-seeds `#noteback-state` via `outerHTML`,
  which emits raw text verbatim — a comment body containing `</script>` breaks out of
  the block. It must be escaped (`.replace(/<\/(script)/gi, '<\\/$1')`, the same escape
  the canonical exporter uses). e2e-guarded. *(A pre-existing twin in
  `exporter.js`'s `rebuildHtml` was noted as a separate follow-up.)*
- **Runtime-list drift (cross-task gap).** There are **three** hardcoded "canvas
  inline file" lists that must stay identical: `bin/noteback.js` `RUNTIME_FILES`,
  `examples/build-canvas.js`, and `src/background/service-worker.js`
  `CANVAS_RUNTIME_FILES` (the extension's "Save as HTML canvas" path). Only the first
  two were updated for the new modules; the service-worker list drifted, so
  extension-saved canvases booted without history. Every single-task review passed —
  this only surfaced in whole-branch review. `test/canvas-runtime-parity.test.js` now
  asserts all three agree so it can't recur. (`chrome-kv-store.js` is intentionally
  excluded from canvas lists — it's extension-only; the canvas builds an inline
  `localStorage` kv.)
