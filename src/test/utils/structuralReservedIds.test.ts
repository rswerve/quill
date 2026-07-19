import { describe, it, expect } from 'vitest';
import {
  collectReservedIds,
  allocateReservedId,
  type ReservedIdSources,
} from '../../utils/structuralReservedIds';

/**
 * 6b-2: the batch-local reserved-id collector, verified independently before it
 * enters the orchestration. It must reserve every EXISTING identity — including the
 * non-actionable, inactive, orphan, and malformed ones the UI refuses to enumerate —
 * so a freshly minted structural change can never adopt an id already in use.
 */

const EMPTY: ReservedIdSources = {
  liveInlineIds: [],
  liveInlineIdentityHints: [],
  liveStructuralIdentityIds: [],
  retainedStructuralIds: [],
  quarantinedInlineIds: [],
  quarantinedStructural: [],
  replyChatSuggestionIds: [],
};

/** A nextId source returning the given values in order (throws when exhausted). */
function seq(values: string[]): () => string {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('seq exhausted');
    return values[i++];
  };
}

describe('collectReservedIds', () => {
  it('unions ids from every source — including non-actionable ones — and dedupes', () => {
    const reserved = collectReservedIds({
      liveInlineIds: ['inline-1', 'shared'],
      liveInlineIdentityHints: ['hint-1', 'shared'], // duplicate across sources
      liveStructuralIdentityIds: ['struct-1', 'orphan-malformed'], // raw/orphan live ids
      retainedStructuralIds: ['retained-1', 'inactive-retained'], // inactive record kept
      quarantinedInlineIds: ['q-inline-1'],
      quarantinedStructural: [{ changeId: 'q-struct-cid' }, { id: 'q-struct-id' }],
      replyChatSuggestionIds: ['reply-1', 'chat-1'],
    });
    for (const id of [
      'inline-1',
      'shared',
      'hint-1',
      'struct-1',
      'orphan-malformed',
      'retained-1',
      'inactive-retained',
      'q-inline-1',
      'q-struct-cid',
      'q-struct-id',
      'reply-1',
      'chat-1',
    ]) {
      expect(reserved.has(id)).toBe(true);
    }
    expect(reserved.size).toBe(12); // 'shared' collapsed
  });

  it('reserves BOTH changeId and id from a quarantined structural record', () => {
    const reserved = collectReservedIds({
      ...EMPTY,
      quarantinedStructural: [{ changeId: 'cid', id: 'iid', operation: 'garbage', level: 99 }],
    });
    expect(reserved.has('cid')).toBe(true);
    expect(reserved.has('iid')).toBe(true);
  });

  it('ignores opaque / malformed quarantined structural evidence without crashing', () => {
    const reserved = collectReservedIds({
      ...EMPTY,
      quarantinedStructural: [
        null,
        42,
        'a raw string',
        [],
        { nope: true },
        { changeId: 123 },
        { id: null },
      ],
    });
    expect(reserved.size).toBe(0);
  });

  it('drops empty and non-string hints and keeps ids EXACT (never trims)', () => {
    const reserved = collectReservedIds({
      ...EMPTY,
      liveInlineIds: ['', ' x ', 'keep'],
      quarantinedStructural: [{ changeId: '' }, { id: '  ' }],
    });
    expect(reserved.has('')).toBe(false); // empty dropped
    expect(reserved.has(' x ')).toBe(true); // exact — not trimmed to 'x'
    expect(reserved.has('x')).toBe(false);
    expect(reserved.has('keep')).toBe(true);
    expect(reserved.has('  ')).toBe(true); // a whitespace identity is kept exact
  });
});

describe('allocateReservedId', () => {
  it('allocates an unreserved id and reserves it in place', () => {
    const reserved = new Set(['a']);
    expect(allocateReservedId(reserved, seq(['a', 'b']))).toBe('b'); // 'a' collides → skipped
    expect(reserved.has('b')).toBe(true);
  });

  it('never reuses an allocated id within the batch, even before the mint runs', () => {
    const reserved = new Set<string>();
    const next = seq(['x', 'x', 'y']);
    expect(allocateReservedId(reserved, next)).toBe('x');
    // Reserved on ALLOCATION (not on mint success), so the second 'x' is skipped.
    expect(allocateReservedId(reserved, next)).toBe('y');
  });
});
