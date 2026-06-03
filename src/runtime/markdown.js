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
 *   1. > "<quote>"
 *      <body>
 *
 *   2. > "<quote>"
 *      <body>
 *
 * Public API:
 *   toMarkdown(state, opts?) -> string     // opts.date defaults to today (YYYY-MM-DD)
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.markdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INDENT = '   '; // three spaces, aligning under "N. "

  /** Format a Date as YYYY-MM-DD (local). */
  function today() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  /**
   * @param {Object} state                 State per CONTRACTS.md §2.
   * @param {{date?: string}} [opts]        date as YYYY-MM-DD; defaults to today.
   * @returns {string} Markdown feedback document.
   */
  function toMarkdown(state, opts) {
    const o = opts || {};
    const date = o.date != null ? String(o.date) : today();
    const docTitle = state && state.docTitle != null ? String(state.docTitle) : '';
    const comments = (state && Array.isArray(state.comments)) ? state.comments : [];

    const n = comments.length;
    const noun = n === 1 ? 'comment' : 'comments';

    const lines = [];
    lines.push('# Feedback on ' + docTitle);
    lines.push(n + ' ' + noun + ' — ' + date);

    comments.forEach((c, i) => {
      lines.push(''); // blank line before each item (and after the header line)
      const quote = c && c.anchor && c.anchor.quote != null ? String(c.anchor.quote) : '';
      const body = c && c.body != null ? String(c.body) : '';
      lines.push((i + 1) + '. > "' + quote + '"');
      // Indent every line of a (possibly multi-line) body to align under the quote.
      const bodyLines = body.split('\n');
      for (const bl of bodyLines) {
        lines.push(INDENT + bl);
      }
    });

    // Trailing newline so the document ends cleanly.
    return lines.join('\n') + '\n';
  }

  return { toMarkdown };
});
