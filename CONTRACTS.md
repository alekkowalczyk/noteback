# Noteback — Integration Contracts

This document is the **single source of truth** for the cross-module interfaces in
Noteback v1. Every implementation phase MUST honor these signatures exactly so the
portable runtime works identically in **extension mode** (content script +
`chrome.storage.local`) and **embedded mode** (inlined in a saved canvas +
in-file JSON state block).

Read this together with the design spec:
`docs/design.md`.

---

## 0. Hard environment constraints (do not violate)

- Chrome **Manifest V3**. **Vanilla JavaScript only** — NO TypeScript, NO npm
  dependencies, NO bundler, NO build step. The extension loads unpacked exactly
  as written.
- The **pure-logic** runtime modules (`anchor.js`, `state.js`, `markdown.js`) MUST
  run **both** in a browser **and** under Node's built-in test runner. They use the
  dual-export ("UMD-lite") pattern in §4.
- **DOM** runtime modules (`highlight.js`, `overlay.js`, `boot.js`) are
  **browser-only**: they attach to the `NotebackRuntime` global only (no
  `module.exports`).
- Content scripts **cannot** use ES module `import`. Runtime files are listed in
  dependency order in the manifest's `content_scripts[].js` array and share the
  `NotebackRuntime` global.
- The service worker inlines the runtime into an exported canvas by fetching each
  runtime file's text via `fetch(chrome.runtime.getURL(path))` and concatenating
  it into a single inline `<script>`. **Every runtime file must be listed in
  `web_accessible_resources`.**
- Tests use the **Node built-in runner only**, with `node:test` +
  `node:assert`. NO test framework. Run with `npm test`, which expands to
  `node --test "test/**/*.test.js"`. (Note: under Node 22 the bare directory form
  `node --test test/` is treated as a module entry point and fails — use the glob
  form or plain `node --test` auto-discovery instead.)

---

## 1. StorageAdapter contract

Both storage modes implement the **same** asynchronous interface. The runtime never
touches Chrome APIs or the DOM state block directly — it only talks to an injected
adapter.

```js
/**
 * @typedef {Object} StorageAdapter
 * @property {() => Promise<State|null>} load
 *   Resolve the persisted State for the current document, or null if none exists.
 * @property {(state: State) => Promise<void>} save
 *   Persist the given State. Resolves when durably written (best-effort).
 */
```

Rules:
- `load()` returns `null` (not `{}`) when nothing is stored yet — callers create a
  fresh State via `state.createState(...)`.
- `save(state)` accepts a **valid** State (see §2). Adapters do not mutate the input.
- Adapters are **stateless wrappers** over their backing store; identity is the
  `docId` inside the State, not adapter instance.

**History-mode extension.** When the adapter is the **snapshot-history adapter**
(`createHistoryStateAdapter`, §8) it additionally exposes
`getHistory() -> Promise<Version[]>`, `getVersion({versionKey}) -> Promise<{html, comments, docTitle, contentHash}|null>`,
`getCurrentVersionKey() -> Promise<string|null>` (THIS document's current version key
— its content hash, or `null` when degraded), `exportHistory() -> Promise<{schemaVersion, entries}|null>`
(this doc's full history as a kv-key → record map, snapshots included; used by "save
with comments and history" to embed history in the file), and
`clearCurrent() -> Promise<void>`. The overlay
feature-detects these (via the `history` config passed to `boot`, §3.7) to drive the
version timeline; the comments-only `ChromeStorageAdapter`/`InFileStateAdapter` don't
have them and the timeline stays hidden. There is no per-comment "section" lookup —
history operates on whole-document version snapshots, not extracted fragments.

**Inline version view.** Clicking a version row calls `openVersionInline(versionKey)`,
which opens a read-only `<iframe srcdoc>` side panel (`.nb-hist-view`) beside the
sidebar — same tab, same origin. An in-tab `viewingKey` (null = live draft) drives the
timeline: the viewed row is the active `nb-ver-viewing` row (active dot + highlight, no
text label), a "Back to current" bar (`renderBackToCurrentBar`) is shown above the
timeline and calls `closeVersionInline()` to return to the live draft, and every other
row remains clickable to switch the view. Inline viewing never mutates the live
document. There is no new-tab checkout: `openVersionTab` and the
`data-noteback-checkout` marker were removed because a `window.open(blob:)` tab spawned
from a `file://` canvas gets an opaque origin whose `localStorage` is denied, leaving
the opened tab's history sidebar empty.

- **Diff view.** While viewing an earlier version inline, a "Diff" toggle in the
  panel header re-renders the document as an inline, formatting-preserving diff of
  the viewed version (base) against the **next chronological version** (target):
  the most-recent earlier version diffs against the live current draft ("now").
  Added runs are green `<ins class="nb-diff-ins">` / `.nb-diff-ins-block`, removed
  runs red `<del class="nb-diff-del">` / `.nb-diff-del-block`, edited paragraphs
  `.nb-diff-edit-block` (word-level). To read unmistakably as a comparison (not as
  document content), the diff iframe gets a sticky legend header
  (`.nb-diff-legend` — "Comparing v{from} → {to}" + a colour key) and each changed
  block carries a left gutter rail (a `+`/`−`/`✎` badge + thick change-bar via
  `::before`) and an `Added`/`Removed`/`Edited` tag (`::after`) — a SOLID,
  saturated, square label filled with the rail colour (not a pale wash), on a
  square-cornered block, so the change type registers instantly. Word changes use a
  shape cue (underline for adds, strike-through for deletes) on top of colour.
  Comment highlights stay painted (layered on a separate visual channel). The
  legend also carries a right-aligned **Prev/Next change navigator** (a `n / N`
  counter between two buttons) driven by an in-iframe script (`buildDiffNavScript`):
  it steps a `.nb-diff-focus` pointer through the changed blocks in document order,
  scrolling each to centre with a colour ring + intensified fill, wrapping at both
  ends. A **"Show diff"** shortcut on the live `now` timeline row
  (`.nb-ver-diff`) opens the latest-version → now diff directly (diff toggle
  pre-armed) — equivalent to opening that version's row and enabling Diff. The
  toggle is sticky while switching version rows and
  resets on "Back to current". Pure diff logic lives in `NotebackRuntime.diff`
  (`src/runtime/diff.js`); DOM rendering in `NotebackRuntime.diffRender`
  (`src/runtime/diff-render.js`).

**Version save actions.** A version row's `▾` actions menu offers **Copy feedback**,
**Save HTML with comments**, and **Save clean HTML** (both saves disabled when the
version's snapshot is pruned). "Save HTML with comments" rebuilds a re-openable canvas
of that version via `buildVersionCanvasHtml(v, docId, docTitle)` (clone the live shell,
swap in the snapshot content, re-seed `#noteback-state` with the version's comments,
escaping `</script>`; no checkout marker); "Save clean HTML" saves the raw `v.html`
snapshot. Both route through `exporter.onSaveHtml(html, name)` and are **downloaded** —
opening the file later is a fresh `file://` canvas with its own storage, which is why
this re-uses a version-canvas builder without reintroducing the opaque-origin bug.

Implementations (all satisfy the `load`/`save` core; covered by the adapter tests
under `test/` — `history-state-adapter.test.js`, `chrome-kv-store.test.js`,
`draft-history-core.test.js`):

| Implementation        | File                                      | Backing store |
|-----------------------|-------------------------------------------|---------------|
| `ChromeStorageAdapter`| `src/adapters/chrome-storage-adapter.js`  | `chrome.storage.local`, keyed by `docId` (comments-only) |
| `InFileStateAdapter`  | `src/adapters/infile-state-adapter.js`    | the in-file `<script id="noteback-state">` JSON block |
| `createHistoryStateAdapter` | `src/adapters/history-state-adapter.js` | a kv store (chrome- or localStorage-backed) + the history core, wrapping an inner adapter (§8) |

### 1.1 ChromeStorageAdapter

```js
/**
 * @param {string} docId  Identity key (file path / URL).
 * @param {object} [chromeApi]  Defaults to the global `chrome`; injectable for tests.
 * @returns {StorageAdapter}
 */
function createChromeStorageAdapter(docId, chromeApi) { ... }
```
- Storage key convention: `"noteback:" + docId`.
- `load()` reads that key and returns the parsed State (or null).
- `save(state)` writes the whole State object under that key.

### 1.2 InFileStateAdapter

```js
/**
 * @param {Document} [doc]  Defaults to the global `document`.
 * @returns {StorageAdapter}
 */
function createInFileStateAdapter(doc) { ... }
```
- `load()` reads the text of `#noteback-state` (see §5) and `JSON.parse`s it; null if
  absent/empty.
- `save(state)` writes `JSON.stringify(state)` back into that script element's text
  content. (It does NOT persist to disk — re-sharing is handled by the exporter's
  download / File System Access flow, §6.)

### 1.3 Settings: per-origin activation (extension mode only)

Stored in `chrome.storage.local` under the single key **`nb:settings`** (distinct
from per-document state, which is keyed `"noteback:" + docId`, §1.1). Shape:

```jsonc
{
  "version": 1,
  "origins": { "file": true, "localhost": true, "127.0.0.1": true },
  "disabledSites": [],  // canonical origins, e.g. "http://localhost:3000"; "file://" for file pages
  "historySites": []    // canonical origins opted IN to snapshot history (§8); other origins are comments-only
}
```

A missing/partial object reads as **all-on, nothing disabled, history opt-in empty**
(current behavior; zero migration). `src/content/origin-policy.js` is the single
source of truth and is shared by the content script (gating) and the popup
(rendering toggles):

- `classifyOrigin(loc) -> 'file' | 'localhost' | '127.0.0.1' | 'other'`
- `originOf(loc) -> canonical origin` (`"file://"` for file pages)
- `normalizeSettings(s) -> { origins, disabledSites, historySites }` (defaults filled)
- `isActive({type, origin}, settings)` — **active** iff `origins[type] !== false`
  **and** `origin ∉ disabledSites`. Per-type is the master gate; per-site only
  subtracts a single origin. `'other'` is never active.
- `historyAllowed({type, origin}, settings)` — gates the **snapshot-history engine**
  (§8). Default-**on** for `file`/`localhost`/`127.0.0.1`; for any other origin it is
  opt-in via `origin ∈ historySites`. When false the content script keeps the
  comments-only `ChromeStorageAdapter` (no version timeline). Decided at first mount.
- `overlayMounted(doc) -> boolean` — true when a Noteback overlay is already mounted on
  `doc` (any `[data-noteback-ui]` node). The content script calls this to stand down on a
  page whose own embedded canvas runtime already booted (see §3.7's cross-world note);
  `doc` is caller-supplied, so the module stays node-testable.

**Active** → the content script mounts the overlay. **Dormant** → injected but
mounts nothing (no chip, launcher, or listeners); stored comments are untouched.
The content script re-evaluates live on `chrome.storage.onChanged`, so popup
toggles take effect without a page reload. `NOTEBACK_PING` reports
`{ booted, dormant, originType, origin }` so the popup distinguishes "off by
settings" from "no file access". The embedded canvas is unaffected — it has no
settings and always shows its UI.

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
activation. The injected list is **exactly** `content_scripts[0].js` from the
manifest (the same files the browser would auto-inject), so it never drifts.

---

## 2. State schema (schemaVersion 1)

Exactly as design spec §5. This is the canonical shape produced/validated by
`state.js`, persisted by adapters, exported in the canvas state block, and consumed
by `markdown.js`.

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
        "prefix": "The system uses ",      // ~32 chars before the quote
        "suffix": " so that bursts are",   // ~32 chars after the quote
        "occurrence": 0                     // 0-based nth match of quote in doc text
      },
      "body": "use a stream here instead",
      "createdAt": "<ISO-8601>",            // stamped by runtime at create time
      "author": null                        // RESERVED for multi-author (v1.1); always null in v1
    }
  ]
}
```

Field rules:
- `schemaVersion` — integer, currently `1`.
- `docId` — string; the document identity key. Re-opening the same file restores
  its comments. In **comments-only** modes this is the file path / URL
  (`location.href`). The **snapshot-history** engine (§8) uses a separate, explicit
  doc-id — the value baked into `#noteback-doc-root[data-noteback-doc-id]` (§5), or a
  per-URL minted id for extension pages Noteback didn't author. Its version records
  (`nb:doc:` / `nb:ver:`) live in §8, not in this State block.
- `docTitle` — string; human label (usually the file name).
- `comments` — array, possibly empty, order = creation order.
- `comment.id` — string, format `"c_" + <stable unique id>`.
- `comment.anchor` — either a text-quote anchor object (below) **or `null`**. A `null`
  anchor denotes a **document-level comment** — a note about the whole document rather
  than a quoted passage. This is distinct from an *orphan* (a non-null anchor whose
  quote no longer matches the text). Document-level comments render in Markdown as
  `(note on the whole document)` and group separately in the sidebar.
- `comment.anchor.quote` — the exact selected text (required, non-empty when anchor is present).
- `comment.anchor.prefix` / `suffix` — up to ~32 chars of surrounding document text
  (may be empty strings at doc boundaries).
- `comment.anchor.occurrence` — 0-based index selecting which match of `quote` in the
  full document text this comment targets (disambiguates duplicate phrases).
- `comment.body` — the note text (may be empty while editing; non-empty when saved).
- `comment.createdAt` — ISO-8601 timestamp string, stamped at creation.
- `comment.author` — always `null` in v1 (reserved).

A comment is **orphaned/unanchored** when its `quote`/`occurrence` can no longer be
located in the current document text (spec §6). Orphans are retained in State and
surfaced in the sidebar's "unanchored" group — never silently dropped.

---

## 3. Module API surface (signatures later phases fill in)

### 3.1 `runtime/anchor.js` (pure; dual-export → `NotebackRuntime.anchor`)
Text-quote (W3C / Hypothesis-style) anchoring over a document's plain text.

```js
/**
 * Extract the full searchable text of a root node (browser) — for anchoring.
 * @param {Node} root
 * @returns {string}
 */
function getDocumentText(root) { ... }

/**
 * Build an anchor descriptor from a selected substring of `docText`.
 * @param {string} docText        Full document text (from getDocumentText).
 * @param {number} startIndex     Start offset of the selection within docText.
 * @param {number} endIndex       End offset (exclusive) within docText.
 * @param {number} [contextLen=32]
 * @returns {{quote:string, prefix:string, suffix:string, occurrence:number}}
 */
function describeAnchor(docText, startIndex, endIndex, contextLen) { ... }

/**
 * Re-find an anchor's character range within docText.
 * @param {string} docText
 * @param {{quote:string, prefix:string, suffix:string, occurrence:number}} anchor
 * @returns {{start:number, end:number}|null}  null when orphaned.
 */
function findAnchor(docText, anchor) { ... }
```

### 3.2 `runtime/state.js` (pure; dual-export → `NotebackRuntime.state`)

```js
function createState(docId, docTitle) { ... }            // -> fresh State (empty comments)
function validateState(state) { ... }                    // -> {valid:boolean, errors:string[]}
function addComment(state, { anchor, body }) { ... }      // -> new State (immutable); stamps id+createdAt+author:null
function editComment(state, id, { body, anchor }) { ... } // -> new State
function deleteComment(state, id) { ... }                 // -> new State
function serialize(state) { ... }                         // -> JSON string
function deserialize(json) { ... }                        // -> State (throws/returns null on invalid)
```
- All mutators are **pure**: they return a new State and never mutate the input.
- `addComment` stamps `id` (`"c_"+id`), `createdAt` (ISO-8601), and `author:null`.

### 3.3 `runtime/markdown.js` (pure; dual-export → `NotebackRuntime.markdown`)

```js
/**
 * Render State to the clean/neutral Markdown of spec §8.1.
 * @param {State} state
 * @param {{date?: string, docHtml?: string}} [opts]
 *   date    defaults to today (YYYY-MM-DD).
 *   docHtml the document's HTML source. When supplied, each anchored quote is
 *           located in it and annotated with a `(line N)` / `(lines A–B)` ref,
 *           and the header gains a "Line numbers refer to…" note (only if at
 *           least one quote actually resolved). Omit it → no line refs.
 * @returns {string}
 */
function toMarkdown(state, opts) { ... }

// Also exported (for tests / callers): condenseQuote(quote), lineRangeOf(docHtml, quote, occurrence).
```
Output shape (spec §8.1, with `docHtml` supplied):
```
# Feedback on <docTitle>
<N> comments — <YYYY-MM-DD>
Line numbers refer to the document's HTML source.   ← only when ≥1 ref resolved

1. > "<quote>" (line 12)
   <body>

2. > "<quote>" (lines 30–34)
   <body>
```
- **Line refs** are computed by locating the *full* quote in `docHtml` markup
  (whole-quote match → HTML-entity-encoded fallback → cross-block first-line /
  last-line probe for quotes that span block tags). Unresolved → the ref is
  simply omitted for that item; the quote is still rendered.
- **Long quotes are condensed** for display (`condenseQuote`): a passage over
  ~200 chars becomes *first ~2 sentences* `(…)` *last ~2 sentences* (char-window
  fallback). The line ref is always computed from the **uncondensed** quote, so
  the quote — not the line number — is the source of truth if they ever disagree.
- **Line-number semantics differ by mode** (see §3.5 callers): the embedded
  canvas passes doc-content-relative markup (line 1 = first line of body
  content); the extension passes `documentElement.outerHTML` (file-absolute,
  tracks the opened file). Same function, different `docHtml` origin.
- A document-level note (`anchor === null`) renders as
  `N. (note on the whole document)` with no quote and no ref.

### 3.4 `runtime/highlight.js` (DOM-only → `NotebackRuntime.highlight`)

```js
function paintHighlights(root, state, opts) { ... }  // re-anchor each comment + wrap matched ranges
function clearHighlights(root) { ... }               // remove all Noteback highlight wrappers
function focusHighlight(root, commentId) { ... }     // scroll to / flash a comment's highlight
```
- Highlight wrapper element marker: `data-noteback-id="<commentId>"`,
  class `noteback-highlight`.

### 3.5 `runtime/overlay.js` (DOM-only → `NotebackRuntime.overlay`)
Mode-agnostic UI: floating "💬 Comment" button, comment popover, sidebar.

```js
/**
 * @param {Object} cfg
 * @param {Node} cfg.root                 Document root to annotate.
 * @param {StorageAdapter} cfg.adapter    Persistence (see §1).
 * @param {Object} cfg.exporter           Export hooks (see §3.6); may be partial in embedded mode.
 * @param {Object} [cfg.history]          Snapshot-history adapter (see §1, §8); null/absent → timeline hidden.
 * @param {string} [cfg.mode]             'extension' | 'embedded' — drives the info-dialog run-mode
 *                                        indicator. Defaults to 'embedded' (the canvas is the common case);
 *                                        the extension content script passes 'extension'.
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
function mountOverlay(cfg) { ... }
```

**Behavioral invariants** (easy to regress — keep them true):
- **Comment chip ("💬 Comment")** appears *debounced* (~340 ms, re-armed on each
  `selectionchange`, re-anchored on `mouseup`), not instantly. Its entrance is a
  **keyframe animation restarted via reflow** (`classList.remove` →
  `void el.offsetWidth` → `classList.add`), NOT a CSS `transition` — a transition
  out of `display:none` does not reliably fire. See the gotcha in `CLAUDE.md`.
- **The chip hugs the cursor**, not the centre of the passage: it's anchored to
  the selection's *focus point* (where the drag ended) and centred on that x —
  **below** the cursor for a forward drag, flipped **above** for a backward one
  (so it never covers the just-selected text), flipping again only when the
  viewport lacks room. The *composer*, by contrast, is still placed off the full
  selection box (see below). Covered by `test/e2e/comment-chip-position.e2e.test.js`.
- **Comment composer** is positioned to stay clear of the selection's vertical
  band when there's room (prefer below, flip above, else hug the nearer edge),
  is **draggable by its handle**, and is dismissed **only** by Cancel / Save /
  Escape — *not* by clicking outside it. Do not re-add outside-click-to-close
  for the composer.
- **Sidebar** *is* dismissed by clicking outside it (guarded: ignored while a
  composer is open, while a highlight `<mark>` is clicked, or while a non-collapsed
  selection exists). These two outside-click behaviors are intentionally opposite.
- Own UI is marked `data-noteback-ui`; outside-click detection uses
  `composedPath()` so clicks inside the shadow-DOM panel count as "inside".
- **Footer "Save…" menu** (a dropdown over the Save button) closes on item-click,
  outside-click (`composedPath()` excludes its wrapper), or Escape; the Save button
  `stopPropagation()`s its own toggle so the same click can't immediately re-close it.
  Closing the sidebar also closes the menu. Items map to the exporter hooks above.

### 3.6 `canvas/exporter.js` (pure-ish → `NotebackRuntime.exporter`)

```js
/**
 * Build the self-contained canvas HTML string (does NOT touch disk).
 * @param {Object} cfg
 * @param {string} cfg.docHtml            Original document <body> (or full) markup.
 * @param {State}  cfg.state              Current annotation state.
 * @param {string} cfg.templateHtml       canvas-template.html shell text.
 * @param {string} cfg.inlinedRuntime     Concatenated runtime source (incl. InFileStateAdapter + boot).
 * @returns {string} complete HTML document text.
 */
function buildCanvasHtml(cfg) { ... }

/** Trigger a browser download of `html` as `filename`. */
function downloadCanvas(html, filename) { ... }

/** Feature-detected in-place save via File System Access API; falls back to download. */
async function saveCanvasInPlace(html, suggestedName) { ... }
```

**Exporter hooks object** (the `cfg.exporter` passed to `mountOverlay`/`boot`). All
hooks are **optional** — the overlay feature-detects each and falls back when absent.
Each receives the current `State`.

```js
/**
 * @typedef {Object} ExporterHooks
 * @property {(state: State) => void|Promise<void>}   [onCopyMarkdown] Copy feedback as Markdown.
 * @property {(state: State, opts: {clean?: boolean}) => Promise<string>} [onCopyHtml] Build HTML for the clipboard — the clean document (clean:true) or the full feedback canvas (clean:false). Returns the string; the overlay/popup writes it to the clipboard.
 * @property {(state: State) => void|Promise<void>}   [onSaveCanvas]   Save HTML *with* comments (re-shareable canvas).
 * @property {(state: State) => void|Promise<void>}   [onSaveCanvasWithHistory] Save HTML with comments AND the embedded version history (a `#noteback-history` JSON block). Present only on the embedded canvas. The overlay shows the "with comments and history" item only when this hook exists AND `getHistory()` is non-empty.
 * @property {(state: State) => void|Promise<void>}   [onSaveClean]    Save HTML *without* Noteback (the original document).
 * @property {(html: string, name: string) => void|Promise<void>} [onSaveHtml] Save a PRE-BUILT HTML string to a file (the overlay builds it — e.g. a past version's canvas or clean snapshot — and this routes it through the same save-in-place/download primitives the live-doc saves use). Present only on the embedded canvas.
 * @property {(state: State) => void}                 [onSavePdf]      Produce a PDF. Omit to use the overlay's default (`window.print()`).
 */
```

Footer **Save…** menu → hooks: *HTML · with comments* → `onSaveCanvas`,
*HTML · with comments and history* → `onSaveCanvasWithHistory` (hidden unless there's
history), *HTML · clean copy* → `onSaveClean`, *PDF/Print* → `onSavePdf`
(default `window.print()`).

**Embedded history block.** `onSaveCanvasWithHistory` calls the adapter's
`exportHistory()` (a `{schemaVersion, entries}` map of `nb:doc:*`/`nb:ver:*` kv keys →
records, snapshots included) and writes it into a `<script id="noteback-history"
type="application/json">` block (escaping `</script>` to `<\/script>` so a comment body
can't close it). On reopen the embedded boot **synchronously** seeds `localStorage` from
that block — **only keys not already present** (never clobber newer local data) — before
the history adapter first resolves. The block is excluded from snapshots
(`captureCleanDoc`), clean copies (`rebuildCleanHtml`), plain "with comments" saves
(`rebuildHtml`), so it never nests/recurses.

Footer **Copy ▾** menu → `onCopyHtml`: *Copy html (with feedback)* →
`onCopyHtml(state, {clean:false})` (same bytes as `onSaveCanvas`), *Copy html
(clean)* → `onCopyHtml(state, {clean:true})` (same bytes as `onSaveClean`). The
main "Copy feedback" button still uses `onCopyMarkdown`. In extension mode the
with-feedback variant is assembled by the service worker (`NOTEBACK_BUILD_CANVAS`)
and returned as a string; the page writes it to the clipboard.

PDF cleanliness relies on the runtime's `@media print` rules (overlay `BUTTON_CSS`),
which hide every `[data-noteback-ui]` node and strip highlight styling — so a PDF is
the clean document without needing a hook. The embedded canvas supplies `onSaveCanvas`,
`onSaveClean`, and `onCopyHtml`; the save hooks serialize the live document (clean copy additionally removes the
state block, the inlined runtime `<script>`, the `#noteback-doc-root` wrapper, the
guiding comment, and the title suffix) and persist via `saveCanvasInPlace`/`downloadCanvas`
under the plain document filename.

### 3.7 `runtime/boot.js` (DOM-only → `NotebackRuntime.boot`)
Single entry point used by **both** modes.

```js
/**
 * Wire adapter + overlay + highlights for a document.
 * @param {Object} cfg
 * @param {Node} [cfg.root=document.body]
 * @param {StorageAdapter} cfg.adapter
 * @param {Object} [cfg.exporter]
 * @param {Object} [cfg.history]   Snapshot-history adapter (see §1, §8); forwarded to the overlay.
 * @returns {Promise<{ destroy: () => void }>}
 */
async function boot(cfg) { ... }
```

**Single-mount guard (per JS world).** `boot()` sets `window.__notebackBooted`
synchronously on first call (before any `await`) and stores its controller on
`window.__notebackController`; a second `boot()` **in the same world** returns that
controller instead of mounting again (a duplicate injection / re-boot).

**Cross-world stand-down (embedded canvas vs. extension).** When a page carries **both**
an embedded canvas runtime **and** the installed extension (opening a saved canvas with
the extension on), the two run in **separate JS worlds** — the canvas in the page's MAIN
world, the content script in an ISOLATED world — so neither sees the other's
`__notebackBooted` flag. The hand-off goes through the **shared DOM** instead: `boot()`
appends a synchronous `<div data-noteback-ui="mount">` marker (before its first `await`,
so it's present by the extension's `document_idle`; `destroy()` removes it). The content
script stands down when `originPolicy.overlayMounted(document)` finds any
`[data-noteback-ui]` node — the embedded canvas boots at `DOMContentLoaded` (before
`document_idle`), so it wins and the extension does **not** double-mount. Because the
marker only exists when `boot()` actually ran, a canvas whose runtime was blocked (e.g.
CSP) leaves no marker and the extension correctly takes over. Guarded by
`test/e2e/extension-standdown.e2e.test.js` (loads the real unpacked extension).

---

## 4. `NotebackRuntime` global namespace map

Pure-logic modules use the dual-export ("UMD-lite") boilerplate so the **same file**
works in the browser (attaches to `globalThis.NotebackRuntime.<name>`) and under Node
(`module.exports`). DOM modules attach to the global only.

```js
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.<moduleName> = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /* ... return api ... */
});
```

Node tests require the file directly:
`const anchor = require('../src/runtime/anchor.js');`

| File                                      | `NotebackRuntime.<key>` | Node `module.exports`? | Kind        |
|-------------------------------------------|-------------------------|------------------------|-------------|
| `src/runtime/anchor.js`                   | `anchor`                | yes                    | pure        |
| `src/runtime/state.js`                    | `state`                 | yes                    | pure        |
| `src/runtime/markdown.js`                 | `markdown`              | yes                    | pure        |
| `src/runtime/highlight.js`                | `highlight`             | no                     | DOM         |
| `src/runtime/overlay.js`                  | `overlay`               | no                     | DOM         |
| `src/runtime/draft-history-core.js`       | `draftHistory`          | yes                    | pure-ish    |
| `src/runtime/snapshot-capture.js`         | `snapshotCapture`       | yes                    | pure-ish    |
| `src/runtime/boot.js`                     | `boot`                  | no                     | DOM         |
| `src/adapters/chrome-storage-adapter.js`  | `chromeStorageAdapter`  | no                     | DOM (chrome)|
| `src/adapters/chrome-kv-store.js`         | `chromeKvStore`         | yes (tests)            | DOM (chrome)|
| `src/adapters/infile-state-adapter.js`    | `infileStateAdapter`    | no                     | DOM         |
| `src/adapters/history-state-adapter.js`   | `historyStateAdapter`   | yes (tests)            | mixed       |
| `src/canvas/exporter.js`                  | `exporter`              | yes (pure parts)       | mixed       |

**Runtime dependency order** — the order the service worker concatenates for
inlining and the order in `bin/noteback.js`'s `RUNTIME_FILES` (the `wrap` CLI) /
`examples/build-canvas.js`:

```
src/runtime/anchor.js
src/runtime/state.js
src/runtime/markdown.js
src/runtime/highlight.js
src/runtime/overlay.js
src/runtime/draft-history-core.js
src/runtime/snapshot-capture.js
src/adapters/infile-state-adapter.js
src/adapters/history-state-adapter.js
src/canvas/exporter.js
src/runtime/boot.js
```

The **canvas inline** runtime (above) uses `InFileStateAdapter` as the inner adapter
and a **localStorage-backed** kv store built inline in the embedded boot (§8); it does
NOT inline `chrome-kv-store.js`, `chrome-storage-adapter.js`, or `content-script.js`.

The **extension** loads the full snapshot-history engine: `manifest.json`
`content_scripts[0].js` lists the same shared runtime **plus** `chrome-kv-store.js`
(extension kv backend), `chrome-storage-adapter.js` (the comments-only fallback),
`origin-policy.js`, and `content-script.js` (extension boot). The extension content
script gates the history adapter behind `historyAllowed` (§1.3); otherwise it falls
back to the comments-only `ChromeStorageAdapter`. The `content_scripts[0].js` order is
the single source of truth for click-to-activate injection (§1.4) and is also
mirrored in `web_accessible_resources` (so the modules can be `fetch`ed for inlining).

---

## 5. Canvas state-block format

The machine-readable annotation state lives in the saved canvas as a single script
element. Its `id` and `type` are part of the contract — `InFileStateAdapter` and the
exporter both depend on them.

```html
<script type="application/json" id="noteback-state">
{ ...State JSON per §2... }
</script>
```

- `type="application/json"` so the browser does NOT execute it.
- `id="noteback-state"` is the lookup key for `InFileStateAdapter`.
- Content is `JSON.stringify(state)` (whitespace-insensitive; parsers must tolerate
  both pretty and minified JSON).
- There is **exactly one** such element per canvas.

**Baked doc-id.** The canvas body wraps the document in
`<div id="noteback-doc-root" data-noteback-doc-id="…">` (`canvas-template.html`,
filled by the exporter's `{{DOC_ID}}` token). That attribute is the stable identity
the snapshot-history engine (§8) keys on — it persists across re-exports, so a
re-shared/re-wrapped canvas keeps the same version history. `wrap`
(`bin/noteback.js`) mints one when absent and preserves it on re-export
(`mintDocId` / `readBakedDocId`); see §8 for the precedence.

---

## 6. Guiding HTML comment string

A one-line HTML comment placed at the **top of the canvas `<body>`** (immediately
before the original document markup) so any AI handed the file knows what it is. This
exact string is the contract (the exporter writes it; tests may assert it):

```html
<!-- Noteback feedback canvas: each item is a quoted passage + a note. Please revise the document accordingly. -->
```

---

## 7. Canvas assembly summary (who builds what)

1. Service worker (extension) reads page HTML + current State.
2. It fetches each runtime file's text (dependency order, §4) via
   `fetch(chrome.runtime.getURL(path))` and concatenates them into one runtime blob.
3. `exporter.buildCanvasHtml({ docHtml, state, templateHtml, inlinedRuntime })` fills
   `src/canvas/canvas-template.html` with:
   - the guiding HTML comment (§6),
   - the original document markup,
   - the original document's `<head>` styling (`{{DOC_STYLE}}`): its inline
     `<style>` blocks + `<link rel="stylesheet">` refs, **excluding** Noteback's own
     `data-noteback-ui` styles — so a styled source keeps its look in the canvas
     instead of rendering as raw HTML. Extracted by `exporter.extractHeadStyles`
     and substituted **last** so the carried CSS is never re-scanned for `{{…}}` tokens.
   - the state block (§5),
   - one inline `<script>` containing the concatenated runtime + a boot call that uses
     `InFileStateAdapter`.
4. The result is downloaded (baseline) or saved in place via File System Access
   (enhancement, secure contexts) — see spec §8.3.

The produced file must, with **no extension installed**, render the doc, paint the
highlights, show the sidebar, and allow add/edit/delete + re-serialize.

---

## 8. Snapshot history

**One** storage-agnostic history engine runs identically in both modes (embedded
canvas over `localStorage`, extension over `chrome.storage.local`). It keeps a
per-document timeline of **versions** and snapshots the **whole clean document once**,
at a version's first comment, so the user can peek/open/copy-feedback on a past draft.

### 8.1 Identity — the doc-id

Identity is an **explicit doc-id**, not derived at runtime:

- **Canvas:** baked into `#noteback-doc-root[data-noteback-doc-id]` (§5).
- **`wrap` CLI** (`bin/noteback.js`): precedence is explicit `--id <id>` → the id
  already baked in the `-o` target → the id baked in the input HTML
  (`#noteback-doc-root` attr OR a source `<!-- noteback-doc-id: … -->` marker) →
  otherwise **mint** a fresh one. Helpers: `mintDocId`, `readBakedDocId`,
  `readMarkerDocId`. Re-export preserves the existing id, so a re-wrapped canvas keeps
  its history. **`--bake-id`** (with a separate `-o` target) stamps the resolved id
  into the SOURCE as that comment marker (`bakeDocIdIntoSource`, idempotent, after the
  doctype) so history survives even if the generated canvas is deleted; the marker is
  stripped from the canvas content (`stripDocIdMarker`) so it never double-anchors.
- **Extension on a page it didn't author** (no baked id): a per-URL minted id stored
  under `nb:url:<normalizedHref>` (fragment stripped) in `chrome.storage.local`. A
  baked id always wins. This is distinct from the comments-only `docId`
  (`location.href`) that still keys `ChromeStorageAdapter` / the export identity.

### 8.2 The engine — `draft-history-core.js`

`createDraftHistory({store, now, codec, limits})` → `{resolve, persist, history,
version, clearCurrent}`. It is **pure** — no DOM, no `localStorage`, no `chrome.*` —
talking only to an injected **async kv store** (`get/set/remove/keys`) and a `codec`
(`compress`/`decompress`, gzip with an identity fallback). Per doc-id it owns an
ordered list of versions; each version is keyed by a **content hash** over the
normalized visible text (`cyrb53`-based), or **`'h0:' + docId`** when the text is too
short to hash (`< MIN_HASH_CHARS`, 32). `resolve` initialises/looks up the current
version and returns `{degraded, docId, versionKey, contentHash, comments, hasSnapshot}`;
`persist` writes the comments and captures the snapshot **once** (only if none stored
yet); `history` returns past versions (newest-first, non-empty only); `version`
decompresses one version's snapshot; `clearCurrent` wipes a version's comments +
snapshot. Retention runs on every `resolve`/`persist`: a snapshot window (~5), a
metadata window (~15), a 90-day TTL, and a coarse ~3 MB global byte cap (internal
`prune` / `enforceByteCap`; the doc's newest version and the active version are always
protected).

### 8.3 kv namespaces / record shapes

- `nb:doc:<docId>` → `{ schemaVersion:1, docId, docTitle, versions:[versionKey,…] }`
  (oldest→newest).
- `nb:ver:<versionKey>` → `{ schemaVersion:1, versionKey, docId, contentHash,
  comments:[], snapshotHtml:<gzip str|''>, createdAt, lastEditedAt, docTitle }`.
  `versionKey = contentHash || ('h0:' + docId)`.
- `nb:url:<normalizedHref>` → minted per-URL doc-id (**extension only**, §8.1).

This is a **clean break** from the old key namespaces — old data is simply ignored.
The embedded canvas still loads its *current* comments from the in-file `#noteback-state`
block (§5); history is the extra layer on top.

### 8.4 Two kv backends, one engine

- **Extension:** `src/adapters/chrome-kv-store.js` — `createChromeKvStore(chromeApi?)`
  → async `{get,set,remove,keys}` over `chrome.storage.local` (supports both the
  callback and promise MV3 forms). It **throws eagerly** if `chrome.storage.local` is
  unavailable, so callers wrap construction in `try/catch` and degrade.
- **Embedded canvas:** an equivalent `localStorage`-backed kv store built **inline** in
  the exporter's `EMBEDDED_BOOT` (`lsStore`). Its `try/catch` is load-bearing —
  `window.localStorage` can *throw* on `file://`; on failure `lsStore` is `null` and
  the adapter degrades to the in-file `InFileStateAdapter`.

### 8.5 The adapter — `history-state-adapter.js`

`createHistoryStateAdapter({doc, store, inner, docId, contentText, captureSnapshot, …})`
is the **mode-agnostic** StorageAdapter (it replaced the old localStorage adapter).
It wraps an **inner** adapter (embedded: `InFileStateAdapter`; extension: `null`) + the
kv `store` + the core. `load`/`save` flow comments through both `inner` and the core;
on the **first** comment it captures the snapshot via `captureSnapshot()` and stores it
gzipped. It also exposes `getHistory`/`getVersion`/`clearCurrent` (§1) and `makeCodec`
(gzip via `CompressionStream`/`Response`, identity fallback). `hasSnapshot` is seeded
from the version's **real stored snapshot state**, never the comment count. If the store
or core is unusable (or doc-id is empty) it **degrades**: comments still flow through
`inner`; the history methods return `[]`/`null`/no-op.

### 8.6 Snapshot capture — `snapshot-capture.js`

`captureCleanDoc(doc)` clones `documentElement`, removes `[data-noteback-ui]`, **unwraps**
every `<mark class="noteback-highlight">`, removes `#noteback-state` and the inline
runtime `<script>`, and returns the clean full-document HTML. Because marks are
stripped, the snapshot is **paint-independent** — it does not matter whether highlights
are painted when `save` runs. `stripNotebackFromHtml(html)` is the string-only Node-test
equivalent (no DOM); `identityCodec` is the no-op gzip fallback.

### 8.7 Overlay — version timeline + inline view

The overlay renders a **version timeline** (`renderVersions`) instead of the old
history popup. It docks at the **bottom** of the sidebar — `.nb-versions-dock`, a
bounded (`max-height:34vh`), self-scrolling band between the scrolling comment list
(`.nb-list`, `flex:1`) and the action footer (`.nb-foot`), collapsing via `:empty` when
there are no earlier versions — so the current draft's notes keep the available space.
Collapse rule: **0** earlier versions → hidden; **1** → inline; **2+** → newest inline +
a "+N older versions" disclosure. Each row's chevron menu has **copy feedback**, **save
HTML with comments**, and **save clean HTML** actions, and the row body is click-to-view:

- **Inline view** (`openVersionInline`) parses the stored snapshot and re-renders it by
  running the **live** highlight painter (`highlightApi.paintHighlights`) over the parsed
  doc — no cross-node re-highlighter — then **re-injects the shared `HIGHLIGHT_CSS`**
  (plus `PEEK_POP_CSS` for the in-iframe comment popover) into the snapshot `<head>` so
  the marks match the live document. It renders inside an `<iframe srcdoc>` that
  **fills the panel** as a column-flex child (`flex:1;min-height:0`), in a side panel
  (`.nb-hist-view`) that sits **beside the sidebar** (not a centered modal — the sidebar
  stays visible on the right with the live timeline). An in-tab `viewingKey` marks the
  viewed version the active `nb-ver-viewing` row (active dot + highlight, no text label);
  a "Back to current" bar (`renderBackToCurrentBar` → `closeVersionInline`) returns to the
  live draft. Pruned snapshots (`html === ''`) toast and leave the view closed. The
  `</script>` escape applies to `buildPeekPopoverScript`, which serializes comment data
  into the iframe's inline script.

- **Save actions** (chevron menu): **Save HTML with comments** rebuilds a re-openable
  canvas of the version with `buildVersionCanvasHtml` (clone the live shell, swap in the
  snapshot content, re-seed `#noteback-state` with the version's comments, escaping
  `</script>`); **Save clean HTML** saves the raw `v.html` snapshot. Both call
  `exporter.onSaveHtml(html, name)` (download), are disabled when the snapshot is pruned,
  and never `window.open` — so a re-opened saved file is a fresh `file://` canvas with its
  own storage, avoiding the opaque-origin `localStorage` bug that retired `openVersionTab`.

### 8.8 Per-site opt-in

The extension content script gates the engine on `historyAllowed(info, settings)`
(§1.3): default-on for `file`/`localhost`/`127.0.0.1`, opt-in via `historySites` for
other origins. When not allowed it keeps the comments-only `ChromeStorageAdapter`. The
embedded canvas has no settings and always runs history (subject to `lsStore`
availability, §8.4).
