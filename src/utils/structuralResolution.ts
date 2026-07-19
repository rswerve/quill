import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { retainedRecords } from '../extensions/StructuralRecordStore';
import {
  SKIP_TRACKING_META,
  STRUCTURAL_BYPASS_META,
  type StructuralBypass,
} from '../extensions/trackChangesMeta';
import { analyzeStructuralUnions } from './structuralUnionIndex';
import { structuralFootprints } from './structuralFootprints';

/**
 * The per-change structural resolution kernel. Accept collapses a block union to
 * its proposed branch, Reject to its original branch — for ONE changeId only,
 * leaving every other union and all inline suggestions untouched. The collapse is
 * ONE `replaceWith` over the whole union (the surviving branch, identity cleared),
 * so the transaction inverts atomically: Undo restores both branches in a single
 * step and the session-retained record reactivates. A two-step markup+delete does
 * NOT invert cleanly (its inverse re-inserts and re-marks with divergent mapping).
 *
 * The transaction carries {@link SKIP_TRACKING_META} and a scoped
 * `{kind:'resolve', changeId, action}` {@link STRUCTURAL_BYPASS_META}, so the
 * freeze guard authorizes exactly this change and no other.
 *
 * Option-B: on Accept the origin comment's mark is removed in the SAME transaction
 * — a contained origin rides the dropped delete branch, but a DISJOINT origin
 * elsewhere would otherwise outlive its now-resolved record and break snapshot
 * integrity. A resolve for A must never mutate a locked union B, so if the origin
 * mark sits inside any OTHER change's footprint the resolution refuses with
 * `origin-comment-locked` rather than broadening A's bypass; once B resolves, A
 * can be retried. Reject performs no comment operation and retains the origin.
 */
export type StructuralResolutionResult =
  | { ok: true; tr: Transaction }
  | { ok: false; reason: 'not-resolvable' | 'origin-comment-locked' };

interface CommentMarkInstance {
  from: number;
  to: number;
  mark: Mark;
}

/** Every live instance of one comment id, as exact (removable) mark instances. */
function commentMarkInstances(doc: PMNode, commentId: string): CommentMarkInstance[] {
  const instances: CommentMarkInstance[] = [];
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment' && mark.attrs.commentId === commentId) {
        instances.push({ from: pos, to: pos + node.nodeSize, mark });
      }
    }
  });
  return instances;
}

export function resolveStructuralUnion(
  state: EditorState,
  changeId: string,
  action: 'accept' | 'reject',
): StructuralResolutionResult {
  const records = retainedRecords(state);
  const union = analyzeStructuralUnions(state.doc, records).persistable.get(changeId);
  if (!union) return { ok: false, reason: 'not-resolvable' };
  const record = records.get(changeId);
  const tr = state.tr;

  if (action === 'accept' && record?.originCommentId) {
    const instances = commentMarkInstances(state.doc, record.originCommentId);
    if (instances.length > 0) {
      // A resolve for this change must not touch another change's frozen region.
      const foreignFootprints = structuralFootprints(state.doc).filter(
        (footprint) => footprint.changeId !== changeId,
      );
      const insideForeignUnion = instances.some((instance) =>
        foreignFootprints.some(
          (footprint) => instance.from < footprint.to && footprint.from < instance.to,
        ),
      );
      if (insideForeignUnion) return { ok: false, reason: 'origin-comment-locked' };
      // Unset only DISJOINT origin instances (outside this union) so a disjoint
      // origin does not outlive its record; instances inside the union are dropped
      // by the collapse below and correctly restored (with their mark) by Undo.
      for (const instance of instances) {
        if (instance.from >= union.from && instance.to <= union.to) continue;
        tr.removeMark(instance.from, instance.to, instance.mark);
      }
    }
  }

  // Collapse to the surviving branch (identity cleared) in ONE replaceWith over the
  // whole union, so the transaction inverts atomically — Undo restores both branches
  // (and the record reactivates) in a single step. A two-step markup+delete does not.
  const keepRoot = action === 'accept' ? union.insertRoot : union.deleteRoot;
  const survivor = keepRoot.node.type.create(
    { ...keepRoot.node.attrs, blockTrack: null },
    keepRoot.node.content,
    keepRoot.node.marks,
  );
  tr.replaceWith(union.from, union.to, survivor);
  tr.setMeta(SKIP_TRACKING_META, true);
  tr.setMeta(STRUCTURAL_BYPASS_META, {
    kind: 'resolve',
    changeId,
    action,
  } satisfies StructuralBypass);
  return { ok: true, tr };
}
