import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createDocument, type Editor as TiptapEditor } from '@tiptap/core';

/**
 * Parse markdown into a DETACHED document using `editor`'s schema and parse options —
 * the EXACT pipeline `setContent(md)` uses: tiptap-markdown renders md → HTML, then
 * tiptap's own `createDocument` builds the doc (not a bare DOMParser, which omits the
 * trailing filler paragraph `setContent` appends after a doc ending in a list/code
 * block). The result therefore equals the document a REOPEN of that markdown would
 * produce — what canonical-capture maps review anchors into — and never mutates the
 * live editor.
 */
export function parseMarkdownToDoc(editor: TiptapEditor, md: string): ProseMirrorNode {
  const html = (
    editor.storage as unknown as Record<string, { parser: { parse: (md: string) => string } }>
  )['markdown'].parser.parse(md);
  return createDocument(html, editor.schema, editor.options.parseOptions);
}
