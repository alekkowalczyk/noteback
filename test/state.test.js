/**
 * Noteback tests — state.test.js
 *
 * Runs under the Node built-in runner ONLY:  node --test
 * No test framework. Uses node:test + node:assert.
 *
 * Covers (per spec §12 / CONTRACTS §2-3.2): createState shape, validateState,
 * immutable add/edit/delete comment, deterministic createdAt stamping, and
 * serialize/deserialize round-trip (incl. empty state and invalid input).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const state = require('../src/runtime/state.js');

const ANCHOR = { quote: 'a queue', prefix: 'uses ', suffix: ' which', occurrence: 0 };
const TS = '2026-06-03T12:00:00.000Z';

test('state module loads with its API surface', () => {
  assert.strictEqual(state.SCHEMA_VERSION, 1);
  assert.strictEqual(typeof state.createState, 'function');
  assert.strictEqual(typeof state.validateState, 'function');
  assert.strictEqual(typeof state.addComment, 'function');
  assert.strictEqual(typeof state.editComment, 'function');
  assert.strictEqual(typeof state.deleteComment, 'function');
  assert.strictEqual(typeof state.serialize, 'function');
  assert.strictEqual(typeof state.deserialize, 'function');
});

// ---------------------------------------------------------------------------
// createState
// ---------------------------------------------------------------------------

test('createState returns a fresh valid empty state', () => {
  const s = state.createState('file:///x.html', 'x.html');
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(s.docId, 'file:///x.html');
  assert.strictEqual(s.docTitle, 'x.html');
  assert.deepStrictEqual(s.comments, []);
  assert.strictEqual(state.validateState(s).valid, true);
});

// ---------------------------------------------------------------------------
// addComment — immutability + stamping
// ---------------------------------------------------------------------------

test('addComment appends immutably and stamps id/createdAt/author', () => {
  const s = state.createState('file:///x.html', 'x.html');
  const s2 = state.addComment(s, { anchor: ANCHOR, body: 'note' }, { createdAt: TS });

  assert.strictEqual(s.comments.length, 0, 'input untouched');
  assert.strictEqual(s2.comments.length, 1);
  assert.notStrictEqual(s2, s, 'returns a new object');
  assert.notStrictEqual(s2.comments, s.comments, 'new comments array');

  const c = s2.comments[0];
  assert.match(c.id, /^c_/);
  assert.deepStrictEqual(c.anchor, ANCHOR);
  assert.strictEqual(c.body, 'note');
  assert.strictEqual(c.createdAt, TS);
  assert.strictEqual(c.author, null);
});

test('addComment generates unique ids across multiple comments', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'one' }, { createdAt: TS });
  s = state.addComment(s, { anchor: ANCHOR, body: 'two' }, { createdAt: TS });
  s = state.addComment(s, { anchor: ANCHOR, body: 'three' }, { createdAt: TS });
  const ids = s.comments.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, 3, 'ids are unique');
  assert.deepStrictEqual(s.comments.map((c) => c.body), ['one', 'two', 'three'], 'creation order preserved');
});

test('addComment accepts an explicit id (deterministic) when provided', () => {
  const s = state.createState('file:///x.html', 'x.html');
  const s2 = state.addComment(s, { anchor: ANCHOR, body: 'note' }, { id: 'c_fixed', createdAt: TS });
  assert.strictEqual(s2.comments[0].id, 'c_fixed');
});

// ---------------------------------------------------------------------------
// editComment
// ---------------------------------------------------------------------------

test('editComment updates body/anchor immutably and leaves others alone', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'old' }, { id: 'c_1', createdAt: TS });
  s = state.addComment(s, { anchor: ANCHOR, body: 'keep' }, { id: 'c_2', createdAt: TS });

  const s2 = state.editComment(s, 'c_1', { body: 'new body' });
  assert.strictEqual(s.comments[0].body, 'old', 'input untouched');
  assert.strictEqual(s2.comments[0].body, 'new body');
  assert.strictEqual(s2.comments[1].body, 'keep');
  assert.notStrictEqual(s2, s);

  const newAnchor = { quote: 'other', prefix: '', suffix: '', occurrence: 1 };
  const s3 = state.editComment(s2, 'c_1', { anchor: newAnchor });
  assert.deepStrictEqual(s3.comments[0].anchor, newAnchor);
  assert.strictEqual(s3.comments[0].body, 'new body', 'unspecified fields preserved');
});

test('editComment on a missing id is a no-op new state', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'a' }, { id: 'c_1', createdAt: TS });
  const s2 = state.editComment(s, 'c_missing', { body: 'x' });
  assert.deepStrictEqual(s2.comments, s.comments);
});

// ---------------------------------------------------------------------------
// deleteComment
// ---------------------------------------------------------------------------

test('deleteComment removes the matching comment immutably', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'a' }, { id: 'c_1', createdAt: TS });
  s = state.addComment(s, { anchor: ANCHOR, body: 'b' }, { id: 'c_2', createdAt: TS });

  const s2 = state.deleteComment(s, 'c_1');
  assert.strictEqual(s.comments.length, 2, 'input untouched');
  assert.strictEqual(s2.comments.length, 1);
  assert.strictEqual(s2.comments[0].id, 'c_2');
});

test('deleteComment on a missing id leaves comments unchanged', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'a' }, { id: 'c_1', createdAt: TS });
  const s2 = state.deleteComment(s, 'nope');
  assert.strictEqual(s2.comments.length, 1);
});

// ---------------------------------------------------------------------------
// validateState
// ---------------------------------------------------------------------------

test('validateState accepts a well-formed state', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'note' }, { id: 'c_1', createdAt: TS });
  const r = state.validateState(s);
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.errors, []);
});

test('validateState reports a non-object input', () => {
  const r = state.validateState(null);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test('validateState reports a wrong schemaVersion', () => {
  const r = state.validateState({ schemaVersion: 99, docId: 'x', docTitle: 'x', comments: [] });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /schemaVersion/i.test(e)));
});

test('validateState reports missing docId / docTitle / comments', () => {
  const r = state.validateState({ schemaVersion: 1 });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /docId/i.test(e)));
  assert.ok(r.errors.some((e) => /docTitle/i.test(e)));
  assert.ok(r.errors.some((e) => /comments/i.test(e)));
});

test('validateState reports a malformed comment', () => {
  const bad = {
    schemaVersion: 1,
    docId: 'x',
    docTitle: 'x',
    comments: [{ id: 'c_1', body: 'note' }] // missing anchor/createdAt
  };
  const r = state.validateState(bad);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test('validateState rejects a comment whose anchor.quote is empty', () => {
  const bad = {
    schemaVersion: 1,
    docId: 'x',
    docTitle: 'x',
    comments: [
      {
        id: 'c_1',
        anchor: { quote: '', prefix: '', suffix: '', occurrence: 0 },
        body: 'note',
        createdAt: TS,
        author: null
      }
    ]
  };
  const r = state.validateState(bad);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => /quote/i.test(e)));
});

// ---------------------------------------------------------------------------
// document-level comments (anchor === null)
// ---------------------------------------------------------------------------

test('addComment with anchor:null stores a valid document-level comment', () => {
  const s = state.createState('file:///x.html', 'x.html');
  const s2 = state.addComment(s, { anchor: null, body: 'whole-doc note' }, { id: 'c_d', createdAt: TS });
  const c = s2.comments[0];
  assert.strictEqual(c.anchor, null, 'anchor preserved as null (document-level)');
  assert.strictEqual(c.body, 'whole-doc note');
  assert.strictEqual(state.validateState(s2).valid, true, 'document-level comment is valid');
});

test('validateState accepts anchor:null but still rejects a missing anchor key', () => {
  const base = { schemaVersion: 1, docId: 'x', docTitle: 'x' };
  const ok = state.validateState({
    ...base,
    comments: [{ id: 'c_1', anchor: null, body: 'n', createdAt: TS, author: null }]
  });
  assert.strictEqual(ok.valid, true);

  const missing = state.validateState({
    ...base,
    comments: [{ id: 'c_1', body: 'n', createdAt: TS, author: null }] // no anchor key
  });
  assert.strictEqual(missing.valid, false);
  assert.ok(missing.errors.some((e) => /anchor/i.test(e)));
});

test('serialize/deserialize round-trips a document-level comment', () => {
  let s = state.createState('file:///doc.html', 'doc.html');
  s = state.addComment(s, { anchor: null, body: 'about the whole doc' }, { id: 'c_d', createdAt: TS });
  const back = state.deserialize(state.serialize(s));
  assert.deepStrictEqual(back, s);
  assert.strictEqual(back.comments[0].anchor, null);
});

test('editComment keeps a document-level comment null-anchored when editing body', () => {
  let s = state.createState('file:///x.html', 'x.html');
  s = state.addComment(s, { anchor: null, body: 'first' }, { id: 'c_d', createdAt: TS });
  const s2 = state.editComment(s, 'c_d', { body: 'edited' });
  assert.strictEqual(s2.comments[0].anchor, null);
  assert.strictEqual(s2.comments[0].body, 'edited');
});

// ---------------------------------------------------------------------------
// serialize / deserialize
// ---------------------------------------------------------------------------

test('serialize/deserialize round-trips an empty state', () => {
  const s = state.createState('file:///x.html', 'x.html');
  const json = state.serialize(s);
  assert.strictEqual(typeof json, 'string');
  const back = state.deserialize(json);
  assert.deepStrictEqual(back, s);
});

test('serialize/deserialize round-trips a populated state', () => {
  let s = state.createState('file:///doc.html', 'doc.html');
  s = state.addComment(s, { anchor: ANCHOR, body: 'first' }, { id: 'c_1', createdAt: TS });
  s = state.addComment(
    s,
    { anchor: { quote: 'X', prefix: 'p', suffix: 's', occurrence: 1 }, body: 'second' },
    { id: 'c_2', createdAt: TS }
  );
  const back = state.deserialize(state.serialize(s));
  assert.deepStrictEqual(back, s);
});

test('deserialize tolerates pretty-printed JSON', () => {
  const s = state.createState('file:///x.html', 'x.html');
  const pretty = JSON.stringify(s, null, 2);
  assert.deepStrictEqual(state.deserialize(pretty), s);
});

test('deserialize returns null on invalid JSON', () => {
  assert.strictEqual(state.deserialize('{not json'), null);
});

test('deserialize returns null on structurally invalid state', () => {
  assert.strictEqual(state.deserialize(JSON.stringify({ schemaVersion: 2 })), null);
});

test('deserialize returns null on empty/blank input', () => {
  assert.strictEqual(state.deserialize(''), null);
  assert.strictEqual(state.deserialize('   '), null);
});
