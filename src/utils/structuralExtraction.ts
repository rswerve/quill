import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import type { BlockTrackAttr } from '../extensions/BlockTrack';
import type { StructuralSuggestionRecord } from '../types';
import type { MarkdownSerialize } from './structuralFingerprint';
import { structuralFingerprint } from './structuralFingerprint';

/** Metadata that lives in the canonical record, keyed by changeId. */
export interface StructuralRecordMetadata {
  author: string;
  createdAt: string;
  originCommentId?: string;
  originChatMessageId?: string;
}

const STRIP_MARKS = new Set(['tracked_insert', 'tracked_delete', 'tracked_format', 'comment']);

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
  if (out.marks) out.marks = out.marks.filter((mark) => !STRIP_MARKS.has(mark.type));
  if (out.content) out.content = out.content.map(stripReviewMetadata);
  return out;
}

interface UnionGroup {
  deleteNodes: PMNode[];
  insertNodes: PMNode[];
  firstSourceIndex: number;
}

function groupByChange(reviewDoc: PMNode): Map<string, UnionGroup> {
  const groups = new Map<string, UnionGroup>();
  let sourceIndex = 0;
  reviewDoc.forEach((node) => {
    const track = node.attrs.blockTrack as BlockTrackAttr | null | undefined;
    if (!track) {
      sourceIndex += 1;
      return;
    }
    let group = groups.get(track.changeId);
    if (!group) {
      group = { deleteNodes: [], insertNodes: [], firstSourceIndex: -1 };
      groups.set(track.changeId, group);
    }
    if (track.op === 'delete') {
      if (group.firstSourceIndex < 0) group.firstSourceIndex = sourceIndex;
      group.deleteNodes.push(node);
      sourceIndex += 1; // a delete branch stays in the source document
    } else {
      group.insertNodes.push(node); // an insert branch is absent from the source
    }
  });
  return groups;
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
  const records: StructuralSuggestionRecord[] = [];
  for (const [changeId, group] of groupByChange(reviewDoc)) {
    const meta = metadata.get(changeId);
    if (group.deleteNodes.length === 0 || group.insertNodes.length === 0 || !meta) continue;
    records.push({
      changeId,
      author: meta.author,
      createdAt: meta.createdAt,
      ...(meta.originCommentId ? { originCommentId: meta.originCommentId } : {}),
      ...(meta.originChatMessageId ? { originChatMessageId: meta.originChatMessageId } : {}),
      anchor: {
        parentPath: [],
        childIndex: group.firstSourceIndex,
        childCount: group.deleteNodes.length,
      },
      sourceFingerprint: structuralFingerprint(Fragment.fromArray(group.deleteNodes), serialize),
      proposed: group.insertNodes.map((node) => stripReviewMetadata(node.toJSON())),
    });
  }
  return records;
}
