import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Comment, LogicalSuggestion, TrackedChangeSegment } from '../types';
import { buildEditTextProjection } from './editTextProjection';
import { rangeText } from './trackedEdits';

/**
 * Conservative LOAD-SIDE relocation ("unbound" mode) for review anchors whose stored
 * coordinates are only hints — a legacy sidecar/draft, or a `.md` edited outside Quill
 * (detected by a review-source-hash mismatch). The stored position is NEVER trusted
 * here, not even when its text happens to match, because a whitespace collapse can slide
 * a saved range exactly onto a different occurrence of the same text (`x··aa` → `x·aa`
 * lands "a" on the second one). Instead we enumerate the document GLOBALLY and relocate
 * only when the anchor's text lands unambiguously.
 *
 * Data-integrity contract (a safe visible failure beats a plausible wrong anchor):
 *  - A logical suggestion relocates ALL-OR-NOTHING: its whole span must match, exactly
 *    once, entirely as ordinary text. Any ambiguity, absence, non-contiguity, or a span
 *    that touches a non-text leaf (a hard break, image, block boundary) → quarantine.
 *  - Search uses the LEGACY plaintext projection, which renders a hard break as a space
 *    just as legacy segments were captured — so a surviving break location is VISIBLE to
 *    the search and forces the leaf-touching / ambiguous quarantine rather than being
 *    silently skipped and letting a coincidental plain-text occurrence win.
 *  - A comment relocates only to a globally-unique occurrence of its anchor text.
 */

export type SuggestionRelocation =
  | { status: 'relocated'; suggestion: LogicalSuggestion }
  | {
      status: 'quarantined';
      reason:
        | 'non-contiguous'
        | 'leaf-segment'
        | 'format-unsupported'
        | 'not-found'
        | 'ambiguous'
        | 'leaf-span'
        | 'mark-ineligible'
        | 'invalid';
    };

/** Sort a suggestion's segments by position without mutating the record. */
function sortedSegments(suggestion: LogicalSuggestion): TrackedChangeSegment[] {
  return [...suggestion.segments].sort((a, b) => a.from - b.from);
}

/**
 * The suggestion's full contiguous span as ordinary text, plus its saved start.
 * Refuses (returns a reason) a suggestion that carries an explicit leaf segment or
 * whose segments are not adjacent — neither can be reconstructed as a plain substring.
 */
function reconstructSpan(
  suggestion: LogicalSuggestion,
):
  | { text: string; from: number }
  | { reason: 'non-contiguous' | 'leaf-segment' | 'format-unsupported' } {
  const segments = sortedSegments(suggestion);
  if (segments.length === 0) return { reason: 'non-contiguous' };
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    // A format suggestion's meaning is its net mark delta relative to the target's
    // CURRENT marks, which text alone can't verify — relocating it by text could bind
    // onto differently-formatted text, so Reject would invert the delta and MUTATE
    // externally-changed formatting. Refuse (quarantine) until mark-context validation.
    if (segment.kind === 'format') return { reason: 'format-unsupported' };
    // An explicitly identified leaf (hard break) cannot be relocated by text in v1.
    if (segment.nodeType) return { reason: 'leaf-segment' };
    if (i > 0 && segments[i - 1].to !== segment.from) return { reason: 'non-contiguous' };
  }
  return { text: segments.map((segment) => segment.text).join(''), from: segments[0].from };
}

/** Every plaintext index where `needle` occurs in `haystack` (overlapping-safe start step). */
function allIndexesOf(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    out.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return out;
}

/** Shift every segment of a suggestion by a uniform delta, preserving all other fields. */
function shiftSuggestion(suggestion: LogicalSuggestion, delta: number): LogicalSuggestion {
  return {
    ...suggestion,
    segments: suggestion.segments.map((segment) => ({
      ...segment,
      from: segment.from + delta,
      to: segment.to + delta,
    })),
  };
}

/** After relocation, every segment's plaintext must still equal its recorded text. */
function segmentsValid(doc: ProseMirrorNode, suggestion: LogicalSuggestion): boolean {
  const size = doc.content.size;
  return suggestion.segments.every((segment) => {
    if (segment.from < 0 || segment.to > size || segment.to <= segment.from) return false;
    return rangeText(doc, segment.from, segment.to) === segment.text;
  });
}

const SEGMENT_MARK: Record<string, string> = {
  insert: 'tracked_insert',
  delete: 'tracked_delete',
  format: 'tracked_format',
};

/**
 * Whether every textblock covering [from, to] admits `markName`. Plain text is not
 * enough: code-block content is `text`-sourced but rejects tracked/comment marks, so a
 * unique match INSIDE a code block would "relocate" yet `addMark` there is a silent
 * no-op — a record with no live mark. Fail closed on any ineligible parent or a mark
 * type the schema lacks. (A suggestion span is intra-block, but nodesBetween covers the
 * general case.)
 */
export function spanAdmitsMark(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  markName: string,
): boolean {
  const markType = doc.type.schema.marks[markName];
  if (!markType) return false;
  let ok = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock && !node.type.allowsMarkType(markType)) ok = false;
    return ok;
  });
  return ok;
}

/**
 * Whether every segment of a suggestion sits where its tracking mark can live — the
 * eligibility preflight the unbound matcher already runs, exposed so the BOUND restore
 * can apply it too (otherwise a stored position in a code block would `addMark` into a
 * silent no-op yet be classified as restored).
 */
export function suggestionMarksAdmissible(
  doc: ProseMirrorNode,
  suggestion: LogicalSuggestion,
): boolean {
  return suggestion.segments.every((segment) =>
    spanAdmitsMark(doc, segment.from, segment.to, SEGMENT_MARK[segment.kind]),
  );
}

export function relocateSuggestion(
  doc: ProseMirrorNode,
  suggestion: LogicalSuggestion,
): SuggestionRelocation {
  const span = reconstructSpan(suggestion);
  if ('reason' in span) return { status: 'quarantined', reason: span.reason };

  // Legacy projection: a hard break reads as a space (as legacy segments were captured),
  // so a surviving break location is a visible match and cannot be silently bypassed.
  const projection = buildEditTextProjection(doc, 0, doc.content.size, 'legacy');
  const matches = allIndexesOf(projection.text, span.text);
  if (matches.length === 0) return { status: 'quarantined', reason: 'not-found' };
  if (matches.length > 1) return { status: 'quarantined', reason: 'ambiguous' };

  const start = matches[0];
  for (let k = 0; k < span.text.length; k += 1) {
    if (projection.sources[start + k] !== 'text')
      return { status: 'quarantined', reason: 'leaf-span' };
  }

  const newFrom = projection.positions[start];
  if (newFrom === undefined) return { status: 'quarantined', reason: 'invalid' };
  const relocated = shiftSuggestion(suggestion, newFrom - span.from);
  if (!segmentsValid(doc, relocated)) return { status: 'quarantined', reason: 'invalid' };

  // A text-only match can still land where its tracking mark cannot live (a code
  // block). Restoring there would addMark into a no-op — a record with no live mark.
  for (const segment of relocated.segments) {
    if (!spanAdmitsMark(doc, segment.from, segment.to, SEGMENT_MARK[segment.kind])) {
      return { status: 'quarantined', reason: 'mark-ineligible' };
    }
  }
  return { status: 'relocated', suggestion: relocated };
}

/**
 * Relocate a detached comment to a GLOBALLY-UNIQUE occurrence of its anchor text.
 * Unlike the bound-mode `locateDetachedCommentAnchor`, this never trusts the stored
 * range even when its text matches — that "fast path" is exactly what binds a drifted
 * range onto the wrong repeated occurrence. Returns null on absence or ambiguity.
 */
export function relocateComment(
  doc: ProseMirrorNode,
  comment: Pick<Comment, 'anchorText'>,
): { from: number; to: number } | null {
  if (!comment.anchorText) return null;
  const projection = buildEditTextProjection(doc, 0, doc.content.size, 'legacy');
  const matches = allIndexesOf(projection.text, comment.anchorText);
  if (matches.length !== 1) return null;
  const start = matches[0];
  // Same leaf-provenance gate as suggestions: a unique legacy-projection match on a
  // span touching a hard break (or other non-text leaf) must not bind — the highlight
  // would land across a break the stored anchor text can't have described.
  for (let k = 0; k < comment.anchorText.length; k += 1) {
    if (projection.sources[start + k] !== 'text') return null;
  }
  const from = projection.positions[start];
  const to = projection.positions[start + comment.anchorText.length];
  if (from === undefined || to === undefined) return null;
  // The comment mark must be admissible where it would land (not a code block).
  if (!spanAdmitsMark(doc, from, to, 'comment')) return null;
  return { from, to };
}
