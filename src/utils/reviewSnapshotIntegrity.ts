import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { getTrackedChanges } from '../extensions/TrackChanges';
import type { Comment, JSONContent, Suggestion } from '../types';

/**
 * Validation for the lossless (PM-JSON) crash-recovery path. `workspace.json` is untrusted
 * input — it may have been truncated by the very crash it exists to recover, or written by
 * a different Quill version — so before a recovery restores a document byte-for-byte we
 * prove two things, FAIL-CLOSED, against the LIVE schema:
 *
 *  1. the JSON is a real document this schema round-trips without silently dropping data, and
 *  2. the document's marks form a BIJECTION with the review records — so we never install a
 *     document and a metadata set that disagree about which annotations exist and where.
 *
 * A lossless restore is only safe when the two were captured as one coherent state; these
 * checks are what let recovery trust the stored positions instead of relocating.
 */

export type SnapshotValidation = { ok: true; doc: ProseMirrorNode } | { ok: false; reason: string };

/** Structural: a parseable `doc` node this schema reproduces with no dropped attributes. */
function parseSnapshotDoc(schema: Schema, json: JSONContent): SnapshotValidation {
  if (!json || typeof json !== 'object' || json.type !== 'doc') {
    return { ok: false, reason: 'docJSON is not a doc node' };
  }
  let doc: ProseMirrorNode;
  try {
    doc = schema.nodeFromJSON(json);
  } catch (e) {
    return {
      ok: false,
      reason: `docJSON failed schema parse: ${e instanceof Error ? e.message : e}`,
    };
  }
  if (doc.type !== schema.topNodeType) {
    return {
      ok: false,
      reason: `docJSON top node is ${doc.type.name}, not ${schema.topNodeType.name}`,
    };
  }
  // A silently-dropped unknown attribute (e.g. a newer Quill's mark attr this schema can't
  // read) would make the reparse lossy — catch it by re-serializing and deep-comparing.
  if (!deepEqual(doc.toJSON(), json)) {
    return { ok: false, reason: 'docJSON did not round-trip through the schema (attribute loss)' };
  }
  return { ok: true, doc };
}

/** The set of comment ids that appear as live marks in the document. */
function markedCommentIds(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') {
        const id = mark.attrs.commentId as string | undefined;
        if (id) ids.add(id);
      }
    }
  });
  return ids;
}

/** Suggestion side of the bijection: attached records ↔ live tracked marks, detached ↔ none. */
function validateSuggestions(
  doc: ProseMirrorNode,
  schema: Schema,
  suggestions: Suggestion[],
): string | null {
  const liveIds = new Set<string>();
  for (const change of getTrackedChanges({ state: { doc, schema } })) {
    if (liveIds.has(change.id)) return `duplicate live tracked-change id ${change.id}`;
    liveIds.add(change.id);
  }

  const pending = suggestions.filter((s) => s.status === 'pending');
  const recordIds = new Set<string>();
  const attached = new Set<string>();
  const detached = new Set<string>();
  for (const s of pending) {
    if (recordIds.has(s.id)) return `duplicate suggestion record id ${s.id}`;
    recordIds.add(s.id);
    (s.detached ? detached : attached).add(s.id);
  }

  for (const id of attached)
    if (!liveIds.has(id)) return `attached suggestion ${id} has no live mark`;
  for (const id of detached)
    if (liveIds.has(id)) return `detached suggestion ${id} unexpectedly has a live mark`;
  for (const id of liveIds)
    if (!attached.has(id)) return `orphan tracked mark ${id} has no attached record`;
  return null;
}

/** Comment side of the bijection: active records ↔ marks, resolved/detached ↔ mark-less. */
function validateComments(doc: ProseMirrorNode, comments: Comment[]): string | null {
  const recordIds = new Set<string>();
  for (const c of comments) {
    if (recordIds.has(c.id)) return `duplicate comment record id ${c.id}`;
    recordIds.add(c.id);
  }
  const marked = markedCommentIds(doc);
  for (const c of comments) {
    const hasMark = marked.has(c.id);
    const shouldHaveMark = !c.resolved && !c.detached;
    if (shouldHaveMark && !hasMark) return `active comment ${c.id} has no mark`;
    if (!shouldHaveMark && hasMark)
      return `resolved/detached comment ${c.id} unexpectedly has a mark`;
  }
  for (const id of marked) if (!recordIds.has(id)) return `comment mark ${id} has no record`;
  return null;
}

/**
 * Parse and consistency-check a lossless snapshot. Returns the parsed doc on success so the
 * caller can dispatch the SAME validated node it checked (never a re-parse). Never mutates.
 */
export function validateSnapshot(
  schema: Schema,
  json: JSONContent,
  comments: Comment[],
  suggestions: Suggestion[],
): SnapshotValidation {
  const parsed = parseSnapshotDoc(schema, json);
  if (!parsed.ok) return parsed;
  const suggestionError = validateSuggestions(parsed.doc, schema, suggestions);
  if (suggestionError) return { ok: false, reason: suggestionError };
  const commentError = validateComments(parsed.doc, comments);
  if (commentError) return { ok: false, reason: commentError };
  return parsed;
}

/** Structural deep equality for plain JSON values (order-independent for object keys). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}
