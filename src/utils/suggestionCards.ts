import type {
  LegacyTrackedChangeInfo,
  LegacyTrackedFormatChange,
  LegacyTrackedTextChange,
  TrackedChangeInfo,
  TrackedFormatSegment,
  TrackedTextSegment,
} from '../types';

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

/** Slice-1 card projection retained as the equivalence oracle. */
export type LegacySuggestionCardGroup =
  | { kind: 'single'; cardId: string; change: LegacyTrackedTextChange }
  | {
      kind: 'replacement';
      cardId: string;
      del: LegacyTrackedTextChange;
      ins: LegacyTrackedTextChange;
    }
  | { kind: 'format'; cardId: string; change: LegacyTrackedFormatChange };

export function groupLegacySuggestionCards(
  changes: LegacyTrackedChangeInfo[],
): LegacySuggestionCardGroup[] {
  const groups: LegacySuggestionCardGroup[] = [];
  const byPair = new Map<string, LegacyTrackedTextChange[]>();
  for (const change of changes) {
    if (change.operation === 'format') {
      groups.push({ kind: 'format', cardId: change.id, change });
    } else if (change.pairId) {
      const members = byPair.get(change.pairId) ?? [];
      members.push(change);
      byPair.set(change.pairId, members);
    } else groups.push({ kind: 'single', cardId: change.id, change });
  }
  for (const members of byPair.values()) {
    const deletion = members.find((change) => change.operation === 'delete');
    const insertion = members.find((change) => change.operation === 'insert');
    if (deletion && insertion && members.length === 2) {
      groups.push({
        kind: 'replacement',
        cardId: deletion.pairId!,
        del: deletion,
        ins: insertion,
      });
    } else {
      for (const change of members) {
        groups.push({ kind: 'single', cardId: change.id, change });
      }
    }
  }
  return groups;
}
