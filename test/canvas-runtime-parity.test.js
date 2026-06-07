/**
 * Parity guard: the canvas "inline runtime file list" exists in THREE places that
 * must stay byte-identical (same files, same order). They can't share a literal
 * because each lives in a different runtime context:
 *   1. bin/noteback.js           → exported RUNTIME_FILES (the source of truth)
 *   2. examples/build-canvas.js  → its RUNTIME_FILES array
 *   3. src/background/service-worker.js → const CANVAS_RUNTIME_FILES
 * If any one drifts, canvases assembled by that path boot a different (often
 * incomplete) runtime — e.g. dropping the history modules silently disables
 * version history. This test fails loudly on any divergence.
 *
 * The service worker and build-canvas scripts can't be require()d here (the SW
 * calls importScripts/chrome.* at load; build-canvas runs an export on require),
 * so we read their source text and parse the array literal out of it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Source of truth — safe to require (pure module export).
const { RUNTIME_FILES } = require('../bin/noteback.js');

/**
 * Pull the quoted string entries out of a `const <name> = [ ... ];` array literal
 * in a source file. Handles only well-formed, single-occurrence literals (which
 * is all these three are) — not arbitrary JS.
 */
function parseArrayLiteral(filePath, constName) {
  const src = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
  const re = new RegExp('const\\s+' + constName + '\\s*=\\s*\\[([\\s\\S]*?)\\]', 'm');
  const m = src.match(re);
  assert.ok(m, `could not find "const ${constName} = [...]" in ${filePath}`);
  const body = m[1];
  const items = [];
  const itemRe = /['"]([^'"]+)['"]/g;
  let im;
  while ((im = itemRe.exec(body)) !== null) {
    items.push(im[1]);
  }
  assert.ok(items.length > 0, `parsed an empty array for ${constName} in ${filePath}`);
  return items;
}

test('canvas runtime file lists stay in parity across the three definitions', () => {
  const swList = parseArrayLiteral('src/background/service-worker.js', 'CANVAS_RUNTIME_FILES');
  const buildList = parseArrayLiteral('examples/build-canvas.js', 'RUNTIME_FILES');

  assert.deepStrictEqual(
    swList,
    RUNTIME_FILES,
    'src/background/service-worker.js CANVAS_RUNTIME_FILES drifted from bin/noteback.js RUNTIME_FILES (source of truth)'
  );
  assert.deepStrictEqual(
    buildList,
    RUNTIME_FILES,
    'examples/build-canvas.js RUNTIME_FILES drifted from bin/noteback.js RUNTIME_FILES (source of truth)'
  );
});
