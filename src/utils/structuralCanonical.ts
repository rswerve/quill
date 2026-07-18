import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import type { StructuralSuggestionRecord } from '../types';
import {
  activeStructuralChangeIds,
  type CanonicalRecord,
} from '../extensions/StructuralRecordStore';
import { projectBlockUnions } from './blockUnionProjection';
import { buildAnchorMapper } from './reviewAnchorMap';
import { structuralFootprints } from './structuralFootprints';
import { structuralFingerprint, type MarkdownSerialize } from './structuralFingerprint';
import { reconstructBlockUnions } from './structuralReconstruction';

export type RebasedStructuralRecords =
  | { ok: true; records: StructuralSuggestionRecord[] }
  | { ok: false; error: string };

export type CanonicalStructuralReview = { ok: true; doc: PMNode } | { ok: false; error: string };

export type StructuralRecordSeed =
  | { ok: true; records: CanonicalRecord[] }
  | { ok: false; error: string };

interface TopLevelRange {
  childIndex: number;
  childCount: number;
  outerFrom: number;
  outerTo: number;
  contentFrom: number;
  contentTo: number;
  nodes: PMNode[];
}

/** Resolve a V1 top-level structural anchor to exact node and content boundaries. */
function resolveTopLevelRange(
  doc: PMNode,
  childIndex: number,
  childCount: number,
): TopLevelRange | null {
  if (childIndex < 0 || childCount < 1 || childIndex + childCount > doc.childCount) {
    return null;
  }
  let pos = 0;
  for (let i = 0; i < childIndex; i += 1) pos += doc.child(i).nodeSize;
  const outerFrom = pos;
  const nodes: PMNode[] = [];
  for (let i = childIndex; i < childIndex + childCount; i += 1) {
    const child = doc.child(i);
    nodes.push(child);
    pos += child.nodeSize;
  }
  const outerTo = pos;
  return {
    childIndex,
    childCount,
    outerFrom,
    outerTo,
    // Structural roots are non-leaf blocks, so their content is delimited by
    // the opening/closing token on each end. For a multi-block range this spans
    // every intervening block boundary, which is exactly what the anchor mapper
    // must prove survived the Markdown round trip.
    contentFrom: outerFrom + 1,
    contentTo: outerTo - 1,
    nodes,
  };
}

/** Locate the exact top-level range whose content boundaries match a mapped range. */
function rangeAtContentBoundaries(doc: PMNode, from: number, to: number): TopLevelRange | null {
  let pos = 0;
  let startIndex = -1;
  let endIndex = -1;
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i);
    if (pos + 1 === from) startIndex = i;
    pos += child.nodeSize;
    if (pos - 1 === to && startIndex >= 0) {
      endIndex = i;
      break;
    }
  }
  if (startIndex < 0 || endIndex < startIndex) return null;
  return resolveTopLevelRange(doc, startIndex, endIndex - startIndex + 1);
}

function idsAreExact(
  expectedRecords: readonly StructuralSuggestionRecord[],
  restoredRecords: readonly StructuralSuggestionRecord[],
): boolean {
  const expected = expectedRecords.map((record) => record.changeId);
  const restored = restoredRecords.map((record) => record.changeId);
  const expectedSet = new Set(expected);
  const restoredSet = new Set(restored);
  return (
    expectedSet.size === expected.length &&
    restoredSet.size === restored.length &&
    expectedSet.size === restoredSet.size &&
    [...expectedSet].every((id) => restoredSet.has(id))
  );
}

/** Canonical metadata only; proposed/anchor/fingerprint data never enters plugin state. */
function toCanonicalRecord(record: StructuralSuggestionRecord): CanonicalRecord {
  return {
    changeId: record.changeId,
    op: record.op,
    author: record.author,
    createdAt: record.createdAt,
    ...(record.originCommentId ? { originCommentId: record.originCommentId } : {}),
    ...(record.originChatMessageId ? { originChatMessageId: record.originChatMessageId } : {}),
  };
}

const REVIEW_MARK_TYPES = ['tracked_insert', 'tracked_delete', 'tracked_format', 'comment'];

/** Exact structural/content parity after removing the independently-persisted review marks. */
function structuralSkeletonEq(a: PMNode, b: PMNode): boolean {
  return stripReviewMarks(a).eq(stripReviewMarks(b));
}

function stripReviewMarks(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  for (const name of REVIEW_MARK_TYPES) {
    const markType = doc.type.schema.marks[name];
    if (markType) tr.removeMark(0, tr.doc.content.size, markType);
  }
  return tr.doc;
}

/**
 * Re-anchor and re-fingerprint records extracted from the LIVE review union so
 * they describe the parsed canonical SOURCE document exactly. Markdown parsing
 * may normalize whitespace or remove an earlier empty block, so copying only a
 * new fingerprint is insufficient: childIndex/childCount must be mapped too.
 *
 * The live source and canonical source are aligned by the same deterministic,
 * provenance-aware mapper used by inline canonical capture. Each structural
 * anchor must map to exact top-level block-content boundaries; a disappearing,
 * merged, split, or semantically changed source root fails closed.
 */
export function rebaseStructuralRecordsToCanonicalSource(
  liveReviewDoc: PMNode,
  canonicalSourceDoc: PMNode,
  records: readonly StructuralSuggestionRecord[],
  serialize: MarkdownSerialize,
): RebasedStructuralRecords {
  const footprintIds = new Set(structuralFootprints(liveReviewDoc).map((entry) => entry.changeId));
  const activeIds = activeStructuralChangeIds(liveReviewDoc);
  const recordIds = records.map((record) => record.changeId);
  const recordSet = new Set(recordIds);
  const idsAreComplete =
    footprintIds.size === activeIds.size &&
    [...footprintIds].every((id) => activeIds.has(id)) &&
    recordSet.size === recordIds.length &&
    activeIds.size === recordSet.size &&
    [...activeIds].every((id) => recordSet.has(id));
  if (!idsAreComplete) {
    return { ok: false, error: 'structural records do not match the live unions' };
  }
  if (records.length === 0) return { ok: true, records: [] };
  const liveSourceDoc = projectBlockUnions(liveReviewDoc, 'source').doc;
  const mapper = buildAnchorMapper(liveSourceDoc, canonicalSourceDoc);
  const rebased: StructuralSuggestionRecord[] = [];

  for (const record of records) {
    if (record.anchor.parentPath.length !== 0) {
      return { ok: false, error: `unsupported structural parent path for ${record.changeId}` };
    }
    const liveRange = resolveTopLevelRange(
      liveSourceDoc,
      record.anchor.childIndex,
      record.anchor.childCount,
    );
    if (!liveRange) {
      return { ok: false, error: `invalid structural source anchor for ${record.changeId}` };
    }
    // Refuse a stale/misbound input record before attempting to relocate it.
    if (
      structuralFingerprint(Fragment.fromArray(liveRange.nodes), serialize) !==
      record.sourceFingerprint
    ) {
      return { ok: false, error: `structural source fingerprint mismatch for ${record.changeId}` };
    }
    const mapped = mapper.map(liveRange.contentFrom, liveRange.contentTo);
    if (!mapped) {
      return {
        ok: false,
        error: `structural source did not survive canonicalization for ${record.changeId}`,
      };
    }
    const canonicalRange = rangeAtContentBoundaries(canonicalSourceDoc, mapped.from, mapped.to);
    if (!canonicalRange) {
      return {
        ok: false,
        error: `structural source no longer aligns to blocks for ${record.changeId}`,
      };
    }
    rebased.push({
      ...record,
      anchor: {
        parentPath: [],
        childIndex: canonicalRange.childIndex,
        childCount: canonicalRange.childCount,
      },
      sourceFingerprint: structuralFingerprint(Fragment.fromArray(canonicalRange.nodes), serialize),
    });
  }
  return { ok: true, records: rebased };
}

/**
 * Purely reconstruct a canonical review union from the canonical source. This is
 * the detached-document counterpart of structuralReload: no editor transaction,
 * plugin state, history, or update side effects. A partial reconstruction is never
 * success — every record must restore exactly once and the reconstructed union must
 * project back to the exact source document supplied by the caller.
 */
export function buildCanonicalStructuralReview(
  canonicalSourceDoc: PMNode,
  records: readonly StructuralSuggestionRecord[],
  serialize: MarkdownSerialize,
): CanonicalStructuralReview {
  if (records.length === 0) return { ok: true, doc: canonicalSourceDoc };
  const result = reconstructBlockUnions(canonicalSourceDoc, [...records], serialize);
  if (result.quarantined.length > 0 || !idsAreExact(records, result.restored)) {
    return { ok: false, error: 'canonical structural records failed reconstruction' };
  }
  const projectedSource = projectBlockUnions(result.doc, 'source').doc;
  if (!projectedSource.eq(canonicalSourceDoc)) {
    return { ok: false, error: 'canonical structural review does not project to its source' };
  }
  return { ok: true, doc: result.doc };
}

/**
 * Validate persisted structural records against an already-restored lossless
 * review document and prepare the metadata-only plugin-state seed. This function
 * is pure: callers run it before any restore mutation, then attach the returned
 * records to the SAME transaction as the document replacement via
 * `resetStructuralRecords`.
 *
 * Exactness is bidirectional: every live blockTrack id must be a complete union
 * with exactly one valid persisted record, every persisted record must be live,
 * reconstruction from the source projection must reproduce the restored review
 * skeleton, and inline/comment marks are ignored only because their independent
 * bijection is validated by reviewSnapshotIntegrity.
 */
export function prepareStructuralRecordSeed(
  restoredReviewDoc: PMNode,
  persisted: readonly StructuralSuggestionRecord[],
  serialize: MarkdownSerialize,
): StructuralRecordSeed {
  const footprintIds = new Set(
    structuralFootprints(restoredReviewDoc).map((entry) => entry.changeId),
  );
  const activeIds = activeStructuralChangeIds(restoredReviewDoc);
  const persistedIds = persisted.map((record) => record.changeId);
  const persistedSet = new Set(persistedIds);
  const exactIds =
    footprintIds.size === activeIds.size &&
    [...footprintIds].every((id) => activeIds.has(id)) &&
    persistedSet.size === persistedIds.length &&
    activeIds.size === persistedSet.size &&
    [...activeIds].every((id) => persistedSet.has(id));
  if (!exactIds) {
    return { ok: false, error: 'lossless structural records do not match the live unions' };
  }
  if (persisted.length === 0) return { ok: true, records: [] };

  const sourceDoc = projectBlockUnions(restoredReviewDoc, 'source').doc;
  const rebuilt = buildCanonicalStructuralReview(sourceDoc, persisted, serialize);
  if (!rebuilt.ok) return rebuilt;
  if (!structuralSkeletonEq(rebuilt.doc, restoredReviewDoc)) {
    return { ok: false, error: 'lossless structural records do not reproduce the review union' };
  }
  return { ok: true, records: persisted.map(toCanonicalRecord) };
}
