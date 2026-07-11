import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditScope, QuillEdit } from '../types';

/**
 * Read the plain text of a document range the same way Claude was shown it.
 * We pass '\n' as the block separator and ' ' as the leaf separator so list
 * items and paragraphs become newline-separated plaintext (no markdown syntax)
 * — matching what `getRangeTexts` sends in the prompt and what Claude's `find`
 * strings are expected to match.
 */
export function rangeText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', ' ');
}

/**
 * Map an offset into `rangeText(doc, from, to)` back to an absolute ProseMirror
 * position. Because `textBetween` injects separator characters at node
 * boundaries that don't correspond to a single document position, we rebuild
 * the same string while tracking, for each emitted character, the doc position
 * it should map to. Returns the absolute position, or null if `offset` is out
 * of bounds.
 *
 * The mapping array has length (text.length + 1): index i is the position just
 * before the i-th emitted character, and the final entry is the boundary just
 * after the last emitted character (so a match ending at the end of the text
 * never swallows trailing block-close tokens).
 */
export function mapRangeTextOffsetToPos(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  offset: number,
): number | null {
  // This must emit exactly one map entry per character of
  // doc.textBetween(from, to, '\n', ' ') — same order, same count — or every
  // offset after the first divergence maps to the wrong position. textBetween's
  // actual rules (prosemirror-model Fragment.textBetween): a '\n' separator is
  // emitted on entering every textblock after the first (including EMPTY
  // textblocks) and before a block-level leaf that renders leaf text; a ' ' is
  // emitted for every leaf node given the leafText argument; text nodes emit
  // their (range-clamped) characters. Nothing is emitted at mark boundaries:
  // adjacent text runs in one block are contiguous in the string.
  const map: number[] = [];
  let first = true;
  // Boundary just after the most recently emitted character. Separators are
  // anchored here: they have no width in the document.
  let lastEnd = from;

  doc.nodesBetween(from, to, (node, pos) => {
    const leafText = node.isText ? '' : node.isLeaf ? ' ' : '';
    if (node.isBlock && ((node.isLeaf && leafText) || node.isTextblock)) {
      if (first) {
        first = false;
      } else {
        map.push(lastEnd);
      }
    }
    if (node.isText) {
      const start = Math.max(pos, from);
      const end = Math.min(pos + node.nodeSize, to);
      for (let p = start; p < end; p++) {
        map.push(p);
      }
      if (end > start) lastEnd = end;
    } else if (node.isLeaf && leafText) {
      map.push(Math.max(pos, from));
      lastEnd = Math.min(pos + node.nodeSize, to);
    }
  });

  // Final boundary: just after the last emitted character.
  map.push(lastEnd);

  if (offset < 0 || offset >= map.length) return null;
  return map[offset];
}

/**
 * Given a target range and a `find` string, locate the first occurrence within
 * the range's plaintext and return its absolute from/to document positions.
 * Returns null when `find` is not present verbatim.
 */
export function locateEdit(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  find: string,
): { from: number; to: number } | null {
  const text = rangeText(doc, rangeFrom, rangeTo);
  const idx = text.indexOf(find);
  if (idx === -1) return null;
  const absFrom = mapRangeTextOffsetToPos(doc, rangeFrom, rangeTo, idx);
  const absTo = mapRangeTextOffsetToPos(doc, rangeFrom, rangeTo, idx + find.length);
  if (absFrom === null || absTo === null) return null;
  return { from: absFrom, to: absTo };
}

/** Resolve the absolute from/to bounds for an edit scope around a comment. */
export function resolveScopeRange(
  doc: ProseMirrorNode,
  comment: { from: number; to: number },
  scope: EditScope,
): { from: number; to: number } {
  if (scope === 'doc') return { from: 0, to: doc.content.size };
  if (scope === 'paragraph') {
    const $from = doc.resolve(Math.min(comment.from, doc.content.size));
    return { from: $from.start($from.depth), to: $from.end($from.depth) };
  }
  return { from: comment.from, to: comment.to };
}

/** A located edit ready to apply, in document order. */
export interface PlacedEdit {
  from: number;
  to: number;
  replace: string;
}

/**
 * Pure planning step: turn quote-based edits into absolute-position edits,
 * sorted back-to-front so applying them in order keeps earlier positions valid.
 * Edits whose `find` can't be located are reported via `skipped`.
 */
export function planEdits(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edits: QuillEdit[],
): { placed: PlacedEdit[]; skipped: number } {
  const placed: PlacedEdit[] = [];
  let skipped = 0;
  for (const edit of edits) {
    const at = locateEdit(doc, rangeFrom, rangeTo, edit.find);
    if (!at) {
      skipped++;
      continue;
    }
    placed.push({ from: at.from, to: at.to, replace: edit.replace });
  }
  placed.sort((a, b) => b.from - a.from);
  return { placed, skipped };
}
