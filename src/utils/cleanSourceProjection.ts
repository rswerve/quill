import { DOMSerializer, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { getTextBetween, getTextSerializersFromSchema } from '@tiptap/core';
import { projectDocument, type BlockUnionProjection } from './blockUnionProjection';
import { stripReviewMarks } from './canonicalDocument';

/**
 * The clean ORIGINAL document as a ProseMirror node: block-union structural
 * changes collapsed to their source branch, pending inline changes rejected
 * (insertions dropped, deletions kept, formatting inverted), AND the review-mark
 * axis stripped — comment anchors plus any residual tracked marks — so NOTHING on
 * the review layer (redline OR comment highlight) survives into what export,
 * copy, and the Claude document present.
 *
 * Mark removal is position-neutral, so the projection's `mapping` and
 * `removedBranchRanges` stay valid over the stripped doc — copy relies on that
 * mapping to translate a live selection into source coordinates. This is the one
 * shared projection all three consumers (Markdown, HTML, clipboard) build on.
 */
export function projectCleanSourceDocument(doc: PMNode): BlockUnionProjection {
  const projected = projectDocument(doc, { structural: 'source', inline: 'source' });
  return { ...projected, doc: stripReviewMarks(projected.doc) };
}

/**
 * The clean ORIGINAL document as Markdown — {@link projectCleanSourceDocument}
 * serialized by the caller's Markdown serializer over a DETACHED document (it
 * never touches the live editor). This is the "pending suggestions ignored" view
 * that export, copy, and the Claude document all present: accepted changes are
 * already committed text; un-accepted ones vanish. (Comment marks are Markdown-
 * dropped anyway, so stripping them leaves the Markdown output unchanged.)
 */
export function cleanSourceMarkdown(doc: PMNode, serialize: (doc: PMNode) => string): string {
  return serialize(projectCleanSourceDocument(doc).doc);
}

/**
 * The clean ORIGINAL document as an HTML string — {@link projectCleanSourceDocument}
 * serialized to HTML with ProseMirror's DOMSerializer over a DETACHED document.
 * This is what the print / Export-to-PDF pipeline renders, so the printed artifact
 * ignores every un-accepted suggestion AND carries no review-layer markup at all:
 * no redline elements/classes and no comment-mark highlights (comments are
 * annotations, not content). Requires a DOM (`document`); callers outside a
 * browser / jsdom must not invoke it.
 */
export function cleanSourceHTML(doc: PMNode): string {
  const clean = projectCleanSourceDocument(doc).doc;
  const serializer = DOMSerializer.fromSchema(clean.type.schema);
  const container = document.createElement('div');
  container.appendChild(serializer.serializeFragment(clean.content));
  return container.innerHTML;
}

/**
 * The clean-source clipboard payload for a live selection [from, to): the HTML
 * slice AND the plain text, both from the pending-ignored projection rather than
 * the live redline. Returns:
 *   - null when the selection is empty — nothing to copy; let the default run;
 *   - `{ slice: Slice.empty, text: '' }` when a NONEMPTY selection is entirely
 *     hidden pending content (maps to a collapsed source range) — copy nothing;
 *   - otherwise the {@link projectCleanSourceDocument} slice + text over the mapped
 *     source range, so a selection spanning hidden content yields only its
 *     source-visible part, a retained deletion yields its original text without
 *     tracking, a pending format yields the original formatting, a structural
 *     union yields its source branch, and comment anchors never come along.
 * The from+1 / to-1 associations pin the range to visible content at the edges.
 *
 * Plain text uses Tiptap's `getTextBetween` + `getTextSerializersFromSchema` over
 * the CLEAN projected range — NOT `slice.content.textBetween`, which drops node
 * `renderText` serializers (HardBreak's newline, future inline atoms). This is
 * exactly the path Tiptap core's ClipboardTextSerializer takes, except its
 * coordinate source is the LIVE selection (the leak); ours is the clean
 * projection, so rendered-text semantics survive without reintroducing hidden
 * content.
 */
export function cleanSourceClipboard(
  doc: PMNode,
  from: number,
  to: number,
): { slice: Slice; text: string } | null {
  if (from >= to) return null;
  const projection = projectCleanSourceDocument(doc);
  const sourceFrom = projection.mapping.map(from, 1);
  const sourceTo = projection.mapping.map(to, -1);
  if (sourceFrom >= sourceTo) return { slice: Slice.empty, text: '' };
  const slice = projection.doc.slice(sourceFrom, sourceTo);
  const text = getTextBetween(
    projection.doc,
    { from: sourceFrom, to: sourceTo },
    {
      blockSeparator: '\n\n',
      textSerializers: getTextSerializersFromSchema(projection.doc.type.schema),
    },
  );
  return { slice, text };
}
