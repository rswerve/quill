import type { TrackedChangeInfo, TrackedFormatChange, TrackedTextChange } from '../types';

/** One review-panel card's worth of pending tracked changes. */
export type SuggestionCardGroup =
  | { kind: 'single'; cardId: string; change: TrackedTextChange }
  | { kind: 'replacement'; cardId: string; del: TrackedTextChange; ins: TrackedTextChange }
  | { kind: 'format'; cardId: string; change: TrackedFormatChange };

/**
 * Group live tracked-change marks exactly as the review panel presents them:
 * one card per insertion, deletion, or formatting operation, and one shared
 * card for the two halves of a replacement.
 */
export function groupSuggestionCards(changes: TrackedChangeInfo[]): SuggestionCardGroup[] {
  const groups: SuggestionCardGroup[] = [];
  const byPair = new Map<string, TrackedTextChange[]>();

  for (const change of changes) {
    if (change.operation === 'format') {
      groups.push({ kind: 'format', cardId: change.id, change });
      continue;
    }
    if (change.pairId) {
      const members = byPair.get(change.pairId) ?? [];
      members.push(change);
      byPair.set(change.pairId, members);
    } else {
      groups.push({ kind: 'single', cardId: change.id, change });
    }
  }

  for (const members of byPair.values()) {
    const deletion = members.find((change) => change.operation === 'delete');
    const insertion = members.find((change) => change.operation === 'insert');
    // A dangling pairId renders as a standalone card until both halves exist.
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

export function countLogicalSuggestionCards(changes: TrackedChangeInfo[]): number {
  return groupSuggestionCards(changes).length;
}

/** Count the still-live logical cards linked from one persisted chat turn. */
export function countLinkedSuggestionCards(
  changes: TrackedChangeInfo[],
  suggestionIds: string[],
): number {
  const linkedIds = new Set(suggestionIds);
  return countLogicalSuggestionCards(
    changes.filter(
      (change) =>
        linkedIds.has(change.id) ||
        (change.operation !== 'format' &&
          change.pairId !== undefined &&
          linkedIds.has(change.pairId)),
    ),
  );
}
