#!/usr/bin/env node
/**
 * noteback — CLI for the Noteback feedback canvas.
 *
 *   noteback wrap <file.html> [-o <out.html>]
 *
 * `wrap` turns an ordinary HTML document into a self-contained Noteback
 * *feedback canvas*: the same document, plus the inlined runtime and an empty
 * comment state, so it can be opened directly in a browser (NO extension) to
 * highlight text, leave notes, and copy the feedback back as Markdown.
 *
 * It reuses the REAL, unit-tested builder (`src/canvas/exporter.js`
 * `buildCanvasHtml`) and the actual runtime sources — the same files the
 * extension's service worker inlines — so the tricky `</script>` / `<!--`
 * escaping is handled by tested code, never by hand.
 *
 * By default it rewrites the file IN PLACE (the file you wrote becomes the
 * canvas). Pass `-o`/`--out` to write a separate file instead. Re-wrapping an
 * existing canvas is safe: the builder strips the prior runtime + state block
 * before re-embedding a fresh, empty one.
 *
 * Pure logic (`wrapHtml`) is exported for tests; file IO lives in `main`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'src/canvas/canvas-template.html');

// The bundled agent skill (shipped in the npm package) and its install name.
const SKILL_NAME = 'noteback';
const SKILL_SRC = path.join(ROOT, 'skills', SKILL_NAME);

// Runtime files in dependency order — identical to examples/build-canvas.js and
// the manifest's web_accessible_resources (extension-only modules excluded).
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

/** Concatenate the runtime sources (cached per process). */
let _runtimeCache = null;
function readInlinedRuntime() {
  if (_runtimeCache == null) {
    _runtimeCache = RUNTIME_FILES.map(function (f) {
      return fs.readFileSync(path.join(ROOT, f), 'utf8');
    }).join('\n;\n');
  }
  return _runtimeCache;
}

/**
 * Derive a human document title: the input's <title>, else the file name.
 * Strips a trailing " — Noteback feedback canvas" so re-wrapping is idempotent.
 * @param {string} html
 * @param {string} sourceName  file name used as the fallback title.
 * @returns {string}
 */
function deriveTitle(html, sourceName) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (m) {
    const t = m[1].replace(/\s+/g, ' ').trim().replace(/\s*—\s*Noteback feedback canvas$/, '').trim();
    if (t) return t;
  }
  return sourceName || 'document';
}

/**
 * Build the canvas HTML for a document string. PURE w.r.t. its arguments
 * (reads the template + runtime sources from disk, writes nothing).
 *
 * @param {string} docHtml             the document markup (full page or fragment).
 * @param {{sourceName?: string, docId?: string}} [opts]
 * @returns {string} complete canvas HTML.
 */
function wrapHtml(docHtml, opts) {
  const o = opts || {};
  const exporter = require(path.join(ROOT, 'src/canvas/exporter.js'));
  const templateHtml = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const sourceName = o.sourceName || 'document';
  const state = {
    schemaVersion: 1,
    docId: o.docId != null ? String(o.docId) : sourceName,
    docTitle: deriveTitle(String(docHtml == null ? '' : docHtml), sourceName),
    comments: []
  };
  return exporter.buildCanvasHtml({
    docHtml: docHtml,
    state: state,
    templateHtml: templateHtml,
    inlinedRuntime: readInlinedRuntime()
  });
}

/**
 * Read `inputPath`, wrap it, and write to `outputPath` (defaults to in place).
 * @returns {{out: string, bytes: number, title: string}}
 */
function wrapFile(inputPath, outputPath) {
  const out = outputPath || inputPath;
  const docHtml = fs.readFileSync(inputPath, 'utf8');
  const html = wrapHtml(docHtml, { sourceName: path.basename(inputPath) });
  fs.writeFileSync(out, html);
  return { out: out, bytes: html.length, title: deriveTitle(docHtml, path.basename(inputPath)) };
}

/* --------------------------------------------------------------------------- *
 * install-skill — drop the bundled agent skill into a Claude skills directory *
 * --------------------------------------------------------------------------- */

/**
 * Resolve the skills directory to install into:
 *   --dir <path> → that directory; --project → <cwd>/.claude/skills;
 *   otherwise the personal scope ~/.claude/skills.
 */
function resolveSkillsDir(args) {
  if (args.dir) return path.resolve(args.dir);
  if (args.project) return path.join(process.cwd(), '.claude', 'skills');
  return path.join(os.homedir(), '.claude', 'skills');
}

/**
 * Copy the bundled skill into the resolved skills directory as
 * `<skillsDir>/noteback/`. Idempotent (overwrites to update in place).
 * @returns {number} process exit code.
 */
function installSkill(args) {
  if (!fs.existsSync(SKILL_SRC)) {
    process.stderr.write('noteback install-skill: bundled skill not found at ' + SKILL_SRC + '\n');
    return 1;
  }
  const skillsDir = resolveSkillsDir(args || {});
  const dest = path.join(skillsDir, SKILL_NAME);
  try {
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.cpSync(SKILL_SRC, dest, { recursive: true });
  } catch (e) {
    process.stderr.write('noteback install-skill: ' + (e && e.message ? e.message : String(e)) + '\n');
    return 1;
  }
  process.stdout.write(
    'Installed the Noteback skill → ' + dest + '\n' +
    'Restart Claude Code (or your agent) so it discovers the skill.\n' +
    'It wraps HTML docs you hand off for review with `npx noteback wrap`.\n'
  );
  return 0;
}

/* --------------------------------------------------------------------------- *
 * CLI                                                                         *
 * --------------------------------------------------------------------------- */

const USAGE = [
  'noteback — turn an HTML document into a self-contained feedback canvas.',
  '',
  'Usage:',
  '  noteback wrap <file.html> [-o <out.html>]',
  '  noteback install-skill [--project] [--dir <path>]',
  '',
  'Commands:',
  '  wrap           wrap an HTML doc as a feedback canvas (in place, or -o <path>)',
  '  install-skill  install the Noteback agent skill into your Claude skills dir',
  '',
  'Options:',
  '  -o, --out <path>   (wrap) write the canvas to <path> instead of rewriting in place',
  '  --project          (install-skill) use ./.claude/skills instead of ~/.claude/skills',
  '  --dir <path>       (install-skill) install into a specific skills directory',
  '  -h, --help         show this help',
  '',
  'The wrapped output opens directly in a browser (no extension): highlight text',
  'to comment, add a whole-document note, then "Copy feedback as markdown".'
].join('\n');

function parseArgs(argv) {
  const args = { cmd: null, input: null, out: null, dir: null, project: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--project') args.project = true;
    else if (a[0] === '-') { /* unknown flag — ignore */ }
    else if (!args.cmd) args.cmd = a;       // first bare token is the command
    else if (!args.input) args.input = a;   // second bare token is the input file
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.help || !args.cmd) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (args.cmd === 'install-skill') {
    return installSkill(args);
  }
  if (args.cmd !== 'wrap') {
    process.stderr.write('noteback: unknown command "' + args.cmd + '"\n\n' + USAGE + '\n');
    return 2;
  }
  if (!args.input) {
    process.stderr.write('noteback wrap: missing <file.html>\n\n' + USAGE + '\n');
    return 2;
  }
  if (!fs.existsSync(args.input)) {
    process.stderr.write('noteback wrap: file not found: ' + args.input + '\n');
    return 1;
  }

  try {
    const r = wrapFile(args.input, args.out);
    process.stdout.write(
      'Wrapped "' + r.title + '" → ' + r.out + ' (' + r.bytes + ' bytes).\n' +
      'Open it in a browser to comment, then "Copy feedback as markdown".\n'
    );
    return 0;
  } catch (e) {
    process.stderr.write('noteback wrap: ' + (e && e.message ? e.message : String(e)) + '\n');
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { wrapHtml, wrapFile, deriveTitle, main, installSkill, resolveSkillsDir, RUNTIME_FILES, SKILL_NAME };
