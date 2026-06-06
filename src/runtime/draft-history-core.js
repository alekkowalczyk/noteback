/**
 * Noteback runtime — draft-history-core.js  (PURE-ISH; dual-export)
 *
 * Storage-agnostic, pure history engine keyed by an explicit doc-id. Each
 * document owns an ordered list of versions; a version is keyed by content hash
 * (`cyrb53`-based), or `h0:<docId>` when the content is too short to hash
 * reliably. The whole clean document is snapshotted once (via `codec.compress`)
 * at a version's first comment; subsequent `persist` calls update comments only.
 * `resolve` initialises or looks up a version; `history` returns past versions
 * newest-first; `version` decompresses a snapshot; `clearCurrent` wipes a
 * version's comments and snapshot. Retention is enforced on every `resolve`/
 * `persist`: snapshot window, metadata window, TTL, and a global byte cap.
 * Talks to an injected async key-value `store` + `codec`; never touches the
 * DOM, localStorage, or chrome.*. Runs in the browser
 * (`NotebackRuntime.draftHistory`) and under Node tests (`module.exports`).
 */
(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.draftHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_HASH_CHARS = 32;

  /** Trim + collapse all whitespace runs to a single space (case preserved). */
  function normalizeText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /** cyrb53 — fast 53-bit non-crypto string hash (public domain). */
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /**
   * Content hash over normalized visible text. Returns null when the normalized
   * text is below the small-content guard (no stable identity).
   * @returns {string|null}
   */
  function contentHash(text) {
    const norm = normalizeText(text);
    if (norm.length < MIN_HASH_CHARS) return null;
    return cyrb53(norm, 0).toString(36) + '-' + cyrb53(norm, 0x9e3779b9).toString(36);
  }

  const DOC = 'nb:doc:';
  const VER = 'nb:ver:';

  function defaultLimits(l) {
    l = l || {};
    return { snapshotDrafts: l.snapshotDrafts || 5, metaDrafts: l.metaDrafts || 15, ttlDays: l.ttlDays || 90, maxBytes: l.maxBytes || 3000000 };
  }

  /**
   * @param {Object} cfg
   * @param {Object} cfg.store    async kv: get/set/remove/keys
   * @param {() => string} cfg.now  ISO timestamp
   * @param {Object} cfg.codec    { compress(str)->Promise<str>, decompress(str)->Promise<str> }
   * @param {Object} [cfg.limits]
   */
  function createDraftHistory(cfg) {
    const store = cfg.store;
    const now = cfg.now || (() => new Date().toISOString());
    const codec = cfg.codec || { compress: (s) => Promise.resolve(s), decompress: (s) => Promise.resolve(s) };
    const limits = defaultLimits(cfg.limits);

    const docKey = (id) => DOC + id;
    const verKey = (k) => VER + k;

    function ensureDoc(docId, versionKey, docTitle) {
      return store.get(docKey(docId)).then((d) => {
        d = { schemaVersion: 1, docId: docId, docTitle: (d && d.docTitle) || String(docTitle || ''), versions: (d && d.versions ? d.versions.slice() : []) };
        if (d.versions.indexOf(versionKey) === -1) d.versions.push(versionKey);
        return store.set(docKey(docId), d);
      });
    }

    function resolve(opts) {
      const docId = String(opts.docId == null ? '' : opts.docId);
      if (!docId) return Promise.resolve({ degraded: true, docId: null, versionKey: null, contentHash: null, comments: opts.fallbackComments || [] });
      const hash = contentHash(opts.contentText);
      const versionKey = hash || ('h0:' + docId);
      return store.get(verKey(versionKey)).then((ver) => {
        if (ver) {
          return ensureDoc(docId, versionKey, opts.docTitle).then(() => prune(docId, versionKey))
            .then(() => ({ degraded: false, docId: docId, versionKey: versionKey, contentHash: hash, comments: (ver.comments || []).slice(), hasSnapshot: !!ver.snapshotHtml }));
        }
        ver = { schemaVersion: 1, versionKey: versionKey, docId: docId, contentHash: hash,
          comments: (opts.fallbackComments || []).slice(), snapshotHtml: '', createdAt: now(), lastEditedAt: now(), docTitle: String(opts.docTitle || '') };
        return store.set(verKey(versionKey), ver).then(() => ensureDoc(docId, versionKey, opts.docTitle)).then(() => prune(docId, versionKey))
          .then(() => ({ degraded: false, docId: docId, versionKey: versionKey, contentHash: hash, comments: (opts.fallbackComments || []).slice(), hasSnapshot: false }));
      });
    }

    function persist(p) {
      return store.get(verKey(p.versionKey)).then((ver) => {
        if (!ver) return; // resolve() must run first
        ver = Object.assign({}, ver);
        ver.comments = (p.comments || []).slice();
        if (p.snapshotHtml != null && p.snapshotHtml !== '' && !ver.snapshotHtml) ver.snapshotHtml = p.snapshotHtml; // capture once
        ver.lastEditedAt = now();
        return store.set(verKey(p.versionKey), ver).then(() => prune(ver.docId || p.docId, p.versionKey));
      });
    }

    function history(q) {
      return store.get(docKey(q.docId)).then((doc) => {
        if (!doc) return [];
        const keys = doc.versions.slice().reverse(); // newest first
        const out = [];
        return keys.reduce((chain, k) => chain.then(() => {
          if (k === q.exceptVersionKey) return;
          return store.get(verKey(k)).then((ver) => {
            if (ver && ver.comments && ver.comments.length > 0) {
              out.push({ versionKey: k, docId: ver.docId, docTitle: ver.docTitle, createdAt: ver.createdAt, lastEditedAt: ver.lastEditedAt, hasSnapshot: !!ver.snapshotHtml, comments: ver.comments.slice() });
            }
          });
        }), Promise.resolve()).then(() => out);
      });
    }

    function version(q) {
      return store.get(verKey(q.versionKey)).then((ver) => {
        if (!ver) return null;
        return codec.decompress(ver.snapshotHtml || '').then((html) => ({ html: html, comments: (ver.comments || []).slice(), docTitle: ver.docTitle, contentHash: ver.contentHash }));
      });
    }

    function clearCurrent(q) {
      return store.get(verKey(q.versionKey)).then((ver) => {
        if (!ver) return;
        ver = Object.assign({}, ver, { comments: [], snapshotHtml: '', lastEditedAt: now() });
        return store.set(verKey(q.versionKey), ver);
      });
    }

    // Retention: snapshot window, metadata window, TTL, then a coarse global byte cap.
    function prune(docId, protectedKey) {
      return store.get(docKey(docId)).then((doc) => {
        if (!doc) return;
        const vers = doc.versions.slice(); // oldest→newest
        const newest = vers[vers.length - 1];
        const ttlCutoff = Date.parse(now()) - limits.ttlDays * 86400000;
        return vers.reduce((chain, k, idx) => chain.then(() => store.get(verKey(k)).then((ver) => {
          if (!ver) return;
          if (k === protectedKey || k === newest) return;
          const ageFromNewest = vers.length - 1 - idx;
          const tooOld = isFinite(ttlCutoff) && Date.parse(ver.lastEditedAt) < ttlCutoff;
          if (ageFromNewest >= limits.metaDrafts || tooOld) return store.remove(verKey(k));
          if (ageFromNewest >= limits.snapshotDrafts && ver.snapshotHtml) {
            ver = Object.assign({}, ver, { snapshotHtml: '' });
            return store.set(verKey(k), ver);
          }
        })), Promise.resolve()).then(() => {
          const kept = [];
          return vers.reduce((chain, k) => chain.then(() => store.get(verKey(k)).then((ver) => { if (ver) kept.push(k); })), Promise.resolve())
            .then(() => store.set(docKey(docId), { schemaVersion: 1, docId: doc.docId, docTitle: doc.docTitle, versions: kept }));
        }).then(() => enforceByteCap(protectedKey));
      });
    }

    function enforceByteCap(protectedKey) {
      return store.keys().then((allKeys) => {
        const vKeys = allKeys.filter((k) => k.indexOf(VER) === 0);
        return Promise.all(vKeys.map((k) => store.get(k).then((g) => ({ key: k, ver: g })))).then((all) => {
          const entries = all.filter((e) => e.ver);
          const newestByDoc = {};
          entries.forEach((e) => { const t = Date.parse(e.ver.lastEditedAt) || 0; const d = e.ver.docId;
            if (!newestByDoc[d] || t >= newestByDoc[d].t) newestByDoc[d] = { t: t, key: e.key }; });
          const protectedKeys = {};
          Object.keys(newestByDoc).forEach((d) => { protectedKeys[newestByDoc[d].key] = true; });
          if (protectedKey) protectedKeys[VER + protectedKey] = true;
          const total = () => entries.reduce((s, e) => s + (e.ver ? JSON.stringify(e.ver).length : 0), 0);
          entries.sort((a, b) => (Date.parse(a.ver.lastEditedAt) || 0) - (Date.parse(b.ver.lastEditedAt) || 0));
          const setOps = [], removeKeys = {};
          for (let i = 0; i < entries.length && total() > limits.maxBytes; i++) {
            const e = entries[i];
            if (e.key === VER + protectedKey) continue;
            if (e.ver && e.ver.snapshotHtml) { e.ver = Object.assign({}, e.ver, { snapshotHtml: '' }); setOps.push(e); }
          }
          for (let j = 0; j < entries.length && total() > limits.maxBytes; j++) {
            const e = entries[j];
            if (!e.ver || protectedKeys[e.key]) continue;
            removeKeys[e.key] = true; e.ver = null;
          }
          const sets = setOps.filter((e) => !removeKeys[e.key]);
          return Promise.all(sets.map((e) => store.set(e.key, e.ver)))
            .then(() => Promise.all(Object.keys(removeKeys).map((k) => store.remove(k))));
        });
      });
    }

    return { resolve, persist, history, version, clearCurrent };
  }

  return { MIN_HASH_CHARS, normalizeText, contentHash, cyrb53, createDraftHistory };
});
