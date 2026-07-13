import { describe, expect, it } from 'vitest';
import type { TrackedChangeInfo, TrackedTextChange } from '../../types';
import {
  countLinkedSuggestionCards,
  countLogicalSuggestionCards,
  groupSuggestionCards,
} from '../../utils/suggestionCards';

function textChange(
  id: string,
  operation: 'insert' | 'delete',
  pairId?: string,
): TrackedTextChange {
  return {
    id,
    operation,
    pairId,
    from: 1,
    to: 2,
    text: id,
    authorID: 'reviewer',
    status: 'pending',
    createdAt: 1,
  };
}

const changes: TrackedChangeInfo[] = [
  textChange('delete-half', 'delete', 'replacement'),
  textChange('insert-half', 'insert', 'replacement'),
  textChange('insertion', 'insert'),
  textChange('deletion', 'delete'),
  {
    id: 'format',
    operation: 'format',
    authorID: 'reviewer',
    status: 'pending',
    createdAt: 1,
    segments: [
      { from: 3, to: 4, text: 'a', adds: ['bold'], removes: [] },
      { from: 6, to: 7, text: 'b', adds: ['bold'], removes: [] },
    ],
  },
];

describe('logical suggestion cards', () => {
  it('counts a replacement pair, standalone changes, and a multi-segment format as cards', () => {
    expect(groupSuggestionCards(changes).map((group) => group.cardId)).toEqual([
      'insertion',
      'deletion',
      'format',
      'replacement',
    ]);
    expect(countLogicalSuggestionCards(changes)).toBe(4);
  });

  it('counts both persisted replacement-half ids as one linked chat card', () => {
    expect(countLinkedSuggestionCards(changes, ['delete-half', 'insert-half'])).toBe(1);
  });

  it('also accepts a logical pairId link and ignores unrelated cards', () => {
    expect(countLinkedSuggestionCards(changes, ['replacement'])).toBe(1);
  });

  it('keeps a dangling pair half as one visible card', () => {
    expect(countLogicalSuggestionCards([textChange('only-half', 'delete', 'pair')])).toBe(1);
  });
});
