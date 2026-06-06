const { test } = require('node:test');
const assert = require('node:assert');
require('../src/runtime/draft-history-core.js');
require('../src/runtime/snapshot-capture.js');
const mod = require('../src/adapters/history-state-adapter.js');
const core = require('../src/runtime/draft-history-core.js');

const idCodec = { compress: (s) => Promise.resolve(String(s)), decompress: (s) => Promise.resolve(String(s)) };
function fakeStore() { const m = new Map(); return { get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); return Promise.resolve(); }, remove: (k) => { m.delete(k); return Promise.resolve(); }, keys: () => Promise.resolve(Array.from(m.keys())) }; }
function fakeInner() { let s = null; return { load: () => Promise.resolve(s), save: (x) => { s = x; return Promise.resolve(); } }; }
const LONG = 'A document body that is comfortably longer than the small-content guard.';

function build(store, snapHtml) {
  return mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner: fakeInner(), docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => (snapHtml || '<html>SNAP</html>'),
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z'
  });
}

test('load returns the current version comments (empty initially)', async () => {
  const a = build(fakeStore());
  const s = await a.load();
  assert.strictEqual(s.docId, 'D1');
  assert.deepStrictEqual(s.comments, []);
});

test('save captures a full-doc snapshot at the first comment; getHistory/getVersion see it', async () => {
  const store = fakeStore();
  const a = build(store, '<html>FIRST</html>');
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  // simulate a NEW draft (content change) so the first becomes history:
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>SECOND</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:01Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].hasSnapshot, true);
  const v = await b.getVersion({ versionKey: hist[0].versionKey });
  assert.strictEqual(v.html, '<html>FIRST</html>');
});

test('degrades when docId is empty (no history, comments still flow via inner)', async () => {
  const a = mod.createHistoryStateAdapter({ doc: { title: 'T' }, store: fakeStore(), inner: fakeInner(), docId: '', contentText: () => LONG, captureSnapshot: () => '<html>S</html>', draftHistory: core, codec: idCodec, now: () => 'x' });
  const s0 = await a.load();
  assert.deepStrictEqual(s0.comments, []);
  await a.save({ schemaVersion: 1, docId: '', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  assert.deepStrictEqual(await a.getHistory(), []);
});
