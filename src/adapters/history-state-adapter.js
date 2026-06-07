/**
 * Noteback — history-state-adapter.js  (MODE-AGNOSTIC; dual-export)
 *
 * The unified StorageAdapter both modes use. Wraps an inner StorageAdapter
 * (embedded: InFileStateAdapter; extension: null) + an injected async kv store
 * (localStorage- or chrome-backed) + the pure history core (draft-history-core).
 * Persists the current draft's comments under a doc-id and captures the FULL,
 * clean document snapshot once — at the version's FIRST comment. Exposes
 * load/save/getHistory/getVersion/clearCurrent for the overlay. Degrades to the
 * inner adapter (or a no-op) when the store/core is unavailable or the doc-id is
 * empty: comments still flow through `inner`; history methods return []/null/noop.
 *
 * Holds NO chrome.* / extension globals and NO localStorage access — the store and
 * inner adapter are injected by the mode-specific boot. The gzip codec uses
 * CompressionStream/Response (browser) with an identity fallback (Node).
 *
 * Attaches to NotebackRuntime.historyStateAdapter; dual-exported for Node tests.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.historyStateAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function rt() { const g = (typeof globalThis !== 'undefined') ? globalThis : this; return (g && g.NotebackRuntime) || {}; }

  /** gzip codec via CompressionStream when available; identity otherwise. */
  function makeCodec() {
    const hasCS = (typeof CompressionStream !== 'undefined') && (typeof Response !== 'undefined');
    const sc = rt().snapshotCapture;
    if (!hasCS) return (sc && sc.identityCodec) || { compress: (x) => Promise.resolve(x), decompress: (x) => Promise.resolve(x) };
    function toB64(b) { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return 'gz:' + btoa(s); }
    function fromB64(s) { const bin = atob(s.slice(3)); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
    return {
      compress: (str) => { try { const cs = new CompressionStream('gzip'); return new Response(new Response(str).body.pipeThrough(cs)).arrayBuffer().then((buf) => toB64(new Uint8Array(buf))); } catch (e) { return Promise.resolve(String(str)); } },
      decompress: (str) => { if (typeof str !== 'string' || str.slice(0, 3) !== 'gz:') return Promise.resolve(String(str == null ? '' : str)); try { return new Response(new Response(fromB64(str)).body.pipeThrough(new DecompressionStream('gzip'))).text(); } catch (e) { return Promise.resolve(''); } }
    };
  }

  /**
   * @param {Object} cfg
   * @param {Document} cfg.doc
   * @param {Object} cfg.store            async kv: get/set/remove/keys
   * @param {Object|null} cfg.inner       inner StorageAdapter (load/save) or null
   * @param {string} cfg.docId            resolved doc-id ('' → degrade)
   * @param {() => string} cfg.contentText  clean visible text for hashing
   * @param {() => string} cfg.captureSnapshot  clean full-doc HTML
   * @param {Object} [cfg.draftHistory]   override (tests); else rt().draftHistory
   * @param {Object} [cfg.codec]          override; else gzip-or-identity
   * @param {() => string} [cfg.now]
   * @param {() => boolean} [cfg.isEnabled]  when it returns false the adapter passes
   *   through to inner (no version/snapshot) and getHistory()/getVersion() report
   *   empty — used by the embedded gear's live opt-out. Defaults to always-true.
   */
  function createHistoryStateAdapter(cfg) {
    const doc = cfg.doc, inner = cfg.inner || null;
    const dhMod = cfg.draftHistory || rt().draftHistory;
    const now = cfg.now || (() => new Date().toISOString());
    const docId = String(cfg.docId == null ? '' : cfg.docId);
    const usable = !!(cfg.store && dhMod && dhMod.createDraftHistory && docId);
    const codec = cfg.codec || makeCodec();
    const dh = usable ? dhMod.createDraftHistory({ store: cfg.store, now: now, codec: codec }) : null;
    let resolved = null;
    const isEnabled = cfg.isEnabled || function () { return true; };
    function currentlyEnabled() { try { return !!isEnabled(); } catch (e) { return true; } }
    let lastEnabled = currentlyEnabled();

    function docTitle() { return (doc && doc.title) || ''; }

    function ensureResolved() {
      const en = currentlyEnabled();
      if (en !== lastEnabled) { resolved = null; lastEnabled = en; } // enabled flipped → re-resolve
      if (resolved) return Promise.resolve(resolved);
      const innerLoad = inner ? inner.load() : Promise.resolve(null);
      return innerLoad.then((innerState) => {
        const fallback = (innerState && innerState.comments) || [];
        // !usable OR disabled → degrade to inner: comments flow, no version written.
        if (!usable || !en) { resolved = { degraded: true, comments: fallback.slice(), versionKey: null, hasSnapshot: true }; return resolved; }
        return dh.resolve({ docId: docId, contentText: cfg.contentText ? cfg.contentText() : '', fallbackComments: fallback, docTitle: docTitle() })
          .then((r) => { resolved = { degraded: r.degraded, docId: r.docId, versionKey: r.versionKey, comments: r.comments, hasSnapshot: !!r.hasSnapshot }; return resolved; });
      });
    }

    return {
      load: function () {
        return ensureResolved().then((r) => ({ schemaVersion: 1, docId: docId, docTitle: docTitle(), comments: (r.comments || []).slice() }));
      },

      save: function (state) {
        const writeThrough = inner ? inner.save(state) : Promise.resolve();
        return ensureResolved().then((r) => {
          const comments = (state.comments || []).slice();
          r.comments = comments; // keep the in-memory current draft coherent for a later load()
          if (!usable || r.degraded) return writeThrough;
          const needSnapshot = comments.length > 0 && !r.hasSnapshot;
          const snapP = needSnapshot && cfg.captureSnapshot ? codec.compress(cfg.captureSnapshot()) : Promise.resolve('');
          return snapP.then((snap) => { if (snap) r.hasSnapshot = true; return dh.persist({ docId: docId, versionKey: r.versionKey, comments: comments, snapshotHtml: snap }); }).then(() => writeThrough);
        });
      },

      getHistory: function () {
        if (!usable) return Promise.resolve([]);
        return ensureResolved().then((r) => r.degraded ? [] : dh.history({ docId: docId, exceptVersionKey: r.versionKey }));
      },

      // The version key of THIS document's current content (its content hash, or the
      // h0:<docId> fallback). Used by checkout to bake "which version is live" into
      // the opened canvas so that tab can offer "open current". null when degraded.
      getCurrentVersionKey: function () {
        if (!usable) return Promise.resolve(null);
        return ensureResolved().then((r) => r.degraded ? null : r.versionKey);
      },

      // This doc's full history (doc record + every version record, snapshots
      // included) as a kv-key → value map, so "save with comments and history" can
      // embed it in the file. null when degraded or there's nothing stored.
      exportHistory: function () {
        if (!usable) return Promise.resolve(null);
        return ensureResolved().then((r) => (r.degraded || !dh.exportDoc) ? null : dh.exportDoc({ docId: docId }));
      },

      getVersion: function (ref) {
        if (!usable || !currentlyEnabled()) return Promise.resolve(null);
        return dh.version({ versionKey: ref.versionKey });
      },

      clearCurrent: function () {
        if (!usable) return Promise.resolve();
        return ensureResolved().then((r) => { if (r.degraded) return; r.comments = []; r.hasSnapshot = false; return dh.clearCurrent({ docId: docId, versionKey: r.versionKey }); });
      }
    };
  }

  return { createHistoryStateAdapter: createHistoryStateAdapter, makeCodec: makeCodec };
});
