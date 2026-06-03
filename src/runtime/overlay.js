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

  const BUTTON_CSS = [
    '.noteback-fab{',
    '  position:absolute;z-index:2147483646;',
    '  font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    '  background:#2563eb;color:#fff;border:none;border-radius:6px;',
    '  padding:6px 10px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);',
    '  display:inline-flex;align-items:center;gap:5px;',
    '}',
    '.noteback-fab:hover{background:#1d4ed8;}',
    'mark.noteback-highlight{',
    '  background:#fde68a;color:inherit;border-radius:2px;',
    '  box-shadow:0 0 0 1px rgba(245,158,11,.35);cursor:pointer;',
    '  padding:0;',
    '}',
    'mark.noteback-highlight-flash{',
    '  background:#fbbf24!important;box-shadow:0 0 0 2px rgba(217,119,6,.7)!important;',
    '  transition:background .2s ease,box-shadow .2s ease;',
    '}'
  ].join('');

  const PANEL_CSS = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;}',
    '.nb-root{',
    '  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
    '  color:#1f2937;',
    '}',
    '.nb-sidebar{',
    '  position:fixed;top:0;right:0;height:100vh;width:340px;max-width:85vw;',
    '  background:#fff;border-left:1px solid #e5e7eb;box-shadow:-2px 0 12px rgba(0,0,0,.08);',
    '  display:flex;flex-direction:column;z-index:2147483647;',
    '  transform:translateX(100%);transition:transform .18s ease;',
    '}',
    '.nb-sidebar.nb-open{transform:translateX(0);}',
    '.nb-head{display:flex;align-items:center;justify-content:space-between;',
    '  padding:12px 14px;border-bottom:1px solid #e5e7eb;}',
    '.nb-title{font-weight:700;font-size:15px;}',
    '.nb-count{color:#6b7280;font-size:12px;}',
    '.nb-x{border:none;background:none;font-size:18px;line-height:1;cursor:pointer;',
    '  color:#6b7280;padding:4px;border-radius:4px;}',
    '.nb-x:hover{background:#f3f4f6;color:#111827;}',
    '.nb-list{flex:1 1 auto;overflow-y:auto;padding:10px 12px;}',
    '.nb-group-label{font-size:11px;font-weight:700;text-transform:uppercase;',
    '  letter-spacing:.04em;color:#9ca3af;margin:8px 2px 6px;}',
    '.nb-item{border:1px solid #e5e7eb;border-radius:8px;padding:10px;',
    '  margin-bottom:10px;background:#fff;}',
    '.nb-item.nb-orphan{border-style:dashed;border-color:#d1d5db;background:#fafafa;}',
    '.nb-item.nb-active{border-color:#2563eb;box-shadow:0 0 0 1px #2563eb;}',
    '.nb-quote{font-style:italic;color:#374151;background:#fef3c7;border-radius:4px;',
    '  padding:3px 6px;display:block;margin-bottom:6px;cursor:pointer;',
    '  white-space:pre-wrap;word-break:break-word;}',
    '.nb-item.nb-orphan .nb-quote{background:#f3f4f6;color:#6b7280;}',
    '.nb-body{white-space:pre-wrap;word-break:break-word;margin:0 0 8px;}',
    '.nb-actions{display:flex;gap:8px;}',
    '.nb-link{border:none;background:none;color:#2563eb;cursor:pointer;font-size:12px;',
    '  padding:2px 4px;border-radius:4px;}',
    '.nb-link:hover{background:#eff6ff;}',
    '.nb-link.nb-danger{color:#dc2626;}',
    '.nb-link.nb-danger:hover{background:#fef2f2;}',
    '.nb-empty{color:#9ca3af;text-align:center;padding:24px 12px;font-size:13px;}',
    '.nb-foot{border-top:1px solid #e5e7eb;padding:12px;display:flex;flex-direction:column;gap:8px;}',
    '.nb-btn{font:600 13px/1 inherit;border:1px solid #2563eb;background:#2563eb;color:#fff;',
    '  border-radius:6px;padding:9px 12px;cursor:pointer;text-align:center;}',
    '.nb-btn:hover{background:#1d4ed8;}',
    '.nb-btn.nb-secondary{background:#fff;color:#2563eb;}',
    '.nb-btn.nb-secondary:hover{background:#eff6ff;}',
    '.nb-toast{position:fixed;bottom:18px;right:18px;background:#111827;color:#fff;',
    '  padding:9px 14px;border-radius:8px;font-size:13px;z-index:2147483647;opacity:0;',
    '  transition:opacity .2s ease;pointer-events:none;}',
    '.nb-toast.nb-show{opacity:1;}',
    /* popover */
    '.nb-popover{position:fixed;z-index:2147483647;background:#fff;border:1px solid #e5e7eb;',
    '  border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px;width:300px;max-width:90vw;}',
    '.nb-popover .nb-pq{font-style:italic;color:#6b7280;font-size:12px;margin-bottom:8px;',
    '  max-height:54px;overflow:auto;background:#fef3c7;border-radius:4px;padding:4px 6px;',
    '  white-space:pre-wrap;word-break:break-word;}',
    '.nb-popover textarea{width:100%;min-height:72px;resize:vertical;border:1px solid #d1d5db;',
    '  border-radius:6px;padding:8px;font:14px/1.4 inherit;color:#1f2937;}',
    '.nb-popover textarea:focus{outline:2px solid #2563eb;outline-offset:0;border-color:#2563eb;}',
    '.nb-pop-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}'
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
    fab.textContent = '💬 Comment';
    fab.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(fab);

    let pendingAnchor = null; // anchor described from the current selection

    /* --- sidebar -------------------------------------------------------- */
    const sidebar = doc.createElement('div');
    sidebar.className = 'nb-sidebar';
    uiRoot.appendChild(sidebar);
    sidebar.innerHTML =
      '<div class="nb-head">' +
      '  <div><span class="nb-title">Noteback</span> <span class="nb-count"></span></div>' +
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

    /* --- popover (in shadow root) --------------------------------------- */
    let popover = null;
    let editingId = null;

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
    }

    function hideFab() {
      fab.style.display = 'none';
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
      popover.querySelector('.nb-pq').textContent = '“' + truncate(quote, 140) + '”';
      const ta = popover.querySelector('textarea');
      ta.value = o.body || '';
      uiRoot.appendChild(popover);

      positionPopover(o.rect);

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
      if (top + h + 8 > vh) top = Math.max(8, (rect ? rect.top : top) - h - 8);
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
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
      if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
      popover = null;
      editingId = null;
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
      comments.forEach(function (c) {
        const found = c && c.anchor && anchorApi.findAnchor(text, c.anchor);
        if (found) anchored.push(c); else orphans.push(c);
      });

      elCount.textContent = comments.length === 1 ? '1 comment' : comments.length + ' comments';
      elList.textContent = '';

      if (comments.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'nb-empty';
        empty.textContent = 'Select text in the document and click “💬 Comment” to add feedback.';
        elList.appendChild(empty);
        return;
      }

      anchored.forEach(function (c) { elList.appendChild(renderItem(c, false)); });

      if (orphans.length > 0) {
        const label = doc.createElement('div');
        label.className = 'nb-group-label';
        label.textContent = 'Unanchored (' + orphans.length + ')';
        elList.appendChild(label);
        orphans.forEach(function (c) { elList.appendChild(renderItem(c, true)); });
      }
    }

    function renderItem(c, isOrphan) {
      const item = doc.createElement('div');
      item.className = 'nb-item' + (isOrphan ? ' nb-orphan' : '');
      item.setAttribute('data-id', c.id);

      const quote = doc.createElement('span');
      quote.className = 'nb-quote';
      quote.textContent = '“' + truncate((c.anchor && c.anchor.quote) || '', 160) + '”';
      if (!isOrphan) {
        quote.title = 'Jump to highlight';
        quote.addEventListener('click', function () { focusComment(c.id); });
      }
      item.appendChild(quote);

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
          toast('Copied feedback as Markdown');
        } catch (e) {
          toast('Copy failed');
        }
        return;
      }
      // Default embedded-mode behaviour: render + Clipboard API.
      if (!renderMd) { toast('Markdown unavailable'); return; }
      const md = renderMd(s);
      const ok = await copyToClipboard(md);
      toast(ok ? 'Copied feedback as Markdown' : 'Copy failed — select & copy manually');
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
    function toast(msg) {
      if (!toastEl) {
        toastEl = doc.createElement('div');
        toastEl.className = 'nb-toast';
        uiRoot.appendChild(toastEl);
      }
      toastEl.textContent = msg;
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
    }
    function closeSidebar() {
      sidebar.classList.remove('nb-open');
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
