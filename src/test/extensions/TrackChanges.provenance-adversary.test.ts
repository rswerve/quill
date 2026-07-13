import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import type { TrackedTextChange } from '../../types';

describe('provenance adversary', () => {
  let editor: Editor;

  afterEach(() => editor.destroy());

  it('does not coalesce adjacent user typing into a Claude-origin insertion after reset', () => {
    editor = new Editor({
      extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackChanges],
      content: '<p>Hello</p>',
    });
    editor.commands.setTrackChangesEnabled(true);

    editor.commands.setTrackChangesAuthor('claude');
    editor.commands.setTrackChangesOrigin('comment-1');
    editor.commands.insertContentAt(6, ' AI');

    editor.commands.setTrackChangesAuthor('anonymous');
    editor.commands.setTrackChangesOrigin(null);
    editor.commands.insertContentAt(9, ' user');

    const inserts = getTrackedChanges(editor).filter(
      (change): change is TrackedTextChange => change.operation === 'insert',
    );
    expect(inserts).toHaveLength(2);
    expect(
      inserts.map(({ authorID, originCommentId, text }) => ({ authorID, originCommentId, text })),
    ).toEqual([
      { authorID: 'claude', originCommentId: 'comment-1', text: ' AI' },
      { authorID: 'anonymous', originCommentId: undefined, text: ' user' },
    ]);
  });

  it('stamps chat provenance and does not coalesce adjacent edits from different turns', () => {
    editor = new Editor({
      extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackChanges],
      content: '<p></p>',
    });
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');

    editor.commands.setTrackChangesOrigin({ chatMessageId: 'chat-1' });
    editor.commands.insertContentAt(1, 'first');
    editor.commands.setTrackChangesOrigin({ chatMessageId: 'chat-2' });
    editor.commands.insertContentAt(6, 'second');
    editor.commands.setTrackChangesOrigin(null);

    const inserts = getTrackedChanges(editor).filter(
      (change): change is TrackedTextChange => change.operation === 'insert',
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map(({ originChatMessageId, text }) => ({ originChatMessageId, text }))).toEqual(
      [
        { originChatMessageId: 'chat-1', text: 'first' },
        { originChatMessageId: 'chat-2', text: 'second' },
      ],
    );
  });
});
