'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// Require the runtime deps so they self-register on globalThis.NotebackRuntime
// (the adapter's makeCodec reads rt().snapshot for its identity-codec fallback),
// and inject them explicitly via the documented cfg test-overrides.
const draftHistory = require('../src/runtime/draft-history-core.js');
const snapshot = require('../src/runtime/snapshot.js');
const mod = require('../src/adapters/localstorage-state-adapter.js');

/** Fake synchronous localStorage. */
function fakeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; }
  };
}
/** Fake in-file inner adapter capturing the last saved state. */
function fakeInner(initial) {
  let saved = initial || null;
  return { load: () => Promise.resolve(saved), save: (s) => { saved = s; return Promise.resolve(); }, _saved: () => saved };
}
const text = 'The system uses a single Redis instance to coordinate workers daily.';
function fakeDoc() {
  return { getElementById: () => ({ textContent: text }), title: 'Plan' };
}

test('load() returns inner state on first open, then localStorage after save', async () => {
  const storage = fakeLocalStorage();
  const inner = fakeInner({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [] });
  const a = mod.createLocalStorageStateAdapter({
    doc: fakeDoc(), storage, inner, attachKey: 'file:///a.html', now: () => '2026-06-05T00:00:00Z',
    draftHistory, snapshot
  });
  const first = await a.load();
  assert.deepStrictEqual(first.comments, []);
  await a.save({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [{ id: 'c1', body: 'hey', anchor: null, createdAt: 'x', author: null }] });
  const again = await a.load();
  assert.strictEqual(again.comments.length, 1);
  assert.strictEqual(inner._saved().comments.length, 1, 'write-through to inner');
});

test('degrades to inner when storage is missing', async () => {
  const inner = fakeInner({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [{ id: 'c', body: 'x', anchor: null, createdAt: 'x', author: null }] });
  const a = mod.createLocalStorageStateAdapter({ doc: fakeDoc(), storage: null, inner, attachKey: 'file:///a.html', draftHistory, snapshot });
  const s = await a.load();
  assert.strictEqual(s.comments.length, 1);
  await a.save({ schemaVersion: 1, docId: 'a', docTitle: 'Plan', comments: [] });
  assert.deepStrictEqual(inner._saved().comments, [], 'still writes through to inner');
});
