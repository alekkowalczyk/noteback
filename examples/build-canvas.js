#!/usr/bin/env node
/**
 * examples/build-canvas.js — generate a self-contained Noteback feedback canvas
 * from examples/spec.html, reusing the REAL exporter.buildCanvasHtml and the
 * actual runtime sources (the same files the extension's service worker inlines).
 *
 * This mirrors what background/service-worker.js does at runtime, but offline so
 * the canvas can be opened directly (no extension) to demo embedded mode.
 *
 *   node examples/build-canvas.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const { buildCanvasHtml } = require(path.join(root, 'src/canvas/exporter.js'));

// Runtime files, in the dependency order declared in manifest web_accessible_resources
// (content-script and chrome-storage-adapter are extension-only → excluded).
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

const docHtml = fs.readFileSync(path.join(__dirname, 'spec.html'), 'utf8');
const templateHtml = fs.readFileSync(path.join(root, 'src/canvas/canvas-template.html'), 'utf8');
const inlinedRuntime = RUNTIME_FILES
  .map(function (f) { return fs.readFileSync(path.join(root, f), 'utf8'); })
  .join('\n;\n');

// Empty state — the recipient (us, in the demo) will add comments live in the browser.
const state = {
  schemaVersion: 1,
  docId: '',
  docTitle: 'RealtimeSync Service — Technical Spec',
  comments: []
};

const html = buildCanvasHtml({ docHtml: docHtml, state: state, templateHtml: templateHtml, inlinedRuntime: inlinedRuntime });
const out = path.join(__dirname, 'spec.canvas.html');
fs.writeFileSync(out, html);
console.log('wrote', out, '(' + html.length + ' bytes)');
