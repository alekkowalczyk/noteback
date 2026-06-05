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
  assert.ok(core.contentHash('x'.repeat(core.MIN_HASH_CHARS)) !== null);
});
