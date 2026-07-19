import type { EditorState } from '@tiptap/pm/state';
import type { StructuralChangeInfo } from '../types';
import { retainedRecords } from '../extensions/StructuralRecordStore';
import { analyzeStructuralUnions } from './structuralUnionIndex';

/**
 * Enumerate the live block-union structural changes for the review layer. The
 * authoritative source is the canonical record store joined with
 * `analyzeStructuralUnions`' **persistable** set — unions whose topology, metadata,
 * and declared op all agree — NOT raw `blockTrack` attributes, which cannot tell an
 * incomplete, orphan, or op-mismatched union from a real one. Each change's metadata
 * is read from the FULL {@link CanonicalRecord} by id, never the analyzer's minimal
 * metadata view.
 *
 * A change is included only while its union is live and complete: a
 * retained-but-inactive record (its union removed by Undo) is absent, and Undo/Redo
 * toggle inclusion because the analyzer derives activity from the document. The
 * result is sorted in document order (envelope start, then changeId) so card order
 * never depends on record insertion order.
 *
 * This axis is deliberately separate from `getTrackedChanges` (inline marks only) —
 * `blockTrack` is a node attribute invisible to it — so the two review axes never
 * cross-contaminate.
 */
export function getStructuralChanges(state: EditorState): StructuralChangeInfo[] {
  const records = retainedRecords(state);
  const index = analyzeStructuralUnions(state.doc, records);
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
