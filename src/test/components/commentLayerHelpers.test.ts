import { describe, expect, it } from 'vitest';
import type { Comment } from '../../types';
import { sortCommentsInDocumentOrder } from '../../components/CommentLayer';

function comment(id: string, from: number, createdAt: string): Comment {
  return {
    id,
    kind: 'note',
    from,
    to: from + 1,
    anchorText: id,
    author: 'User',
    createdAt,
    resolved: false,
    replies: [],
  };
}

describe('sortCommentsInDocumentOrder', () => {
  it('orders comments by live document range', () => {
    const later = comment('later', 20, '2026-07-14T12:00:00.000Z');
    const earlier = comment('earlier', 4, '2026-07-14T12:01:00.000Z');

    expect(sortCommentsInDocumentOrder([later, earlier]).map(({ id }) => id)).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('uses creation time and id as deterministic same-position tie breakers', () => {
    const newest = comment('newest', 10, '2026-07-14T12:02:00.000Z');
    const second = comment('z-second', 10, '2026-07-14T12:00:00.000Z');
    const first = comment('a-first', 10, '2026-07-14T12:00:00.000Z');

    expect(sortCommentsInDocumentOrder([newest, second, first]).map(({ id }) => id)).toEqual([
      'a-first',
      'z-second',
      'newest',
    ]);
  });
});
