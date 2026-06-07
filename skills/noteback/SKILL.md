---
name: noteback
description: Use when you write an HTML document, plan, spec, design, report, or similar deliverable for the user to READ AND GIVE FEEDBACK ON. Wraps the HTML as a self-contained Noteback feedback canvas so the user can highlight text, leave comments (including whole-document notes) in their browser with NO extension, and copy the feedback back as Markdown to iterate. Do not use for HTML that is a build artifact (a website page, an email template, a UI component) rather than something the user reviews.
---

# Noteback feedback canvas

When you hand the user an HTML deliverable to review, give it to them **already
annotatable**. Instead of plain HTML, emit a Noteback *feedback canvas*: the same
document with a tiny runtime baked in, so the user can highlight any passage,
attach a note (or add a note about the whole document), and click **Copy feedback**
to paste the Markdown back to you. No browser extension, no server, no install —
they just open the file.

## When this applies

Use it for HTML you produce **for the user to read and respond to**: specs, plans,
design docs, proposals, research write-ups, reports, status summaries.

Do **not** use it for HTML that is a product/build artifact — a page of a website
you're building, an email template, a rendered component, a test fixture. Those are
not "documents the user reviews," they're deliverables in their own right.

If unsure, ask: *"Want this as a Noteback canvas so you can comment on it inline?"*

## Prefer HTML for documents the user will review

When you're about to produce a plan, spec, design, or report **for the user to read
and give feedback on**, default to authoring it as an **HTML document** rather than a
Markdown (`.md`) file, then wrap it as a canvas. HTML renders cleanly in the browser
and — once wrapped — is directly annotatable, which is exactly what a review document
is for. A `.md` file the user opens in a viewer gives them nowhere to leave anchored
comments.

This is about the **delivery format, not the writing**: compose the same well-structured
content (headings, lists, tables, code blocks) as HTML. You can write Markdown-style
content and convert it, or emit HTML directly — either way the user gets a richer,
commentable artifact.

Keep using Markdown when it's genuinely the better fit:
- files that live in the repo and should be diffed/committed (READMEs, `docs/` specs,
  ADRs, changelogs),
- content destined for a system that expects Markdown (a PR body, an issue, a wiki),
- when the user asks for Markdown, or for short inline answers in chat.

Rule of thumb: **a document the user will review and comment on → HTML canvas; a file
that lives in version control or another tool → Markdown.**

## Make it look designed, not like rendered Markdown

You're handing the user a *document*, so treat it like one — give it real visual
design, not a bare wall of `<h1>`/`<p>`/`<ul>` that reads like a Markdown preview.
A generic stylesheet (centered column, system font, default headings) signals "auto-
generated" and makes the content feel cheaper than it is. Invest in:

- **Distinctive typography** — a characterful display face for headings paired with a
  clean body face and a mono for code; avoid the generic defaults (Arial, system-ui,
  Inter/Roboto everywhere). Establish a real type scale and hierarchy.
- **A cohesive visual identity** — a deliberate palette with a dominant tone and a
  sharp accent (CSS variables), not black-on-white with blue links. Match the theme to
  the document's purpose (an editorial memo, a spec sheet, a report).
- **Structure that aids reading** — styled section markers, callout/aside boxes for
  decisions vs. risks vs. notes, proper tables, framed figures/diagrams, and generous
  spacing. One tasteful staggered page-load reveal beats scattered micro-animations.

Keep these hard constraints:
- **Put your CSS in a `<style>` *inside `<body>`*, not in `<head>`.** This is the one
  that bites hardest: `wrap` keeps only the body's inner markup and **discards `<head>`
  entirely**, so a stylesheet in `<head>` (or a `<link rel="stylesheet">`) is silently
  dropped and the canvas renders as raw, unstyled HTML. Inline the full stylesheet as a
  `<style>` block at the top of `<body>`. (A `<title>` can stay in `<head>` — `wrap` reads
  it for the doc title — but styling must live in the body.) Remote `@import` web fonts
  need network when the file is opened, so always give solid local fallbacks.
- **Real, selectable text in normal flow.** Don't put body content in `::before/::after`,
  background images, or `<canvas>` — Noteback anchors comments to selectable text, so
  decorative-only elements should be exactly that (decorative).
- **Leave the bottom-right corner free** (Noteback's launcher) and don't globally style
  the `<mark>` element — the runtime paints highlights as `mark.noteback-highlight`. Use
  your own class for any highlighter-style effect.

If you want a bolder, art-directed result, the `frontend-design` skill (when available)
is a good companion for choosing the aesthetic direction before you write the HTML.

## How to wrap

After writing the HTML file (e.g. `plan.html`), wrap it in place:

```
npx noteback wrap plan.html
```

`plan.html` is now the canvas — opening it boots the annotation UI. To keep the
plain original too, write the canvas to a separate file instead:

```
npx noteback wrap plan.html -o plan.canvas.html
```

**If you wrap to a separate `-o` file and intend to iterate, add `--bake-id`:**

```
npx noteback wrap plan.html -o plan.canvas.html --bake-id
```

Noteback keys each document's comments and **version history** to a stable
*doc-id*. Wrapping **in place** (`wrap plan.html`) bakes that id into the file, so
re-wrapping always keeps the same history. But with a separate `-o` output the id
lives **only inside the generated canvas** — if that canvas is later deleted,
moved, or regenerated from scratch, the next wrap mints a *new* id and the
document's history (stored in the browser, keyed by the old id) is **orphaned**:
the comments/timeline silently vanish. `--bake-id` stamps the id back into the
**source** (`plan.html`, as an HTML comment marker), so every re-wrap resolves the
same id and history follows the document across edits. Use it whenever the canvas
is a regenerated build artifact rather than the file you keep — i.e. any time your
loop is *edit `plan.html` → re-wrap → hand back*. (It's a no-op for in-place wraps,
which already carry the id.)

The wrapper reuses Noteback's tested canvas builder, so the embedded runtime is
escaped correctly — **never assemble the canvas by hand** (the `</script>` / `<!--`
escaping inside an inline `<script>` is exactly what breaks if you splice strings).

Re-wrapping a file that is already a canvas is safe and idempotent: the builder
strips the old runtime and the previous comment state before embedding a fresh,
empty one. So on each iteration you can rewrite the document normally and wrap
again.

> Setup note: `npx noteback wrap` requires the `noteback` CLI to be resolvable
> (published to npm, `npm link`-ed, or run from a checkout). From a local checkout
> of the repo the equivalent is `node /path/to/noteback/bin/noteback.js wrap <file>`.

## Tell the user (after wrapping)

Show a short, consistent message so the workflow is obvious:

> 📝 I wrote this as a **Noteback canvas** — open **`plan.html`** in your browser.
> Highlight any text to comment on it, or use the **🗨 Noteback** button (bottom-right)
> to add a note about the whole document. When you're done, click **Copy feedback**
> and paste it back here and I'll revise.

Adjust the filename, but keep the three beats: *open it · comment · copy the markdown
back to me*.

**Offer to open it — don't make them hunt for the file.** After wrapping, ask
whether you should open it in their browser right now rather than assuming they'll
locate and open it, e.g. *"Want me to open it in your browser now?"* If they say
yes, open it with the platform opener (`open <file>` on macOS, `xdg-open <file>` on
Linux, `start "" <file>` on Windows). And in a line, remind them the loop is
paste-based: they can click **Copy feedback** and paste it **straight back into
this chat** — no need to save or send a file.

## Closing the loop

When the user pastes the Markdown feedback back, treat each item as a change request
against the document: the quoted passage tells you *where*, the note tells you *what*.
Each quoted item also carries a `(line N)` / `(lines A–B)` reference into the document
markup to help you jump to the passage — but the quote is the source of truth; if a
line ref and the quote ever disagree, trust the quote. A long passage is shown
condensed as `first sentence(s) (…) last sentence(s)`, with the line range covering the
*whole* selection. Whole-document notes (`(note on the whole document)`) apply to the
doc as a whole. Revise the HTML, then wrap again and hand it back for another pass.

The user does **not** need to save the HTML or send you a file for this loop — the
Markdown they copy carries everything you need. (Saving the HTML is only for when
they want to keep or re-share an annotated copy.)
