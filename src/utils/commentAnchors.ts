import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Comment } from '../types';
import { locateEdit, rangeText } from './trackedEdits';

export interface LocatedCommentAnchor {
  from: number;
  to: number;
}

/**
 * Locate a mark-less comment without trusting its frozen range blindly.
 * Prefer that range only while it still contains the exact anchor text;
 * otherwise accept one unique document-wide occurrence and reject ambiguity.
 */
export function locateDetachedCommentAnchor(
  doc: ProseMirrorNode,
  comment: Pick<Comment, 'anchorText' | 'from' | 'to'>,
): LocatedCommentAnchor | null {
  if (!comment.anchorText) return null;
  const size = doc.content.size;
  const from = Math.max(0, Math.min(comment.from, size));
  const to = Math.max(from, Math.min(comment.to, size));
  if (to > from && rangeText(doc, from, to) === comment.anchorText) return { from, to };

  const documentText = rangeText(doc, 0, size);
  const first = documentText.indexOf(comment.anchorText);
  if (first === -1 || documentText.indexOf(comment.anchorText, first + 1) !== -1) return null;
  return locateEdit(doc, 0, size, comment.anchorText);
}
