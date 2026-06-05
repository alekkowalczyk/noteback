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

  /** [heading?, prev?, block, next?] in document order, deduped, no nulls. */
  function pickSectionNodes(block) {
    const out = [];
    const heading = findNearestHeading(block);
    const prev = block.previousElementSibling;
    const next = block.nextElementSibling;
    [heading, prev, block, next].forEach(function (n) {
      if (n && out.indexOf(n) === -1) out.push(n);
    });
    // Order is document-natural by construction; dedup above handles heading === prev.
    return out;
  }

  const identityCodec = {
    compress: function (s) { return Promise.resolve(String(s == null ? '' : s)); },
    decompress: function (s) { return Promise.resolve(String(s == null ? '' : s)); }
  };

  const UI_ATTR = 'data-noteback-ui';
  const HL_CLASS = 'noteback-highlight';

  /** Nearest block-level ancestor of a node (fallback: the node itself). */
  function enclosingBlock(node, rootNode) {
    const BLOCK = /^(P|LI|PRE|BLOCKQUOTE|TD|TH|TR|DIV|SECTION|ARTICLE|H1|H2|H3|H4|H5|H6|UL|OL|TABLE|FIGURE)$/;
    let el = (node.nodeType === 1) ? node : node.parentElement;
    while (el && el !== rootNode) {
      if (el.tagName && BLOCK.test(String(el.tagName).toUpperCase())) return el;
      el = el.parentElement;
    }
    return (node.nodeType === 1) ? node : node.parentElement;
  }

  /** Clone a node and strip Noteback UI + unwrap highlight marks inside it. */
  function cleanClone(node) {
    const clone = node.cloneNode(true);
    const ui = clone.querySelectorAll ? clone.querySelectorAll('[' + UI_ATTR + ']') : [];
    for (let i = 0; i < ui.length; i++) { if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]); }
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
    const styles = doc.querySelectorAll ? doc.querySelectorAll('head style, style') : [];
    let out = '';
    for (let i = 0; i < styles.length; i++) {
      if (styles[i].getAttribute && styles[i].getAttribute(UI_ATTR)) continue; // skip our own
      out += (styles[i].textContent || '') + '\n';
    }
    return out;
  }

  /**
   * Build per-section snapshots for the given comments.
   * @param {Object} cfg
   * @param {Node} cfg.root        the painted content root (#noteback-doc-root)
   * @param {Document} cfg.doc
   * @param {Array} cfg.comments   current State.comments
   * @param {number} [cfg.maxSectionChars=8000]
   * @returns {{ sections: Array<{id,html}>, styles: string, sectionByCommentId: Object }}
   */
  function extractSections(cfg) {
    const root = cfg.root, doc = cfg.doc;
    const maxChars = cfg.maxSectionChars || 8000;
    const sections = [];
    const byBlock = []; // [{block, id}]
    const sectionByCommentId = {};

    (cfg.comments || []).forEach(function (c) {
      if (!c || c.anchor == null) return; // doc-level note: no section
      const mark = root.querySelector('mark.' + HL_CLASS + '[data-noteback-id="' + c.id + '"]');
      if (!mark) return; // orphaned / not painted
      const block = enclosingBlock(mark, root);
      let existing = null;
      for (let i = 0; i < byBlock.length; i++) { if (byBlock[i].block === block) { existing = byBlock[i]; break; } }
      if (existing) { sectionByCommentId[c.id] = existing.id; return; }

      const nodes = pickSectionNodes(block);
      const wrap = doc.createElement('div');
      nodes.forEach(function (n) { wrap.appendChild(cleanClone(n)); });
      let html = wrap.innerHTML;
      if (html.length > maxChars) { wrap.textContent = ''; wrap.appendChild(cleanClone(block)); html = wrap.innerHTML; }
      const id = 's' + (sections.length + 1);
      sections.push({ id: id, html: html });
      byBlock.push({ block: block, id: id });
      sectionByCommentId[c.id] = id;
    });

    return { sections: sections, styles: collectInlineStyles(doc), sectionByCommentId: sectionByCommentId };
  }

  return {
    isHeading: isHeading,
    findNearestHeading: findNearestHeading,
    pickSectionNodes: pickSectionNodes,
    enclosingBlock: enclosingBlock,
    extractSections: extractSections,
    collectInlineStyles: collectInlineStyles,
    identityCodec: identityCodec
  };
});
