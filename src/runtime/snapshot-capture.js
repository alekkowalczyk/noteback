/**
 * Noteback runtime — snapshot-capture.js  (PURE-ISH; dual-export)
 *
 * Produces a clean document snapshot — no Noteback UI elements
 * (`data-noteback-ui`), no highlight `<mark>` wrappers, no `#noteback-state`
 * script block, and no inlined runtime scripts — suitable for history storage.
 *
 * Two capture paths:
 *   `captureCleanDoc(doc?)` — DOM path used in production in BOTH extension
 *       and embedded-canvas modes. Clones `documentElement`, removes nodes,
 *       and serialises to HTML. Handles nested/same-name tags correctly.
 *   `stripNotebackFromHtml(html)` — string-only regex path used exclusively
 *       by Node unit tests (no DOM available). Good enough for flat/shallow
 *       fixture HTML; does NOT handle all nesting edge cases.
 *
 * Also exports:
 *   `identityCodec` — no-op Promise codec (compress/decompress return the
 *       string unchanged) used as the gzip fallback when compression is
 *       unavailable.
 *
 * Runs in the browser (`NotebackRuntime.snapshotCapture`) and under Node
 * (`module.exports`). No DOM access outside `captureCleanDoc`; no chrome.*.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.snapshotCapture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var identityCodec = {
    compress: function (s) { return Promise.resolve(String(s == null ? '' : s)); },
    decompress: function (s) { return Promise.resolve(String(s == null ? '' : s)); }
  };

  function captureCleanDoc(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return '';
    var clone = d.documentElement.cloneNode(true);

    // Remove all noteback UI elements
    var ui = clone.querySelectorAll('[data-noteback-ui]');
    for (var i = 0; i < ui.length; i++) {
      if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]);
    }

    // Unwrap highlight marks (replace <mark> with its children)
    var marks = clone.querySelectorAll('mark.noteback-highlight');
    for (var j = 0; j < marks.length; j++) {
      var m = marks[j];
      var p = m.parentNode;
      if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    }

    // Remove noteback-state block
    var st = clone.querySelector('#noteback-state');
    if (st && st.parentNode) st.parentNode.removeChild(st);

    // Remove inline runtime scripts (no src attr, body contains NotebackRuntime)
    var scripts = clone.querySelectorAll('script');
    for (var k = 0; k < scripts.length; k++) {
      var sc = scripts[k];
      if (!sc.getAttribute('src') && /NotebackRuntime/.test(sc.textContent || '')) {
        if (sc.parentNode) sc.parentNode.removeChild(sc);
      }
    }

    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  function stripNotebackFromHtml(html) {
    var out = String(html || '');

    // Remove elements with data-noteback-ui. Backreference \1 closes on the
    // same tag name, but [\s\S]*? is non-greedy and does NOT handle nested
    // same-name tags — a stray closing tag may remain. This is the string-only
    // test path; the DOM path (captureCleanDoc) removes nodes and is correct.
    out = out.replace(/<([a-z][a-z0-9]*)\b[^>]*\bdata-noteback-ui\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

    // Remove noteback-state script block (matched by id attribute)
    out = out.replace(/<script\b[^>]*\bid\s*=\s*["']noteback-state["'][^>]*>[\s\S]*?<\/script\s*>/gi, '');

    // Remove inline runtime scripts (no src attribute, contains NotebackRuntime)
    // Pattern: <script with no src>, body contains NotebackRuntime, close </script>
    out = out.replace(/<script\b[^>]*>([^<]|<(?!\/script))*NotebackRuntime([^<]|<(?!\/script))*<\/script\s*>/gi, '');

    // Unwrap highlight marks: <mark ... class="noteback-highlight" ...>text</mark> -> text
    out = out.replace(/<mark\b[^>]*\bnoteback-highlight\b[^>]*>([\s\S]*?)<\/mark\s*>/gi, '$1');

    return out;
  }

  return {
    identityCodec: identityCodec,
    captureCleanDoc: captureCleanDoc,
    stripNotebackFromHtml: stripNotebackFromHtml
  };
});
