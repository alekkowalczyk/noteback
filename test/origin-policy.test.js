/**
 * Noteback tests — origin-policy.test.js
 * Runs under the Node built-in runner ONLY:  node --test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../src/content/origin-policy.js');

test('module exposes its API and a stable settings key', () => {
  assert.strictEqual(policy.SETTINGS_KEY, 'nb:settings');
  assert.deepStrictEqual(policy.TYPES, ['file', 'localhost', '127.0.0.1']);
  assert.strictEqual(typeof policy.classifyOrigin, 'function');
  assert.strictEqual(typeof policy.originOf, 'function');
  assert.strictEqual(typeof policy.normalizeSettings, 'function');
  assert.strictEqual(typeof policy.isActive, 'function');
});

test('classifyOrigin maps protocol/hostname to type', () => {
  assert.strictEqual(policy.classifyOrigin({ protocol: 'file:', hostname: '' }), 'file');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'http:', hostname: 'localhost' }), 'localhost');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), '127.0.0.1');
  assert.strictEqual(policy.classifyOrigin({ protocol: 'https:', hostname: 'example.com' }), 'other');
});

test('originOf returns "file://" for file pages and origin otherwise', () => {
  assert.strictEqual(policy.originOf({ protocol: 'file:', hostname: '' }), 'file://');
  assert.strictEqual(
    policy.originOf({ protocol: 'http:', host: 'localhost:3000', origin: 'http://localhost:3000' }),
    'http://localhost:3000'
  );
});

test('isActive defaults to true when settings are absent', () => {
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, null), true);
  assert.strictEqual(policy.isActive({ type: 'file', origin: 'file://' }, undefined), true);
});

test('per-type switch off suppresses the whole type', () => {
  const s = { origins: { localhost: false } };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
  assert.strictEqual(policy.isActive({ type: 'file', origin: 'file://' }, s), true);
});

test('per-site entry subtracts one origin while its type stays on', () => {
  const s = { disabledSites: ['http://localhost:3000'] };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:3000' }, s), false);
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:8000' }, s), true);
});

test('type-off wins regardless of disabledSites', () => {
  const s = { origins: { localhost: false }, disabledSites: [] };
  assert.strictEqual(policy.isActive({ type: 'localhost', origin: 'http://localhost:8000' }, s), false);
});

test('unknown/other origin type is never active', () => {
  assert.strictEqual(policy.isActive({ type: 'other', origin: 'https://example.com' }, null), false);
});

test('normalizeSettings fills defaults and is shape-stable', () => {
  const n = policy.normalizeSettings(null);
  assert.deepStrictEqual(n.origins, { file: true, localhost: true, '127.0.0.1': true });
  assert.deepStrictEqual(n.disabledSites, []);
});

test('historyAllowed: on by default for file/localhost/127, off for other', () => {
  assert.strictEqual(policy.historyAllowed({ type: 'file', origin: 'file://' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: 'localhost', origin: 'http://localhost:3000' }, null), true);
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, null), false);
});

test('historyAllowed: an other-origin opts in via historySites', () => {
  const s = { historySites: ['https://example.com'] };
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://example.com' }, s), true);
  assert.strictEqual(policy.historyAllowed({ type: 'other', origin: 'https://evil.com' }, s), false);
});
