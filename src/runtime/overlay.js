/**
 * Noteback runtime — overlay.js  (DOM-ONLY; browser global)
 *
 * Responsibility: the mode-agnostic annotation UI —
 *   - floating "💬 Comment" button that appears on text selection,
 *   - comment popover (textarea) for create / edit,
 *   - sidebar listing all comments (with their quotes), edit/delete, the two
 *     export actions, and an "unanchored" group for orphans.
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
 *                                     copyMarkdown(), saveCanvas() }
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
  // the painted highlight. The highlight reads like a honey marker swiped over the
  // text (a translucent band, not a flat block) — on-theme with the canvas concept.
  const BUTTON_CSS = [
    '.noteback-fab{',
    '  position:absolute;z-index:2147483646;',
    '  display:inline-flex;align-items:center;gap:7px;',
    '  font:600 12.5px/1 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    '  letter-spacing:.01em;color:#fffdf8;background:#127a72;',
    '  border:none;border-radius:999px;padding:7px 13px 7px 11px;cursor:pointer;',
    '  box-shadow:0 7px 18px -6px rgba(15,98,89,.6),0 1px 2px rgba(20,30,20,.22);',
    '  opacity:0;transform:scale(.94);',
    '  transition:transform .16s cubic-bezier(0.34,1.36,0.64,1),opacity .16s ease,background .15s ease;',
    '  -webkit-font-smoothing:antialiased;',
    '}',
    '.noteback-fab::before{content:"";width:9px;height:9px;border-radius:2px;',
    '  background:#ffd166;box-shadow:0 0 0 2px rgba(255,209,102,.3);}',
    '.noteback-fab.nb-in{opacity:1;transform:scale(1);}',
    '.noteback-fab:hover{background:#0e6960;}',
    '.noteback-fab:active{transform:scale(.97);}',
    'mark.noteback-highlight{',
    '  background:linear-gradient(180deg,transparent 12%,#ffe49c 12%,#ffe49c 92%,transparent 92%);',
    '  color:inherit;border-radius:1px;padding:0 .5px;cursor:pointer;',
    '  -webkit-box-decoration-break:clone;box-decoration-break:clone;',
    '  transition:background .2s ease;',
    '}',
    'mark.noteback-highlight:hover{',
    '  background:linear-gradient(180deg,transparent 12%,#ffd877 12%,#ffd877 92%,transparent 92%);}',
    'mark.noteback-highlight-flash{',
    '  background:#ffd166 !important;border-radius:3px !important;',
    '  box-shadow:0 0 0 3px rgba(232,184,75,.55) !important;',
    '  transition:background .25s ease,box-shadow .25s ease;',
    '}',
    '@media (prefers-reduced-motion: reduce){',
    '  .noteback-fab,mark.noteback-highlight,mark.noteback-highlight-flash{transition:none !important;}',
    '  .noteback-fab{opacity:1;transform:none;}',
    '}'
  ].join('');

  // Shadow-DOM panel styles. Concept: an editor's desk — warm paper surfaces,
  // warm-ink text, a fountain-pen teal accent, honey highlighter for quotes, an
  // italic-serif voice for quoted passages, and a soft rounded wordmark. Motion is
  // adapted from transitions.dev (panel reveal, menu dropdown, notification badge,
  // texts reveal, success check) and gated behind one prefers-reduced-motion guard.
  const PANEL_CSS = [
    ':host{all:initial;',
    '  --nb-ink:#2c2a25;--nb-ink-soft:#746f62;--nb-ink-faint:#a99f8c;',
    '  --nb-line:#e7dfce;--nb-line-strong:#d8ceb6;',
    '  --nb-accent:#127a72;--nb-accent-deep:#0e6960;--nb-accent-ink:#0c5f59;--nb-accent-wash:#e3efed;',
    '  --nb-danger:#b04a33;--nb-danger-wash:#f5e7e0;',
    '  --nb-paper:#f8f4ec;--nb-card:#fffdf8;',
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
    '  box-shadow:-16px 0 44px -22px rgba(60,48,25,.45);display:flex;flex-direction:column;z-index:2147483647;',
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
    '.nb-x:hover{background:#efe7d6;color:var(--nb-ink);}',
    '.nb-x:active{transform:scale(.9);}',

    /* list */
    '.nb-list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:13px 14px 16px;scrollbar-width:thin;}',
    '.nb-group-label{font:700 10.5px/1 var(--nb-round);text-transform:uppercase;letter-spacing:.09em;',
    '  color:var(--nb-ink-faint);margin:15px 4px 9px;display:flex;align-items:center;gap:9px;}',
    '.nb-group-label::after{content:"";flex:1;height:1px;background:var(--nb-line);}',

    /* comment cards */
    '.nb-item{position:relative;border:1px solid var(--nb-line);border-radius:13px;',
    '  padding:12px 13px 10px;margin-bottom:11px;background:var(--nb-card);',
    '  transition:box-shadow .2s ease,transform .2s ease,border-color .2s ease;}',
    '.nb-item:hover{box-shadow:0 12px 24px -16px rgba(60,48,25,.5);transform:translateY(-1px);border-color:var(--nb-line-strong);}',
    '.nb-item.nb-orphan{border-style:dashed;border-color:#d9cfb8;background:#f6f1e6;}',
    '.nb-item.nb-active{border-color:var(--nb-accent);box-shadow:0 0 0 1.5px var(--nb-accent),0 12px 24px -16px rgba(17,122,114,.55);}',
    '.nb-item.nb-doc{border-color:#bfe0db;background:#f1faf8;}',

    /* quote — honey highlighter swipe + italic-serif voice */
    '.nb-quote{font:italic 400 13.5px/1.5 var(--nb-quote);color:#5a4a2a;',
    '  background:linear-gradient(180deg,transparent 56%,#ffe49c 56%);border-radius:2px;',
    '  padding:1px 2px;display:block;margin:0 0 8px;cursor:pointer;white-space:pre-wrap;word-break:break-word;',
    '  -webkit-box-decoration-break:clone;box-decoration-break:clone;transition:background .2s ease;}',
    '.nb-quote:hover{background:linear-gradient(180deg,transparent 48%,#ffd877 48%);}',
    '.nb-item.nb-orphan .nb-quote{background:#efe7d6;color:var(--nb-ink-soft);}',

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
    '  background:linear-gradient(180deg,rgba(248,244,236,0),#f2ebdb);}',
    '.nb-btn{font:700 13px/1 var(--nb-round);border:1px solid var(--nb-accent);background:var(--nb-accent);color:#fffdf8;',
    '  border-radius:11px;padding:11px 12px;cursor:pointer;text-align:center;display:inline-flex;align-items:center;justify-content:center;gap:7px;',
    '  box-shadow:0 7px 16px -10px rgba(15,98,89,.7);transition:background .15s ease,transform .12s ease,box-shadow .2s ease;}',
    '.nb-btn:hover{background:var(--nb-accent-deep);box-shadow:0 11px 22px -10px rgba(15,98,89,.8);}',
    '.nb-btn:active{transform:translateY(1px) scale(.995);}',
    '.nb-btn.nb-secondary{background:var(--nb-card);color:var(--nb-accent-ink);border-color:var(--nb-line-strong);box-shadow:none;}',
    '.nb-btn.nb-secondary:hover{background:var(--nb-accent-wash);border-color:var(--nb-accent);}',

    /* toast + success check (transitions.dev) */
    '.nb-toast{position:fixed;bottom:20px;right:20px;display:inline-flex;align-items:center;gap:9px;',
    '  background:#2c2a25;color:#fdf8ec;padding:11px 15px 11px 13px;border-radius:13px;font:500 13px/1.2 var(--nb-ui);',
    '  z-index:2147483647;opacity:0;transform:translateY(8px) scale(.96);pointer-events:none;',
    '  box-shadow:0 16px 36px -12px rgba(20,15,5,.6);',
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
    '  border-radius:15px;box-shadow:0 20px 46px -16px rgba(60,48,25,.5),0 2px 8px rgba(60,48,25,.12);',
    '  padding:13px;width:312px;max-width:92vw;transform-origin:top center;',
    '  transform:scale(var(--dropdown-pre-scale));opacity:0;pointer-events:none;',
    '  transition:transform var(--dropdown-open-dur) var(--dropdown-ease),opacity var(--dropdown-open-dur) var(--dropdown-ease);',
    '  will-change:transform,opacity;}',
    '.nb-popover[data-origin="bottom-center"]{transform-origin:bottom center;}',
    '.nb-popover.is-open{transform:scale(1);opacity:1;pointer-events:auto;}',
    '.nb-popover.is-closing{transform:scale(var(--dropdown-closing-scale));opacity:0;pointer-events:none;',
    '  transition:transform var(--dropdown-close-dur) var(--dropdown-ease),opacity var(--dropdown-close-dur) var(--dropdown-ease);}',
    '.nb-pq{font:italic 400 12.5px/1.45 var(--nb-quote);color:#6a5a38;margin-bottom:9px;max-height:60px;overflow:auto;',
    '  background:linear-gradient(180deg,transparent 54%,#ffe49c 54%);border-radius:2px;padding:2px 3px;',
    '  white-space:pre-wrap;word-break:break-word;-webkit-box-decoration-break:clone;box-decoration-break:clone;}',
    '.nb-popover textarea{width:100%;min-height:76px;resize:vertical;border:1px solid var(--nb-line-strong);',
    '  border-radius:10px;padding:9px 10px;font:400 13.5px/1.5 var(--nb-ui);color:var(--nb-ink);background:#fffefb;',
    '  transition:border-color .15s ease,box-shadow .15s ease;}',
    '.nb-popover textarea::placeholder{color:var(--nb-ink-faint);}',
    '.nb-popover textarea:focus{outline:none;border-color:var(--nb-accent);box-shadow:0 0 0 3px var(--nb-accent-wash);}',
    '.nb-pop-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:11px;}',

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
    '  box-shadow:0 2px 6px rgba(60,48,25,.3);transform-origin:center;transform:scale(1);opacity:1;filter:blur(0);',
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
    '  padding:9px 10px;font:400 13.5px/1.5 var(--nb-ui);color:var(--nb-ink);background:#fffefb;',
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
    '  .nb-sidebar,.nb-popover,.nb-launcher,.nb-toast,.nb-launcher-badge,.nb-badge-dot,',
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
    const onChange = cfg.onChange || function () {};
    const renderMd = cfg.toMarkdown ||
      (markdownApi ? function (s) { return markdownApi.toMarkdown(s); } : null);

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

    let pendingAnchor = null; // anchor described from the current selection

    /* --- sidebar -------------------------------------------------------- */
    const sidebar = doc.createElement('div');
    sidebar.className = 'nb-sidebar';
    uiRoot.appendChild(sidebar);
    sidebar.innerHTML =
      '<div class="nb-head">' +
      '  <div class="nb-titlewrap"><span class="nb-title">Noteback</span> <span class="nb-count"></span></div>' +
      '  <button type="button" class="nb-x" title="Close" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="nb-list"></div>' +
      '<div class="nb-foot">' +
      '  <button type="button" class="nb-btn nb-secondary nb-copy">Copy as Markdown</button>' +
      '  <button type="button" class="nb-btn nb-save">Save as HTML canvas</button>' +
      '</div>';

    const elCount = sidebar.querySelector('.nb-count');
    const elList = sidebar.querySelector('.nb-list');
    sidebar.querySelector('.nb-x').addEventListener('click', closeSidebar);
    sidebar.querySelector('.nb-copy').addEventListener('click', copyMarkdown);
    sidebar.querySelector('.nb-save').addEventListener('click', saveCanvas);

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

      const rect = range.getBoundingClientRect();
      positionFab(rect);
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
      // Play the scale/fade-in (origin-grow) once shown. Forcing a reflow before
      // adding the class guarantees the transition fires even without rAF.
      if (!fab.classList.contains('nb-in')) {
        void fab.offsetWidth;
        fab.classList.add('nb-in');
      }
    }

    function hideFab() {
      fab.style.display = 'none';
      fab.classList.remove('nb-in');
      pendingAnchor = null;
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
      const rect = fabRect();
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

    function openPopover(o) {
      closePopover();
      editingId = o.id || null;
      popover = doc.createElement('div');
      popover.className = 'nb-popover';
      popover.setAttribute(UI_ATTR, 'popover');
      const quote = (o.anchor && o.anchor.quote) || '';
      popover.innerHTML =
        '<div class="nb-pq"></div>' +
        '<textarea placeholder="Add a comment…"></textarea>' +
        '<div class="nb-pop-actions">' +
        '  <button type="button" class="nb-link nb-cancel">Cancel</button>' +
        '  <button type="button" class="nb-btn nb-savecomment">Save</button>' +
        '</div>';
      const pq = popover.querySelector('.nb-pq');
      pq.textContent = quote ? ('“' + truncate(quote, 140) + '”') : 'Note on the whole document';
      const ta = popover.querySelector('textarea');
      ta.value = o.body || '';
      uiRoot.appendChild(popover);

      positionPopover(o.rect);
      // Origin-aware grow (menu-dropdown): reflow, then flip to .is-open so the
      // popover scales up from the edge nearest the trigger.
      void popover.offsetWidth;
      popover.classList.add('is-open');

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

    function positionPopover(rect) {
      const vw = (win && win.innerWidth) || 1024;
      const vh = (win && win.innerHeight) || 768;
      const w = 300;
      let left = rect ? rect.left : (vw - w) / 2;
      let top = rect ? rect.bottom + 8 : 80;
      if (left + w + 8 > vw) left = vw - w - 8;
      if (left < 8) left = 8;
      const h = popover.offsetHeight || 160;
      let above = false;
      if (top + h + 8 > vh) { top = Math.max(8, (rect ? rect.top : top) - h - 8); above = true; }
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      // Grow from the edge nearest the trigger: placed below → top origin.
      popover.setAttribute('data-origin', above ? 'bottom-center' : 'top-center');
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

      updateLauncher();
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

    async function saveCanvas() {
      const s = getState();
      if (exporter && typeof exporter.onSaveCanvas === 'function') {
        try {
          await exporter.onSaveCanvas(s);
          toast('Saving HTML canvas…');
        } catch (e) {
          toast('Save failed');
        }
        return;
      }
      toast('Saving the canvas is only available with the extension here.');
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
      sidebar.classList.remove('nb-open');
      launcher.classList.remove('nb-hidden');
    }
    function toggleSidebar() {
      if (sidebar.classList.contains('nb-open')) closeSidebar();
      else openSidebar();
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
    const onDocMouseDown = function (e) {
      // Click outside the popover (and not on the fab) closes the editor.
      if (!popover) return;
      const t = e.target;
      if (t === fab) return;
      if (isInOwnUi(t)) {
        // Clicks inside our shadow UI report the host as target; allow them.
        if (t === host) return;
      }
      // Determine if the click landed inside the popover via composedPath.
      const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
      if (path.indexOf(popover) !== -1) return;
      closePopover();
    };

    doc.addEventListener('selectionchange', onSelChange);
    if (win) {
      win.addEventListener('scroll', onScrollOrResize, true);
      win.addEventListener('resize', onScrollOrResize);
    }
    doc.addEventListener('mousedown', onDocMouseDown, true);

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

    // Initial render so the sidebar reflects loaded state when first opened.
    renderSidebar();

    function destroy() {
      doc.removeEventListener('selectionchange', onSelChange);
      if (win) {
        win.removeEventListener('scroll', onScrollOrResize, true);
        win.removeEventListener('resize', onScrollOrResize);
      }
      doc.removeEventListener('mousedown', onDocMouseDown, true);
      doc.removeEventListener('click', onDocClick);
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
