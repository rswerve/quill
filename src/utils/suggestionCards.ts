import type { TrackedChangeInfo, TrackedFormatSegment, TrackedTextSegment } from '../types';

/** Visible glyph for a hard break in a review-card preview. */
export const LINE_BREAK_GLYPH = '↵';

/**
 * Display text for a review-card preview. A hard-break segment renders as the
 * ↵ glyph so it never previews as a blank or a raw newline. Contiguous
 * segments join seamlessly — a text–break–text run reads "one↵two" — while a
 * genuine gap keeps the ellipsis separator. A break-only preview (no visible
 * text) would otherwise be a bare symbol, so it gets the spelled-out
 * "↵ line break" label for clarity and screen readers.
 */
export function segmentsToPreview(segments: TrackedTextSegment[]): string {
  let preview = '';
  let hasText = false;
  segments.forEach((segment, index) => {
    if (index > 0) {
      const previous = segments[index - 1];
      preview += previous.to === segment.from ? '' : ' … ';
    }
    if (segment.nodeType === 'hardBreak') {
      preview += LINE_BREAK_GLYPH;
    } else {
      preview += segment.text;
      hasText = true;
    }
  });
  if (!hasText && preview.length > 0) preview += ' line break';
  return preview;
}

/** One review-panel card. Canonical changes no longer need a grouping pass. */
export type SuggestionCardGroup =
  | {
      kind: 'single';
      cardId: string;
      change: TrackedChangeInfo;
      operation: 'insert' | 'delete';
      segments: TrackedTextSegment[];
    }
  | {
      kind: 'replacement';
      cardId: string;
      change: TrackedChangeInfo;
      deletions: TrackedTextSegment[];
      insertions: TrackedTextSegment[];
    }
  | {
      kind: 'format';
      cardId: string;
      change: TrackedChangeInfo;
      segments: TrackedFormatSegment[];
    };

export function groupSuggestionCards(changes: TrackedChangeInfo[]): SuggestionCardGroup[] {
  return changes.flatMap((change): SuggestionCardGroup[] => {
    const insertions = change.segments.filter(
      (segment): segment is TrackedTextSegment => segment.kind === 'insert',
    );
    const deletions = change.segments.filter(
      (segment): segment is TrackedTextSegment => segment.kind === 'delete',
    );
    const formats = change.segments.filter(
      (segment): segment is TrackedFormatSegment => segment.kind === 'format',
    );
    if (formats.length > 0 && insertions.length === 0 && deletions.length === 0) {
      return [{ kind: 'format', cardId: change.id, change, segments: formats }];
    }
    if (insertions.length > 0 && deletions.length > 0) {
      return [
        {
          kind: 'replacement',
          cardId: change.id,
          change,
          deletions,
          insertions,
        },
      ];
    }
    const segments = insertions.length > 0 ? insertions : deletions;
    if (segments.length === 0) return [];
    return [
      {
        kind: 'single',
        cardId: change.id,
        change,
        operation: insertions.length > 0 ? 'insert' : 'delete',
        segments,
      },
    ];
  });
}

export function countLogicalSuggestionCards(changes: TrackedChangeInfo[]): number {
  return groupSuggestionCards(changes).length;
}

export function countLinkedSuggestionCards(
  changes: TrackedChangeInfo[],
  suggestionIds: string[],
): number {
  const linkedIds = new Set(suggestionIds);
  return countLogicalSuggestionCards(changes.filter((change) => linkedIds.has(change.id)));
}
