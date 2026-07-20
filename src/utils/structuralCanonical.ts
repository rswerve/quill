import { Fragment, Mark, type Node as PMNode } from '@tiptap/pm/model';
import type { StructuralSuggestionRecord } from '../types';
import { structuralSkeletonEq } from './canonicalDocument';
import { partitionStructuralRecords } from './structuralRecordValidation';
import { toCanonicalRecord, type CanonicalRecord } from '../extensions/StructuralRecordStore';
import { projectBlockUnions } from './blockUnionProjection';
import { buildAnchorMapper } from './reviewAnchorMap';
import { structuralFingerprint, type MarkdownSerialize } from './structuralFingerprint';
import { reconstructBlockUnions } from './structuralReconstruction';
import { analyzeStructuralUnions } from './structuralUnionIndex';

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

/**
 * The first-to-last real content carried by a structural source range. Unlike
 * `contentFrom`/`contentTo`, these positions are visible to `buildAnchorMapper`
 * even when the top-level root is a non-textblock container such as a list.
 */
function contentWitness(range: TopLevelRange): { from: number; to: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  let rootFrom = range.outerFrom;
  for (const root of range.nodes) {
    root.descendants((node, pos) => {
      if (node.isText || node.isLeaf) {
        const absolute = rootFrom + 1 + pos;
        if (first === null) first = absolute;
        last = absolute + node.nodeSize;
      }
    });
    rootFrom += root.nodeSize;
  }
  return first === null || last === null ? null : { from: first, to: last };
}

/** Locate the top-level range whose block containers enclose a mapped witness. */
function rangeContainingWitness(doc: PMNode, from: number, to: number): TopLevelRange | null {
  if (from > to) return null;
  let pos = 0;
  let startIndex = -1;
  let endIndex = -1;
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i);
    const contentFrom = pos + 1;
    const contentTo = pos + child.nodeSize - 1;
    if (startIndex < 0 && contentFrom <= from && from <= contentTo) startIndex = i;
    if (contentFrom <= to && to <= contentTo) endIndex = i;
    pos += child.nodeSize;
  }
  if (startIndex < 0 || endIndex < startIndex) return null;
  return resolveTopLevelRange(doc, startIndex, endIndex - startIndex + 1);
}

const IGNORED_CONTAINER_ATTRS = new Set(['blockTrack', 'tight']);

function semanticContainerAttrs(node: PMNode): string {
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(node.attrs).sort()) {
    if (!IGNORED_CONTAINER_ATTRS.has(key)) attrs[key] = node.attrs[key];
  }
  return JSON.stringify(attrs);
}

/**
 * Compare only the block-container tree. Inline identity is already proven by
 * mapping the complete content witness; this second check prevents that content
 * from being rebound into a different/merged list or item hierarchy.
 */
function blockContainerHierarchyEq(left: PMNode, right: PMNode): boolean {
  if (
    left.type.name !== right.type.name ||
    semanticContainerAttrs(left) !== semanticContainerAttrs(right) ||
    !Mark.sameSet(left.marks, right.marks)
  ) {
    return false;
  }
  const leftBlocks: PMNode[] = [];
  const rightBlocks: PMNode[] = [];
  left.forEach((child) => {
    if (child.isBlock) leftBlocks.push(child);
  });
  right.forEach((child) => {
    if (child.isBlock) rightBlocks.push(child);
  });
  return (
    leftBlocks.length === rightBlocks.length &&
    leftBlocks.every((child, index) => blockContainerHierarchyEq(child, rightBlocks[index]))
  );
}

function rangeContainerHierarchyEq(left: TopLevelRange, right: TopLevelRange): boolean {
  return (
    left.nodes.length === right.nodes.length &&
    left.nodes.every((node, index) => blockContainerHierarchyEq(node, right.nodes[index]))
  );
}

/**
 * Map a source range to its canonical top-level roots. Exact wrapper boundaries
 * remain authoritative. Lists need the fallback because the generic mapper has
 * cells for their text/leaf descendants, not for the list wrapper's content edge.
 */
function mapCanonicalRange(
  liveRange: TopLevelRange,
  canonicalSourceDoc: PMNode,
  mapper: ReturnType<typeof buildAnchorMapper>,
): { range: TopLevelRange | null; exactMapped: boolean } {
  const exact = mapper.map(liveRange.contentFrom, liveRange.contentTo);
  if (exact) {
    const exactRange = rangeAtContentBoundaries(canonicalSourceDoc, exact.from, exact.to);
    if (exactRange) return { range: exactRange, exactMapped: true };
  }

  // Textblock roots already expose their exact content boundaries to the generic
  // mapper. The fallback is deliberately narrower: it exists for structural
  // containers (currently list roots) whose wrapper boundary has no anchor cell.
  if (liveRange.nodes.every((node) => node.isTextblock)) {
    return { range: null, exactMapped: exact !== null };
  }
  const witness = contentWitness(liveRange);
  if (!witness) return { range: null, exactMapped: exact !== null };
  const mappedWitness = mapper.map(witness.from, witness.to);
  if (!mappedWitness) return { range: null, exactMapped: exact !== null };
  const containing = rangeContainingWitness(
    canonicalSourceDoc,
    mappedWitness.from,
    mappedWitness.to,
  );
  return {
    range: containing && rangeContainerHierarchyEq(liveRange, containing) ? containing : null,
    exactMapped: exact !== null,
  };
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

/**
 * Re-anchor and re-fingerprint records extracted from the LIVE review union so
 * they describe the parsed canonical SOURCE document exactly. Markdown parsing
 * may normalize whitespace or remove an earlier empty block, so copying only a
 * new fingerprint is insufficient: childIndex/childCount must be mapped too.
 *
 * The live source and canonical source are aligned by the same deterministic,
 * provenance-aware mapper used by inline canonical capture. Textblock anchors
 * must map to exact top-level content boundaries. A non-textblock container whose
 * wrapper boundary has no mapper cell may instead relocate through its complete
 * descendant-content witness, but only when the enclosing block hierarchy is
 * identical. A disappearing, merged, split, or semantically changed source root
 * therefore still fails closed.
 */
export function rebaseStructuralRecordsToCanonicalSource(
  liveReviewDoc: PMNode,
  canonicalSourceDoc: PMNode,
  records: readonly StructuralSuggestionRecord[],
  serialize: MarkdownSerialize,
): RebasedStructuralRecords {
  const recordIds = records.map((record) => record.changeId);
  const recordSet = new Set(recordIds);
  const metadata = new Map(records.map((record) => [record.changeId, record]));
  const index = analyzeStructuralUnions(liveReviewDoc, metadata);
  const activeIds = new Set(index.persistable.keys());
  const idsAreComplete =
    index.hasStructuralMarkup === records.length > 0 &&
    index.issues.length === 0 &&
    index.missingMetadataIds.size === 0 &&
    index.allIdentityIds.size === index.topologyValid.size &&
    [...index.allIdentityIds].every((id) => index.topologyValid.has(id)) &&
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
    const mappedRange = mapCanonicalRange(liveRange, canonicalSourceDoc, mapper);
    const canonicalRange = mappedRange.range;
    if (!canonicalRange) {
      return {
        ok: false,
        error: mappedRange.exactMapped
          ? `structural source no longer aligns to blocks for ${record.changeId}`
          : `structural source did not survive canonicalization for ${record.changeId}`,
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
  persisted: readonly unknown[],
  serialize: MarkdownSerialize,
): StructuralRecordSeed {
  // Persisted workspace JSON is untrusted. Partition BEFORE any metadata access; a malformed
  // entry makes the entire lossless seed unusable because docJSON + metadata are one atomic
  // snapshot and silently dropping one record could orphan or misidentify a live union.
  const partitioned = partitionStructuralRecords(persisted);
  if (partitioned.quarantined.length > 0) {
    return { ok: false, error: 'lossless structural records are malformed' };
  }
  const records = partitioned.valid;
  const persistedIds = records.map((record) => record.changeId);
  const persistedSet = new Set(persistedIds);
  const metadata = new Map(records.map((record) => [record.changeId, record]));
  const index = analyzeStructuralUnions(restoredReviewDoc, metadata);
  const activeIds = new Set(index.persistable.keys());
  const exactIds =
    index.hasStructuralMarkup === records.length > 0 &&
    index.issues.length === 0 &&
    index.missingMetadataIds.size === 0 &&
    index.allIdentityIds.size === index.topologyValid.size &&
    [...index.allIdentityIds].every((id) => index.topologyValid.has(id)) &&
    persistedSet.size === persistedIds.length &&
    activeIds.size === persistedSet.size &&
    [...activeIds].every((id) => persistedSet.has(id));
  if (!exactIds) {
    return { ok: false, error: 'lossless structural records do not match the live unions' };
  }
  if (records.length === 0) return { ok: true, records: [] };

  const sourceDoc = projectBlockUnions(restoredReviewDoc, 'source').doc;
  const rebuilt = buildCanonicalStructuralReview(sourceDoc, records, serialize);
  if (!rebuilt.ok) return rebuilt;
  if (!structuralSkeletonEq(rebuilt.doc, restoredReviewDoc)) {
    return { ok: false, error: 'lossless structural records do not reproduce the review union' };
  }
  return { ok: true, records: records.map(toCanonicalRecord) };
}
