import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Transform, type Mapping } from '@tiptap/pm/transform';
import type { StructuralSuggestionRecord } from '../types';
import type { MarkdownSerialize } from './structuralFingerprint';
import { structuralFingerprint } from './structuralFingerprint';

const FORBIDDEN_MARKS = new Set(['tracked_insert', 'tracked_delete', 'tracked_format', 'comment']);

export interface ReconstructionResult {
  /** The rebuilt review document (source + proposed branches, both flagged). */
  doc: PMNode;
  /** Maps pristine-source positions onto the reconstructed review document. */
  mapping: Mapping;
  /** Records that failed validation; preserved verbatim, never applied. */
  quarantined: StructuralSuggestionRecord[];
}

interface ResolvedRange {
  from: number;
  to: number;
  blockPositions: number[];
}

/**
 * Resolve a top-level source-branch anchor to positions in the pristine source.
 * V1 supports only top-level unions (`parentPath` empty); nested anchors are
 * quarantined until the nested-list phase.
 */
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

/** A proposed subtree is clean iff it carries no tracking/comment marks or blockTrack. */
function proposedIsClean(node: PMNode): boolean {
  let clean = true;
  const inspect = (n: PMNode) => {
    if ((n.attrs as { blockTrack?: unknown }).blockTrack) clean = false;
    if (n.marks.some((mark) => FORBIDDEN_MARKS.has(mark.type.name))) clean = false;
  };
  inspect(node);
  node.descendants((child) => {
    inspect(child);
  });
  return clean;
}

/** Parse and validate one record's proposed blocks; null if any is unsafe. */
function parseProposed(schema: Schema, record: StructuralSuggestionRecord): PMNode[] | null {
  if (record.proposed.length === 0) return null;
  const nodes: PMNode[] = [];
  for (const json of record.proposed) {
    try {
      const node = schema.nodeFromJSON(json);
      node.check(); // throws on a schema-invalid subtree
      if (!node.isBlock || !proposedIsClean(node)) return null;
      nodes.push(node);
    } catch {
      return null;
    }
  }
  return nodes;
}

interface ValidRecord {
  record: StructuralSuggestionRecord;
  range: ResolvedRange;
  proposed: PMNode[];
}

/**
 * Reconstruct the review document from a pristine source document and its
 * structural records. The caller has already gated on the whole-document source
 * hash (a mismatch quarantines every record upstream); this validates each
 * record against the pristine source, rejects overlapping anchors, quarantines
 * the invalid, and reconstructs the valid ones — in reverse source order, via
 * direct `nodeFromJSON` insertion so adjacent same-type blocks never coalesce the
 * way a Markdown reparse would (R4). Every anchor is validated before the first
 * insertion, so an early reconstruction can't contaminate a later anchor.
 */
export function reconstructBlockUnions(
  sourceDoc: PMNode,
  records: StructuralSuggestionRecord[],
  serialize: MarkdownSerialize,
): ReconstructionResult {
  const schema = sourceDoc.type.schema;
  const valid: ValidRecord[] = [];
  const quarantined: StructuralSuggestionRecord[] = [];

  for (const record of records) {
    const { parentPath, childIndex, childCount } = record.anchor;
    const range =
      parentPath.length === 0 ? resolveTopLevelRange(sourceDoc, childIndex, childCount) : null;
    const proposed = parseProposed(schema, record);
    const fingerprintOk =
      range !== null &&
      structuralFingerprint(sourceBranchFragment(sourceDoc, range), serialize) ===
        record.sourceFingerprint;
    if (range && proposed && fingerprintOk) {
      valid.push({ record, range, proposed });
    } else {
      quarantined.push(record);
    }
  }

  // Reject overlapping/duplicate anchor ranges as malformed (both sides).
  const overlapping = new Set<string>();
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i].range;
      const b = valid[j].range;
      if (a.from < b.to && b.from < a.to) {
        overlapping.add(valid[i].record.changeId);
        overlapping.add(valid[j].record.changeId);
      }
    }
  }
  const applicable = valid.filter((v) => {
    if (!overlapping.has(v.record.changeId)) return true;
    quarantined.push(v.record);
    return false;
  });

  // Reconstruct in reverse source order so earlier anchors keep their positions.
  const tr = new Transform(sourceDoc);
  for (const { record, range } of [...applicable].sort((a, b) => b.range.from - a.range.from)) {
    const flagged = record.proposed.map((json) =>
      schema.nodeFromJSON({
        ...json,
        attrs: { ...(json.attrs ?? {}), blockTrack: { changeId: record.changeId, op: 'insert' } },
      }),
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

  return { doc: tr.doc, mapping: tr.mapping, quarantined };
}
