/**
 * Noteback runtime — diff-render.js  (DOM-aware; browser-only)
 *
 * Renders an inline, formatting-preserving unified diff of two document bodies,
 * using the pure planner in `NotebackRuntime.diff`. Strategy: start from a FULL
 * deep clone of the TARGET body (so all structure / non-block content / wrappers
 * survive), then annotate changed blocks in place and inject deleted (base-only)
 * blocks positionally. Edited blocks are re-rendered with word-level ins/del runs
 * (inline formatting inside an edited block is flattened — a v1 simplification).
 *
 * Browser-only: attaches to `NotebackRuntime.diffRender`. No module.exports — it
 * touches the DOM, so it is exercised by the browser e2e, not the Node suite.
 */
(function (root) {
  'use strict';
  root.NotebackRuntime = root.NotebackRuntime || {};

  var BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dt,dd,figcaption';

  function diffApi() {
    var g = root.NotebackRuntime || {};
    return g.diff;
  }

  // Leaf block-level elements in document order, each with its normalized text.
  // "Leaf" = a matched block that does NOT itself contain another matched block,
  // so we diff paragraphs/list-items, not their containers.
  function extractBlocks(body) {
    var els = [], texts = [];
    if (!body) return { els: els, texts: texts };
    var all = body.querySelectorAll(BLOCK_SELECTOR);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.querySelector(BLOCK_SELECTOR)) continue; // not a leaf block
      els.push(el);
      texts.push((el.textContent || '').replace(/\s+/g, ' ').trim());
    }
    return { els: els, texts: texts };
  }

  // Replace an edited block's children with word-diff runs (eq text / ins / del).
  function applyWordDiff(el, baseText, targetText, doc, diff) {
    while (el.firstChild) el.removeChild(el.firstChild);
    el.classList.add('nb-diff-edit-block');
    var runs = diff.diffWords(baseText, targetText);
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (r.op === 'eq') { el.appendChild(doc.createTextNode(r.text)); continue; }
      var span = doc.createElement(r.op === 'ins' ? 'ins' : 'del');
      span.className = r.op === 'ins' ? 'nb-diff-ins' : 'nb-diff-del';
      span.textContent = r.text;
      el.appendChild(span);
    }
  }

  // Render the inline diff. Returns { body, hasChanges }: a deep clone of the
  // target body carrying .nb-diff-* markup. `doc` is the target's ownerDocument.
  function renderInlineDiff(baseBody, targetBody, doc) {
    var diff = diffApi();
    var outBody = targetBody.cloneNode(true); // full clone — preserves structure
    if (!diff) return { body: outBody, hasChanges: false };

    var base = extractBlocks(baseBody);
    var target = extractBlocks(targetBody);
    var outBlocks = extractBlocks(outBody).els; // aligns 1:1 with target.els
    var steps = diff.planBlocks(base.texts, target.texts);
    var changed = false;

    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s.type === 'eq') {
        continue; // unchanged — leave the cloned block as-is
      }
      if (s.type === 'ins') {
        if (outBlocks[s.targetIndex]) outBlocks[s.targetIndex].classList.add('nb-diff-ins-block');
        changed = true;
        continue;
      }
      if (s.type === 'edit') {
        if (outBlocks[s.targetIndex]) applyWordDiff(outBlocks[s.targetIndex], base.texts[s.baseIndex], target.texts[s.targetIndex], doc, diff);
        changed = true;
        continue;
      }
      // 'del': inject the base-only block before the next surviving target block.
      var anchor = null;
      for (var j = i + 1; j < steps.length; j++) {
        var nj = steps[j];
        if (nj.type !== 'del' && nj.targetIndex != null && outBlocks[nj.targetIndex]) { anchor = outBlocks[nj.targetIndex]; break; }
      }
      var delEl = base.els[s.baseIndex].cloneNode(true);
      delEl.classList.add('nb-diff-del-block');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(delEl, anchor);
      else outBody.appendChild(delEl);
      changed = true;
    }

    return { body: outBody, hasChanges: changed };
  }

  root.NotebackRuntime.diffRender = {
    extractBlocks: extractBlocks,
    renderInlineDiff: renderInlineDiff
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
