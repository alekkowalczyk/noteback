'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/runtime/draft-history-core.js');

test('normalizeText trims and collapses whitespace, preserves case', () => {
  assert.strictEqual(core.normalizeText('  Hello\n\n  World  '), 'Hello World');
  assert.strictEqual(core.normalizeText('A\tB\r\nC'), 'A B C');
});

test('contentHash is stable and whitespace-insensitive', () => {
  const a = core.contentHash('The system uses a single Redis instance.');
  const b = core.contentHash('The   system uses a single   Redis instance.');
  assert.strictEqual(a, b, 'whitespace differences do not change the hash');
  assert.strictEqual(typeof a, 'string');
  assert.ok(a.length > 0);
});

test('contentHash differs when visible text changes', () => {
  const a = core.contentHash('The plan says use a single Redis instance to coordinate workers.');
  const b = core.contentHash('The plan says use a Redis cluster to coordinate workers instead.');
  assert.notStrictEqual(a, b);
});

test('contentHash returns null below the small-content guard', () => {
  assert.strictEqual(core.contentHash('tiny'), null);
  assert.strictEqual(core.contentHash('x'.repeat(core.MIN_HASH_CHARS - 1)), null, '31 chars → null');
  assert.strictEqual(typeof core.contentHash('x'.repeat(core.MIN_HASH_CHARS)), 'string', '32 chars → hash');
});

/** Map-backed async store implementing the core's store interface. */
function fakeStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, v); return Promise.resolve(); },
    remove: (k) => { m.delete(k); return Promise.resolve(); },
    keys: () => Promise.resolve(Array.from(m.keys())),
    _dump: () => m
  };
}
const idCodec = { compress: (s) => Promise.resolve(s), decompress: (s) => Promise.resolve(s) };
function makeCore(store, t0) {
  let n = 0;
  return core.createDraftHistory({
    store,
    now: () => '2026-06-05T00:00:0' + (n % 10) + 'Z',
    mintId: () => 'lin_' + (++n),
    codec: idCodec,
    limits: { snapshotDrafts: 5, metaDrafts: 15, ttlDays: 99999, maxBytes: 1e9 }
  });
}

test('resolve seeds a fresh draft from fallback comments and mints a lineage', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const r = await dh.resolve({
    contentText: 'x'.repeat(40), attachKey: 'file:///a.html',
    fallbackComments: [], docTitle: 'A'
  });
  assert.strictEqual(r.degraded, false);
  assert.ok(r.contentHash);
  assert.ok(r.lineageId);
  assert.deepStrictEqual(r.comments, []);
  const lin = await store.get('nb:lin:' + r.lineageId);
  assert.deepStrictEqual(lin.generations, [r.contentHash]);
  assert.deepStrictEqual(lin.attachKeys, ['file:///a.html']);
});

test('resolve degrades below the content guard', async () => {
  const dh = makeCore(fakeStore());
  const r = await dh.resolve({ contentText: 'tiny', attachKey: 'k', fallbackComments: [] });
  assert.strictEqual(r.degraded, true);
});

test('persist then resolve again (refresh) returns the saved comments', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const text = 'The system uses a single Redis instance to coordinate.';
  const r1 = await dh.resolve({ contentText: text, attachKey: 'file:///a.html', fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'hi', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: text, attachKey: 'file:///a.html', fallbackComments: [] });
  assert.strictEqual(r2.contentHash, r1.contentHash);
  assert.strictEqual(r2.comments.length, 1);
  assert.strictEqual(r2.comments[0].body, 'hi');
});

test('a content change makes a new draft in the same lineage; history shows the old one', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'The design uses a single Redis instance to coordinate the workers.', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'old note', anchor: { quote: 'Redis', prefix: '', suffix: '', occurrence: 0 }, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: 'The design uses a Redis cluster to coordinate the workers instead.', attachKey: key, fallbackComments: [] });
  assert.notStrictEqual(r2.contentHash, r1.contentHash);
  assert.strictEqual(r2.lineageId, r1.lineageId, 'same lineage via attach key');
  assert.deepStrictEqual(r2.comments, [], 'new draft starts clean');
  const hist = await dh.history({ lineageId: r2.lineageId, exceptHash: r2.contentHash });
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].comments[0].body, 'old note');
});

test('move (same content, new attach key) keeps comments and history', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const text = 'The system uses a single Redis instance to coordinate workers.';
  const r1 = await dh.resolve({ contentText: text, attachKey: 'file:///old.html', fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'kept', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: text, attachKey: 'file:///new.html', fallbackComments: [] });
  assert.strictEqual(r2.comments.length, 1, 'comments found by content hash after move');
  const lin = await store.get('nb:lin:' + r2.lineageId);
  assert.ok(lin.attachKeys.indexOf('file:///new.html') !== -1, 'new path recorded');
});

test('history lists only drafts with >=1 comment, newest first', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'Draft one has plenty of body text here for hashing.', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'one', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: 'Draft two has plenty of body text here for hashing.', attachKey: key, fallbackComments: [] });
  // r2 has no comments → not in history
  const r3 = await dh.resolve({ contentText: 'Draft three has plenty of body text here for hashing.', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r3.contentHash, comments: [{ id: 'c3', body: 'three', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const hist = await dh.history({ lineageId: r3.lineageId, exceptHash: r3.contentHash });
  assert.deepStrictEqual(hist.map((d) => d.comments[0].body), ['one']);
});

test('clearCurrent empties the draft (kept out of history) but leaves siblings', async () => {
  const store = fakeStore();
  const dh = makeCore(store);
  const key = 'file:///a.html';
  const r1 = await dh.resolve({ contentText: 'The first draft has plenty of body text for hashing.', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r1.contentHash, comments: [{ id: 'c1', body: 'one', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  const r2 = await dh.resolve({ contentText: 'The second draft has plenty of body text for hashing.', attachKey: key, fallbackComments: [] });
  await dh.persist({ contentHash: r2.contentHash, comments: [{ id: 'c2', body: 'two', anchor: null, createdAt: 'x', author: null }], sections: [], styles: '' });
  await dh.clearCurrent({ contentHash: r2.contentHash });
  const gen = await store.get('nb:gen:' + r2.contentHash);
  assert.deepStrictEqual(gen.comments, []);
  const hist = await dh.history({ lineageId: r2.lineageId, exceptHash: r2.contentHash });
  assert.deepStrictEqual(hist.map((d) => d.comments[0].body), ['one']);
});
