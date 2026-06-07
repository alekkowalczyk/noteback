const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/runtime/draft-history-core.js');

const idCodec = { compress: (s) => Promise.resolve(String(s)), decompress: (s) => Promise.resolve(String(s)) };
function fakeStore() {
  const m = new Map();
  return {
    get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); return Promise.resolve(); },
    remove: (k) => { m.delete(k); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(m.keys()))
  };
}
function makeCore(store) {
  let n = 0;
  return core.createDraftHistory({ store, now: () => '2026-06-05T00:00:0' + (n++ % 10) + 'Z', codec: idCodec,
    limits: { snapshotDrafts: 5, metaDrafts: 15, ttlDays: 99999, maxBytes: 1e9 } });
}
const LONG = 'The design uses a single Redis instance to coordinate the workers.';

test('resolve creates a version and lists it under the doc', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.docId, 'D1');
  assert.ok(r.versionKey);
  assert.deepStrictEqual(r.comments, []);
});

test('exportDoc returns the doc record + every version record as a kv-key map', async () => {
  const dh = makeCore(fakeStore());
  const r1 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r1.versionKey, comments: [{ id: 'c1', body: 'v1 note', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>ONE</html>' });
  const r2 = await dh.resolve({ docId: 'D1', contentText: LONG + ' Now changed materially here.', fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r2.versionKey, comments: [{ id: 'c2', body: 'v2 note', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>TWO</html>' });

  const exp = await dh.exportDoc({ docId: 'D1' });
  assert.strictEqual(exp.schemaVersion, 1);
  const keys = Object.keys(exp.entries);
  assert.ok(keys.indexOf('nb:doc:D1') !== -1, 'includes the doc record');
  assert.ok(keys.indexOf('nb:ver:' + r1.versionKey) !== -1, 'includes version 1');
  assert.ok(keys.indexOf('nb:ver:' + r2.versionKey) !== -1, 'includes version 2');
  assert.strictEqual(keys.length, 3, 'exactly the doc + its two versions');
  assert.strictEqual(exp.entries['nb:ver:' + r1.versionKey].snapshotHtml, '<html>ONE</html>');
  // Round-trip: seeding a fresh store from the entries reproduces the history.
  const store2 = fakeStore();
  for (const k of keys) await store2.set(k, exp.entries[k]);
  const dh2 = makeCore(store2);
  const hist = await dh2.history({ docId: 'D1', exceptVersionKey: r2.versionKey });
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].comments[0].body, 'v1 note');
});

test('exportDoc returns null for an unknown doc', async () => {
  const dh = makeCore(fakeStore());
  assert.strictEqual(await dh.exportDoc({ docId: 'NOPE' }), null);
});

test('a content change makes a new version in the same doc; history shows the old one', async () => {
  const dh = makeCore(fakeStore());
  const r1 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r1.versionKey, comments: [{ id: 'c1', body: 'old', anchor: { quote: 'Redis', prefix: '', suffix: '', occurrence: 0 }, createdAt: 'x', author: null }], snapshotHtml: '<html>OLD</html>' });
  const r2 = await dh.resolve({ docId: 'D1', contentText: LONG + ' Now changed materially here.', fallbackComments: [], docTitle: 'T' });
  assert.notStrictEqual(r2.versionKey, r1.versionKey);
  const hist = await dh.history({ docId: 'D1', exceptVersionKey: r2.versionKey });
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].comments[0].body, 'old');
  assert.strictEqual(hist[0].hasSnapshot, true);
});

test('resolve reports hasSnapshot reflecting the version\'s stored snapshot state', async () => {
  const dh = makeCore(fakeStore());
  const r1 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(r1.hasSnapshot, false, 'a brand-new version has no snapshot yet');
  await dh.persist({ docId: 'D1', versionKey: r1.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>SNAP</html>' });
  const r2 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(r2.versionKey, r1.versionKey, 'same content resolves the same version');
  assert.strictEqual(r2.hasSnapshot, true, 'after a snapshot is persisted, resolve reports it');
});

test('resolve seeds a pre-existing version that has comments but NO snapshot as hasSnapshot:false', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  // First resolve seeds a version with fallback comments but an empty snapshot
  // (the embedded re-shared-canvas case): comments present, snapshotHtml ''.
  const r1 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [{ id: 'c1', body: 'b' }], docTitle: 'T' });
  assert.deepStrictEqual(r1.comments, [{ id: 'c1', body: 'b' }]);
  // Re-resolving the SAME content must NOT report hasSnapshot just because comments exist.
  const r2 = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(r2.versionKey, r1.versionKey);
  assert.deepStrictEqual(r2.comments, [{ id: 'c1', body: 'b' }], 'stored comments survive');
  assert.strictEqual(r2.hasSnapshot, false, 'comments without a snapshot must not look snapshotted');
});

test('version() decompresses the stored full-doc snapshot + comments', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>SNAP</html>' });
  const v = await dh.version({ versionKey: r.versionKey });
  assert.strictEqual(v.html, '<html>SNAP</html>');
  assert.strictEqual(v.comments.length, 1);
});

test('snapshot is captured once; a later persist without snapshot keeps it', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>FIRST</html>' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1' }, { id: 'c2' }], snapshotHtml: '<html>SECOND</html>' });
  const v = await dh.version({ versionKey: r.versionKey });
  assert.strictEqual(v.html, '<html>FIRST</html>', 'first snapshot is immutable');
});

test('short content still gets a stable deterministic version key (no degrade)', async () => {
  const dh = makeCore(fakeStore());
  const a = await dh.resolve({ docId: 'D1', contentText: 'hi', fallbackComments: [], docTitle: 'T' });
  const b = await dh.resolve({ docId: 'D1', contentText: 'hi', fallbackComments: [], docTitle: 'T' });
  assert.strictEqual(a.degraded, false);
  assert.strictEqual(a.versionKey, b.versionKey);
  assert.strictEqual(a.versionKey, 'h0:D1');
});

test('no docId → degraded, returns fallback comments, no history', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: '', contentText: LONG, fallbackComments: [{ id: 'c1' }] });
  assert.strictEqual(r.degraded, true);
  assert.deepStrictEqual(r.comments, [{ id: 'c1' }]);
});

test('clearCurrent empties the current version but keeps history', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ docId: 'D1', contentText: LONG, fallbackComments: [], docTitle: 'T' });
  await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }], snapshotHtml: '<html>S</html>' });
  await dh.clearCurrent({ docId: 'D1', versionKey: r.versionKey });
  const v = await dh.version({ versionKey: r.versionKey });
  assert.deepStrictEqual(v.comments, []);
});

test('prune drops versions beyond metaDrafts, never the newest/protected', async () => {
  const dh = core.createDraftHistory({ store: fakeStore(), now: () => '2026-06-05T00:00:00Z', codec: idCodec,
    limits: { snapshotDrafts: 1, metaDrafts: 2, ttlDays: 99999, maxBytes: 1e9 } });
  let last;
  for (let i = 0; i < 5; i++) {
    const r = await dh.resolve({ docId: 'D1', contentText: LONG + ' rev ' + i + ' padding padding padding', fallbackComments: [], docTitle: 'T' });
    await dh.persist({ docId: 'D1', versionKey: r.versionKey, comments: [{ id: 'c' + i }], snapshotHtml: '<html>S' + i + '</html>' });
    last = r.versionKey;
  }
  const hist = await dh.history({ docId: 'D1', exceptVersionKey: last });
  assert.ok(hist.length <= 2, 'metadata window enforced');
});
