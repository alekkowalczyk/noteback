'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const snap = require('../src/runtime/snapshot.js');

/** Build a fake element graph: array of siblings under a parent. */
function el(tag, text) { return { tagName: tag, textContent: text || '', previousElementSibling: null, nextElementSibling: null, parentElement: null }; }
function siblings(parent, list) {
  for (let i = 0; i < list.length; i++) {
    list[i].parentElement = parent;
    list[i].previousElementSibling = list[i - 1] || null;
    list[i].nextElementSibling = list[i + 1] || null;
  }
  return list;
}

test('findNearestHeading walks back through previous siblings', () => {
  const parent = el('SECTION');
  const [h, p1, p2] = siblings(parent, [el('H2', 'Arch'), el('P', 'first'), el('P', 'second')]);
  assert.strictEqual(snap.findNearestHeading(p2), h);
  assert.strictEqual(snap.findNearestHeading(p1), h);
});

test('findNearestHeading climbs to an ancestor section heading', () => {
  const root = el('DIV');
  const [h, sect] = siblings(root, [el('H1', 'Top'), el('SECTION')]);
  const [p] = siblings(sect, [el('P', 'body')]);
  assert.strictEqual(snap.findNearestHeading(p), h);
});

test('findNearestHeading returns null when none exists', () => {
  const parent = el('DIV');
  const [p] = siblings(parent, [el('P', 'lonely')]);
  assert.strictEqual(snap.findNearestHeading(p), null);
});

test('pickSectionNodes returns [heading, prev, block, next] without nulls', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'H'), el('P', 'prev'), el('P', 'block'), el('P', 'next')]);
  const block = list[2];
  const picked = snap.pickSectionNodes(block);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['H', 'prev', 'block', 'next']);
});

test('pickSectionNodes dedupes when heading is also the previous sibling', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'H'), el('P', 'block'), el('P', 'next')]);
  const block = list[1];
  const picked = snap.pickSectionNodes(block);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['H', 'block', 'next']);
});

test('identityCodec round-trips', async () => {
  const c = snap.identityCodec;
  assert.strictEqual(await c.decompress(await c.compress('hi <b>x</b>')), 'hi <b>x</b>');
});

test('isHeading recognizes H1-H6, role=heading, and rejects others', () => {
  assert.strictEqual(snap.isHeading(el('H1')), true);
  assert.strictEqual(snap.isHeading(el('h3')), true); // case-insensitive
  assert.strictEqual(snap.isHeading(el('P')), false);
  assert.strictEqual(snap.isHeading(null), false);
  assert.strictEqual(snap.isHeading({}), false); // no tagName
  const aria = { tagName: 'DIV', getAttribute: function (n) { return n === 'role' ? 'heading' : null; } };
  assert.strictEqual(snap.isHeading(aria), true);
  const plainDiv = { tagName: 'DIV', getAttribute: function () { return null; } };
  assert.strictEqual(snap.isHeading(plainDiv), false);
});

test('pickSectionNodes handles a block with no heading and no prev sibling', () => {
  const parent = el('DIV');
  const list = siblings(parent, [el('P', 'block'), el('P', 'next')]);
  const block = list[0];
  const picked = snap.pickSectionNodes(block);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['block', 'next']);
});

test('enclosingBlock finds the nearest block ancestor, else falls back to the node', () => {
  const root = { tagName: 'DIV', nodeType: 1, parentElement: null };
  const p = { tagName: 'P', nodeType: 1, parentElement: root };
  const span = { tagName: 'SPAN', nodeType: 1, parentElement: p };
  const textInSpan = { nodeType: 3, parentElement: span };
  assert.strictEqual(snap.enclosingBlock(textInSpan, root), p, 'text node -> enclosing P');
  assert.strictEqual(snap.enclosingBlock(span, root), p, 'inline span -> enclosing P');
  assert.strictEqual(snap.enclosingBlock(p, root), p, 'block element returns itself');
  const loneSpan = { tagName: 'SPAN', nodeType: 1, parentElement: root };
  assert.strictEqual(snap.enclosingBlock(loneSpan, root), loneSpan, 'no block ancestor -> the node itself');
});
