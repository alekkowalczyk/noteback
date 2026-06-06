/**
 * Noteback runtime — snapshot.js  (DOM module; pure sub-helpers dual-exported)
 *
 * Captures clean per-section HTML for the draft-history context popup. The DOM
 * extraction (`extractSections`) is browser-only; the section-selection helpers
 * are pure and dual-exported so they unit-test under Node.
 *
 * Attaches to `NotebackRuntime.snapshot`; exports the pure parts under Node.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.snapshot = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADINGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };

  function isHeading(node) {
    if (!node || !node.tagName) return false;
    if (HEADINGS[String(node.tagName).toUpperCase()]) return true;
    const role = node.getAttribute && node.getAttribute('role');
    return role === 'heading';
  }

  /** Heading level 1-6 (role=heading uses aria-level, default 2); 99 = not a heading. */
  function headingLevel(node) {
    if (!node || !node.tagName) return 99;
    const m = /^H([1-6])$/.exec(String(node.tagName).toUpperCase());
    if (m) return Number(m[1]);
    const role = node.getAttribute && node.getAttribute('role');
    if (role === 'heading') {
      const lv = node.getAttribute && parseInt(node.getAttribute('aria-level'), 10);
      return (lv && isFinite(lv)) ? lv : 2;
    }
    return 99;
  }

  /** True if `ancestor` is `node` or contains it (walks parentElement; DOM-free). */
  function nodeContains(ancestor, node) {
    let el = node;
    while (el) { if (el === ancestor) return true; el = el.parentElement; }
    return false;
  }

  /** Nearest preceding heading: back through prev siblings, then up ancestors. */
  function findNearestHeading(block) {
    let node = block;
    while (node) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (isHeading(sib)) return sib;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  const CONTEXT_FALLBACK_BLOCKS = 3; // sibling window each side when no heading bounds the section

  /** A bounded window of sibling blocks around `block` (used when there's no heading). */
  function windowAround(block, before, after) {
    const out = [];
    const prevs = [];
    let p = block.previousElementSibling;
    while (p && prevs.length < before) { prevs.push(p); p = p.previousElementSibling; }
    for (let i = prevs.length - 1; i >= 0; i--) out.push(prevs[i]); // reversed -> document order
    out.push(block);
    let n = block.nextElementSibling, c = 0;
    while (n && c < after) { out.push(n); n = n.nextElementSibling; c++; }
    return out;
  }

  /**
   * The whole enclosing section in document order: the nearest heading, then every
   * following sibling up to (but not including) the next heading of the same or
   * higher level. Gives the history popup full section context, not just a block or
   * two. Deeper sub-headings (and their content) stay in; a same/higher heading ends
   * the section. Falls back to a bounded sibling window when there's no heading to
   * anchor to (or the heading's sibling run doesn't actually contain the block).
   */
  function pickSectionNodes(block) {
    const heading = isHeading(block) ? block : findNearestHeading(block);
    if (!heading) return windowAround(block, CONTEXT_FALLBACK_BLOCKS, CONTEXT_FALLBACK_BLOCKS);
    const level = headingLevel(heading);
    const out = [heading];
    let n = heading.nextElementSibling;
    while (n) {
      if (isHeading(n) && headingLevel(n) <= level) break;
      out.push(n);
      n = n.nextElementSibling;
    }
    for (let i = 0; i < out.length; i++) { if (nodeContains(out[i], block)) return out; }
    // The heading's sibling run didn't reach the block (unusual nesting) -> window.
    return windowAround(block, CONTEXT_FALLBACK_BLOCKS, CONTEXT_FALLBACK_BLOCKS);
  }

  const identityCodec = {
    compress: function (s) { return Promise.resolve(String(s == null ? '' : s)); },
    decompress: function (s) { return Promise.resolve(String(s == null ? '' : s)); }
  };

  const UI_ATTR = 'data-noteback-ui';
  const HL_CLASS = 'noteback-highlight';
  const BLOCK_TAGS = /^(P|LI|PRE|BLOCKQUOTE|TD|TH|TR|DIV|SECTION|ARTICLE|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|FIGURE)$/;

  /** Nearest block-level ancestor of a node (fallback: the node itself). */
  function enclosingBlock(node, rootNode) {
    let el = (node.nodeType === 1) ? node : node.parentElement;
    while (el && el !== rootNode) {
      if (el.tagName && BLOCK_TAGS.test(String(el.tagName).toUpperCase())) return el;
      el = el.parentElement;
    }
    return (node.nodeType === 1) ? node : node.parentElement;
  }

  /** Clone a node and strip Noteback UI + unwrap highlight marks inside it. */
  function cleanClone(node) {
    const clone = node.cloneNode(true);
    const ui = clone.querySelectorAll ? clone.querySelectorAll('[' + UI_ATTR + ']') : [];
    for (let i = 0; i < ui.length; i++) { if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]); }
    // Unwrap highlight marks among descendants. (The cloned node is always a
    // block element, never a bare highlight mark, so the mark tag is never the
    // clone root — that only happens for highlighted text with no block wrapper.)
    const marks = clone.querySelectorAll ? clone.querySelectorAll('mark.' + HL_CLASS) : [];
    for (let j = 0; j < marks.length; j++) {
      const m = marks[j], p = m.parentNode; if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    }
    return clone;
  }

  /** Inline <style> text from the document head (for snapshot styling). */
  function collectInlineStyles(doc) {
    const styles = doc.querySelectorAll ? doc.querySelectorAll('style') : [];
    let out = '';
    for (let i = 0; i < styles.length; i++) {
      if (styles[i].getAttribute && styles[i].getAttribute(UI_ATTR)) continue; // skip our own
      out += (styles[i].textContent || '') + '\n';
    }
    return out;
  }

  /** True if `node` is a highlight <mark> (not a content block). */
  function isHighlightMark(node) {
    return !!(node && node.tagName === 'MARK' && (' ' + (node.className || '') + ' ').indexOf(' ' + HL_CLASS + ' ') !== -1);
  }

  /** Concatenated cleaned HTML for an ordered list of section nodes. */
  function assembleHtml(nodes, doc) {
    const wrap = doc.createElement('div');
    for (let i = 0; i < nodes.length; i++) {
      // A selection that crosses block boundaries wraps the inter-block whitespace
      // in bare <mark>s that sit at the section level — skip them so they don't leak
      // stray highlighted whitespace into the snapshot.
      if (isHighlightMark(nodes[i])) continue;
      wrap.appendChild(cleanClone(nodes[i]));
    }
    return wrap.innerHTML;
  }

  /** Index of the first node in `nodes` that is or contains `block` (-1 if none). */
  function indexOfContaining(nodes, block) {
    for (let i = 0; i < nodes.length; i++) { if (nodeContains(nodes[i], block)) return i; }
    return -1;
  }

  /**
   * When the captured section(s) exceed the char budget, keep the nearest heading
   * plus the protected core (the blocks the selection actually touches, indices
   * protectLo..protectHi) and grow a window outward until the next block would blow
   * the cap. The protected core is never dropped, so the whole selection stays in.
   */
  function trimToCap(nodes, protectLo, protectHi, maxChars, doc) {
    const heading = isHeading(nodes[0]) ? nodes[0] : null;
    let lo = protectLo, hi = protectHi;
    function current() {
      const win = nodes.slice(lo, hi + 1);
      return (heading && lo > 0) ? [heading].concat(win) : win;
    }
    let grew = true;
    while (grew) {
      grew = false;
      if (hi + 1 < nodes.length) { hi++; if (assembleHtml(current(), doc).length <= maxChars) grew = true; else hi--; }
      if (lo - 1 >= 0) { lo--; if (assembleHtml(current(), doc).length <= maxChars) grew = true; else lo++; }
    }
    return current();
  }

  /**
   * Build per-section snapshots for the given comments. A selection that spans
   * blocks paints one <mark> per text slice (all sharing the comment id), so a
   * comment can touch several blocks — even several sections. Each comment maps to
   * the UNION of every section its selection touches (first slice's section through
   * the last's), so the popup shows the whole selected passage with context, not
   * just the start. Single-section spans that fit the cap are shared between
   * comments; oversized captures trim context around the touched blocks while always
   * keeping the full selection. Doc-level notes (anchor==null) and comments whose
   * highlight isn't painted are skipped.
   * @param {Object} cfg
   * @param {Node} cfg.root        the painted content root (#noteback-doc-root)
   * @param {Document} cfg.doc
   * @param {Array} cfg.comments   current State.comments
   * @param {number} [cfg.maxSectionChars=16000]
   * @returns {{ sections: Array<{id,html}>, styles: string, sectionByCommentId: Object }}
   */
  function extractSections(cfg) {
    const root = cfg.root, doc = cfg.doc;
    const maxChars = cfg.maxSectionChars || 16000;
    const sections = [];
    const keyed = []; // [{ key, id }] — key is the section heading (shared) or comment id (per-comment)
    const sectionByCommentId = {};

    (cfg.comments || []).forEach(function (c) {
      if (!c || c.anchor == null) return; // doc-level note: no section
      const marks = root.querySelectorAll('mark.' + HL_CLASS + '[data-noteback-id="' + c.id + '"]');
      if (!marks || !marks.length) return; // orphaned / not painted

      // Distinct blocks the selection touches, in document order. A mark with no
      // block ancestor (enclosingBlock returns the mark itself) is inter-block
      // whitespace the selection swept up — not a content block; skip it.
      const blocks = [];
      for (let i = 0; i < marks.length; i++) {
        const b = enclosingBlock(marks[i], root);
        if (b === marks[i]) continue;
        if (blocks.indexOf(b) === -1) blocks.push(b);
      }
      if (!blocks.length) return;
      // Union of every section those blocks fall in, in document order (a contiguous
      // selection touches contiguous sections, so no gaps).
      const nodes = [];
      const heads = [];
      blocks.forEach(function (b) {
        const sn = pickSectionNodes(b);
        if (heads.indexOf(sn[0]) === -1) {
          heads.push(sn[0]);
          for (let i = 0; i < sn.length; i++) { if (nodes.indexOf(sn[i]) === -1) nodes.push(sn[i]); }
        }
      });

      let html = assembleHtml(nodes, doc);
      let key;
      if (html.length <= maxChars) {
        // A single-section span can be shared between comments; a multi-section span
        // is per-comment (its exact extent varies).
        key = heads.length === 1 ? nodes[0] : c.id;
      } else {
        key = c.id;
        let lo = indexOfContaining(nodes, blocks[0]);
        let hi = indexOfContaining(nodes, blocks[blocks.length - 1]);
        if (lo < 0) lo = 0;
        if (hi < 0) hi = nodes.length - 1;
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        html = assembleHtml(trimToCap(nodes, lo, hi, maxChars, doc), doc);
      }
      let existingId = null;
      for (let i = 0; i < keyed.length; i++) { if (keyed[i].key === key) { existingId = keyed[i].id; break; } }
      if (existingId) { sectionByCommentId[c.id] = existingId; return; }
      const id = 's' + (sections.length + 1);
      sections.push({ id: id, html: html });
      keyed.push({ key: key, id: id });
      sectionByCommentId[c.id] = id;
    });

    return { sections: sections, styles: collectInlineStyles(doc), sectionByCommentId: sectionByCommentId };
  }

  return {
    isHeading: isHeading,
    headingLevel: headingLevel,
    findNearestHeading: findNearestHeading,
    pickSectionNodes: pickSectionNodes,
    enclosingBlock: enclosingBlock,
    extractSections: extractSections,
    collectInlineStyles: collectInlineStyles,
    identityCodec: identityCodec
  };
});
