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
  'src/runtime/diff.js',
  'src/runtime/highlight.js',
  'src/runtime/diff-render.js',
  'src/runtime/overlay.js',
  'src/runtime/draft-history-core.js',
  'src/runtime/snapshot-capture.js',
  'src/adapters/infile-state-adapter.js',
  'src/adapters/history-state-adapter.js',
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
 * Mint a fresh, unique document id.
 * @returns {string}
 */
function mintDocId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
}

/**
 * Read a baked-in doc-id from a canvas HTML string, or return null.
 * @param {string} html
 * @returns {string|null}
 */
function readBakedDocId(html) {
  const m = /id\s*=\s*["']noteback-doc-root["'][^>]*\bdata-noteback-doc-id\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
  return m ? m[1] : null;
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
    docId: o.docId != null && String(o.docId) !== '' ? String(o.docId) : mintDocId(),
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
 * Precedence for doc-id: explicitId → baked id in the existing -o file → baked id in the input itself → mint.
 * @returns {{out: string, bytes: number, title: string}}
 */
function wrapFile(inputPath, outputPath, explicitId) {
  const out = outputPath || inputPath;
  const docHtml = fs.readFileSync(inputPath, 'utf8');
  var docId = explicitId || null;
  if (!docId && fs.existsSync(out)) docId = readBakedDocId(fs.readFileSync(out, 'utf8'));
  if (!docId) docId = readBakedDocId(docHtml);
  const html = wrapHtml(docHtml, { sourceName: path.basename(inputPath), docId: docId || undefined });
  fs.writeFileSync(out, html);
  return { out: out, bytes: html.length, title: deriveTitle(docHtml, path.basename(inputPath)) };
}

/* --------------------------------------------------------------------------- *
 * install-skill — drop the bundled agent skill into a Claude skills directory *
 * --------------------------------------------------------------------------- */

/**
 * Plan where `install-skill` writes, mirroring `npx skills add`:
 *   - default / --project: the skill's **real files** go in the vendor-neutral
 *     `<base>/.agents/skills/` hub — which **Codex** and **OpenCode** read
 *     natively — and a **symlink** is placed in `<base>/.claude/skills/` so
 *     **Claude Code** (which only reads there) picks it up too. One install
 *     covers all three. `<base>` is the home dir, or the CWD with --project.
 *   - --dir <path>: a plain real copy into `<path>/<name>/` — an explicit
 *     override (no hub, no symlink) for vendoring or tests.
 *
 * `args.home` / `args.cwd` override the base dirs (for tests); they default to
 * os.homedir() / process.cwd().
 * @returns {{plain:true, dir:string}
 *          |{plain:false, hub:string, links:{dir:string,label:string}[]}}
 */
function planInstall(args) {
  const a = args || {};
  if (a.dir) return { plain: true, dir: path.resolve(a.dir) };
  const base = a.project ? (a.cwd || process.cwd()) : (a.home || os.homedir());
  return {
    plain: false,
    hub: path.join(base, '.agents', 'skills'),
    // Only agents that DON'T read the .agents hub need a symlink. Codex and
    // OpenCode read it natively; Claude Code reads ~/.claude/skills only.
    links: [{ dir: path.join(base, '.claude', 'skills'), label: 'Claude Code' }]
  };
}

/**
 * Install the bundled skill (see planInstall for the layout). Idempotent:
 * existing targets are replaced, so re-running updates in place.
 * @returns {number} process exit code.
 */
function installSkill(args) {
  if (!fs.existsSync(SKILL_SRC)) {
    process.stderr.write('noteback install-skill: bundled skill not found at ' + SKILL_SRC + '\n');
    return 1;
  }
  const plan = planInstall(args || {});
  try {
    if (plan.plain) {
      const dest = path.join(plan.dir, SKILL_NAME);
      fs.mkdirSync(plan.dir, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(SKILL_SRC, dest, { recursive: true });
      process.stdout.write(
        'Installed the Noteback skill → ' + dest + '\n' +
        'Restart your agent so it discovers the skill.\n'
      );
      return 0;
    }

    // 1) real files into the neutral hub (Codex + OpenCode read here natively)
    const hubDest = path.join(plan.hub, SKILL_NAME);
    fs.mkdirSync(plan.hub, { recursive: true });
    fs.rmSync(hubDest, { recursive: true, force: true });
    fs.cpSync(SKILL_SRC, hubDest, { recursive: true });

    // 2) symlink the hub into each agent dir that doesn't read .agents itself
    const lines = ['  ' + hubDest + '  (Codex + OpenCode)'];
    for (const link of plan.links) {
      const linkPath = path.join(link.dir, SKILL_NAME);
      fs.mkdirSync(link.dir, { recursive: true });
      fs.rmSync(linkPath, { recursive: true, force: true }); // replace stale dir/symlink
      const rel = path.relative(link.dir, hubDest);          // ../../.agents/skills/noteback
      try {
        fs.symlinkSync(rel, linkPath);
        lines.push('  ' + linkPath + ' → ' + rel + '  (' + link.label + ')');
      } catch (e) {
        // Symlinks may be unavailable (e.g. Windows without privilege): copy.
        fs.cpSync(hubDest, linkPath, { recursive: true });
        lines.push('  ' + linkPath + '  (' + link.label + ', copied — symlink unavailable)');
      }
    }
    process.stdout.write(
      'Installed the Noteback skill:\n' + lines.join('\n') + '\n' +
      'Restart your agent so it discovers the skill.\n'
    );
    return 0;
  } catch (e) {
    process.stderr.write('noteback install-skill: ' + (e && e.message ? e.message : String(e)) + '\n');
    return 1;
  }
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
  '  install-skill  install the Noteback agent skill (Codex / OpenCode / Claude Code)',
  '',
  'install-skill puts the skill in the ~/.agents/skills hub (read by Codex and',
  'OpenCode) and symlinks it into ~/.claude/skills (for Claude Code) — one install,',
  'all three. Re-running updates in place.',
  '',
  'Options:',
  '  -o, --out <path>   (wrap) write the canvas to <path> instead of rewriting in place',
  '  --id <id>          (wrap) set/override the document id baked into the canvas (normally inferred',
  '                     from the -o target; use this to chain version history across re-wraps)',
  '  --project          (install-skill) install into ./ (this repo) instead of your home dir',
  '  --dir <path>       (install-skill) plain-copy into a specific skills directory (no symlink)',
  '  -h, --help         show this help',
  '',
  'The wrapped output opens directly in a browser (no extension): highlight text',
  'to comment, add a whole-document note, then "Copy feedback as markdown".'
].join('\n');

function parseArgs(argv) {
  const args = { cmd: null, input: null, out: null, dir: null, project: false, help: false, id: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--id') args.id = argv[++i];
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
    const r = wrapFile(args.input, args.out, args.id);
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

module.exports = { wrapHtml, wrapFile, deriveTitle, mintDocId, readBakedDocId, main, installSkill, planInstall, RUNTIME_FILES, SKILL_NAME };
