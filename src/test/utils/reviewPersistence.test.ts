import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import {
  mergeQuarantinedSuggestions,
  suggestionsFromTrackedChanges,
  restoreReviewMarks,
} from '../../utils/reviewPersistence';
import type {
  FormatSuggestion,
  TextSuggestion,
  TrackedFormatChange,
  TrackedTextChange,
} from '../../types';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content,
  });
}

function makeChange(overrides: Partial<TrackedTextChange> = {}): TrackedTextChange {
  return {
    id: 'ch1',
    operation: 'insert',
    from: 1,
    to: 6,
    text: 'Hello',
    authorID: 'claude',
    status: 'pending',
    createdAt: Date.parse('2026-07-11T12:00:00Z'),
    ...overrides,
  };
}

function makeFormatChange(overrides: Partial<TrackedFormatChange> = {}): TrackedFormatChange {
  return {
    id: 'fmt1',
    operation: 'format',
    authorID: 'claude',
    status: 'pending',
    createdAt: Date.parse('2026-07-11T12:00:00Z'),
    segments: [
      { from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
      { from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
    ],
    ...overrides,
  };
}

describe('suggestionsFromTrackedChanges', () => {
  it('carries originCommentId through to the sidecar record', () => {
    const [s] = suggestionsFromTrackedChanges([makeChange({ originCommentId: 'c42' })]);
    expect(s.originCommentId).toBe('c42');
  });

  it('round-trips document-chat provenance through sidecar marks', () => {
    const [record] = suggestionsFromTrackedChanges([
      makeChange({ originChatMessageId: 'chat-message-7' }),
    ]);
    expect(record.originChatMessageId).toBe('chat-message-7');

    const editor = makeEditor();
    restoreReviewMarks(editor, [], [record]);
    expect(getTrackedChanges(editor)[0].originChatMessageId).toBe('chat-message-7');
    editor.destroy();
  });

  it('omits originCommentId when the change has none (like pairId)', () => {
    const [s] = suggestionsFromTrackedChanges([makeChange()]);
    expect('originCommentId' in s).toBe(false);
    expect('pairId' in s).toBe(false);
  });

  it('still carries pairId alongside originCommentId', () => {
    const [s] = suggestionsFromTrackedChanges([
      makeChange({ pairId: 'p1', originCommentId: 'c42' }),
    ]);
    expect(s.type).not.toBe('format');
    if (s.type === 'format') throw new Error('expected a text suggestion');
    expect(s.pairId).toBe('p1');
    expect(s.originCommentId).toBe('c42');
  });

  it('serializes every homogeneous span of a format change', () => {
    const [suggestion] = suggestionsFromTrackedChanges([
      makeFormatChange({ originCommentId: 'c42' }),
    ]);

    expect(suggestion).toEqual({
      id: 'fmt1',
      type: 'format',
      author: 'claude',
      createdAt: '2026-07-11T12:00:00.000Z',
      status: 'pending',
      originCommentId: 'c42',
      segments: [
        { from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
        { from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
      ],
    });
  });
});

describe('restoreReviewMarks', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  function suggestion(overrides: Partial<TextSuggestion> = {}): TextSuggestion {
    return {
      id: 's1',
      type: 'insertion',
      from: 1,
      to: 6,
      originalText: '',
      suggestedText: 'Hello',
      author: 'claude',
      createdAt: '2026-07-11T12:00:00Z',
      status: 'pending',
      ...overrides,
    };
  }

  function formatSuggestion(overrides: Partial<FormatSuggestion> = {}): FormatSuggestion {
    return {
      id: 'fmt1',
      type: 'format',
      author: 'claude',
      createdAt: '2026-07-11T12:00:00Z',
      status: 'pending',
      segments: [
        { from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
        { from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
      ],
      ...overrides,
    };
  }

  it('stamps originCommentId back into the restored dataTracked', () => {
    editor = makeEditor('<p>Hello world</p>');
    restoreReviewMarks(editor, [], [suggestion({ originCommentId: 'c42', pairId: 'p1' })]);

    const [change] = getTrackedChanges(editor);
    expect(change).toMatchObject({
      id: 's1',
      operation: 'insert',
      originCommentId: 'c42',
      pairId: 'p1',
    });
  });

  it('restores without originCommentId when the record has none', () => {
    editor = makeEditor('<p>Hello world</p>');
    restoreReviewMarks(editor, [], [suggestion()]);

    const [change] = getTrackedChanges(editor);
    expect(change.id).toBe('s1');
    expect(change.originCommentId).toBeUndefined();
  });

  it('round-trips: live change → sidecar record → restored change keeps the origin', () => {
    // Mint a live tracked change with an origin, flatten it for the sidecar,
    // then stamp it onto a fresh editor — the origin must survive the trip.
    editor = makeEditor('<p>Hello world</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.commands.setTrackChangesOrigin('c42');
    editor.commands.insertContentAt(7, 'beautiful ');

    const records = suggestionsFromTrackedChanges(getTrackedChanges(editor));
    expect(records[0].originCommentId).toBe('c42');
    editor.destroy();

    editor = makeEditor('<p>Hello beautiful world</p>');
    restoreReviewMarks(editor, [], records);
    const [restored] = getTrackedChanges(editor);
    expect(restored.originCommentId).toBe('c42');
    expect(restored.status).toBe('pending');
  });

  it('restores disjoint format spans under one logical id with exact deltas', () => {
    editor = makeEditor('<p><strong>Hello</strong> <em>world</em></p>');
    restoreReviewMarks(editor, [], [formatSuggestion({ originCommentId: 'c42' })]);

    expect(getTrackedChanges(editor)).toEqual([
      expect.objectContaining({
        id: 'fmt1',
        operation: 'format',
        authorID: 'claude',
        originCommentId: 'c42',
        segments: [
          { from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
          { from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
        ],
      }),
    ]);
  });

  it('round-trips a multi-span format change without aliasing its delta arrays', () => {
    const live = makeFormatChange({ originCommentId: 'c42' });
    const [record] = suggestionsFromTrackedChanges([live]);
    expect(record.type).toBe('format');
    if (record.type !== 'format') throw new Error('expected a format suggestion');
    expect(record.segments).not.toBe(live.segments);
    expect(record.segments[0].adds).not.toBe(live.segments[0].adds);

    editor = makeEditor('<p><strong>Hello</strong> <em>world</em></p>');
    restoreReviewMarks(editor, [], [record]);
    expect(getTrackedChanges(editor)[0]).toMatchObject({
      operation: 'format',
      originCommentId: 'c42',
      segments: live.segments,
    });
  });

  it('quarantines a text suggestion whose stored text no longer matches the document', () => {
    editor = makeEditor('<p>Other world</p>');
    const before = editor.getJSON();

    const result = restoreReviewMarks(editor, [], [suggestion()]);

    expect(result.quarantinedSuggestions).toEqual([
      expect.objectContaining({ id: 's1', suggestedText: 'Hello' }),
    ]);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ suggestionId: 's1', expected: 'Hello', actual: 'Other' }),
    ]);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.acceptAllChanges();
    expect(editor.getJSON()).toEqual(before);
  });

  it('quarantines an entire replacement pair when either half mismatches', () => {
    editor = makeEditor('<p>Old New</p>');
    const records: TextSuggestion[] = [
      suggestion({
        id: 'delete-half',
        type: 'deletion',
        from: 1,
        to: 4,
        originalText: 'Old',
        suggestedText: '',
        pairId: 'pair-1',
      }),
      suggestion({
        id: 'insert-half',
        from: 5,
        to: 8,
        originalText: '',
        suggestedText: 'Wrong',
        pairId: 'pair-1',
      }),
    ];

    const result = restoreReviewMarks(editor, [], records);

    expect(result.quarantinedSuggestions.map((record) => record.id)).toEqual([
      'delete-half',
      'insert-half',
    ]);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('quarantines every segment of a format suggestion when one segment mismatches', () => {
    editor = makeEditor('<p><strong>Hello</strong> <em>other</em></p>');

    const result = restoreReviewMarks(editor, [], [formatSuggestion()]);

    expect(result.quarantinedSuggestions).toEqual([
      expect.objectContaining({ id: 'fmt1', type: 'format' }),
    ]);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ suggestionId: 'fmt1', expected: 'world', actual: 'other' }),
    ]);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('preserves quarantined records beside the live projection without duplicating ids', () => {
    const quarantined = suggestion({ id: 'quarantined' });
    const live = suggestion({ id: 'live', suggestedText: 'world' });

    expect(mergeQuarantinedSuggestions([live], [quarantined, live])).toEqual([live, quarantined]);
  });

  it.each([true, false])(
    'save/reopen keeps freshly inserted text outside an inherited format marker (suggesting=%s)',
    (suggesting) => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('claude');
      editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
      editor.commands.setTrackChangesEnabled(suggesting);
      editor.commands.insertContentAt(3, 'X');

      const records = suggestionsFromTrackedChanges(getTrackedChanges(editor));
      const format = records.find((record) => record.type === 'format');
      expect(format?.type).toBe('format');
      if (!format || format.type !== 'format') throw new Error('format record missing');
      expect(format.segments.map((segment) => segment.text).join('')).toBe('Hello');
      expect(format.segments.some((segment) => segment.text.includes('X'))).toBe(false);
      editor.destroy();

      // Markdown persists the now-applied bold but not review marks. This is
      // the equivalent clean document shape presented to restoreReviewMarks.
      editor = makeEditor('<p><strong>HeXllo</strong> world</p>');
      restoreReviewMarks(editor, [], records);

      let insertedMarks: string[] | null = null;
      editor.state.doc.descendants((node) => {
        if (node.isText && node.text === 'X') {
          insertedMarks = node.marks.map((mark) => mark.type.name);
        }
      });
      expect(insertedMarks).not.toContain('tracked_format');
    },
  );
});
