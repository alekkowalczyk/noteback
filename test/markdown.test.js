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

test('toMarkdown renders a document-level (null-anchor) note without a quote', () => {
  const state = {
    schemaVersion: 1,
    docId: 'x',
    docTitle: 'd.html',
    comments: [
      { id: 'c_d', anchor: null, body: 'overall this needs a threat model', createdAt: '2026-06-03T12:00:00.000Z', author: null }
    ]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  const expected = [
    '# Feedback on d.html',
    '1 comment — 2026-06-03',
    '',
    '1. (note on the whole document)',
    '   overall this needs a threat model',
    ''
  ].join('\n');
  assert.strictEqual(md, expected);
});

test('toMarkdown mixes quoted and whole-document notes', () => {
  const state = {
    schemaVersion: 1,
    docId: 'x',
    docTitle: 'd.html',
    comments: [
      mkComment('a single Redis instance', 'SPOF'),
      { id: 'c_d', anchor: null, body: 'needs a threat model', createdAt: '2026-06-03T12:00:00.000Z', author: null }
    ]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03' });
  assert.match(md, /1\. > "a single Redis instance"/);
  assert.match(md, /2\. \(note on the whole document\)\n   needs a threat model/);
});

/* --- line references (opt-in via opts.docHtml) ----------------------------- */

test('toMarkdown appends a single-line ref when the quote is on one line', () => {
  const docHtml = [
    '<h1>Spec</h1>',                       // line 1
    '<p>RealtimeSync keeps documents in sync.</p>', // line 2
    '<p>Each user has a single workspace.</p>'      // line 3
  ].join('\n');
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [mkComment('a single workspace', 'should support many')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml });
  assert.match(md, /1\. > "a single workspace" \(line 3\)/);
});

test('toMarkdown emits a line RANGE for a multi-line passage', () => {
  const docHtml = [
    '<p>intro</p>',          // 1
    '<p>alpha',              // 2  (quote starts here)
    'beta',                  // 3
    'gamma</p>'              // 4  (quote ends here)
  ].join('\n');
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [mkComment('alpha\nbeta\ngamma', 'spans lines')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml });
  assert.match(md, /\(lines 2–4\)/);
});

test('toMarkdown spans a line range for a selection crossing block boundaries', () => {
  const docHtml = [
    '<h2>Architecture</h2>',                 // 1
    '<p>Incoming edits go to Redis</p>',     // 2  (quote starts: "Incoming edits go to Redis")
    '<h2>Data Model</h2>',                   // 3
    '<p>checked on every edit</p>'           // 4  (quote ends: "checked on every edit")
  ].join('\n');
  // Flat-text selection across the two <p> blocks: tags are gone, but the source
  // newlines between blocks remain as whitespace text nodes.
  const quote = 'Incoming edits go to Redis\nData Model\nchecked on every edit';
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [mkComment(quote, 'failure story?')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml });
  assert.match(md, /\(lines 2–4\)/);
});

test('toMarkdown honours occurrence to pick the right repeat for the line ref', () => {
  const docHtml = ['<p>token</p>', '<p>token</p>', '<p>token</p>'].join('\n'); // lines 1,2,3
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [{ id: 'c', anchor: { quote: 'token', prefix: '', suffix: '', occurrence: 2 }, body: 'third one', createdAt: '2026-06-03T12:00:00.000Z', author: null }]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml });
  assert.match(md, /\(line 3\)/);
});

test('toMarkdown locates a quote containing &/< via entity-encoded fallback', () => {
  const docHtml = '<p>cost is 5 &amp; rising &lt; 10</p>'; // line 1
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [mkComment('5 & rising < 10', 'clarify')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml });
  assert.match(md, /\(line 1\)/);
});

test('toMarkdown omits a line ref when the quote is not found', () => {
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [mkComment('nowhere to be found', 'note')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml: '<p>unrelated text</p>' });
  assert.match(md, /1\. > "nowhere to be found"\n/); // no "(line ...)" suffix
  assert.doesNotMatch(md, /\(line/);
});

/* --- long-quote condensing ------------------------------------------------- */

test('condenseQuote leaves a short quote untouched (whitespace collapsed)', () => {
  assert.strictEqual(markdown.condenseQuote('a   short\nquote'), 'a short quote');
});

test('condenseQuote keeps first/last sentences of a long passage with " (…) "', () => {
  const long =
    'The system starts here with the first point. ' +
    'Then a second sentence elaborates further on the design. ' +
    'A third middle sentence adds detail nobody needs to re-read. ' +
    'A fourth middle sentence keeps going and going and going. ' +
    'A fifth sentence still in the middle of the passage. ' +
    'Finally the passage ends with this concluding thought.';
  const out = markdown.condenseQuote(long);
  assert.ok(out.length < long.length, 'condensed is shorter');
  assert.match(out, / \(…\) /);
  assert.match(out, /^The system starts here/);
  assert.match(out, /concluding thought\.$/);
  assert.doesNotMatch(out, /third middle sentence/);
});

test('toMarkdown condenses a long quote inline but its line ref spans the full passage', () => {
  // The selection's flat text preserves the source newlines (text nodes do),
  // so the quote and the markup share the same line breaks.
  const sentences = [
    'Sentence one introduces the overall idea of the passage clearly.',
    'Sentence two continues to elaborate on the supporting detail at length.',
    'Sentence three is filler that nobody really needs to read again later.',
    'Sentence four is filler too and keeps padding out the middle section.',
    'Sentence five wraps up this deliberately long passage in its entirety.'
  ];
  const quote = sentences.join('\n');                 // each sentence on its own line
  const docHtml = '<p>\n' + quote + '\n</p>';         // line 1 = <p>, lines 2–6 = sentences
  const state = {
    schemaVersion: 1, docId: 'x', docTitle: 'd.html',
    comments: [mkComment(quote, 'too long')]
  };
  const md = markdown.toMarkdown(state, { date: '2026-06-03', docHtml });
  assert.match(md, / \(…\) /);            // condensed display
  assert.match(md, /\(lines 2–6\)/);      // ranged ref over the full passage
});
