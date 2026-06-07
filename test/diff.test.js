/**
 * Noteback tests — diff.test.js
 * Runs under the Node built-in runner ONLY:  node --test
 * Covers the pure diff brain (src/runtime/diff.js): word tokenizing, generic
 * LCS sequence diff, word-level diff, similarity, and block planning.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const diff = require('../src/runtime/diff.js');

test('diff module loads with its API surface', () => {
  assert.strictEqual(typeof diff.tokenizeWords, 'function');
  assert.strictEqual(typeof diff.diffSequences, 'function');
  assert.strictEqual(typeof diff.diffWords, 'function');
  assert.strictEqual(typeof diff.similarity, 'function');
  assert.strictEqual(typeof diff.planBlocks, 'function');
});

test('tokenizeWords keeps separators so join reproduces the input', () => {
  const s = 'the  quick brown\tfox';
  assert.strictEqual(diff.tokenizeWords(s).join(''), s);
  assert.deepStrictEqual(diff.tokenizeWords('a b'), ['a', ' ', 'b']);
  assert.deepStrictEqual(diff.tokenizeWords(''), []);
  assert.deepStrictEqual(diff.tokenizeWords(null), []);
});

test('diffSequences: identical arrays are all eq', () => {
  const ops = diff.diffSequences(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.deepStrictEqual(ops, [{ op: 'eq', items: ['a', 'b', 'c'] }]);
});

test('diffSequences: empty sides', () => {
  assert.deepStrictEqual(diff.diffSequences([], []), []);
  assert.deepStrictEqual(diff.diffSequences([], ['x']), [{ op: 'ins', items: ['x'] }]);
  assert.deepStrictEqual(diff.diffSequences(['x'], []), [{ op: 'del', items: ['x'] }]);
});

test('diffSequences: a middle insert and a middle delete', () => {
  // insert 'X' between a and b
  assert.deepStrictEqual(
    diff.diffSequences(['a', 'b'], ['a', 'X', 'b']),
    [{ op: 'eq', items: ['a'] }, { op: 'ins', items: ['X'] }, { op: 'eq', items: ['b'] }]
  );
  // delete 'b' from the middle
  assert.deepStrictEqual(
    diff.diffSequences(['a', 'b', 'c'], ['a', 'c']),
    [{ op: 'eq', items: ['a'] }, { op: 'del', items: ['b'] }, { op: 'eq', items: ['c'] }]
  );
});

test('diffSequences: fully disjoint → del-run then ins-run', () => {
  assert.deepStrictEqual(
    diff.diffSequences(['a', 'b'], ['x', 'y']),
    [{ op: 'del', items: ['a', 'b'] }, { op: 'ins', items: ['x', 'y'] }]
  );
});

test('diffWords: word-level edit coalesces runs and rejoins text', () => {
  const runs = diff.diffWords('the quick brown fox', 'the slow brown fox');
  // 'the ' eq, 'quick' del, 'slow' ins, ' brown fox' eq
  const eq = runs.filter((r) => r.op === 'eq').map((r) => r.text).join('|');
  assert.ok(eq.includes('the'), 'keeps the unchanged "the"');
  assert.ok(runs.some((r) => r.op === 'del' && r.text === 'quick'), 'marks "quick" deleted');
  assert.ok(runs.some((r) => r.op === 'ins' && r.text === 'slow'), 'marks "slow" inserted');
  // Reconstructing eq+ins reproduces the target; eq+del reproduces the base.
  assert.strictEqual(runs.filter((r) => r.op !== 'del').map((r) => r.text).join(''), 'the slow brown fox');
  assert.strictEqual(runs.filter((r) => r.op !== 'ins').map((r) => r.text).join(''), 'the quick brown fox');
});

test('similarity: identical=1, disjoint=0, partial in between, empty-empty=1', () => {
  assert.strictEqual(diff.similarity('alpha beta gamma', 'alpha beta gamma'), 1);
  assert.strictEqual(diff.similarity('alpha beta', 'x y z'), 0);
  assert.strictEqual(diff.similarity('', ''), 1);
  assert.strictEqual(diff.similarity('alpha', ''), 0);
  const partial = diff.similarity('the quick brown fox', 'the quick red fox');
  assert.ok(partial > 0.5 && partial < 1, 'a one-word change is highly similar (got ' + partial + ')');
});

test('planBlocks: unchanged blocks are all eq', () => {
  const steps = diff.planBlocks(['A', 'B'], ['A', 'B']);
  assert.deepStrictEqual(steps, [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'eq', baseIndex: 1, targetIndex: 1 }
  ]);
});

test('planBlocks: a pure insert and a pure delete', () => {
  assert.deepStrictEqual(diff.planBlocks(['A'], ['A', 'B']), [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'ins', targetIndex: 1 }
  ]);
  assert.deepStrictEqual(diff.planBlocks(['A', 'B'], ['A']), [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'del', baseIndex: 1 }
  ]);
});

test('planBlocks: a similar replaced block becomes an edit', () => {
  const steps = diff.planBlocks(
    ['Ship in Q2 and early Q3 with a small team'],
    ['Ship in Q2 and late Q3 with a small team']
  );
  assert.deepStrictEqual(steps, [{ type: 'edit', baseIndex: 0, targetIndex: 0 }]);
});

test('planBlocks: a dissimilar replaced block stays del + ins', () => {
  const steps = diff.planBlocks(['totally unrelated alpha'], ['completely different beta']);
  assert.deepStrictEqual(steps, [
    { type: 'del', baseIndex: 0 },
    { type: 'ins', targetIndex: 0 }
  ]);
});

test('planBlocks: edit in the middle keeps surrounding eq blocks aligned', () => {
  const steps = diff.planBlocks(
    ['intro para', 'the quick brown fox', 'outro para'],
    ['intro para', 'the quick red fox', 'outro para']
  );
  assert.deepStrictEqual(steps, [
    { type: 'eq', baseIndex: 0, targetIndex: 0 },
    { type: 'edit', baseIndex: 1, targetIndex: 1 },
    { type: 'eq', baseIndex: 2, targetIndex: 2 }
  ]);
});
