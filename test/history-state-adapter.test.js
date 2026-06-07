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

test('exportHistory returns the doc + version records as a kv-key map; null when degraded', async () => {
  const store = fakeStore();
  const a = build(store, '<html>FIRST</html>');
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  const exp = await a.exportHistory();
  assert.ok(exp && exp.entries, 'returns an entries map');
  assert.ok(Object.prototype.hasOwnProperty.call(exp.entries, 'nb:doc:D1'), 'includes the doc record');
  const verKeys = Object.keys(exp.entries).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeys.length, 1, 'includes the one version record');
  assert.strictEqual(exp.entries[verKeys[0]].snapshotHtml, '<html>FIRST</html>', 'the version snapshot travels in the export');
  // degraded (empty docId) → null.
  const d = mod.createHistoryStateAdapter({ doc: { title: 'T' }, store: fakeStore(), inner: fakeInner(), docId: '', contentText: () => LONG, captureSnapshot: () => '<html>S</html>', draftHistory: core, codec: idCodec, now: () => 'x' });
  assert.strictEqual(await d.exportHistory(), null);
});

test('getCurrentVersionKey returns the resolved version key; null when degraded', async () => {
  // usable: the key is the content hash of the (long-enough) content text.
  const a = build(fakeStore());
  const key = await a.getCurrentVersionKey();
  assert.strictEqual(typeof key, 'string');
  assert.ok(key && key.length > 0, 'a non-empty version key is resolved');
  // It must match the key getHistory excludes (i.e., the CURRENT version).
  const a2 = build(fakeStore());
  const k2 = await a2.getCurrentVersionKey();
  assert.strictEqual(k2, key, 'the same content resolves to the same current key');
  // degraded (empty docId) → null.
  const d = mod.createHistoryStateAdapter({ doc: { title: 'T' }, store: fakeStore(), inner: fakeInner(), docId: '', contentText: () => LONG, captureSnapshot: () => '<html>S</html>', draftHistory: core, codec: idCodec, now: () => 'x' });
  assert.strictEqual(await d.getCurrentVersionKey(), null);
});

test('degrades when docId is empty (no history, comments still flow via inner)', async () => {
  const a = mod.createHistoryStateAdapter({ doc: { title: 'T' }, store: fakeStore(), inner: fakeInner(), docId: '', contentText: () => LONG, captureSnapshot: () => '<html>S</html>', draftHistory: core, codec: idCodec, now: () => 'x' });
  const s0 = await a.load();
  assert.deepStrictEqual(s0.comments, []);
  await a.save({ schemaVersion: 1, docId: '', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  assert.deepStrictEqual(await a.getHistory(), []);
});

test('a second comment does NOT recapture the snapshot (capture-once holds)', async () => {
  const store = fakeStore();
  let snapVal = '<html>SNAP-A</html>';
  const a = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner: fakeInner(), docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => snapVal,
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z'
  });
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  snapVal = '<html>SNAP-B</html>'; // a different capture on the 2nd save must be ignored
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }, { id: 'c2', body: 'b2', anchor: null, createdAt: 'y', author: null }] });
  // Re-open as a fresh draft (content changed) so the version above is history.
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>OTHER</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:01Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1);
  const v = await b.getVersion({ versionKey: hist[0].versionKey });
  assert.strictEqual(v.html, '<html>SNAP-A</html>', 'the first snapshot is immutable across later saves');
  assert.strictEqual(v.comments.length, 2, 'comments still update on the second save');
});

test('in-file fallback comments over an empty store: a snapshot IS still captured (regression)', async () => {
  // The bug: a version pre-seeded with fallback comments but an EMPTY snapshot was
  // treated as already-snapshotted, so save() never captured one and the version
  // became permanently un-peekable. Here `inner` returns a pre-existing comment
  // (the re-shared in-file canvas), the store starts empty, and save() with that
  // comment present must capture the snapshot.
  const store = fakeStore();
  const seeded = { schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'infile', anchor: null, createdAt: 'x', author: null }] };
  const inner = { load: () => Promise.resolve(seeded), save: () => Promise.resolve() };
  const a = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner, docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => '<html>INFILE-SNAP</html>',
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z'
  });
  const s0 = await a.load();
  assert.strictEqual(s0.comments.length, 1, 'fallback comment surfaces on load');
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: s0.comments });
  // Re-open as a fresh draft (content changed) so the seeded version is history.
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>OTHER</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:01Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].hasSnapshot, true, 'the version is peekable (snapshot captured)');
  const v = await b.getVersion({ versionKey: hist[0].versionKey });
  assert.strictEqual(v.html, '<html>INFILE-SNAP</html>', 'the captured snapshot is the in-file one');
});

test('clearCurrent empties comments and resets the capture-once path', async () => {
  const store = fakeStore();
  let snapVal = '<html>SNAP-1</html>';
  const a = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner: fakeInner(), docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => snapVal,
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z'
  });
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  await a.clearCurrent();
  assert.deepStrictEqual((await a.load()).comments, [], 'comments wiped after clearCurrent');
  // Save a comment again: a fresh snapshot must be re-captured (hasSnapshot reset).
  snapVal = '<html>SNAP-2</html>';
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c2', body: 'b2', anchor: null, createdAt: 'y', author: null }] });
  // Re-open as a fresh draft (content changed) so the post-clear version is history.
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>OTHER</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:01Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].hasSnapshot, true, 'a snapshot is re-captured after clearCurrent');
  const vv = await b.getVersion({ versionKey: hist[0].versionKey });
  assert.strictEqual(vv.html, '<html>SNAP-2</html>', 're-captured snapshot reflects the post-clear save');
});

test('isEnabled()=false makes the adapter pass through to inner (no version), flip on restores history', async () => {
  const store = fakeStore();
  let on = false; // start DISABLED
  const inner = fakeInner();
  const a = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner, docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => '<html>SNAP</html>',
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z',
    isEnabled: () => on
  });
  // Disabled: a save writes through inner but records NO version.
  await a.load();
  const comments = [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }];
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: comments });
  assert.deepStrictEqual(await a.getHistory(), [], 'no history while disabled');
  assert.strictEqual((await inner.load()).comments.length, 1, 'comment still written through inner');
  const verKeysWhileOff = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeysWhileOff.length, 0, 'no version record created while disabled');

  // Flip ON: the same adapter now records the current draft as a version.
  on = true;
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: comments });
  const verKeysWhileOn = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeysWhileOn.length, 1, 'a version record exists once re-enabled');
  // It is the CURRENT version (excluded from getHistory), so a fresh sibling draft sees it as history.
  const b = mod.createHistoryStateAdapter({ doc: { title: 'T', getElementById: () => ({ textContent: LONG + ' changed.' }) }, store, inner: fakeInner(), docId: 'D1', contentText: () => LONG + ' changed.', captureSnapshot: () => '<html>OTHER</html>', draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:02Z' });
  await b.load();
  const hist = await b.getHistory();
  assert.strictEqual(hist.length, 1, 'the re-enabled draft is visible as history to a later version');
  assert.strictEqual(hist[0].comments.length, 1);
});

test('isEnabled defaults to true (omitted → unchanged behavior)', async () => {
  const store = fakeStore();
  const a = build(store, '<html>FIRST</html>'); // build() passes no isEnabled
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  const verKeys = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(verKeys.length, 1, 'history records normally when isEnabled is omitted');
});

test('flipping isEnabled ON→OFF stops recording live and hides history (data kept)', async () => {
  const store = fakeStore();
  let on = true; // start ENABLED
  const a = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner: fakeInner(), docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => '<html>SNAP</html>',
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z',
    isEnabled: () => on
  });
  // Enabled: a comment records a version (populates the resolved cache + a nb:ver record).
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  const beforeOff = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(beforeOff.length, 1, 'a version record exists while enabled');

  // Flip OFF: the populated (non-degraded) cache must be invalidated → degrade live.
  on = false;
  assert.deepStrictEqual(await a.getHistory(), [], 'history hidden once disabled');
  // A further save records NO new version (recording stopped); the kept record stays.
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }, { id: 'c2', body: 'b2', anchor: null, createdAt: 'y', author: null }] });
  const afterOff = (await store.keys()).filter((k) => k.indexOf('nb:ver:') === 0);
  assert.strictEqual(afterOff.length, 1, 'no NEW version recorded while disabled (data kept, recording stopped)');
});

test('getVersion returns null while disabled (data kept, just not surfaced)', async () => {
  const store = fakeStore();
  // First, record a version while ENABLED so there is a real versionKey to query.
  const a = build(store, '<html>SNAP</html>'); // build() passes no isEnabled → on
  await a.load();
  await a.save({ schemaVersion: 1, docId: 'D1', docTitle: 'T', comments: [{ id: 'c1', body: 'b', anchor: null, createdAt: 'x', author: null }] });
  const key = await a.getCurrentVersionKey();
  assert.ok(key, 'a version key resolved while enabled');
  // A disabled adapter over the SAME store must not surface that snapshot.
  const off = mod.createHistoryStateAdapter({
    doc: { title: 'T', getElementById: () => ({ textContent: LONG }) },
    store, inner: fakeInner(), docId: 'D1',
    contentText: () => LONG, captureSnapshot: () => '<html>SNAP</html>',
    draftHistory: core, codec: idCodec, now: () => '2026-06-05T00:00:00Z',
    isEnabled: () => false
  });
  assert.strictEqual(await off.getVersion({ versionKey: key }), null, 'getVersion is null while disabled');
});

test('makeCodec gzip roundtrip (when CompressionStream is available)', async () => {
  if (typeof CompressionStream === 'undefined') return; // Node without CompressionStream: skip
  const c = mod.makeCodec();
  const gz = await c.compress('<html>hi</html>');
  assert.ok(gz.startsWith('gz:'), 'compressed payload is gz-tagged');
  assert.strictEqual(await c.decompress(gz), '<html>hi</html>', 'roundtrips back to the original');
  assert.strictEqual(await c.decompress('plain-not-gz'), 'plain-not-gz', 'a non-gz string passes through unchanged');
});
