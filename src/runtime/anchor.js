/**
 * Noteback runtime — anchor.js  (PURE LOGIC; dual-export)
 *
 * Responsibility: text-quote (W3C / Hypothesis-style) anchoring over a
 * document's plain text. Stores `quote` + `prefix`/`suffix` context +
 * `occurrence` index so a highlight survives minor DOM/whitespace differences
 * and can be re-found on load (or reported as an orphan when the doc changed).
 *
 * Runs BOTH in the browser (attaches to `NotebackRuntime.anchor`) and under
 * Node's built-in test runner (`require('../src/runtime/anchor.js')`).
 *
 * Public API (see CONTRACTS.md §3.1):
 *   getDocumentText(root) -> string
 *   describeAnchor(docText, startIndex, endIndex, contextLen=32)
 *       -> { quote, prefix, suffix, occurrence }
 *   findAnchor(docText, anchor) -> { start, end } | null   // null = orphaned
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.anchor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CONTEXT_LEN = 32;

  /**
   * Extract the full searchable text of a root node.
   * In the browser this is the rendered text of the subtree; we use
   * `textContent` which is stable and DOM-implementation independent. Works on
   * any object exposing a `textContent` string (handy for tests).
   * @param {Node} root
   * @returns {string}
   */
  function getDocumentText(root) {
    if (root == null) return '';
    if (typeof root.textContent === 'string') return root.textContent;
    return String(root);
  }

  /**
   * Collapse all runs of whitespace to a single space, building a parallel
   * index map back to the ORIGINAL string offsets so a match found in the
   * normalized space can be projected back onto the original text.
   *
   * @param {string} text
   * @returns {{ norm: string, map: number[] }}
   *   `norm` is the whitespace-normalized text; `map[i]` is the original-text
   *   offset of the character at normalized offset `i`. `map[norm.length]`
   *   holds `text.length` as an end sentinel.
   */
  function normalizeWithMap(text) {
    let norm = '';
    const map = [];
    let inWs = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        // Collapse a run of whitespace into a single space anchored at the
        // FIRST whitespace char of the run.
        if (!inWs) {
          norm += ' ';
          map.push(i);
          inWs = true;
        }
      } else {
        norm += ch;
        map.push(i);
        inWs = false;
      }
    }
    map.push(text.length); // end sentinel
    return { norm, map };
  }

  /** Whitespace-collapse a quote/context fragment for normalized comparison. */
  function normalizeFragment(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ');
  }

  /**
   * Build an anchor descriptor from a selected substring of `docText`.
   * @param {string} docText
   * @param {number} startIndex
   * @param {number} endIndex   exclusive
   * @param {number} [contextLen=32]
   * @returns {{quote:string, prefix:string, suffix:string, occurrence:number}}
   */
  function describeAnchor(docText, startIndex, endIndex, contextLen) {
    const len = typeof contextLen === 'number' ? contextLen : DEFAULT_CONTEXT_LEN;
    const text = String(docText == null ? '' : docText);
    const start = Math.max(0, Math.min(startIndex, text.length));
    const end = Math.max(start, Math.min(endIndex, text.length));

    const quote = text.slice(start, end);
    const prefix = text.slice(Math.max(0, start - len), start);
    const suffix = text.slice(end, Math.min(text.length, end + len));

    // occurrence = how many times this exact quote substring appears strictly
    // before `start` in the original text (0-based index of THIS match).
    let occurrence = 0;
    if (quote.length > 0) {
      let idx = text.indexOf(quote);
      while (idx !== -1 && idx < start) {
        occurrence++;
        idx = text.indexOf(quote, idx + 1);
      }
    }

    return { quote, prefix, suffix, occurrence };
  }

  /**
   * Find every normalized match of `quote` within `docText`, returned as
   * original-text ranges. Matches are non-overlapping, left-to-right.
   * @returns {Array<{start:number, end:number}>}
   */
  function findAllMatches(docText, quote) {
    const normQuote = normalizeFragment(quote).trim();
    if (normQuote.length === 0) return [];

    const { norm, map } = normalizeWithMap(docText);
    const matches = [];
    let from = 0;
    // Match the quote allowing the surrounding doc to have collapsed-but-still
    // present whitespace; we search the trimmed normalized quote.
    while (true) {
      const at = norm.indexOf(normQuote, from);
      if (at === -1) break;
      const start = map[at];
      const end = map[at + normQuote.length];
      matches.push({ start, end });
      from = at + normQuote.length;
    }
    return matches;
  }

  /**
   * Re-find an anchor's character range within `docText`.
   *
   * Strategy:
   *  1. Collect all whitespace-normalized matches of `quote`.
   *  2. If the stored `occurrence` index is in range, use it directly.
   *  3. Otherwise (the doc changed) fall back to prefix/suffix context to pick
   *     the best surviving match.
   *  4. If nothing matches at all, the comment is an ORPHAN → return null.
   *
   * @param {string} docText
   * @param {{quote:string, prefix:string, suffix:string, occurrence:number}} anchor
   * @returns {{start:number, end:number}|null}  null when orphaned.
   */
  function findAnchor(docText, anchor) {
    if (!anchor || typeof anchor.quote !== 'string' || anchor.quote.trim() === '') {
      return null;
    }
    const text = String(docText == null ? '' : docText);
    const matches = findAllMatches(text, anchor.quote);
    if (matches.length === 0) return null;

    const occurrence = typeof anchor.occurrence === 'number' ? anchor.occurrence : 0;

    // Happy path: the recorded occurrence still resolves.
    if (occurrence >= 0 && occurrence < matches.length) {
      // If multiple matches exist, prefer the recorded occurrence UNLESS
      // prefix/suffix context points decisively at a different one (doc edited
      // above the anchor). We only override when exactly one match satisfies
      // the context and the recorded occurrence does not.
      if (matches.length === 1) return matches[0];

      const scored = scoreByContext(text, matches, anchor);
      const best = scored[0];
      const recorded = matches[occurrence];
      // If the context-best match is unambiguously better than the recorded
      // one, trust context; otherwise honor the recorded occurrence.
      if (best.match === recorded || best.score === 0) return recorded;
      const recordedScore = scored.find((s) => s.match === recorded).score;
      return best.score > recordedScore ? best.match : recorded;
    }

    // Stale occurrence: pick the best match by surrounding context.
    const scored = scoreByContext(text, matches, anchor);
    return scored[0].match;
  }

  /**
   * Rank matches by how well the document text immediately around each one
   * agrees with the stored prefix/suffix. Higher score = better.
   * @returns {Array<{match:{start:number,end:number}, score:number}>} sorted desc.
   */
  function scoreByContext(text, matches, anchor) {
    const wantPrefix = normalizeFragment(anchor.prefix || '');
    const wantSuffix = normalizeFragment(anchor.suffix || '');

    const scored = matches.map((m) => {
      const beforeRaw = text.slice(0, m.start);
      const afterRaw = text.slice(m.end);
      const before = normalizeFragment(beforeRaw);
      const after = normalizeFragment(afterRaw);

      let score = 0;
      if (wantPrefix) score += commonSuffixLen(before, wantPrefix);
      if (wantSuffix) score += commonPrefixLen(after, wantSuffix);
      return { match: m, score };
    });

    // Stable sort: highest score first, ties keep document order.
    scored.sort((a, b) => b.score - a.score || a.match.start - b.match.start);
    return scored;
  }

  /** Length of the longest common suffix of `a` and `b`. */
  function commonSuffixLen(a, b) {
    let i = 0;
    const max = Math.min(a.length, b.length);
    while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  /** Length of the longest common prefix of `a` and `b`. */
  function commonPrefixLen(a, b) {
    let i = 0;
    const max = Math.min(a.length, b.length);
    while (i < max && a[i] === b[i]) i++;
    return i;
  }

  return {
    DEFAULT_CONTEXT_LEN,
    getDocumentText,
    describeAnchor,
    findAnchor
  };
});
