import type { Node as PMNode } from '@tiptap/pm/model';
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
