import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditScope, QuillEdit, QuillFormatEdit, QuillTextEdit } from '../types';
import { normalizeHref } from './linkEditing';

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

/** Remove only LF characters from the end of a string in linear time. */
export function stripTrailingNewlines(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 10) end--;
  return value.slice(0, end);
}

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
    let leafText = '';
    if (!node.isText && node.isLeaf) leafText = ' ';
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
  | { kind: 'text'; from: number; to: number; replace: string; linkHref?: string }
  | {
      kind: 'format';
      from: number;
      to: number;
      /** Style changes to apply over the range, in protocol order. */
      marks: Array<{ mark: FormatMarkName; set: boolean }>;
    };

type PlacedTextEdit = Extract<PlacedEdit, { kind: 'text' }>;
type PlacedFormatEdit = Extract<PlacedEdit, { kind: 'format' }>;

export type EditResultStatus = 'applied' | 'not-found' | 'no-op' | 'conflict' | 'malformed';

export type EditResultReason =
  | 'text-not-found'
  | 'link-not-found'
  | 'link-target-mismatch'
  | 'ambiguous-link'
  | 'already-applied'
  | 'overlapping-edit'
  | 'pending-suggestion'
  | 'invalid-edit'
  | 'invalid-link'
  | 'document-unavailable';

/** A structured outcome for one model-proposed edit, in input order. */
export interface EditResult {
  edit: QuillEdit;
  status: EditResultStatus;
  reason?: EditResultReason;
}

interface PlanDecision {
  result: EditResult;
  placed?: PlacedEdit;
}

interface MarkdownLinkValue {
  label: string;
  href: string;
}

const completeMarkdownLink = /^\[([^\]\n]+)\]\(([^()\s]+)\)$/;

function parseMarkdownLink(value: string): MarkdownLinkValue | null {
  const match = completeMarkdownLink.exec(value);
  if (!match) return null;
  const href = normalizeHref(match[2]);
  return href ? { label: match[1], href } : null;
}

interface LinkSpan {
  from: number;
  to: number;
  href: string;
}

/** Contiguous visible text ranges carrying the same link mark. */
function linkSpans(doc: ProseMirrorNode, from: number, to: number): LinkSpan[] {
  const spans: LinkSpan[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => candidate.type.name === 'link');
    if (!mark) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
    const previous = spans.at(-1);
    if (previous && previous.to === start && previous.href === href) previous.to = end;
    else spans.push({ from: start, to: end, href });
  });
  return spans;
}

function result(edit: QuillEdit, status: EditResultStatus, reason?: EditResultReason): EditResult {
  return { edit, status, ...(reason ? { reason } : {}) };
}

function protocolFormatMarks(format: QuillFormatEdit['format']): PlacedFormatEdit['marks'] {
  const marks: PlacedFormatEdit['marks'] = [];
  for (const [key, mark] of Object.entries(PROTOCOL_FORMAT_MARKS)) {
    const value = (format as Record<string, unknown>)[key];
    if (typeof value === 'boolean') marks.push({ mark, set: value });
  }
  return marks;
}

function planFormatEdit(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edit: QuillFormatEdit,
  format: QuillFormatEdit['format'],
): PlanDecision {
  const { find } = edit;
  const marks = protocolFormatMarks(format);
  if (!find || marks.length === 0) {
    return { result: result(edit, 'malformed', 'invalid-edit') };
  }
  const at = locateEdit(doc, rangeFrom, rangeTo, find);
  if (!at || at.to <= at.from) {
    return { result: result(edit, 'not-found', 'text-not-found') };
  }
  if (!formatOpChangesState(doc, at.from, at.to, marks)) {
    return { result: result(edit, 'no-op', 'already-applied') };
  }
  return {
    result: result(edit, 'applied'),
    placed: { kind: 'format', from: at.from, to: at.to, marks },
  };
}

function planMarkdownLinkFallback(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edit: QuillTextEdit,
): PlanDecision | null {
  const source = parseMarkdownLink(edit.find);
  if (!source) return null;

  const matches = linkSpans(doc, rangeFrom, rangeTo).filter(
    (span) => rangeText(doc, span.from, span.to) === source.label,
  );
  if (matches.length === 0) {
    return { result: result(edit, 'not-found', 'link-not-found') };
  }
  if (matches.length > 1) {
    return { result: result(edit, 'conflict', 'ambiguous-link') };
  }

  const [match] = matches;
  if (normalizeHref(match.href) !== source.href) {
    return { result: result(edit, 'not-found', 'link-target-mismatch') };
  }

  const replacementLink = parseMarkdownLink(edit.replace);
  const replaceLooksLikeLink = edit.replace.startsWith('[') && edit.replace.includes('](');
  if (replaceLooksLikeLink && !replacementLink) {
    return { result: result(edit, 'malformed', 'invalid-link') };
  }
  const replace = replacementLink?.label ?? edit.replace;
  const linkHref = replacementLink?.href ?? source.href;
  if (replace === source.label && linkHref === source.href) {
    return { result: result(edit, 'no-op', 'already-applied') };
  }
  return {
    result: result(edit, 'applied'),
    placed: { kind: 'text', from: match.from, to: match.to, replace, linkHref },
  };
}

function planTextEdit(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edit: QuillTextEdit,
): PlanDecision {
  const { find, replace } = edit;
  // A text-identical replacement can only be a formatting-only ask, which
  // find/replace cannot express — the protocol's format ops can.
  if (find === replace) return { result: result(edit, 'no-op', 'already-applied') };
  const at = locateEdit(doc, rangeFrom, rangeTo, find);
  if (at) {
    return {
      result: result(edit, 'applied'),
      placed: { kind: 'text', from: at.from, to: at.to, replace },
    };
  }
  return (
    planMarkdownLinkFallback(doc, rangeFrom, rangeTo, edit) ?? {
      result: result(edit, 'not-found', 'text-not-found'),
    }
  );
}

function planEdit(
  doc: ProseMirrorNode,
  rangeFrom: number,
  rangeTo: number,
  edit: QuillEdit,
): PlanDecision {
  // Model JSON is untrusted despite its static type: reject malformed entries
  // instead of throwing part-way through an apply.
  if (typeof edit !== 'object' || edit === null || typeof edit.find !== 'string') {
    return { result: result(edit, 'malformed', 'invalid-edit') };
  }

  const replace = (edit as QuillTextEdit).replace;
  const format = (edit as QuillFormatEdit).format;
  const hasReplace = typeof replace === 'string';
  const hasFormat = typeof format === 'object' && format !== null && !Array.isArray(format);
  // XOR: an edit is a text replacement or a format op, never both/neither.
  if (hasReplace === hasFormat) {
    return { result: result(edit, 'malformed', 'invalid-edit') };
  }

  return hasFormat
    ? planFormatEdit(doc, rangeFrom, rangeTo, edit as QuillFormatEdit, format)
    : planTextEdit(doc, rangeFrom, rangeTo, edit as QuillTextEdit);
}

function formatConflictReason(
  doc: ProseMirrorNode,
  format: PlacedFormatEdit,
  texts: PlacedTextEdit[],
  formatAuthor?: string,
): EditResultReason | null {
  const overlapsText = texts.some((text) => format.from < text.to && text.from < format.to);
  if (overlapsText) return 'overlapping-edit';
  return formatAuthor && rangeHasForeignPendingFormat(doc, format.from, format.to, formatAuthor)
    ? 'pending-suggestion'
    : null;
}

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
): { placed: PlacedEdit[]; results: EditResult[] } {
  const results: EditResult[] = [];
  const texts: Array<{ editIndex: number; placed: PlacedTextEdit }> = [];
  const formats: Array<{ editIndex: number; placed: PlacedFormatEdit }> = [];

  for (const edit of edits) {
    const decision = planEdit(doc, rangeFrom, rangeTo, edit);
    const editIndex = results.push(decision.result) - 1;
    if (decision.placed?.kind === 'text') texts.push({ editIndex, placed: decision.placed });
    if (decision.placed?.kind === 'format') formats.push({ editIndex, placed: decision.placed });
  }

  const placed: PlacedEdit[] = texts.map((candidate) => candidate.placed);
  const textEdits = texts.map((candidate) => candidate.placed);
  for (const candidate of formats) {
    const reason = formatConflictReason(doc, candidate.placed, textEdits, formatAuthor);
    if (reason) {
      results[candidate.editIndex] = result(edits[candidate.editIndex], 'conflict', reason);
    } else {
      placed.push(candidate.placed);
    }
  }

  placed.sort((a, b) => b.from - a.from);
  return { placed, results };
}

function editFindLabel(edit: QuillEdit): string {
  if (typeof edit !== 'object' || edit === null || typeof edit.find !== 'string') {
    return '(invalid edit)';
  }
  const compact = edit.find.replace(/\s+/g, ' ').trim();
  const limit = 58;
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function editResultReason(result: EditResult): string {
  switch (result.reason) {
    case 'ambiguous-link':
      return 'more than one link has that label.';
    case 'link-not-found':
      return 'no link has that visible text.';
    case 'link-target-mismatch':
      return 'the link text exists, but its destination does not match.';
    case 'already-applied':
      return 'it already matches the proposal.';
    case 'overlapping-edit':
      return 'it overlaps another proposed text change.';
    case 'pending-suggestion':
      return 'it conflicts with a pending suggestion.';
    case 'invalid-edit':
      return 'the edit instruction is malformed.';
    case 'invalid-link':
      return 'the replacement link is malformed or unsafe.';
    case 'document-unavailable':
      return 'the document was not ready.';
    default:
      return 'text wasn’t found.';
  }
}

/** Human-readable, bounded details for model edits that were not applied. */
export function formatEditResultNotice(results: EditResult[]): string {
  const skipped = results.filter((candidate) => candidate.status !== 'applied');
  if (skipped.length === 0) return '';
  const heading =
    skipped.length === 1 ? '1 change was skipped:' : `${skipped.length} changes were skipped:`;
  const lines = skipped.map(
    (candidate) => `• “${editFindLabel(candidate.edit)}” — ${editResultReason(candidate)}`,
  );
  return `(${heading}\n${lines.join('\n')})`;
}

/** Whether applying `marks` over the range would change any text node's state. */
function formatOpChangesState(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  marks: Array<{ mark: FormatMarkName; set: boolean }>,
): boolean {
  let changes = false;
  doc.nodesBetween(from, to, (node) => {
    if (changes || !node.isText) return;
    changes = marks.some(({ mark, set }) => {
      const has = node.marks.some((m) => m.type.name === mark);
      return set ? !has : has;
    });
  });
  return changes;
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
