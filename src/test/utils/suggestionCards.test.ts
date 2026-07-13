import { describe, expect, it } from 'vitest';
import type { LegacyTrackedChangeInfo, TrackedChangeInfo } from '../../types';
import {
  countLinkedSuggestionCards,
  countLogicalSuggestionCards,
  groupLegacySuggestionCards,
  groupSuggestionCards,
} from '../../utils/suggestionCards';

function textChange(id: string, operation: 'insert' | 'delete'): TrackedChangeInfo {
  return {
    id,
    authorID: 'reviewer',
    status: 'pending',
    createdAt: 1,
    segments: [{ kind: operation, from: 1, to: 2, text: id }],
  };
}

const changes: TrackedChangeInfo[] = [
  {
    id: 'replacement',
    authorID: 'reviewer',
    status: 'pending',
    createdAt: 1,
    segments: [
      { kind: 'delete', from: 1, to: 2, text: 'delete-half' },
      { kind: 'insert', from: 1, to: 2, text: 'insert-half' },
    ],
  },
  textChange('insertion', 'insert'),
  textChange('deletion', 'delete'),
  {
    id: 'format',
    authorID: 'reviewer',
    status: 'pending',
    createdAt: 1,
    segments: [
      { kind: 'format', from: 3, to: 4, text: 'a', adds: ['bold'], removes: [] },
      { kind: 'format', from: 6, to: 7, text: 'b', adds: ['bold'], removes: [] },
    ],
  },
];

describe('logical suggestion cards', () => {
  it('counts a replacement pair, standalone changes, and a multi-segment format as cards', () => {
    expect(groupSuggestionCards(changes).map((group) => group.cardId)).toEqual([
      'replacement',
      'insertion',
      'deletion',
      'format',
    ]);
    expect(countLogicalSuggestionCards(changes)).toBe(4);
  });

  it('counts the logical replacement id once and ignores unrelated cards', () => {
    expect(countLinkedSuggestionCards(changes, ['replacement'])).toBe(1);
  });

  it('keeps legacy dangling pair halves visible in the migration oracle', () => {
    const legacy: LegacyTrackedChangeInfo[] = [
      {
        id: 'only-half',
        pairId: 'pair',
        operation: 'delete',
        from: 1,
        to: 2,
        text: 'old',
        authorID: 'reviewer',
        status: 'pending',
        createdAt: 1,
      },
    ];
    expect(groupLegacySuggestionCards(legacy)).toHaveLength(1);
  });
});
