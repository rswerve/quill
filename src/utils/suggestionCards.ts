import type {
  StructuralChangeInfo,
  TrackedChangeInfo,
  TrackedFormatSegment,
  TrackedTextSegment,
} from '../types';

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

/**
 * One INLINE review-panel card — the exact return type of `groupSuggestionCards`.
 * Deliberately not widened with a structural variant: `CommentLayer` derives its
 * type from this function and assumes every non-replacement/non-format group has
 * inline `.segments`. Structural cards are the separate
 * {@link StructuralSuggestionCardGroup}; an umbrella `ReviewCardGroup` is
 * introduced only in the production wiring (3b).
 */
export type InlineSuggestionCardGroup =
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

/** One structural (block-union) review-panel card, keyed by its change id. */
export interface StructuralSuggestionCardGroup {
  kind: 'structural';
  cardId: string;
  change: StructuralChangeInfo;
}

/** The umbrella the review panel renders: an inline card group or a structural one. */
export type ReviewCardGroup = InlineSuggestionCardGroup | StructuralSuggestionCardGroup;

/** Build the structural card groups from enumerated structural changes (already ordered). */
export function structuralCardGroups(
  changes: StructuralChangeInfo[],
): StructuralSuggestionCardGroup[] {
  return changes.map((change) => ({ kind: 'structural', cardId: change.changeId, change }));
}

export function groupSuggestionCards(changes: TrackedChangeInfo[]): InlineSuggestionCardGroup[] {
  return changes.flatMap((change): InlineSuggestionCardGroup[] => {
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
