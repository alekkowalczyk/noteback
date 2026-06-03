/**
 * Noteback runtime — state.js  (PURE LOGIC; dual-export)
 *
 * Responsibility: create / validate the annotation State, add / edit / delete
 * comments (immutably), and (de)serialize to/from JSON. This is the canonical
 * implementation of the schema in CONTRACTS.md §2 (schemaVersion 1).
 *
 * Runs BOTH in the browser (`NotebackRuntime.state`) and under Node tests
 * (`require('../src/runtime/state.js')`).
 *
 * Public API (see CONTRACTS.md §3.2):
 *   createState(docId, docTitle) -> State                 // empty comments
 *   validateState(state) -> { valid:boolean, errors:string[] }
 *   addComment(state, { anchor, body }, opts?) -> State    // pure; stamps id/createdAt/author:null
 *   editComment(state, id, { body, anchor }) -> State      // pure
 *   deleteComment(state, id) -> State                      // pure
 *   serialize(state) -> string (JSON)
 *   deserialize(json) -> State                             // null on invalid
 *
 * Determinism: timestamps and ids are PARAMETERS, not read from the system
 * clock inside the pure path. `addComment` accepts an optional third argument
 * `{ id?, createdAt? }`; callers in the browser pass `new Date().toISOString()`
 * and a generated id, while tests inject fixed values.
 */

(function (root, factory) {
  const api = factory();
  root.NotebackRuntime = root.NotebackRuntime || {};
  root.NotebackRuntime.state = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  /** Generate a reasonably-unique id suffix (non-cryptographic; ids are local). */
  function generateId() {
    const rand = Math.random().toString(36).slice(2, 10);
    const time = Date.now().toString(36);
    return 'c_' + time + rand;
  }

  /**
   * @param {string} docId
   * @param {string} docTitle
   * @returns {Object} fresh State with an empty comments array.
   */
  function createState(docId, docTitle) {
    return {
      schemaVersion: SCHEMA_VERSION,
      docId: String(docId == null ? '' : docId),
      docTitle: String(docTitle == null ? '' : docTitle),
      comments: []
    };
  }

  /**
   * Append a comment. Stamps `id`, `createdAt` (ISO-8601), and `author:null`.
   * Pure: returns a NEW State; the input is never mutated.
   *
   * @param {Object} state
   * @param {{anchor:Object, body:string}} fields
   * @param {{id?:string, createdAt?:string}} [opts]  inject for determinism.
   * @returns {Object} new State.
   */
  function addComment(state, fields, opts) {
    const { anchor, body } = fields || {};
    const o = opts || {};
    const comment = {
      id: o.id != null ? String(o.id) : generateId(),
      anchor: cloneAnchor(anchor),
      body: body == null ? '' : String(body),
      createdAt: o.createdAt != null ? String(o.createdAt) : new Date().toISOString(),
      author: null
    };
    return {
      ...state,
      comments: [...(state.comments || []), comment]
    };
  }

  /**
   * Update the body and/or anchor of a comment, immutably.
   * Unspecified fields are preserved. A missing id is a no-op (returns an
   * equivalent new State).
   * @returns {Object} new State.
   */
  function editComment(state, id, fields) {
    const patch = fields || {};
    return {
      ...state,
      comments: (state.comments || []).map((c) => {
        if (c.id !== id) return c;
        const next = { ...c };
        if (Object.prototype.hasOwnProperty.call(patch, 'body')) {
          next.body = patch.body == null ? '' : String(patch.body);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'anchor')) {
          next.anchor = cloneAnchor(patch.anchor);
        }
        return next;
      })
    };
  }

  /**
   * Remove the comment with the given id, immutably.
   * @returns {Object} new State.
   */
  function deleteComment(state, id) {
    return {
      ...state,
      comments: (state.comments || []).filter((c) => c.id !== id)
    };
  }

  /**
   * Defensive copy of an anchor so stored comments don't alias caller data.
   * A null/undefined anchor denotes a DOCUMENT-LEVEL comment (attached to the
   * whole document rather than a quoted passage) and is preserved as null —
   * which is distinct from an "orphan" (a real anchor whose quote no longer
   * matches the current text).
   */
  function cloneAnchor(anchor) {
    if (anchor == null) return null;
    return {
      quote: anchor.quote == null ? '' : String(anchor.quote),
      prefix: anchor.prefix == null ? '' : String(anchor.prefix),
      suffix: anchor.suffix == null ? '' : String(anchor.suffix),
      occurrence: typeof anchor.occurrence === 'number' ? anchor.occurrence : 0
    };
  }

  /**
   * Validate a State object against the schemaVersion-1 contract.
   * @returns {{valid:boolean, errors:string[]}}
   */
  function validateState(state) {
    const errors = [];

    if (state == null || typeof state !== 'object' || Array.isArray(state)) {
      return { valid: false, errors: ['state must be a non-null object'] };
    }

    if (state.schemaVersion !== SCHEMA_VERSION) {
      errors.push('schemaVersion must be ' + SCHEMA_VERSION);
    }
    if (typeof state.docId !== 'string') {
      errors.push('docId must be a string');
    }
    if (typeof state.docTitle !== 'string') {
      errors.push('docTitle must be a string');
    }
    if (!Array.isArray(state.comments)) {
      errors.push('comments must be an array');
    } else {
      state.comments.forEach((c, i) => {
        validateComment(c, i, errors);
      });
    }

    return { valid: errors.length === 0, errors };
  }

  function validateComment(c, i, errors) {
    const at = 'comments[' + i + ']';
    if (c == null || typeof c !== 'object') {
      errors.push(at + ' must be an object');
      return;
    }
    if (typeof c.id !== 'string' || c.id === '') {
      errors.push(at + '.id must be a non-empty string');
    }
    if (typeof c.body !== 'string') {
      errors.push(at + '.body must be a string');
    }
    if (typeof c.createdAt !== 'string' || c.createdAt === '') {
      errors.push(at + '.createdAt must be an ISO-8601 string');
    }
    if (!('author' in c) || c.author !== null) {
      errors.push(at + '.author must be null in v1');
    }
    // anchor may be null for a DOCUMENT-LEVEL comment (a whole-doc note);
    // otherwise it must be a valid text-quote anchor.
    if (!('anchor' in c)) {
      errors.push(at + '.anchor must be present (an anchor object or null)');
    } else if (c.anchor === null) {
      /* document-level comment — no anchor; valid. */
    } else if (typeof c.anchor !== 'object') {
      errors.push(at + '.anchor must be an object or null');
    } else {
      const a = c.anchor;
      if (typeof a.quote !== 'string' || a.quote === '') {
        errors.push(at + '.anchor.quote must be a non-empty string');
      }
      if (typeof a.prefix !== 'string') {
        errors.push(at + '.anchor.prefix must be a string');
      }
      if (typeof a.suffix !== 'string') {
        errors.push(at + '.anchor.suffix must be a string');
      }
      if (typeof a.occurrence !== 'number' || a.occurrence < 0 || !Number.isInteger(a.occurrence)) {
        errors.push(at + '.anchor.occurrence must be a non-negative integer');
      }
    }
  }

  /**
   * @param {Object} state
   * @returns {string} JSON string of the State.
   */
  function serialize(state) {
    return JSON.stringify(state);
  }

  /**
   * Parse a JSON state block. Returns the State, or null when the input is not
   * valid JSON or not a structurally valid State (per validateState).
   * @param {string} json
   * @returns {Object|null}
   */
  function deserialize(json) {
    if (typeof json !== 'string' || json.trim() === '') return null;
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return null;
    }
    if (!validateState(parsed).valid) return null;
    return parsed;
  }

  return {
    SCHEMA_VERSION,
    createState,
    validateState,
    addComment,
    editComment,
    deleteComment,
    serialize,
    deserialize
  };
});
