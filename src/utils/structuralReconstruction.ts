import { Fragment, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model';
import { Transform, type Mapping } from '@tiptap/pm/transform';
import type { StructuralSuggestionRecord } from '../types';
import type { MarkdownSerialize } from './structuralFingerprint';
import { structuralFingerprint } from './structuralFingerprint';
import { BLOCK_TRACK_TYPES } from '../extensions/BlockTrack';

const FORBIDDEN_MARKS = new Set(['tracked_insert', 'tracked_delete', 'tracked_format', 'comment']);
const TRACKABLE = new Set<string>(BLOCK_TRACK_TYPES);

export interface ReconstructionResult {
  /** The rebuilt review document (source + proposed branches, both flagged). */
  doc: PMNode;
  /** Maps pristine-source positions onto the reconstructed review document. */
  mapping: Mapping;
  /** Records reconstructed into the review document. */
  restored: StructuralSuggestionRecord[];
  /** Records that failed validation; preserved verbatim, never applied. */
  quarantined: StructuralSuggestionRecord[];
}

interface ResolvedRange {
  from: number;
  to: number;
  blockPositions: number[];
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deserialized JSON is untyped; validate the record's shape before dereferencing. */
function recordShapeValid(r: unknown): r is StructuralSuggestionRecord {
  if (!isPlainObject(r)) return false;
  if (typeof r.changeId !== 'string' || typeof r.sourceFingerprint !== 'string') return false;
  if (!Array.isArray(r.proposed) || r.proposed.length === 0) return false;
  const a = r.anchor;
  if (!isPlainObject(a)) return false;
  if (!Array.isArray(a.parentPath) || !a.parentPath.every(isFiniteInt)) return false;
  return isFiniteInt(a.childIndex) && isFiniteInt(a.childCount);
}

/** Resolve a top-level source-branch anchor. V1 supports only top-level unions. */
function resolveTopLevelRange(
  doc: PMNode,
  childIndex: number,
  childCount: number,
): ResolvedRange | null {
  if (childIndex < 0 || childCount < 1 || childIndex + childCount > doc.childCount) return null;
  let pos = 0;
  for (let i = 0; i < childIndex; i += 1) pos += doc.child(i).nodeSize;
  const from = pos;
  const blockPositions: number[] = [];
  for (let i = childIndex; i < childIndex + childCount; i += 1) {
    blockPositions.push(pos);
    pos += doc.child(i).nodeSize;
  }
  return { from, to: pos, blockPositions };
}

function sourceBranchFragment(doc: PMNode, range: ResolvedRange): Fragment {
  return Fragment.fromArray(range.blockPositions.map((p) => doc.nodeAt(p) as PMNode));
}

/**
 * Inspect the RAW proposed JSON before `nodeFromJSON` (which silently drops
 * unknown attributes and cannot distinguish an injected `blockTrack: null` from a
 * schema default). Rejects unknown node types, any `blockTrack` key, unknown
 * attributes, and forbidden (tracking/comment) marks, recursively.
 */
function attrsAreClean(json: Record<string, unknown>, nodeType: NodeType): boolean {
  if (json.attrs === undefined) return true;
  if (!isPlainObject(json.attrs) || 'blockTrack' in json.attrs) return false;
  const allowed = new Set(Object.keys(nodeType.spec.attrs ?? {}));
  return Object.keys(json.attrs).every((k) => allowed.has(k));
}

function markIsClean(schema: Schema, mark: unknown): boolean {
  if (!isPlainObject(mark) || typeof mark.type !== 'string') return false;
  if (FORBIDDEN_MARKS.has(mark.type) || !schema.marks[mark.type]) return false;
  if (mark.attrs === undefined) return true;
  if (!isPlainObject(mark.attrs)) return false;
  const allowed = new Set(Object.keys(schema.marks[mark.type].spec.attrs ?? {}));
  return Object.keys(mark.attrs).every((k) => allowed.has(k));
}

function marksAreClean(schema: Schema, json: Record<string, unknown>): boolean {
  if (json.marks === undefined) return true;
  if (!Array.isArray(json.marks)) return false;
  return json.marks.every((mark) => markIsClean(schema, mark));
}

function rawNodeIsClean(schema: Schema, json: unknown): boolean {
  if (!isPlainObject(json) || typeof json.type !== 'string') return false;
  const nodeType = schema.nodes[json.type];
  if (!nodeType || !attrsAreClean(json, nodeType) || !marksAreClean(schema, json)) return false;
  if (json.content === undefined) return true;
  if (!Array.isArray(json.content)) return false;
  // Recurse with the same strict check — text/leaf nodes are handled by the type
  // + marks checks above, so there is no weaker "leaf" fallback to slip through.
  return json.content.every((c) => rawNodeIsClean(schema, c));
}

interface ValidRecord {
  record: StructuralSuggestionRecord;
  range: ResolvedRange;
  proposed: PMNode[];
}

/** Every source-branch root must be a type that can carry the delete flag. */
function sourceBranchTrackable(sourceDoc: PMNode, range: ResolvedRange): boolean {
  return range.blockPositions.every((p) =>
    TRACKABLE.has((sourceDoc.nodeAt(p) as PMNode).type.name),
  );
}

/** Parse and validate the proposed blocks; null if any is unsafe or untrackable. */
function parseProposedNodes(schema: Schema, proposedJson: unknown[]): PMNode[] | null {
  const proposed: PMNode[] = [];
  for (const json of proposedJson) {
    if (!rawNodeIsClean(schema, json)) return null;
    let node: PMNode;
    try {
      node = schema.nodeFromJSON(json);
      node.check(); // throws on a schema-invalid subtree
    } catch {
      return null;
    }
    if (!node.isBlock || !TRACKABLE.has(node.type.name)) return null;
    proposed.push(node);
  }
  return proposed;
}

/** Validate one record against the pristine source; null if anything is off. */
function validateRecord(
  sourceDoc: PMNode,
  record: unknown,
  serialize: MarkdownSerialize,
): ValidRecord | null {
  if (!recordShapeValid(record) || record.anchor.parentPath.length !== 0) return null;

  const range = resolveTopLevelRange(sourceDoc, record.anchor.childIndex, record.anchor.childCount);
  if (!range || !sourceBranchTrackable(sourceDoc, range)) return null;
  if (
    structuralFingerprint(sourceBranchFragment(sourceDoc, range), serialize) !==
    record.sourceFingerprint
  )
    return null;

  const proposed = parseProposedNodes(sourceDoc.type.schema, record.proposed);
  if (!proposed) return null;

  // The proposed fragment must be valid as exact siblings at the parent/index,
  // so `tr.insert` never wraps or restructures it (e.g. a bare listItem).
  const insertIndex = record.anchor.childIndex + record.anchor.childCount;
  if (!sourceDoc.canReplace(insertIndex, insertIndex, Fragment.fromArray(proposed))) return null;

  return { record, range, proposed };
}

/**
 * Reconstruct the review document from a pristine source and its structural
 * records. Treats records as an untrusted deserialization boundary: validates
 * every record's shape, anchor, source trackability, fingerprint, and
 * proposed-subtree hygiene/admissibility before any insertion; quarantines
 * duplicate `changeId`s and overlapping anchors; reconstructs the survivors in
 * reverse source order via direct node insertion (R4 — no Markdown-reparse
 * coalescing); and fails ATOMICALLY (returns the pristine source, quarantines the
 * batch) on any unexpected transform error. The whole-document hash gate is the
 * caller's responsibility.
 */
/** Change ids that appear on more than one record (all such records quarantine). */
function duplicateChangeIds(records: unknown[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const id = isPlainObject(r) ? r.changeId : undefined;
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
}

/** Change ids whose anchor ranges overlap another's (both are malformed). */
function overlappingChangeIds(valid: ValidRecord[]): Set<string> {
  const overlapping = new Set<string>();
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      if (valid[i].range.from < valid[j].range.to && valid[j].range.from < valid[i].range.to) {
        overlapping.add(valid[i].record.changeId);
        overlapping.add(valid[j].record.changeId);
      }
    }
  }
  return overlapping;
}

/** Build the review document from validated records, reverse source order. */
function applyRecords(
  sourceDoc: PMNode,
  applicable: ValidRecord[],
): { doc: PMNode; mapping: Mapping } {
  const tr = new Transform(sourceDoc);
  for (const { record, range, proposed } of [...applicable].sort(
    (a, b) => b.range.from - a.range.from,
  )) {
    const flagged = proposed.map((node) =>
      node.type.create(
        { ...node.attrs, blockTrack: { changeId: record.changeId, op: 'insert' } },
        node.content,
        node.marks,
      ),
    );
    tr.insert(range.to, Fragment.fromArray(flagged));
    for (const pos of range.blockPositions) {
      const node = sourceDoc.nodeAt(pos) as PMNode;
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        blockTrack: { changeId: record.changeId, op: 'delete' },
      });
    }
  }
  return { doc: tr.doc, mapping: tr.mapping };
}

export function reconstructBlockUnions(
  sourceDoc: PMNode,
  records: StructuralSuggestionRecord[],
  serialize: MarkdownSerialize,
): ReconstructionResult {
  const duplicates = duplicateChangeIds(records);
  const valid: ValidRecord[] = [];
  const quarantined: StructuralSuggestionRecord[] = [];
  for (const record of records) {
    const id = isPlainObject(record) ? record.changeId : undefined;
    const isDuplicate = typeof id === 'string' && duplicates.has(id);
    const v = isDuplicate ? null : validateRecord(sourceDoc, record, serialize);
    if (v) valid.push(v);
    else quarantined.push(record);
  }

  const overlapping = overlappingChangeIds(valid);
  const applicable = valid.filter((v) => {
    if (!overlapping.has(v.record.changeId)) return true;
    quarantined.push(v.record);
    return false;
  });

  try {
    const { doc, mapping } = applyRecords(sourceDoc, applicable);
    return { doc, mapping, restored: applicable.map((v) => v.record), quarantined };
  } catch {
    return {
      doc: sourceDoc,
      mapping: new Transform(sourceDoc).mapping,
      restored: [],
      quarantined: [...quarantined, ...applicable.map((v) => v.record)],
    };
  }
}
