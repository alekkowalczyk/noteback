/**
 * Noteback tests — cli-wrap.test.js
 *
 * Runs under the Node built-in runner ONLY:  node --test
 *
 * Covers the `noteback wrap` CLI (bin/noteback.js): turning an ordinary HTML
 * document into a self-contained feedback canvas with an EMPTY comment state,
 * a derived title, the inlined runtime, and re-wrap (idempotency) safety.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/noteback.js');
const state = require('../src/runtime/state.js');

const DOC = [
  '<!DOCTYPE html>',
  '<html><head><title>RealtimeSync Plan</title></head>',
  '<body>',
  '  <h1>RealtimeSync</h1>',
  '  <p>The system uses a single Redis instance to coordinate workers.</p>',
  '</body></html>'
].join('\n');

/** Pull the JSON text out of the embedded <script id="noteback-state"> block. */
function stateBlock(html) {
  const m = /<script\b[^>]*id="noteback-state"[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  return m ? m[1].trim() : null;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('wrapHtml exposes its API surface', () => {
  assert.strictEqual(typeof cli.wrapHtml, 'function');
  assert.strictEqual(typeof cli.wrapFile, 'function');
  assert.strictEqual(typeof cli.deriveTitle, 'function');
});

test('deriveTitle prefers <title>, falls back to the file name', () => {
  assert.strictEqual(cli.deriveTitle('<title>My Spec</title>', 'plan.html'), 'My Spec');
  assert.strictEqual(cli.deriveTitle('<p>no title here</p>', 'plan.html'), 'plan.html');
});

test('deriveTitle strips a prior canvas suffix (idempotent re-wrap)', () => {
  assert.strictEqual(
    cli.deriveTitle('<title>My Spec — Noteback feedback canvas</title>', 'x.html'),
    'My Spec'
  );
});

test('wrapHtml embeds the doc body, the runtime, and an EMPTY valid state', () => {
  const html = cli.wrapHtml(DOC, { sourceName: 'plan.html' });

  // Original content survives.
  assert.match(html, /a single Redis instance/);
  // Runtime is inlined (the canvas boots with no extension).
  assert.match(html, /NotebackRuntime/);
  // Title was derived from <title>.
  assert.match(html, /<title>RealtimeSync Plan — Noteback feedback canvas<\/title>/);

  // The embedded state block is a valid, EMPTY state.
  const raw = stateBlock(html);
  assert.ok(raw, 'state block present');
  const s = state.deserialize(raw);
  assert.ok(s, 'embedded state is structurally valid');
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(s.docTitle, 'RealtimeSync Plan');
  assert.deepStrictEqual(s.comments, []);
});

test('wrapHtml output has no raw </script or <!-- inside the inlined runtime script', () => {
  const html = cli.wrapHtml(DOC, { sourceName: 'plan.html' });
  // Isolate the runtime <script> (the last <script> before </body>): it must not
  // contain bytes that would derail the HTML tokenizer (the canvas-mount bug).
  const m = /<script>([\s\S]*NotebackRuntime[\s\S]*?)<\/script>/i.exec(html);
  assert.ok(m, 'runtime script found');
  const inline = m[1];
  assert.ok(!/<\/script/i.test(inline), 'no unescaped </script in runtime');
  assert.ok(!/<!--/.test(inline), 'no unescaped <!-- in runtime');
});

test('re-wrapping a canvas is idempotent (nothing accumulates, body intact)', () => {
  const once = cli.wrapHtml(DOC, { sourceName: 'plan.html' });
  const twice = cli.wrapHtml(once, { sourceName: 'plan.html' });

  // The builder strips the prior state block + runtime before re-embedding fresh
  // ones, so counts must NOT grow between one wrap and two. (Note: the literal
  // `type="application/json" id="noteback-state"` also appears in a JSDoc comment
  // inside the inlined runtime, so the absolute count is >1 — what matters for
  // idempotency is that it stays constant.)
  assert.strictEqual(
    countOccurrences(twice, 'type="application/json"'),
    countOccurrences(once, 'type="application/json"'),
    'no extra state block accumulated on re-wrap'
  );
  // Doc body preserved and NOT duplicated.
  assert.strictEqual(countOccurrences(twice, 'a single Redis instance'), 1, 'body present, not duplicated');

  const s = state.deserialize(stateBlock(twice));
  assert.ok(s, 'state still valid after re-wrap');
  assert.deepStrictEqual(s.comments, [], 'state still empty after re-wrap');
  assert.strictEqual(s.docTitle, 'RealtimeSync Plan', 'title not double-suffixed');
});

test('wrapFile rewrites a file in place and returns metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noteback-cli-'));
  const file = path.join(dir, 'plan.html');
  fs.writeFileSync(file, DOC);

  const r = cli.wrapFile(file);
  assert.strictEqual(r.out, file, 'wrote in place by default');
  assert.strictEqual(r.title, 'RealtimeSync Plan');
  assert.ok(r.bytes > DOC.length, 'canvas is larger than the source');

  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /NotebackRuntime/);
  assert.ok(state.deserialize(stateBlock(written)), 'written file has a valid state block');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrapFile honors an explicit output path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noteback-cli-'));
  const input = path.join(dir, 'plan.html');
  const output = path.join(dir, 'plan.canvas.html');
  fs.writeFileSync(input, DOC);

  const r = cli.wrapFile(input, output);
  assert.strictEqual(r.out, output);
  assert.strictEqual(fs.readFileSync(input, 'utf8'), DOC, 'source left untouched');
  assert.match(fs.readFileSync(output, 'utf8'), /NotebackRuntime/);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* --- install-skill -------------------------------------------------------- */

test('install-skill copies the bundled skill into a target skills dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noteback-skill-'));
  const code = cli.installSkill({ dir });
  assert.strictEqual(code, 0, 'install succeeds');

  const skillMd = path.join(dir, cli.SKILL_NAME, 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), 'SKILL.md installed under <dir>/noteback/');
  assert.match(fs.readFileSync(skillMd, 'utf8'), /name:\s*noteback\b/, 'it is the real skill');

  // Idempotent: a second install over the same dir still succeeds.
  assert.strictEqual(cli.installSkill({ dir }), 0, 're-install is safe');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('planInstall picks the .agents hub + .claude symlink (or a plain --dir copy)', () => {
  // --dir is an explicit plain-copy override (no hub/symlink).
  assert.deepStrictEqual(cli.planInstall({ dir: '/tmp/x' }), {
    plain: true, dir: path.resolve('/tmp/x')
  });
  // Personal scope: real files in ~/.agents/skills, symlink in ~/.claude/skills.
  assert.deepStrictEqual(cli.planInstall({ home: '/h' }), {
    plain: false,
    hub: path.join('/h', '.agents', 'skills'),
    links: [{ dir: path.join('/h', '.claude', 'skills'), label: 'Claude Code' }]
  });
  // Project scope mirrors it under the CWD.
  assert.deepStrictEqual(cli.planInstall({ project: true, cwd: '/p' }), {
    plain: false,
    hub: path.join('/p', '.agents', 'skills'),
    links: [{ dir: path.join('/p', '.claude', 'skills'), label: 'Claude Code' }]
  });
});

test('wrapHtml inlines the draft-history runtime modules', () => {
  const html = cli.wrapHtml(DOC, { sourceName: 'plan.html' });
  assert.match(html, /NotebackRuntime\.draftHistory/);
  assert.match(html, /NotebackRuntime\.snapshot/);
  assert.match(html, /NotebackRuntime\.localStorageStateAdapter/);
});

test('canvas guards localStorage access so a throwing/blocked store cannot break boot', () => {
  const html = cli.wrapHtml(DOC, { sourceName: 'plan.html' });
  // The boot script must capture localStorage inside a try/catch (not access window.localStorage raw in the adapter guard).
  assert.match(html, /nbLocalStorage/);
  assert.match(html, /try\s*\{\s*return\s*\(typeof window/);
});

test('wrapHtml mints a doc-id when none is given', () => {
  const html = cli.wrapHtml('<html><body><p>some adequately long document body text here</p></body></html>', { sourceName: 'a.html' });
  const m = /data-noteback-doc-id="([^"]+)"/.exec(html);
  assert.ok(m && m[1] && m[1] !== 'a.html', 'a real minted id, not the basename');
});

test('wrapHtml honors an explicit docId', () => {
  const html = cli.wrapHtml('<html><body><p>body text that is long enough</p></body></html>', { sourceName: 'a.html', docId: 'FIXED1' });
  assert.ok(html.includes('data-noteback-doc-id="FIXED1"'));
});

test('re-wrap reuses the doc-id already in the -o target', () => {
  const tmp = path.join(os.tmpdir(), 'nb-id-' + process.pid + '.canvas.html');
  fs.writeFileSync(tmp, cli.wrapHtml('<html><body><p>first body long enough to hash</p></body></html>', { sourceName: 'a.html', docId: 'KEEPME' }));
  const r = cli.wrapFile(path.join(__dirname, 'fixtures', 'plain.html'), tmp);
  const out = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  assert.ok(out.includes('data-noteback-doc-id="KEEPME"'), 'id preserved across re-wrap');
});

test('install-skill writes the .agents hub + a .claude symlink (covers Codex/OpenCode/Claude)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noteback-home-'));

  assert.strictEqual(cli.installSkill({ home }), 0, 'install succeeds');

  // Real files in the vendor-neutral hub (Codex + OpenCode read here).
  const hubMd = path.join(home, '.agents', 'skills', cli.SKILL_NAME, 'SKILL.md');
  assert.ok(fs.existsSync(hubMd), 'real SKILL.md under ~/.agents/skills/noteback/');
  assert.match(fs.readFileSync(hubMd, 'utf8'), /name:\s*noteback\b/, 'it is the real skill');

  // A relative symlink into Claude's dir (Claude Code does not read .agents).
  const link = path.join(home, '.claude', 'skills', cli.SKILL_NAME);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), '~/.claude/skills/noteback is a symlink');
  assert.strictEqual(
    fs.readlinkSync(link),
    path.join('..', '..', '.agents', 'skills', cli.SKILL_NAME),
    'symlink target is relative to the hub'
  );
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), 'symlink resolves to the skill');

  // Idempotent, and a stale REAL dir at the Claude path is replaced by the symlink.
  fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(link, { recursive: true });
  fs.writeFileSync(path.join(link, 'SKILL.md'), 'stale');
  assert.strictEqual(cli.installSkill({ home }), 0, 're-install is safe');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'stale real dir replaced by a symlink');

  fs.rmSync(home, { recursive: true, force: true });
});
