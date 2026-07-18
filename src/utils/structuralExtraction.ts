import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import type { StructuralOp, StructuralSuggestionRecord } from '../types';
import type { MarkdownSerialize } from './structuralFingerprint';
import { structuralFingerprint } from './structuralFingerprint';
import { isReviewMarkName } from './canonicalDocument';
import { analyzeStructuralUnions, type StructuralUnionIndex } from './structuralUnionIndex';

/** Metadata that lives in the canonical record, keyed by changeId. */
export interface StructuralRecordMetadata {
  op: StructuralOp;
  author: string;
  createdAt: string;
  originCommentId?: string;
  originChatMessageId?: string;
}

/**
 * Strip review-only metadata from a proposed subtree's JSON so the persisted
 * proposal is clean: no `blockTrack` identity, no tracking/comment marks. This is
 * what keeps the sidecar's proposed content valid against reconstruction's trust
 * boundary (which quarantines any of those).
 */
function stripReviewMetadata(json: JSONContent): JSONContent {
  const out: JSONContent = { ...json };
  if (out.attrs) {
    const rest = { ...(out.attrs as Record<string, unknown>) };
    delete rest.blockTrack;
    out.attrs = rest;
  }
  if (out.marks) out.marks = out.marks.filter((mark) => !isReviewMarkName(mark.type));
  if (out.content) out.content = out.content.map(stripReviewMetadata);
  return out;
}

/**
 * Extract persistable structural records from a review document — the inverse of
 * `reconstructBlockUnions`. For each change: the anchor is computed in SOURCE
 * index space (insert branches removed), the fingerprint is the Markdown of the
 * delete branch (identical to the on-disk source, since Markdown drops
 * `blockTrack`), and `proposed` is the insert branch's JSON with all review
 * metadata stripped. Structural metadata (author/timestamp/origin) is supplied by
 * the caller from the canonical record store. Incomplete unions (a branch with no
 * counterpart) or changes with no metadata are skipped.
 */
export function extractStructuralRecords(
  reviewDoc: PMNode,
  metadata: Map<string, StructuralRecordMetadata>,
  serialize: MarkdownSerialize,
): StructuralSuggestionRecord[] {
  return extractStructuralRecordsFromIndex(
    analyzeStructuralUnions(reviewDoc, metadata),
    metadata,
    serialize,
  );
}

/** Extract from a previously-built index so save uses the exact same union truth. */
export function extractStructuralRecordsFromIndex(
  index: StructuralUnionIndex,
  metadata: ReadonlyMap<string, StructuralRecordMetadata>,
  serialize: MarkdownSerialize,
): StructuralSuggestionRecord[] {
  const records: StructuralSuggestionRecord[] = [];
  for (const [changeId, union] of index.persistable) {
    const meta = metadata.get(changeId);
    if (!meta) continue;
    const deleteNodes = [union.deleteRoot.node];
    records.push({
      changeId,
      author: meta.author,
      createdAt: meta.createdAt,
      op: meta.op,
      ...(meta.originCommentId ? { originCommentId: meta.originCommentId } : {}),
      ...(meta.originChatMessageId ? { originChatMessageId: meta.originChatMessageId } : {}),
      anchor: {
        parentPath: [...union.parentPath],
        childIndex: union.sourceChildIndex,
        childCount: union.sourceChildCount,
      },
      sourceFingerprint: structuralFingerprint(Fragment.fromArray(deleteNodes), serialize),
      proposed: [stripReviewMetadata(union.insertRoot.node.toJSON())],
    });
  }
  return records;
}
