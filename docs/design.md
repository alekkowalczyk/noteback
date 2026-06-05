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
