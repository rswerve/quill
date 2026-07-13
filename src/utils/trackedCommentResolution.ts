import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Comment } from '../types';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import { rangeText } from './trackedEdits';

export type TrackedRemovalMark = 'tracked_delete' | 'tracked_insert';

export interface CapturedCommentAnchor {
  id: string;
  from: number;
  to: number;
  anchorText: string;
}

interface Range {
  from: number;
  to: number;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Capture live comments whose complete marked range will be removed by a
 * tracked-change resolution. Accept removes tracked deletions; reject removes
 * tracked insertions. `targetId` may be one change id or a replacement pairId;
 * omitting it models the corresponding All action.
 */
export function captureCommentsConsumedByTrackedRemoval(
  doc: ProseMirrorNode,
  removalMarkName: TrackedRemovalMark,
  targetId?: string,
): CapturedCommentAnchor[] {
  const removalRanges: Range[] = [];
  const commentRanges = new Map<string, Range[]>();

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === 'comment' && typeof mark.attrs.commentId === 'string') {
        const ranges = commentRanges.get(mark.attrs.commentId) ?? [];
        ranges.push({ from: pos, to: pos + node.nodeSize });
        commentRanges.set(mark.attrs.commentId, ranges);
      }
      if (mark.type.name !== removalMarkName) continue;
      const tracked = mark.attrs.dataTracked;
      if (tracked?.status !== 'pending') continue;
      if (targetId && tracked.id !== targetId && tracked.pairId !== targetId) continue;
      removalRanges.push({ from: pos, to: pos + node.nodeSize });
    }
  });

  const mergedRemovals = mergeRanges(removalRanges);
  if (mergedRemovals.length === 0 || commentRanges.size === 0) return [];

  const captured: CapturedCommentAnchor[] = [];
  for (const [id, markedRanges] of commentRanges) {
    const live = findAnnotationRange(doc, 'comment', id);
    if (!live) continue;
    const fullyConsumed = markedRanges.every((marked) =>
      mergedRemovals.some((removal) => removal.from <= marked.from && removal.to >= marked.to),
    );
    if (!fullyConsumed) continue;
    captured.push({ ...live, id, anchorText: rangeText(doc, live.from, live.to) });
  }
  return captured;
}

/** Queue-safe state transform using snapshots captured before the text removal. */
export function autoResolveCapturedComments(
  comments: Comment[],
  captured: CapturedCommentAnchor[],
): Comment[] {
  if (captured.length === 0) return comments;
  const byId = new Map(captured.map((anchor) => [anchor.id, anchor]));
  let changed = false;
  const resolved = comments.map((comment) => {
    const anchor = byId.get(comment.id);
    if (!anchor || comment.resolved) return comment;
    changed = true;
    return { ...comment, ...anchor, resolved: true };
  });
  return changed ? resolved : comments;
}
