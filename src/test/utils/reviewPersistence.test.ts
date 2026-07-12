import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { suggestionsFromTrackedChanges, restoreReviewMarks } from '../../utils/reviewPersistence';
import type { Suggestion, TrackedTextChange } from '../../types';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackChanges],
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

describe('suggestionsFromTrackedChanges', () => {
  it('carries originCommentId through to the sidecar record', () => {
    const [s] = suggestionsFromTrackedChanges([makeChange({ originCommentId: 'c42' })]);
    expect(s.originCommentId).toBe('c42');
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
    expect(s.pairId).toBe('p1');
    expect(s.originCommentId).toBe('c42');
  });
});

describe('restoreReviewMarks', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
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
});
