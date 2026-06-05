# Design — Popup Save parity + per-origin activation control

Date: 2026-06-05
Status: approved (brainstorm), pending implementation plan
Branch context: builds on the sidebar Save… menu (`feat/save-menu-clean-pdf`).

## Summary

Two related changes to the **extension-mode** UI:

1. **Popup Save parity.** The toolbar popup's single *Save as HTML with comments*
   button becomes a **Save ▾ dropdown** with the same three options the sidebar
   already has: *HTML · with comments*, *HTML · clean copy*, *PDF*.
2. **Per-origin activation control.** A way to make Noteback **go dormant** on
   origins where it's in the way (primarily local dev servers), via two levers:
   a **per-site** quick toggle and **per-type** switches (`file://` / `localhost`
   / `127.0.0.1`). Dormant = injected but mounts no UI; comment data is untouched.

Both are extension-only. The embedded canvas runtime is unaffected (it has no
popup and no settings — it always shows its own UI).

## Motivation

- The sidebar gained a three-way Save menu; the popup still offers only the
  canvas save. Users reaching for Save from the toolbar get an inferior subset.
- When actively building on `localhost`/`127.0.0.1`, the Noteback comment chip
  and launcher get in the way. There is currently **no** way to suppress it short
  of disabling or removing the extension. The pain is specifically "this dev
  server is in my way *right now*."

## Non-goals (YAGNI)

- No per-path / per-URL / regex rules — origin granularity only.
- No dedicated options page — settings live in an inline popup panel.
- No cross-device sync of settings.
- No snooze/scheduling ("off for 2 hours").
- No change to embedded-canvas behavior.

---

## Feature 1 — Popup Save dropdown

### Behavior
The popup's Save control opens a small menu with three items, mirroring the
sidebar labels exactly:

- **HTML · with comments** → `controller.saveCanvas()`
- **HTML · clean copy** → `controller.saveClean()`
- **PDF/Print** → `controller.savePdf()`

### Wiring
- `boot.js`: the boot controller currently forwards only `saveCanvas`. Add
  pass-throughs for `saveClean` and `savePdf` (the overlay controller already
  implements both).
- `content-script.js`: add two inbound message types and route them to the
  controller:
  - `NOTEBACK_SAVE_CLEAN` → `controller.saveClean()`
  - `NOTEBACK_SAVE_PDF` → `controller.savePdf()`
  - (`NOTEBACK_SAVE_CANVAS` already exists.)
- `popup.html` / `popup.js` / `popup.css`: replace the single Save button with a
  Save ▾ disclosure + a three-item menu; each item sends the matching message.
  Style mirrors the sidebar's menu look; reuse the existing popup button visuals.

Because the sidebar already invokes these same controller methods in-page, the
popup path produces identical results — **no new export logic**. PDF still works
by triggering the page's print flow (the popup closes as the print dialog opens).

---

## Feature 2 — Per-origin activation control

### The activation predicate

A page is **active** iff:

```
origins[type] === true   AND   origin ∉ disabledSites
```

- `type` ∈ `{ "file", "localhost", "127.0.0.1" }`, derived from `location`.
  Anything else classifies as `"other"` and is never matched (the manifest only
  injects on the three supported origin classes anyway).
- `origin` is `location.origin` (scheme + host + port). For `file://` pages this
  is the single value `"file://"`.

**Active** → mount the overlay + selection listeners (today's behavior).
**Dormant** → the content script is injected (the manifest match can't be
conditional) but it mounts nothing: no chip, no launcher, no `selectionchange`
listener. Stored comments are **not** touched — only the live UI is suppressed.

### Precedence (deliberate)

- **Per-type switch is the master gate.** Turning a type off suppresses Noteback
  on **all** sites of that type.
- **Per-site toggle only subtracts.** It removes a single noisy origin while its
  type stays on. It cannot re-enable a site whose type is off.
- For `file://`, per-site == per-type (one origin) — the popup labels the
  per-site control accordingly so this isn't surprising.

### Live application (no reload)

The content script subscribes to `chrome.storage.onChanged` for the settings
key. When the popup writes a change, every open tab re-evaluates the predicate
and **mounts or unmounts immediately**:

- newly active and not mounted → `mount()` (calls `boot()`)
- newly dormant and mounted → `unmount()` (calls `controller.destroy()`, which
  releases boot's single-mount guard so a later `mount()` is clean)

This is why the boot/destroy lifecycle matters: `boot.js` already exposes a
`destroy()` that tears down the overlay, clears highlights, and resets
`__notebackBooted`, making re-mount idempotent.

### Settings storage

One new key in `chrome.storage.local`, separate from per-document comment state
(which is keyed per `docId`):

```jsonc
// key: "nb:settings"
{
  "version": 1,
  "origins": { "file": true, "localhost": true, "127.0.0.1": true },
  "disabledSites": []          // array of origins, e.g. "http://localhost:3000"
}
```

**Absent key = all-on, nothing disabled.** Fresh installs and existing users keep
today's behavior with zero migration. Reads treat a missing/partial object as
all-defaults-true.

### New module — `src/content/origin-policy.js`

A DOM-free, UMD-lite dual-export module (same pattern as `anchor`/`state`/
`markdown`) so it is unit-testable under Node:

```
classifyOrigin(loc)        -> "file" | "localhost" | "127.0.0.1" | "other"
isActive(info, settings)   -> boolean        // applies the predicate above
```

- `info` carries `{ type, origin }`. `classifyOrigin` accepts a
  `location`-shaped object (`{ protocol, hostname, origin }`) so tests can pass
  plain objects.
- Added to the manifest `content_scripts.js` list (before `content-script.js`).
  Extension-only; **not** added to `web_accessible_resources` (the canvas never
  uses settings).

### Content-script changes (`src/content/content-script.js`)

- Refactor the one-shot boot into a `mount()` / `unmount()` pair holding the
  current controller and an `active` flag.
- On load: read `nb:settings` → `isActive` → `mount()` or stay dormant.
- Subscribe to `chrome.storage.onChanged`; on a settings change re-evaluate and
  mount/unmount as above.
- Extend the `NOTEBACK_PING` response so the popup can distinguish *dormant by
  settings* from *not injected (no file access)*:
  `{ ok, booted, dormant, originType, origin, docTitle }`.

---

## Popup layout

```
┌─────────────────────────────┐
│ Noteback                ⚙︎  │   gear toggles the settings panel
├─────────────────────────────┤
│ [ Toggle sidebar          ] │
│ [ Copy feedback as markdown]│
│ [ Save ▾                  ] │   Feature 1 dropdown
│                             │
│ Active on this site   (●—)  │   per-site quick toggle (frequent action)
├─────────────────────────────┤
│ status line                 │
└─────────────────────────────┘

⚙︎ panel (slides over the body): per-type switches
   file://      (●—)
   localhost    (●—)
   127.0.0.1    (●—)
```

- **Per-site toggle is front-and-center** (the frequent "off here" action);
  **per-type switches sit behind the gear** (rare configuration).
- **Per-site toggle when its type is off:** shown disabled (it can't override
  type-off) with a one-line hint pointing at the gear, e.g. "localhost is off in
  settings". This keeps the precedence rule legible instead of offering a toggle
  that silently does nothing.
- **Dormant-by-settings state:** when the active page is dormant due to settings,
  the body shows "Noteback is off on this site" plus the toggle to switch it back
  on — visually distinct from the existing file-access onboarding card. The popup
  uses the `PING` `dormant`/`originType` fields to choose which state to render.
- Writing a toggle updates `nb:settings`; the content script reacts live, and the
  popup refreshes its own status. No page reload required.

## State interactions / edge cases

- **Type off + per-site present:** type-off wins; the page is dormant regardless
  of the per-site entry.
- **file:// per-site:** equals per-type (single origin `"file://"`); labeled so.
- **Unsupported origin (`other`):** never active; popup keeps today's "works on
  local file:// and localhost documents" message.
- **No file access on `file://`:** unchanged — onboarding card path takes
  precedence over the dormant-by-settings path (you can't be "active on this
  site" if the script never injected).
- **Canvas page with extension on:** unchanged — boot's single-mount guard still
  makes the embedded runtime win; settings gate only the extension's own mount.

## Testing

- **Unit (`node --test`):** `origin-policy` — `classifyOrigin` for file/localhost/
  127/other, and an `isActive` truth table covering type-gate, per-site subtract,
  precedence, and missing/partial settings (all-on default).
- **Manual / live:**
  - Popup Save dropdown: all three exports fire from the toolbar (with-comments
    downloads a canvas, clean-copy downloads comment-free HTML, PDF opens print).
  - Per-site toggle on `localhost:8000` doc → chip/launcher disappear **without
    reload**; re-enable → they return. Comments still present afterward.
  - Per-type `localhost` off → dormant on all localhost; a `localhost` review doc
    is suppressed too (expected); `file://` doc unaffected.
  - Dormant-by-settings popup state is visually distinct from the file-access
    onboarding card.

## Files touched (anticipated)

- `manifest.json` — add `src/content/origin-policy.js` to `content_scripts.js`.
- `src/content/origin-policy.js` — **new** pure module.
- `src/content/content-script.js` — mount/unmount lifecycle, storage subscription,
  PING fields, two new save messages.
- `src/runtime/boot.js` — forward `saveClean` / `savePdf` on the controller.
- `src/popup/popup.html` / `popup.js` / `popup.css` — Save dropdown, gear +
  settings panel, per-site toggle, dormant-state body.
- `test/` — `origin-policy` unit tests.
- `CONTRACTS.md` — document the `nb:settings` schema and the activation predicate.
```
