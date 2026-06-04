# Noteback — Annotate AI Docs & Copy/Share Feedback for Claude, ChatGPT & co.

**Noteback** is a zero-backend Chrome extension (Manifest V3) for **reviewing
local AI-generated HTML documents** — specs, plans, design docs. Highlight a
passage, attach a comment anchored to that exact quote, then either **copy your
feedback as Markdown** to paste back to an AI or a teammate, or **save a
self-contained "feedback canvas"** — a single HTML file with your highlights and
comments baked in that anyone can open, read, comment on, and re-share **without
installing anything**.

> note it → send it back.

It runs **entirely locally**: no server, no account, no telemetry, no network
calls.

**Keywords:** annotate AI docs · feedback for AI · review LLM specs · copy
feedback to Claude / ChatGPT · code review · HTML annotation · text-quote
highlighting · Chrome extension · Manifest V3.

---

## Why Noteback

The workflow it serves:

> An AI generates an HTML doc → you open it locally → you annotate it → you send
> the feedback back to the AI (next prompt) **or** to the human who shared it
> (who will likely paste it into *their* AI).

Generic web annotators are saturated (Web Highlights, Glasp, Hypothesis, …).
Noteback wins the **local-AI-doc** niche with two co-equal pillars:

- **Frictionless browser overlay** — select text, type a note, done. Zero setup
  beyond installing the extension.
- **Best-in-class feedback export** — output that is excellent for **both** a
  human reviewer **and** an AI model.

## What it does (v1 / MVP)

- Injects on `file://`, `localhost`, and `127.0.0.1` documents.
- Select text → floating **💬 Comment** button → popover → save.
- Robust **text-quote anchoring** (W3C / Hypothesis style): `quote` + `prefix` /
  `suffix` context + `occurrence` index, so highlights survive minor
  DOM/whitespace changes. Lost quotes become **"unanchored"** comments rather
  than disappearing.
- Toggleable **sidebar** listing every comment; edit / delete.
- **Copy feedback as markdown** — clean, neutral, human- and AI-readable, with
  line references back into the HTML file.
- **Save as HTML with comments** — one self-contained, fully interactive file.
- **Onboarding** for enabling "Allow access to file URLs."

See [`docs/superpowers/specs/2026-06-03-noteback-design.md`](docs/superpowers/specs/2026-06-03-noteback-design.md)
for the full design and [`CONTRACTS.md`](CONTRACTS.md) for the integration
contracts (StorageAdapter, State schema, runtime namespace, canvas format).

## Architecture — one portable runtime, two modes

The annotation engine (selection → popover → highlight painting → comment list →
serialization) is built **once** and runs in two modes via an injected
`StorageAdapter`:

| Mode | Host | State store |
|------|------|-------------|
| **Extension mode** | Content script on local pages | `chrome.storage.local` |
| **Embedded mode** | Inlined into a saved canvas file | In-file `<script id="noteback-state">` JSON block |

The "anyone can collaborate on the canvas without installing anything" capability
falls out of the **same codebase** that powers the extension.

- **No build step.** Vanilla JavaScript, no TypeScript, no npm dependencies, no
  bundler — load the folder unpacked exactly as written.

## Use as an agent skill — born-annotatable docs

Noteback also ships a tiny CLI and an **agent skill** so an AI coding agent (Claude
Code, etc.) can hand you documents that are *already* annotatable — no extension
needed at all. When the agent writes a plan/spec/report as HTML, it wraps it:

```sh
npx noteback wrap plan.html            # rewrite in place → plan.html IS the canvas
npx noteback wrap plan.html -o out.html  # keep the original, write a separate canvas
```

You open the file, comment, click **Copy feedback as markdown**, and paste it back to
the agent to iterate. The wrapper reuses the same tested canvas builder as the
extension, and re-wrapping an existing canvas is idempotent (the old runtime + comment
state are stripped before a fresh empty one is embedded).

The skill itself lives in [`skills/noteback-canvas/SKILL.md`](skills/noteback-canvas/SKILL.md):
it tells the agent to prefer HTML for reviewable docs, wrap them, and treat your pasted
Markdown as change requests. This is a third on-ramp to the **same embedded mode** the
"Save as HTML with comments" button produces.

## Install (unpacked, for development)

1. Clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the repo root (the folder with
   `manifest.json`).
5. To annotate `file://` docs, open the extension's **Details** page and enable
   **"Allow access to file URLs."** (`localhost` / `127.0.0.1` need no toggle.)

## Permissions (minimal by design)

`storage` (persist comments), `activeTab` + `scripting` (act on the current tab
on demand), `downloads` (export the canvas), and host access limited to
`file:///*`, `http://localhost/*`, `http://127.0.0.1/*`. No remote code, which
also eases Web Store review.

## Privacy

100% local. State lives only in `chrome.storage.local` and inside files you
explicitly save. No analytics, no accounts, no network calls.

## Development

```sh
# Run the runtime unit tests (Node built-in runner; no framework, no deps):
npm test            # -> node --test "test/**/*.test.js"
# or, equivalently:
node --test         # auto-discovers test/
```

The pure-logic runtime modules (`anchor`, `state`, `markdown`) are written to run
**both** in the browser and under Node so they can be unit-tested directly.

## License

[MIT](LICENSE).
