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

  /** Concatenated cleaned HTML for an ordered list of section nodes. */
  function assembleHtml(nodes, doc) {
    const wrap = doc.createElement('div');
    for (let i = 0; i < nodes.length; i++) wrap.appendChild(cleanClone(nodes[i]));
    return wrap.innerHTML;
  }

  /**
   * When a whole section exceeds the char budget, keep the nearest heading plus a
   * contiguous window of blocks grown outward from the commented block until adding
   * the next block would blow the cap.
   */
  function trimToCap(nodes, block, maxChars, doc) {
    let anchor = 0;
    for (let i = 0; i < nodes.length; i++) { if (nodeContains(nodes[i], block)) { anchor = i; break; } }
    const heading = isHeading(nodes[0]) ? nodes[0] : null;
    let lo = anchor, hi = anchor;
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
   * Build per-section snapshots for the given comments. Each anchored comment maps
   * to its whole enclosing section; comments that share a section (which fits the
   * cap) share one snapshot. Oversized sections are trimmed to a window around the
   * commented block. Doc-level notes (anchor==null) and comments whose highlight
   * isn't painted are skipped.
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
    const keyed = []; // [{ key, id }] — key is the section heading (shared) or block (trimmed)
    const sectionByCommentId = {};

    (cfg.comments || []).forEach(function (c) {
      if (!c || c.anchor == null) return; // doc-level note: no section
      const mark = root.querySelector('mark.' + HL_CLASS + '[data-noteback-id="' + c.id + '"]');
      if (!mark) return; // orphaned / not painted
      const block = enclosingBlock(mark, root);
      const nodes = pickSectionNodes(block);
      let html = assembleHtml(nodes, doc);
      let key;
      if (html.length <= maxChars) {
        key = nodes[0]; // whole section captured — share it across comments in the same section
      } else {
        key = block;    // oversized section — store a capped window around this block
        html = assembleHtml(trimToCap(nodes, block, maxChars, doc), doc);
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
