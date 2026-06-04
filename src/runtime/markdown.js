/**
 * Noteback runtime — markdown.js  (PURE LOGIC; dual-export)
 *
 * Responsibility: render the annotation State to the clean / neutral Markdown
 * of design spec §8.1 — readable by a human AND an AI, with no presumptuous
 * instructions.
 *
 * Runs BOTH in the browser (`NotebackRuntime.markdown`) and under Node tests
 * (`require('../src/runtime/markdown.js')`).
 *
 * Output shape (CONTRACTS.md §3.3):
 *   # Feedback on <docTitle>
 *   <N> comments — <YYYY-MM-DD>
 *
 *   1. > "<quote>" (lines 12–15)
 *      <body>
 *
 *   2. > "<quote>" (line 20)
 *      <body>
 *
 * Line references and quote condensing are OPT-IN via `opts.docHtml` — the
 * document's content markup. When supplied, each quoted passage is located in
 * it to emit a `(line N)` / `(lines A–B)` reference, and a long passage is
 * condensed to its first and last sentence(s) joined by " (…) " so the feedback
 * stays scannable. Without `docHtml`, output is the original quote-verbatim
 * format (CONTRACTS.md §3.3) — callers under Node tests rely on that.
 *
 * Public API:
 *   toMarkdown(state, opts?) -> string
 *     opts.date    YYYY-MM-DD; defaults to today.
 *     opts.docHtml document content markup; enables line refs + condensing.
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.markdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INDENT = '   '; // three spaces, aligning under "N. "

  // A quote longer than this (after collapsing whitespace) is condensed to its
  // first/last sentences rather than reproduced in full.
  const QUOTE_LIMIT = 200;
  // When falling back to a character window (few sentence breaks), how much of
  // the head and tail to keep.
  const WINDOW = 130;

  /** Format a Date as YYYY-MM-DD (local). */
  function today() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  /** Collapse all runs of whitespace (incl. newlines) to single spaces. */
  function collapseWs(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** Split prose into sentences, keeping terminal punctuation. */
  function splitSentences(text) {
    const parts = String(text).match(/[^.!?]*[.!?]+(?=\s|$)|[^.!?]+$/g);
    if (!parts) return [String(text).trim()].filter(Boolean);
    return parts.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /** Trim a head slice back to the last word boundary (avoid cutting a word). */
  function clipHead(s) {
    const sp = s.lastIndexOf(' ');
    return (sp > 40 ? s.slice(0, sp) : s).trim();
  }

  /** Trim a tail slice forward to the next word boundary. */
  function clipTail(s) {
    const sp = s.indexOf(' ');
    return (sp !== -1 && sp < s.length - 40 ? s.slice(sp + 1) : s).trim();
  }

  /**
   * Render a quote for display. Short quotes pass through whitespace-collapsed.
   * A long passage keeps its first and last sentence(s) joined by " (…) " so the
   * reader sees where it starts and ends without the whole span.
   * @param {string} quote
   * @returns {string}
   */
  function condenseQuote(quote) {
    const q = collapseWs(quote);
    if (q.length <= QUOTE_LIMIT) return q;

    const sents = splitSentences(q);
    if (sents.length >= 5) {
      const head = sents.slice(0, 2).join(' ');
      const tail = sents.slice(-2).join(' ');
      // Only condense if it actually drops a meaningful middle.
      if (head.length + tail.length < q.length - 20) return head + ' (…) ' + tail;
    }
    // Few sentence breaks but still long: keep a head + tail character window.
    return clipHead(q.slice(0, WINDOW)) + ' (…) ' + clipTail(q.slice(-WINDOW));
  }

  /** 1-based line number of a character index within `text`. */
  function lineAt(text, index) {
    let line = 1;
    const stop = Math.min(index, text.length);
    for (let i = 0; i < stop; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  /** Index of the `n`-th (0-based) occurrence of `needle`, or -1. */
  function nthIndexOf(haystack, needle, n) {
    let idx = -1;
    for (let k = 0; k <= n; k++) {
      idx = haystack.indexOf(needle, idx + 1);
      if (idx === -1) return -1;
    }
    return idx;
  }

  /** Locate `needle` in `haystack`, trying an HTML-entity-encoded variant too. */
  function findWithEntities(haystack, needle, from) {
    const start = from || 0;
    let idx = haystack.indexOf(needle, start);
    if (idx !== -1) return { idx: idx, len: needle.length };
    const enc = needle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    idx = haystack.indexOf(enc, start);
    if (idx !== -1) return { idx: idx, len: enc.length };
    return null;
  }

  /**
   * Locate a quoted passage within the document markup and return the 1-based
   * line range it spans, or null if it can't be found. The quote is the raw
   * flat-text slice; within a single block it appears verbatim between tags, so
   * a literal search works (honouring the anchor's `occurrence` for repeats).
   * When the selection crosses block boundaries the full string won't match
   * (intervening tags), so we fall back to locating its first and last lines
   * separately and span between them.
   * @param {string} docHtml
   * @param {string} quote
   * @param {number} occurrence
   * @returns {{start:number,end:number}|null}
   */
  function lineRangeOf(docHtml, quote, occurrence) {
    if (!docHtml || !quote) return null;

    // 1. Whole-quote match (single-block selection).
    const occ = typeof occurrence === 'number' && occurrence >= 0 ? occurrence : 0;
    let idx = nthIndexOf(docHtml, quote, occ);
    if (idx !== -1) return { start: lineAt(docHtml, idx), end: lineAt(docHtml, idx + quote.length) };
    const whole = findWithEntities(docHtml, quote, 0);
    if (whole) return { start: lineAt(docHtml, whole.idx), end: lineAt(docHtml, whole.idx + whole.len) };

    // 2. Cross-block fallback: anchor on the first and last lines of the quote.
    const qlines = quote.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (qlines.length < 2) return null;
    const head = findWithEntities(docHtml, qlines[0], 0);
    if (!head) return null;
    const tail = findWithEntities(docHtml, qlines[qlines.length - 1], head.idx + head.len);
    if (!tail) return null;
    return { start: lineAt(docHtml, head.idx), end: lineAt(docHtml, tail.idx + tail.len) };
  }

  /** Format a line range as "(line N)" or "(lines A–B)". */
  function formatLineRef(range) {
    if (!range) return '';
    return range.start === range.end
      ? ' (line ' + range.start + ')'
      : ' (lines ' + range.start + '–' + range.end + ')';
  }

  /**
   * @param {Object} state                 State per CONTRACTS.md §2.
   * @param {{date?: string}} [opts]        date as YYYY-MM-DD; defaults to today.
   * @returns {string} Markdown feedback document.
   */
  function toMarkdown(state, opts) {
    const o = opts || {};
    const date = o.date != null ? String(o.date) : today();
    const docHtml = o.docHtml != null ? String(o.docHtml) : '';
    const docTitle = state && state.docTitle != null ? String(state.docTitle) : '';
    const comments = (state && Array.isArray(state.comments)) ? state.comments : [];

    const n = comments.length;
    const noun = n === 1 ? 'comment' : 'comments';

    const lines = [];
    lines.push('# Feedback on ' + docTitle);
    lines.push(n + ' ' + noun + ' — ' + date);

    comments.forEach((c, i) => {
      lines.push(''); // blank line before each item (and after the header line)
      const anchor = c && c.anchor;
      const quote = anchor && anchor.quote != null ? String(anchor.quote) : '';
      const body = c && c.body != null ? String(c.body) : '';
      // A comment with no quote is a DOCUMENT-LEVEL note (anchor === null); render
      // it with a plain marker instead of an empty blockquote.
      if (quote === '') {
        lines.push((i + 1) + '. (note on the whole document)');
      } else {
        // Line reference (only when the doc markup is supplied) is computed from
        // the FULL quote; the displayed quote may be condensed.
        const ref = docHtml ? formatLineRef(lineRangeOf(docHtml, quote, anchor.occurrence)) : '';
        lines.push((i + 1) + '. > "' + condenseQuote(quote) + '"' + ref);
      }
      // Indent every line of a (possibly multi-line) body to align under the quote.
      const bodyLines = body.split('\n');
      for (const bl of bodyLines) {
        lines.push(INDENT + bl);
      }
    });

    // Trailing newline so the document ends cleanly.
    return lines.join('\n') + '\n';
  }

  return {
    toMarkdown,
    // exposed for unit tests
    condenseQuote,
    lineRangeOf
  };
});
