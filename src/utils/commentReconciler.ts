import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Comment } from '../types';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import { rangeText } from './trackedEdits';

/**
 * Project unresolved comment records from their live document marks.
 *
 * A surviving mark is the runtime source of truth for both its range and quote.
 * If the whole marked span is deleted, ProseMirror removes the mark and the
 * unresolved comment disappears with it. Resolved comments are deliberately
 * mark-less, so they retain their stored snapshot until they are unresolved.
 *
 * A `detached` comment (one a load could not re-anchor) is likewise mark-less on
 * purpose: it is preserved AS-IS and never reattached here, even if a stray mark with
 * its id or matching text happens to exist — repair goes through explicit unique
 * relocation, never this projection.
 */
export function reconcileCommentsWithDocument(
  comments: Comment[],
  doc: ProseMirrorNode,
): Comment[] {
  let changed = false;
  const reconciled: Comment[] = [];

  for (const comment of comments) {
    if (comment.resolved || comment.detached) {
      reconciled.push(comment);
      continue;
    }

    const range = findAnnotationRange(doc, 'comment', comment.id);
    if (!range) {
      changed = true;
      continue;
    }

    const anchorText = rangeText(doc, range.from, range.to);
    if (
      range.from === comment.from &&
      range.to === comment.to &&
      anchorText === comment.anchorText
    ) {
      reconciled.push(comment);
      continue;
    }

    changed = true;
    reconciled.push({ ...comment, ...range, anchorText });
  }

  return changed ? reconciled : comments;
}
