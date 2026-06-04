/**
 * Noteback tests — exporter.test.js
 *
 * Runs under the Node built-in runner ONLY:  node --test
 * No test framework. Uses node:test + node:assert.
 *
 * Covers the PURE canvas builder (CONTRACTS.md §3.6 / §5 / §6 / §7, spec §8.2):
 *   - buildCanvasHtml fills the template tokens (title, guiding comment, body,
 *     state block, inlined runtime + embedded boot),
 *   - it strips Noteback's injected UI, highlight <mark> wrappers, the stale
 *     state block, and any prior inlined runtime from the captured doc markup,
 *   - the produced state block round-trips as valid JSON,
 *   - the inlined runtime contains no premature "</script>" and the full
 *     runtime+boot blob is syntactically valid JavaScript (so the canvas works
 *     with NO extension installed — spec §12 integration intent),
 *   - extractBodyMarkup + sanitizeFilename edge cases.
 *
 * The DOM helpers (downloadCanvas / saveCanvasInPlace) are browser-only and not
 * unit-tested here.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const exporter = require('../src/canvas/exporter.js');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = fs.readFileSync(
  path.join(ROOT, 'src/canvas/canvas-template.html'),
  'utf8'
);

// The same dependency-ordered runtime the service worker concatenates (§4).
const RUNTIME_FILES = [
  'src/runtime/anchor.js',
  'src/runtime/state.js',
  'src/runtime/markdown.js',
  'src/runtime/highlight.js',
  'src/runtime/overlay.js',
  'src/adapters/infile-state-adapter.js',
  'src/canvas/exporter.js',
  'src/runtime/boot.js'
];

function concatRuntime() {
  return RUNTIME_FILES
    .map(function (p) {
      return '/* === ' + p + ' === */\n' + fs.readFileSync(path.join(ROOT, p), 'utf8');
    })
    .join('\n\n');
}

function mkState(comments) {
  return {
    schemaVersion: 1,
    docId: 'file:///Users/me/spec.html',
    docTitle: 'spec.html',
    comments: comments || []
  };
}

function mkComment(id, quote, body) {
  return {
    id: id,
    anchor: { quote: quote, prefix: '', suffix: '', occurrence: 0 },
    body: body,
    createdAt: '2026-06-03T00:00:00.000Z',
    author: null
  };
}

/** Extract the inner text of the runtime <script> (the last, untyped one). */
function extractRuntimeScript(html) {
  const marker = '<!-- Inlined portable runtime';
  const idx = html.indexOf('<script>', html.indexOf(marker));
  const end = html.indexOf('</script>', idx);
  return html.slice(idx + '<script>'.length, end);
}

/** Extract the JSON state block text. */
function extractStateBlock(html) {
  const m = /<script type="application\/json" id="noteback-state">([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1].trim() : null;
}

test('exporter module exposes its API surface', () => {
  assert.strictEqual(typeof exporter.buildCanvasHtml, 'function');
  assert.strictEqual(typeof exporter.extractBodyMarkup, 'function');
  assert.strictEqual(typeof exporter.downloadCanvas, 'function');
  assert.strictEqual(typeof exporter.saveCanvasInPlace, 'function');
  assert.strictEqual(typeof exporter.sanitizeFilename, 'function');
});

test('GUIDING_COMMENT matches the CONTRACTS §6 exact string', () => {
  assert.strictEqual(
    exporter.GUIDING_COMMENT,
    '<!-- Noteback feedback canvas: each item is a quoted passage + a note. ' +
      'Please revise the document accordingly. -->'
  );
});

test('buildCanvasHtml fills every template token (no {{…}} left)', () => {
  const html = exporter.buildCanvasHtml({
    docHtml: '<body><h1>Hi</h1></body>',
    state: mkState([mkComment('c_1', 'Hi', 'note')]),
    templateHtml: TEMPLATE,
    inlinedRuntime: '/* rt */'
  });
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'no unreplaced tokens remain');
});

test('buildCanvasHtml places the guiding comment and a single state block', () => {
  const html = exporter.buildCanvasHtml({
    docHtml: '<body><p>x</p></body>',
    state: mkState([]),
    templateHtml: TEMPLATE,
    inlinedRuntime: ''
  });
  assert.ok(html.includes(exporter.GUIDING_COMMENT), 'guiding comment present');
  const blocks = html.match(/id="noteback-state"/g) || [];
  assert.strictEqual(blocks.length, 1, 'exactly one state block');
});

test('buildCanvasHtml escapes the title and uses it in <title>', () => {
  const html = exporter.buildCanvasHtml({
    docHtml: '<body></body>',
    state: { schemaVersion: 1, docId: 'x', docTitle: 'a<b>&c', comments: [] },
    templateHtml: TEMPLATE,
    inlinedRuntime: ''
  });
  assert.match(html, /<title>a&lt;b&gt;&amp;c — Noteback feedback canvas<\/title>/);
});

test('buildCanvasHtml carries the original document markup into the doc root', () => {
  const html = exporter.buildCanvasHtml({
    docHtml: '<!DOCTYPE html><html><head><title>t</title></head><body><h1>Architecture</h1><p>The queue.</p></body></html>',
    state: mkState([]),
    templateHtml: TEMPLATE,
    inlinedRuntime: ''
  });
  assert.ok(html.includes('<h1>Architecture</h1>'), 'doc heading preserved');
  assert.ok(html.includes('<p>The queue.</p>'), 'doc paragraph preserved');
  // The original <head>/<title> must NOT be nested inside the canvas body.
  const bodyStart = html.indexOf('<body>');
  assert.strictEqual(html.indexOf('<title>t</title>'), -1, 'original head title stripped');
  void bodyStart;
});

test('buildCanvasHtml strips injected UI, highlight marks, stale state + runtime', () => {
  const docHtml =
    '<!DOCTYPE html><html><head><title>spec</title>' +
    '<style data-noteback-ui="fab">.noteback-fab{}</style></head>' +
    '<body>' +
    '<p>The system uses <mark class="noteback-highlight" data-noteback-id="c_1">a queue</mark> here.</p>' +
    '<div data-noteback-ui="panel"><div class="nb-sidebar">SIDEBAR_JUNK</div></div>' +
    '<button class="noteback-fab" data-noteback-ui="fab">💬 Comment</button>' +
    '<script type="application/json" id="noteback-state">{"stale":true}</script>' +
    '<script>window.NotebackRuntime={};/* old inlined runtime */</script>' +
    '</body></html>';

  const html = exporter.buildCanvasHtml({
    docHtml: docHtml,
    state: mkState([mkComment('c_1', 'a queue', 'use a stream')]),
    templateHtml: TEMPLATE,
    inlinedRuntime: '/* fresh runtime */'
  });

  // Inner doc-root markup only (between the doc-root div and the state comment).
  const docRoot = /<div id="noteback-doc-root">([\s\S]*?)<\/div>\s*<!-- Machine-readable/.exec(html);
  assert.ok(docRoot, 'doc root region found');
  const inner = docRoot[1];

  assert.ok(inner.includes('a queue'), 'highlighted text preserved');
  assert.ok(!/<mark/i.test(inner), 'highlight <mark> wrapper unwrapped');
  assert.ok(!inner.includes('SIDEBAR_JUNK'), 'injected sidebar removed');
  assert.ok(!/noteback-fab/.test(inner), 'floating button removed');
  assert.ok(!html.includes('"stale":true'), 'stale state block removed');
  assert.ok(!html.includes('old inlined runtime'), 'prior inlined runtime removed');
});

test('buildCanvasHtml state block round-trips as valid State JSON', () => {
  const state = mkState([
    mkComment('c_1', 'a queue which decouples', 'use a stream'),
    mkComment('c_2', 'Each user has one workspace', 'should be many')
  ]);
  const html = exporter.buildCanvasHtml({
    docHtml: '<body><p>a queue which decouples; Each user has one workspace</p></body>',
    state: state,
    templateHtml: TEMPLATE,
    inlinedRuntime: ''
  });
  const block = extractStateBlock(html);
  assert.ok(block, 'state block found');
  const parsed = JSON.parse(block);
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.comments.length, 2);
  assert.strictEqual(parsed.comments[0].body, 'use a stream');
  assert.strictEqual(parsed.comments[1].anchor.quote, 'Each user has one workspace');
});

test('buildCanvasHtml neutralizes "</script>" in the JSON state body', () => {
  const state = mkState([mkComment('c_1', 'q', 'see </script> tag and <!-- comment')]);
  const html = exporter.buildCanvasHtml({
    docHtml: '<body><p>q</p></body>',
    state: state,
    templateHtml: TEMPLATE,
    inlinedRuntime: ''
  });
  const block = extractStateBlock(html);
  // The state block must still parse and preserve the original body text.
  const parsed = JSON.parse(block);
  assert.strictEqual(parsed.comments[0].body, 'see </script> tag and <!-- comment');
});

test('inlined runtime + embedded boot has no premature </script> and is valid JS', () => {
  const html = exporter.buildCanvasHtml({
    docHtml: '<body><p>The system uses a queue.</p></body>',
    state: mkState([mkComment('c_1', 'a queue', 'note')]),
    templateHtml: TEMPLATE,
    inlinedRuntime: concatRuntime()
  });
  const inline = extractRuntimeScript(html);

  assert.ok(inline.length > 1000, 'runtime was inlined');
  assert.ok(!/<\/script>/i.test(inline), 'no literal </script> in the inline runtime');
  // Regression (browser-only HTML tokenizer bug): a literal "<!--" inside the
  // inlined runtime starts the "script data escaped" state, after which a later
  // "<script" double-escapes it and the real </script> is ignored to EOF. The
  // runtime legitimately contains "<!--" (the guiding-comment constant), so the
  // escaper MUST neutralize it. Node's vm.Script can't catch this (no HTML
  // tokenizer), so assert at the byte level.
  assert.ok(!/<!--/.test(inline), 'no literal <!-- in the inline runtime');
  // Must be syntactically valid JS so the extension-less canvas actually boots.
  assert.doesNotThrow(function () {
    new vm.Script(inline);
  }, 'inlined runtime + boot parses');
  // The embedded boot must wire the InFileStateAdapter (CONTRACTS §7).
  assert.ok(inline.includes('createInFileStateAdapter'), 'embedded boot uses InFileStateAdapter');
  assert.ok(inline.includes('noteback-doc-root'), 'embedded boot targets the doc root');
});

test('escapeForInlineScript neutralizes </script and <!-- without changing JS semantics', () => {
  const body =
    'var a = "x</script>y"; var hadComment = "<!-- c -->"; ' +
    'var re = /<script\\b/; var ws = "\\s";';
  const out = exporter.escapeForInlineScript(body);
  assert.ok(!/<\/script/i.test(out), 'no raw </script remains');
  assert.ok(!/<!--/.test(out), 'no raw <!-- remains');
  // A lone "<script" is intentionally left intact (escaping it would corrupt
  // "\\s" inside the regex literal).
  assert.ok(out.includes('/<script\\b/'), 'lone <script in a regex literal untouched');
  // The backslash insertions must be JS no-ops: escaped source evaluates the same.
  // Run in a vm and serialize: objects from a vm context have a foreign
  // [[Prototype]], so compare by value (JSON), not deepStrictEqual.
  const run = (code) =>
    vm.runInNewContext(
      '(function(){' + code + ' return JSON.stringify({a:a, hadComment:hadComment, reSource:re.source, ws:ws});})()'
    );
  assert.strictEqual(run(out), run(body), 'escaped source evaluates identically');
});

test('escapeForJsonScript neutralizes </script and <!-- and stays valid JSON', () => {
  const original = 'see </script> and <!-- comment --> here';
  const escaped = exporter.escapeForJsonScript(JSON.stringify(original));
  assert.ok(!/<\/script/i.test(escaped), 'no raw </script in JSON');
  assert.ok(!/<!--/.test(escaped), 'no raw <!-- in JSON');
  assert.strictEqual(JSON.parse(escaped), original, 'JSON round-trips to the original string');
});

test('EMBEDDED_BOOT is itself valid JavaScript', () => {
  assert.doesNotThrow(function () {
    new vm.Script(exporter.EMBEDDED_BOOT);
  });
});

test('embedded boot wires the clean-HTML export (Save… → HTML · clean copy)', () => {
  const boot = exporter.EMBEDDED_BOOT;
  assert.ok(boot.includes('onSaveClean'), 'embedded boot exposes the onSaveClean hook');
  assert.ok(boot.includes('rebuildCleanHtml'), 'a clean-HTML builder is defined');
  // The clean copy is the plain document: it must remove the state block + the
  // inlined runtime <script> and unwrap the doc-root (parallels rebuildHtml, which
  // keeps them for the re-shareable canvas).
  assert.ok(boot.includes('noteback-state'), 'clean rebuild targets the state block');
  assert.ok(/NotebackRuntime/.test(boot), 'clean rebuild detects the inlined runtime script');
  assert.ok(boot.includes('noteback-doc-root'), 'clean rebuild unwraps the doc root');
  // A distinct filename so a clean copy can't clobber the canvas next to it.
  assert.ok(boot.includes('cleanSuggestedName') && boot.includes('(clean)'),
    'clean copy gets a "(clean)" filename suffix');
  assert.doesNotThrow(function () { new vm.Script(boot); }, 'embedded boot still parses');
});

test('extractBodyMarkup handles a full document, a bare fragment, and unwraps doc-root', () => {
  assert.strictEqual(
    exporter.extractBodyMarkup('<html><head><title>t</title></head><body><p>hi</p></body></html>'),
    '<p>hi</p>'
  );
  assert.strictEqual(exporter.extractBodyMarkup('<p>bare</p>'), '<p>bare</p>');
  assert.strictEqual(
    exporter.extractBodyMarkup('<div id="noteback-doc-root"><p>wrapped</p></div>'),
    '<p>wrapped</p>'
  );
});

test('sanitizeFilename keeps ordinary names and forces an .html suffix', () => {
  assert.strictEqual(exporter.sanitizeFilename('my-spec.html'), 'my-spec.html');
  assert.strictEqual(exporter.sanitizeFilename('design'), 'design.html');
  assert.strictEqual(exporter.sanitizeFilename(''), 'noteback.html');
  assert.strictEqual(exporter.sanitizeFilename('a/b\\c.htm'), 'a_b_c.htm');
  assert.match(exporter.sanitizeFilename('My Doc'), /^My_Doc\.html$/);
});
