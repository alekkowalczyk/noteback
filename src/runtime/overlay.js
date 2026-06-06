/**
 * Noteback runtime — overlay.js  (DOM-ONLY; browser global)
 *
 * Responsibility: the mode-agnostic annotation UI —
 *   - floating "💬 Comment" button that appears on text selection,
 *   - comment popover (textarea) for create / edit,
 *   - sidebar listing all comments (with their quotes), edit/delete, a footer
 *     "Save…" menu (HTML with comments / clean HTML / PDF) plus copy-as-markdown,
 *     and an "unanchored" group for orphans.
 * This is the SAME component used in the extension and inside the saved canvas.
 *
 * It is storage- and export-agnostic: it receives a StorageAdapter (CONTRACTS.md
 * §1) and an exporter hooks object (§3.6), so it never calls Chrome APIs or
 * touches disk directly. Coordinates with `NotebackRuntime.highlight` for paint
 * and with `NotebackRuntime.state`/`anchor` for mutations.
 *
 * Browser-only: attaches to `NotebackRuntime.overlay`. No module.exports.
 *
 * Public API (CONTRACTS.md §3.5):
 *   mountOverlay({ root, adapter, exporter, getState, setState, onChange,
 *                  toMarkdown }) -> { destroy(), refresh(), toggleSidebar(),
 *                                     openSidebar(), closeSidebar(),
 *                                     copyMarkdown(), saveCanvas(), saveClean(),
 *                                     savePdf() }
 *
 * The overlay owns the live State for the duration of the session. `boot.js`
 * injects `getState`/`setState` so a single State instance is shared between the
 * overlay and the highlight painter, and `onChange(state)` is fired after every
 * persisted mutation so boot can repaint highlights.
 *
 * Styling is scoped two ways:
 *   - The sidebar/popover live in a Shadow DOM host so host-page CSS can't bleed
 *     in and our CSS can't leak out.
 *   - The floating button lives in the light DOM (so it can be positioned near
 *     the live selection) but every class is `noteback-`-prefixed and styles are
 *     injected once under a scoped <style data-noteback-ui> guard.
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.overlay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UI_ATTR = 'data-noteback-ui';

  function rt() {
    const g = typeof globalThis !== 'undefined' ? globalThis : this;
    return g.NotebackRuntime || {};
  }

  /* ----------------------------------------------------------------------- *
   * Styles (injected into the shadow root for the panel; into the document  *
   * head for the floating light-DOM button).                                *
   * ----------------------------------------------------------------------- */

  // Light-DOM styles: the floating "Comment" chip that appears on selection, and
  // the painted highlight — a filled honey swatch with rounded corners and a 1px
  // darker-yellow ring. The passage being actively commented gets a teal ring.
  const BUTTON_CSS = [
    '.noteback-fab{',
    '  position:absolute;z-index:2147483646;',
    '  display:inline-flex;align-items:center;gap:7px;',
    '  font:600 12.5px/1 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    '  letter-spacing:.01em;color:#fffdf8;background:#127a72;',
    '  border:none;border-radius:999px;padding:7px 13px 7px 11px;cursor:pointer;',
    '  box-shadow:0 7px 18px -6px rgba(15,98,89,.6),0 1px 2px rgba(20,30,20,.22);',
    '  opacity:0;transition:transform .12s ease,background .15s ease;',
    '  -webkit-font-smoothing:antialiased;',
    '}',
    '.noteback-fab::before{content:"";width:9px;height:9px;border-radius:2px;',
    '  background:#ffd166;box-shadow:0 0 0 2px rgba(255,209,102,.3);}',
    // Entrance is a keyframe animation (re)started by toggling .nb-in — reliable
    // out of display:none, where a plain transition frequently won't fire.
    '.noteback-fab.nb-in{opacity:1;animation:nb-fab-pop .24s cubic-bezier(0.34,1.5,0.64,1);}',
    '@keyframes nb-fab-pop{0%{opacity:0;transform:scale(.8) translateY(3px);}',
    '  55%{opacity:1;}100%{opacity:1;transform:scale(1) translateY(0);}}',
    '.noteback-fab:hover{background:#0e6960;}',
    '.noteback-fab:active{transform:scale(.96);}',
    'mark.noteback-highlight{',
    '  background:#ffe7a3;color:inherit;border-radius:4px;padding:0 1.5px;cursor:pointer;',
    '  box-shadow:0 0 0 1px rgba(210,158,40,.55);',
    '  -webkit-box-decoration-break:clone;box-decoration-break:clone;',
    '  transition:background .2s ease,box-shadow .2s ease;',
    '}',
    'mark.noteback-highlight:hover{background:#ffdd83;box-shadow:0 0 0 1px rgba(198,148,34,.8);}',
    /* the passage being commented in the open editor — teal-ringed to stand out */
    'mark.noteback-highlight[data-noteback-id="__nb_preview"]{',
    '  background:#ffdd83;box-shadow:0 0 0 2px rgba(18,122,114,.6);}',
    'mark.noteback-highlight-flash{',
    '  background:#ffd166 !important;border-radius:4px !important;',
    '  box-shadow:0 0 0 2px rgba(18,122,114,.6) !important;',
    '  transition:background .25s ease,box-shadow .25s ease;',
    '}',
    '@media (prefers-reduced-motion: reduce){',
    '  .noteback-fab,mark.noteback-highlight,mark.noteback-highlight-flash{transition:none !important;animation:none !important;}',
    '  .noteback-fab,.noteback-fab.nb-in{opacity:1;transform:none;animation:none !important;}',
    '}',
    // Printing (incl. "Save as PDF" from the menu): hide every Noteback-injected
    // node and render highlights as plain text, so the printout/PDF is the clean
    // document. [data-noteback-ui] covers the sidebar host, launcher, fab and our
    // injected <style>; highlights stay inline but lose their honey styling.
    '@media print{',
    '  [data-noteback-ui]{display:none !important;}',
    '  mark.noteback-highlight,mark.noteback-highlight-flash{',
    '    background:transparent !important;box-shadow:none !important;color:inherit !important;}',
    '}'
  ].join('');

  // Shadow-DOM panel styles. Concept: a calm editor's desk — neutral surfaces,
  // near-ink text, a fountain-pen teal accent, honey highlighter for quotes, an
  // italic-serif voice for quoted passages, and a soft rounded wordmark. Motion is
  // adapted from transitions.dev (panel reveal, menu dropdown, notification badge,
  // texts reveal, success check) and gated behind one prefers-reduced-motion guard.
  const PANEL_CSS = [
    ':host{all:initial;',
    '  --nb-ink:#2b2b29;--nb-ink-soft:#6c6c68;--nb-ink-faint:#a2a09b;',
    '  --nb-line:#e6e5e2;--nb-line-strong:#d6d5d1;',
    '  --nb-accent:#127a72;--nb-accent-deep:#0e6960;--nb-accent-ink:#0c5f59;--nb-accent-wash:#e6efed;',
    '  --nb-danger:#b04a33;--nb-danger-wash:#f3e8e3;',
    '  --nb-paper:#f5f5f3;--nb-card:#ffffff;',
    '  --nb-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    '  --nb-round:ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN",Quicksand,system-ui,sans-serif;',
    '  --nb-quote:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;',
    '  --panel-open-dur:420ms;--panel-close-dur:300ms;--panel-blur:3px;--panel-ease:cubic-bezier(0.22,1,0.36,1);',
    '  --dropdown-open-dur:240ms;--dropdown-close-dur:150ms;--dropdown-pre-scale:0.96;--dropdown-closing-scale:0.99;--dropdown-ease:cubic-bezier(0.22,1,0.36,1);',
    '  --badge-slide-dur:260ms;--badge-pop-dur:500ms;--badge-pop-close-dur:180ms;--badge-fade-dur:400ms;--badge-fade-close-dur:180ms;--badge-blur:2px;--badge-offset-x:-7px;--badge-offset-y:10px;--badge-slide-ease:cubic-bezier(0.22,1,0.36,1);--badge-pop-ease:cubic-bezier(0.34,1.36,0.64,1);--badge-close-ease:cubic-bezier(0.4,0,0.2,1);',
    '  --stagger-dur:460ms;--stagger-ease:cubic-bezier(0.22,1,0.36,1);',
    '  --check-opacity-dur:520ms;--check-rotate-dur:520ms;--check-rotate-from:60deg;--check-bob-dur:440ms;--check-y-amount:10px;--check-blur-dur:480ms;--check-blur-from:6px;--check-path-dur:520ms;--check-path-delay:90ms;--check-ease-opacity:cubic-bezier(0.22,1,0.36,1);--check-ease-rotate:cubic-bezier(0.22,1,0.36,1);--check-ease-out:cubic-bezier(0.22,1,0.36,1);--check-ease-bob:cubic-bezier(0.34,1.35,0.64,1);--check-ease-path:cubic-bezier(0.22,1,0.36,1);',
    '}',
    '*{box-sizing:border-box;}',
    '.nb-root{font:14px/1.5 var(--nb-ui);color:var(--nb-ink);-webkit-font-smoothing:antialiased;}',

    /* sidebar — panel reveal (slide + cross-blur + fade on one ease) */
    '.nb-sidebar{position:fixed;top:0;right:0;height:100vh;width:360px;max-width:88vw;',
    '  background:var(--nb-paper);color:var(--nb-ink);border-left:1px solid var(--nb-line);',
    '  box-shadow:-16px 0 44px -22px rgba(40,40,38,.45);display:flex;flex-direction:column;z-index:2147483647;',
    '  transform:translateX(44px);opacity:0;filter:blur(var(--panel-blur));pointer-events:none;',
    '  transition:transform var(--panel-close-dur) var(--panel-ease),opacity var(--panel-close-dur) var(--panel-ease),filter var(--panel-close-dur) var(--panel-ease);',
    '  will-change:transform,opacity,filter;}',
    '.nb-sidebar.nb-open{transform:translateX(0);opacity:1;filter:blur(0);pointer-events:auto;',
    '  transition:transform var(--panel-open-dur) var(--panel-ease),opacity var(--panel-open-dur) var(--panel-ease),filter var(--panel-open-dur) var(--panel-ease);}',

    /* header */
    '.nb-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    '  padding:16px 16px 13px;border-bottom:1px solid var(--nb-line);}',
    '.nb-titlewrap{display:flex;align-items:baseline;gap:9px;min-width:0;}',
    '.nb-title{font:700 16px/1 var(--nb-round);letter-spacing:.01em;color:var(--nb-ink);',
    '  display:inline-flex;align-items:center;gap:8px;}',
    '.nb-title::before{content:"";width:11px;height:11px;border-radius:3px;background:#ffd166;',
    '  box-shadow:0 0 0 3px rgba(255,209,102,.22);}',
    '.nb-count{color:var(--nb-ink-soft);font:500 12px/1 var(--nb-ui);white-space:nowrap;}',
    '.nb-x{border:none;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--nb-ink-faint);',
    '  width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none;',
    '  transition:background .15s ease,color .15s ease,transform .15s ease;}',
    '.nb-x:hover{background:#ececea;color:var(--nb-ink);}',
    '.nb-x:active{transform:scale(.9);}',
    '.nb-head-ctrls{display:flex;align-items:center;gap:4px;flex:none;}',
    '.nb-info{border:none;background:none;font-size:18px;line-height:1;cursor:pointer;color:var(--nb-ink-faint);',
    '  width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none;',
    '  transition:background .15s ease,color .15s ease,transform .15s ease;}',
    '.nb-info:hover{background:#ececea;color:var(--nb-ink);}',
    '.nb-info:active{transform:scale(.9);}',

    /* info dialog (install-as-a-skill) */
    '.nb-info-dialog{position:absolute;inset:0;z-index:5;display:flex;align-items:flex-start;justify-content:center;',
    '  padding:54px 16px 16px;background:rgba(40,40,38,.28);}',
    '.nb-info-dialog[hidden]{display:none;}',
    '.nb-info-card{width:100%;background:var(--nb-paper);border:1px solid var(--nb-line);border-radius:14px;',
    '  box-shadow:0 18px 50px -20px rgba(40,40,38,.5);padding:14px 14px 16px;}',
    '.nb-info-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;}',
    '.nb-info-title{font:700 14px/1.2 var(--nb-round);color:var(--nb-ink);}',
    '.nb-info-x{border:none;background:none;font-size:18px;line-height:1;cursor:pointer;color:var(--nb-ink-faint);',
    '  width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none;}',
    '.nb-info-x:hover{background:#ececea;color:var(--nb-ink);}',
    '.nb-info-note{margin:0 0 12px;font:400 12.5px/1.5 var(--nb-ui);color:var(--nb-ink-soft);}',
    '.nb-cmd{display:flex;align-items:center;gap:8px;margin-top:8px;}',
    '.nb-cmd code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;',
    '  font:500 11.5px/1.4 var(--nb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);',
    '  background:#f3f2ef;border:1px solid var(--nb-line);border-radius:8px;padding:6px 8px;color:var(--nb-ink);}',
    '.nb-cmd-copy{flex:none;border:1px solid var(--nb-line);background:#fff;cursor:pointer;border-radius:8px;',
    '  font:600 11px/1 var(--nb-ui);padding:6px 9px;color:var(--nb-ink-soft);transition:background .15s ease,color .15s ease;}',
    '.nb-cmd-copy:hover{background:#f3f2ef;color:var(--nb-ink);}',
    '.nb-info-link{display:inline-block;margin-top:13px;font:600 12px/1 var(--nb-ui);',
    '  color:#2563eb;text-decoration:none;}',
    '.nb-info-link:hover{text-decoration:underline;}',

    /* list */
    '.nb-list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:13px 14px 16px;scrollbar-width:thin;}',
    '.nb-group-label{font:700 10.5px/1 var(--nb-round);text-transform:uppercase;letter-spacing:.09em;',
    '  color:var(--nb-ink-faint);margin:15px 4px 9px;display:flex;align-items:center;gap:9px;}',
    '.nb-group-label::after{content:"";flex:1;height:1px;background:var(--nb-line);}',

    /* comment cards */
    '.nb-item{position:relative;border:1px solid var(--nb-line);border-radius:13px;',
    '  padding:12px 13px 10px;margin-bottom:11px;background:var(--nb-card);',
    '  transition:box-shadow .2s ease,transform .2s ease,border-color .2s ease;}',
    '.nb-item:hover{box-shadow:0 12px 24px -16px rgba(40,40,38,.5);transform:translateY(-1px);border-color:var(--nb-line-strong);}',
    '.nb-item.nb-orphan{border-style:dashed;border-color:#d6d5d1;background:#f3f3f1;}',
    '.nb-item.nb-active{border-color:var(--nb-accent);box-shadow:0 0 0 1.5px var(--nb-accent),0 12px 24px -16px rgba(17,122,114,.55);}',
    '.nb-item.nb-doc{border-color:#bfe0db;background:#f1faf8;}',

    /* quote — soft honey wash + rounded honey border, a quiet echo of the highlight */
    '.nb-quote{font:italic 400 13.5px/1.5 var(--nb-quote);color:#6a5a38;',
    '  background:#fcf6e7;border:1px solid rgba(208,162,52,.34);border-radius:7px;',
    '  padding:6px 9px;display:block;margin:0 0 9px;cursor:pointer;white-space:pre-wrap;word-break:break-word;',
    '  transition:background .2s ease,border-color .2s ease;}',
    '.nb-quote:hover{background:#faf0d4;border-color:rgba(200,152,42,.5);}',
    '.nb-item.nb-orphan .nb-quote{background:#f0f0ee;border-color:#dededa;color:var(--nb-ink-soft);}',

    '.nb-doc-tag{display:inline-flex;align-items:center;gap:5px;font:600 11px/1 var(--nb-round);',
    '  color:var(--nb-accent-ink);background:var(--nb-accent-wash);border-radius:999px;padding:4px 10px;margin-bottom:8px;}',
    '.nb-body{white-space:pre-wrap;word-break:break-word;margin:0 0 9px;font:400 13.5px/1.5 var(--nb-ui);color:var(--nb-ink);}',
    '.nb-actions{display:flex;gap:6px;}',
    '.nb-link{border:none;background:none;color:var(--nb-ink-soft);cursor:pointer;font:600 12px/1 var(--nb-round);',
    '  padding:5px 9px;border-radius:8px;transition:background .15s ease,color .15s ease;}',
    '.nb-link:hover{background:var(--nb-accent-wash);color:var(--nb-accent-ink);}',
    '.nb-link.nb-danger{color:#9c7b6e;}',
    '.nb-link.nb-danger:hover{background:var(--nb-danger-wash);color:var(--nb-danger);}',

    '.nb-empty{color:var(--nb-ink-soft);text-align:center;padding:30px 18px 24px;font:400 13px/1.55 var(--nb-ui);}',
    '.nb-empty strong{display:block;font:700 14.5px/1.3 var(--nb-round);color:var(--nb-ink);margin-bottom:6px;}',
    '.nb-empty b{font-weight:600;color:var(--nb-accent-ink);}',

    /* footer + buttons */
    '.nb-foot{border-top:1px solid var(--nb-line);padding:12px 14px 14px;display:flex;flex-direction:column;gap:8px;',
    '  background:linear-gradient(180deg,rgba(245,245,243,0),#eeeeec);}',
    '.nb-btn{font:700 13px/1 var(--nb-round);border:1px solid var(--nb-accent);background:var(--nb-accent);color:#fffdf8;',
    '  border-radius:11px;padding:11px 12px;cursor:pointer;text-align:center;display:inline-flex;align-items:center;justify-content:center;gap:7px;',
    '  box-shadow:0 7px 16px -10px rgba(15,98,89,.7);transition:background .15s ease,transform .12s ease,box-shadow .2s ease;}',
    '.nb-btn:hover{background:var(--nb-accent-deep);box-shadow:0 11px 22px -10px rgba(15,98,89,.8);}',
    '.nb-btn:active{transform:translateY(1px) scale(.995);}',
    '.nb-btn.nb-secondary{background:var(--nb-card);color:var(--nb-accent-ink);border-color:var(--nb-line-strong);box-shadow:none;}',
    '.nb-btn.nb-secondary:hover{background:var(--nb-accent-wash);border-color:var(--nb-accent);}',

    /* save menu — a dropdown that grows upward from the footer "Save" button */
    '.nb-save-wrap{position:relative;}',
    '.nb-save-btn{width:100%;}',
    '.nb-save-btn .nb-caret{margin-left:6px;font-size:10px;line-height:1;opacity:.85;transition:transform .18s var(--dropdown-ease);}',
    '.nb-save-wrap.nb-menu-open .nb-save-btn .nb-caret{transform:rotate(180deg);}',
    '.nb-menu{position:absolute;left:0;right:0;bottom:calc(100% + 8px);z-index:2147483647;',
    '  background:var(--nb-card);border:1px solid var(--nb-line-strong);border-radius:14px;padding:6px;',
    '  box-shadow:0 20px 46px -16px rgba(40,40,38,.5),0 2px 8px rgba(40,40,38,.12);transform-origin:bottom center;',
    '  transform:scale(var(--dropdown-pre-scale));opacity:0;pointer-events:none;',
    '  transition:transform var(--dropdown-open-dur) var(--dropdown-ease),opacity var(--dropdown-open-dur) var(--dropdown-ease);',
    '  will-change:transform,opacity;}',
    '.nb-menu.is-open{transform:scale(1);opacity:1;pointer-events:auto;}',
    '.nb-menu.is-closing{transform:scale(var(--dropdown-closing-scale));opacity:0;pointer-events:none;',
    '  transition:transform var(--dropdown-close-dur) var(--dropdown-ease),opacity var(--dropdown-close-dur) var(--dropdown-ease);}',
    '.nb-menu-item{display:block;width:100%;text-align:left;border:none;background:none;cursor:pointer;',
    '  padding:9px 11px;border-radius:10px;transition:background .14s ease;}',
    '.nb-menu-item:hover,.nb-menu-item:focus-visible{background:var(--nb-accent-wash);outline:none;}',
    '.nb-mi-label{display:block;font:700 13px/1.25 var(--nb-round);color:var(--nb-ink);}',
    '.nb-menu-item:hover .nb-mi-label,.nb-menu-item:focus-visible .nb-mi-label{color:var(--nb-accent-deep);}',
    '.nb-mi-sub{display:block;font:400 11.5px/1.3 var(--nb-ui);color:var(--nb-ink-soft);margin-top:2px;}',
    '.nb-menu-sep{height:1px;background:var(--nb-line);margin:4px 9px;}',
    /* copy split-button — main keeps its action; the caret opens this menu */
    '.nb-copy-wrap{position:relative;display:flex;}',
    '.nb-copy-wrap .nb-copy{flex:1;border-top-right-radius:0;border-bottom-right-radius:0;}',
    '.nb-copy-caret-btn{flex:none;padding:0 10px;border-left:none;border-top-left-radius:0;border-bottom-left-radius:0;}',
    '.nb-copy-caret-btn .nb-caret{font-size:10px;line-height:1;opacity:.85;transition:transform .18s var(--dropdown-ease);}',
    '.nb-copy-wrap.nb-menu-open .nb-copy-caret-btn .nb-caret{transform:rotate(180deg);}',

    /* version timeline (docs/design.md §14.4) + snapshot peek popup */
    '.nb-versions{margin-top:14px;border-top:1px solid var(--nb-line);}',
    '.nb-versions .nb-group-label{margin:13px 4px 4px;}',
    '.nb-ver-rest[hidden]{display:none;}',
    '.nb-ver-row{padding:9px 4px;border-top:1px solid var(--nb-line);}',
    '.nb-ver-row:first-of-type{border-top:none;}',
    '.nb-ver-row.active{background:var(--nb-accent-wash);border-radius:10px;border-top:none;margin-top:2px;}',
    '.nb-ver-line{display:flex;align-items:center;gap:9px;font:500 13px/1.3 var(--nb-ui);color:var(--nb-ink);cursor:pointer;}',
    '.nb-ver-row.active .nb-ver-line{cursor:default;}',
    '.nb-ver-dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--nb-ink-faint);flex:none;box-sizing:border-box;}',
    '.nb-ver-row.active .nb-ver-dot{background:var(--nb-accent);border-color:var(--nb-accent);}',
    '.nb-ver-name{font:700 13px/1.2 var(--nb-round);color:var(--nb-ink);}',
    '.nb-ver-meta{font:400 11.5px/1.2 var(--nb-ui);color:var(--nb-ink-soft);}',
    '.nb-ver-spacer{flex:1;}',
    '.nb-ver-here{font:700 9.5px/1 var(--nb-round);letter-spacing:.08em;text-transform:uppercase;color:var(--nb-accent-deep);}',
    '.nb-ver-count{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;background:#efe7d6;',
    '  border:1px solid var(--nb-line);border-radius:999px;padding:2px 9px;color:var(--nb-ink-soft);}',
    '.nb-ver-row.active .nb-ver-count{background:#fff;}',
    '.nb-ver-actions{display:flex;gap:7px;margin:8px 0 0 19px;}',
    '.nb-ver-btn{font:600 12px/1 var(--nb-round);padding:5px 11px;border-radius:9px;border:1px solid var(--nb-line-strong);',
    '  background:var(--nb-card);color:var(--nb-ink);cursor:pointer;transition:background .14s ease,border-color .14s ease;}',
    '.nb-ver-btn:hover:not(:disabled){background:var(--nb-accent-wash);border-color:var(--nb-accent);color:var(--nb-accent-deep);}',
    '.nb-ver-open{background:var(--nb-accent);border-color:var(--nb-accent);color:#fffdf8;}',
    '.nb-ver-open:hover:not(:disabled){background:var(--nb-accent-deep);border-color:var(--nb-accent-deep);color:#fffdf8;}',
    '.nb-ver-btn:disabled{opacity:.42;cursor:default;}',
    '.nb-disclose{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:none;background:none;cursor:pointer;',
    '  padding:11px 4px;border-top:1px solid var(--nb-line);border-radius:0;}',
    '.nb-disclose:hover .nb-disclose-label{color:var(--nb-accent-deep);}',
    '.nb-disclose-chev{display:inline-flex;color:var(--nb-ink-faint);font-size:14px;line-height:1;transition:transform .16s ease;}',
    '.nb-disclose.nb-open .nb-disclose-chev{transform:rotate(90deg);}',
    '.nb-disclose-label{font:700 10px/1 var(--nb-round);letter-spacing:.08em;text-transform:uppercase;color:var(--nb-ink-soft);}',
    '.nb-hist-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
    '.nb-hist-panel{position:relative;width:min(820px,92vw);height:min(80vh,720px);background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);}',
    '.nb-hist-close{position:absolute;top:8px;right:8px;z-index:3;border:none;background:#0001;border-radius:50%;width:28px;height:28px;cursor:pointer;}',
    '.nb-hist-back{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;align-items:center;gap:6px;',
    '  border:none;border-bottom:1px solid var(--nb-line);background:var(--nb-accent-wash);color:var(--nb-accent-deep);',
    '  font:700 12px/1 var(--nb-round);letter-spacing:.01em;padding:11px 40px 11px 14px;cursor:pointer;text-align:left;',
    '  transition:background .14s ease,color .14s ease;}',
    '.nb-hist-back:hover{background:var(--nb-accent);color:#fffdf8;}',
    '.nb-hist-frame{position:absolute;top:38px;left:0;right:0;bottom:0;width:100%;height:auto;border:0;background:#fff;}',

    /* toast + success check (transitions.dev) */
    '.nb-toast{position:fixed;bottom:20px;right:20px;display:inline-flex;align-items:center;gap:9px;',
    '  background:#2b2b29;color:#f4f4f2;padding:11px 15px 11px 13px;border-radius:13px;font:500 13px/1.2 var(--nb-ui);',
    '  z-index:2147483647;opacity:0;transform:translateY(8px) scale(.96);pointer-events:none;',
    '  box-shadow:0 16px 36px -12px rgba(18,18,16,.6);',
    '  transition:opacity .22s ease,transform .22s cubic-bezier(0.34,1.36,0.64,1);}',
    '.nb-toast.nb-show{opacity:1;transform:translateY(0) scale(1);}',
    '.nb-toast-check{display:none;width:20px;height:20px;flex:none;transform-origin:center;opacity:0;',
    '  will-change:transform,opacity,filter;}',
    '.nb-toast.nb-has-check .nb-toast-check{display:inline-block;}',
    '.nb-toast-check svg{display:block;overflow:visible;width:20px;height:20px;}',
    '.nb-toast-check svg path{stroke:#ffd166;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;',
    '  stroke-dasharray:22;stroke-dashoffset:22;}',
    '.nb-toast-check[data-state="in"]{animation:nb-check-fade var(--check-opacity-dur) var(--check-ease-opacity) forwards,',
    '  nb-check-rotate var(--check-rotate-dur) var(--check-ease-rotate) forwards,',
    '  nb-check-blur var(--check-blur-dur) var(--check-ease-out) forwards,',
    '  nb-check-bob var(--check-bob-dur) var(--check-ease-bob) forwards;}',
    '.nb-toast-check[data-state="in"] svg path{animation:nb-check-draw var(--check-path-dur) var(--check-ease-path) var(--check-path-delay) forwards;}',
    '@keyframes nb-check-fade{from{opacity:0;}to{opacity:1;}}',
    '@keyframes nb-check-rotate{from{transform:rotate(var(--check-rotate-from));}to{transform:rotate(0);}}',
    '@keyframes nb-check-blur{from{filter:blur(var(--check-blur-from));}to{filter:blur(0);}}',
    '@keyframes nb-check-bob{from{translate:0 var(--check-y-amount);}to{translate:0 0;}}',
    '@keyframes nb-check-draw{to{stroke-dashoffset:0;}}',

    /* popover — menu dropdown (origin-aware grow) */
    '.nb-popover{position:fixed;z-index:2147483647;background:var(--nb-card);border:1px solid var(--nb-line-strong);',
    '  border-radius:15px;box-shadow:0 20px 46px -16px rgba(40,40,38,.5),0 2px 8px rgba(40,40,38,.12);',
    '  padding:13px;width:312px;max-width:92vw;transform-origin:top center;',
    '  transform:scale(var(--dropdown-pre-scale));opacity:0;pointer-events:none;',
    '  transition:transform var(--dropdown-open-dur) var(--dropdown-ease),opacity var(--dropdown-open-dur) var(--dropdown-ease);',
    '  will-change:transform,opacity;}',
    '.nb-popover[data-origin="bottom-center"]{transform-origin:bottom center;}',
    '.nb-popover.is-open{transform:scale(1);opacity:1;pointer-events:auto;}',
    '.nb-popover.is-closing{transform:scale(var(--dropdown-closing-scale));opacity:0;pointer-events:none;',
    '  transition:transform var(--dropdown-close-dur) var(--dropdown-ease),opacity var(--dropdown-close-dur) var(--dropdown-ease);}',
    '.nb-popover textarea{width:100%;min-height:76px;resize:vertical;border:1px solid var(--nb-line-strong);',
    '  border-radius:10px;padding:9px 10px;font:400 13.5px/1.5 var(--nb-ui);color:var(--nb-ink);background:#ffffff;',
    '  transition:border-color .15s ease,box-shadow .15s ease;}',
    '.nb-popover textarea::placeholder{color:var(--nb-ink-faint);}',
    '.nb-popover textarea:focus{outline:none;border-color:var(--nb-accent);box-shadow:0 0 0 3px var(--nb-accent-wash);}',
    '.nb-pop-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:11px;}',
    /* drag handle — grab to slide the composer off the highlighted text */
    '.nb-pop-handle{display:flex;align-items:center;justify-content:center;height:13px;margin:-5px 0 8px;',
    '  cursor:grab;touch-action:none;}',
    '.nb-pop-handle::before{content:"";width:32px;height:4px;border-radius:999px;background:var(--nb-line-strong);',
    '  transition:background .15s ease,width .15s ease;}',
    '.nb-pop-handle:hover::before{background:var(--nb-ink-faint);width:40px;}',
    '.nb-popover.nb-dragging{cursor:grabbing;transition:none;}',
    '.nb-popover.nb-dragging .nb-pop-handle{cursor:grabbing;}',

    /* launcher pill + notification badge */
    '.nb-launcher{position:fixed;right:18px;bottom:18px;z-index:2147483646;display:inline-flex;align-items:center;gap:8px;',
    '  border:none;cursor:pointer;background:var(--nb-accent);color:#fffdf8;border-radius:999px;padding:10px 16px 10px 13px;',
    '  font:700 13px/1 var(--nb-round);letter-spacing:.01em;',
    '  box-shadow:0 12px 26px -12px rgba(15,98,89,.7),0 2px 6px rgba(20,30,20,.18);',
    '  animation:nb-launch-in .5s cubic-bezier(0.22,1,0.36,1) both;',
    '  transition:transform .22s cubic-bezier(0.34,1.36,0.64,1),box-shadow .22s ease,background .15s ease;}',
    '.nb-launcher:hover{transform:translateY(-2px);background:var(--nb-accent-deep);',
    '  box-shadow:0 18px 32px -12px rgba(15,98,89,.75),0 3px 8px rgba(20,30,20,.2);}',
    '.nb-launcher:active{transform:translateY(0) scale(.98);}',
    '.nb-launcher.nb-hidden{display:none;}',
    '.nb-launcher-icon{width:11px;height:11px;border-radius:3px;background:#ffd166;box-shadow:0 0 0 3px rgba(255,209,102,.25);}',
    '@keyframes nb-launch-in{from{transform:translateY(16px) scale(.9);opacity:0;}to{transform:translateY(0) scale(1);opacity:1;}}',
    '@keyframes nb-badge-slide-in{from{transform:translate(var(--badge-offset-x),var(--badge-offset-y));}to{transform:translate(0,0);}}',
    '.nb-launcher-badge{position:absolute;top:-7px;right:-6px;pointer-events:none;will-change:transform;}',
    '.nb-launcher-badge[data-open="true"]{animation:nb-badge-slide-in var(--badge-slide-dur) var(--badge-slide-ease);}',
    '.nb-badge-dot{display:flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;',
    '  border-radius:999px;background:#ffd166;color:#5a4a12;font:700 11px/1 var(--nb-round);border:2px solid var(--nb-paper);',
    '  box-shadow:0 2px 6px rgba(40,40,38,.3);transform-origin:center;transform:scale(1);opacity:1;filter:blur(0);',
    '  transition:transform var(--badge-pop-dur) var(--badge-pop-ease),opacity var(--badge-fade-dur) var(--badge-pop-ease),filter var(--badge-pop-dur) var(--badge-pop-ease);',
    '  will-change:transform,opacity,filter;}',
    '.nb-launcher-badge[data-open="false"] .nb-badge-dot{transform:scale(0);opacity:0;filter:blur(var(--badge-blur));',
    '  transition:transform var(--badge-pop-close-dur) var(--badge-close-ease),opacity var(--badge-fade-close-dur) var(--badge-close-ease),filter var(--badge-pop-close-dur) var(--badge-close-ease);}',

    /* whole-document note composer */
    '.nb-doc-composer{margin-bottom:12px;}',
    '.nb-add-doc{width:100%;border:1.5px dashed var(--nb-line-strong);background:var(--nb-card);color:var(--nb-accent-ink);',
    '  border-radius:12px;padding:11px 12px;font:600 12.5px/1.2 var(--nb-round);cursor:pointer;',
    '  display:flex;align-items:center;justify-content:center;gap:7px;',
    '  transition:background .15s ease,border-color .15s ease,color .15s ease,transform .12s ease;}',
    '.nb-add-doc:hover{background:var(--nb-accent-wash);border-color:var(--nb-accent);color:var(--nb-accent-deep);}',
    '.nb-add-doc:active{transform:scale(.99);}',
    '.nb-doc-ta{width:100%;min-height:70px;resize:vertical;border:1px solid var(--nb-line-strong);border-radius:11px;',
    '  padding:9px 10px;font:400 13.5px/1.5 var(--nb-ui);color:var(--nb-ink);background:#ffffff;',
    '  transition:border-color .15s ease,box-shadow .15s ease;}',
    '.nb-doc-ta::placeholder{color:var(--nb-ink-faint);}',
    '.nb-doc-ta:focus{outline:none;border-color:var(--nb-accent);box-shadow:0 0 0 3px var(--nb-accent-wash);}',

    /* list reveal — staggered settle, armed only while .nb-reveal is present */
    '.nb-list.nb-reveal .nb-item,.nb-list.nb-reveal .nb-group-label,.nb-list.nb-reveal .nb-empty{',
    '  opacity:0;transform:translateY(7px);filter:blur(2px);',
    '  transition:opacity var(--stagger-dur) var(--stagger-ease),transform var(--stagger-dur) var(--stagger-ease),filter var(--stagger-dur) var(--stagger-ease);}',
    '.nb-list.nb-reveal.nb-shown .nb-item,.nb-list.nb-reveal.nb-shown .nb-group-label,.nb-list.nb-reveal.nb-shown .nb-empty{',
    '  opacity:1;transform:translateY(0);filter:blur(0);}',

    '@media (prefers-reduced-motion: reduce){',
    '  .nb-sidebar,.nb-popover,.nb-menu,.nb-launcher,.nb-toast,.nb-launcher-badge,.nb-badge-dot,',
    '  .nb-list.nb-reveal .nb-item,.nb-list.nb-reveal .nb-group-label,.nb-list.nb-reveal .nb-empty{',
    '    transition:none !important;animation:none !important;}',
    '  .nb-toast-check,.nb-toast-check svg path{animation:none !important;}',
    '  .nb-toast-check svg path{stroke-dashoffset:0 !important;}',
    '}'
  ].join('');

  /* ----------------------------------------------------------------------- *
   * mountOverlay                                                             *
   * ----------------------------------------------------------------------- */

  /**
   * @param {Object} cfg
   * @param {Node} cfg.root                       Document root to annotate.
   * @param {Object} cfg.adapter                  StorageAdapter (load/save).
   * @param {Object} [cfg.exporter]               Export hooks; may be partial.
   * @param {() => Object} cfg.getState           Returns the current live State.
   * @param {(s:Object)=>void} cfg.setState       Stores a new live State.
   * @param {(s:Object)=>void} [cfg.onChange]     Fired after each persisted change.
   * @param {(s:Object)=>string} [cfg.toMarkdown] Markdown renderer override.
   * @returns {Object} controller
   */
  function mountOverlay(cfg) {
    cfg = cfg || {};
    const rootNode = cfg.root || (typeof document !== 'undefined' ? document.body : null);
    if (!rootNode) throw new Error('overlay.mountOverlay needs a root node');
    const doc = rootNode.ownerDocument || document;
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);

    const modules = rt();
    const anchorApi = modules.anchor;
    const stateApi = modules.state;
    const highlightApi = modules.highlight;
    const markdownApi = modules.markdown;
    if (!anchorApi || !stateApi) {
      throw new Error('overlay.mountOverlay requires NotebackRuntime.anchor and .state');
    }

    const adapter = cfg.adapter;
    const exporter = cfg.exporter || {};
    const getState = cfg.getState || (function () { return null; });
    const setState = cfg.setState || function () {};
    const history = cfg.history || null;
    const onChange = cfg.onChange || function () {};
    // Prefer the runtime markdown module directly so we can hand it the document
    // markup for line references; fall back to the boot-supplied renderer.
    const renderMd = markdownApi
      ? function (s) { return markdownApi.toMarkdown(s, { docHtml: docHtmlForLines() }); }
      : (cfg.toMarkdown || null);

    // Popover close animation duration (keep in sync with --dropdown-close-dur).
    const POPOVER_CLOSE_MS = 160;

    /** Whether the user has asked the OS for reduced motion. */
    function reduceMotion() {
      try {
        return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) { return false; }
    }

    /* --- inject the light-DOM button style once ------------------------- */
    if (!doc.querySelector('style[data-noteback-ui="fab"]')) {
      const st = doc.createElement('style');
      st.setAttribute(UI_ATTR, 'fab');
      st.textContent = BUTTON_CSS;
      (doc.head || doc.documentElement).appendChild(st);
    }

    /* --- shadow host for the panel UI ----------------------------------- */
    const host = doc.createElement('div');
    host.setAttribute(UI_ATTR, 'panel');
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    (doc.body || doc.documentElement).appendChild(host);

    let shadow;
    if (typeof host.attachShadow === 'function') {
      shadow = host.attachShadow({ mode: 'open' });
    } else {
      shadow = host; // graceful fallback (older engines)
    }
    const styleEl = doc.createElement('style');
    styleEl.textContent = PANEL_CSS;
    shadow.appendChild(styleEl);

    const uiRoot = doc.createElement('div');
    uiRoot.className = 'nb-root';
    shadow.appendChild(uiRoot);

    /* --- floating comment button (light DOM) ---------------------------- */
    const fab = doc.createElement('button');
    fab.type = 'button';
    fab.className = 'noteback-fab';
    fab.setAttribute(UI_ATTR, 'fab');
    fab.textContent = 'Comment'; // a honey marker chip is drawn via CSS ::before
    fab.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(fab);

    let pendingAnchor = null;   // anchor described from the current selection
    let pendingFabRect = null;  // selection rect the chip should sit above
    let fabTimer = null;        // debounce: show the chip a beat after settling
    const FAB_DELAY_MS = 340;

    /* --- sidebar -------------------------------------------------------- */
    const sidebar = doc.createElement('div');
    sidebar.className = 'nb-sidebar';
    uiRoot.appendChild(sidebar);
    sidebar.innerHTML =
      '<div class="nb-head">' +
      '  <div class="nb-titlewrap"><span class="nb-title">Noteback</span> <span class="nb-count"></span></div>' +
      '  <div class="nb-head-ctrls">' +
      '    <button type="button" class="nb-info" title="Install Noteback as a skill" aria-label="About Noteback" aria-expanded="false">ⓘ</button>' +
      '    <button type="button" class="nb-x" title="Close" aria-label="Close">×</button>' +
      '  </div>' +
      '</div>' +
      '<div class="nb-list"></div>' +
      '<div class="nb-foot">' +
      '  <div class="nb-copy-wrap">' +
      '    <button type="button" class="nb-btn nb-secondary nb-copy">Copy feedback</button>' +
      '    <button type="button" class="nb-btn nb-secondary nb-copy-caret-btn" aria-haspopup="menu" aria-expanded="false" aria-label="More copy options"><span class="nb-caret" aria-hidden="true">▾</span></button>' +
      '    <div class="nb-copy-menu nb-menu" role="menu" aria-label="Copy options">' +
      '      <button type="button" class="nb-menu-item nb-copy-canvas" role="menuitem">' +
      '        <span class="nb-mi-label">Copy html (with feedback)</span>' +
      '        <span class="nb-mi-sub">re-openable canvas</span></button>' +
      '      <div class="nb-menu-sep" role="none"></div>' +
      '      <button type="button" class="nb-menu-item nb-copy-clean" role="menuitem">' +
      '        <span class="nb-mi-label">Copy html (clean)</span>' +
      '        <span class="nb-mi-sub">the original, no Noteback</span></button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="nb-save-wrap">' +
      '    <button type="button" class="nb-btn nb-save-btn" aria-haspopup="menu" aria-expanded="false">Save<span class="nb-caret" aria-hidden="true">▾</span></button>' +
      '    <div class="nb-menu" role="menu" aria-label="Save options">' +
      '      <button type="button" class="nb-menu-item nb-save-comments" role="menuitem">' +
      '        <span class="nb-mi-label">HTML · with comments</span>' +
      '        <span class="nb-mi-sub">highlights &amp; notes, re-shareable</span></button>' +
      '      <div class="nb-menu-sep" role="none"></div>' +
      '      <button type="button" class="nb-menu-item nb-save-clean" role="menuitem">' +
      '        <span class="nb-mi-label">HTML · clean copy</span>' +
      '        <span class="nb-mi-sub">the original, no Noteback</span></button>' +
      '      <div class="nb-menu-sep" role="none"></div>' +
      '      <button type="button" class="nb-menu-item nb-save-pdf" role="menuitem">' +
      '        <span class="nb-mi-label">PDF/Print</span>' +
      '        <span class="nb-mi-sub">print-ready, no comments</span></button>' +
      '      <div class="nb-menu-sep" role="none"></div>' +
      '      <button type="button" class="nb-menu-item nb-clear-comments" role="menuitem">' +
      '        <span class="nb-mi-label">Clear my comments (this draft)</span>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="nb-info-dialog" role="dialog" aria-label="About Noteback" hidden>' +
      '  <div class="nb-info-card">' +
      '    <div class="nb-info-head">' +
      '      <span class="nb-info-title">Hand yourself annotatable docs</span>' +
      '      <button type="button" class="nb-info-x" title="Close" aria-label="Close">×</button>' +
      '    </div>' +
      '    <p class="nb-info-note">Noteback also ships as an agent skill + CLI, so an AI (Claude Code, etc.) can give you HTML that is already annotatable.</p>' +
      '    <div class="nb-cmd"><code>npx skills add alekkowalczyk/noteback</code>' +
      '      <button type="button" class="nb-cmd-copy" data-cmd="npx skills add alekkowalczyk/noteback" title="Copy command">Copy</button></div>' +
      '    <div class="nb-cmd"><code>npx noteback install-skill</code>' +
      '      <button type="button" class="nb-cmd-copy" data-cmd="npx noteback install-skill" title="Copy command">Copy</button></div>' +
      '    <a class="nb-info-link" href="https://github.com/alekkowalczyk/noteback" target="_blank" rel="noopener noreferrer">View the project on GitHub ↗</a>' +
      '  </div>' +
      '</div>';

    const elCount = sidebar.querySelector('.nb-count');
    const elList = sidebar.querySelector('.nb-list');
    const saveWrap = sidebar.querySelector('.nb-save-wrap');
    const saveBtn = sidebar.querySelector('.nb-save-btn');
    const saveMenu = saveWrap.querySelector('.nb-menu');
    const copyWrap = sidebar.querySelector('.nb-copy-wrap');
    const copyCaretBtn = sidebar.querySelector('.nb-copy-caret-btn');
    const copyMenu = sidebar.querySelector('.nb-copy-menu');
    sidebar.querySelector('.nb-x').addEventListener('click', closeSidebar);
    sidebar.querySelector('.nb-copy').addEventListener('click', copyMarkdown);
    copyCaretBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleCopyMenu(); });
    sidebar.querySelector('.nb-copy-canvas').addEventListener('click', function () { closeCopyMenu(); copyHtmlCanvas(); });
    sidebar.querySelector('.nb-copy-clean').addEventListener('click', function () { closeCopyMenu(); copyHtmlClean(); });
    saveBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleSaveMenu(); });
    sidebar.querySelector('.nb-save-comments').addEventListener('click', function () { closeSaveMenu(); saveCanvas(); });
    sidebar.querySelector('.nb-save-clean').addEventListener('click', function () { closeSaveMenu(); saveClean(); });
    sidebar.querySelector('.nb-save-pdf').addEventListener('click', function () { closeSaveMenu(); savePdf(); });
    const clearBtn = sidebar.querySelector('.nb-clear-comments');
    if (!history) { clearBtn.style.display = 'none'; }
    else {
      clearBtn.addEventListener('click', function () {
        closeSaveMenu();
        Promise.resolve(history.clearCurrent()).then(function () {
          const empty = { schemaVersion: 1, docId: (getState() || {}).docId || '', docTitle: (getState() || {}).docTitle || '', comments: [] };
          setState(empty);
          return persist(empty); // write through to the in-file block / re-share copy (parity with delete)
        }).then(function () {
          repaintHighlights();
          renderSidebar();
        });
      });
    }

    /* --- info dialog (install-as-a-skill) ------------------------------- */
    const infoBtn = sidebar.querySelector('.nb-info');
    const infoDialog = sidebar.querySelector('.nb-info-dialog');
    let infoOpen = false;
    function openInfo() { infoDialog.hidden = false; infoOpen = true; infoBtn.setAttribute('aria-expanded', 'true'); }
    function closeInfo() { infoDialog.hidden = true; infoOpen = false; infoBtn.setAttribute('aria-expanded', 'false'); }
    infoBtn.addEventListener('click', function (e) { e.stopPropagation(); if (infoOpen) closeInfo(); else openInfo(); });
    infoDialog.querySelector('.nb-info-x').addEventListener('click', closeInfo);
    // Click on the dim backdrop (but not the card) closes it.
    infoDialog.addEventListener('click', function (e) { if (e.target === infoDialog) closeInfo(); });
    const infoCopyBtns = infoDialog.querySelectorAll('.nb-cmd-copy');
    for (let i = 0; i < infoCopyBtns.length; i++) {
      infoCopyBtns[i].addEventListener('click', function () {
        const cmd = this.getAttribute('data-cmd') || '';
        Promise.resolve(copyToClipboard(cmd)).then(function (ok) {
          toast(ok ? 'Copied command' : 'Copy failed — select & copy manually', { success: !!ok });
        });
      });
    }
    const onDocKeydownInfo = function (e) {
      if (e.key === 'Escape' && infoOpen) { closeInfo(); if (infoBtn && infoBtn.focus) infoBtn.focus(); }
    };
    doc.addEventListener('keydown', onDocKeydownInfo);

    /* --- launcher (always-visible pill that opens the sidebar) ---------- */
    const launcher = doc.createElement('button');
    launcher.type = 'button';
    launcher.className = 'nb-launcher';
    launcher.setAttribute(UI_ATTR, 'launcher');
    launcher.title = 'Open Noteback';
    launcher.innerHTML =
      '<span class="nb-launcher-icon" aria-hidden="true"></span>' +
      '<span class="nb-launcher-label">Noteback</span>' +
      '<span class="nb-launcher-badge" data-open="false" aria-hidden="true"><span class="nb-badge-dot"></span></span>';
    uiRoot.appendChild(launcher);
    launcher.addEventListener('click', openSidebar);

    let lastBadgeCount = 0;
    /**
     * Reflect the comment count on the launcher's notification badge. The dot
     * pops in when it first appears and re-pops whenever the count changes
     * (replay = drop to data-open="false", reflow, then back to "true").
     */
    function updateLauncher() {
      const s = getState();
      const n = (s && Array.isArray(s.comments)) ? s.comments.length : 0;
      const badge = launcher.querySelector('.nb-launcher-badge');
      const dot = launcher.querySelector('.nb-badge-dot');
      if (dot) dot.textContent = n > 0 ? String(n) : '';
      if (badge) {
        if (n > 0) {
          if (n !== lastBadgeCount) {
            badge.setAttribute('data-open', 'false');
            void badge.offsetWidth; // reflow so the pop replays from scale(0)
          }
          badge.setAttribute('data-open', 'true');
        } else {
          badge.setAttribute('data-open', 'false');
        }
      }
      lastBadgeCount = n;
    }

    /* --- popover (in shadow root) --------------------------------------- */
    let popover = null;
    let editingId = null;
    // Inline "note about the whole document" composer state (lives in the sidebar).
    let docComposerOpen = false;
    let docComposerDraft = '';

    /* ------------------------------------------------------------------- *
     * Selection → floating button                                         *
     * ------------------------------------------------------------------- */

    function onSelectionChange() {
      if (popover) return; // don't fight an open editor
      const sel = win ? win.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        hideFab();
        return;
      }
      const selectedText = String(sel.toString());
      if (selectedText.trim() === '') { hideFab(); return; }

      // Ignore selections inside our own UI.
      const anchorNode = sel.anchorNode;
      if (anchorNode && isInOwnUi(anchorNode)) { hideFab(); return; }

      const range = sel.getRangeAt(0);
      const anchor = describeFromRange(range);
      if (!anchor) { hideFab(); return; }
      pendingAnchor = anchor;
      pendingFabRect = range.getBoundingClientRect();

      // If the chip is already up, just follow the growing selection. Otherwise
      // debounce its first appearance: wait until the selection settles for a
      // beat, then pop it in — so it doesn't flicker mid-drag and the entrance
      // animation is actually seen rather than snapping in under the cursor.
      if (fab.style.display !== 'none') {
        positionFab(pendingFabRect);
      } else {
        scheduleFab();
      }
    }

    /** (Re)arm the debounce; the chip pops in once the selection holds still. */
    function scheduleFab() {
      if (!win || !win.setTimeout) { if (pendingFabRect) positionFab(pendingFabRect); return; }
      if (fabTimer) win.clearTimeout(fabTimer);
      fabTimer = win.setTimeout(function () {
        fabTimer = null;
        if (pendingAnchor && pendingFabRect) positionFab(pendingFabRect);
      }, FAB_DELAY_MS);
    }

    function cancelFabTimer() {
      if (fabTimer && win && win.clearTimeout) win.clearTimeout(fabTimer);
      fabTimer = null;
    }

    function positionFab(rect) {
      fab.style.display = 'inline-flex';
      const scrollX = win ? (win.scrollX || win.pageXOffset || 0) : 0;
      const scrollY = win ? (win.scrollY || win.pageYOffset || 0) : 0;
      const fabW = fab.offsetWidth || 110;
      let left = rect.left + scrollX + (rect.width / 2) - (fabW / 2);
      let top = rect.top + scrollY - fab.offsetHeight - 8;
      if (top < scrollY + 4) top = rect.bottom + scrollY + 8; // flip below
      if (left < scrollX + 4) left = scrollX + 4;
      fab.style.left = left + 'px';
      fab.style.top = top + 'px';
      // Play the pop-in once when first shown for this selection; while the user
      // keeps dragging the selection we only reposition (nb-in already on).
      if (!fab.classList.contains('nb-in')) playFabIn();
    }

    /**
     * Play the chip's pop-in. It's a keyframe animation (.nb-in), not a
     * transition, because a transition out of display:none frequently doesn't
     * fire. Toggling the class with a forced reflow in between reliably starts
     * the animation. Fired once the debounce settles, so the entrance is seen.
     */
    function playFabIn() {
      fab.classList.remove('nb-in');
      void fab.offsetWidth; // reflow → guarantees the animation restarts
      fab.classList.add('nb-in');
    }

    function hideFab() {
      cancelFabTimer();
      fab.style.display = 'none';
      fab.classList.remove('nb-in');
      pendingAnchor = null;
      pendingFabRect = null;
    }

    fab.addEventListener('mousedown', function (e) {
      // Prevent the click from clearing the selection before we read it.
      e.preventDefault();
    });
    fab.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!pendingAnchor) return;
      const anchor = pendingAnchor;
      // Position the composer relative to the SELECTION (not the chip, which sits
      // above it) so the composer can sit clear of the highlighted passage.
      const rect = pendingFabRect || fabRect();
      hideFab();
      openPopover({ anchor: anchor, body: '', id: null, rect: rect });
    });

    function fabRect() {
      const r = fab.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
    }

    /**
     * Describe an anchor (quote/prefix/suffix/occurrence) from a live Range by
     * mapping its endpoints into the flat document text the anchor module uses.
     */
    function describeFromRange(range) {
      const text = getDocText();
      const startIdx = globalOffsetOf(range.startContainer, range.startOffset);
      const endIdx = globalOffsetOf(range.endContainer, range.endOffset);
      if (startIdx == null || endIdx == null || endIdx <= startIdx) return null;
      return anchorApi.describeAnchor(text, startIdx, endIdx);
    }

    /**
     * Flat text of the doc, excluding our own UI — built with the SAME walk
     * (UI / script / style exclusion) the highlight module uses, so an anchor
     * described here re-finds identically when highlight.paintHighlights runs.
     */
    function getDocText() {
      return computeDocText().text;
    }

    /** Compute flat doc text + an index of contributing text nodes. */
    function computeDocText() {
      const nodes = [];
      const starts = [];
      let text = '';
      const NF = (typeof NodeFilter !== 'undefined') ? NodeFilter : null;
      if (!NF || typeof doc.createTreeWalker !== 'function') {
        return { text: rootNode.textContent || '', nodes: nodes, starts: starts };
      }
      const walker = doc.createTreeWalker(rootNode, NF.SHOW_TEXT, {
        acceptNode: function (node) {
          let el = node.parentNode;
          while (el && el !== rootNode.parentNode) {
            if (el.nodeType === 1) {
              const tag = (el.tagName || '').toUpperCase();
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NF.FILTER_REJECT;
              if (typeof el.hasAttribute === 'function' && el.hasAttribute(UI_ATTR)) return NF.FILTER_REJECT;
            }
            el = el.parentNode;
          }
          return NF.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode())) {
        const v = n.nodeValue || '';
        if (v.length === 0) continue;
        starts.push(text.length);
        nodes.push(n);
        text += v;
      }
      return { text: text, nodes: nodes, starts: starts };
    }

    /**
     * Serialize the document's CONTENT markup for line-number lookup: a clone of
     * the doc root with our injected UI removed and highlight <mark> wrappers
     * unwrapped, so it matches the markup the author actually edits. Line numbers
     * are relative to the start of this content (line 1 = first line of the body).
     */
    function docHtmlForLines() {
      try {
        const clone = rootNode.cloneNode(true);
        if (!clone || typeof clone.querySelectorAll !== 'function') return '';
        const ui = clone.querySelectorAll('[' + UI_ATTR + ']');
        for (let i = 0; i < ui.length; i++) {
          if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]);
        }
        const cls = highlightApi ? highlightApi.HIGHLIGHT_CLASS : 'noteback-highlight';
        const marks = clone.querySelectorAll('mark.' + cls);
        for (let i = 0; i < marks.length; i++) {
          const m = marks[i];
          const p = m.parentNode;
          if (!p) continue;
          while (m.firstChild) p.insertBefore(m.firstChild, m);
          p.removeChild(m);
        }
        return clone.innerHTML || '';
      } catch (e) {
        return '';
      }
    }

    /**
     * Global flat-text offset of a (container, offset) DOM position. We sum the
     * lengths of all contributing text nodes that precede the position. A
     * highlight <mark> we painted contains a text node, which is naturally
     * included by the walk (it isn't UI), so offsets stay consistent.
     */
    function globalOffsetOf(container, offset) {
      const view = computeDocText();
      const nodes = view.nodes;
      const starts = view.starts;
      if (container.nodeType === 3) {
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i] === container) return starts[i] + offset;
        }
        return null;
      }
      // Element container: offset counts child nodes. Resolve to the first text
      // position at/after that child boundary.
      const child = container.childNodes[offset] || null;
      if (child == null) {
        // Position is at the end of the element: use end of its last text descendant.
        const last = lastTextDescendant(container);
        if (!last) return endOffsetFallback(container, view);
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i] === last) return starts[i] + (last.nodeValue || '').length;
        }
        return null;
      }
      const firstText = (child.nodeType === 3) ? child : firstTextDescendant(child);
      if (!firstText) {
        // No text inside; fall back to position before next contributing node.
        return endOffsetFallback(container, view);
      }
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i] === firstText) return starts[i];
      }
      return null;
    }

    function endOffsetFallback(container, view) {
      // Best-effort: map to the start of the next contributing text node after
      // this container, else the full text length.
      const nodes = view.nodes;
      const starts = view.starts;
      for (let i = 0; i < nodes.length; i++) {
        if (container.compareDocumentPosition &&
            (container.compareDocumentPosition(nodes[i]) & 4 /* FOLLOWING */)) {
          return starts[i];
        }
      }
      return view.text.length;
    }

    function firstTextDescendant(node) {
      if (!node) return null;
      if (node.nodeType === 3) return node;
      let child = node.firstChild;
      while (child) {
        const found = firstTextDescendant(child);
        if (found) return found;
        child = child.nextSibling;
      }
      return null;
    }
    function lastTextDescendant(node) {
      if (!node) return null;
      if (node.nodeType === 3) return node;
      let child = node.lastChild;
      while (child) {
        const found = lastTextDescendant(child);
        if (found) return found;
        child = child.previousSibling;
      }
      return null;
    }

    function isInOwnUi(node) {
      let el = node.nodeType === 1 ? node : node.parentNode;
      while (el) {
        if (el === host || el === fab) return true;
        if (el.nodeType === 1 && typeof el.hasAttribute === 'function' && el.hasAttribute(UI_ATTR)) {
          return true;
        }
        el = el.parentNode || (el.host /* shadow boundary */);
        if (el && el.nodeType === 11) el = el.host;
      }
      return false;
    }

    /* ------------------------------------------------------------------- *
     * Popover (create / edit a comment)                                   *
     * ------------------------------------------------------------------- */

    // Id of the transient "you're commenting THIS" highlight painted while the
    // editor is open (CSS gives it a teal ring). Never persisted.
    const PREVIEW_ID = '__nb_preview';
    let previewShown = false;

    /** Repaint highlights from the real (persisted) State. */
    function repaintHighlights() {
      if (highlightApi && typeof highlightApi.paintHighlights === 'function') {
        try { highlightApi.paintHighlights(rootNode, getState(), {}); } catch (e) {}
      }
    }

    /**
     * Indicate what a comment targets, in the document rather than in the dialog:
     *   - editing an anchored comment → flash its existing highlight,
     *   - creating from a selection → drop the (graying) native selection and
     *     paint a teal-ringed preview highlight over the chosen passage,
     *   - whole-document note → nothing to point at.
     */
    function showAnchorPreview(o) {
      if (!highlightApi || typeof highlightApi.paintHighlights !== 'function') return;
      const anchor = o && o.anchor;
      if (o && o.id) {
        if (anchor && anchor.quote && typeof highlightApi.focusHighlight === 'function') {
          try { highlightApi.focusHighlight(rootNode, o.id); } catch (e) {}
        }
        return;
      }
      if (!anchor || !anchor.quote) return;
      try { const sel = win && win.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); } catch (e) {}
      const s = getState();
      const preview = {
        id: PREVIEW_ID, anchor: anchor, body: '',
        createdAt: '1970-01-01T00:00:00.000Z', author: null
      };
      const previewState = {
        schemaVersion: s.schemaVersion, docId: s.docId, docTitle: s.docTitle,
        comments: (s.comments || []).concat([preview])
      };
      try { highlightApi.paintHighlights(rootNode, previewState, {}); previewShown = true; } catch (e) {}
    }

    /** Remove the preview highlight, restoring the real highlights. */
    function clearAnchorPreview() {
      if (!previewShown) return;
      previewShown = false;
      repaintHighlights();
    }

    function openPopover(o) {
      closePopover();
      editingId = o.id || null;
      // Indicate WHICH passage is being commented by highlighting it in the
      // document itself (rather than re-quoting it inside the dialog).
      showAnchorPreview(o);
      popover = doc.createElement('div');
      popover.className = 'nb-popover';
      popover.setAttribute(UI_ATTR, 'popover');
      popover.innerHTML =
        '<div class="nb-pop-handle" title="Drag to move"></div>' +
        '<textarea placeholder="Add a comment…"></textarea>' +
        '<div class="nb-pop-actions">' +
        '  <button type="button" class="nb-link nb-cancel">Cancel</button>' +
        '  <button type="button" class="nb-btn nb-savecomment">Save</button>' +
        '</div>';
      const ta = popover.querySelector('textarea');
      ta.value = o.body || '';
      uiRoot.appendChild(popover);

      positionPopover(o.rect);
      // Origin-aware grow (menu-dropdown): reflow, then flip to .is-open so the
      // popover scales up from the edge nearest the trigger.
      void popover.offsetWidth;
      popover.classList.add('is-open');

      enablePopoverDrag(popover.querySelector('.nb-pop-handle'));
      popover.querySelector('.nb-cancel').addEventListener('click', closePopover);
      popover.querySelector('.nb-savecomment').addEventListener('click', function () {
        commitPopover(o.anchor, ta.value);
      });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commitPopover(o.anchor, ta.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePopover();
        }
      });
      // Focus after layout.
      const focus = function () { try { ta.focus(); } catch (e) {} };
      if (win && win.requestAnimationFrame) win.requestAnimationFrame(focus); else focus();
    }

    /**
     * Place the composer so it doesn't cover the selected passage when possible:
     * prefer just BELOW the selection, flip ABOVE if there isn't room, and only
     * if the selection is too tall to clear either way fall back to the side with
     * more room (clamped on-screen). The user can still drag it via the handle.
     */
    function positionPopover(rect) {
      const vw = (win && win.innerWidth) || 1024;
      const vh = (win && win.innerHeight) || 768;
      const w = popover.offsetWidth || 312;
      const h = popover.offsetHeight || 170;
      const gap = 10;
      const margin = 8;

      // Horizontal: align near the selection's left edge, clamped on-screen.
      let left = rect ? rect.left : (vw - w) / 2;
      if (left + w + margin > vw) left = vw - w - margin;
      if (left < margin) left = margin;

      // Vertical: keep clear of the selection's [top, bottom] band.
      const selTop = rect ? rect.top : vh / 2;
      const selBottom = rect ? rect.bottom : vh / 2;
      const roomBelow = vh - selBottom - gap;
      const roomAbove = selTop - gap;
      let top;
      let above = false;
      if (roomBelow >= h + margin) {
        top = selBottom + gap;                 // below the selection (preferred)
      } else if (roomAbove >= h + margin) {
        top = selTop - h - gap;                // above the selection
        above = true;
      } else if (roomAbove > roomBelow) {
        top = margin;                          // selection too tall: hug the top
        above = true;
      } else {
        top = Math.max(margin, vh - h - margin); // hug the bottom
      }

      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      // Grow from the edge nearest the selection: placed below → top origin.
      popover.setAttribute('data-origin', above ? 'bottom-center' : 'top-center');
    }

    /**
     * Let the user grab the handle and slide the composer aside so it doesn't
     * cover the passage being commented. The popover is position:fixed, so we
     * drag in viewport coordinates (getBoundingClientRect), clamped on-screen.
     */
    function enablePopoverDrag(handle) {
      if (!handle) return;
      let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, dragging = false;

      const onMove = function (e) {
        if (!dragging || !popover) return;
        const vw = (win && win.innerWidth) || 1024;
        const vh = (win && win.innerHeight) || 768;
        const w = popover.offsetWidth || 312;
        const h = popover.offsetHeight || 160;
        let nx = baseLeft + (e.clientX - startX);
        let ny = baseTop + (e.clientY - startY);
        nx = Math.max(8, Math.min(nx, vw - w - 8));
        ny = Math.max(8, Math.min(ny, vh - h - 8));
        popover.style.left = nx + 'px';
        popover.style.top = ny + 'px';
      };

      const onUp = function () {
        dragging = false;
        if (popover) popover.classList.remove('nb-dragging');
        doc.removeEventListener('mousemove', onMove, true);
        doc.removeEventListener('mouseup', onUp, true);
      };

      handle.addEventListener('mousedown', function (e) {
        if (!popover) return;
        e.preventDefault();
        const r = popover.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        baseLeft = r.left; baseTop = r.top;
        dragging = true;
        popover.classList.add('nb-dragging');
        doc.addEventListener('mousemove', onMove, true);
        doc.addEventListener('mouseup', onUp, true);
      });
    }

    async function commitPopover(anchor, body) {
      const text = String(body == null ? '' : body).trim();
      if (text === '') {
        // Empty body on create = discard; on edit = treat as no-op keep-open.
        if (!editingId) { closePopover(); return; }
      }
      let s = getState();
      if (!s) return;
      if (editingId) {
        s = stateApi.editComment(s, editingId, { body: text });
      } else {
        s = stateApi.addComment(s, { anchor: anchor, body: text });
      }
      setState(s);
      // Comments persist as DATA from state.comments (set above, before persist),
      // and the per-draft history snapshot is captured CLEAN via
      // snapshotCapture.captureCleanDoc — it clones the doc and strips every
      // <mark> wrapper, so the capture is paint-independent. The peek re-paints
      // highlights from the stored comment data at view time. This repaint is
      // therefore just the visual refresh — drop the compose-time preview and
      // show the committed highlight — and its position relative to persist()
      // carries no correctness requirement.
      clearAnchorPreview();
      repaintHighlights();
      await persist(s);
      closePopover();
      clearSelection();
      renderSidebar();
      onChange(s);
    }

    function closePopover() {
      const node = popover;
      popover = null;
      editingId = null;
      // Restore real highlights (drop the "being-commented" preview).
      clearAnchorPreview();
      if (!node) return;
      // Animate out (menu-dropdown closing), then remove. The reference is
      // detached first so the overlay already treats the editor as closed.
      node.classList.remove('is-open');
      node.classList.add('is-closing');
      const remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
      const ms = reduceMotion() ? 0 : POPOVER_CLOSE_MS;
      if (ms && win && win.setTimeout) win.setTimeout(remove, ms);
      else remove();
    }

    function clearSelection() {
      try {
        const sel = win ? win.getSelection() : null;
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      } catch (e) {}
      hideFab();
    }

    /* ------------------------------------------------------------------- *
     * Sidebar rendering                                                   *
     * ------------------------------------------------------------------- */

    function renderSidebar() {
      const s = getState();
      const comments = (s && Array.isArray(s.comments)) ? s.comments : [];
      const text = computeDocText().text;

      const anchored = [];
      const orphans = [];
      const docLevel = [];
      comments.forEach(function (c) {
        if (!c) return;
        if (c.anchor == null) { docLevel.push(c); return; } // whole-document note
        const found = anchorApi.findAnchor(text, c.anchor);
        if (found) anchored.push(c); else orphans.push(c);
      });

      elCount.textContent = comments.length === 1 ? '1 comment' : comments.length + ' comments';
      elList.textContent = '';

      // Always offer a subtle way to comment on the whole document.
      elList.appendChild(renderDocComposer());

      if (comments.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'nb-empty';
        empty.innerHTML =
          '<strong>No notes yet</strong>' +
          'Select any text and click <b>Comment</b>, or add a note about the whole document above.';
        elList.appendChild(empty);
        renderVersions();
        updateLauncher();
        return;
      }

      anchored.forEach(function (c) { elList.appendChild(renderItem(c, 'anchored')); });

      if (docLevel.length > 0) {
        elList.appendChild(groupLabel('On the whole document'));
        docLevel.forEach(function (c) { elList.appendChild(renderItem(c, 'doc')); });
      }

      if (orphans.length > 0) {
        elList.appendChild(groupLabel('Unanchored (' + orphans.length + ')'));
        orphans.forEach(function (c) { elList.appendChild(renderItem(c, 'orphan')); });
      }

      renderVersions();
      updateLauncher();
    }

    /**
     * The "Versions" timeline group (docs/design.md \u00A714.4). It shows the
     * document's version history when there is earlier feedback:
     *   - 0 earlier versions  \u2192 render nothing (the group is hidden entirely).
     *   - exactly 1 earlier   \u2192 show it inline.
     *   - 2+ earlier          \u2192 show the MOST-RECENT earlier version inline and tuck
     *                           the rest under a "+N older versions" disclosure.
     * A "now" row (the current draft) sits at the top with no action buttons.
     * Version labels are ordinal by age: with N earlier versions (getHistory is
     * newest-first), the newest earlier entry is v{N}, the next v{N-1}, \u2026 oldest v1.
     */
    function renderVersions() {
      if (!history) return;
      const existing = elList.querySelector('.nb-versions');
      if (existing) existing.remove();
      const wrap = doc.createElement('div');
      wrap.className = 'nb-versions';
      wrap.setAttribute(UI_ATTR, 'versions');
      elList.appendChild(wrap);
      Promise.resolve(history.getHistory()).then(function (versions) {
        // Collapse rule: 0 earlier versions \u2192 the group is not rendered at all.
        if (!versions || versions.length === 0) { wrap.remove(); return; }

        const label = doc.createElement('div');
        label.className = 'nb-group-label';
        label.textContent = 'Versions';
        wrap.appendChild(label);

        // The "now" row: the live draft, no actions, status dot active.
        wrap.appendChild(renderNowRow());

        const total = versions.length; // earlier versions, newest-first
        // The most-recent earlier version always stays inline.
        wrap.appendChild(renderVersionRow(versions[0], total));

        if (total >= 2) {
          // 2+ earlier versions \u2192 collapse indices 1..end under a disclosure.
          const rest = doc.createElement('div');
          rest.className = 'nb-ver-rest';
          rest.setAttribute(UI_ATTR, 'versions-rest');
          rest.hidden = true;
          for (let i = 1; i < total; i++) {
            rest.appendChild(renderVersionRow(versions[i], total - i));
          }
          const disclose = doc.createElement('button');
          disclose.type = 'button';
          disclose.className = 'nb-disclose';
          disclose.setAttribute(UI_ATTR, 'versions-disclose');
          const chev = doc.createElement('span');
          chev.className = 'nb-disclose-chev';
          chev.textContent = '\u203A'; // \u203A
          const dlabel = doc.createElement('span');
          dlabel.className = 'nb-disclose-label';
          const remaining = total - 1;
          const moreLabel = '+' + remaining + ' older version' + (remaining === 1 ? '' : 's');
          dlabel.textContent = moreLabel;
          disclose.appendChild(chev);
          disclose.appendChild(dlabel);
          // Toggle: reveal/hide the collapsed rows and flip the chevron (CSS
          // rotates it on .nb-open). The button stays visible in both states.
          disclose.addEventListener('click', function () {
            const open = rest.hidden; // about to open if currently hidden
            rest.hidden = !open;
            disclose.classList.toggle('nb-open', open);
            dlabel.textContent = open ? 'Fewer versions' : moreLabel;
          });
          wrap.appendChild(disclose);
          wrap.appendChild(rest);
        }
      });
    }

    /** The current-draft "now" row. No actions; status dot active. */
    function renderNowRow() {
      const s = getState();
      const count = (s && Array.isArray(s.comments)) ? s.comments.length : 0;
      const row = doc.createElement('div');
      row.className = 'nb-ver-row active';
      row.setAttribute(UI_ATTR, 'version-now');
      const line = doc.createElement('div');
      line.className = 'nb-ver-line';
      const dot = doc.createElement('span');
      dot.className = 'nb-ver-dot';
      const name = doc.createElement('span');
      name.className = 'nb-ver-name';
      name.textContent = 'now';
      const spacer = doc.createElement('span');
      spacer.className = 'nb-ver-spacer';
      const here = doc.createElement('span');
      here.className = 'nb-ver-here';
      here.textContent = 'you are here';
      const cnt = doc.createElement('span');
      cnt.className = 'nb-ver-count';
      cnt.textContent = String(count);
      line.appendChild(dot);
      line.appendChild(name);
      line.appendChild(spacer);
      line.appendChild(here);
      line.appendChild(cnt);
      row.appendChild(line);
      return row;
    }

    /**
     * One earlier-version row: dot, v-label, time, count, and open + copy-feedback
     * actions. Clicking ANYWHERE on the row (line or the actions strip's empty
     * space) peeks the snapshot; the open / copy-feedback buttons stopPropagation
     * so a button click runs only its own action and doesn't also peek.
     * @param {Object} d      a getHistory() entry
     * @param {number} ordinal the v-number (oldest = 1)
     */
    function renderVersionRow(d, ordinal) {
      const row = doc.createElement('div');
      row.className = 'nb-ver-row';
      row.setAttribute(UI_ATTR, 'version');
      row.setAttribute('data-version-key', d.versionKey || '');

      const line = doc.createElement('div');
      line.className = 'nb-ver-line';
      const dot = doc.createElement('span');
      dot.className = 'nb-ver-dot';
      const name = doc.createElement('span');
      name.className = 'nb-ver-name';
      name.textContent = 'v' + ordinal;
      const meta = doc.createElement('span');
      meta.className = 'nb-ver-meta';
      meta.textContent = formatWhen(d.lastEditedAt || d.createdAt);
      const spacer = doc.createElement('span');
      spacer.className = 'nb-ver-spacer';
      const cnt = doc.createElement('span');
      cnt.className = 'nb-ver-count';
      cnt.textContent = String((d.comments && d.comments.length) || 0);
      line.appendChild(dot);
      line.appendChild(name);
      line.appendChild(meta);
      line.appendChild(spacer);
      line.appendChild(cnt);
      row.appendChild(line);

      const acts = doc.createElement('div');
      acts.className = 'nb-ver-actions';
      const open = doc.createElement('button');
      open.type = 'button';
      open.className = 'nb-ver-btn nb-ver-open';
      open.textContent = 'open';
      if (!d.hasSnapshot) {
        // Pruned snapshot (design state C): the heavy snapshot is evicted, so
        // there is nothing to open \u2014 but the feedback survives, so copy still works.
        open.disabled = true;
        open.title = 'Snapshot no longer stored';
      } else {
        open.addEventListener('click', function (e) { e.stopPropagation(); openVersionTab(d.versionKey); });
      }
      const copy = doc.createElement('button');
      copy.type = 'button';
      copy.className = 'nb-ver-btn nb-ver-copy';
      copy.textContent = 'copy feedback';
      copy.addEventListener('click', function (e) { e.stopPropagation(); copyVersionFeedback(d); });
      acts.appendChild(open);
      acts.appendChild(copy);
      row.appendChild(acts);
      // Peek lives on the whole row, so clicking the line OR the actions strip's
      // empty space opens the snapshot; the buttons' stopPropagation keeps a
      // button click from also peeking.
      row.addEventListener('click', function () { openVersionPeek(d.versionKey); });
      return row;
    }

    /** Export one earlier version's feedback as markdown, to the clipboard. */
    async function copyVersionFeedback(d) {
      const versionState = { docTitle: d.docTitle || '', comments: (d.comments || []).slice() };
      let md = null;
      if (markdownApi && typeof markdownApi.toMarkdown === 'function') {
        md = markdownApi.toMarkdown(versionState, {});
      } else if (renderMd) {
        md = renderMd(versionState);
      }
      if (md == null) { toast('Markdown unavailable'); return; }
      const ok = await copyToClipboard(md);
      if (ok) toast('Copied feedback as Markdown', { success: true });
      else toast('Copy failed \u2014 select & copy manually');
    }

    /**
     * Peek a past version: parse its clean-document snapshot, run the LIVE
     * highlight painter over it (so the commented passages are wrapped in the
     * same `<mark class="noteback-highlight">` the live doc uses), and show the
     * result in the snapshot modal (iframe srcdoc). A "\u2190 Back to current" banner
     * at the top of the panel returns to the live document (same as the \u2715 /
     * backdrop click). Pruned snapshots (html === '') are a no-op.
     */
    function openVersionPeek(versionKey) {
      Promise.resolve(history.getVersion({ versionKey: versionKey })).then(function (v) {
        if (!v || !v.html) return; // pruned \u2014 nothing to peek

        // Parse the snapshot and paint REAL highlights into it via the live
        // painter. paintHighlights creates each <mark> with the parsed doc's own
        // ownerDocument (wrapRange uses nodes[0].ownerDocument), so the marks land
        // inside `parsed` and survive serialization below. A pruned/odd snapshot
        // must not break the peek, hence the guard.
        let painted = '<!DOCTYPE html>' + v.html;
        try {
          const parsed = new DOMParser().parseFromString(v.html, 'text/html');
          try {
            highlightApi.paintHighlights(parsed.body, { schemaVersion: 1, comments: v.comments || [] }, {});
          } catch (e) { /* keep the un-highlighted snapshot */ }
          // Scroll the first highlight into view once the iframe loads.
          const scrollScript =
            '<scr' + 'ipt>(function(){var m=document.querySelector("mark.noteback-highlight");' +
            'if(m)m.scrollIntoView({block:"center"});})();</scr' + 'ipt>';
          painted = '<!DOCTYPE html>' + parsed.documentElement.outerHTML + scrollScript;
        } catch (e) { /* DOMParser unavailable \u2014 fall back to the raw snapshot */ }

        const back = doc.createElement('div');
        back.className = 'nb-hist-backdrop';
        back.setAttribute(UI_ATTR, 'version-peek');
        const panel = doc.createElement('div');
        panel.className = 'nb-hist-panel';
        const close = doc.createElement('button');
        close.type = 'button'; close.className = 'nb-hist-close'; close.textContent = '\u2715';
        close.addEventListener('click', function () { back.remove(); });
        back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
        // "\u2190 Back to current" banner \u2014 an obvious clickable control that closes the
        // peek and returns to the live document. (Locked wording: "Back to current".)
        const backBar = doc.createElement('button');
        backBar.type = 'button';
        backBar.className = 'nb-hist-back';
        backBar.setAttribute(UI_ATTR, 'version-peek-back');
        backBar.textContent = '\u2190 Back to current';
        backBar.addEventListener('click', function () { back.remove(); });
        const frame = doc.createElement('iframe');
        frame.className = 'nb-hist-frame';
        frame.srcdoc = painted; // the snapshot with live highlights painted in
        panel.appendChild(close);
        panel.appendChild(backBar);
        panel.appendChild(frame);
        back.appendChild(panel); uiRoot.appendChild(back);
      });
    }

    /**
     * Build a REAL annotatable canvas of a past version, as an HTML string.
     *
     * Factored out of openVersionTab so the e2e can assert on the produced HTML
     * without driving window.open. Primary path (the current page is itself a
     * canvas \u2014 embedded mode, or the extension running on a canvas): clone the
     * CURRENT live document (keeping its inlined runtime + styles + template),
     * strip Noteback's own UI + any live highlights, swap in the snapshot's
     * doc-content, and re-seed the #noteback-state block with the version's
     * comments. Opening the result boots a working canvas of that version.
     *
     * @param {Object} v        getVersion() result: { html, comments, docTitle, contentHash }
     * @param {string} docId    the current page's baked doc-id
     * @param {string} docTitle title for the version's state block
     * @returns {string} a full canvas HTML document
     */
    function buildVersionCanvasHtml(v, docId, docTitle) {
      // Snapshot's doc-content inner HTML (its #noteback-doc-root if present, else body).
      const parsed = new DOMParser().parseFromString(v.html, 'text/html');
      const snapRoot = parsed.querySelector('#noteback-doc-root') || parsed.body;
      const snapInner = snapRoot ? snapRoot.innerHTML : '';

      // Clone the CURRENT live document \u2014 it carries the inlined runtime, the
      // canvas template wrapper, and the page styles, which is what makes the
      // opened tab a working annotatable canvas.
      const clone = document.documentElement.cloneNode(true);

      // Strip Noteback's own UI from the clone (sidebar host, launcher, fab, our
      // injected <style>, any open peek modal). The inlined runtime <script> is
      // NOT a [data-noteback-ui] node, so it survives \u2014 that's deliberate.
      const ui = clone.querySelectorAll('[' + UI_ATTR + ']');
      for (let i = 0; i < ui.length; i++) {
        if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]);
      }
      // Unwrap any live highlight <mark>s left in the clone so we start clean
      // (the snapshot content we inject below replaces the doc-root anyway, but
      // be defensive in case the clone's root is reused).
      const liveMarks = clone.querySelectorAll('mark.' + (highlightApi && highlightApi.HIGHLIGHT_CLASS || 'noteback-highlight'));
      for (let i = 0; i < liveMarks.length; i++) {
        const m = liveMarks[i];
        const p = m.parentNode;
        if (!p) continue;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      }

      // Swap in the snapshot's doc-content.
      const cloneRoot = clone.querySelector('#noteback-doc-root');
      if (cloneRoot) cloneRoot.innerHTML = snapInner;

      // Re-seed the machine-readable state block with the version's comments.
      // The JSON lands in a <script> element's textContent and is then serialized
      // via outerHTML, which emits raw-text VERBATIM (it does NOT escape
      // </script>). A comment body or docTitle containing "</script>" would break
      // out of the state block, truncating the JSON and making any trailing
      // markup live in the opened tab (self-XSS). Escape exactly as the canonical
      // exporter does (escapeForJsonScript): "<\/script" serializes verbatim and
      // JSON.parse reads "\/" back as "/", so the comment round-trips intact.
      const stateEl = clone.querySelector('#noteback-state');
      if (stateEl) {
        const stateJson = JSON.stringify({
          schemaVersion: 1,
          docId: docId || '',
          docTitle: docTitle || '',
          comments: v.comments || []
        });
        stateEl.textContent = stateJson.replace(/<\/(script)/gi, '<\\/$1');
      }

      return '<!DOCTYPE html>\n' + clone.outerHTML;
    }

    /**
     * Checkout: open a past version as a real, live, annotatable canvas tab.
     * Pruned snapshots (html === '') are a no-op.
     *
     * Primary path: the clone-based builder above (works when the current page is
     * a canvas with the inlined runtime \u2014 embedded mode and the extension on a
     * canvas). Falls back to opening the bare clean snapshot when the build fails
     * or the current page isn't a canvas (see the fidelity note below).
     */
    function openVersionTab(versionKey) {
      Promise.resolve(history.getVersion({ versionKey: versionKey })).then(function (v) {
        if (!v || !v.html) return; // pruned \u2014 nothing to open
        let html = null;
        // Build a working canvas only when the current page IS a canvas (it has a
        // baked doc-root + the inlined runtime). Otherwise we can't clone a runtime.
        const rootEl = document.getElementById('noteback-doc-root');
        const stateEl = document.getElementById('noteback-state');
        const isCanvas = !!(rootEl && stateEl);
        if (isCanvas) {
          try {
            const docId = (rootEl.getAttribute && rootEl.getAttribute('data-noteback-doc-id')) || '';
            const docTitle = v.docTitle || document.title || '';
            html = buildVersionCanvasHtml(v, docId, docTitle);
          } catch (e) { html = null; }
        }
        // Extension non-canvas fallback (a page Noteback didn't author \u2014 no inlined
        // runtime in this document). Best-effort: open the bare clean snapshot, a
        // readable but NON-annotatable view. The design's Risk \u00a7Fidelity accepts
        // this. (A full canvas build here would need the runtime + template via
        // chrome.runtime.getURL + exporter.buildCanvasHtml; deferred \u2014 TODO.)
        if (html == null) html = '<!DOCTYPE html>\n' + v.html;
        try {
          const blob = new Blob([html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          if (win && typeof win.open === 'function') win.open(url, '_blank');
        } catch (e) { toast('Could not open version'); }
      });
    }

    function formatWhen(iso) {
      if (!iso) return 'earlier';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return 'earlier';
      return d.toLocaleString();
    }

    function groupLabel(textValue) {
      const label = doc.createElement('div');
      label.className = 'nb-group-label';
      label.textContent = textValue;
      return label;
    }

    /* --- whole-document note composer (inline, top of the list) --------- */

    function renderDocComposer() {
      const wrap = doc.createElement('div');
      wrap.className = 'nb-doc-composer';
      if (!docComposerOpen) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'nb-add-doc';
        btn.textContent = '＋ Add a note about the whole document';
        btn.addEventListener('click', function () {
          docComposerOpen = true;
          docComposerDraft = '';
          renderSidebar();
          focusDocComposer();
        });
        wrap.appendChild(btn);
        return wrap;
      }
      const ta = doc.createElement('textarea');
      ta.className = 'nb-doc-ta';
      ta.placeholder = 'A note about the whole document…';
      ta.value = docComposerDraft;
      ta.addEventListener('input', function () { docComposerDraft = ta.value; });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commitDocComment(ta.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          docComposerOpen = false;
          docComposerDraft = '';
          renderSidebar();
        }
      });
      const actions = doc.createElement('div');
      actions.className = 'nb-pop-actions';
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.className = 'nb-link';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () {
        docComposerOpen = false;
        docComposerDraft = '';
        renderSidebar();
      });
      const save = doc.createElement('button');
      save.type = 'button';
      save.className = 'nb-btn nb-savedoc';
      save.textContent = 'Save note';
      save.addEventListener('click', function () { commitDocComment(ta.value); });
      actions.appendChild(cancel);
      actions.appendChild(save);
      wrap.appendChild(ta);
      wrap.appendChild(actions);
      return wrap;
    }

    function focusDocComposer() {
      const ta = elList.querySelector('.nb-doc-ta');
      if (!ta) return;
      const f = function () { try { ta.focus(); } catch (e) {} };
      if (win && win.requestAnimationFrame) win.requestAnimationFrame(f); else f();
    }

    async function commitDocComment(body) {
      const text = String(body == null ? '' : body).trim();
      if (text === '') { docComposerOpen = false; docComposerDraft = ''; renderSidebar(); return; }
      let s = getState();
      if (!s) return;
      s = stateApi.addComment(s, { anchor: null, body: text });
      setState(s);
      await persist(s);
      docComposerOpen = false;
      docComposerDraft = '';
      renderSidebar();
      onChange(s);
    }

    function renderItem(c, kind) {
      const isOrphan = kind === 'orphan';
      const isDoc = kind === 'doc';
      const item = doc.createElement('div');
      item.className = 'nb-item' + (isOrphan ? ' nb-orphan' : '') + (isDoc ? ' nb-doc' : '');
      item.setAttribute('data-id', c.id);

      if (isDoc) {
        const tag = doc.createElement('span');
        tag.className = 'nb-doc-tag';
        tag.textContent = '🗎 Whole document';
        item.appendChild(tag);
      } else {
        const quote = doc.createElement('span');
        quote.className = 'nb-quote';
        quote.textContent = '“' + truncate((c.anchor && c.anchor.quote) || '', 160) + '”';
        if (!isOrphan) {
          quote.title = 'Jump to highlight';
          quote.addEventListener('click', function () { focusComment(c.id); });
        }
        item.appendChild(quote);
      }

      const body = doc.createElement('p');
      body.className = 'nb-body';
      body.textContent = c.body || '';
      item.appendChild(body);

      const actions = doc.createElement('div');
      actions.className = 'nb-actions';
      const edit = doc.createElement('button');
      edit.type = 'button';
      edit.className = 'nb-link';
      edit.textContent = 'Edit';
      edit.addEventListener('click', function () { editInline(c); });
      const del = doc.createElement('button');
      del.type = 'button';
      del.className = 'nb-link nb-danger';
      del.textContent = 'Delete';
      del.addEventListener('click', function () { removeComment(c.id); });
      actions.appendChild(edit);
      actions.appendChild(del);
      item.appendChild(actions);

      return item;
    }

    function focusComment(id) {
      if (highlightApi && typeof highlightApi.focusHighlight === 'function') {
        highlightApi.focusHighlight(rootNode, id);
      }
      // Highlight the matching sidebar item briefly.
      const items = elList.querySelectorAll('.nb-item');
      for (let i = 0; i < items.length; i++) {
        items[i].classList.toggle('nb-active', items[i].getAttribute('data-id') === id);
      }
    }

    function editInline(c) {
      // Open the popover positioned near the sidebar item for editing.
      const rect = { left: ((win && win.innerWidth) || 1024) - 360, top: 90, bottom: 90 };
      openPopover({ anchor: c.anchor, body: c.body || '', id: c.id, rect: rect });
    }

    async function removeComment(id) {
      let s = getState();
      if (!s) return;
      s = stateApi.deleteComment(s, id);
      setState(s);
      await persist(s);
      renderSidebar();
      onChange(s);
    }

    /* ------------------------------------------------------------------- *
     * Export hooks                                                         *
     * ------------------------------------------------------------------- */

    async function copyMarkdown() {
      const s = getState();
      if (exporter && typeof exporter.onCopyMarkdown === 'function') {
        try {
          await exporter.onCopyMarkdown(s);
          toast('Copied feedback as Markdown', { success: true });
        } catch (e) {
          toast('Copy failed');
        }
        return;
      }
      // Default embedded-mode behaviour: render + Clipboard API.
      if (!renderMd) { toast('Markdown unavailable'); return; }
      const md = renderMd(s);
      const ok = await copyToClipboard(md);
      if (ok) toast('Copied feedback as Markdown', { success: true });
      else toast('Copy failed — select & copy manually');
    }

    function copyHtmlCanvas() { return copyHtml(false); }
    function copyHtmlClean() { return copyHtml(true); }

    // "Copy html" — the same artifacts as the Save menu, to the clipboard.
    // The hook returns the HTML string; we do the clipboard write here so both
    // runtime modes share one path (incl. the file:// execCommand fallback).
    async function copyHtml(clean) {
      const s = getState();
      if (exporter && typeof exporter.onCopyHtml === 'function') {
        try {
          const html = await exporter.onCopyHtml(s, { clean: clean });
          const ok = await copyToClipboard(html);
          if (ok) toast(clean ? 'Copied clean HTML' : 'Copied HTML with feedback', { success: true });
          else toast('Copy failed — select & copy manually');
        } catch (e) {
          toast('Copy failed');
        }
        return;
      }
      toast(clean ? 'Clean HTML copy needs the extension or saved canvas.'
                  : 'HTML copy needs the extension or saved canvas.');
    }

    async function saveCanvas() {
      const s = getState();
      if (exporter && typeof exporter.onSaveCanvas === 'function') {
        try {
          await exporter.onSaveCanvas(s);
          toast('Saving HTML with comments…');
        } catch (e) {
          toast('Save failed');
        }
        return;
      }
      toast('Saving the canvas is only available with the extension here.');
    }

    // "HTML · clean copy" — the original document with all Noteback stripped.
    async function saveClean() {
      const s = getState();
      if (exporter && typeof exporter.onSaveClean === 'function') {
        try {
          await exporter.onSaveClean(s);
          toast('Saving clean HTML…');
        } catch (e) {
          toast('Save failed');
        }
        return;
      }
      toast('Clean HTML export is available in the saved canvas.');
    }

    // "PDF" — print to PDF. The @media print rules (BUTTON_CSS) hide all Noteback
    // UI and neutralize highlights, so the printout is the clean document. Print is
    // universally available, so this works in every mode; the hook is an override.
    function savePdf() {
      if (exporter && typeof exporter.onSavePdf === 'function') {
        try { exporter.onSavePdf(getState()); return; } catch (e) { /* fall through */ }
      }
      if (win && typeof win.print === 'function') {
        try { win.print(); } catch (e) { toast('Printing unavailable here'); }
      } else {
        toast('Printing unavailable here');
      }
    }

    async function copyToClipboard(textValue) {
      try {
        if (win && win.navigator && win.navigator.clipboard && win.isSecureContext) {
          await win.navigator.clipboard.writeText(textValue);
          return true;
        }
      } catch (e) { /* fall through to execCommand */ }
      try {
        const ta = doc.createElement('textarea');
        ta.setAttribute(UI_ATTR, 'clip');
        ta.value = textValue;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        (doc.body || doc.documentElement).appendChild(ta);
        ta.focus();
        ta.select();
        const ok = doc.execCommand && doc.execCommand('copy');
        ta.remove();
        return !!ok;
      } catch (e) {
        return false;
      }
    }

    /* ------------------------------------------------------------------- *
     * Toast                                                               *
     * ------------------------------------------------------------------- */

    let toastEl = null;
    let toastTimer = null;
    function ensureToast() {
      if (toastEl) return;
      toastEl = doc.createElement('div');
      toastEl.className = 'nb-toast';
      toastEl.innerHTML =
        '<span class="nb-toast-check" data-state="out" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 6.5"/></svg>' +
        '</span><span class="nb-toast-msg"></span>';
      uiRoot.appendChild(toastEl);
    }
    /** Show a transient toast. `opts.success` draws a celebratory check (success-check). */
    function toast(msg, opts) {
      opts = opts || {};
      ensureToast();
      toastEl.querySelector('.nb-toast-msg').textContent = msg;
      const check = toastEl.querySelector('.nb-toast-check');
      if (opts.success) {
        toastEl.classList.add('nb-has-check');
        check.setAttribute('data-state', 'out');
        void check.offsetWidth; // reflow so the stroke draw replays from offset 0
        check.setAttribute('data-state', 'in');
      } else {
        toastEl.classList.remove('nb-has-check');
        check.setAttribute('data-state', 'out');
      }
      toastEl.classList.add('nb-show');
      if (toastTimer && win) win.clearTimeout(toastTimer);
      const to = (win && win.setTimeout) || setTimeout;
      toastTimer = to(function () { toastEl.classList.remove('nb-show'); }, 2200);
    }

    /* ------------------------------------------------------------------- *
     * Sidebar open / close                                                *
     * ------------------------------------------------------------------- */

    function openSidebar() {
      renderSidebar();
      sidebar.classList.add('nb-open');
      launcher.classList.add('nb-hidden'); // sidebar has its own ✕ close
      playListReveal();
    }

    /**
     * Staggered settle for the comment list when the sidebar opens (texts-reveal).
     * The `.nb-reveal` arming class is removed once the run completes so ordinary
     * re-renders (typing in a composer, edit/delete) stay static — the reveal is
     * the one orchestrated moment, not a per-change effect.
     */
    function playListReveal() {
      if (reduceMotion()) return;
      const els = elList.querySelectorAll('.nb-item,.nb-group-label,.nb-empty');
      if (!els.length) return;
      elList.classList.remove('nb-reveal', 'nb-shown');
      for (let i = 0; i < els.length; i++) {
        els[i].style.transitionDelay = (Math.min(i, 9) * 42) + 'ms';
      }
      elList.classList.add('nb-reveal');
      void elList.offsetWidth; // reflow so the hidden base state applies first
      elList.classList.add('nb-shown');
      const total = 520 + Math.min(els.length, 9) * 42;
      const to = (win && win.setTimeout) || setTimeout;
      to(function () {
        elList.classList.remove('nb-reveal', 'nb-shown');
        for (let i = 0; i < els.length; i++) els[i].style.transitionDelay = '';
      }, total);
    }
    function closeSidebar() {
      closeSaveMenu();
      closeCopyMenu();
      sidebar.classList.remove('nb-open');
      launcher.classList.remove('nb-hidden');
    }
    function toggleSidebar() {
      if (sidebar.classList.contains('nb-open')) closeSidebar();
      else openSidebar();
    }

    /* ------------------------------------------------------------------- *
     * Save menu (footer dropdown: with-comments / clean / PDF)            *
     * ------------------------------------------------------------------- */

    let saveMenuOpen = false;
    let saveMenuCloseTimer = null;

    function openSaveMenu() {
      if (saveMenuOpen) return;
      closeCopyMenu();           // the two footer menus are mutually exclusive
      saveMenuOpen = true;
      if (saveMenuCloseTimer) {
        (win && win.clearTimeout ? win.clearTimeout : clearTimeout)(saveMenuCloseTimer);
        saveMenuCloseTimer = null;
      }
      saveMenu.classList.remove('is-closing');
      saveWrap.classList.add('nb-menu-open');
      saveBtn.setAttribute('aria-expanded', 'true');
      void saveMenu.offsetWidth; // reflow so the closed scale applies before growing
      saveMenu.classList.add('is-open');
    }

    function closeSaveMenu() {
      if (!saveMenuOpen) return;
      saveMenuOpen = false;
      saveWrap.classList.remove('nb-menu-open');
      saveBtn.setAttribute('aria-expanded', 'false');
      saveMenu.classList.remove('is-open');
      saveMenu.classList.add('is-closing');
      const settle = function () { saveMenu.classList.remove('is-closing'); saveMenuCloseTimer = null; };
      const ms = reduceMotion() ? 0 : POPOVER_CLOSE_MS;
      if (ms && win && win.setTimeout) saveMenuCloseTimer = win.setTimeout(settle, ms);
      else settle();
    }

    function toggleSaveMenu() {
      if (saveMenuOpen) closeSaveMenu();
      else openSaveMenu();
    }

    let copyMenuOpen = false;
    let copyMenuCloseTimer = null;

    function openCopyMenu() {
      if (copyMenuOpen) return;
      closeSaveMenu();           // the two footer menus are mutually exclusive
      copyMenuOpen = true;
      if (copyMenuCloseTimer) {
        (win && win.clearTimeout ? win.clearTimeout : clearTimeout)(copyMenuCloseTimer);
        copyMenuCloseTimer = null;
      }
      copyMenu.classList.remove('is-closing');
      copyWrap.classList.add('nb-menu-open');
      copyCaretBtn.setAttribute('aria-expanded', 'true');
      void copyMenu.offsetWidth; // reflow so the closed scale applies before growing
      copyMenu.classList.add('is-open');
    }

    function closeCopyMenu() {
      if (!copyMenuOpen) return;
      copyMenuOpen = false;
      copyWrap.classList.remove('nb-menu-open');
      copyCaretBtn.setAttribute('aria-expanded', 'false');
      copyMenu.classList.remove('is-open');
      copyMenu.classList.add('is-closing');
      const settle = function () { copyMenu.classList.remove('is-closing'); copyMenuCloseTimer = null; };
      const ms = reduceMotion() ? 0 : POPOVER_CLOSE_MS;
      if (ms && win && win.setTimeout) copyMenuCloseTimer = win.setTimeout(settle, ms);
      else settle();
    }

    function toggleCopyMenu() {
      if (copyMenuOpen) closeCopyMenu();
      else openCopyMenu();
    }

    /* ------------------------------------------------------------------- *
     * Persistence helper                                                  *
     * ------------------------------------------------------------------- */

    async function persist(s) {
      if (adapter && typeof adapter.save === 'function') {
        try { await adapter.save(s); } catch (e) { /* best-effort */ }
      }
    }

    /* ------------------------------------------------------------------- *
     * Wiring + lifecycle                                                  *
     * ------------------------------------------------------------------- */

    const onSelChange = function () { onSelectionChange(); };
    const onScrollOrResize = function () {
      if (fab.style.display !== 'none') hideFab();
    };
    // The comment composer is intentionally NOT dismissed by clicking outside it
    // (only Cancel / Save / Escape close it), so a stray click can't discard an
    // in-progress note. Outside-click-to-close applies to the sidebar only.

    /**
     * Clicking outside the sidebar dismisses it. Uses `click` (not mousedown) and
     * skips when a text selection is in progress, so selecting passages to comment
     * never closes the panel. Also ignores our own UI, highlight clicks (those
     * focus a comment instead), and any click while the composer is open.
     */
    const onDocClickOutside = function (e) {
      if (!sidebar.classList.contains('nb-open')) return;
      if (popover) return; // don't close the panel out from under an open composer
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      if (path.indexOf(host) !== -1 || path.indexOf(fab) !== -1) return; // our UI
      const t = e.target;
      const hlClass = highlightApi ? highlightApi.HIGHLIGHT_CLASS : 'noteback-highlight';
      if (t && t.closest && t.closest('mark.' + hlClass)) return; // highlight → focus
      const sel = win ? win.getSelection() : null;
      if (sel && !sel.isCollapsed && String(sel).trim() !== '') return; // mid-selection
      closeSidebar();
    };

    // Re-anchor the debounce to the moment the user releases the selection, so
    // the chip appears a beat *after* they finish dragging — never mid-drag —
    // and its pop-in is clearly seen. Skip if released on the chip itself, or
    // while the editor is open.
    const onDocMouseUp = function (e) {
      if (popover) return;
      const t = e.target;
      if (t === fab || (t && t.closest && t.closest('.noteback-fab'))) return;
      if (pendingAnchor && pendingFabRect && fab.style.display === 'none') scheduleFab();
    };

    doc.addEventListener('selectionchange', onSelChange);
    if (win) {
      win.addEventListener('scroll', onScrollOrResize, true);
      win.addEventListener('resize', onScrollOrResize);
    }
    doc.addEventListener('mouseup', onDocMouseUp);

    // Clicking a painted highlight in the doc opens + focuses its sidebar entry.
    const onDocClick = function (e) {
      const t = e.target;
      if (t && t.nodeType === 1 && t.closest) {
        const mark = t.closest('mark.' + (highlightApi ? highlightApi.HIGHLIGHT_CLASS : 'noteback-highlight'));
        if (mark) {
          const id = mark.getAttribute(highlightApi ? highlightApi.ID_ATTR : 'data-noteback-id');
          if (id) {
            openSidebar();
            focusComment(id);
          }
        }
      }
    };
    doc.addEventListener('click', onDocClick);
    doc.addEventListener('click', onDocClickOutside);

    // The save menu closes on any click outside its wrapper (the Save button +
    // dropdown). The Save button stops propagation, so its own toggling click
    // never reaches here; menu-item clicks already closed it.
    const onDocClickSaveMenu = function (e) {
      if (!saveMenuOpen) return;
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      if (path.indexOf(saveWrap) !== -1) return;
      closeSaveMenu();
    };
    // Escape closes the save menu and returns focus to its button.
    const onDocKeydownSaveMenu = function (e) {
      if (e.key === 'Escape' && saveMenuOpen) {
        closeSaveMenu();
        if (saveBtn && saveBtn.focus) saveBtn.focus();
      }
    };
    // The copy menu closes on any click outside its wrapper; the caret stops
    // propagation so its own toggle click never reaches here.
    const onDocClickCopyMenu = function (e) {
      if (!copyMenuOpen) return;
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      if (path.indexOf(copyWrap) !== -1) return;
      closeCopyMenu();
    };
    const onDocKeydownCopyMenu = function (e) {
      if (e.key === 'Escape' && copyMenuOpen) {
        closeCopyMenu();
        if (copyCaretBtn && copyCaretBtn.focus) copyCaretBtn.focus();
      }
    };
    doc.addEventListener('click', onDocClickCopyMenu);
    doc.addEventListener('keydown', onDocKeydownCopyMenu);
    doc.addEventListener('click', onDocClickSaveMenu);
    doc.addEventListener('keydown', onDocKeydownSaveMenu);

    // Initial render so the sidebar reflects loaded state when first opened.
    renderSidebar();

    function destroy() {
      doc.removeEventListener('selectionchange', onSelChange);
      if (win) {
        win.removeEventListener('scroll', onScrollOrResize, true);
        win.removeEventListener('resize', onScrollOrResize);
      }
      doc.removeEventListener('mouseup', onDocMouseUp);
      doc.removeEventListener('click', onDocClick);
      doc.removeEventListener('click', onDocClickOutside);
      doc.removeEventListener('click', onDocClickSaveMenu);
      doc.removeEventListener('keydown', onDocKeydownSaveMenu);
      doc.removeEventListener('click', onDocClickCopyMenu);
      doc.removeEventListener('keydown', onDocKeydownCopyMenu);
      doc.removeEventListener('keydown', onDocKeydownInfo);
      cancelFabTimer();
      closePopover();
      if (fab.parentNode) fab.parentNode.removeChild(fab);
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    async function refresh() {
      if (adapter && typeof adapter.load === 'function') {
        const loaded = await adapter.load();
        if (loaded) setState(loaded);
      }
      renderSidebar();
    }

    return {
      destroy: destroy,
      refresh: refresh,
      renderSidebar: renderSidebar,
      toggleSidebar: toggleSidebar,
      openSidebar: openSidebar,
      closeSidebar: closeSidebar,
      copyMarkdown: copyMarkdown,
      saveCanvas: saveCanvas,
      saveClean: saveClean,
      savePdf: savePdf,
      focusComment: focusComment
    };
  }

  /* helpers ------------------------------------------------------------- */

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  return { mountOverlay: mountOverlay };
});
