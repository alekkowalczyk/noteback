/**
 * Noteback tests — origin-policy.test.js
 * Runs under the Node built-in runner ONLY:  node --test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../src/content/origin-policy.js');

test('module exposes its API and a stable settings key', () => {
  assert.strictEqual(policy.SETTINGS_KEY, 'nb:settings');
  assert.deepStrictEqual(policy.TYPES, ['file', 'localhost', '127.0.0.1']);
  assert.strictEqual(typeof policy.classifyOrigin, 'function');
  assert.strictEqual(typeof policy.originOf, 'function');
  assert.strictEqual(typeof policy.normalizeSettings, 'function');
  assert.strictEqual(typeof policy.isActive, 'function');
  assert.strictEqual(typeof policy.overlayMounted, 'function');
});

test('classifyOrigin maps protocol/hostname to type', () => {
  assert.strictEqual(policy.classifyOrigin({ protocol: 'file:', hostname: '' }), 'file');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'http:', hostname: 'localhost' }), 'localhost');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), '127.0.0.1');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'https:', hostname: 'example.com' }), 'other');
});

test('originOf returns "file://" for file pages and origin otherwise', () => {
  assert.strictEqual(policy.originOf({ protocol: 'file:', hostname: '' }), 'file://');
  assert.strictEqual(
    policy.originOf({ protocol: 'http:', host: 'localhost:3000', origin: 'http://localhost:3000' }),
    'http://localhost:3000'
  );
});

test('isActive defaults to true when settings are absent', () => {
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, null), true);
  assert.strictEqual(policy.isActive({ type: 'file', origin: 'file://' }, undefined), true);
});

test('per-type switch off suppresses the whole type', () => {
  const s = { origins: { localhost: false } };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
  assert.strictEqual(policy.isActive({ type: 'file', origin: 'file://' }, s), true);
});

test('per-site entry subtracts one origin while its type stays on', () => {
  const s = { disabledSites: ['http://localhost:3000'] };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:8000' }, s), true);
});

test('type-off wins regardless of disabledSites', () => {
  const s = { origins: { localhost: false }, disabledSites: [] };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:8000' }, s), false);
});

test('unknown/other origin type is never active', () => {
  assert.strictEqual(policy.isActive({ type: 'other', origin: 'https://example.com' }, null), false);
});

test('normalizeSettings fills defaults and is shape-stable', () => {
  const n = policy.normalizeSettings(null);
  assert.deepStrictEqual(n.origins, { file: true, localhost: true, '127.0.0.1': true });
  assert.deepStrictEqual(n.disabledSites, []);
  assert.deepStrictEqual(n.historySites, []);
});

test('historyAllowed: on by default for file/localhost/127, off for other', () => {
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: '127.0.0.1', origin: 'http://127.0.0.1:8080' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, null), false);
});

test('historyAllowed: an other-origin opts in via historySites', () => {
  const s = { historySites: ['https://example.com'] };
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, s), true);
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://evil.com' }, s), false);
});

// overlayMounted is the cross-world stand-down the extension content script uses:
// it must report "an overlay is already here" purely from a [data-noteback-ui]
// node in the supplied document (the canvas's main-world boot flag is invisible to
// the isolated-world content script — only the shared DOM crosses).
function fakeDoc(selectorMatches) {
  return {
    querySelector: function (sel) {
      return selectorMatches[sel] || null;
    }
  };
}

test('overlayMounted: true when a [data-noteback-ui] node is present', () => {
  assert.strictEqual(policy.overlayMounted(fakeDoc({ '[data-noteback-ui]': {} })), true);
});

test('overlayMounted: false when no Noteback UI node is present', () => {
  assert.strictEqual(policy.overlayMounted(fakeDoc({})), false);
});

test('overlayMounted: false (never throws) for a missing/invalid document', () => {
  assert.strictEqual(policy.overlayMounted(null), false);
  assert.strictEqual(policy.overlayMounted(undefined), false);
  assert.strictEqual(policy.overlayMounted({}), false); // no querySelector
});

test('normalizeSettings carries the history opt-out fields with safe defaults', () => {
  const n = policy.normalizeSettings(null);
  assert.strictEqual(n.historyDisabledGlobal, false);
  assert.deepStrictEqual(n.historyDisabledSites, []);
  assert.deepStrictEqual(n.historyDisabledDocs, []);
  // garbage shapes coerce to safe defaults
  const g = policy.normalizeSettings({ historyDisabledGlobal: 'yes', historyDisabledSites: 'x', historyDisabledDocs: 5 });
  assert.strictEqual(g.historyDisabledGlobal, false); // only boolean true counts
  assert.deepStrictEqual(g.historyDisabledSites, []);
  assert.deepStrictEqual(g.historyDisabledDocs, []);
});

test('historyAllowed: global opt-out turns history off everywhere', () => {
  const s = { historyDisabledGlobal: true };
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, s), false);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
});

test('historyAllowed: per-site opt-out subtracts one origin (others stay on)', () => {
  const s = { historyDisabledSites: ['file://'] };
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, s), false);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, s), true);
});

test('historyAllowed: per-doc opt-out subtracts one document by its docKey', () => {
  const s = { historyDisabledDocs: ['doc-123'] };
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://', docKey: 'doc-123' }, s), false);
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://', docKey: 'doc-999' }, s), true);
  // no docKey supplied → per-doc list can't match → stays on
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, s), true);
});

test('historyAllowed: opt-out beats the base allow and the opt-in', () => {
  // local type would normally be on, but a global opt-out wins
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, { historyDisabledGlobal: true }), false);
  // an opted-in other origin is overridden by a per-site opt-out
  const s = { historySites: ['https://example.com'], historyDisabledSites: ['https://example.com'] };
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, s), false);
});
