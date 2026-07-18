import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { getTrackedChanges } from '../extensions/TrackChanges';
import { INLINE_FORMAT_POLICIES } from '../extensions/trackChangesPolicy';
import { reconcileCommentsWithDocument } from './commentReconciler';
import { normalizePersistedSuggestions, suggestionsFromTrackedChanges } from './reviewPersistence';
import { sanitizeSuggestions } from './annotationValidation';
import type { Comment, JSONContent, LogicalSuggestion, Suggestion } from '../types';

/** The inline marks a format suggestion may add/remove (bold/italic/strike/code). */
const TRACKABLE_FORMATS = new Set(Object.keys(INLINE_FORMAT_POLICIES));
/** The operation sets one logical change may present, as a sorted-join key. */
const ALLOWED_OP_SETS = new Set(['insert', 'delete', 'delete|insert', 'format']);

/**
 * Validation for the lossless (PM-JSON) crash-recovery path. `workspace.json` is untrusted
 * input — truncated by the crash it recovers, or written by a different Quill version — so
 * before recovery restores a document byte-for-byte we prove, FAIL-CLOSED, against the LIVE
 * schema:
 *
 *  1. the JSON is a real document this schema round-trips + `check()`s without dropping data,
 *  2. every raw tracked mark carries a well-formed `dataTracked` (so the change collector can
 *     never throw or silently coalesce a malformed one), and
 *  3. the document's marks form an EXACT correspondence with the review records — not merely
 *     matching id sets, but matching geometry, text, kind, author, and format deltas — so we
 *     never install a document and a metadata set that disagree.
 *
 * A lossless restore is only safe when the two were captured as one coherent state; these
 * checks are what let recovery trust the stored positions instead of relocating. The whole
 * consistency phase is wrapped so ANY unexpected collector error fails closed, never throws.
 */

export type SnapshotValidation = { ok: true; doc: ProseMirrorNode } | { ok: false; reason: string };

/** Structural: a parseable, schema-valid `doc` this schema reproduces with no dropped data. */
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
  // `nodeFromJSON` only checks that node/mark TYPES exist — it accepts schema-INVALID content
  // arrangements (e.g. a paragraph nested in a paragraph) that ALSO round-trip through toJSON
  // unchanged. `check()` validates the content expressions and marks and throws on violation;
  // without it a corrupt-but-well-typed doc would pass and then corrupt the editor on dispatch.
  try {
    doc.check();
  } catch (e) {
    return {
      ok: false,
      reason: `docJSON violates the schema: ${e instanceof Error ? e.message : e}`,
    };
  }
  // A silently-dropped unknown attribute (e.g. a newer Quill's mark attr this schema can't
  // read) would make the reparse lossy — catch it by re-serializing and deep-comparing.
  if (!deepEqual(doc.toJSON(), json)) {
    return { ok: false, reason: 'docJSON did not round-trip through the schema (attribute loss)' };
  }
  return { ok: true, doc };
}

type TrackedOp = 'insert' | 'delete' | 'format';
type MarkMeta = {
  authorID: unknown;
  status: unknown;
  createdAt: unknown;
  originCommentId: unknown;
  originChatMessageId: unknown;
  logicalKind: unknown;
  ops: Set<TrackedOp>;
};

function trackedOp(mark: { type: unknown }, schema: Schema): TrackedOp | null {
  if (mark.type === schema.marks['tracked_insert']) return 'insert';
  if (mark.type === schema.marks['tracked_delete']) return 'delete';
  if (mark.type === schema.marks['tracked_format']) return 'format';
  return null;
}

/**
 * A format delta must be `{ adds: string[]; removes: string[] }` of SUPPORTED format-mark
 * names, disjoint, and non-empty — the exact shape a real format suggestion carries. An empty
 * or absent delta, an unknown mark name, or an add that is also a remove is corruption.
 */
function formatDeltaError(id: string, delta: unknown): string | null {
  if (typeof delta !== 'object' || delta === null)
    return `tracked mark ${id} has a malformed delta`;
  const d = delta as Record<string, unknown>;
  const seen: Record<'adds' | 'removes', string[]> = { adds: [], removes: [] };
  for (const key of ['adds', 'removes'] as const) {
    const v = d[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
      return `tracked mark ${id} delta.${key} is not a string array`;
    for (const name of v)
      if (!TRACKABLE_FORMATS.has(name))
        return `tracked mark ${id} delta.${key} names an unsupported format "${name}"`;
    seen[key] = v;
  }
  if (seen.adds.length + seen.removes.length === 0)
    return `tracked mark ${id} has an empty format delta`;
  const removes = new Set(seen.removes);
  if (seen.adds.some((a) => removes.has(a)))
    return `tracked mark ${id} format delta adds and removes overlap`;
  return null;
}

/** Field-type checks common to every tracked mark (author/status/timestamps/origins/logicalKind). */
function trackedMarkFieldError(id: string, data: Record<string, unknown>): string | null {
  if (typeof data.authorID !== 'string') return `tracked mark ${id} has a non-string authorID`;
  // A persisted tracked mark is always unresolved — accepted/rejected changes drop their marks.
  if (data.status !== 'pending')
    return `tracked mark ${id} is "${String(data.status)}", not pending`;
  if (typeof data.createdAt !== 'number') return `tracked mark ${id} has a non-numeric createdAt`;
  if (data.updatedAt !== undefined && typeof data.updatedAt !== 'number')
    return `tracked mark ${id} has a non-numeric updatedAt`;
  for (const key of ['originCommentId', 'originChatMessageId'] as const)
    if (data[key] !== undefined && typeof data[key] !== 'string')
      return `tracked mark ${id} has a non-string ${key}`;
  if (data.logicalKind !== undefined && data.logicalKind !== 'replacement')
    return `tracked mark ${id} has an invalid logicalKind "${String(data.logicalKind)}"`;
  return null;
}

/** Shape-check one tracked mark's attrs (dataTracked + changeId must agree with the mark type). */
function trackedMarkDataError(op: TrackedOp, attrs: Record<string, unknown>): string | null {
  const data = attrs.dataTracked as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return 'tracked mark has no dataTracked';
  const id = data.id;
  if (typeof id !== 'string' || !id) return 'tracked mark is missing its id';
  if (attrs.changeId !== id)
    return `tracked mark ${id} changeId "${String(attrs.changeId)}" != dataTracked.id`;
  if (data.operation !== op)
    return `tracked mark ${id} operation "${String(data.operation)}" != ${op}`;
  const fieldError = trackedMarkFieldError(id, data);
  if (fieldError) return fieldError;
  if (op === 'format') {
    if (data.logicalKind !== undefined) return `format mark ${id} must not carry a logicalKind`;
    if (data.delta === undefined) return `format mark ${id} has no delta`;
    return formatDeltaError(id, data.delta);
  }
  if (data.delta !== undefined) return `tracked mark ${id} (${op}) must not carry a format delta`;
  return null;
}

/**
 * Validate the raw `dataTracked` on every tracked mark BEFORE the change collector reads them.
 * getTrackedChanges deliberately skips malformed marks and coalesces fragments by id, so a
 * corrupt mark could otherwise vanish (becoming an invisible orphan) or throw mid-collection
 * (e.g. a `delta.adds` that isn't an array). Fragments sharing an id must agree on identity
 * (operation may differ — a replacement carries both an insert and a delete under one id).
 */
function fragmentMetaError(
  id: string,
  prior: MarkMeta,
  data: Record<string, unknown>,
): string | null {
  if (
    prior.authorID !== data.authorID ||
    prior.status !== data.status ||
    prior.createdAt !== data.createdAt ||
    prior.originCommentId !== data.originCommentId ||
    prior.originChatMessageId !== data.originChatMessageId ||
    prior.logicalKind !== data.logicalKind
  ) {
    return `tracked mark ${id} has inconsistent metadata across fragments`;
  }
  return null;
}

function validateRawTrackedMarks(doc: ProseMirrorNode, schema: Schema): string | null {
  const meta = new Map<string, MarkMeta>();
  let error: string | null = null;
  doc.descendants((node) => {
    if (error) return false;
    if (!node.isInline) return;
    for (const mark of node.marks) {
      const op = trackedOp(mark, schema);
      if (!op) continue;
      error = trackedMarkDataError(op, mark.attrs);
      if (error) return false;
      const data = mark.attrs.dataTracked as Record<string, unknown>;
      const id = data.id as string;
      const prior = meta.get(id);
      if (prior) {
        error = fragmentMetaError(id, prior, data);
        if (error) return false;
        prior.ops.add(op);
      } else {
        meta.set(id, {
          authorID: data.authorID,
          status: data.status,
          createdAt: data.createdAt,
          originCommentId: data.originCommentId,
          originChatMessageId: data.originChatMessageId,
          logicalKind: data.logicalKind,
          ops: new Set([op]),
        });
      }
    }
  });
  if (error) return error;
  // Each logical change must present an allowed operation shape (insertion / deletion /
  // insert+delete replacement / format), and `logicalKind` must agree: exactly the
  // insert+delete replacement carries 'replacement', nothing else does.
  for (const [id, m] of meta) {
    const shape = [...m.ops].sort().join('|');
    if (!ALLOWED_OP_SETS.has(shape))
      return `tracked mark ${id} has an invalid operation set {${shape}}`;
    const isReplacement = shape === 'delete|insert';
    if (isReplacement && m.logicalKind !== 'replacement')
      return `tracked mark ${id} is an insert+delete replacement but its logicalKind is not 'replacement'`;
    if (!isReplacement && m.logicalKind !== undefined)
      return `tracked mark ${id} (${shape}) must not carry logicalKind`;
  }
  return null;
}

/** Canonical form both sides run through, so legitimate serialization can't false-positive. */
function canonicalize(suggestions: Suggestion[]): LogicalSuggestion[] {
  return normalizePersistedSuggestions(sanitizeSuggestions(suggestions));
}

/**
 * Suggestion side — an EXACT correspondence: every attached record deep-equals its live
 * canonical form (author/timestamp/origins/segment geometry+text+kind/format deltas all
 * covered), detached records are mark-less, no orphan marks, no duplicate ids, and no
 * accepted/rejected records (new snapshots emit only pending).
 */
function validateSuggestions(
  doc: ProseMirrorNode,
  schema: Schema,
  suggestions: Suggestion[],
): string | null {
  const ids = new Set<string>();
  for (const s of suggestions) {
    if (s.status !== 'pending') return `suggestion record ${s.id} is ${s.status}, not pending`;
    if (ids.has(s.id)) return `duplicate suggestion record id ${s.id}`;
    ids.add(s.id);
  }
  const live = new Map<string, LogicalSuggestion>();
  for (const s of canonicalize(
    suggestionsFromTrackedChanges(getTrackedChanges({ state: { doc, schema } })),
  ))
    live.set(s.id, s);

  const attached = new Map<string, LogicalSuggestion>();
  for (const s of canonicalize(suggestions.filter((s) => !s.detached))) attached.set(s.id, s);
  for (const s of suggestions)
    if (s.detached && live.has(s.id))
      return `detached suggestion ${s.id} unexpectedly has a live mark`;

  for (const [id, record] of attached) {
    const canon = live.get(id);
    if (!canon) return `attached suggestion ${id} has no live mark`;
    if (!deepEqual(record, canon)) return `attached suggestion ${id} does not match its live mark`;
  }
  for (const id of live.keys())
    if (!attached.has(id)) return `orphan tracked mark ${id} has no attached record`;
  return null;
}

/** The {kind, resolved} of every comment mark carrying `id`. */
function commentMarkAttrs(
  doc: ProseMirrorNode,
  id: string,
): Array<{ kind: unknown; resolved: unknown }> {
  const attrs: Array<{ kind: unknown; resolved: unknown }> = [];
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment' && mark.attrs.commentId === id)
        attrs.push({ kind: mark.attrs.kind, resolved: mark.attrs.resolved });
    }
  });
  return attrs;
}

/** The set of comment ids that appear as live marks in the document. */
function markedCommentIds(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type.name === 'comment') {
        const id = mark.attrs.commentId as string | undefined;
        if (id) ids.add(id);
      }
  });
  return ids;
}

/**
 * Comment side — an EXACT correspondence: reconciling the records against the document is a
 * NO-OP (any drift in range/anchorText, or a missing mark, changes the output), every active
 * record's mark carries its `kind` and is unresolved, resolved/detached records are mark-less,
 * and no mark lacks a record.
 */
/**
 * The active comment's mark must cover [from, to] CONTIGUOUSLY and stay within it. Coverage is
 * measured over mark-admissible inline content (text nodes) only — block boundaries can't carry
 * a comment mark, so they are not gaps. This rejects disjoint same-id spans whose outer envelope
 * happens to match the record range, which the reconcile/envelope check alone would miss.
 */
function commentCoverageError(doc: ProseMirrorNode, c: Comment): string | null {
  let error: string | null = null;
  doc.descendants((node, pos) => {
    if (error) return false;
    // Text AND hard breaks are annotation-mark-admissible (Quill marks breaks); everything
    // else (block boundaries, atoms) can't carry a comment mark, so it isn't a gap.
    if (!node.isText && node.type.name !== 'hardBreak') return;
    const from = pos;
    const to = pos + node.nodeSize;
    const marked = node.marks.some(
      (mark) => mark.type.name === 'comment' && mark.attrs.commentId === c.id,
    );
    if (marked && (from < c.from || to > c.to)) {
      error = `comment ${c.id} is marked outside its record range`;
    } else if (!marked && from < c.to && to > c.from) {
      error = `comment ${c.id} range has an uncovered gap (disjoint marks)`;
    }
  });
  return error;
}

/** Mark attributes must agree with the record: active ↔ its kind + unresolved + contiguous, else mark-less. */
function commentMarkError(doc: ProseMirrorNode, c: Comment): string | null {
  const attrs = commentMarkAttrs(doc, c.id);
  if (c.resolved || c.detached) {
    return attrs.length > 0 ? `resolved/detached comment ${c.id} unexpectedly has a mark` : null;
  }
  if (attrs.length === 0) return `active comment ${c.id} has no mark`;
  if (attrs.some((a) => a.kind !== c.kind))
    return `comment ${c.id} mark kind does not match record`;
  // Strictly unresolved: a persisted `resolved` of `true` OR a stray string like "false" fails.
  if (attrs.some((a) => a.resolved !== false))
    return `active comment ${c.id} has a non-false resolved mark`;
  return commentCoverageError(doc, c);
}

function validateComments(doc: ProseMirrorNode, comments: Comment[]): string | null {
  const ids = new Set<string>();
  for (const c of comments) {
    if (ids.has(c.id)) return `duplicate comment record id ${c.id}`;
    ids.add(c.id);
  }
  if (!deepEqual(reconcileCommentsWithDocument(comments, doc), comments))
    return 'comment records are not coherent with the document (range / anchor / presence)';
  for (const c of comments) {
    const error = commentMarkError(doc, c);
    if (error) return error;
  }
  for (const id of markedCommentIds(doc))
    if (!ids.has(id)) return `comment mark ${id} has no record`;
  return null;
}

/**
 * Parse and consistency-check a lossless snapshot. Returns the parsed doc on success so the
 * caller can dispatch the SAME validated node it checked (never a re-parse). Never mutates.
 * The consistency phase is wrapped so any unexpected collector error fails closed.
 */
function consistencyError(
  doc: ProseMirrorNode,
  schema: Schema,
  comments: Comment[],
  suggestions: Suggestion[],
): string | null {
  return (
    validateRawTrackedMarks(doc, schema) ||
    validateSuggestions(doc, schema, suggestions) ||
    validateComments(doc, comments)
  );
}

export function validateSnapshot(
  schema: Schema,
  json: JSONContent,
  comments: Comment[],
  suggestions: Suggestion[],
): SnapshotValidation {
  const parsed = parseSnapshotDoc(schema, json);
  if (!parsed.ok) return parsed;
  try {
    const error = consistencyError(parsed.doc, schema, comments, suggestions);
    if (error) return { ok: false, reason: error };
  } catch (e) {
    return {
      ok: false,
      reason: `snapshot consistency check threw: ${e instanceof Error ? e.message : e}`,
    };
  }
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
