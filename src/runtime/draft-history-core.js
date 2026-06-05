/**
 * Noteback runtime — draft-history-core.js  (PURE-ISH; dual-export)
 *
 * Storage-agnostic core for content-hash draft identity, lineage grouping, and
 * GC. Talks to an injected async key-value `store` + `codec`; never touches the
 * DOM, localStorage, or chrome.*. Runs in the browser
 * (`NotebackRuntime.draftHistory`) and under Node tests (`module.exports`).
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.draftHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_HASH_CHARS = 32;

  /** Trim + collapse all whitespace runs to a single space (case preserved). */
  function normalizeText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /** cyrb53 — fast 53-bit non-crypto string hash (public domain). */
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0);
    let h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /**
   * Content hash over normalized visible text. Returns null when the normalized
   * text is below the small-content guard (no stable identity).
   * @returns {string|null}
   */
  function contentHash(text) {
    const norm = normalizeText(text);
    if (norm.length < MIN_HASH_CHARS) return null;
    return cyrb53(norm, 0).toString(36) + '-' + cyrb53(norm, 0x9e3779b9).toString(36);
  }

  return { MIN_HASH_CHARS, normalizeText, contentHash, cyrb53 };
});
