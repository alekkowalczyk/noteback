const { test } = require('node:test');
const assert = require('node:assert');
const cap = require('../src/runtime/snapshot-capture.js');

test('identityCodec is a no-op string round-trip', async () => {
  assert.strictEqual(await cap.identityCodec.compress('x'), 'x');
  assert.strictEqual(await cap.identityCodec.decompress('x'), 'x');
});

test('stripNotebackFromHtml removes UI, marks, state block, runtime script', () => {
  const dirty = '<!DOCTYPE html><html><head><style>p{}</style></head><body>' +
    '<div data-noteback-ui="sidebar">UI</div>' +
    '<p>Hello <mark class="noteback-highlight" data-noteback-id="c1">world</mark>!</p>' +
    '<script type="application/json" id="noteback-state">{"x":1}</script>' +
    '<script>window.NotebackRuntime={};</script>' +
    '</body></html>';
  const clean = cap.stripNotebackFromHtml(dirty);
  assert.ok(!clean.includes('data-noteback-ui'));
  assert.ok(!clean.includes('noteback-state'));
  assert.ok(!clean.includes('NotebackRuntime'));
  assert.ok(clean.includes('Hello world!'), 'mark unwrapped, text preserved');
});

test('stripNotebackFromHtml preserves a legitimate non-Noteback inline script', () => {
  const html = '<html><body><p>x</p><script>var analytics = 1;</script></body></html>';
  const clean = cap.stripNotebackFromHtml(html);
  assert.ok(clean.includes('var analytics = 1'), 'user script preserved');
});
