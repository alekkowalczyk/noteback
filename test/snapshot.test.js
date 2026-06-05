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

test('pickSectionNodes captures the whole section up to the next same-level heading', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'Sec'), el('P', 'a'), el('UL', 'b'), el('P', 'c'), el('H2', 'Next'), el('P', 'd')]);
  const picked = snap.pickSectionNodes(list[2]); // commented block is somewhere mid-section
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['Sec', 'a', 'b', 'c'], 'stops before the next H2, excludes its content');
});

test('pickSectionNodes stops at a higher-level heading', () => {
  const parent = el('DIV');
  const list = siblings(parent, [el('H2', 'Sec'), el('P', 'a'), el('H1', 'Top'), el('P', 'b')]);
  const picked = snap.pickSectionNodes(list[1]);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['Sec', 'a'], 'an H1 ends an H2 section');
});

test('pickSectionNodes keeps deeper sub-headings inside the section', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'Sec'), el('P', 'a'), el('H3', 'Sub'), el('P', 'b'), el('H2', 'Next')]);
  const picked = snap.pickSectionNodes(list[1]);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['Sec', 'a', 'Sub', 'b'], 'an H3 stays in; the next H2 ends it');
});

test('pickSectionNodes treats a highlighted heading as the section start', () => {
  const parent = el('SECTION');
  const list = siblings(parent, [el('H2', 'Sec'), el('P', 'a'), el('H2', 'Next'), el('P', 'b')]);
  const picked = snap.pickSectionNodes(list[2]); // the H2 "Next" itself is highlighted
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['Next', 'b']);
});

test('pickSectionNodes falls back to a sibling window when there is no heading', () => {
  const parent = el('DIV');
  const list = siblings(parent, [el('P', 'p1'), el('P', 'p2'), el('P', 'block'), el('P', 'p4'), el('P', 'p5')]);
  const picked = snap.pickSectionNodes(list[2]);
  assert.deepStrictEqual(picked.map((n) => n.textContent), ['p1', 'p2', 'block', 'p4', 'p5'], 'up to 3 blocks each side');
});

test('headingLevel reads H1-H6 and aria-level, else 99', () => {
  assert.strictEqual(snap.headingLevel(el('H1')), 1);
  assert.strictEqual(snap.headingLevel(el('h3')), 3);
  assert.strictEqual(snap.headingLevel(el('P')), 99);
  const aria = { tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'heading' : (n === 'aria-level' ? '4' : null)) };
  assert.strictEqual(snap.headingLevel(aria), 4);
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

/**
 * Minimal DOM faithful to exactly the API extractSections + its helpers touch:
 * root.querySelector (the painted-<mark> lookup), sibling/parent links, cloneNode,
 * and a wrapper div whose innerHTML concatenates appended clones. `painted`
 * toggles whether the comment's highlight mark is present in the document.
 */
function fakeEl(tag, text) {
  const node = {
    tagName: tag, nodeType: 1, parentElement: null,
    previousElementSibling: null, nextElementSibling: null,
    _html: '<' + tag.toLowerCase() + '>' + (text || '') + '</' + tag.toLowerCase() + '>',
    getAttribute: function () { return null; },
    querySelectorAll: function () { return []; },
    cloneNode: function () { return { querySelectorAll: function () { return []; }, _html: node._html }; }
  };
  return node;
}
function sceneDom(painted) {
  const mkWrap = function () {
    const kids = [];
    return { appendChild: function (c) { kids.push(c); }, get innerHTML() { return kids.map(function (k) { return k._html || ''; }).join(''); } };
  };
  const doc = {
    createElement: function (t) { return t === 'div' ? mkWrap() : fakeEl(t); },
    querySelectorAll: function () { return []; } // no inline <style>
  };
  const root = { tagName: 'DIV', nodeType: 1, parentElement: null };
  const nodes = [fakeEl('H2', 'Section'), fakeEl('P', 'prev'), fakeEl('P', 'commented block'), fakeEl('P', 'next')];
  nodes.forEach(function (n, i) { n.parentElement = root; n.previousElementSibling = nodes[i - 1] || null; n.nextElementSibling = nodes[i + 1] || null; });
  const block = nodes[2];
  const mark = { tagName: 'MARK', nodeType: 1, parentElement: block, getAttribute: function () { return null; }, querySelectorAll: function () { return []; }, cloneNode: function () { return { querySelectorAll: function () { return []; }, _html: '' }; } };
  root.querySelector = function (sel) { return (painted && /data-noteback-id="c1"/.test(sel)) ? mark : null; };
  return { doc: doc, root: root };
}

test('extractSections captures a section + sectionByCommentId when the highlight IS painted', () => {
  const { doc, root } = sceneDom(true);
  const comments = [{ id: 'c1', body: 'note', anchor: { quote: 'commented' } }];
  const ex = snap.extractSections({ root: root, doc: doc, comments: comments });
  assert.strictEqual(ex.sections.length, 1, 'one section captured');
  assert.strictEqual(ex.sectionByCommentId.c1, ex.sections[0].id, 'comment maps to its section (=> clickable history)');
  assert.ok(ex.sections[0].html.length > 0, 'section html is non-empty');
});

test('extractSections captures NOTHING when the highlight is not painted (the root-cause condition)', () => {
  // This is exactly what happened pre-fix: persist()/extractSections ran before
  // the new comment's <mark> was painted, so the snapshot silently captured no
  // section — leaving the history entry permanently un-clickable.
  const { doc, root } = sceneDom(false);
  const comments = [{ id: 'c1', body: 'note', anchor: { quote: 'commented' } }];
  const ex = snap.extractSections({ root: root, doc: doc, comments: comments });
  assert.strictEqual(ex.sections.length, 0, 'no painted mark => no section');
  assert.deepStrictEqual(ex.sectionByCommentId, {}, 'no painted mark => no comment mapping');
});

test('extractSections skips whole-document notes (anchor == null)', () => {
  const { doc, root } = sceneDom(true);
  const ex = snap.extractSections({ root: root, doc: doc, comments: [{ id: 'c1', body: 'doc note', anchor: null }] });
  assert.strictEqual(ex.sections.length, 0);
  assert.deepStrictEqual(ex.sectionByCommentId, {});
});

test('extractSections trims an oversized section but still captures the commented block', () => {
  const { doc, root } = sceneDom(true);
  // A tiny cap forces the trim path; the section is still produced (windowed).
  const ex = snap.extractSections({ root: root, doc: doc, comments: [{ id: 'c1', body: 'note', anchor: { quote: 'commented' } }], maxSectionChars: 5 });
  assert.strictEqual(ex.sections.length, 1);
  assert.strictEqual(ex.sectionByCommentId.c1, ex.sections[0].id);
  assert.ok(ex.sections[0].html.length > 0);
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
