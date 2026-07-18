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
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { CommentMark } from '../../extensions/Comment';
import { sanitizeSuggestions } from '../../utils/annotationValidation';
import {
  mergeQuarantinedSuggestions,
  suggestionsFromTrackedChanges,
  restoreReviewMarks,
} from '../../utils/reviewPersistence';
import { reconcileCommentsWithDocument } from '../../utils/commentReconciler';
import { findAnnotationRange } from '../../extensions/AnnotationFocus';
import type {
  Comment,
  LegacyFormatSuggestion,
  LegacyTextSuggestion,
  LogicalSuggestion,
  TrackedChangeInfo,
  TrackedChangeSegment,
} from '../../types';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ code: false }),
      ReviewableCode,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      CommentMark,
    ],
    content,
  });
}

const comment = (overrides: Partial<Comment> = {}): Comment => ({
  id: 'cm1',
  anchorText: 'world',
  from: 7,
  to: 12,
  author: 'Reviewer',
  createdAt: '2026-07-11T18:00:00Z',
  resolved: false,
  kind: 'note',
  replies: [],
  ...overrides,
});

const hasCommentMark = (editor: Editor, id: string) =>
  findAnnotationRange(editor.state.doc, 'comment', id) !== null;

function makeChange(overrides: Partial<TrackedChangeInfo> = {}): TrackedChangeInfo {
  return {
    id: 'ch1',
    authorID: 'claude',
    status: 'pending',
    createdAt: Date.parse('2026-07-11T12:00:00Z'),
    segments: [{ kind: 'insert', from: 1, to: 6, text: 'Hello' }],
    ...overrides,
  };
}

function makeFormatChange(overrides: Partial<TrackedChangeInfo> = {}): TrackedChangeInfo {
  return {
    id: 'fmt1',
    authorID: 'claude',
    status: 'pending',
    createdAt: Date.parse('2026-07-11T12:00:00Z'),
    segments: [
      { kind: 'format', from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
      { kind: 'format', from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
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

  it('omits originCommentId when the change has none', () => {
    const [s] = suggestionsFromTrackedChanges([makeChange()]);
    expect('originCommentId' in s).toBe(false);
  });

  it('serializes a replacement as one logical record with both segments', () => {
    const [s] = suggestionsFromTrackedChanges([
      makeChange({
        originCommentId: 'c42',
        segments: [
          { kind: 'delete', from: 1, to: 6, text: 'Hello' },
          { kind: 'insert', from: 1, to: 3, text: 'Hi' },
        ],
      }),
    ]);
    expect(s).toMatchObject({
      id: 'ch1',
      type: 'change',
      originCommentId: 'c42',
      segments: [
        { kind: 'delete', from: 1, to: 6, text: 'Hello' },
        { kind: 'insert', from: 1, to: 3, text: 'Hi' },
      ],
    });
  });

  it('serializes every homogeneous span of a format change', () => {
    const [suggestion] = suggestionsFromTrackedChanges([
      makeFormatChange({ originCommentId: 'c42' }),
    ]);

    expect(suggestion).toEqual({
      id: 'fmt1',
      type: 'change',
      author: 'claude',
      createdAt: '2026-07-11T12:00:00.000Z',
      status: 'pending',
      originCommentId: 'c42',
      segments: [
        { kind: 'format', from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
        { kind: 'format', from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
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

  function suggestion(overrides: Partial<LegacyTextSuggestion> = {}): LegacyTextSuggestion {
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

  function formatSuggestion(
    overrides: Partial<LegacyFormatSuggestion> = {},
  ): LegacyFormatSuggestion {
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
    restoreReviewMarks(editor, [], [suggestion({ originCommentId: 'c42' })]);

    const [change] = getTrackedChanges(editor);
    expect(change).toMatchObject({
      id: 's1',
      originCommentId: 'c42',
      segments: [expect.objectContaining({ kind: 'insert', text: 'Hello' })],
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

  it('round-trips a pending hard-break deletion through the sidecar', () => {
    editor = makeEditor('<p>one<br>two</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    let hardBreakPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (hardBreakPos < 0 && node.type.name === 'hardBreak') hardBreakPos = pos;
    });
    expect(hardBreakPos).toBeGreaterThan(0);
    editor
      .chain()
      .setTextSelection({ from: hardBreakPos, to: hardBreakPos + 1 })
      .deleteSelection()
      .run();

    const records = suggestionsFromTrackedChanges(getTrackedChanges(editor));
    expect(records).toEqual([
      expect.objectContaining({
        type: 'change',
        segments: [expect.objectContaining({ kind: 'delete', text: '\n', nodeType: 'hardBreak' })],
      }),
    ]);
    editor.destroy();

    editor = makeEditor('<p>one<br>two</p>');
    const restored = restoreReviewMarks(editor, [], records);

    expect(restored).toMatchObject({ quarantinedSuggestions: [], mismatches: [] });
    let restoredBreakMarks: string[] | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') {
        restoredBreakMarks = node.marks.map((mark) => mark.type.name);
      }
    });
    expect(restoredBreakMarks).toContain('tracked_delete');
    expect(getTrackedChanges(editor)).toEqual([
      expect.objectContaining({
        segments: [expect.objectContaining({ kind: 'delete', text: '\n', nodeType: 'hardBreak' })],
      }),
    ]);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe('<p>onetwo</p>');
  });

  it('round-trips a pending hard-break insertion through the sidecar', () => {
    editor = makeEditor('<p>onetwo</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.commands.setTextSelection(4);
    editor.commands.setHardBreak();

    const records = suggestionsFromTrackedChanges(getTrackedChanges(editor));
    expect(records).toEqual([
      expect.objectContaining({
        type: 'change',
        segments: [expect.objectContaining({ kind: 'insert', text: '\n', nodeType: 'hardBreak' })],
      }),
    ]);
    editor.destroy();

    editor = makeEditor('<p>one<br>two</p>');
    const sanitized = sanitizeSuggestions(JSON.parse(JSON.stringify(records)) as unknown);
    expect(sanitized[0]).toMatchObject({
      segments: [expect.objectContaining({ text: '\n', nodeType: 'hardBreak' })],
    });
    expect(restoreReviewMarks(editor, [], sanitized)).toMatchObject({
      quarantinedSuggestions: [],
      mismatches: [],
    });
    let restoredBreakMarks: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'hardBreak') {
        restoredBreakMarks = node.marks.map((mark) => mark.type.name);
      }
    });
    expect(restoredBreakMarks).toContain('tracked_insert');
    editor.commands.rejectAllChanges();
    expect(editor.getHTML()).toBe('<p>onetwo</p>');
  });

  it('restores a legacy space-encoded hard-break segment', () => {
    editor = makeEditor('<p>one<br>two</p>');
    const legacy = {
      id: 'legacy-break',
      type: 'change' as const,
      author: 'claude',
      createdAt: '2026-07-11T12:00:00.000Z',
      status: 'pending' as const,
      segments: [{ kind: 'delete' as const, from: 4, to: 5, text: ' ' }],
    };

    expect(restoreReviewMarks(editor, [], [legacy])).toMatchObject({
      quarantinedSuggestions: [],
      mismatches: [],
    });
    expect(getTrackedChanges(editor)[0].segments).toEqual([
      expect.objectContaining({ kind: 'delete', text: '\n', nodeType: 'hardBreak' }),
    ]);
  });

  it('restores a legacy mixed text-and-break segment with its old space projection', () => {
    editor = makeEditor('<p>one<br>two</p>');
    const legacy = {
      id: 'legacy-mixed-break',
      type: 'change' as const,
      author: 'claude',
      createdAt: '2026-07-11T12:00:00.000Z',
      status: 'pending' as const,
      segments: [{ kind: 'delete' as const, from: 1, to: 8, text: 'one two' }],
    };

    expect(restoreReviewMarks(editor, [], [legacy])).toMatchObject({
      quarantinedSuggestions: [],
      mismatches: [],
    });
    expect(getTrackedChanges(editor)[0].segments).toEqual([
      expect.objectContaining({ kind: 'delete', text: 'one' }),
      expect.objectContaining({ kind: 'delete', text: '\n', nodeType: 'hardBreak' }),
      expect.objectContaining({ kind: 'delete', text: 'two' }),
    ]);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe('<p></p>');
  });

  it('quarantines a semantic hard-break segment when its range is ordinary text', () => {
    editor = makeEditor('<p>x</p>');
    const record = {
      id: 'mismatched-break',
      type: 'change' as const,
      author: 'claude',
      createdAt: '2026-07-11T12:00:00.000Z',
      status: 'pending' as const,
      segments: [
        {
          kind: 'insert' as const,
          from: 1,
          to: 2,
          text: '\n',
          nodeType: 'hardBreak' as const,
        },
      ],
    };

    const restored = restoreReviewMarks(editor, [], [record]);
    // A quarantined suggestion is now marked detached (non-authoritative for future loads).
    expect(restored.quarantinedSuggestions).toEqual([{ ...record, detached: true }]);
    expect(restored.mismatches).toEqual([
      expect.objectContaining({ suggestionId: 'mismatched-break', expected: '\n', actual: null }),
    ]);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('round-trips a format suggestion spanning a hard break without text-node semantics', () => {
    editor = makeEditor('<p>one<br>two</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.chain().setTextSelection({ from: 1, to: 8 }).setItalic().run();

    const records = suggestionsFromTrackedChanges(getTrackedChanges(editor));
    const formatSegments = records[0]?.type === 'change' ? records[0].segments : [];
    expect(formatSegments).toEqual([
      expect.objectContaining({ kind: 'format', text: 'one' }),
      expect.objectContaining({ kind: 'format', text: 'two' }),
    ]);
    for (const segment of formatSegments) expect(segment).not.toHaveProperty('nodeType');
    editor.destroy();

    editor = makeEditor('<p><em>one<br>two</em></p>');
    expect(restoreReviewMarks(editor, [], records)).toMatchObject({
      quarantinedSuggestions: [],
      mismatches: [],
    });
    expect(getTrackedChanges(editor)[0].segments).toEqual([
      expect.objectContaining({ kind: 'format', text: 'one' }),
      expect.objectContaining({ kind: 'format', text: 'two' }),
    ]);
  });

  it('restores disjoint format spans under one logical id with exact deltas', () => {
    editor = makeEditor('<p><strong>Hello</strong> <em>world</em></p>');
    restoreReviewMarks(editor, [], [formatSuggestion({ originCommentId: 'c42' })]);

    expect(getTrackedChanges(editor)).toEqual([
      expect.objectContaining({
        id: 'fmt1',
        authorID: 'claude',
        originCommentId: 'c42',
        segments: [
          { kind: 'format', from: 1, to: 6, text: 'Hello', adds: ['bold'], removes: [] },
          { kind: 'format', from: 7, to: 12, text: 'world', adds: [], removes: ['italic'] },
        ],
      }),
    ]);
  });

  it('round-trips a multi-span format change without aliasing its delta arrays', () => {
    const live = makeFormatChange({ originCommentId: 'c42' });
    const [record] = suggestionsFromTrackedChanges([live]);
    expect(record.type).toBe('change');
    if (record.type !== 'change') throw new Error('expected a logical suggestion');
    expect(record.segments).not.toBe(live.segments);
    const recordSegment = record.segments[0];
    const liveSegment = live.segments[0];
    if (recordSegment.kind !== 'format' || liveSegment.kind !== 'format') {
      throw new Error('expected format segments');
    }
    expect(recordSegment.adds).not.toBe(liveSegment.adds);

    editor = makeEditor('<p><strong>Hello</strong> <em>world</em></p>');
    restoreReviewMarks(editor, [], [record]);
    expect(getTrackedChanges(editor)[0]).toMatchObject({
      originCommentId: 'c42',
      segments: live.segments,
    });
  });

  it('quarantines a text suggestion whose stored text no longer matches the document', () => {
    editor = makeEditor('<p>Other world</p>');
    const before = editor.getJSON();

    const result = restoreReviewMarks(editor, [], [suggestion()]);

    expect(result.quarantinedSuggestions).toEqual([
      expect.objectContaining({
        id: 's1',
        type: 'change',
        segments: [expect.objectContaining({ kind: 'insert', text: 'Hello' })],
      }),
    ]);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ suggestionId: 's1', expected: 'Hello', actual: 'Other' }),
    ]);
    expect(getTrackedChanges(editor)).toEqual([]);
    editor.commands.acceptAllChanges();
    expect(editor.getJSON()).toEqual(before);
  });

  it('migrates and quarantines an entire legacy replacement when either half mismatches', () => {
    editor = makeEditor('<p>Old New</p>');
    const records: LegacyTextSuggestion[] = [
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

    expect(result.quarantinedSuggestions.map((record) => record.id)).toEqual(['pair-1']);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('migrates a valid legacy pair into one resolvable logical replacement', () => {
    editor = makeEditor('<p>Old New</p>');
    const records: LegacyTextSuggestion[] = [
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
        suggestedText: 'New',
        pairId: 'pair-1',
      }),
    ];

    expect(restoreReviewMarks(editor, [], records).mismatches).toEqual([]);
    const [change] = getTrackedChanges(editor);
    expect(change).toMatchObject({
      id: 'pair-1',
      segments: [
        expect.objectContaining({ kind: 'delete', text: 'Old' }),
        expect.objectContaining({ kind: 'insert', text: 'New' }),
      ],
    });
    editor.commands.resolveChange(change.id, 'accept');
    expect(editor.state.doc.textContent).toBe(' New');
  });

  it('quarantines every segment of a format suggestion when one segment mismatches', () => {
    editor = makeEditor('<p><strong>Hello</strong> <em>other</em></p>');

    const result = restoreReviewMarks(editor, [], [formatSuggestion()]);

    expect(result.quarantinedSuggestions).toEqual([
      expect.objectContaining({ id: 'fmt1', type: 'change' }),
    ]);
    expect(result.mismatches).toEqual([
      expect.objectContaining({ suggestionId: 'fmt1', expected: 'world', actual: 'other' }),
    ]);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('preserves quarantined records beside the live projection without duplicating ids', () => {
    const [quarantined] = suggestionsFromTrackedChanges([makeChange({ id: 'quarantined' })]);
    const [live] = suggestionsFromTrackedChanges([
      makeChange({
        id: 'live',
        segments: [{ kind: 'insert', from: 7, to: 12, text: 'world' }],
      }),
    ]);

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
      const format = records.find(
        (record) =>
          record.type === 'change' && record.segments.some((segment) => segment.kind === 'format'),
      );
      expect(format?.type).toBe('change');
      if (!format || format.type !== 'change') throw new Error('format record missing');
      const formatSegments = format.segments.filter((segment) => segment.kind === 'format');
      expect(formatSegments.map((segment) => segment.text).join('')).toBe('Hello');
      expect(formatSegments.some((segment) => segment.text.includes('X'))).toBe(false);
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

describe('restoreReviewMarks: bound/unbound modes (slice 3b)', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  const logical = (
    segments: TrackedChangeSegment[],
    overrides: object = {},
  ): LogicalSuggestion => ({
    id: 'sg1',
    author: 'claude',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    type: 'change',
    segments,
    ...overrides,
  });

  it('bound: validates a comment at its stored range and stamps it', () => {
    editor = makeEditor(); // "Hello world"; "world" at 7..12
    const result = restoreReviewMarks(editor, [comment()], [], 'bound');
    expect(hasCommentMark(editor, 'cm1')).toBe(true);
    expect(result.comments[0].detached).toBeUndefined();
    expect(result.detachedComments).toEqual([]);
  });

  it('bound: a comment whose anchor text no longer matches is detached, not stamped', () => {
    editor = makeEditor();
    const stale = comment({ anchorText: 'zzz' }); // text at [7,12] is "world"
    const result = restoreReviewMarks(editor, [stale], [], 'bound');
    expect(hasCommentMark(editor, 'cm1')).toBe(false);
    expect(result.comments[0].detached).toBe(true);
    expect(result.detachedComments.map((c) => c.id)).toEqual(['cm1']);
  });

  it('unbound: relocates a comment to a unique occurrence and clears detached', () => {
    editor = makeEditor();
    const drifted = comment({ from: 100, to: 105, detached: true }); // stale coords, still "world"
    const result = restoreReviewMarks(editor, [drifted], [], 'unbound');
    expect(hasCommentMark(editor, 'cm1')).toBe(true);
    expect(result.comments[0]).toMatchObject({ from: 7, to: 12 });
    expect(result.comments[0].detached).toBeUndefined();
    expect(result.relocatedComments.map((c) => c.id)).toEqual(['cm1']);
  });

  it('unbound: an ambiguous comment is detached, never guessed', () => {
    editor = makeEditor('<p>ab ab</p>');
    const result = restoreReviewMarks(
      editor,
      [comment({ anchorText: 'ab', from: 1, to: 3 })],
      [],
      'unbound',
    );
    expect(hasCommentMark(editor, 'cm1')).toBe(false);
    expect(result.comments[0].detached).toBe(true);
    expect(result.detachedComments.map((c) => c.id)).toEqual(['cm1']);
  });

  it('unbound: relocates a drifted suggestion and stamps it at the corrected position', () => {
    editor = makeEditor(); // "world" at 7..12
    const drifted = logical([{ kind: 'delete', from: 100, to: 105, text: 'world' }]);
    const result = restoreReviewMarks(editor, [], [drifted], 'unbound');
    expect(result.relocatedSuggestions.map((s) => s.id)).toEqual(['sg1']);
    expect(result.quarantinedSuggestions).toEqual([]);
    expect(getTrackedChanges(editor)).toHaveLength(1);
    expect(getTrackedChanges(editor)[0].segments[0]).toMatchObject({ from: 7, to: 12 });
  });

  it('unbound: an ambiguous suggestion is quarantined, not relocated', () => {
    editor = makeEditor('<p>ab ab</p>');
    const ambiguous = logical([{ kind: 'delete', from: 1, to: 3, text: 'ab' }]);
    const result = restoreReviewMarks(editor, [], [ambiguous], 'unbound');
    expect(result.relocatedSuggestions).toEqual([]);
    expect(result.quarantinedSuggestions.map((s) => s.id)).toEqual(['sg1']);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('regression: a detached comment survives the next editor update without a mark or reattachment', () => {
    editor = makeEditor('<p>ab ab</p>');
    const result = restoreReviewMarks(
      editor,
      [comment({ anchorText: 'ab', from: 1, to: 3 })],
      [],
      'unbound',
    );
    expect(result.comments[0].detached).toBe(true);

    // Simulate a subsequent editor update reconciling comments from live marks.
    const afterUpdate = reconcileCommentsWithDocument(result.comments, editor.state.doc);
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]).toMatchObject({ id: 'cm1', detached: true });
    expect(hasCommentMark(editor, 'cm1')).toBe(false); // still no mark, not reattached
  });

  it('unbound: a RESOLVED comment on repeated text is detached but stays resolved (no mark)', () => {
    editor = makeEditor('<p>ab ab</p>');
    const resolved = comment({ resolved: true, anchorText: 'ab', from: 1, to: 3 });
    const result = restoreReviewMarks(editor, [resolved], [], 'unbound');
    expect(result.comments[0]).toMatchObject({ resolved: true, detached: true });
    expect(hasCommentMark(editor, 'cm1')).toBe(false);
  });

  it('unbound: a RESOLVED comment with drifted coords is corrected but not stamped', () => {
    editor = makeEditor(); // "world" at 7..12
    const resolved = comment({ resolved: true, from: 100, to: 105 }); // stale coords, unique "world"
    const result = restoreReviewMarks(editor, [resolved], [], 'unbound');
    expect(result.comments[0]).toMatchObject({ resolved: true, from: 7, to: 12 });
    expect(result.comments[0].detached).toBeUndefined();
    expect(hasCommentMark(editor, 'cm1')).toBe(false); // resolved => no live mark
  });

  it('bound: a persisted detached comment never re-binds via its stale range (stays detached)', () => {
    // "ab" repeats; the stale range [1,3] contains "ab", but a detached record must go
    // through unique-only relocation even in bound mode — so it stays detached.
    editor = makeEditor('<p>ab ab</p>');
    const persistedDetached = comment({ anchorText: 'ab', from: 1, to: 3, detached: true });
    const result = restoreReviewMarks(editor, [persistedDetached], [], 'bound');
    expect(result.comments[0].detached).toBe(true);
    expect(hasCommentMark(editor, 'cm1')).toBe(false);
  });

  it('bound: an in-range code-block comment is detached, never silently no-op "restored"', () => {
    editor = makeEditor('<pre><code>codeword</code></pre>'); // "codeword" at 1..9
    const inCode = comment({ anchorText: 'codeword', from: 1, to: 9 });
    const result = restoreReviewMarks(editor, [inCode], [], 'bound');
    expect(result.comments[0].detached).toBe(true);
    expect(hasCommentMark(editor, 'cm1')).toBe(false);
  });

  it('bound: an in-range code-block suggestion is quarantined, never "restored"', () => {
    editor = makeEditor('<pre><code>codeword</code></pre>');
    const inCode = logical([{ kind: 'delete', from: 1, to: 9, text: 'codeword' }]);
    const result = restoreReviewMarks(editor, [], [inCode], 'bound');
    expect(result.quarantinedSuggestions.map((s) => s.id)).toEqual(['sg1']);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('bound: a resolved comment inside a code block is detached (eligibility ignores resolution)', () => {
    editor = makeEditor('<pre><code>codeword</code></pre>');
    const resolvedInCode = comment({ resolved: true, anchorText: 'codeword', from: 1, to: 9 });
    const result = restoreReviewMarks(editor, [resolvedInCode], [], 'bound');
    expect(result.comments[0]).toMatchObject({ resolved: true, detached: true });
    expect(hasCommentMark(editor, 'cm1')).toBe(false);
  });

  it('unbound: two suggestions relocating onto one span with excluding marks are both quarantined', () => {
    editor = makeEditor(); // one unique "world" at 7..12
    const ins = logical([{ kind: 'insert', from: 100, to: 105, text: 'world' }], { id: 'ins' });
    const del = logical([{ kind: 'delete', from: 200, to: 205, text: 'world' }], { id: 'del' });
    const result = restoreReviewMarks(editor, [], [ins, del], 'unbound');
    expect(result.relocatedSuggestions).toEqual([]);
    expect(result.quarantinedSuggestions.map((s) => s.id).sort()).toEqual(['del', 'ins']);
    expect(getTrackedChanges(editor)).toEqual([]); // zero marks stamped
  });

  it('unbound: a disjoint third suggestion survives while the conflicting pair is quarantined', () => {
    editor = makeEditor(); // "Hello" at 1..6, "world" at 7..12 (both unique)
    const ins = logical([{ kind: 'insert', from: 100, to: 105, text: 'world' }], { id: 'ins' });
    const del = logical([{ kind: 'delete', from: 200, to: 205, text: 'world' }], { id: 'del' });
    const third = logical([{ kind: 'delete', from: 300, to: 305, text: 'Hello' }], { id: 'third' });
    const result = restoreReviewMarks(editor, [], [ins, del, third], 'unbound');
    expect(result.relocatedSuggestions.map((s) => s.id)).toEqual(['third']);
    expect(result.quarantinedSuggestions.map((s) => s.id).sort()).toEqual(['del', 'ins']);
    expect(getTrackedChanges(editor).map((c) => c.id)).toEqual(['third']);
  });

  it('bound: a malformed sidecar with two conflicting suggestions on one span quarantines both', () => {
    editor = makeEditor(); // "world" at 7..12
    const ins = logical([{ kind: 'insert', from: 7, to: 12, text: 'world' }], { id: 'ins' });
    const del = logical([{ kind: 'delete', from: 7, to: 12, text: 'world' }], { id: 'del' });
    const result = restoreReviewMarks(editor, [], [ins, del], 'bound');
    expect(result.quarantinedSuggestions.map((s) => s.id).sort()).toEqual(['del', 'ins']);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('bound: one suggestion with INTERNALLY conflicting segments is quarantined', () => {
    editor = makeEditor(); // "world" at 7..12
    const malformed = logical(
      [
        { kind: 'insert', from: 7, to: 12, text: 'world' },
        { kind: 'delete', from: 7, to: 12, text: 'world' },
      ],
      { id: 'malf' },
    );
    const result = restoreReviewMarks(editor, [], [malformed], 'bound');
    expect(result.quarantinedSuggestions.map((s) => s.id)).toEqual(['malf']);
    expect(getTrackedChanges(editor)).toEqual([]);
  });

  it('a quarantined suggestion is marked detached (non-authoritative for future loads)', () => {
    editor = makeEditor(); // "world" at 7..12
    const stale = logical([{ kind: 'delete', from: 7, to: 12, text: 'zzz' }], { id: 'sg1' }); // text mismatch
    const result = restoreReviewMarks(editor, [], [stale], 'bound');
    expect(result.quarantinedSuggestions[0]).toMatchObject({ id: 'sg1', detached: true });
  });

  it('bound: a DETACHED suggestion relocates by unique text, never its stale stored range', () => {
    editor = makeEditor(); // "world" at 7..12
    // Detached record with a stale range: even in bound mode it must relocate by unique text.
    const detached = logical([{ kind: 'delete', from: 100, to: 105, text: 'world' }], {
      id: 'sg1',
      detached: true,
    });
    const result = restoreReviewMarks(editor, [], [detached], 'bound');
    expect(result.relocatedSuggestions.map((s) => s.id)).toEqual(['sg1']);
    expect(result.relocatedSuggestions[0].detached).toBeUndefined(); // cleared on re-anchor
    expect(getTrackedChanges(editor)[0].segments[0]).toMatchObject({ from: 7, to: 12 });
  });

  it('bound: a DETACHED suggestion on ambiguous text stays detached (quarantined)', () => {
    editor = makeEditor('<p>ab ab</p>');
    const detached = logical([{ kind: 'delete', from: 1, to: 3, text: 'ab' }], {
      id: 'sg1',
      detached: true,
    });
    const result = restoreReviewMarks(editor, [], [detached], 'bound');
    expect(result.quarantinedSuggestions[0]).toMatchObject({ id: 'sg1', detached: true });
    expect(getTrackedChanges(editor)).toEqual([]);
  });
});
