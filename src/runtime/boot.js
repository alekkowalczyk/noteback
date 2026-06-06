/**
 * Noteback runtime — boot.js  (DOM-ONLY; browser global)
 *
 * Responsibility: the SINGLE entry point used by BOTH modes. Given a
 * StorageAdapter (and optional exporter hooks), it loads (or creates) the
 * document State, mounts the overlay, paints initial highlights, and keeps the
 * highlights in sync after every overlay-driven mutation.
 *
 *   - Extension mode: content-script.js calls boot({ adapter: ChromeStorageAdapter }).
 *   - Embedded mode:  the inlined canvas script calls boot({ adapter: InFileStateAdapter }).
 *
 * Boot owns the live State and shares it with the overlay via getState/setState,
 * so the overlay and the highlight painter always agree on one State instance.
 * After each persisted change the overlay calls back into boot (onChange) and
 * boot repaints the highlights.
 *
 * Browser-only: attaches to `NotebackRuntime.boot`. No module.exports.
 *
 * Public API (CONTRACTS.md §3.7):
 *   boot({ root=document.body, adapter, exporter? }) ->
 *       Promise<{ destroy(), repaint(), getState(), getController(),
 *                 toggleSidebar(), openSidebar(), closeSidebar(),
 *                 copyMarkdown(), saveCanvas() }>
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.boot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function rt() {
    const g = typeof globalThis !== 'undefined' ? globalThis : this;
    return g.NotebackRuntime || {};
  }

  /**
   * Wire adapter + overlay + highlights for a document.
   * @param {Object} cfg
   * @param {Node} [cfg.root=document.body]
   * @param {Object} cfg.adapter           StorageAdapter (load/save).
   * @param {Object} [cfg.exporter]        Export hooks (onCopyMarkdown/onSaveCanvas).
   * @param {string} [cfg.docId]           Identity key; defaults to location.href.
   * @param {string} [cfg.docTitle]        Human label; defaults to document.title.
   * @returns {Promise<Object>} controller
   */
  async function boot(cfg) {
    cfg = cfg || {};

    // Single-mount guard. A page can carry BOTH an embedded canvas runtime and
    // the installed extension's content script — e.g. opening a saved canvas (or
    // an agent-wrapped doc) while the extension is on. Whichever calls boot first
    // sets the flag (synchronously, before any await) and wins; a second call
    // adopts that controller instead of mounting a duplicate overlay, which would
    // show two launchers/sidebars and split state across two stores (the canvas's
    // in-file JSON vs chrome.storage). The embedded canvas boots first — its inline
    // script runs before the content script's document_idle — so a received
    // canvas's own comments stay authoritative and the extension stands down.
    const g = (typeof globalThis !== 'undefined') ? globalThis
      : (typeof window !== 'undefined' ? window : this);
    if (g && g.__notebackBooted) {
      return g.__notebackController || null;
    }
    if (g) g.__notebackBooted = true;

    const modules = rt();
    const stateApi = modules.state;
    const highlightApi = modules.highlight;
    const overlayApi = modules.overlay;
    if (!stateApi) throw new Error('boot requires NotebackRuntime.state');
    if (!overlayApi) throw new Error('boot requires NotebackRuntime.overlay');

    const doc = (cfg.root && cfg.root.ownerDocument) ||
      (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('boot requires a DOM document');
    const rootNode = cfg.root || doc.body || doc.documentElement;

    const docId = cfg.docId != null ? cfg.docId :
      (typeof location !== 'undefined' ? location.href : '');
    const docTitle = cfg.docTitle != null ? cfg.docTitle :
      (doc.title || deriveTitle(docId));

    const adapter = cfg.adapter;

    /* --- load or create the live State --------------------------------- */
    let liveState = null;
    if (adapter && typeof adapter.load === 'function') {
      try {
        liveState = await adapter.load();
      } catch (e) {
        liveState = null;
      }
    }
    if (!liveState) {
      liveState = stateApi.createState(docId, docTitle);
    } else {
      // Keep identity/title fresh without discarding loaded comments.
      if (!liveState.docId) liveState.docId = docId;
      if (!liveState.docTitle) liveState.docTitle = docTitle;
    }

    const getState = function () { return liveState; };
    const setState = function (s) { if (s) liveState = s; };

    /* --- repaint highlights from the current State --------------------- */
    function repaint() {
      if (!highlightApi || typeof highlightApi.paintHighlights !== 'function') {
        return { painted: [], orphaned: [] };
      }
      return highlightApi.paintHighlights(rootNode, liveState, {});
    }

    /* --- mount the overlay, sharing the single State ------------------- */
    const controller = overlayApi.mountOverlay({
      root: rootNode,
      adapter: adapter,
      exporter: cfg.exporter || {},
      history: cfg.history || null,
      getState: getState,
      setState: setState,
      onChange: function () { repaint(); },
      toMarkdown: modules.markdown
        ? function (s) { return modules.markdown.toMarkdown(s); }
        : undefined
    });

    /* --- initial paint -------------------------------------------------- */
    repaint();

    function destroy() {
      if (highlightApi && typeof highlightApi.clearHighlights === 'function') {
        try { highlightApi.clearHighlights(rootNode); } catch (e) {}
      }
      if (controller && typeof controller.destroy === 'function') controller.destroy();
      // Release the single-mount guard so a later boot() can re-mount cleanly.
      if (g) { g.__notebackBooted = false; g.__notebackController = null; }
    }

    const bootApi = {
      destroy: destroy,
      repaint: repaint,
      getState: getState,
      setState: setState,
      getController: function () { return controller; },
      toggleSidebar: function () { return controller.toggleSidebar(); },
      openSidebar: function () { return controller.openSidebar(); },
      closeSidebar: function () { return controller.closeSidebar(); },
      copyMarkdown: function () { return controller.copyMarkdown(); },
      saveCanvas: function () { return controller.saveCanvas(); },
      saveClean: function () { return controller.saveClean(); },
      savePdf: function () { return controller.savePdf(); }
    };
    // Expose for the single-mount guard so a deferred second boot can adopt it.
    if (g) g.__notebackController = bootApi;
    return bootApi;
  }

  /** Derive a friendly title from a path/URL (last segment). */
  function deriveTitle(docId) {
    const s = String(docId == null ? '' : docId);
    if (s === '') return 'document';
    const noHash = s.split('#')[0].split('?')[0];
    const parts = noHash.split('/');
    const last = parts[parts.length - 1] || parts[parts.length - 2] || s;
    return last || s;
  }

  return { boot: boot };
});
