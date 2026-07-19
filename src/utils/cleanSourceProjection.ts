import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';
import { projectDocument } from './blockUnionProjection';

/**
 * The clean ORIGINAL document as Markdown: block-union structural changes
 * collapsed to their source branch and pending inline changes rejected
 * (insertions dropped, deletions kept, formatting inverted), then serialized.
 *
 * This is the "pending suggestions ignored" view that export, copy, and the
 * Claude document all present — accepted changes are already committed text;
 * un-accepted ones vanish. `serialize` is the caller's Markdown serializer over a
 * DETACHED document (it never touches the live editor).
 */
export function cleanSourceMarkdown(doc: PMNode, serialize: (doc: PMNode) => string): string {
  return serialize(projectDocument(doc, { structural: 'source', inline: 'source' }).doc);
}

/**
 * The clean ORIGINAL document as an HTML string — the same
 * {structural:'source', inline:'source'} projection as {@link cleanSourceMarkdown}
 * (block unions collapsed to their source branch; pending insertions dropped,
 * deletions kept, formatting inverted), serialized to HTML with ProseMirror's
 * DOMSerializer over a DETACHED document. This is what the print / Export-to-PDF
 * pipeline renders, so the printed artifact ignores every un-accepted suggestion.
 * The projected doc carries no tracking marks, so the output has no redline
 * markup at all — no CSS masking of the live editor is involved. Requires a DOM
 * (`document`); callers outside a browser / jsdom must not invoke it.
 */
export function cleanSourceHTML(doc: PMNode): string {
  const clean = projectDocument(doc, { structural: 'source', inline: 'source' }).doc;
  const serializer = DOMSerializer.fromSchema(clean.type.schema);
  const container = document.createElement('div');
  container.appendChild(serializer.serializeFragment(clean.content));
  return container.innerHTML;
}
