import { describe, expect, it } from 'vitest';
import type { TrackedChangeInfo } from '../../types';
import {
  countLinkedSuggestionCards,
  countLogicalSuggestionCards,
  groupSuggestionCards,
  segmentsToPreview,
} from '../../utils/suggestionCards';
import type { TrackedTextSegment } from '../../types';

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
});

describe('segmentsToPreview', () => {
  const seg = (
    kind: 'insert' | 'delete',
    from: number,
    to: number,
    text: string,
    nodeType?: 'hardBreak',
  ): TrackedTextSegment => ({ kind, from, to, text, ...(nodeType ? { nodeType } : {}) });

  it('spells out a break-only preview so it is clear and never a blank quote', () => {
    // A break-only insertion previously showed an empty quote; a bare glyph is
    // also unclear to screen readers, so it gets the "↵ line break" label.
    expect(segmentsToPreview([seg('insert', 1, 2, '\n', 'hardBreak')])).toBe('↵ line break');
  });

  it('joins a contiguous text–break–text run seamlessly', () => {
    expect(
      segmentsToPreview([
        seg('delete', 1, 4, 'one'),
        seg('delete', 4, 5, '\n', 'hardBreak'),
        seg('delete', 5, 8, 'two'),
      ]),
    ).toBe('one↵two');
  });

  it('keeps the ellipsis separator between genuinely non-contiguous segments', () => {
    expect(segmentsToPreview([seg('delete', 1, 4, 'one'), seg('delete', 8, 11, 'six')])).toBe(
      'one … six',
    );
  });

  it('renders plain text unchanged', () => {
    expect(segmentsToPreview([seg('insert', 1, 6, 'hello')])).toBe('hello');
  });
});
