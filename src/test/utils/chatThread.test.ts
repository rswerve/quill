import { describe, it, expect } from 'vitest';
import { stripTransientChatState } from '../../utils/chatThread';
import type { ChatMessage } from '../../types';

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm',
  role: 'assistant',
  text: 't',
  createdAt: '',
  ...over,
});

describe('stripTransientChatState', () => {
  it('downgrades a pending assistant turn to cancelled, keeping its partial text', () => {
    const out = stripTransientChatState([
      message({ id: 'a', role: 'assistant', text: 'half a response', pending: true }),
    ]);
    expect(out[0]).toMatchObject({
      id: 'a',
      pending: false,
      cancelled: true,
      text: 'half a response',
    });
  });

  it('keeps a finished assistant turn untouched', () => {
    const finished = message({ id: 'a', role: 'assistant', text: 'done' });
    const out = stripTransientChatState([finished]);
    expect(out[0]).toBe(finished);
  });

  it('keeps errored and already-cancelled assistant turns (retryable history, not in-flight)', () => {
    const errored = message({ id: 'a', role: 'assistant', text: 'oops', error: 'API Error' });
    const cancelled = message({ id: 'b', role: 'assistant', text: '', cancelled: true });
    const out = stripTransientChatState([errored, cancelled]);
    expect(out).toEqual([errored, cancelled]);
  });

  it('never touches user turns', () => {
    // pending should never appear on a user turn, but the guard is scoped to
    // assistant turns — a user turn is retained verbatim regardless.
    const user = message({ id: 'u', role: 'user', text: 'hi', pending: true });
    const out = stripTransientChatState([user]);
    expect(out[0]).toBe(user);
  });

  it('returns the same array reference when nothing is transient', () => {
    const input = [
      message({ id: 'u', role: 'user', text: 'q' }),
      message({ id: 'a', role: 'assistant', text: 'a' }),
    ];
    expect(stripTransientChatState(input)).toBe(input);
  });

  it('strips only the pending turn from a mixed thread', () => {
    const out = stripTransientChatState([
      message({ id: 'u1', role: 'user', text: 'first' }),
      message({ id: 'a1', role: 'assistant', text: 'done' }),
      message({ id: 'u2', role: 'user', text: 'second' }),
      message({ id: 'a2', role: 'assistant', text: 'streaming…', pending: true }),
    ]);
    expect(out.map((m) => [m.id, m.pending ?? false, m.cancelled ?? false])).toEqual([
      ['u1', false, false],
      ['a1', false, false],
      ['u2', false, false],
      ['a2', false, true],
    ]);
  });

  it('does not mutate the input array or its messages', () => {
    const pending = message({ id: 'a', role: 'assistant', text: 'x', pending: true });
    const input = [pending];
    stripTransientChatState(input);
    expect(pending.pending).toBe(true); // original untouched
    expect(input).toEqual([pending]);
  });
});
