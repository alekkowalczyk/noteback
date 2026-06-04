# CLAUDE.md — Noteback engineering notes

Project-local guidance for working in this repo. Read alongside `README.md`
(what/why), `CONTRACTS.md` (the runtime module API + behavioral invariants), and
`docs/superpowers/specs/2026-06-03-noteback-design.md` (the original design).
This file records the **non-obvious gotchas** — things you can't infer by reading
the code, that have already bitten us once.

## Hard constraints (do not break)

- **Zero npm dependencies, no build step, no TypeScript.** It loads unpacked
  exactly as written. Don't add a bundler, a framework, or a `dependencies`
  entry. Tests run on the **Node built-in runner** (`npm test` → `node --test`).
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
  public repo and reads `skills/noteback-canvas/SKILL.md` from the default
  branch. Needs: public repo, `name`+`description` frontmatter, on default branch.
- `npx noteback wrap` / `npx noteback install-skill` → **npm** is the registry
  (the published `noteback` package's `bin`).
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
