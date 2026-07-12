import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditScope, QuillEdit, QuillFormatEdit, QuillTextEdit } from '../types';

/**
 * Protocol style names → editor mark names, defining the v1 tracked-format
 * scope. Unknown keys in a format op are ignored (forward compatibility).
 */
const PROTOCOL_FORMAT_MARKS = {
  bold: 'bold',
  italic: 'italic',
  strikethrough: 'strike',
} as const;

export type FormatMarkName = (typeof PROTOCOL_FORMAT_MARKS)[keyof typeof PROTOCOL_FORMAT_MARKS];

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

/** A located edit ready to apply, sorted back-to-front for application. */
export type PlacedEdit =
  | { kind: 'text'; from: number; to: number; replace: string }
  | {
      kind: 'format';
      from: number;
      to: number;
      /** Style changes to apply over the range, in protocol order. */
      marks: Array<{ mark: FormatMarkName; set: boolean }>;
    };

/**
 * Pure planning step: turn quote-based edits into absolute-position edits,
 * sorted back-to-front so applying them in order keeps earlier positions
 * valid. Skipped (and reported) rather than guessed at: unlocatable finds,
 * text-identical replacements (a formatting ask must use a format op),
 * malformed entries (both/neither of replace and format, empty-find format,
 * no recognized styles), format ops overlapping a text replacement from the
 * same block (the replacement subsumes them), and — when `formatAuthor` is
 * given — format ops touching text that carries another author's pending
 * format suggestion (v1 cross-author policy: whole-op block, never partial).
 */
export function planEdits(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edits: QuillEdit[],
  formatAuthor?: string,
): { placed: PlacedEdit[]; skipped: number } {
  const texts: Array<Extract<PlacedEdit, { kind: 'text' }>> = [];
  const formats: Array<Extract<PlacedEdit, { kind: 'format' }>> = [];
  let skipped = 0;

  for (const edit of edits) {
    const replace = (edit as QuillTextEdit).replace;
    const format = (edit as QuillFormatEdit).format;
    const hasReplace = typeof replace === 'string';
    const hasFormat = typeof format === 'object' && format !== null;

    // XOR: an edit is a text replacement or a format op, never both/neither.
    if (hasReplace === hasFormat) {
      skipped++;
      continue;
    }

    if (hasFormat) {
      const marks: Array<{ mark: FormatMarkName; set: boolean }> = [];
      for (const [key, mark] of Object.entries(PROTOCOL_FORMAT_MARKS)) {
        const value = (format as Record<string, unknown>)[key];
        if (typeof value === 'boolean') marks.push({ mark, set: value });
      }
      if (!edit.find || marks.length === 0) {
        skipped++;
        continue;
      }
      const at = locateEdit(doc, rangeFrom, rangeTo, edit.find);
      if (!at || at.to <= at.from) {
        skipped++;
        continue;
      }
      formats.push({ kind: 'format', from: at.from, to: at.to, marks });
      continue;
    }

    // A text-identical replacement can only be a formatting-only ask, which
    // find/replace cannot express — the protocol's format ops can. Skip it so
    // the done-phase summary reports it honestly instead.
    if (edit.find === replace) {
      skipped++;
      continue;
    }
    const at = locateEdit(doc, rangeFrom, rangeTo, edit.find);
    if (!at) {
      skipped++;
      continue;
    }
    texts.push({ kind: 'text', from: at.from, to: at.to, replace });
  }

  const placed: PlacedEdit[] = [...texts];
  for (const f of formats) {
    if (texts.some((t) => f.from < t.to && t.from < f.to)) {
      // One reply proposed replacing this text AND reformatting it — the
      // replacement wins (it already carries the new content).
      skipped++;
      continue;
    }
    if (formatAuthor && rangeHasForeignPendingFormat(doc, f.from, f.to, formatAuthor)) {
      skipped++;
      continue;
    }
    placed.push(f);
  }

  placed.sort((a, b) => b.from - a.from);
  return { placed, skipped };
}

function rangeHasForeignPendingFormat(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  author: string,
): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found || !node.isText) return;
    found = node.marks.some(
      (m) =>
        m.type.name === 'tracked_format' &&
        m.attrs.dataTracked?.status === 'pending' &&
        m.attrs.dataTracked?.authorID !== author,
    );
  });
  return found;
}
