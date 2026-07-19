import type { EditorState } from '@tiptap/pm/state';
import type { StructuralChangeInfo } from '../types';
import { retainedRecords } from '../extensions/StructuralRecordStore';
import {
  analyzeStructuralUnions,
  type StructuralUnionIndex,
  type StructuralUnionIssueCode,
} from './structuralUnionIndex';
import type { CanonicalRecord } from '../extensions/StructuralRecordStore';

/**
 * Build the review-facing structural changes from an analyzed index joined with the
 * canonical record store. Only the `persistable` set (topology + metadata + declared
 * op all agree) becomes an actionable change; metadata is read from the FULL record
 * by id. Sorted in document order (envelope start, then changeId) so card order
 * never depends on record insertion order.
 */
function changesFromIndex(
  index: StructuralUnionIndex,
  records: ReadonlyMap<string, CanonicalRecord>,
): StructuralChangeInfo[] {
  const changes: StructuralChangeInfo[] = [];
  for (const [changeId, union] of index.persistable) {
    const record = records.get(changeId);
    if (!record) continue; // persistable implies a record; stay defensive
    changes.push({
      kind: 'structural',
      changeId,
      op: record.op,
      author: record.author,
      createdAt: record.createdAt,
      ...(record.originCommentId ? { originCommentId: record.originCommentId } : {}),
      ...(record.originChatMessageId ? { originChatMessageId: record.originChatMessageId } : {}),
      from: union.from,
      to: union.to,
      source: { from: union.deleteRoot.pos, to: union.deleteRoot.to },
      proposed: { from: union.insertRoot.pos, to: union.insertRoot.to },
    });
  }
  return changes.sort((a, b) => a.from - b.from || a.changeId.localeCompare(b.changeId));
}

/**
 * The live block-union structural changes for the review layer. See
 * {@link getStructuralReviewState} for the changes + attention pairing; this is the
 * changes-only accessor used where attention is not needed. The structural axis is
 * deliberately separate from `getTrackedChanges` (inline marks only), since
 * `blockTrack` is a node attribute invisible to it.
 */
export function getStructuralChanges(state: EditorState): StructuralChangeInfo[] {
  const records = retainedRecords(state);
  return changesFromIndex(analyzeStructuralUnions(state.doc, records), records);
}

/** A structural review issue for the non-actionable needs-attention state. */
export type StructuralReviewIssueCode = StructuralUnionIssueCode | 'missing-metadata';

export interface StructuralReviewIssue {
  /** Null for an anonymous invalid identity (malformed markup with no usable id). */
  readonly changeId: string | null;
  readonly code: StructuralReviewIssueCode;
}

export interface StructuralReviewState {
  /** Actionable, card-facing changes (persistable unions). */
  changes: StructuralChangeInfo[];
  /** Corrupt/incomplete unions that get a non-actionable needs-attention state, never a card. */
  issues: StructuralReviewIssue[];
}

/**
 * The whole structural review inventory from ONE analyzer pass: the actionable
 * changes plus the issues a corrupt or incomplete union raises. Issues cover the
 * analyzer's topology problems, the anonymous invalid identities it reports with a
 * null change id, and — synthesized here because the analyzer keeps them out of
 * `issues` — the orphan unions in `missingMetadataIds` (a live union whose record was
 * lost). `union-not-clean` is NOT here: it is an inline-mark condition the analyzer
 * cannot see, surfaced instead when a resolution refuses.
 */
export function getStructuralReviewState(state: EditorState): StructuralReviewState {
  const records = retainedRecords(state);
  const index = analyzeStructuralUnions(state.doc, records);
  const issues: StructuralReviewIssue[] = index.issues.map((issue) => ({
    changeId: issue.changeId,
    code: issue.code,
  }));
  for (const changeId of index.missingMetadataIds) {
    issues.push({ changeId, code: 'missing-metadata' });
  }
  return { changes: changesFromIndex(index, records), issues };
}
