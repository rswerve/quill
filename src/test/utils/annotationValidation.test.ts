import { describe, it, expect } from 'vitest';
import {
  sanitizeComments,
  sanitizeSuggestions,
  sanitizeAISession,
  sanitizeContextFolder,
  sanitizeDocumentChat,
} from '../../utils/annotationValidation';
import type { AISessionBinding } from '../../types';
import autoBindSession from '../../../test/fixtures/ipc/auto-bind-session.json';

const validComment = {
  id: 'c1',
  kind: 'note',
  anchorText: 'hello',
  from: 3,
  to: 8,
  author: 'Sam',
  createdAt: '2026-01-01T00:00:00Z',
  resolved: false,
  replies: [],
};

const validSuggestion = {
  id: 's1',
  type: 'insertion',
  from: 1,
  to: 4,
  originalText: '',
  suggestedText: 'new',
  author: 'Claude',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
};

const validFormatSuggestion = {
  id: 'fmt1',
  type: 'format',
  author: 'Claude',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
  originCommentId: 'c1',
  segments: [
    { from: 8, to: 12, text: 'late', adds: ['strike', 'bold', 'bold'], removes: [] },
    { from: 1, to: 4, text: 'new', adds: [], removes: ['italic'] },
  ],
};

const validLogicalSuggestion = {
  id: 'change-1',
  type: 'change',
  author: 'Claude',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
  originChatMessageId: 'turn-1',
  segments: [
    { kind: 'insert', from: 8, to: 11, text: 'new' },
    { kind: 'delete', from: 1, to: 4, text: 'old' },
  ],
};

describe('sanitizeComments', () => {
  it('preserves a well-formed private note', () => {
    expect(sanitizeComments([validComment])).toEqual([validComment]);
  });

  it.each([undefined, 'unexpected'])('defaults a missing or malformed %s kind to note', (kind) => {
    expect(sanitizeComments([{ ...validComment, kind }])[0].kind).toBe('note');
  });

  it.each(['note', 'claude'] as const)('preserves an explicit %s identity', (kind) => {
    expect(sanitizeComments([{ ...validComment, kind }])[0].kind).toBe(kind);
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeComments(undefined)).toEqual([]);
    expect(sanitizeComments(null)).toEqual([]);
    expect(sanitizeComments('comments')).toEqual([]);
    expect(sanitizeComments({ 0: validComment })).toEqual([]);
  });

  it('drops records that are not objects or lack an id', () => {
    expect(sanitizeComments([null, 42, 'x', {}, { id: '' }])).toEqual([]);
  });

  it('drops comments with non-numeric or negative positions (would throw in doc.resolve)', () => {
    const bad = [
      { ...validComment, from: -1 },
      { ...validComment, to: NaN },
      { ...validComment, from: 'nope' },
      { ...validComment, to: Infinity },
      { ...validComment, from: undefined },
    ];
    expect(sanitizeComments(bad)).toEqual([]);
  });

  it('floors fractional positions and orders from <= to', () => {
    const [c] = sanitizeComments([{ ...validComment, from: 8.9, to: 3.2 }]);
    expect(c.from).toBe(3);
    expect(c.to).toBe(8);
  });

  it('coerces missing optional fields to safe defaults', () => {
    const [c] = sanitizeComments([{ id: 'c2', from: 0, to: 1 }]);
    expect(c).toMatchObject({
      id: 'c2',
      anchorText: '',
      author: '',
      createdAt: '',
      resolved: false,
      replies: [],
    });
  });

  it('drops malformed replies but keeps the comment', () => {
    const [c] = sanitizeComments([
      { ...validComment, replies: [null, { id: 'r1', text: 'hi' }, { text: 'no id' }] },
    ]);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].id).toBe('r1');
  });

  it('preserves a non-empty model on a persisted AI reply', () => {
    const [c] = sanitizeComments([
      {
        ...validComment,
        replies: [
          {
            id: 'r-model',
            author: 'Claude',
            text: 'Reply',
            createdAt: '2026-07-11T18:00:00Z',
            authorKind: 'ai',
            model: 'claude-fable-5',
          },
        ],
      },
    ]);

    expect(c.replies[0].model).toBe('claude-fable-5');
  });

  it('preserves a persisted AI reply effort and both observation timestamps', () => {
    const [c] = sanitizeComments([
      {
        ...validComment,
        replies: [
          {
            id: 'r-obs',
            author: 'Claude',
            text: 'Reply',
            createdAt: '2026-07-11T18:00:00Z',
            authorKind: 'ai',
            model: 'claude-opus-4-8',
            modelObservedAt: '2026-07-11T18:00:05Z',
            effort: 'high',
            effortObservedAt: '2026-07-11T18:00:06Z',
          },
        ],
      },
    ]);

    expect(c.replies[0]).toMatchObject({
      model: 'claude-opus-4-8',
      modelObservedAt: '2026-07-11T18:00:05Z',
      effort: 'high',
      effortObservedAt: '2026-07-11T18:00:06Z',
    });
  });

  it('drops an unknown effort level and an observation timestamp with no surviving value', () => {
    const [c] = sanitizeComments([
      {
        ...validComment,
        replies: [
          {
            id: 'r-bad',
            author: 'Claude',
            text: 'Reply',
            createdAt: '2026-07-11T18:00:00Z',
            authorKind: 'ai',
            effort: 'ultra', // not a real effort level → dropped
            effortObservedAt: '2026-07-11T18:00:06Z', // orphaned by the drop
            modelObservedAt: '2026-07-11T18:00:05Z', // no model at all → orphan
          },
        ],
      },
    ]);

    const reply = c.replies[0];
    expect(reply.effort).toBeUndefined();
    expect(reply.effortObservedAt).toBeUndefined();
    expect(reply.model).toBeUndefined();
    expect(reply.modelObservedAt).toBeUndefined();
  });

  it('preserves safe reply provenance and dismissed state', () => {
    const [comment] = sanitizeComments([
      {
        ...validComment,
        replies: [
          {
            id: 'r-linked',
            author: 'Claude',
            text: 'Edited it.',
            createdAt: '2026-07-11T18:00:00Z',
            authorKind: 'ai',
            suggestionIds: ['change-1', '', 7, 'change-2'],
            dismissed: true,
          },
        ],
      },
    ]);

    expect(comment.replies[0]).toMatchObject({
      suggestionIds: ['change-1', 'change-2'],
      dismissed: true,
    });
  });

  it('keeps the good comments and drops the bad in a mixed array', () => {
    const result = sanitizeComments([validComment, { id: 'bad', from: -5, to: 2 }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });
});

describe('sanitizeSuggestions', () => {
  it('keeps a well-formed suggestion', () => {
    expect(sanitizeSuggestions([validSuggestion])).toEqual([validSuggestion]);
  });

  it('keeps one logical replacement record and canonicalizes segment order', () => {
    expect(sanitizeSuggestions([validLogicalSuggestion])).toEqual([
      {
        ...validLogicalSuggestion,
        segments: [
          { kind: 'delete', from: 1, to: 4, text: 'old' },
          { kind: 'insert', from: 8, to: 11, text: 'new' },
        ],
      },
    ]);
  });

  it('drops a logical record if any segment is malformed', () => {
    expect(
      sanitizeSuggestions([
        {
          ...validLogicalSuggestion,
          segments: [...validLogicalSuggestion.segments, { kind: 'insert', from: 3, to: 3 }],
        },
      ]),
    ).toEqual([]);
  });

  it('drops suggestions with an unknown type', () => {
    expect(sanitizeSuggestions([{ ...validSuggestion, type: 'replacement' }])).toEqual([]);
  });

  it('drops suggestions with bad positions', () => {
    expect(sanitizeSuggestions([{ ...validSuggestion, from: -2 }])).toEqual([]);
  });

  it('defaults an unknown status to pending', () => {
    const [s] = sanitizeSuggestions([{ ...validSuggestion, status: 'weird' }]);
    expect(s.status).toBe('pending');
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeSuggestions(null)).toEqual([]);
  });

  it('passes originCommentId through when it is a non-empty string', () => {
    const [s] = sanitizeSuggestions([{ ...validSuggestion, originCommentId: 'c42' }]);
    expect(s.originCommentId).toBe('c42');
  });

  it('passes originChatMessageId through when it is a non-empty string', () => {
    const [suggestion] = sanitizeSuggestions([
      { ...validSuggestion, originChatMessageId: 'chat-message-42' },
    ]);
    expect(suggestion.originChatMessageId).toBe('chat-message-42');
  });

  it('drops a malformed originCommentId (empty or non-string), like pairId', () => {
    const [empty] = sanitizeSuggestions([{ ...validSuggestion, originCommentId: '' }]);
    expect('originCommentId' in empty).toBe(false);
    const [numeric] = sanitizeSuggestions([{ ...validSuggestion, originCommentId: 7 }]);
    expect('originCommentId' in numeric).toBe(false);
  });

  it('keeps format suggestions and canonicalizes segment and mark order', () => {
    expect(sanitizeSuggestions([validFormatSuggestion])).toEqual([
      {
        ...validFormatSuggestion,
        segments: [
          { from: 1, to: 4, text: 'new', adds: [], removes: ['italic'] },
          { from: 8, to: 12, text: 'late', adds: ['bold', 'strike'], removes: [] },
        ],
      },
    ]);
  });

  it('filters unknown format names but retains the valid delta', () => {
    const [suggestion] = sanitizeSuggestions([
      {
        ...validFormatSuggestion,
        segments: [{ from: 1, to: 4, text: 'new', adds: ['bold', 'underline'], removes: [] }],
      },
    ]);
    expect(suggestion).toMatchObject({
      type: 'format',
      segments: [{ from: 1, to: 4, text: 'new', adds: ['bold'], removes: [] }],
    });
  });

  it('drops malformed format suggestions rather than restoring an inexact inverse', () => {
    const malformed = [
      { ...validFormatSuggestion, segments: [] },
      {
        ...validFormatSuggestion,
        segments: [{ from: 2, to: 2, text: '', adds: ['bold'], removes: [] }],
      },
      {
        ...validFormatSuggestion,
        segments: [{ from: 1, to: 4, text: 'new', adds: ['bold'], removes: ['bold'] }],
      },
      {
        ...validFormatSuggestion,
        segments: [
          { from: 1, to: 5, text: 'first', adds: ['bold'], removes: [] },
          { from: 4, to: 8, text: 'overlap', adds: ['italic'], removes: [] },
        ],
      },
      {
        ...validFormatSuggestion,
        segments: [{ from: 1, to: 4, text: 'new', adds: ['underline'], removes: [] }],
      },
    ];
    expect(sanitizeSuggestions(malformed)).toEqual([]);
  });
});

describe('sanitizeAISession', () => {
  const valid = autoBindSession;

  it('keeps a complete binding', () => {
    expect(sanitizeAISession(valid)).toEqual(valid);
  });

  it('preserves createdByQuill on a Quill-minted binding', () => {
    const created: AISessionBinding = {
      ...valid,
      provider: 'claude-code',
      createdByQuill: true,
    };
    const sanitized = sanitizeAISession({ ...valid, createdByQuill: true });
    expect(sanitized).toEqual(created);
  });

  it('rejects a binding with the wrong provider', () => {
    expect(sanitizeAISession({ ...valid, provider: 'openai' })).toBeUndefined();
  });

  it('rejects a partial binding (all-or-nothing)', () => {
    expect(sanitizeAISession({ ...valid, sessionId: '' })).toBeUndefined();
    expect(sanitizeAISession({ ...valid, cwd: 42 })).toBeUndefined();
    expect(sanitizeAISession({})).toBeUndefined();
    expect(sanitizeAISession(null)).toBeUndefined();
  });
});

describe('sanitizeContextFolder', () => {
  it('keeps a non-empty string', () => {
    expect(sanitizeContextFolder('/refs')).toBe('/refs');
  });

  it('rejects empty strings and non-strings', () => {
    expect(sanitizeContextFolder('')).toBeUndefined();
    expect(sanitizeContextFolder(123)).toBeUndefined();
    expect(sanitizeContextFolder(null)).toBeUndefined();
  });
});

describe('sanitizeDocumentChat', () => {
  it('keeps a valid thread while dropping malformed messages and optional fields', () => {
    expect(
      sanitizeDocumentChat({
        sessionId: 'session-1',
        messages: [
          { id: 'u1', role: 'user', text: 'Please edit this', createdAt: 'now' },
          {
            id: 'a1',
            role: 'assistant',
            text: 'Done',
            createdAt: 'later',
            model: 'claude-sonnet',
            suggestionIds: ['s1', '', 42, 's2'],
          },
          { role: 'assistant', text: 'missing id' },
        ],
      }),
    ).toEqual({
      sessionId: 'session-1',
      messages: [
        { id: 'u1', role: 'user', text: 'Please edit this', createdAt: 'now' },
        {
          id: 'a1',
          role: 'assistant',
          text: 'Done',
          createdAt: 'later',
          model: 'claude-sonnet',
          suggestionIds: ['s1', 's2'],
        },
      ],
    });
  });

  it('preserves an assistant message effort and both observation timestamps', () => {
    const thread = sanitizeDocumentChat({
      sessionId: 'session-1',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          text: 'Done',
          createdAt: 'later',
          model: 'claude-opus-4-8',
          modelObservedAt: '2026-07-11T18:00:05Z',
          effort: 'max',
          effortObservedAt: '2026-07-11T18:00:06Z',
        },
      ],
    });

    expect(thread?.messages[0]).toMatchObject({
      model: 'claude-opus-4-8',
      modelObservedAt: '2026-07-11T18:00:05Z',
      effort: 'max',
      effortObservedAt: '2026-07-11T18:00:06Z',
    });
  });

  it('rejects a thread without a session id or message array', () => {
    expect(sanitizeDocumentChat({ sessionId: '', messages: [] })).toBeUndefined();
    expect(sanitizeDocumentChat({ sessionId: 'session-1' })).toBeUndefined();
    expect(sanitizeDocumentChat(null)).toBeUndefined();
  });
});
