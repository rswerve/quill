import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createDocument, type Editor as TiptapEditor } from '@tiptap/core';

/**
 * Parse markdown into a DETACHED document using `editor`'s schema and parse options —
 * the EXACT pipeline `setContent(md)` uses: tiptap-markdown renders md → HTML, then
 * tiptap's own `createDocument` builds the doc (not a bare DOMParser, which parses HTML
 * subtly differently). `setContent` runs `createDocument` and then replaces the document;
 * the only thing it adds afterward is a trailing filler paragraph — and Quill disables
 * that plugin (`StarterKit.configure({ trailingNode: false })`), so under the production
 * schema this equals a reopen EXACTLY. The result is what canonical-capture maps review
 * anchors into, and this never mutates the live editor.
 */
export function parseMarkdownToDoc(editor: TiptapEditor, md: string): ProseMirrorNode {
  const html = (
    editor.storage as unknown as Record<string, { parser: { parse: (md: string) => string } }>
  )['markdown'].parser.parse(md);
  return createDocument(html, editor.schema, editor.options.parseOptions);
}
