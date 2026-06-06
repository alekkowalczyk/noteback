const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('../src/adapters/chrome-kv-store.js');

function fakeChrome() {
  const m = new Map();
  return { runtime: {}, storage: { local: {
    get: (k, cb) => { if (k === null) { const o = {}; m.forEach((v, kk) => { o[kk] = v; }); return cb(o); } const o = {}; if (m.has(k)) o[k] = m.get(k); cb(o); },
    set: (bag, cb) => { Object.keys(bag).forEach((kk) => m.set(kk, bag[kk])); cb(); },
    remove: (k, cb) => { m.delete(k); cb(); }
  } } };
}

test('chrome-kv-store get/set/remove/keys round-trip', async () => {
  const kv = mod.createChromeKvStore(fakeChrome());
  assert.strictEqual(await kv.get('nb:doc:D1'), null);
  await kv.set('nb:doc:D1', { a: 1 });
  assert.deepStrictEqual(await kv.get('nb:doc:D1'), { a: 1 });
  await kv.set('nb:ver:V1', { b: 2 });
  assert.deepStrictEqual((await kv.keys()).sort(), ['nb:doc:D1', 'nb:ver:V1']);
  await kv.remove('nb:doc:D1');
  assert.strictEqual(await kv.get('nb:doc:D1'), null);
});
