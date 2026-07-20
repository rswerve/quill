import type { Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';

/**
 * The review-mark axis of a canonical document.
 *
 * A saved Quill document is two layered projections of the same content: the
 * canonical SOURCE (the Markdown on disk) and the review UNION that rides marks on
 * top of it. Telling those apart — which marks the Markdown owns vs. which are the
 * independently-persisted review axis — is a decision made identically in save,
 * reload, structural rebase, skeleton comparison, and anchor mapping. This module
 * is the single home for that decision so the answer can never drift between
 * callers; adding a new trackable mark is a one-line change every consumer inherits.
 */

/**
 * The inline marks that ride ON TOP of the canonical source and are persisted
 * independently of the Markdown: tracked insert/delete/format + comment anchors.
 */
export const REVIEW_MARK_NAMES: readonly string[] = [
  'tracked_insert',
  'tracked_delete',
  'tracked_format',
  'comment',
];

const REVIEW_MARK_NAME_SET: ReadonlySet<string> = new Set(REVIEW_MARK_NAMES);

/** True when a mark type name belongs to the independently-persisted review axis. */
export function isReviewMarkName(name: string): boolean {
  return REVIEW_MARK_NAME_SET.has(name);
}

/** A copy of `doc` with every review-axis mark removed; content and structure intact. */
export function stripReviewMarks(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  for (const name of REVIEW_MARK_NAMES) {
    const markType = doc.type.schema.marks[name];
    if (markType) tr.removeMark(0, tr.doc.content.size, markType);
  }
  return tr.doc;
}

/**
 * Exact structural/content parity after removing the independently-persisted
 * review marks. Structural reconstruction restores blocks and their `blockTrack`
 * branch flags but not inline tracked/comment marks (those are Markdown-dropped
 * and restored on top), so `Node.eq` AFTER stripping those marks is the right
 * "same structural arrangement" test.
 */
export function structuralSkeletonEq(a: PMNode, b: PMNode): boolean {
  return stripReviewMarks(a).eq(stripReviewMarks(b));
}
