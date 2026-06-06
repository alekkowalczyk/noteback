# CLAUDE.md — Noteback engineering notes

Project-local guidance for working in this repo. Read alongside `README.md`
(what/why), `CONTRACTS.md` (the runtime module API + behavioral invariants), and
`docs/design.md` (the original design).
This file records the **non-obvious gotchas** — things you can't infer by reading
the code, that have already bitten us once.

## Hard constraints (do not break)

- **Zero RUNTIME dependencies, no build step, no TypeScript.** The shipped code
  (`bin`, `src`, `skills`) loads unpacked exactly as written — never add a bundler,
  a framework, or a `dependencies` entry, and never `require` a package from
  `src/`. Tests run on the **Node built-in runner** (`npm test` → `node --test`).
  The **one** allowed exception is `devDependencies`: Playwright backs the browser
  e2e (`test/e2e/`, `npm run test:e2e`) that covers overlay DOM behaviour the Node
  suite can't. It is test-only and never reaches users (`files` ships `bin`/`src`/
  `skills` only). Needs the browser binary once: `npx playwright install chromium`.
- **One runtime, two modes.** The annotation engine in `src/runtime/` runs both
  as the extension content script (`ChromeStorageAdapter`) and inlined into a
  saved canvas file (`InFileStateAdapter`). Anything in `src/runtime/` must work
  in **both** — no `chrome.*` access, no extension-only globals. Mode-specific
  code lives in `src/content/`, `src/adapters/`, `src/canvas/`.
- **Pure-logic modules** (`anchor`, `state`, `markdown`) must run under Node *and*
  the browser (UMD-lite dual export) so they stay unit-testable. Keep them
  DOM-free.

## Gotchas that already bit us

- **CSS transition out of `display:none` does not reliably fire.** The comment
  chip's entrance is a **keyframe animation restarted by a forced reflow**:
  `el.classList.remove('nb-in'); void el.offsetWidth; el.classList.add('nb-in')`.
  Don't "simplify" it back to a `transition` — it'll snap in with no animation.
- **The comment chip is debounced (~340 ms).** A `setTimeout` is re-armed on each
  `selectionchange` and the anchor is re-resolved on `mouseup`. Two consequences:
  (1) live/Playwright tests must wait ~380 ms after selecting before the chip is
  clickable; (2) `commitPopover` is **async** (`await persist`) — a test that
  creates two comments synchronously will have the second reuse the first
  anchor (because `onSelectionChange` early-returns while a popover is open).
  Await the first commit.
- **Composer vs. sidebar outside-click are opposite on purpose.** The composer
  closes **only** via Cancel / Save / Escape (never outside-click); the sidebar
  **does** close on outside-click (guarded). See `CONTRACTS.md` §3.5. Don't
  "unify" them.
- **Markdown line refs are computed from the document markup**, not the DOM. The
  full (uncondensed) quote is located in `docHtml`; long quotes are condensed for
  *display* only. If a line ref and the quote ever disagree, **the quote wins** —
  it's the anchor; the line number is a convenience.
- **Line-number semantics differ by mode.** Embedded canvas → doc-content-relative
  (`#noteback-doc-root` innerHTML, line 1 = first body line). Extension →
  `documentElement.outerHTML` (file-absolute, tracks the opened file). Same
  `toMarkdown`, different `docHtml` origin. This is a deliberate, documented
  tradeoff — don't try to "fix" one to match the other.
- **Draft identity is hashed from the CLEAN, pre-paint content root.** The
  localStorage adapter resolves the content hash from `#noteback-doc-root`
  `textContent` at construction, before highlights are painted — never recompute it
  from the live DOM after `<mark>` wrappers are added, or the hash shifts.
- **`window.localStorage` access can THROW (not just be absent) on `file://`** or
  when storage is blocked — and `file://` is the primary canvas use case. The
  `EMBEDDED_BOOT` adapter composition captures it inside a `try/catch`
  (`nbLocalStorage`) and falls back to the in-file adapter; never reference
  `window.localStorage` raw in the boot guard, or a blocked store crashes the whole
  canvas mount (it did once — the overlay never appeared). Live-verified in Task 9.
- **`file://` localStorage is one shared bucket** across all local canvases (Chrome).
  Keys are content-hashed and namespaced (`nb:gen:`/`nb:lin:`/`nb:attach`) precisely
  so distinct documents don't collide in that shared bucket.
- **History snapshots render in an `<iframe srcdoc>`** with the draft's inline
  `<style>` only; external stylesheets/remote images won't load there. That's
  expected — the popup shows structure + text + the highlight, not a pixel-perfect
  reproduction. The highlighted quote is interpolated into an injected `<script>`,
  so it is escaped with `.replace(/<\//g, '<\\/')` to prevent a `</script>` in the
  quote from breaking out (a real quote from an HTML/security doc can contain it).
  The popup re-highlights the quote with a CROSS-NODE matcher (`overlay.nbHistHighlight`,
  serialized via `toString()`): a multi-block selection's quote spans several text
  nodes, so a single-text-node `indexOf` can't find it. It also matches whitespace
  loosely (`\s*`, not `\s+`) because the snapshot drops the inter-block whitespace
  the live selection swept up (those bare whitespace `<mark>`s are stripped in
  `snapshot.assembleHtml`), so the quote's whitespace may have no counterpart.
- **A selection paints one `<mark>` per text slice (same id), so a comment can span
  many blocks/sections.** `snapshot.extractSections` therefore unions every section
  the selection touches (via `querySelectorAll`, not `querySelector` — using only the
  first mark captured just the start, a bug we shipped once). See its block-collection
  loop and the per-section dedupe.
- **The history peek pads the captured union with ~`CONTEXT_PAD_BLOCKS` (3) context
  blocks above the first touched section and below the last** (`snapshot.padContext`),
  so the popup shows what surrounds the selection — the capture otherwise consumes
  whole sections and leaves no in-section context. The padding crosses section
  boundaries (it pulls in the neighbouring heading + a paragraph or two) and skips the
  inter-block whitespace `<mark>`s a cross-block selection leaves behind. Under the
  char cap, `trimToCap` protects the **touched blocks** (`blocks[0]..blocks[last]`, the
  actual selection) and grows outward — section remainder, then padding — so context is
  sacrificed before the selection. Do **not** reinstate `trimToCap`'s old
  "prepend `nodes[0]` if it's a heading" shortcut: with padding `nodes[0]` is a context
  block, not the section heading, so it would wrongly re-add dropped padding. The
  section heading rides along inside the protected/grown window instead. `contextPad: 0`
  in the cfg disables padding (used by the union unit test to isolate that logic).
- **History snapshots are read from the PAINTED highlights — paint before persist.**
  `snapshot.extractSections` locates a comment's section by querying
  `mark.noteback-highlight[data-noteback-id="<id>"]` in the live doc. So
  `overlay.commitPopover` must paint the committed highlights (drop the compose
  preview, then `repaintHighlights()`) **before** `await persist(s)` runs the
  snapshot. If persist runs first, a brand-new comment's `<mark>` isn't in the DOM
  yet, the snapshot is captured empty (`sections:[]`, no `sectionByCommentId`), and
  the comment's later "Earlier feedback" entry is silently un-clickable
  (`hasSnapshot:false`, `sectionId:null` → the overlay `disable`s the button: no
  pointer cursor, clicks ignored). This shipped once and was found only in the live
  canvas — the Node suite can't catch it (the bug lives in the overlay's DOM
  paint/persist ordering, which has no Node-side DOM). It is now guarded by the
  browser e2e `test/e2e/history-popup.e2e.test.js` (real drag-select → reload as a
  new draft → click the entry → assert the popup opens); that test fails on the
  pre-fix ordering. The Node tests cover the seams around it (`extractSections`
  with/without a painted mark; `history()` reporting `hasSnapshot`/`sectionId`).
- **The click-to-activate injection list is sourced from the manifest, never
  copied.** `popup.js` activates unsupported-origin pages by reading
  `chrome.runtime.getManifest().content_scripts[0].js` and `executeScript`-ing
  that exact list. Don't hard-code the file list in the popup — it would silently
  drift the next time a runtime file is added to the manifest, and the injected
  page would boot an incomplete runtime.

## Live verification (Playwright)

- Serve over **localhost**, not `file://` (the latter is blocked).
- **After editing any `src/runtime/` file, rebuild the canvas AND cache-bust the
  URL** before re-testing:
  `node bin/noteback.js wrap examples/spec.html -o examples/spec.canvas.html`,
  then load it with a bumped `?v=N`. The browser HTTP-caches the **inlined**
  runtime, so a stale canvas silently runs old code. (Symptom we hit:
  `lineRangeOf.toString()` showed the old body with no fallback.) `examples/
  spec.canvas.html` is gitignored and rebuilt each time.

## Distribution model (two independent registries)

- `npx skills add alekkowalczyk/noteback` → **GitHub** is the registry
  ([vercel-labs/skills](https://github.com/vercel-labs/skills)). It clones the
  public repo and reads `skills/noteback/SKILL.md` from the default
  branch. Needs: public repo, `name`+`description` frontmatter, on default branch.
- `npx noteback wrap` / `npx noteback install-skill` → **npm** is the registry
  (the published `noteback` package's `bin`).
- **`install-skill` mirrors `skills add`'s layout** (`bin/noteback.js`
  `planInstall`): real files in the vendor-neutral `~/.agents/skills/` hub —
  read **natively by Codex and OpenCode** — plus a relative symlink in
  `~/.claude/skills/` (Claude Code reads only there). One install covers all
  three; it does **not** use `~/.codex/skills/` (the current Codex docs read
  `.agents/skills`, not `.codex/skills`). `--dir <path>` is a plain-copy escape
  hatch (no hub/symlink). Idempotent: a stale dir/symlink at a target is replaced.
- GitHub serves the *skill*; npm serves the *`wrap` CLI*. They're decoupled.
  `npm publish` requires 2FA (`npm publish --otp=<code>` or a granular token with
  "bypass 2fa"). Publishing and pushing are the **maintainer's** actions — don't
  run them unprompted.

## Repo conventions

- **Never commit to `main`** (the default branch). Work on a feature branch and
  open it for merge. (Mirrors the global rule; restated here because the branch
  was renamed from a feature branch to `main`.)
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Screenshots used in docs live in `examples/screenshots/`.
