# History opt-out controls — design

**Date:** 2026-06-07
**Status:** Approved (ready for implementation plan)
**Branch:** `feat/snapshot-history`

## Problem

Version history is recorded automatically wherever it can run — always-on for
`file`/`localhost`/`127.0.0.1` in the extension, and for any embedded canvas with
a working `localStorage` bucket. There is no way for a user to say "don't keep
history here." Two surfaces need an opt-out:

1. **Extension popup** — opt out of storing history **globally**, for the
   **current document**, or for the **current site** (origin / "root URL part").
2. **Embedded canvas** — a **gear (⚙)** button next to the existing `ⓘ` (embedded
   mode only) to opt out for **this document** or **globally for all embedded
   documents**.

## Decisions (settled during brainstorming)

- **"Current root URL part" = origin/site** — scheme+host+port (`file://` for local
  files), matching the existing per-site identity (`originPolicy.originOf`). Not a
  path prefix.
- **Both surfaces take effect live** — toggling stops/starts recording and
  shows/hides the timeline immediately, with no manual page reload.
- **Opt-out = stop + hide, keep data** — recording stops and the timeline hides,
  but already-stored snapshots stay in storage. Re-enabling brings the timeline and
  data straight back. No purge.
- **Per-document opt-out is keyed on the history doc-id** (the baked
  `data-noteback-doc-id`, or the `nb:url:<href>` minted id for extension pages
  Noteback didn't author) — the same identity that buckets history — not on
  `location.href`.
- **Purely subtractive.** This feature only adds opt-**out**. It does **not** add
  history opt-**in** UI for arbitrary origins (the existing `historySites` opt-in
  path is untouched, and gains no new popup control). Explicit non-goal.

## Why the two surfaces differ (the one real trade-off)

The live mechanism is **asymmetric on purpose**, dictated by how each surface builds
its adapter:

- **Extension** chooses the adapter *type* at mount: the unified history engine
  (`createHistoryStateAdapter` over the chrome kv store) when `historyAllowed()` is
  true, else the comments-only `ChromeStorageAdapter`. There is no history adapter
  to gate when history was off at mount — so a live change must **re-mount**
  (unmount + mount) to rebuild the adapter. This keeps CLAUDE.md's "history gate is
  read once at first mount" literally true: a re-mount is a new mount.
- **Embedded** *always* builds the history adapter when `lsStore && docId`, and
  `boot()` is not re-entrant (`window.__notebackBooted` guard). So embedded gates the
  already-built adapter **in place** via an `isEnabled()` predicate — no re-boot.

The rejected alternative — always build the history engine in the extension too and
gate it like embedded — would unify the mechanism but is a larger change to
`buildAdapter` and removes the comments-only fast path that exists for non-history
origins. The asymmetric approach reuses existing mount/unmount machinery and touches
less code.

## Data model

### Extension — `nb:settings` (chrome.storage.local)

Three new fields, all opt-**out** (absence ⇒ history on). Normalized in
`origin-policy.js` `normalizeSettings`:

```js
historyDisabledGlobal : boolean     // kill switch, every page
historyDisabledSites  : string[]    // origins via originOf(): 'file://', 'https://x.com'
historyDisabledDocs   : string[]    // history doc-ids (baked id or nb:url minted id)
```

`normalizeSettings` returns `historyDisabledGlobal: !!s.historyDisabledGlobal`,
`historyDisabledSites: Array.isArray(...) ? slice() : []`, and likewise for
`historyDisabledDocs`, alongside the existing `origins` / `disabledSites` /
`historySites`.

### Embedded — localStorage flags (shared `file://` bucket)

Two boolean flags, namespaced like the existing `nb:doc:` / `nb:ver:` keys:

```
nb:nohist:global         // "1" = off for every embedded canvas in this bucket
nb:nohist:doc:<docId>    // "1" = off for this document
```

`<docId>` is the baked `data-noteback-doc-id`. The "global" flag is scoped to the
localStorage bucket: for `file://` that is **all local canvases in this browser**;
for an http-served canvas it is that origin. Documented caveat — this is what "all
embedded documents here" means.

## Gating logic — one subtract layer

`historyAllowed(info, settings)` in `origin-policy.js` gets an opt-out layer **above**
today's base rule. `info` gains an optional `docKey` (the resolved history doc-id):

```js
function historyAllowed(info, settings) {
  info = info || {};
  const norm = normalizeSettings(settings);
  // hard opt-outs win (subtract layer):
  if (norm.historyDisabledGlobal) return false;
  if (info.origin && norm.historyDisabledSites.indexOf(info.origin) !== -1) return false;
  if (info.docKey && norm.historyDisabledDocs.indexOf(info.docKey) !== -1) return false;
  // existing base (unchanged):
  if (TYPES.indexOf(info.type) !== -1) return true;
  return !!(info.origin && norm.historySites.indexOf(info.origin) !== -1);
}
```

The embedded canvas does **not** use `origin-policy` (it is not in the canvas
bundle). It reads its two localStorage flags directly in `EMBEDDED_BOOT`.

## Live mechanism

### Extension (re-mount on flip)

`content-script.js`:

1. **Cache the history doc-id.** Resolve it once at boot (`resolveDocId()` is already
   called inside `buildAdapter`; lift the resolution so the value is also available
   to `applySettings` and to `NOTEBACK_PING`). Call it `historyDocId`.
2. **Pass `docKey`** into the `historyAllowed` call inside `buildAdapter` (so the
   per-doc opt-out is honored at mount).
3. **Track + re-mount.** Keep `lastHistoryOk`. In `applySettings(settings)`, after the
   existing activate/deactivate decision, compute
   `historyAllowed({type, origin, docKey: historyDocId}, settings)`; if the page is
   currently mounted (`active`) and the value differs from `lastHistoryOk`,
   `unmount()` then `mount(settings)`. Update `lastHistoryOk` on every (re-)mount.
   Comments survive (chrome.storage); the timeline appears/disappears as the rebuilt
   adapter dictates.

Edge: the force-activate path (`window.__notebackForceActivate`, "other" origins
injected via the popup) ignores settings entirely today and continues to — no
history runs there regardless.

### Embedded (in-place gate via `historyControl`)

`EMBEDDED_BOOT` builds a small `historyControl` object **before** the adapter, reading
the two flags synchronously (direct `window.localStorage`, all in try/catch — never
raw, per the file:// throw gotcha):

```js
// pseudo-shape
historyControl = {
  available: !!(RT.historyStateAdapter && lsStore && docId),
  globalOff(): boolean,   // reads nb:nohist:global
  docOff():    boolean,   // reads nb:nohist:doc:<docId>
  enabled():   boolean,   // !(globalOff() || docOff())
  setGlobal(off): void,   // writes/removes nb:nohist:global, updates in-memory flag
  setDoc(off):    void    // writes/removes nb:nohist:doc:<docId>, updates in-memory flag
}
```

- `createHistoryStateAdapter` is called with `isEnabled: historyControl.enabled`.
- `boot()` cfg gains `historyControl: historyControl` so the overlay's gear can flip
  it and call `renderSidebar()` to update the UI live.

`historyControl.available` is false when there is no history machinery (e.g. blocked
`localStorage` → `lsStore` is null); the gear is then not shown.

### Runtime adapter change (`draft-history-core.js`)

`createHistoryStateAdapter` gains one optional `isEnabled()` param (default
`function () { return true; }`). When it returns **false**:

- `save` / `persist` / `load` delegate straight to `inner` (the in-file block in
  embedded mode) — no version snapshot, no `nb:ver`/`nb:doc` writes.
- `getHistory()` returns `[]` (so the timeline and the "Save · with comments and
  history" item hide — both already key off the history list being non-empty).

`getVersion` / `getCurrentVersionKey` / `clearCurrent` keep working against stored
data (harmless; the UI won't call them while the timeline is hidden). This predicate
is the **only** runtime-adapter change; the extension passes no `isEnabled` and gets
the default-true behavior (it relies on re-mount instead).

## UI

### Popup (extension) — "Version history" section

Scoped to the **active tab**. The popup learns the tab's `origin`, `originType`, and
resolved `historyDocId` via an extended `NOTEBACK_PING` response (today it returns
`originType`, `origin`, `docId`, `docTitle`; add `historyDocId`). Three **cascading**
opt-out toggles, default **ON**:

| Toggle | Off writes | On removes |
| --- | --- | --- |
| **Record history** (global) | `historyDisabledGlobal = true` | clears it |
| **On this site — `<origin>`** | add `origin` to `historyDisabledSites` | remove it |
| **On this page** | add `historyDocId` to `historyDisabledDocs` | remove it |

Cascade: when global is off, the site/page toggles render disabled/greyed (their
state is moot). When site is off, the page toggle renders disabled.

The section renders as **actionable** only when base history can run for the page —
i.e. `originType` is a local type, or `origin` is already in `historySites`. For other
origins it shows a one-line hint ("Version history isn't recorded on this site.") and
no toggles. (Consistent with the existing no-opt-in-UI behavior; the non-goal above.)

Writes go through the existing `getSettings()` / `saveSettings()` helpers (which
already merge into `nb:settings`). The resulting `chrome.storage.onChanged` event
drives the content-script re-mount described above — that is the live path.

### Embedded (gear ⚙)

A `⚙` button added to `.nb-head-ctrls` **before** the `ⓘ` button, rendered only when
`runMode === 'embedded'` **and** `cfg.historyControl && cfg.historyControl.available`.
Clicking opens a small card mirroring the existing `.nb-info-dialog` (positioned
overlay with a close affordance, backdrop-click to close), titled e.g. "Version
history", with two opt-out toggles:

| Toggle | Reflects | Off action |
| --- | --- | --- |
| **Record history for this document** | `!historyControl.docOff()` | `historyControl.setDoc(true)` |
| **Record history for all docs here** | `!historyControl.globalOff()` | `historyControl.setGlobal(true)` |

with a hint under the second that "here" means this browser's local files / this
site's storage bucket. Each toggle persists via `historyControl` and then calls
`renderSidebar()` so the timeline + history-save item update live in the same tab.

## "Stop + hide, keep data" — exact semantics

Opting out at any scope:

- **(a) stops recording** new versions (adapter delegates to `inner` / the rebuilt
  comments-only adapter);
- **(b) hides** the timeline *and* the "Save · with comments and history" item — both
  already key off `getHistory()` returning entries;
- **(c) keeps** stored `nb:ver:*` / `nb:doc:*` and any embedded-history block, and
  keeps the `nb:settings` history untouched.

Re-enabling restores the timeline and data immediately. Comments created while opted
out persist to the live store (chrome.storage / the in-file `#noteback-state` block)
— they are simply not versioned until history is re-enabled.

## Files touched

| File | Change |
| --- | --- |
| `src/content/origin-policy.js` | `normalizeSettings` carries the 3 new fields; `historyAllowed` opt-out subtract layer + `docKey` |
| `src/content/content-script.js` | cache `historyDocId`; pass `docKey`; `lastHistoryOk` + re-mount on flip in `applySettings`; `historyDocId` in `NOTEBACK_PING` |
| `src/popup/popup.js` (+ `popup.html`/css) | "Version history" section: 3 cascading opt-out toggles, scoped to the tab |
| `src/canvas/exporter.js` | `historyControl` in `EMBEDDED_BOOT`; pass `isEnabled` to the adapter and `historyControl` into `boot()` |
| `src/runtime/overlay.js` | embedded-only gear button + dialog with 2 toggles; live `renderSidebar()` on toggle |
| `src/runtime/draft-history-core.js` | optional `isEnabled()` param (default true) gating save/getHistory |
| `CONTRACTS.md`, `CLAUDE.md`, `docs/design.md` | document the gate, the flags, the gear, the asymmetric live mechanism |

## Testing

- **Unit — `test/origin-policy.test.js`:** `historyAllowed` opt-out matrix — global,
  site, and doc each subtract independently; opt-out beats the base allow for a local
  type; `docKey` match required for the per-doc case; `normalizeSettings` carries the
  three new fields with safe defaults (missing/garbage ⇒ `false`/`[]`).
- **e2e — embedded gear (`test/e2e/`):** open a canvas (file://), make a comment (a
  `nb:ver` is recorded), open the gear, turn **this document** off ⇒ the timeline +
  "Save · with comments and history" item disappear and a further comment records **no
  new** `nb:ver`; turn it back on ⇒ the timeline returns from the kept data.
- **e2e — extension live opt-out (alongside `extension-standdown.e2e.test.js`):** load
  the unpacked extension on a localhost page, make a comment (a version records), set
  `historyDisabledGlobal` via `chrome.storage.local` (simulating the popup) ⇒ the
  timeline disappears live (re-mount) and a further comment records no version.

## Out of scope / non-goals

- History opt-**in** UI for arbitrary origins (the `historySites` path is unchanged).
- Purging already-stored history on opt-out (kept; only hidden).
- Cross-bucket "global" for embedded (localStorage is per-origin; documented caveat).
