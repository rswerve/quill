import { describe, expect, it } from 'vitest';
import {
  newestObservedEffort,
  newestObservedModel,
  unboundRecoveryNotice,
} from '../../components/DocumentTab';
import { sanitizeComments, sanitizeDocumentChat } from '../../utils/annotationValidation';
import type { ChatMessage, Comment, DocumentChatThread, Reply } from '../../types';

const reply = (createdAt: string, fields: Partial<Reply>): Reply =>
  ({ id: createdAt, author: 'Claude', text: '', createdAt, authorKind: 'ai', ...fields }) as Reply;

const comment = (id: string, replies: Reply[]): Comment => ({ id, replies }) as unknown as Comment;

const msg = (createdAt: string, fields: Partial<ChatMessage>): ChatMessage =>
  ({ id: createdAt, role: 'assistant', text: '', createdAt, ...fields }) as ChatMessage;

const thread = (messages: ChatMessage[]): DocumentChatThread =>
  ({ messages }) as unknown as DocumentChatThread;

describe('newestObserved model/effort restore', () => {
  it('takes the chronologically newest value across replies and chat, per field', () => {
    const comments = [
      comment('c1', [reply('2026-01-01T10:00:00Z', { model: 'claude-opus-4-6', effort: 'high' })]),
      // A newer reply on an EARLIER comment must still win: ranked by createdAt,
      // not by comment order (the old chat-preferring scan got this wrong).
      comment('c0', [reply('2026-01-01T12:00:00Z', { model: 'claude-opus-4-8', effort: 'max' })]),
    ];
    const chat = thread([
      msg('2026-01-01T11:00:00Z', { model: 'claude-sonnet-4-6', effort: 'low' }),
    ]);
    expect(newestObservedModel(comments, chat)).toBe('claude-opus-4-8');
    expect(newestObservedEffort(comments, chat)).toBe('max');
  });

  it('does not let a newer run without effort erase an older valid effort', () => {
    const comments = [
      comment('c1', [reply('2026-01-01T10:00:00Z', { model: 'claude-opus-4-8', effort: 'high' })]),
      comment('c2', [reply('2026-01-01T12:00:00Z', { model: 'claude-opus-4-8' })]), // newer, no effort
    ];
    expect(newestObservedEffort(comments, undefined)).toBe('high');
    expect(newestObservedModel(comments, undefined)).toBe('claude-opus-4-8');
  });

  it('skips a malformed newer effort value', () => {
    const comments = [
      comment('c1', [reply('2026-01-01T10:00:00Z', { effort: 'high' })]),
      comment('c2', [reply('2026-01-01T12:00:00Z', { effort: 'ultra' })]), // not a real effort level
    ];
    expect(newestObservedEffort(comments, undefined)).toBe('high');
  });

  it('lets model and effort legitimately come from different runs', () => {
    const comments = [
      comment('c1', [reply('2026-01-01T10:00:00Z', { effort: 'max' })]), // effort only
      comment('c2', [reply('2026-01-01T12:00:00Z', { model: 'claude-opus-4-8' })]), // model only, newer
    ];
    expect(newestObservedModel(comments, undefined)).toBe('claude-opus-4-8');
    expect(newestObservedEffort(comments, undefined)).toBe('max');
  });

  it('ignores non-AI replies and returns null when nothing was observed', () => {
    const human = [
      comment('c1', [
        { id: 'r', author: 'me', text: 'hi', createdAt: '2026-01-01T10:00:00Z' } as Reply,
      ]),
    ];
    expect(newestObservedModel(human, undefined)).toBeNull();
    expect(newestObservedEffort([], thread([]))).toBeNull();
  });

  it('breaks equal-timestamp ties deterministically (keeps the first seen)', () => {
    const t = '2026-01-01T10:00:00Z';
    const comments = [
      comment('c1', [
        reply(t, { model: 'claude-opus-4-8' }),
        reply(t, { model: 'claude-sonnet-4-6' }),
      ]),
    ];
    // consider() only replaces on a strictly newer createdAt, so equal times keep
    // the first-encountered value — deterministic regardless of input churn.
    expect(newestObservedModel(comments, undefined)).toBe('claude-opus-4-8');
  });

  it('ranks by the field observation time, not createdAt, so a retry restamp wins', () => {
    // Reply A was created Monday but its effort was re-observed Wednesday (a retry
    // reuses createdAt); chat B observed effort Tuesday. Wednesday must win despite
    // A's older createdAt — ranking is by effortObservedAt.
    const comments = [
      comment('a', [
        reply('2026-01-05T00:00:00Z', { effort: 'high', effortObservedAt: '2026-01-07T00:00:00Z' }),
      ]),
    ];
    const chat = thread([
      msg('2026-01-06T00:00:00Z', { effort: 'low', effortObservedAt: '2026-01-06T00:00:00Z' }),
    ]);
    expect(newestObservedEffort(comments, chat)).toBe('high');
    // Legacy records without observedAt fall back to createdAt → B (Tuesday) wins.
    const legacy = [comment('a', [reply('2026-01-05T00:00:00Z', { effort: 'high' })])];
    expect(newestObservedEffort(legacy, chat)).toBe('low');
  });

  // Guards against the helper tests silently passing on already-sanitized runtime
  // objects while the persistence boundary strips the fields: this feeds raw
  // on-disk shapes through the real sanitizers, then into the restore helpers.
  it('round-trips model/effort and their timestamps through the sanitizer into restore', () => {
    const comments = sanitizeComments([
      {
        id: 'c1',
        anchorText: 'x',
        from: 0,
        to: 1,
        author: 'me',
        createdAt: '2026-01-05T00:00:00Z',
        resolved: false,
        kind: 'note',
        replies: [
          {
            id: 'r1',
            author: 'Claude',
            text: 'edited',
            createdAt: '2026-01-05T00:00:00Z', // a retry reuses this original time
            authorKind: 'ai',
            model: 'claude-opus-4-8',
            modelObservedAt: '2026-01-07T00:00:00Z',
            effort: 'high',
            effortObservedAt: '2026-01-07T00:00:00Z',
          },
        ],
      },
    ]);
    const chat = sanitizeDocumentChat({
      sessionId: 's1',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          text: 'hi',
          createdAt: '2026-01-06T00:00:00Z',
          model: 'claude-sonnet-4-6',
          modelObservedAt: '2026-01-06T00:00:00Z',
          effort: 'low',
          effortObservedAt: '2026-01-06T00:00:00Z',
        },
      ],
    });

    // The reply's createdAt (Jan 5) is older than the chat message (Jan 6), but
    // its observation timestamps (Jan 7) are newer. Restore must pick the reply —
    // proving the persisted observedAt survived the boundary AND drove ordering.
    expect(newestObservedModel(comments, chat)).toBe('claude-opus-4-8');
    expect(newestObservedEffort(comments, chat)).toBe('high');
  });
});

describe('unboundRecoveryNotice (Maz decision #3: per-reason, silent-when-clean)', () => {
  it('is silent when nothing was set aside', () => {
    expect(unboundRecoveryNotice('source-mismatch', 0)).toBeNull();
    expect(unboundRecoveryNotice('legacy', 0)).toBeNull();
  });

  it('leads with "changed outside Quill" for an external edit', () => {
    const notice = unboundRecoveryNotice('source-mismatch', 2)!;
    expect(notice.title).toBe('Some annotations need review');
    expect(notice.message).toContain('This file was changed outside Quill.');
    expect(notice.message).toContain('2 couldn’t be placed and are set aside');
    expect(notice.message).toContain('open the review panel');
  });

  it('leads with "older version of Quill" for legacy and version-mismatch', () => {
    expect(unboundRecoveryNotice('legacy', 1)!.message).toContain(
      'This file was saved in an older version of Quill.',
    );
    expect(unboundRecoveryNotice('version-mismatch', 1)!.message).toContain(
      'This file was saved in an older version of Quill.',
    );
  });

  it('leads with a recovery sentence for crash recovery', () => {
    expect(unboundRecoveryNotice('recovery', 3)!.message).toContain(
      'Quill recovered unsaved work from a previous session.',
    );
  });

  it('agrees in number: one is set aside, many are set aside', () => {
    expect(unboundRecoveryNotice('legacy', 1)!.message).toContain(
      '1 couldn’t be placed and is set aside',
    );
    expect(unboundRecoveryNotice('legacy', 4)!.message).toContain(
      '4 couldn’t be placed and are set aside',
    );
  });
});
