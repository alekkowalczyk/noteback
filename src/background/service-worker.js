/**
 * Noteback — service-worker.js  (MV3 background; service-worker global)
 *
 * Responsibility:
 *   - Toolbar action: toggle the in-page sidebar (message the active tab's
 *     content script). Only relevant if the action has no popup; with the popup
 *     present (manifest "action.default_popup"), the popup drives the toggle and
 *     this is a fallback.
 *   - "Save as HTML canvas" assembly: on the NOTEBACK_EXPORT_CANVAS message from
 *     the content script (which supplies the page HTML + current State), fetch
 *     each runtime file's text via fetch(chrome.runtime.getURL(path)) in
 *     dependency order (CONTRACTS.md §4), concatenate into one inlined runtime
 *     blob, fetch the canvas template, call exporter.buildCanvasHtml, then
 *     trigger a download via the `downloads` API (data: URL — service workers
 *     have no DOM/Blob-URL).
 *   - Onboarding / file-URL check: detect whether "Allow access to file URLs"
 *     is enabled and surface guidance (spec §9), and open the extension's
 *     details page on request.
 *
 * The exporter's PURE builder is reused here via importScripts (it attaches to
 * self.NotebackRuntime.exporter and references no DOM at load time).
 */

'use strict';

// Pull in the pure builder. exporter.js attaches to self.NotebackRuntime.exporter
// and only touches DOM/window inside its download helpers (not called here).
try {
  importScripts('/src/canvas/exporter.js');
} catch (e) {
  // If this fails the export path degrades gracefully (handled below).
}

// Runtime files inlined into a canvas, in dependency order (CONTRACTS.md §4).
const CANVAS_RUNTIME_FILES = [
  'src/runtime/anchor.js',
  'src/runtime/state.js',
  'src/runtime/markdown.js',
  'src/runtime/highlight.js',
  'src/runtime/overlay.js',
  'src/adapters/infile-state-adapter.js',
  'src/canvas/exporter.js',
  'src/runtime/boot.js'
];

const CANVAS_TEMPLATE_PATH = 'src/canvas/canvas-template.html';

/* ----------------------------------------------------------------------- *
 * Messaging                                                               *
 * ----------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'NOTEBACK_EXPORT_CANVAS':
      // Content script supplies docHtml + state (it already has the DOM/State).
      exportCanvas({
        docId: msg.docId,
        docTitle: msg.docTitle,
        docHtml: msg.docHtml,
        state: msg.state
      }).then(
        function (result) { sendResponse({ ok: true, downloadId: result }); },
        function (err) {
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        }
      );
      return true; // async response

    case 'NOTEBACK_EXPORT_CLEAN':
      // Content script supplies the already-cleaned HTML (Noteback UI stripped,
      // highlights unwrapped). We only name it and trigger the download.
      exportClean({
        docId: msg.docId,
        docTitle: msg.docTitle,
        cleanHtml: msg.cleanHtml
      }).then(
        function (result) { sendResponse({ ok: true, downloadId: result }); },
        function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
      );
      return true; // async response

    case 'NOTEBACK_CHECK_FILE_ACCESS':
      checkFileUrlAccess().then(
        function (allowed) { sendResponse({ ok: true, allowed: allowed }); },
        function (err) {
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        }
      );
      return true;

    case 'NOTEBACK_OPEN_EXTENSION_DETAILS':
      openExtensionDetails().then(
        function () { sendResponse({ ok: true }); },
        function (err) {
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        }
      );
      return true;

    case 'NOTEBACK_TOGGLE_SIDEBAR_VIA_WORKER':
      // Fallback: popup or external caller asks the worker to toggle the sidebar
      // in a specific (or the active) tab.
      resolveTabId(msg.tabId).then(function (tabId) {
        return toggleSidebar(tabId);
      }).then(
        function () { sendResponse({ ok: true }); },
        function (err) {
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        }
      );
      return true;

    default:
      return false;
  }
});

// If the action has NO popup (e.g. a future build), clicking the toolbar icon
// toggles the sidebar directly. With a popup configured this never fires, but
// wiring it keeps both modes working.
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(function (tab) {
    if (tab && tab.id != null) {
      toggleSidebar(tab.id).catch(function () {});
    }
  });
}

/* ----------------------------------------------------------------------- *
 * Sidebar toggle                                                          *
 * ----------------------------------------------------------------------- */

/**
 * Toggle the sidebar in the given tab by messaging its content script.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function toggleSidebar(tabId) {
  return sendToTab(tabId, { type: 'NOTEBACK_TOGGLE_SIDEBAR' }).then(function () {});
}

/* ----------------------------------------------------------------------- *
 * Canvas export + download                                                *
 * ----------------------------------------------------------------------- */

/**
 * Assemble the self-contained feedback canvas for a document and download it.
 * @param {{docId:string, docTitle:string, docHtml:string, state:Object}} input
 * @returns {Promise<number>} the downloads API download id.
 */
function exportCanvas(input) {
  input = input || {};
  const exporter = getExporter();
  if (!exporter || typeof exporter.buildCanvasHtml !== 'function') {
    return Promise.reject(new Error('exporter unavailable in service worker'));
  }

  return Promise.all([fetchInlinedRuntime(), fetchTemplate()]).then(function (parts) {
    const inlinedRuntime = parts[0];
    const templateHtml = parts[1];

    const html = exporter.buildCanvasHtml({
      docHtml: input.docHtml || '',
      state: input.state || { schemaVersion: 1, docId: input.docId || '', docTitle: input.docTitle || 'document', comments: [] },
      templateHtml: templateHtml,
      inlinedRuntime: inlinedRuntime
    });

    const filename = suggestedFilename(input.docTitle, input.docId);
    return triggerDownload(html, filename);
  });
}

/**
 * Download a clean (Noteback-free) copy of the document. The content script has
 * already stripped our UI and unwrapped highlights, so there is no assembly to
 * do — just name it and hand it to the downloads API.
 * @param {{docId:string, docTitle:string, cleanHtml:string}} input
 * @returns {Promise<number>} the downloads API download id.
 */
function exportClean(input) {
  input = input || {};
  const html = String(input.cleanHtml || '');
  if (!html) return Promise.reject(new Error('no clean HTML provided'));
  const filename = suggestedFilename(input.docTitle, input.docId);
  return triggerDownload(html, filename);
}

/** Fetch + concatenate every runtime file in dependency order. */
function fetchInlinedRuntime() {
  const reads = CANVAS_RUNTIME_FILES.map(function (path) {
    return fetchText(path).then(function (text) {
      // A banner comment per file aids debugging the inlined blob.
      return '/* ===== ' + path + ' ===== */\n' + text;
    });
  });
  return Promise.all(reads).then(function (chunks) {
    return chunks.join('\n\n');
  });
}

/** Fetch the canvas template shell text. */
function fetchTemplate() {
  return fetchText(CANVAS_TEMPLATE_PATH);
}

/** Fetch an extension-packaged file's text via its runtime URL. */
function fetchText(path) {
  const url = chrome.runtime.getURL(path);
  return fetch(url).then(function (resp) {
    if (!resp.ok) throw new Error('failed to fetch ' + path + ' (' + resp.status + ')');
    return resp.text();
  });
}

/**
 * Trigger a download of `html` as `filename` via the downloads API. Service
 * workers have no Blob URL / <a download>, so we use a data: URL (HTML is text;
 * we percent-encode it to survive arbitrary bytes).
 * @returns {Promise<number>} download id.
 */
function triggerDownload(html, filename) {
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  return new Promise(function (resolve, reject) {
    let maybePromise;
    try {
      maybePromise = chrome.downloads.download(
        { url: dataUrl, filename: filename, saveAs: true },
        function (downloadId) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(downloadId);
        }
      );
    } catch (e) {
      reject(e);
      return;
    }
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  });
}

/* ----------------------------------------------------------------------- *
 * Onboarding / file-URL access                                           *
 * ----------------------------------------------------------------------- */

/**
 * Detect whether the extension can access file:// URLs ("Allow access to file
 * URLs" toggle, spec §9). Uses chrome.extension.isAllowedFileSchemeAccess when
 * available; resolves true on http(s)/localhost contexts where the toggle is
 * irrelevant.
 * @returns {Promise<boolean>}
 */
function checkFileUrlAccess() {
  return new Promise(function (resolve) {
    try {
      if (chrome.extension && typeof chrome.extension.isAllowedFileSchemeAccess === 'function') {
        chrome.extension.isAllowedFileSchemeAccess(function (allowed) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { resolve(false); return; }
          resolve(!!allowed);
        });
        return;
      }
    } catch (e) { /* fall through */ }
    // API unavailable → conservatively report "unknown" as not-allowed so the
    // popup can still surface guidance; callers treat non-file pages separately.
    resolve(false);
  });
}

/**
 * Open this extension's details page (chrome://extensions/?id=...), where the
 * "Allow access to file URLs" toggle lives. chrome:// can't be opened via
 * tabs.create from a content script, but the service worker can.
 * @returns {Promise<void>}
 */
function openExtensionDetails() {
  const id = chrome.runtime.id;
  const url = 'chrome://extensions/?id=' + id;
  return new Promise(function (resolve, reject) {
    try {
      chrome.tabs.create({ url: url }, function () {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) { reject(new Error(err.message || String(err))); return; }
        resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

/* ----------------------------------------------------------------------- *
 * Helpers                                                                 *
 * ----------------------------------------------------------------------- */

/** Resolve the exporter API attached by importScripts (or null). */
function getExporter() {
  const g = (typeof self !== 'undefined') ? self : globalThis;
  return g.NotebackRuntime && g.NotebackRuntime.exporter;
}

/** Resolve a tabId argument, falling back to the active tab in the current window. */
function resolveTabId(tabId) {
  if (tabId != null) return Promise.resolve(tabId);
  return new Promise(function (resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) { reject(new Error(err.message || String(err))); return; }
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) { reject(new Error('no active tab')); return; }
      resolve(tab.id);
    });
  });
}

/** Promise-wrapped chrome.tabs.sendMessage. */
function sendToTab(tabId, message) {
  return new Promise(function (resolve, reject) {
    let maybePromise;
    try {
      maybePromise = chrome.tabs.sendMessage(tabId, message, function (resp) {
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

/** Build a friendly .html filename from the doc title / id. */
function suggestedFilename(docTitle, docId) {
  const exporter = getExporter();
  let base = String(docTitle || '').trim();
  if (base === '' && docId) {
    const noHash = String(docId).split('#')[0].split('?')[0];
    const parts = noHash.split('/');
    base = parts[parts.length - 1] || parts[parts.length - 2] || 'noteback';
  }
  if (base === '') base = 'noteback';
  // Drop a redundant canvas suffix and re-add .html via the exporter's sanitizer.
  base = base.replace(/ — Noteback feedback canvas$/, '');
  if (exporter && typeof exporter.sanitizeFilename === 'function') {
    return exporter.sanitizeFilename(base);
  }
  base = base.replace(/[\\/:*?"<>|]+/g, '_');
  if (!/\.html?$/i.test(base)) base += '.html';
  return base;
}
