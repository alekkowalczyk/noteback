/**
 * Noteback — localstorage-state-adapter.js  (DOM; browser global)
 *
 * Canvas binding for draft persistence + history. Decorates InFileStateAdapter:
 * persists the current draft's comments in localStorage (keyed by content hash)
 * AND writes through to the in-file block so the re-share path is unaffected.
 * Exposes getHistory/getSection/clearCurrent for the overlay. Degrades to the
 * inner adapter when localStorage is unavailable or the content guard fails.
 *
 * Attaches to NotebackRuntime.localStorageStateAdapter. The pure logic lives in
 * draft-history-core (which IS tested); the factory is also dual-exported so its
 * branching (degrade / write-through / cache coherence) is covered directly.
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.localStorageStateAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function rt() { const g = (typeof globalThis !== 'undefined') ? globalThis : this; return (g && g.NotebackRuntime) || {}; }

  /** Async kv store over window.localStorage (sync wrapped in Promises). */
  function localStorageStore(storage) {
    return {
      get: function (k) { try { const v = storage.getItem(k); return Promise.resolve(v == null ? null : JSON.parse(v)); } catch (e) { return Promise.resolve(null); } },
      set: function (k, v) { try { storage.setItem(k, JSON.stringify(v)); } catch (e) {} return Promise.resolve(); },
      remove: function (k) { try { storage.removeItem(k); } catch (e) {} return Promise.resolve(); },
      keys: function () { const out = []; try { for (let i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (e) {} return Promise.resolve(out); }
    };
  }

  /** gzip codec via CompressionStream when available; identity otherwise. */
  function makeCodec() {
    const hasCS = (typeof CompressionStream !== 'undefined') && (typeof Response !== 'undefined');
    if (!hasCS) { const s = rt().snapshot; return (s && s.identityCodec) || { compress: function (x) { return Promise.resolve(x); }, decompress: function (x) { return Promise.resolve(x); } }; }
    function toB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return 'gz:' + btoa(bin); }
    function fromB64(s) { const bin = atob(s.slice(3)); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
    return {
      compress: function (str) {
        try {
          const cs = new CompressionStream('gzip');
          const blobStream = new Response(str).body.pipeThrough(cs);
          return new Response(blobStream).arrayBuffer().then(function (buf) { return toB64(new Uint8Array(buf)); });
        } catch (e) { return Promise.resolve(String(str)); }
      },
      decompress: function (str) {
        if (typeof str !== 'string' || str.slice(0, 3) !== 'gz:') return Promise.resolve(String(str == null ? '' : str));
        try {
          const ds = new DecompressionStream('gzip');
          const stream = new Response(fromB64(str)).body.pipeThrough(ds);
          return new Response(stream).text();
        } catch (e) { return Promise.resolve(''); }
      }
    };
  }

  /**
   * @param {Object} cfg
   * @param {Document} cfg.doc
   * @param {Storage|null} cfg.storage   window.localStorage (null → degrade)
   * @param {Object} cfg.inner           InFileStateAdapter (load/save)
   * @param {string} cfg.attachKey       normalized location.href
   * @param {() => string} [cfg.now]
   * @param {Object} [cfg.draftHistory]  override (tests); else rt().draftHistory
   * @param {Object} [cfg.snapshot]      override (tests); else rt().snapshot
   */
  function createLocalStorageStateAdapter(cfg) {
    const doc = cfg.doc;
    const inner = cfg.inner;
    const dhMod = cfg.draftHistory || rt().draftHistory;
    const snapMod = cfg.snapshot || rt().snapshot;
    const now = cfg.now || function () { return new Date().toISOString(); };
    const usable = !!(cfg.storage && dhMod && dhMod.createDraftHistory);
    const codec = makeCodec();
    const dh = usable ? dhMod.createDraftHistory({ store: localStorageStore(cfg.storage), now: now, codec: codec }) : null;

    let resolved = null;       // { degraded, contentHash, lineageId, comments }
    let sectionByCommentId = {};

    function contentRoot() { return doc && doc.getElementById ? doc.getElementById('noteback-doc-root') : null; }
    function contentText() { const r = contentRoot(); return (r && r.textContent) || (doc && doc.body && doc.body.textContent) || ''; }

    function ensureResolved() {
      if (resolved) return Promise.resolve(resolved);
      if (!usable) return inner.load().then(function (s) { resolved = { degraded: true, comments: (s && s.comments) || [] }; return resolved; });
      return inner.load().then(function (innerState) {
        return dh.resolve({ contentText: contentText(), attachKey: cfg.attachKey, fallbackComments: (innerState && innerState.comments) || [], docTitle: (doc && doc.title) || '' });
      }).then(function (r) { resolved = r; return r; });
    }

    return {
      load: function () {
        return ensureResolved().then(function (r) {
          return inner.load().then(function (base) {
            base = base || { schemaVersion: 1, docId: '', docTitle: (doc && doc.title) || '', comments: [] };
            return { schemaVersion: 1, docId: base.docId, docTitle: base.docTitle, comments: (r.comments || []).slice() };
          });
        });
      },

      save: function (state) {
        const writeThrough = inner.save(state);
        if (!usable) {
          if (resolved) resolved.comments = (state.comments || []).slice();
          return writeThrough;
        }
        return ensureResolved().then(function (r) {
          r.comments = (state.comments || []).slice(); // keep the in-memory current draft coherent for a later load()
          if (r.degraded) return writeThrough;
          // Rebuild section snapshots from the painted root, compress once.
          let sections = [], styles = '';
          try {
            if (snapMod && snapMod.extractSections) {
              const ex = snapMod.extractSections({ root: contentRoot() || doc.body, doc: doc, comments: state.comments || [] });
              sectionByCommentId = ex.sectionByCommentId || {};
              styles = ex.styles || '';
              sections = ex.sections || [];
            }
          } catch (e) { sections = []; styles = ''; sectionByCommentId = {}; }
          return Promise.all([
            Promise.all(sections.map(function (s) { return codec.compress(s.html).then(function (h) { return { id: s.id, html: h }; }); })),
            codec.compress(styles)
          ]).then(function (parts) {
            return dh.persist({ contentHash: r.contentHash, comments: state.comments || [], sections: parts[0], styles: parts[1], sectionByCommentId: sectionByCommentId });
          }).then(function () { return writeThrough; });
        });
      },

      getHistory: function () {
        if (!usable) return Promise.resolve([]);
        return ensureResolved().then(function (r) {
          if (r.degraded) return [];
          return dh.history({ lineageId: r.lineageId, exceptHash: r.contentHash });
        });
      },

      getSection: function (commentRef) {
        if (!usable) return Promise.resolve(null);
        return dh.section({ contentHash: commentRef.contentHash, sectionId: commentRef.sectionId });
      },

      clearCurrent: function () {
        if (!usable) return Promise.resolve();
        return ensureResolved().then(function (r) {
          if (r.degraded) return; r.comments = [];
          return dh.clearCurrent({ contentHash: r.contentHash });
        });
      },

      // Exposed so the overlay can label a current comment's snapshot id if needed.
      sectionIdFor: function (commentId) { return sectionByCommentId[commentId] || null; }
    };
  }

  return { createLocalStorageStateAdapter: createLocalStorageStateAdapter, localStorageStore: localStorageStore };
});
