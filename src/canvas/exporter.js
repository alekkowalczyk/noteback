/**
 * Noteback — canvas/exporter.js  (MIXED: pure builder + DOM download; dual-export)
 *
 * Responsibility: produce and persist the self-contained feedback canvas
 * (design spec §8.2 / §8.3, CONTRACTS.md §7).
 *
 *   - buildCanvasHtml(cfg) — PURE: fills canvas-template.html with the guiding
 *     HTML comment (§6), original doc markup, the state block (§5), and one
 *     inline <script> containing the concatenated runtime + a boot call using
 *     InFileStateAdapter. Touches no disk / DOM → testable under Node.
 *   - downloadCanvas(html, filename) — DOM: triggers a browser download
 *     (baseline, always available incl. file://).
 *   - saveCanvasInPlace(html, suggestedName) — DOM: feature-detected in-place
 *     save via the File System Access API in secure contexts; falls back to
 *     downloadCanvas.
 *
 * Dual-export so the pure builder is unit-testable under Node, while the DOM
 * helpers attach to `NotebackRuntime.exporter` in the browser.
 *
 * Public API (CONTRACTS.md §3.6):
 *   buildCanvasHtml({ docHtml, state, templateHtml, inlinedRuntime }) -> string
 *   downloadCanvas(html, filename) -> void
 *   saveCanvasInPlace(html, suggestedName) -> Promise<void>
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.exporter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Guiding HTML comment placed at the top of the canvas <body> (CONTRACTS.md §6).
  const GUIDING_COMMENT =
    '<!-- Noteback feedback canvas: each item is a quoted passage + a note. ' +
    'Please revise the document accordingly. -->';

  // The state block id/type the canvas + InFileStateAdapter agree on (§5).
  const STATE_BLOCK_ID = 'noteback-state';
  const STATE_BLOCK_TYPE = 'application/json';

  // The attribute marking Noteback's own injected UI (overlay/highlight modules).
  const UI_ATTR = 'data-noteback-ui';
  const HIGHLIGHT_CLASS = 'noteback-highlight';

  // The embedded-mode boot call appended after the inlined runtime. It wires the
  // InFileStateAdapter (reading the #noteback-state block) into the shared
  // boot() entry point, and re-builds a downloadable canvas after each in-place
  // save so a recipient can re-share with their comments included (spec §8.3).
  const EMBEDDED_BOOT = [
    '(function () {',
    "  'use strict';",
    '  var RT = (typeof window !== "undefined" ? window : this).NotebackRuntime || {};',
    '  if (!RT.boot || !RT.infileStateAdapter) return;',
    '  function start() {',
    '    var exporterApi = RT.exporter || {};',
    '    // Capture the canvas template (this very document, minus live state) so',
    '    // a re-shared download/save reflects the recipient\'s latest comments.',
    '    var latestState = null;',
    '    var inner = RT.infileStateAdapter.createInFileStateAdapter(document, {',
    '      onChange: function (s) { latestState = s; }',
    '    });',
    '    function normHref() {',
    '      try { var l = location; return (l.origin || (l.protocol + "//" + l.host)) + l.pathname; } catch (e) { return (typeof location !== "undefined" ? location.href : ""); }',
    '    }',
    '    var adapter = (RT.localStorageStateAdapter && typeof window !== "undefined" && window.localStorage)',
    '      ? RT.localStorageStateAdapter.createLocalStorageStateAdapter({',
    '          doc: document,',
    '          storage: window.localStorage,',
    '          inner: inner,',
    '          attachKey: normHref()',
    '        })',
    '      : inner;',
    '    function currentState() {',
    '      if (latestState) return latestState;',
    '      try {',
    '        var el = document.getElementById("' + STATE_BLOCK_ID + '");',
    '        var raw = el ? (el.textContent || "").trim() : "";',
    '        return raw ? JSON.parse(raw) : null;',
    '      } catch (e) { return null; }',
    '    }',
    '    function suggestedName() {',
    '      var t = (document.title || "noteback").replace(/ — Noteback feedback canvas$/, "");',
    '      t = t.replace(/[\\\\/:*?"<>|]+/g, "_").trim() || "noteback";',
    '      if (!/\\.html?$/i.test(t)) t += ".html";',
    '      return t;',
    '    }',
    '    function rebuildHtml() {',
    '      var stateEl = document.getElementById("' + STATE_BLOCK_ID + '");',
    '      var s = currentState();',
    '      if (stateEl && s) stateEl.textContent = JSON.stringify(s);',
    '      // The live document IS the canvas; serialize it as-is. Highlights/UI',
    '      // are re-painted by the embedded runtime on next open, so strip any',
    '      // injected UI before serializing.',
    '      var clone = document.documentElement.cloneNode(true);',
    '      var ui = clone.querySelectorAll("[' + UI_ATTR + '],mark.' + HIGHLIGHT_CLASS + '");',
    '      for (var i = 0; i < ui.length; i++) {',
    '        var n = ui[i];',
    '        if (n.tagName && n.tagName.toUpperCase() === "MARK") {',
    '          while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);',
    '          n.parentNode.removeChild(n);',
    '        } else if (n.parentNode) {',
    '          n.parentNode.removeChild(n);',
    '        }',
    '      }',
    '      return "<!DOCTYPE html>\\n" + clone.outerHTML;',
    '    }',
    '    // "HTML · clean copy": the original document with ALL Noteback removed —',
    '    // injected UI, highlights (unwrapped), the state block, the inlined runtime',
    '    // <script>, the #noteback-doc-root wrapper, the guiding comment, and the',
    '    // " — Noteback feedback canvas" title suffix.',
    '    function rebuildCleanHtml() {',
    '      var clone = document.documentElement.cloneNode(true);',
    '      var ui = clone.querySelectorAll("[' + UI_ATTR + ']");',
    '      for (var i = 0; i < ui.length; i++) { if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]); }',
    '      var marks = clone.querySelectorAll("mark.' + HIGHLIGHT_CLASS + '");',
    '      for (var j = 0; j < marks.length; j++) {',
    '        var mk = marks[j];',
    '        while (mk.firstChild) mk.parentNode.insertBefore(mk.firstChild, mk);',
    '        if (mk.parentNode) mk.parentNode.removeChild(mk);',
    '      }',
    '      var stEl = clone.querySelector("#' + STATE_BLOCK_ID + '");',
    '      if (stEl && stEl.parentNode) stEl.parentNode.removeChild(stEl);',
    '      var scripts = clone.querySelectorAll("script");',
    '      for (var k = 0; k < scripts.length; k++) {',
    '        var sc = scripts[k];',
    '        if (!sc.getAttribute("src") && /NotebackRuntime/.test(sc.textContent || "")) {',
    '          if (sc.parentNode) sc.parentNode.removeChild(sc);',
    '        }',
    '      }',
    '      var rootEl = clone.querySelector("#noteback-doc-root");',
    '      if (rootEl && rootEl.parentNode) {',
    '        while (rootEl.firstChild) rootEl.parentNode.insertBefore(rootEl.firstChild, rootEl);',
    '        rootEl.parentNode.removeChild(rootEl);',
    '      }',
    '      var titleEl = clone.querySelector("title");',
    '      if (titleEl) titleEl.textContent = (titleEl.textContent || "").replace(/ — Noteback feedback canvas$/, "");',
    '      var bodyEl = clone.querySelector("body");',
    '      if (bodyEl) {',
    '        var cn = bodyEl.childNodes, rm = [];',
    '        for (var c = 0; c < cn.length; c++) {',
    '          if (cn[c].nodeType === 8 && /Noteback feedback canvas/.test(cn[c].nodeValue || "")) rm.push(cn[c]);',
    '        }',
    '        for (var r = 0; r < rm.length; r++) if (rm[r].parentNode) rm[r].parentNode.removeChild(rm[r]);',
    '      }',
    '      return "<!DOCTYPE html>\\n" + clone.outerHTML;',
    '    }',
    '    var exporterHooks = {',
    '      onSaveCanvas: function () {',
    '        var html = rebuildHtml();',
    '        var name = suggestedName();',
    '        if (exporterApi.saveCanvasInPlace) return exporterApi.saveCanvasInPlace(html, name);',
    '        if (exporterApi.downloadCanvas) return exporterApi.downloadCanvas(html, name);',
    '        return Promise.resolve();',
    '      },',
    '      onSaveClean: function () {',
    '        var html = rebuildCleanHtml();',
    '        var name = suggestedName();',
    '        if (exporterApi.saveCanvasInPlace) return exporterApi.saveCanvasInPlace(html, name);',
    '        if (exporterApi.downloadCanvas) return exporterApi.downloadCanvas(html, name);',
    '        return Promise.resolve();',
    '      }',
    '      // PDF needs no hook: the overlay falls back to window.print(), and the',
    '      // runtime @media print rules render the clean document.',
    '    };',
    '    RT.boot.boot({',
    '      root: document.getElementById("noteback-doc-root") || document.body,',
    '      adapter: adapter,',
    '      exporter: exporterHooks,',
    '      history: (adapter.getHistory ? {',
    '        getHistory: function () { return adapter.getHistory(); },',
    '        getSection: function (ref) { return adapter.getSection(ref); },',
    '        clearCurrent: function () { return adapter.clearCurrent(); }',
    '      } : null),',
    '      docId: (typeof location !== "undefined" ? location.href : ""),',
    '      docTitle: suggestedName()',
    '    });',
    '  }',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", start);',
    '  } else {',
    '    start();',
    '  }',
    '})();'
  ].join('\n');

  /* ----------------------------------------------------------------------- *
   * PURE: build the canvas HTML string                                      *
   * ----------------------------------------------------------------------- */

  /**
   * Build the complete self-contained canvas HTML (PURE — no disk/DOM).
   *
   * @param {Object} cfg
   * @param {string} cfg.docHtml         Original document markup. May be the full
   *                                     <html> outerHTML (extension mode captures
   *                                     document.documentElement.outerHTML) or
   *                                     just the <body> inner markup.
   * @param {Object} cfg.state           Current annotation State (§2).
   * @param {string} cfg.templateHtml    canvas-template.html shell text.
   * @param {string} cfg.inlinedRuntime  Concatenated runtime source (anchor →
   *                                     boot, incl. InFileStateAdapter). The
   *                                     embedded boot call is appended here.
   * @returns {string} complete HTML document text.
   */
  function buildCanvasHtml(cfg) {
    cfg = cfg || {};
    const template = String(cfg.templateHtml == null ? '' : cfg.templateHtml);
    const state = cfg.state || {};
    const docBody = extractBodyMarkup(String(cfg.docHtml == null ? '' : cfg.docHtml));
    const docTitle = String(state.docTitle || 'document');

    const stateJson = safeStringify(state);
    const runtime = String(cfg.inlinedRuntime == null ? '' : cfg.inlinedRuntime);
    // Neutralize any literal "</script" in the runtime/boot source so it can't
    // prematurely close the inline <script> wrapper in a real browser. "<\/script"
    // is harmless inside JS comments, strings, and regexes.
    const inlined = escapeForInlineScript(
      runtime.replace(/\s*$/, '') + '\n\n' + EMBEDDED_BOOT + '\n'
    );

    // Fill every occurrence of each token, treating the replacement as a literal
    // string (a function avoids `$`-pattern interpretation in String.replace).
    let out = template;
    out = replaceToken(out, 'DOC_TITLE', escapeHtml(docTitle));
    out = replaceToken(out, 'GUIDING_COMMENT', GUIDING_COMMENT);
    out = replaceToken(out, 'DOC_BODY', docBody);
    out = replaceToken(out, 'STATE_JSON', escapeForJsonScript(stateJson));
    out = replaceToken(out, 'INLINED_RUNTIME', inlined);
    return out;
  }

  /** Replace every `{{NAME}}` occurrence with `value` (literal, all matches). */
  function replaceToken(str, name, value) {
    const re = new RegExp('\\{\\{' + name + '\\}\\}', 'g');
    return str.replace(re, function () { return value; });
  }

  /**
   * Reduce captured document markup to the inner markup of its <body>, stripping
   * Noteback's injected UI, painted highlights, the existing state block, and any
   * previously-inlined runtime <script>. Works on a string (no DOM) so the pure
   * builder runs under Node.
   *
   * Accepts either a full document (with <html>/<body>) or a bare body fragment;
   * if no <body> is present the input is treated as the fragment itself.
   *
   * @param {string} html
   * @returns {string} cleaned inner-body markup.
   */
  function extractBodyMarkup(html) {
    let body = html;

    // If a <body>…</body> exists, take its inner content.
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
    if (bodyMatch) {
      body = bodyMatch[1];
    } else {
      // No body tag: strip a leading <!DOCTYPE>, <html>, <head>…</head> if present
      // so we don't double-nest document scaffolding inside the template body.
      body = body.replace(/<!doctype[^>]*>/i, '');
      body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, '');
      body = body.replace(/<\/?html\b[^>]*>/gi, '');
      body = body.replace(/<\/?body\b[^>]*>/gi, '');
    }

    body = stripInjectedUi(body);
    return body.trim();
  }

  /**
   * Remove Noteback's own injected nodes from a markup string:
   *   - any element carrying data-noteback-ui (sidebar host, fab, injected
   *     <style data-noteback-ui>, clipboard textarea),
   *   - highlight <mark class="noteback-highlight"> wrappers (unwrapped: the
   *     inner text is preserved),
   *   - the existing #noteback-state script block (a fresh one is re-added),
   *   - the guiding HTML comment (a fresh one is re-added),
   *   - any prior inlined runtime <script> (heuristic: contains NotebackRuntime).
   *
   * String-based (no DOM); tolerant of attribute order and quoting.
   *
   * @param {string} markup
   * @returns {string}
   */
  function stripInjectedUi(markup) {
    let out = markup;

    // 1. Strip the guiding comment (any existing copy) — re-added by the template.
    out = out.split(GUIDING_COMMENT).join('');

    // 2. Remove the existing JSON state block (re-added fresh). Match by id.
    out = removeElementsById(out, 'script', STATE_BLOCK_ID);

    // 3. Remove elements that carry the data-noteback-ui attribute (with subtree).
    out = removeTaggedElements(out, UI_ATTR);

    // 4. Unwrap highlight <mark> wrappers, keeping their inner text.
    out = unwrapHighlightMarks(out);

    // 5. Remove a prior inlined runtime <script> (NotebackRuntime bootstrap).
    out = removeRuntimeScripts(out);

    // 6. Drop a leftover doc-root wrapper if the captured markup already had one
    //    (we re-wrap via the template's #noteback-doc-root). Unwrap, keep inner.
    out = unwrapDocRoot(out);

    return out;
  }

  /** Remove `<tag …>…</tag>` blocks whose opening tag matches `attr` (boolean-ish). */
  function removeTaggedElements(markup, attr) {
    let out = markup;
    let guard = 0;
    // Find an opening tag bearing the attribute, then remove through its matching
    // close (assuming no same-tag nesting inside our UI subtrees, which holds for
    // the injected host/fab/style/textarea elements).
    const openRe = new RegExp('<([a-zA-Z][\\w-]*)\\b[^>]*\\b' + attr + '\\b[^>]*>', 'i');
    let m;
    while ((m = openRe.exec(out)) && guard++ < 1000) {
      const tag = m[1];
      const startIdx = m.index;
      const afterOpen = startIdx + m[0].length;
      // Self-closing or void: just drop the opening tag.
      if (/\/>\s*$/.test(m[0]) || isVoidTag(tag)) {
        out = out.slice(0, startIdx) + out.slice(afterOpen);
        continue;
      }
      const closeIdx = findMatchingClose(out, tag, afterOpen);
      if (closeIdx === -1) {
        // No matching close found; drop just the opening tag to make progress.
        out = out.slice(0, startIdx) + out.slice(afterOpen);
        continue;
      }
      out = out.slice(0, startIdx) + out.slice(closeIdx);
    }
    return out;
  }

  /** Remove `<tag … id="value" …>…</tag>` blocks (matching by id attribute). */
  function removeElementsById(markup, tag, id) {
    let out = markup;
    let guard = 0;
    const openRe = new RegExp(
      '<' + tag + '\\b[^>]*\\bid\\s*=\\s*["\']' + escapeRegExp(id) + '["\'][^>]*>',
      'i'
    );
    let m;
    while ((m = openRe.exec(out)) && guard++ < 100) {
      const startIdx = m.index;
      const afterOpen = startIdx + m[0].length;
      const closeIdx = findMatchingClose(out, tag, afterOpen);
      if (closeIdx === -1) {
        out = out.slice(0, startIdx) + out.slice(afterOpen);
        continue;
      }
      out = out.slice(0, startIdx) + out.slice(closeIdx);
    }
    return out;
  }

  /** Remove `<script>…</script>` blocks whose body references NotebackRuntime. */
  function removeRuntimeScripts(markup) {
    let out = markup;
    let guard = 0;
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i;
    let m;
    while ((m = scriptRe.exec(out)) && guard++ < 200) {
      const body = m[1] || '';
      const startIdx = m.index;
      const endIdx = startIdx + m[0].length;
      // Leave the JSON state block alone (handled separately; type=application/json).
      const opening = m[0].slice(0, m[0].indexOf('>') + 1);
      const isJson = /type\s*=\s*["']application\/json["']/i.test(opening);
      if (!isJson && /NotebackRuntime/.test(body)) {
        out = out.slice(0, startIdx) + out.slice(endIdx);
      } else {
        // Skip past this script to look for the next one.
        // Re-run from after this match by temporarily splicing a marker is messy;
        // instead, recurse on the remainder and stitch.
        const head = out.slice(0, endIdx);
        const tail = removeRuntimeScripts(out.slice(endIdx));
        return head + tail;
      }
    }
    return out;
  }

  /** Unwrap `<mark class="noteback-highlight" …>inner</mark>` → `inner`. */
  function unwrapHighlightMarks(markup) {
    const re = new RegExp(
      '<mark\\b[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' +
        HIGHLIGHT_CLASS + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/mark\\s*>',
      'gi'
    );
    let prev;
    let out = markup;
    // Loop to handle nested/adjacent marks; bounded by length shrinking.
    do {
      prev = out;
      out = out.replace(re, '$1');
    } while (out !== prev);
    return out;
  }

  /** If the body is a single `<div id="noteback-doc-root">…</div>`, unwrap it. */
  function unwrapDocRoot(markup) {
    const m = /^\s*<div\b[^>]*\bid\s*=\s*["']noteback-doc-root["'][^>]*>([\s\S]*)<\/div\s*>\s*$/i.exec(
      markup
    );
    return m ? m[1] : markup;
  }

  /**
   * Find the index just past the matching `</tag>` for an opening `<tag>` whose
   * content begins at `from`, accounting for same-tag nesting.
   * @returns {number} index after the matching close, or -1 if not found.
   */
  function findMatchingClose(str, tag, from) {
    const openRe = new RegExp('<' + escapeRegExp(tag) + '\\b[^>]*?(\\/?)>', 'gi');
    const closeRe = new RegExp('<\\/' + escapeRegExp(tag) + '\\s*>', 'gi');
    let depth = 1;
    let i = from;
    while (i < str.length) {
      openRe.lastIndex = i;
      closeRe.lastIndex = i;
      const nextOpen = openRe.exec(str);
      const nextClose = closeRe.exec(str);
      if (!nextClose) return -1;
      if (nextOpen && nextOpen.index < nextClose.index) {
        // A nested open of the same tag (ignore self-closing).
        if (nextOpen[1] !== '/') depth++;
        i = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        i = nextClose.index + nextClose[0].length;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function isVoidTag(tag) {
    return /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag);
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function safeStringify(state) {
    try {
      return JSON.stringify(state);
    } catch (e) {
      return '{}';
    }
  }

  /**
   * Make a JSON string safe to embed inside <script type="application/json">.
   * The HTML tokenizer treats ANY <script> element's content as script data
   * (the `type` attribute only affects execution, not tokenization), so it can
   * be ended/derailed two ways:
   *   1. a literal "</script" ends the element;
   *   2. a literal "<!--" enters the legacy "script data escaped" state, after
   *      which a later "<script" makes it double-escaped and the real </script>
   *      is ignored.
   * We neutralize both. "\/" and "<" are BOTH valid JSON escapes (decoding
   * to "/" and "<"), so the block stays valid JSON and JSON.parse restores the
   * identical string, while the HTML tokenizer no longer sees the trigger bytes.
   */
  function escapeForJsonScript(json) {
    return String(json)
      .replace(/<\/(script)/gi, '<\\/$1')
      .replace(/<!--/g, '\\u003c!--');
  }

  /**
   * Make JS source safe to embed inside an inline <script> element. The HTML
   * tokenizer can swallow the closing </script> two ways:
   *   1. a literal "</script" ends the element directly;
   *   2. a literal "<!--" enters the legacy "script data escaped" state, after
   *      which a later "<script" makes it "double escaped" and the real
   *      </script> is ignored until EOF (the script then captures the closing
   *      tag as text → invalid JS → the canvas fails to boot).
   * We break BOTH triggers with a backslash, which is a no-op escape in JS
   * source comments / strings / regex literals ("<\/script" === "</script",
   * "<\!--" === "<!--"), so the executed behavior is unchanged. We deliberately
   * do NOT touch a lone "<script" — inserting "\" there would corrupt "\s"
   * inside regex literals, and once "<!--" is broken a lone "<script" can no
   * longer trigger the escaped state.
   */
  function escapeForInlineScript(src) {
    return String(src)
      .replace(/<\/(script)/gi, '<\\/$1')
      .replace(/<!--/g, '<\\!--');
  }

  /** Minimal HTML-escape for text inserted into element content / title. */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ----------------------------------------------------------------------- *
   * DOM: download + in-place save                                           *
   * ----------------------------------------------------------------------- */

  /**
   * Trigger a browser download of `html` (DOM). Baseline path — works on file://.
   * Uses a Blob + an <a download> click; revokes the object URL afterward.
   * @param {string} html
   * @param {string} filename
   */
  function downloadCanvas(html, filename) {
    const name = sanitizeFilename(filename);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    // Defer revocation so the download can start.
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /**
   * Feature-detected in-place save (DOM). In secure contexts that expose the
   * File System Access API, prompt the user to pick a file and overwrite it.
   * Falls back to downloadCanvas when unavailable, declined, or on error.
   * @param {string} html
   * @param {string} suggestedName
   * @returns {Promise<void>}
   */
  function saveCanvasInPlace(html, suggestedName) {
    const name = sanitizeFilename(suggestedName);
    const canPick =
      typeof window !== 'undefined' &&
      typeof window.showSaveFilePicker === 'function';

    if (!canPick) {
      downloadCanvas(html, name);
      return Promise.resolve();
    }

    return window
      .showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: 'HTML feedback canvas',
            accept: { 'text/html': ['.html', '.htm'] }
          }
        ]
      })
      .then(function (handle) {
        return handle.createWritable();
      })
      .then(function (writable) {
        return writable.write(html).then(function () {
          return writable.close();
        });
      })
      .catch(function (err) {
        // AbortError = user cancelled the picker → do nothing (don't double-save).
        if (err && err.name === 'AbortError') return;
        // Any other failure (permission, unsupported) → fall back to a download.
        downloadCanvas(html, name);
      });
  }

  /** Coerce a filename to something safe + .html-suffixed. */
  function sanitizeFilename(name) {
    let n = String(name == null ? '' : name).trim();
    // Replace only path separators, control characters, and characters illegal
    // in filenames. Keep hyphens / dots / underscores so ordinary names like
    // "my-spec.html" survive intact.
    n = n.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
    if (n === '') n = 'noteback';
    if (!/\.html?$/i.test(n)) n += '.html';
    return n;
  }

  return {
    GUIDING_COMMENT,
    STATE_BLOCK_ID,
    STATE_BLOCK_TYPE,
    EMBEDDED_BOOT,
    buildCanvasHtml,
    extractBodyMarkup,
    escapeForInlineScript,
    escapeForJsonScript,
    downloadCanvas,
    saveCanvasInPlace,
    sanitizeFilename
  };
});
