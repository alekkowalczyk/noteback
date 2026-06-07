/**
 * Noteback — chrome-kv-store.js  (EXTENSION; dual-export)
 *
 * Responsibility: a low-level async key-value store backed by
 * `chrome.storage.local`. Used by the history engine (draft-history-core.js)
 * in EXTENSION mode. Supports both the older callback form and the modern
 * promise-returning MV3 form of the chrome.storage APIs.
 *
 * Public API:
 *   createChromeKvStore(chromeApi?)
 *       -> { get(k): Promise<value|null>,
 *             set(k, v): Promise<void>,
 *             remove(k): Promise<void>,
 *             keys(): Promise<string[]> }
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.chromeKvStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Promise-wrap `chrome.storage.local.get`. Supports both the modern
   * promise-returning MV3 API and the older callback form.
   * @param {object} storage  chrome.storage.local
   * @param {object} chromeApi  chrome (for runtime.lastError)
   * @param {string|null} key  null fetches all items
   * @returns {Promise<Object>} the get() result bag
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
      // Modern MV3: get() also returns a Promise when the callback is honored.
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
   * Promise-wrap `chrome.storage.local.remove`. Supports promise + callback forms.
   * @param {object} storage
   * @param {object} chromeApi
   * @param {string} key
   * @returns {Promise<void>}
   */
  function storageRemove(storage, chromeApi, key) {
    return new Promise(function (resolve, reject) {
      let maybePromise;
      try {
        maybePromise = storage.remove(key, function () {
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
   * @param {object} [chromeApi]  Defaults to the global `chrome`; injectable for tests.
   * @returns {{ get(k:string):Promise<any|null>, set(k:string,v:any):Promise<void>,
   *             remove(k:string):Promise<void>, keys():Promise<string[]> }}
   */
  function createChromeKvStore(chromeApi) {
    const api = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    if (!api || !api.storage || !api.storage.local) {
      throw new Error('chromeKvStore requires chrome.storage.local');
    }
    const local = api.storage.local;

    return {
      get: function (k) {
        return storageGet(local, api, k).then(function (items) {
          const v = items ? items[k] : undefined;
          return v == null ? null : v;
        });
      },

      set: function (k, v) {
        const bag = {};
        bag[k] = v;
        return storageSet(local, api, bag).then(function () {});
      },

      remove: function (k) {
        return storageRemove(local, api, k).then(function () {});
      },

      keys: function () {
        return storageGet(local, api, null).then(function (items) {
          return items ? Object.keys(items) : [];
        });
      }
    };
  }

  return { createChromeKvStore: createChromeKvStore };
});
