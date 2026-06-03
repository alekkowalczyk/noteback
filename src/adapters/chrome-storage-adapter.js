/**
 * Noteback — chrome-storage-adapter.js  (DOM/CHROME; browser global)
 *
 * Responsibility: a StorageAdapter (CONTRACTS.md §1) backed by
 * `chrome.storage.local`, keyed by docId. Used in EXTENSION mode only (the
 * original author). NOT inlined into the saved canvas — recipients use
 * InFileStateAdapter instead.
 *
 * Storage key convention: "noteback:" + docId.
 *
 * Browser-only: attaches to `NotebackRuntime.chromeStorageAdapter`. No
 * module.exports.
 *
 * Public API (CONTRACTS.md §1.1):
 *   createChromeStorageAdapter(docId, chromeApi=globalThis.chrome)
 *       -> { load(): Promise<State|null>, save(state): Promise<void> }
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.chromeStorageAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY_PREFIX = 'noteback:';

  /** Resolve the Chrome API to use (injected for tests, else the global). */
  function resolveChrome(chromeApi) {
    if (chromeApi) return chromeApi;
    if (typeof chrome !== 'undefined') return chrome;
    if (typeof globalThis !== 'undefined' && globalThis.chrome) return globalThis.chrome;
    return null;
  }

  /** Build the storage key for a docId (CONTRACTS.md §1.1). */
  function keyFor(docId) {
    return KEY_PREFIX + String(docId == null ? '' : docId);
  }

  /**
   * Promise-wrap `chrome.storage.local.get`. Supports both the modern
   * promise-returning MV3 API and the older callback form.
   * @param {object} storage  chrome.storage.local
   * @param {object} chromeApi chrome (for runtime.lastError)
   * @param {string} key
   * @returns {Promise<Object>} the get() result bag.
   */
  function storageGet(storage, chromeApi, key) {
    return new Promise(function (resolve, reject) {
      let maybePromise;
      try {
        maybePromise = storage.get(key, function (items) {
          const err = chromeApi && chromeApi.runtime && chromeApi.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(items || {});
        });
      } catch (e) {
        reject(e);
        return;
      }
      // Modern MV3: get() also returns a Promise when no callback is honored.
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(function (items) { resolve(items || {}); }, reject);
      }
    });
  }

  /**
   * Promise-wrap `chrome.storage.local.set`. Supports promise + callback forms.
   * @param {object} storage
   * @param {object} chromeApi
   * @param {Object} bag  { [key]: value }
   * @returns {Promise<void>}
   */
  function storageSet(storage, chromeApi, bag) {
    return new Promise(function (resolve, reject) {
      let maybePromise;
      try {
        maybePromise = storage.set(bag, function () {
          const err = chromeApi && chromeApi.runtime && chromeApi.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve();
        });
      } catch (e) {
        reject(e);
        return;
      }
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(function () { resolve(); }, reject);
      }
    });
  }

  /**
   * @param {string} docId   Identity key (file path / URL).
   * @param {object} [chromeApi]  Defaults to the global `chrome`; injectable for tests.
   * @returns {{ load: () => Promise<Object|null>, save: (state:Object) => Promise<void> }}
   */
  function createChromeStorageAdapter(docId, chromeApi) {
    const key = keyFor(docId);

    function getStorage() {
      const api = resolveChrome(chromeApi);
      if (!api || !api.storage || !api.storage.local) {
        throw new Error('chromeStorageAdapter requires chrome.storage.local');
      }
      return { storage: api.storage.local, chromeApi: api };
    }

    return {
      /**
       * Read the persisted State for this docId. Returns null (per the
       * contract — not {}) when nothing is stored yet.
       * @returns {Promise<Object|null>}
       */
      load: function () {
        let ctx;
        try { ctx = getStorage(); } catch (e) { return Promise.reject(e); }
        return storageGet(ctx.storage, ctx.chromeApi, key).then(function (items) {
          const value = items ? items[key] : undefined;
          if (value == null) return null;
          // chrome.storage.local stores structured clones, so the State is
          // already an object. Tolerate a stringified value defensively.
          if (typeof value === 'string') {
            try { return JSON.parse(value); } catch (e) { return null; }
          }
          return value;
        });
      },

      /**
       * Persist the whole State object under this docId's key. Adapters do not
       * mutate the input (CONTRACTS.md §1).
       * @param {Object} state  valid State (§2).
       * @returns {Promise<void>}
       */
      save: function (state) {
        let ctx;
        try { ctx = getStorage(); } catch (e) { return Promise.reject(e); }
        const bag = {};
        bag[key] = state;
        return storageSet(ctx.storage, ctx.chromeApi, bag);
      }
    };
  }

  return { KEY_PREFIX, keyFor, createChromeStorageAdapter };
});
