/**
 * Noteback tests — markdown.test.js
 *
 * Runs under the Node built-in runner ONLY:  node --test
 * No test framework. Uses node:test + node:assert.
 *
 * Covers (per spec §8.1 / CONTRACTS §3.3): toMarkdown produces the clean/neutral
 * format — heading, "<N> comments — <date>" line, then numbered "> quote" + body
 * items. Includes multi-comment ordering, singular/plural, empty state, and the
 * injected-date option.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const markdown = require('../src/runtime/markdown.js');

function mkComment(quote, body) {
  return {
    id: 'c_x',
    anchor: { quote, prefix: '', suffix: '', occurrence: 0 },
    body,
    createdAt: '2026-06-03T12:00:00.000Z',
    author: null
  };
}

test('markdown module loads with its API surface', () => {
  assert.strictEqual(typeof markdown.toMarkdown, 'function');
});

test('toMarkdown renders the exact spec §8.1 format', () => {
  const state = {
    schemaVersion: 1,
    docId: 'file:///spec.html',
    docTitle: 'spec.html',
    comments: [
      mkComment('a queue which decouples the producer and consumer', 'use a stream here instead'),
      mkComment('Each user has a single workspace', 'should support many')
    ]
  };

  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  const expected = [
    '# Feedback on spec.html',
    '2 comments — 2026-06-03',
    '',
    '1. > "a queue which decouples the producer and consumer"',
    '   use a stream here instead',
    '',
    '2. > "Each user has a single workspace"',
    '   should support many',
    ''
  ].join('\n');

  assert.strictEqual(md, expected);
});

test('toMarkdown preserves comment order', () => {
  const state = {
    schemaVersion: 1,
    docId: 'x',
    docTitle: 'd.html',
    comments: [mkComment('first quote', 'first note'), mkComment('second quote', 'second note'), mkComment('third quote', 'third note')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  const i1 = md.indexOf('first quote');
  const i2 = md.indexOf('second quote');
  const i3 = md.indexOf('third quote');
  assert.ok(i1 < i2 && i2 < i3, 'quotes appear in order');
  assert.match(md, /1\. > "first quote"/);
  assert.match(md, /2\. > "second quote"/);
  assert.match(md, /3\. > "third quote"/);
});

test('toMarkdown uses singular "comment" for exactly one', () => {
  const state = { schemaVersion: 1, docId: 'x', docTitle: 'd.html', comments: [mkComment('q', 'b')] };
  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  assert.match(md, /^# Feedback on d\.html\n1 comment — 2026-06-03\n/);
});

test('toMarkdown handles an empty state (0 comments)', () => {
  const state = { schemaVersion: 1, docId: 'x', docTitle: 'empty.html', comments: [] };
  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  assert.strictEqual(md, '# Feedback on empty.html\n0 comments — 2026-06-03\n');
});

test('toMarkdown defaults the date to today (YYYY-MM-DD) when not provided', () => {
  const state = { schemaVersion: 1, docId: 'x', docTitle: 'd.html', comments: [] };
  const md = markdown.toMarkdown(state);
  assert.match(md, /^# Feedback on d\.html\n0 comments — \d{4}-\d{2}-\d{2}\n$/);
});

test('toMarkdown renders multi-line comment bodies with continuation indent', () => {
  const state = {
    schemaVersion: 1,
    docId: 'x',
    docTitle: 'd.html',
    comments: [mkComment('quote', 'line one\nline two')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  assert.match(md, /1\. > "quote"\n   line one\n   line two\n/);
});
