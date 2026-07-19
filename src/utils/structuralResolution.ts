import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { retainedRecords } from '../extensions/StructuralRecordStore';
import {
  SKIP_TRACKING_META,
  STRUCTURAL_BYPASS_META,
  type StructuralBypass,
} from '../extensions/trackChangesMeta';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import { analyzeStructuralUnions, type IndexedStructuralUnion } from './structuralUnionIndex';
import { structuralFootprints } from './structuralFootprints';
import { rangeText } from './trackedEdits';
import type { CapturedCommentAnchor } from './trackedCommentResolution';

/**
 * The per-change structural resolution kernel. Accept collapses a block union to
 * its proposed branch, Reject to its original branch — for ONE changeId only,
 * leaving every other union and all inline suggestions untouched.
 *
 * The collapse is ONE `replaceWith` over the whole union (the surviving branch,
 * identity cleared), so the transaction inverts atomically: Undo restores both
 * branches in a single step and the session-retained record reactivates. (A
 * two-step markup+delete does NOT invert cleanly.) The transaction carries
 * `closeHistory` so it is its own undo event even when Accept immediately follows
 * the mint, plus {@link SKIP_TRACKING_META} and a scoped
 * `{kind:'resolve', changeId, action}` {@link STRUCTURAL_BYPASS_META} so the freeze
 * guard authorizes exactly this change.
 *
 * Fail-closed: a union whose live shape violates the mint invariant — any tracked
 * mark, any foreign comment, or an origin comment not wholly inside the delete
 * branch (review-mark and structural-skeleton validation are independent, so a
 * snapshot could carry such a state) — refuses `union-not-clean` rather than
 * collapse into a highlight for a resolved comment or silently delete a foreign
 * thread.
 *
 * Option-B (accept only): the origin comment is auto-resolved. A CONTAINED origin
 * rides the dropped delete branch; a DISJOINT origin's exact mark instances are
 * unset in the same transaction so it does not outlive its resolved record. If the
 * origin mark sits inside ANOTHER change's footprint the resolution refuses
 * `origin-comment-locked` (never broadening A's bypass to mutate B); retry once B
 * resolves. The origin's live anchor is returned as `resolvedComment` so the caller
 * resolves React comment state ONLY for a successful, dispatched resolution. Reject
 * performs no comment operation and retains the origin.
 */
export type StructuralResolutionResult =
  | { ok: true; tr: Transaction; resolvedComment: CapturedCommentAnchor | null }
  | { ok: false; reason: 'not-resolvable' | 'union-not-clean' | 'origin-comment-locked' };

const TRACKED_MARK_NAMES = new Set(['tracked_insert', 'tracked_delete', 'tracked_format']);

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

/**
 * The union's live shape matches the mint invariant: no tracked marks anywhere in
 * it, and any comment is the sole origin comment sitting wholly inside the delete
 * branch (the proposed branch is clean per the carveout).
 */
function unionIsClean(
  doc: PMNode,
  union: IndexedStructuralUnion,
  originCommentId: string | undefined,
): boolean {
  const deleteFrom = union.deleteRoot.pos;
  const deleteTo = union.deleteRoot.to;
  let clean = true;
  // Inspect EVERY node's marks (text, hard breaks, inline atoms, and even a
  // malformed block-node mark), not text nodes alone.
  doc.nodesBetween(union.from, union.to, (node, pos) => {
    if (!clean) return false;
    for (const mark of node.marks) {
      const name = mark.type.name;
      if (TRACKED_MARK_NAMES.has(name)) {
        clean = false;
        return false;
      }
      if (name === 'comment') {
        const isOrigin = originCommentId !== undefined && mark.attrs.commentId === originCommentId;
        const insideDeleteBranch =
          node.isInline && pos >= deleteFrom && pos + node.nodeSize <= deleteTo;
        if (!isOrigin || !insideDeleteBranch) {
          clean = false;
          return false;
        }
      }
    }
    return true;
  });
  return clean;
}

type OriginAcceptOutcome =
  | { locked: true }
  | { locked: false; resolvedComment: CapturedCommentAnchor | null };

/**
 * Handle the origin comment on Accept: refuse if it sits inside another change's
 * frozen union, otherwise capture its live anchor (for the caller's React state)
 * and unset only its DISJOINT instances on `tr` (in-union instances are the delete
 * branch and ride the dropped branch, so Undo restores them). Runs after the
 * cleanliness preflight, so any in-union origin instance is delete-branch-only.
 */
function resolveOriginCommentOnAccept(
  state: EditorState,
  tr: Transaction,
  union: IndexedStructuralUnion,
  changeId: string,
  originCommentId: string,
): OriginAcceptOutcome {
  const instances = commentMarkInstances(state.doc, originCommentId);
  if (instances.length === 0) return { locked: false, resolvedComment: null };
  const foreignFootprints = structuralFootprints(state.doc).filter(
    (footprint) => footprint.changeId !== changeId,
  );
  const insideForeignUnion = instances.some((instance) =>
    foreignFootprints.some(
      (footprint) => instance.from < footprint.to && footprint.from < instance.to,
    ),
  );
  if (insideForeignUnion) return { locked: true };
  const live = findAnnotationRange(state.doc, 'comment', originCommentId);
  const resolvedComment: CapturedCommentAnchor | null = live
    ? {
        id: originCommentId,
        from: live.from,
        to: live.to,
        anchorText: rangeText(state.doc, live.from, live.to),
      }
    : null;
  for (const instance of instances) {
    if (instance.from < union.to && union.from < instance.to) continue;
    tr.removeMark(instance.from, instance.to, instance.mark);
  }
  return { locked: false, resolvedComment };
}

export function resolveStructuralUnion(
  state: EditorState,
  changeId: string,
  action: 'accept' | 'reject',
): StructuralResolutionResult {
  const records = retainedRecords(state);
  const union = analyzeStructuralUnions(state.doc, records).persistable.get(changeId);
  if (!union) return { ok: false, reason: 'not-resolvable' };
  const originCommentId = records.get(changeId)?.originCommentId;

  // Fail closed on a union that violates the mint invariant either way.
  if (!unionIsClean(state.doc, union, originCommentId)) {
    return { ok: false, reason: 'union-not-clean' };
  }

  const tr = state.tr;
  let resolvedComment: CapturedCommentAnchor | null = null;

  if (action === 'accept' && originCommentId) {
    const outcome = resolveOriginCommentOnAccept(state, tr, union, changeId, originCommentId);
    if (outcome.locked) return { ok: false, reason: 'origin-comment-locked' };
    resolvedComment = outcome.resolvedComment;
  }

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
  closeHistory(tr);
  return { ok: true, tr, resolvedComment };
}
