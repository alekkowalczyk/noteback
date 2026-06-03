# Noteback — Integration Contracts

This document is the **single source of truth** for the cross-module interfaces in
Noteback v1. Every implementation phase MUST honor these signatures exactly so the
portable runtime works identically in **extension mode** (content script +
`chrome.storage.local`) and **embedded mode** (inlined in a saved canvas +
in-file JSON state block).

Read this together with the design spec:
`docs/superpowers/specs/2026-06-03-noteback-design.md`.

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

Implementations (both satisfy the contract; see §12 adapter tests):

| Implementation        | File                                      | Backing store |
|-----------------------|-------------------------------------------|---------------|
| `ChromeStorageAdapter`| `src/adapters/chrome-storage-adapter.js`  | `chrome.storage.local`, keyed by `docId` |
| `InFileStateAdapter`  | `src/adapters/infile-state-adapter.js`    | the in-file `<script id="noteback-state">` JSON block |

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
  its comments.
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
 * @param {{date?: string}} [opts]  date defaults to today (YYYY-MM-DD).
 * @returns {string}
 */
function toMarkdown(state, opts) { ... }
```
Output shape (spec §8.1):
```
# Feedback on <docTitle>
<N> comments — <YYYY-MM-DD>

1. > "<quote>"
   <body>

2. > "<quote>"
   <body>
```

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
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
function mountOverlay(cfg) { ... }
```

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

### 3.7 `runtime/boot.js` (DOM-only → `NotebackRuntime.boot`)
Single entry point used by **both** modes.

```js
/**
 * Wire adapter + overlay + highlights for a document.
 * @param {Object} cfg
 * @param {Node} [cfg.root=document.body]
 * @param {StorageAdapter} cfg.adapter
 * @param {Object} [cfg.exporter]
 * @returns {Promise<{ destroy: () => void }>}
 */
async function boot(cfg) { ... }
```

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
| `src/runtime/boot.js`                     | `boot`                  | no                     | DOM         |
| `src/adapters/chrome-storage-adapter.js`  | `chromeStorageAdapter`  | no                     | DOM (chrome)|
| `src/adapters/infile-state-adapter.js`    | `infileStateAdapter`    | no                     | DOM         |
| `src/canvas/exporter.js`                  | `exporter`              | yes (pure parts)       | mixed       |

**Runtime dependency order** (the order in `content_scripts[].js`, the order the
service worker concatenates for inlining, and the order in `web_accessible_resources`):

```
src/runtime/anchor.js
src/runtime/state.js
src/runtime/markdown.js
src/runtime/highlight.js
src/runtime/overlay.js
src/adapters/infile-state-adapter.js
src/canvas/exporter.js
src/runtime/boot.js
```

(`chrome-storage-adapter.js` and `content-script.js` are loaded **only** in extension
mode, appended after the shared runtime; they are NOT inlined into the canvas, which
uses `InFileStateAdapter` instead.)

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
   - the state block (§5),
   - one inline `<script>` containing the concatenated runtime + a boot call that uses
     `InFileStateAdapter`.
4. The result is downloaded (baseline) or saved in place via File System Access
   (enhancement, secure contexts) — see spec §8.3.

The produced file must, with **no extension installed**, render the doc, paint the
highlights, show the sidebar, and allow add/edit/delete + re-serialize.
