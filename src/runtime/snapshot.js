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

  return {
    isHeading: isHeading,
    findNearestHeading: findNearestHeading,
    pickSectionNodes: pickSectionNodes,
    identityCodec: identityCodec
  };
});
