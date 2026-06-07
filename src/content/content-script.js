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
 *   { type: 'NOTEBACK_COPY_HTML', clean } -> { ok:true } (builds + copies HTML)
 *   { type: 'NOTEBACK_SAVE_CANVAS' }     -> { ok:true } (kicks off save flow)
 *   { type: 'NOTEBACK_GET_STATE' }       -> { ok:true, state }
 *   { type: 'NOTEBACK_GET_DOC_HTML' }    -> { ok:true, docHtml, docId, docTitle }
 * Outbound (to the service worker) for canvas assembly + download:
 *   { type: 'NOTEBACK_EXPORT_CANVAS', docId, docTitle, docHtml, state }
 *   { type: 'NOTEBACK_BUILD_CANVAS', docId, docTitle, docHtml, state } -> { ok, html }
 */

(function () {
  'use strict';

  // Stand down if THIS isolated world already booted — a duplicate content-script
  // injection. boot.js sets __notebackBooted on the global it sees; for us that is
  // the ISOLATED world's global, so this catches a re-injection but NOT an embedded
  // canvas that booted in the page's MAIN world (different globalThis). That
  // cross-world case is handled just below, through the shared DOM.
  if (window.__notebackBooted) return;

  const RT = window.NotebackRuntime || {};

  // Defensive: if the shared runtime didn't load (unexpected), do nothing rather
  // than throw into the page.
  if (!RT.boot || !RT.chromeStorageAdapter) {
    return;
  }

  // Stand down if the page is itself a Noteback *canvas*: its inlined runtime boots
  // at DOMContentLoaded (before our document_idle) and mounts an overlay into the
  // shared light DOM. Content scripts share the DOM but NOT JS globals with the
  // page, so the canvas's main-world __notebackBooted is invisible above — we
  // detect its overlay through the DOM instead (boot.js stamps a synchronous
  // [data-noteback-ui] mount marker). Mounting again would show two launchers and
  // split state between the canvas's localStorage/in-file history and chrome.storage.
  if (RT.originPolicy && typeof RT.originPolicy.overlayMounted === 'function' &&
      RT.originPolicy.overlayMounted(document)) {
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

  // History doc-id: a baked attribute (the page is itself a wrapped canvas) wins;
  // else a per-URL minted id, persisted in chrome.storage under
  // `nb:url:<normalizedHref>` (fragment stripped, so #hash routes share a bucket),
  // so the same page maps to a stable history bucket across reloads. Distinct
  // from `docId` (location.href) above, which keys the comments-only
  // ChromeStorageAdapter and the export identity — those are unchanged.
  function resolveDocId() {
    const rootEl = document.getElementById('noteback-doc-root');
    const baked = rootEl && rootEl.getAttribute && rootEl.getAttribute('data-noteback-doc-id');
    if (baked) return Promise.resolve(baked);
    // fragment-independent: same doc across #hash routes
    const normHref = (location.href || '').split('#')[0];
    const urlKey = 'nb:url:' + normHref;
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(urlKey, function (items) {
          let id = items && items[urlKey];
          if (id) return resolve(id);
          id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          const bag = {};
          bag[urlKey] = id;
          chrome.storage.local.set(bag, function () { resolve(id); });
        });
      } catch (e) { resolve(''); }
    });
  }

  /* --- adapter ------------------------------------------------------------- */

  // The StorageAdapter is built per-mount (async), gated by the origin's history
  // opt-in: see buildAdapter() / mount(). The comments-only ChromeStorageAdapter
  // is the fallback when history is not allowed (or the kv store is unavailable).

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

  /**
   * Save a clean copy: the document with Noteback's UI removed and highlight
   * <mark> wrappers unwrapped (docContentHtml), downloaded as a standalone .html.
   * The worker has the `downloads` privilege; we just supply the bytes.
   */
  function onSaveClean(state) {
    return sendToWorker({
      type: 'NOTEBACK_EXPORT_CLEAN',
      docId: docId,
      docTitle: docTitle,
      cleanHtml: '<!DOCTYPE html>\n' + docContentHtml()
    });
  }

  /**
   * Build the requested HTML for the clipboard (shared by the sidebar's
   * onCopyHtml hook and the popup's NOTEBACK_COPY_HTML message). Clean HTML is
   * built in-page; the with-feedback canvas is assembled by the service worker
   * (only it can fetch the runtime files) and returned as a string. The caller
   * writes the result to the clipboard.
   * @param {Object} state
   * @param {{clean?:boolean}} [opts]
   * @returns {Promise<string>}
   */
  function onCopyHtml(state, opts) {
    if (opts && opts.clean) {
      return Promise.resolve('<!DOCTYPE html>\n' + docContentHtml());
    }
    return sendToWorker({
      type: 'NOTEBACK_BUILD_CANVAS',
      docId: docId,
      docTitle: docTitle,
      docHtml: collectDocHtml(),
      state: state
    }).then(function (resp) {
      if (resp && resp.ok && typeof resp.html === 'string') return resp.html;
      throw new Error((resp && resp.error) || 'canvas build failed');
    });
  }

  const exporter = {
    onCopyMarkdown: onCopyMarkdown,
    onCopyHtml: onCopyHtml,
    onSaveCanvas: onSaveCanvas,
    onSaveClean: onSaveClean
  };

  /* --- boot ---------------------------------------------------------------- */

  /* --- activation lifecycle ----------------------------------------------- */

  const policy = RT.originPolicy || null;
  const SETTINGS_KEY = (policy && policy.SETTINGS_KEY) || 'nb:settings';
  const originType = policy ? policy.classifyOrigin(location) : 'other';
  const origin = policy ? policy.originOf(location) : location.origin;

  let controller = null;
  let active = false;
  let ready = Promise.resolve(null); // always resolves to the current controller (or null)

  /**
   * Build the StorageAdapter (and optional history wiring) for this mount.
   * When history is allowed for the page's origin and the chrome-backed kv store
   * + a resolved history doc-id are both available, run the unified history
   * engine over chrome.storage. Otherwise fall back to the comments-only
   * ChromeStorageAdapter (today's behavior — unchanged). chrome.* lives only here
   * and in the kv/chrome-storage adapters.
   * @param {Object|null} settings  per-origin policy settings (null on force-activate).
   * @returns {Promise<{adapter:Object, history:Object|null}>}
   */
  function buildAdapter(settings) {
    const historyOk = !!(policy && policy.historyAllowed &&
      policy.historyAllowed({ type: originType, origin: origin }, settings));
    if (!historyOk || !RT.historyStateAdapter || !RT.chromeKvStore || !RT.snapshotCapture) {
      return Promise.resolve({
        adapter: RT.chromeStorageAdapter.createChromeStorageAdapter(docId),
        history: null
      });
    }
    return resolveDocId().then(function (historyDocId) {
      // createChromeKvStore THROWS eagerly if chrome.storage.local is missing —
      // catch (don't .catch()) and degrade to the comments-only path.
      let kv = null;
      try { kv = RT.chromeKvStore.createChromeKvStore(chrome); } catch (e) { kv = null; }
      if (!kv || !historyDocId) {
        return {
          adapter: RT.chromeStorageAdapter.createChromeStorageAdapter(docId),
          history: null
        };
      }
      const adapter = RT.historyStateAdapter.createHistoryStateAdapter({
        doc: document,
        store: kv,
        inner: null,
        docId: historyDocId,
        contentText: function () {
          try { return (document.getElementById('noteback-doc-root') || document.body).textContent || ''; }
          catch (e) { return ''; }
        },
        captureSnapshot: function () { return RT.snapshotCapture.captureCleanDoc(document); }
      });
      return {
        adapter: adapter,
        history: (adapter.getHistory ? {
          getHistory: function () { return adapter.getHistory(); },
          getVersion: function (ref) { return adapter.getVersion(ref); },
          clearCurrent: function () { return adapter.clearCurrent(); }
        } : null)
      };
    });
  }

  function mount(settings) {
    if (active) return ready;
    active = true;
    ready = buildAdapter(settings)
      .then(function (built) {
        return RT.boot.boot({
          root: document.body || document.documentElement,
          adapter: built.adapter,
          exporter: exporter,
          history: built.history,
          docId: docId,
          docTitle: docTitle
        });
      })
      .then(function (c) { controller = c; return c; })
      .catch(function () { controller = null; return null; });
    return ready;
  }

  function unmount() {
    if (!active) return;
    active = false;
    if (controller && typeof controller.destroy === 'function') {
      try { controller.destroy(); } catch (e) { /* ignore */ }
    }
    controller = null;
    ready = Promise.resolve(null);
  }

  function shouldActivate(settings) {
    if (!policy) return true; // fail open if the module is somehow missing
    return policy.isActive({ type: originType, origin: origin }, settings);
  }

  function applySettings(settings) {
    // The history-vs-comments gate is decided at FIRST mount (mount() early-returns
    // when already active); only the activate/deactivate transition is live, so a
    // per-site history opt-in change takes effect on reload, not immediately.
    if (shouldActivate(settings)) mount(settings);
    else unmount();
  }

  // Click-to-activate (unsupported origins). When the popup injects us on an
  // 'other' origin via activeTab, it first sets window.__notebackForceActivate.
  // The user's click IS the opt-in, so we mount unconditionally and do NOT
  // consult nb:settings (the per-type/per-site predicate governs only
  // file/localhost/127). Such pages also ignore live settings changes.
  if (window.__notebackForceActivate) {
    mount();
  } else {
    // Initial decision from stored settings.
    readSettings().then(applySettings);

    // React live to popup-driven changes (no page reload needed).
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[SETTINGS_KEY]) return;
        applySettings(changes[SETTINGS_KEY].newValue || null);
      });
    }
  }

  function readSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(SETTINGS_KEY, function (items) {
          const err = chrome.runtime && chrome.runtime.lastError;
          resolve((!err && items && items[SETTINGS_KEY]) || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  /* --- message listener (popup / toolbar / service worker) ----------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    switch (msg.type) {
      case 'NOTEBACK_PING':
        sendResponse({
          ok: true,
          booted: active,
          dormant: !active,
          originType: originType,
          origin: origin,
          docId: docId,
          docTitle: docTitle
        });
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

      case 'NOTEBACK_COPY_HTML':
        ready.then(function (c) {
          if (!c) { sendResponse({ ok: false, error: 'not booted' }); return; }
          onCopyHtml(c.getState(), { clean: !!msg.clean })
            .then(function (html) { return copyToClipboard(html); })
            .then(function (ok) {
              if (!ok) throw new Error('clipboard write failed');
              sendResponse({ ok: true });
            })
            .catch(function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); });
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

      case 'NOTEBACK_SAVE_CLEAN':
        ready.then(function (c) {
          if (!c) { sendResponse({ ok: false, error: 'not booted' }); return; }
          Promise.resolve(c.saveClean()).then(
            function () { sendResponse({ ok: true }); },
            function (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
          );
        });
        return true;

      case 'NOTEBACK_SAVE_PDF':
        ready.then(function (c) {
          if (!c) { sendResponse({ ok: false, error: 'not booted' }); return; }
          Promise.resolve(c.savePdf()).then(
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
      // Pass the document content markup so each quote gets a line reference.
      return RT.markdown.toMarkdown(state, { docHtml: docContentHtml() });
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

  /**
   * The document's markup with Noteback's own UI removed and highlight <mark>
   * wrappers unwrapped — used for markdown line references. Based on the full
   * <html> so line numbers track the actual .html file the user opened.
   */
  function docContentHtml() {
    try {
      const el = document.documentElement;
      if (!el || typeof el.cloneNode !== 'function') return '';
      const clone = el.cloneNode(true);
      const ui = clone.querySelectorAll('[data-noteback-ui]');
      for (let i = 0; i < ui.length; i++) {
        if (ui[i].parentNode) ui[i].parentNode.removeChild(ui[i]);
      }
      const marks = clone.querySelectorAll('mark.noteback-highlight');
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        const p = m.parentNode;
        if (!p) continue;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      }
      return clone.outerHTML || '';
    } catch (e) {
      return '';
    }
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
