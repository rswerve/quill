import type { Editor } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export interface DocumentStats {
  words: number;
  chars: number;
  line: number;
  column: number;
  /**
   * Present only while a non-empty range is selected. `words` counts every word
   * the selection touches — a partially-selected word at either boundary still
   * counts as a whole one — while `chars` is the exact number of selected text
   * characters. Selecting the entire document yields `words`/`chars` equal to
   * the document totals.
   */
  selection?: { words: number; chars: number };
}

/**
 * Count whitespace-delimited words: each maximal run of non-whitespace is one
 * word. Applied to a selected substring this is exactly the selection rule we
 * want — a partial word at a boundary is still a non-whitespace run, so it
 * counts as one.
 */
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/**
 * Text used for word counting over a range. Block boundaries and inline leaves
 * become whitespace so that words on either side of a paragraph break stay
 * distinct — `textContent` (empty separator) would merge them into one word.
 */
function wordText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', ' ');
}

/**
 * Derive the footer's document statistics from the editor's current state.
 * Words and characters are counted by deliberately different rules: words split
 * on whitespace with block boundaries treated as separators (so paragraph-edge
 * words don't merge), while characters count only text characters with no
 * separators (a block boundary is not a character). Both rules apply equally to
 * the whole document and to a selection, so selecting everything reproduces the
 * totals. `selection` is populated only when a non-empty range is selected.
 */
export function computeDocumentStats(editor: Editor | null): DocumentStats {
  if (!editor) return { words: 0, chars: 0, line: 1, column: 1 };
  const { doc, selection } = editor.state;
  const { head, from, to, empty } = selection;
  const resolved = doc.resolve(head);
  let line = 0;
  doc.nodesBetween(0, head, (node) => {
    if (node.isTextblock) line += 1;
  });
  const stats: DocumentStats = {
    words: countWords(wordText(doc, 0, doc.content.size)),
    chars: doc.textContent.length,
    line: Math.max(1, line),
    column: resolved.parentOffset + 1,
  };
  if (!empty) {
    stats.selection = {
      words: countWords(wordText(doc, from, to)),
      // Precise: the exact number of selected text characters, no separators.
      chars: doc.textBetween(from, to, '').length,
    };
  }
  return stats;
}
