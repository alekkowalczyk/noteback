/**
 * Noteback — origin-policy.js  (PURE; Node + browser dual export)
 *
 * Extension-only. Decides whether Noteback should ACTIVATE (mount its UI) on a
 * given page, from the page's origin and the user's settings. Shared by the
 * content script (gating) and the popup (rendering the toggles). DOM-free and
 * chrome-free so it unit-tests under `node --test`.
 *
 *   classifyOrigin(loc)      -> 'file' | 'localhost' | '127.0.0.1' | 'other'
 *   originOf(loc)            -> canonical origin string ('file://' for file pages)
 *   normalizeSettings(s)     -> { origins:{file,localhost,'127.0.0.1'}, disabledSites:[], historySites:[] }
 *   isActive({type,origin},s)-> boolean   (per-type master gate, per-site subtract)
 *   historyAllowed({type,origin},s) -> boolean (default-on file/localhost/127.0.0.1; opt-in via historySites)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;                       // Node (tests)
  }
  if (root) {
    root.NotebackRuntime = root.NotebackRuntime || {};
    root.NotebackRuntime.originPolicy = api;    // browser (content script + popup)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SETTINGS_KEY = 'nb:settings';
  const TYPES = ['file', 'localhost', '127.0.0.1'];

  function classifyOrigin(loc) {
    loc = loc || {};
    if (String(loc.protocol || '') === 'file:') return 'file';
    const host = String(loc.hostname || '');
    if (host === 'localhost') return 'localhost';
    if (host === '127.0.0.1') return '127.0.0.1';
    return 'other';
  }

  // Canonical per-site identity. file:// pages share the single origin "file://";
  // http(s) pages use scheme+host+port. Computed identically on both sides so a
  // per-site disable entry matches whether written by the popup or read by the
  // content script.
  function originOf(loc) {
    loc = loc || {};
    if (String(loc.protocol || '') === 'file:') return 'file://';
    if (loc.origin) return String(loc.origin);
    const host = String(loc.host || loc.hostname || '');
    return String(loc.protocol || '') + '//' + host;
  }

  function normalizeSettings(settings) {
    const s = settings || {};
    const o = s.origins || {};
    return {
      origins: {
        file: o.file !== false,
        localhost: o.localhost !== false,
        '127.0.0.1': o['127.0.0.1'] !== false
      },
      disabledSites: Array.isArray(s.disabledSites) ? s.disabledSites.slice() : [],
      historySites: Array.isArray(s.historySites) ? s.historySites.slice() : []
    };
  }

  function historyAllowed(info, settings) {
    info = info || {};
    if (TYPES.indexOf(info.type) !== -1) return true;
    const norm = normalizeSettings(settings);
    return !!(info.origin && norm.historySites.indexOf(info.origin) !== -1);
  }

  function isActive(info, settings) {
    info = info || {};
    if (TYPES.indexOf(info.type) === -1) return false;          // 'other'/unknown
    const norm = normalizeSettings(settings);
    if (norm.origins[info.type] === false) return false;        // per-type master gate
    if (info.origin && norm.disabledSites.indexOf(info.origin) !== -1) return false; // per-site subtract
    return true;
  }

  return {
    SETTINGS_KEY: SETTINGS_KEY,
    TYPES: TYPES,
    classifyOrigin: classifyOrigin,
    originOf: originOf,
    normalizeSettings: normalizeSettings,
    isActive: isActive,
    historyAllowed: historyAllowed
  };
});
