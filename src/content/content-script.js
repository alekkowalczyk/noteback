/**
 * Noteback — content-script.js  (EXTENSION mode entry; browser global)
 *
 * Responsibility: extension-mode boot. Runs as the LAST content script after the
 * shared runtime files have populated `NotebackRuntime`. It:
 *   1. derives docId/docTitle from the current location,
 *   2. constructs a ChromeStorageAdapter,
 *   3. wires the export hooks (Copy as Markdown, Save as HTML canvas) that talk
 *      to the service worker,
 *   4. calls NotebackRuntime.boot.boot({ adapter, exporter }),
 *   5. listens for toolbar / popup / service-worker messages (toggle sidebar,
 *      run export, fetch State / page HTML for canvas assembly).
 *
 * Loaded ONLY in extension mode (listed after chrome-storage-adapter.js in the
 * manifest content_scripts array). NOT inlined into the saved canvas.
 *
 * --- Message protocol (content script = the in-tab receiver) ------------------
 * Inbound (from popup / toolbar / service worker), `chrome.runtime.onMessage`:
 *   { type: 'NOTEBACK_PING' }            -> { ok:true, booted, docId, docTitle }
 *   { type: 'NOTEBACK_TOGGLE_SIDEBAR' }  -> { ok:true }
 *   { type: 'NOTEBACK_OPEN_SIDEBAR' }    -> { ok:true }
 *   { type: 'NOTEBACK_CLOSE_SIDEBAR' }   -> { ok:true }
 *   { type: 'NOTEBACK_COPY_MARKDOWN' }   -> { ok:true, markdown } (also copies)
 *   { type: 'NOTEBACK_SAVE_CANVAS' }     -> { ok:true } (kicks off save flow)
 *   { type: 'NOTEBACK_GET_STATE' }       -> { ok:true, state }
 *   { type: 'NOTEBACK_GET_DOC_HTML' }    -> { ok:true, docHtml, docId, docTitle }
 * Outbound (to the service worker) for canvas assembly + download:
 *   { type: 'NOTEBACK_EXPORT_CANVAS', docId, docTitle, docHtml, state }
 */

(function () {
  'use strict';

  // Guard: only boot once per page.
  if (window.__notebackBooted) return;
  window.__notebackBooted = true;

  const RT = window.NotebackRuntime || {};

  // Defensive: if the shared runtime didn't load (unexpected), do nothing rather
  // than throw into the page.
  if (!RT.boot || !RT.chromeStorageAdapter) {
    return;
  }

  /* --- identity ------------------------------------------------------------ */

  const docId = location.href;
  const docTitle = deriveTitle();

  function deriveTitle() {
    const t = (document.title || '').trim();
    if (t) return t;
    const path = location.pathname || '';
    const last = path.split('/').filter(Boolean).pop();
    return last || location.href;
  }

  /* --- adapter ------------------------------------------------------------- */

  const adapter = RT.chromeStorageAdapter.createChromeStorageAdapter(docId);

  /* --- export hooks (wired into the overlay via boot) ---------------------- */

  /**
   * Copy as Markdown: render the current State with the markdown module and
   * copy via the Clipboard API (with an execCommand fallback for file://, which
   * is not a secure context and may lack navigator.clipboard).
   */
  async function onCopyMarkdown(state) {
    const md = renderMarkdown(state);
    const ok = await copyToClipboard(md);
    if (!ok) throw new Error('clipboard write failed');
    return md;
  }

  /**
   * Save as HTML canvas: hand the assembly off to the service worker, which has
   * the privilege to fetch runtime files (chrome.runtime.getURL) and trigger a
   * download. We supply the page HTML + current State so the worker doesn't have
   * to re-read the tab.
   */
  function onSaveCanvas(state) {
    return sendToWorker({
      type: 'NOTEBACK_EXPORT_CANVAS',
      docId: docId,
      docTitle: docTitle,
      docHtml: collectDocHtml(),
      state: state
    });
  }

  const exporter = {
    onCopyMarkdown: onCopyMarkdown,
    onSaveCanvas: onSaveCanvas
  };

  /* --- boot ---------------------------------------------------------------- */

  let controller = null;
  const ready = RT.boot
    .boot({
      root: document.body || document.documentElement,
      adapter: adapter,
      exporter: exporter,
      docId: docId,
      docTitle: docTitle
    })
    .then(function (c) {
      controller = c;
      return c;
    })
    .catch(function () {
      controller = null;
      return null;
    });

  /* --- message listener (popup / toolbar / service worker) ----------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    switch (msg.type) {
      case 'NOTEBACK_PING':
        sendResponse({ ok: true, booted: true, docId: docId, docTitle: docTitle });
        return false;

      case 'NOTEBACK_GET_STATE':
        ready.then(function (c) {
          sendResponse({ ok: true, state: c ? c.getState() : null });
        });
        return true; // async response

      case 'NOTEBACK_GET_DOC_HTML':
        sendResponse({
          ok: true,
          docHtml: collectDocHtml(),
          docId: docId,
          docTitle: docTitle
        });
        return false;

      case 'NOTEBACK_TOGGLE_SIDEBAR':
        ready.then(function (c) {
          if (c) c.toggleSidebar();
          sendResponse({ ok: !!c });
        });
        return true;

      case 'NOTEBACK_OPEN_SIDEBAR':
        ready.then(function (c) {
          if (c) c.openSidebar();
          sendResponse({ ok: !!c });
        });
        return true;

      case 'NOTEBACK_CLOSE_SIDEBAR':
        ready.then(function (c) {
          if (c) c.closeSidebar();
          sendResponse({ ok: !!c });
        });
        return true;

      case 'NOTEBACK_COPY_MARKDOWN':
        ready.then(function (c) {
          const state = c ? c.getState() : null;
          onCopyMarkdown(state).then(
            function (md) { sendResponse({ ok: true, markdown: md }); },
            function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
          );
        });
        return true;

      case 'NOTEBACK_SAVE_CANVAS':
        ready.then(function (c) {
          if (!c) { sendResponse({ ok: false, error: 'not booted' }); return; }
          // Route through the overlay's saveCanvas so the user gets the same
          // toast/feedback as clicking the sidebar button.
          Promise.resolve(c.saveCanvas()).then(
            function () { sendResponse({ ok: true }); },
            function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
          );
        });
        return true;

      default:
        return false;
    }
  });

  /* --- helpers ------------------------------------------------------------- */

  /** Render State to Markdown via the runtime module (with a tiny fallback). */
  function renderMarkdown(state) {
    if (RT.markdown && typeof RT.markdown.toMarkdown === 'function') {
      return RT.markdown.toMarkdown(state);
    }
    // Minimal fallback so copy still produces something useful.
    const comments = (state && Array.isArray(state.comments)) ? state.comments : [];
    const title = (state && state.docTitle) || docTitle;
    const lines = ['# Feedback on ' + title, comments.length + ' comments', ''];
    comments.forEach(function (c, i) {
      lines.push((i + 1) + '. > "' + ((c.anchor && c.anchor.quote) || '') + '"');
      lines.push('   ' + (c.body || ''));
      lines.push('');
    });
    return lines.join('\n');
  }

  /**
   * Capture the document markup for canvas assembly. We grab the full document
   * (outerHTML of <html>) so the saved canvas renders identically; the exporter
   * is responsible for stripping our injected UI / runtime when it rebuilds.
   */
  function collectDocHtml() {
    const el = document.documentElement;
    return el ? el.outerHTML : (document.body ? document.body.outerHTML : '');
  }

  /** Send a message to the service worker, resolving with its response. */
  function sendToWorker(message) {
    return new Promise(function (resolve, reject) {
      let maybePromise;
      try {
        maybePromise = chrome.runtime.sendMessage(message, function (resp) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
        return;
      }
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    });
  }

  /**
   * Copy text to the clipboard. Prefers navigator.clipboard in secure contexts
   * (localhost/https); falls back to a hidden-textarea execCommand('copy'),
   * which is required for file:// pages (not a secure context).
   */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.setAttribute('data-noteback-ui', 'clip');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }
})();
