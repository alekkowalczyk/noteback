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
- **Doc identity is the BAKED doc-id; a version is hashed from the CLEAN, pre-paint
  content root.** A draft's identity is the explicit `data-noteback-doc-id` baked on
  `#noteback-doc-root` (extension pages Noteback didn't author fall back to a per-URL
  minted id under `nb:url:<href>`). Within that doc-id, a *version* is keyed by a
  content hash over `#noteback-doc-root` `textContent` (`createHistoryStateAdapter`'s
  `contentText`), read before highlights are painted — never recompute it from the live
  DOM after `<mark>` wrappers are added, or the hash shifts (and the draft splinters
  into a new version). When the text is too short to hash, the version key falls back to
  `h0:<docId>`.
- **`window.localStorage` access can THROW (not just be absent) on `file://`** or
  when storage is blocked — and `file://` is the primary canvas use case. The
  `EMBEDDED_BOOT` builds the localStorage-backed kv store (`lsStore`) inside a
  `try/catch`; on failure `lsStore` is `null` and `createHistoryStateAdapter` degrades
  to the in-file `InFileStateAdapter` (comments still work, just no version history).
  Never reference `window.localStorage` raw in the boot guard, or a blocked store
  crashes the whole canvas mount (it did once — the overlay never appeared).
- **`file://` localStorage is one shared bucket** across all local canvases (Chrome).
  Keys are namespaced and keyed by the explicit doc-id (`nb:doc:<docId>`) /
  content-hashed version key (`nb:ver:<versionKey>`), with `nb:url:<href>` for
  per-URL minted ids (extension only), precisely so distinct documents don't collide in
  that shared bucket.
- **History snapshots the WHOLE clean document ONCE, at a version's first comment —
  there is no per-comment fragment/"section" extraction.** `snapshot-capture.js`
  `captureCleanDoc` clones `documentElement`, strips `[data-noteback-ui]`, **unwraps**
  every `<mark class="noteback-highlight">`, and drops `#noteback-state` + the inline
  runtime `<script>`, then stores the result gzipped (`makeCodec`). Because the marks
  are stripped, the snapshot is **paint-independent**: it does NOT matter whether
  highlights are painted when `save`/`persist` runs (the old "paint before persist"
  bug class and its `history-popup.e2e.test.js` guard are gone — `commitPopover`'s
  `repaintHighlights()` is now just a visual refresh with no ordering requirement vs.
  `persist`). `history-state-adapter.js` captures the snapshot only when the version
  has **no** snapshot yet (`needSnapshot = comments.length>0 && !r.hasSnapshot`);
  `hasSnapshot` is seeded from the real stored snapshot, never the comment count.
- **The version PEEK re-renders the snapshot with the LIVE highlight painter, not a
  cross-node matcher.** `overlay.openVersionPeek` parses the stored snapshot with
  `DOMParser`, runs `highlightApi.paintHighlights(parsed.body, {comments}, {})` over it
  (the marks are created in the parsed doc's own `ownerDocument`, so they survive
  serialization), and shows the result in an `<iframe srcdoc>` with a fixed
  **"← Back to current"** banner (locked wording). No `nbHistHighlight`, no
  `\s*`-loose whitespace re-finder — the painter re-anchors from the same comment data
  the live doc uses. A pruned snapshot (`html === ''`) is a no-op.
- **CHECKOUT (`open`) re-seeds `#noteback-state` and MUST escape `</script>`.**
  `overlay.openVersionTab` → `buildVersionCanvasHtml` clones the live page shell (to
  keep the inlined runtime + styles), swaps the snapshot's `#noteback-doc-root` content
  in, and re-seeds the `#noteback-state` block with the version's comments. That JSON is
  written via `outerHTML`, which emits raw text **verbatim**, so a comment body
  containing `</script>` would break out of the block — it is escaped with the SAME
  `.replace(/<\/(script)/gi, '<\\/$1')` the canonical exporter uses (`JSON.parse` reads
  `<\/script` back as `</script`, so the comment round-trips). The version timeline +
  checkout are covered by the browser e2e `test/e2e/version-timeline.e2e.test.js`
  (the old `history-popup.e2e.test.js` is deleted).
- **`wrap` PRESERVES an existing doc-id — don't make it re-mint.** The version history
  follows the baked `data-noteback-doc-id`, so re-wrapping a canvas must keep the same
  id or the history orphans. `bin/noteback.js`'s precedence is: explicit `--id` → the id
  already baked in the `-o` target file → the id baked in the input HTML → mint a fresh
  one (`mintDocId` / `readBakedDocId`). The `-o`-target reuse is the easy one to drop —
  it's how `wrap` in place keeps history across re-exports.
- **Extension history is GATED per-site (`historyAllowed`), decided at first mount.**
  `origin-policy.js` `historyAllowed(info, settings)` is default-on for
  `file`/`localhost`/`127.0.0.1` and opt-in via `historySites` for any other origin.
  When it's false the content script keeps the comments-only `ChromeStorageAdapter`
  (no version timeline). The gate is read once at first `mount()`, so toggling a
  per-site history opt-in takes effect on **reload**, not live (unlike the
  activate/deactivate transition, which is live on `chrome.storage.onChanged`). The
  embedded canvas has no settings and always runs history (subject to `lsStore`).
  `createChromeKvStore` THROWS if `chrome.storage.local` is missing — the content
  script catches it (not `.catch()`) and degrades.
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
