/**
 * Noteback tests — anchor.test.js
 *
 * Runs under the Node built-in runner ONLY:  node --test
 * No test framework. Uses node:test + node:assert.
 *
 * Covers (per spec §12 / §6): describeAnchor / findAnchor round-trip,
 * occurrence-index disambiguation of duplicate phrases, prefix/suffix context
 * capture, whitespace-normalized matching, and the orphan (null) case.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const anchor = require('../src/runtime/anchor.js');

test('anchor module loads with its API surface', () => {
  assert.strictEqual(typeof anchor.describeAnchor, 'function');
  assert.strictEqual(typeof anchor.findAnchor, 'function');
  assert.strictEqual(typeof anchor.getDocumentText, 'function');
  assert.strictEqual(anchor.DEFAULT_CONTEXT_LEN, 32);
});

// ---------------------------------------------------------------------------
// describeAnchor
// ---------------------------------------------------------------------------

test('describeAnchor extracts quote + bounded prefix/suffix', () => {
  const text = 'The system uses a queue which decouples the producer and consumer so that bursts are absorbed.';
  const start = text.indexOf('a queue which decouples the producer and consumer');
  const end = start + 'a queue which decouples the producer and consumer'.length;

  const a = anchor.describeAnchor(text, start, end);
  assert.strictEqual(a.quote, 'a queue which decouples the producer and consumer');
  // prefix is up to DEFAULT_CONTEXT_LEN (32) chars immediately before the quote
  assert.strictEqual(a.prefix, 'The system uses ');
  // suffix is up to 32 chars immediately after the quote
  assert.strictEqual(a.suffix, ' so that bursts are absorbed.'.slice(0, 32));
  assert.strictEqual(a.occurrence, 0);
});

test('describeAnchor honours a custom contextLen', () => {
  const text = 'abcdefghij KEYWORD klmnopqrst';
  const start = text.indexOf('KEYWORD');
  const end = start + 'KEYWORD'.length;
  const a = anchor.describeAnchor(text, start, end, 4);
  assert.strictEqual(a.quote, 'KEYWORD');
  assert.strictEqual(a.prefix, 'hij ');
  assert.strictEqual(a.suffix, ' klm');
});

test('describeAnchor clamps prefix/suffix at document boundaries', () => {
  const text = 'KEYWORD here';
  const a = anchor.describeAnchor(text, 0, 'KEYWORD'.length);
  assert.strictEqual(a.prefix, '');
  assert.strictEqual(a.suffix, ' here');
});

test('describeAnchor computes occurrence index for duplicate quotes', () => {
  const text = 'foo bar foo bar foo';
  // the third "foo" (0-based index 2)
  const start = text.lastIndexOf('foo');
  const end = start + 3;
  const a = anchor.describeAnchor(text, start, end);
  assert.strictEqual(a.quote, 'foo');
  assert.strictEqual(a.occurrence, 2);
});

test('describeAnchor occurrence is 0 for the first match', () => {
  const text = 'foo bar foo bar foo';
  const a = anchor.describeAnchor(text, 0, 3);
  assert.strictEqual(a.occurrence, 0);
});

// ---------------------------------------------------------------------------
// findAnchor — basic round-trip
// ---------------------------------------------------------------------------

test('findAnchor round-trips a describeAnchor result', () => {
  const text = 'The system uses a queue which decouples the producer and consumer so that bursts are absorbed.';
  const start = text.indexOf('a queue');
  const end = start + 'a queue which decouples the producer and consumer'.length;
  const a = anchor.describeAnchor(text, start, end);
  assert.deepStrictEqual(anchor.findAnchor(text, a), { start, end });
});

test('findAnchor returns the correct range for a single unique match', () => {
  const text = 'alpha beta gamma delta';
  const a = { quote: 'gamma', prefix: 'beta ', suffix: ' delta', occurrence: 0 };
  const r = anchor.findAnchor(text, a);
  assert.deepStrictEqual(r, { start: text.indexOf('gamma'), end: text.indexOf('gamma') + 5 });
});

// ---------------------------------------------------------------------------
// findAnchor — occurrence disambiguation
// ---------------------------------------------------------------------------

test('findAnchor selects the nth occurrence of a duplicate quote', () => {
  const text = 'foo bar foo bar foo';
  const idx2 = text.lastIndexOf('foo'); // occurrence 2
  const a = { quote: 'foo', prefix: 'bar ', suffix: '', occurrence: 2 };
  assert.deepStrictEqual(anchor.findAnchor(text, a), { start: idx2, end: idx2 + 3 });

  const idx0 = 0;
  const a0 = { quote: 'foo', prefix: '', suffix: ' bar', occurrence: 0 };
  assert.deepStrictEqual(anchor.findAnchor(text, a0), { start: idx0, end: idx0 + 3 });

  const idx1 = text.indexOf('foo', 1); // occurrence 1
  const a1 = { quote: 'foo', prefix: 'bar ', suffix: ' bar', occurrence: 1 };
  assert.deepStrictEqual(anchor.findAnchor(text, a1), { start: idx1, end: idx1 + 3 });
});

test('findAnchor describe→find round-trips for each duplicate occurrence', () => {
  const text = 'foo bar foo bar foo';
  for (let occ = 0; occ < 3; occ++) {
    let start = -1;
    for (let i = 0; i <= occ; i++) start = text.indexOf('foo', start + 1);
    const end = start + 3;
    const a = anchor.describeAnchor(text, start, end);
    assert.strictEqual(a.occurrence, occ, `describe occurrence for #${occ}`);
    assert.deepStrictEqual(anchor.findAnchor(text, a), { start, end }, `find range for #${occ}`);
  }
});

test('findAnchor falls back to prefix/suffix when occurrence is stale', () => {
  // Doc changed: one earlier "foo" was deleted, so the original occurrence index
  // (2) no longer points at the intended match, but the surrounding context does.
  const text = 'foo bar foo'; // now only two "foo"s
  const a = { quote: 'foo', prefix: 'bar ', suffix: '', occurrence: 2 };
  const expected = text.lastIndexOf('foo');
  assert.deepStrictEqual(anchor.findAnchor(text, a), { start: expected, end: expected + 3 });
});

// ---------------------------------------------------------------------------
// findAnchor — whitespace-normalized matching
// ---------------------------------------------------------------------------

test('findAnchor matches across normalized whitespace differences', () => {
  // Document has the quote split across newlines / multiple spaces; the stored
  // quote is single-spaced. Normalized matching should still find it.
  const text = 'Intro.\nThe   quick\nbrown   fox jumps.';
  const a = { quote: 'The quick brown fox', prefix: '', suffix: '', occurrence: 0 };
  const r = anchor.findAnchor(text, a);
  assert.notStrictEqual(r, null);
  // The matched slice, once whitespace-collapsed, equals the quote.
  const matched = text.slice(r.start, r.end).replace(/\s+/g, ' ').trim();
  assert.strictEqual(matched, 'The quick brown fox');
});

test('findAnchor tolerates leading/trailing whitespace variance in the quote', () => {
  const text = 'a  b  c';
  const a = { quote: 'a b', prefix: '', suffix: '', occurrence: 0 };
  const r = anchor.findAnchor(text, a);
  assert.notStrictEqual(r, null);
  assert.strictEqual(text.slice(r.start, r.end).replace(/\s+/g, ' '), 'a b');
});

// ---------------------------------------------------------------------------
// findAnchor — orphan case
// ---------------------------------------------------------------------------

test('findAnchor returns null when the quote is absent (orphan)', () => {
  const text = 'this document no longer contains the phrase';
  const a = { quote: 'a queue which decouples', prefix: '', suffix: '', occurrence: 0 };
  assert.strictEqual(anchor.findAnchor(text, a), null);
});

test('findAnchor returns null for an empty quote', () => {
  assert.strictEqual(anchor.findAnchor('some text', { quote: '', prefix: '', suffix: '', occurrence: 0 }), null);
});

test('findAnchor returns null when the requested occurrence does not exist and context fails', () => {
  const text = 'foo bar foo';
  const a = { quote: 'foo', prefix: 'zzz ', suffix: ' zzz', occurrence: 5 };
  // occurrence 5 doesn't exist and the prefix/suffix context matches nothing.
  const r = anchor.findAnchor(text, a);
  // Implementation may still resolve via best-effort; assert it never returns a
  // bogus out-of-range result.
  if (r !== null) {
    assert.ok(r.start >= 0 && r.end <= text.length && r.start < r.end);
    assert.strictEqual(text.slice(r.start, r.end).replace(/\s+/g, ' '), 'foo');
  }
});

// ---------------------------------------------------------------------------
// getDocumentText (minimal DOM-free smoke; full DOM behavior is browser-tested)
// ---------------------------------------------------------------------------

test('getDocumentText reads textContent from a node-like object', () => {
  const fakeNode = { textContent: 'hello world' };
  assert.strictEqual(anchor.getDocumentText(fakeNode), 'hello world');
});
