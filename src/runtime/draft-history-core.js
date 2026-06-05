/**
 * Noteback runtime — draft-history-core.js  (PURE-ISH; dual-export)
 *
 * Storage-agnostic core for content-hash draft identity, lineage grouping, and
 * GC. Talks to an injected async key-value `store` + `codec`; never touches the
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

  const GEN = 'nb:gen:';
  const LIN = 'nb:lin:';
  const ATTACH = 'nb:attach';

  function defaultLimits(l) {
    l = l || {};
    return {
      snapshotDrafts: l.snapshotDrafts || 5,
      metaDrafts: l.metaDrafts || 15,
      ttlDays: l.ttlDays || 90,
      maxBytes: l.maxBytes || 3000000
    };
  }

  /**
   * @param {Object} cfg
   * @param {Object} cfg.store    async kv: get/set/remove/keys
   * @param {() => string} cfg.now  ISO timestamp
   * @param {() => string} cfg.mintId  unique lineage id
   * @param {Object} cfg.codec    { compress(str)->Promise<str>, decompress(str)->Promise<str> }
   * @param {Object} [cfg.limits]
   */
  function createDraftHistory(cfg) {
    const store = cfg.store;
    const now = cfg.now || (function () { return new Date().toISOString(); });
    const mintId = cfg.mintId || (function () {
      return 'lin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    });
    const codec = cfg.codec || { compress: function (s) { return Promise.resolve(s); }, decompress: function (s) { return Promise.resolve(s); } };
    const limits = defaultLimits(cfg.limits); // used by pruneLineage (Task 3)

    function genKey(h) { return GEN + h; }
    function linKey(id) { return LIN + id; }

    function loadAttach() { return store.get(ATTACH).then(function (m) { return m || {}; }); }

    /**
     * Boot entry: resolve the current draft, seed/attach lineage, return comments.
     * @returns {Promise<{degraded:boolean, contentHash:?string, lineageId:?string, comments:Array}>}
     */
    function resolve(opts) {
      const hash = contentHash(opts.contentText);
      if (hash == null) {
        return Promise.resolve({ degraded: true, contentHash: null, lineageId: null, comments: opts.fallbackComments || [] });
      }
      const attachKey = String(opts.attachKey || '');
      let gen, lineageId;
      return store.get(genKey(hash)).then(function (existing) {
        gen = existing;
        if (gen) {
          lineageId = gen.lineageId;
          return ensureLineage(lineageId, hash, attachKey);
        }
        // New draft: attach to an existing lineage by attach key, else mint one.
        return loadAttach().then(function (map) {
          lineageId = map[attachKey];
          if (!lineageId) lineageId = mintId();
          gen = {
            schemaVersion: 1, contentHash: hash, lineageId: lineageId,
            docTitle: String(opts.docTitle || ''),
            firstSeenAt: now(), lastEditedAt: now(),
            comments: (opts.fallbackComments || []).slice(), sections: [], styles: ''
          };
          return store.set(genKey(hash), gen).then(function () {
            return ensureLineage(lineageId, hash, attachKey);
          });
        });
      }).then(function () {
        return pruneLineage(lineageId, hash).then(function () {
          return { degraded: false, contentHash: hash, lineageId: lineageId, comments: (gen.comments || []).slice() };
        });
      });
    }

    /** Ensure the lineage record exists and records this hash + attach key. */
    function ensureLineage(lineageId, hash, attachKey) {
      return store.get(linKey(lineageId)).then(function (lin) {
        lin = lin || { schemaVersion: 1, lineageId: lineageId, attachKeys: [], generations: [] };
        lin = { schemaVersion: lin.schemaVersion || 1, lineageId: lin.lineageId || lineageId, attachKeys: (lin.attachKeys || []).slice(), generations: (lin.generations || []).slice() };
        if (lin.generations.indexOf(hash) === -1) lin.generations.push(hash);
        if (attachKey && lin.attachKeys.indexOf(attachKey) === -1) lin.attachKeys.push(attachKey);
        return store.set(linKey(lineageId), lin);
      }).then(function () {
        if (!attachKey) return;
        return loadAttach().then(function (map) {
          if (map[attachKey] === lineageId) return;
          map[attachKey] = lineageId;
          return store.set(ATTACH, map);
        });
      });
    }

    /**
     * Write the current draft's comments + snapshot.
     * Callers pass ALREADY-compressed sections/styles; compression is the adapter's
     * job. section() decompresses on read.
     */
    function persist(p) {
      return store.get(genKey(p.contentHash)).then(function (gen) {
        if (!gen) return; // resolve() must run first
        gen = Object.assign({}, gen);
        gen.comments = (p.comments || []).slice();
        gen.sections = p.sections || gen.sections || [];
        gen.styles = (p.styles != null) ? p.styles : (gen.styles || '');
        gen.sectionByCommentId = p.sectionByCommentId || gen.sectionByCommentId || {};
        gen.lastEditedAt = now();
        return store.set(genKey(p.contentHash), gen).then(function () {
          return pruneLineage(gen.lineageId, p.contentHash);
        });
      });
    }

    /** Other drafts in the lineage with >=1 comment, newest first. */
    function history(q) {
      return store.get(linKey(q.lineageId)).then(function (lin) {
        if (!lin) return [];
        const hashes = lin.generations.slice().reverse(); // generations are stored oldest->newest; reverse to walk newest-first
        const out = [];
        return hashes.reduce(function (chain, h) {
          return chain.then(function () {
            if (h === q.exceptHash) return;
            return store.get(genKey(h)).then(function (gen) {
              if (gen && gen.comments && gen.comments.length > 0) {
                const map = gen.sectionByCommentId || {};
                out.push({
                  contentHash: h, lineageId: gen.lineageId, docTitle: gen.docTitle,
                  firstSeenAt: gen.firstSeenAt, lastEditedAt: gen.lastEditedAt,
                  hasSnapshot: !!(gen.sections && gen.sections.length),
                  comments: gen.comments.map(function (c) {
                    const cc = Object.assign({}, c);
                    cc.sectionId = map[c.id] || null; return cc;
                  })
                });
              }
            });
          });
        }, Promise.resolve()).then(function () { return out; });
      });
    }

    /** Decompress one history comment's section snapshot for the popup. */
    function section(q) {
      return store.get(genKey(q.contentHash)).then(function (gen) {
        if (!gen || !gen.sections) return null;
        const sec = gen.sections.filter(function (s) { return s.id === q.sectionId; })[0];
        if (!sec) return null;
        return Promise.all([codec.decompress(sec.html), codec.decompress(gen.styles || '')])
          .then(function (parts) { return { html: parts[0], styles: parts[1] }; });
      });
    }

    /** Empty the current draft's comments + snapshot (history kept). */
    function clearCurrent(q) {
      return store.get(genKey(q.contentHash)).then(function (gen) {
        if (!gen) return;
        gen = Object.assign({}, gen);
        gen.comments = [];
        gen.sections = [];
        gen.lastEditedAt = now();
        return store.set(genKey(q.contentHash), gen);
      });
    }

    /**
     * Enforce retention for a lineage: snapshot window, metadata window, TTL,
     * and a coarse byte cap. `lin.generations` is oldest→newest.
     * @param {string} lineageId
     * @param {string} protectedHash  The current draft's hash — never remove or
     *   strip this gen, regardless of TTL / metaDrafts rules. The lineage's
     *   newest gen is likewise never removed or stripped (parity with
     *   enforceByteCap, which already protects newest-per-lineage).
     */
    function pruneLineage(lineageId, protectedHash) {
      return store.get(linKey(lineageId)).then(function (lin) {
        if (!lin) return;
        const gens = lin.generations.slice(); // oldest -> newest
        const newestHash = gens[gens.length - 1]; // newest of this lineage — never prune it
        const ttlCutoff = Date.parse(now()) - limits.ttlDays * 86400000;

        return gens.reduce(function (chain, h, idx) {
          return chain.then(function () {
            return store.get(genKey(h)).then(function (gen) {
              if (!gen) return;
              // Fix A: never remove or strip the protected (current) draft or the lineage's newest.
              if (h === protectedHash || h === newestHash) return;
              const ageFromNewest = gens.length - 1 - idx; // 0 = newest
              const tooOld = isFinite(ttlCutoff) && Date.parse(gen.lastEditedAt) < ttlCutoff;
              const beyondMeta = ageFromNewest >= limits.metaDrafts;
              const beyondSnapshot = ageFromNewest >= limits.snapshotDrafts;
              if (beyondMeta || tooOld) {
                return store.remove(genKey(h));
              }
              if (beyondSnapshot && (gen.sections.length || gen.styles)) {
                gen = Object.assign({}, gen);
                gen.sections = [];
                gen.styles = '';
                return store.set(genKey(h), gen);
              }
            });
          });
        }, Promise.resolve()).then(function () {
          // Re-read survivors to rebuild the lineage list in order.
          const kept = [];
          return gens.reduce(function (chain, h) {
            return chain.then(function () {
              return store.get(genKey(h)).then(function (gen) { if (gen) kept.push(h); });
            });
          }, Promise.resolve()).then(function () {
            // Clone lin before mutating (match ensureLineage's pattern).
            lin = { schemaVersion: lin.schemaVersion || 1, lineageId: lin.lineageId, attachKeys: (lin.attachKeys || []).slice(), generations: kept };
            return store.set(linKey(lineageId), lin);
          });
        }).then(function () { return enforceByteCap(protectedHash); });
      });
    }

    /** Coarse global byte cap: evict oldest drafts' snapshots, then drafts.
     *  Never evicts the newest gen of any lineage, and never evicts protectedHash. */
    function enforceByteCap(protectedHash) {
      return store.keys().then(function (keys) {
        const genKeys = keys.filter(function (k) { return k.indexOf(GEN) === 0; });
        return Promise.all(genKeys.map(function (k) {
          return store.get(k).then(function (g) { return { key: k, gen: g }; });
        })).then(function (all) {
          const entries = all.filter(function (e) { return e.gen; });
          // Build protected key set: newest gen of each lineage + protectedHash.
          const newestKeyByLineage = {};
          entries.forEach(function (e) {
            const lid = e.gen.lineageId;
            const t = Date.parse(e.gen.lastEditedAt) || 0;
            if (!newestKeyByLineage[lid] || t >= newestKeyByLineage[lid].t) {
              newestKeyByLineage[lid] = { t: t, key: e.key };
            }
          });
          const protectedKeys = {};
          Object.keys(newestKeyByLineage).forEach(function (lid) { protectedKeys[newestKeyByLineage[lid].key] = true; });
          if (protectedHash) protectedKeys[GEN + protectedHash] = true;

          function total() {
            return entries.reduce(function (s, e) { return s + (e.gen ? JSON.stringify(e.gen).length : 0); }, 0);
          }
          entries.sort(function (a, b) {
            return (Date.parse(a.gen.lastEditedAt) || 0) - (Date.parse(b.gen.lastEditedAt) || 0);
          });

          const setOps = [], removeKeys = {};
          // Pass 1: strip snapshots from oldest entries while over cap.
          for (let i = 0; i < entries.length && total() > limits.maxBytes; i++) {
            const e = entries[i];
            if (protectedHash && e.key === GEN + protectedHash) continue;
            if (e.gen && (e.gen.sections.length || e.gen.styles)) {
              e.gen = Object.assign({}, e.gen);
              e.gen.sections = [];
              e.gen.styles = '';
              setOps.push(e);
            }
          }
          // Pass 2: remove unprotected entries while still over cap.
          for (let j = 0; j < entries.length && total() > limits.maxBytes; j++) {
            const e = entries[j];
            if (!e.gen || protectedKeys[e.key]) continue;
            removeKeys[e.key] = true;
            e.gen = null;
          }
          // Execute: SET first, then REMOVE; skip SET for any key that is also removed.
          const sets = setOps.filter(function (e) { return !removeKeys[e.key]; });
          return Promise.all(sets.map(function (e) { return store.set(e.key, e.gen); }))
            .then(function () { return Promise.all(Object.keys(removeKeys).map(function (k) { return store.remove(k); })); });
        });
      });
    }

    return { resolve: resolve, persist: persist, history: history, section: section, clearCurrent: clearCurrent };
  }

  return { MIN_HASH_CHARS, normalizeText, contentHash, cyrb53, createDraftHistory };
});
