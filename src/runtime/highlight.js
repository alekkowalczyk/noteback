/**
 * Noteback runtime — highlight.js  (DOM-ONLY; browser global)
 *
 * Responsibility: paint / clear highlight wrappers for comment anchors within a
 * root node, and focus (scroll-to / flash) a highlight by comment id. Uses
 * `NotebackRuntime.anchor` to re-find each comment's range in the document text.
 *
 * Browser-only: attaches to `NotebackRuntime.highlight`. No module.exports — it
 * is never required by Node tests.
 *
 * Conventions (CONTRACTS.md §3.4):
 *   - highlight wrapper class:   "noteback-highlight"
 *   - wrapper identity attr:     data-noteback-id="<commentId>"
 *
 * Public API:
 *   paintHighlights(root, state, opts?) -> { painted:string[], orphaned:string[] }
 *   clearHighlights(root) -> void
 *   focusHighlight(root, commentId) -> void
 *
 * Design notes:
 *   - `anchor.findAnchor` works over the FLAT textContent of the root. We build a
 *     parallel index of the document's text nodes so a character range can be
 *     projected back onto the live DOM and wrapped in <mark> elements (one per
 *     text node the range spans). We WRAP, never replace — clearing unwraps and
 *     re-merges the text so the original structure is restored losslessly.
 *   - We skip text inside our own UI (anything under a [data-noteback-ui] host,
 *     e.g. the sidebar / popover / button) so overlay chrome never gets anchored
 *     into and the doc text we anchor against matches what the anchor module saw.
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.highlight = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HIGHLIGHT_CLASS = 'noteback-highlight';
  const ID_ATTR = 'data-noteback-id';
  const FLASH_CLASS = 'noteback-highlight-flash';
  // Elements carrying this attribute (and their subtrees) are Noteback's own UI
  // and must be excluded from both text extraction and highlight wrapping.
  const UI_ATTR = 'data-noteback-ui';

  function getAnchorApi() {
    const g = typeof globalThis !== 'undefined' ? globalThis : this;
    return g.NotebackRuntime && g.NotebackRuntime.anchor;
  }

  /**
   * Collect the document's text nodes (in document order), skipping our own UI
   * subtrees, plus <script>/<style> content. Returns the ordered nodes and the
   * concatenated text — the same text the anchor module sees via textContent
   * (modulo the UI we deliberately exclude).
   *
   * @param {Node} rootNode
   * @returns {{ nodes: Text[], starts: number[], text: string }}
   *   `starts[i]` is the global offset where `nodes[i]` begins in `text`.
   */
  function collectTextNodes(rootNode) {
    const nodes = [];
    const starts = [];
    let text = '';

    if (!rootNode || typeof rootNode.nodeType !== 'number') {
      return { nodes, starts, text };
    }

    const doc = rootNode.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const NF = (typeof NodeFilter !== 'undefined') ? NodeFilter : null;

    const accept = function (node) {
      // Reject text under our own UI, scripts and styles.
      let el = node.parentNode;
      while (el && el !== rootNode.parentNode) {
        if (el.nodeType === 1) {
          const tag = (el.tagName || '').toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return false;
          }
          if (typeof el.hasAttribute === 'function' && el.hasAttribute(UI_ATTR)) {
            return false;
          }
        }
        el = el.parentNode;
      }
      return true;
    };

    if (doc && typeof doc.createTreeWalker === 'function' && NF) {
      const walker = doc.createTreeWalker(
        rootNode,
        NF.SHOW_TEXT,
        {
          acceptNode: function (node) {
            return accept(node) ? NF.FILTER_ACCEPT : NF.FILTER_REJECT;
          }
        }
      );
      let n;
      while ((n = walker.nextNode())) {
        const v = n.nodeValue || '';
        if (v.length === 0) continue;
        starts.push(text.length);
        nodes.push(n);
        text += v;
      }
    } else {
      // Fallback manual DFS (e.g. environments without TreeWalker).
      const stack = [rootNode];
      const ordered = [];
      // DFS that preserves document order using an explicit child walk.
      (function walk(node) {
        if (!node) return;
        if (node.nodeType === 3) {
          if (accept(node)) ordered.push(node);
          return;
        }
        if (node.nodeType === 1) {
          const tag = (node.tagName || '').toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
          if (typeof node.hasAttribute === 'function' && node.hasAttribute(UI_ATTR)) return;
        }
        let child = node.firstChild;
        while (child) {
          walk(child);
          child = child.nextSibling;
        }
      })(rootNode);
      void stack;
      for (let i = 0; i < ordered.length; i++) {
        const v = ordered[i].nodeValue || '';
        if (v.length === 0) continue;
        starts.push(text.length);
        nodes.push(ordered[i]);
        text += v;
      }
    }

    return { nodes, starts, text };
  }

  /**
   * Locate the text node + local offset for a global character offset.
   * @returns {{ node: Text, offset: number }|null}
   */
  function locate(index, nodes, starts) {
    if (nodes.length === 0) return null;
    // Binary search for the last node whose start <= index.
    let lo = 0;
    let hi = nodes.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= index) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const node = nodes[found];
    const offset = index - starts[found];
    const len = (node.nodeValue || '').length;
    // Clamp the end-edge case (index === text.length lands past the last node).
    return { node: node, offset: Math.max(0, Math.min(offset, len)) };
  }

  /**
   * Wrap the character range [start, end) of the live DOM in <mark> elements
   * tagged with the comment id. The range may span several text nodes; we wrap
   * each spanned slice in its own <mark> (splitting text nodes at the edges).
   *
   * @returns {boolean} true if at least one wrapper was created.
   */
  function wrapRange(start, end, commentId, nodes, starts) {
    if (end <= start) return false;
    const doc = nodes[0] && nodes[0].ownerDocument;
    if (!doc) return false;

    // Identify every text node (slice) the range touches, with local offsets.
    const segments = [];
    for (let i = 0; i < nodes.length; i++) {
      const nodeStart = starts[i];
      const nodeEnd = nodeStart + (nodes[i].nodeValue || '').length;
      if (nodeEnd <= start) continue;
      if (nodeStart >= end) break;
      const localStart = Math.max(0, start - nodeStart);
      const localEnd = Math.min(nodeEnd, end) - nodeStart;
      if (localEnd > localStart) {
        segments.push({ node: nodes[i], localStart: localStart, localEnd: localEnd });
      }
    }
    if (segments.length === 0) return false;

    let created = false;
    // Wrap from last → first so earlier nodes' offsets stay valid after splits.
    for (let s = segments.length - 1; s >= 0; s--) {
      const seg = segments[s];
      let node = seg.node;
      let localStart = seg.localStart;
      let localEnd = seg.localEnd;
      const full = node.nodeValue || '';

      // Split off the trailing remainder first.
      if (localEnd < full.length) {
        node.splitText(localEnd);
      }
      // Split off the leading remainder; `node` becomes the middle slice.
      if (localStart > 0) {
        node = node.splitText(localStart);
      }

      const mark = doc.createElement('mark');
      mark.className = HIGHLIGHT_CLASS;
      mark.setAttribute(ID_ATTR, commentId);
      const parent = node.parentNode;
      if (!parent) continue;
      parent.replaceChild(mark, node);
      mark.appendChild(node);
      created = true;
    }
    return created;
  }

  /**
   * Re-anchor each comment and wrap matched ranges.
   * @param {Node} rootNode
   * @param {Object} state
   * @param {Object} [opts]
   * @returns {{painted:string[], orphaned:string[]}} comment ids by outcome.
   */
  function paintHighlights(rootNode, state, opts) {
    void opts;
    const painted = [];
    const orphaned = [];
    if (!rootNode || !state || !Array.isArray(state.comments)) {
      return { painted: painted, orphaned: orphaned };
    }
    const anchorApi = getAnchorApi();
    if (!anchorApi) {
      throw new Error('highlight.paintHighlights requires NotebackRuntime.anchor');
    }

    // Always start from a clean slate so repaint is idempotent.
    clearHighlights(rootNode);

    // Resolve all anchors against ONE snapshot of the text, but paint ranges one
    // comment at a time (re-collecting nodes after each paint, since wrapping
    // mutates the DOM — offsets from the original snapshot would drift).
    const snapshot = collectTextNodes(rootNode);

    // Resolve every comment to a range up-front against the stable snapshot text.
    const resolved = [];
    state.comments.forEach(function (c) {
      if (!c || !c.anchor) {
        orphaned.push(c && c.id);
        return;
      }
      const range = anchorApi.findAnchor(snapshot.text, c.anchor);
      if (!range) {
        orphaned.push(c.id);
      } else {
        resolved.push({ id: c.id, start: range.start, end: range.end });
      }
    });

    // Paint earliest-first so that, as we re-collect nodes after each wrap, the
    // already-wrapped ranges (which keep their text) don't shift later offsets:
    // <mark> wrapping does not change textContent, so the flat text is stable and
    // we can paint all ranges against the SAME snapshot offsets in one pass,
    // wrapping from last range to first to keep node offsets valid.
    resolved.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    for (let i = resolved.length - 1; i >= 0; i--) {
      const r = resolved[i];
      const ok = wrapRange(r.start, r.end, r.id, snapshot.nodes, snapshot.starts);
      if (ok) painted.push(r.id);
      else orphaned.push(r.id);
    }
    // Restore document order in the painted list.
    painted.reverse();

    return { painted: painted, orphaned: orphaned };
  }

  /**
   * Remove every Noteback highlight wrapper under rootNode (restoring text).
   * @param {Node} rootNode
   */
  function clearHighlights(rootNode) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
    const marks = rootNode.querySelectorAll('mark.' + HIGHLIGHT_CLASS + '[' + ID_ATTR + ']');
    for (let i = 0; i < marks.length; i++) {
      unwrap(marks[i]);
    }
    // Coalesce adjacent text nodes split during wrapping so the DOM is restored.
    if (typeof rootNode.normalize === 'function') {
      rootNode.normalize();
    }
  }

  /** Replace a wrapper element with its child nodes (unwrap), in place. */
  function unwrap(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
  }

  /**
   * Scroll to / flash a comment's highlight.
   * @param {Node} rootNode
   * @param {string} commentId
   * @returns {boolean} true if a highlight was found and focused.
   */
  function focusHighlight(rootNode, commentId) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function' || !commentId) {
      return false;
    }
    const sel = 'mark.' + HIGHLIGHT_CLASS + '[' + ID_ATTR + '="' + cssEscape(commentId) + '"]';
    const marks = rootNode.querySelectorAll(sel);
    if (!marks || marks.length === 0) return false;

    const first = marks[0];
    if (typeof first.scrollIntoView === 'function') {
      try {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {
        first.scrollIntoView();
      }
    }
    // Flash every wrapper of this comment.
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      m.classList.add(FLASH_CLASS);
      (function (node) {
        const win = (node.ownerDocument && node.ownerDocument.defaultView) ||
          (typeof window !== 'undefined' ? window : null);
        const to = win ? win.setTimeout : setTimeout;
        to(function () { node.classList.remove(FLASH_CLASS); }, 1200);
      })(m);
    }
    return true;
  }

  /** Minimal CSS attribute-value escaping for the id selector. */
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  return {
    HIGHLIGHT_CLASS: HIGHLIGHT_CLASS,
    ID_ATTR: ID_ATTR,
    FLASH_CLASS: FLASH_CLASS,
    UI_ATTR: UI_ATTR,
    paintHighlights: paintHighlights,
    clearHighlights: clearHighlights,
    focusHighlight: focusHighlight
  };
});
