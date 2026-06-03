/**
 * Noteback — infile-state-adapter.js  (DOM; browser global)
 *
 * Responsibility: a StorageAdapter (CONTRACTS.md §1) backed by the in-file
 * `<script type="application/json" id="noteback-state">` JSON block (§5). Used
 * in EMBEDDED mode (inside a saved canvas) by recipients with no extension.
 *
 *   - load(): JSON.parse the #noteback-state text -> State (null if absent/empty).
 *   - save(state): write JSON.stringify(state) back into that element's text.
 *     (This updates the in-memory DOM only; persisting to disk is the exporter's
 *     download / File System Access flow — see CONTRACTS.md §6 / spec §8.3.)
 *     After updating the block it fires an optional `onChange(state)` so the
 *     embedded boot can offer a fresh "Download with my comments" canvas.
 *
 * Browser-only: attaches to `NotebackRuntime.infileStateAdapter`. No
 * module.exports.
 *
 * Public API (CONTRACTS.md §1.2):
 *   createInFileStateAdapter(doc=document, opts?)
 *       -> { load(): Promise<State|null>, save(state): Promise<void> }
 *   opts.onChange?(state)  Notified after each in-place save so the exporter can
 *                          re-build the downloadable canvas.
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.infileStateAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_BLOCK_ID = 'noteback-state';
  const STATE_BLOCK_TYPE = 'application/json';

  /** Resolve the document to operate on. */
  function resolveDoc(doc) {
    if (doc) return doc;
    if (typeof document !== 'undefined') return document;
    return null;
  }

  /** Find the single `#noteback-state` block (CONTRACTS.md §5). */
  function findBlock(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return null;
    return doc.getElementById(STATE_BLOCK_ID);
  }

  /**
   * Ensure the state block exists, creating it if missing (so a save in a doc
   * that never had one — e.g. a freshly authored page — still works).
   * @param {Document} doc
   * @returns {Element}
   */
  function ensureBlock(doc) {
    let el = findBlock(doc);
    if (el) return el;
    el = doc.createElement('script');
    el.type = STATE_BLOCK_TYPE;
    el.id = STATE_BLOCK_ID;
    (doc.body || doc.head || doc.documentElement).appendChild(el);
    return el;
  }

  /** Read the raw text of a script element (textContent across engines). */
  function blockText(el) {
    if (!el) return '';
    return el.textContent || el.innerHTML || '';
  }

  /**
   * @param {Document} [doc]  Defaults to global `document`.
   * @param {{ onChange?: (state:Object) => void }} [opts]
   * @returns {{ load: () => Promise<Object|null>, save: (state:Object) => Promise<void> }}
   */
  function createInFileStateAdapter(doc, opts) {
    const options = opts || {};
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    return {
      /**
       * Parse the in-file state block. Returns null when the block is absent,
       * empty, or not valid JSON (per the StorageAdapter contract — callers then
       * create a fresh State).
       * @returns {Promise<Object|null>}
       */
      load: function () {
        const d = resolveDoc(doc);
        if (!d) return Promise.resolve(null);
        const el = findBlock(d);
        if (!el) return Promise.resolve(null);
        const raw = blockText(el).trim();
        if (raw === '') return Promise.resolve(null);
        try {
          return Promise.resolve(JSON.parse(raw));
        } catch (e) {
          return Promise.resolve(null);
        }
      },

      /**
       * Serialize `state` back into the in-file block (in-memory DOM only) and
       * notify the exporter (via onChange) so a fresh canvas can be downloaded.
       * Does NOT mutate the input State.
       * @param {Object} state  valid State (§2).
       * @returns {Promise<void>}
       */
      save: function (state) {
        const d = resolveDoc(doc);
        if (!d) {
          return Promise.reject(new Error('infileStateAdapter requires a document'));
        }
        let el;
        try {
          el = ensureBlock(d);
        } catch (e) {
          return Promise.reject(e);
        }
        el.textContent = JSON.stringify(state);
        if (onChange) {
          try { onChange(state); } catch (e) { /* notification is best-effort */ }
        }
        return Promise.resolve();
      }
    };
  }

  return {
    STATE_BLOCK_ID,
    STATE_BLOCK_TYPE,
    findBlock,
    createInFileStateAdapter
  };
});
