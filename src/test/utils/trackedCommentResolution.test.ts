import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { CommentMark } from '../../extensions/Comment';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import type { Comment } from '../../types';
import {
  autoResolveCapturedComments,
  captureCommentsConsumedByTrackedRemoval,
} from '../../utils/trackedCommentResolution';

const COMMENT: Comment = {
  id: 'comment-1',
  anchorText: 'hello',
  from: 1,
  to: 6,
  author: 'Reviewer',
  createdAt: '2026-07-11T18:00:00Z',
  resolved: false,
  replies: [],
};

function makeEditor(content = '<p>hello world</p>') {
  return new Editor({
    extensions: [
      StarterKit,
      CommentMark,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
}

function applyReplacement(editor: Editor, from: number, to: number, replacement: string) {
  editor.commands.setCommentRange(COMMENT.id, COMMENT.from, COMMENT.to);
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('claude');
  editor.commands.setTrackChangesOrigin(COMMENT.id);
  editor.chain().setTextSelection({ from, to }).insertContent(replacement).run();
  editor.commands.setTrackChangesEnabled(false);
  editor.commands.setTrackChangesOrigin(null);
}

function replacementPairId(editor: Editor): string | undefined {
  const change = getTrackedChanges(editor).find(
    (candidate) => candidate.operation !== 'format' && candidate.pairId,
  );
  return change && change.operation !== 'format' ? change.pairId : undefined;
}

describe('tracked comment resolution', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it('captures a comment fully contained by one replacement deletion half', () => {
    editor = makeEditor();
    applyReplacement(editor, 1, 6, 'goodbye');
    const pairId = replacementPairId(editor);
    expect(pairId).toBeTruthy();

    expect(
      captureCommentsConsumedByTrackedRemoval(editor.state.doc, 'tracked_delete', pairId),
    ).toEqual([{ id: COMMENT.id, from: 8, to: 13, anchorText: 'hello' }]);
  });

  it('does not capture partial-overlap or non-overlap replacements', () => {
    editor = makeEditor();
    applyReplacement(editor, 2, 5, 'ipp');
    let pairId = replacementPairId(editor);
    expect(
      captureCommentsConsumedByTrackedRemoval(editor.state.doc, 'tracked_delete', pairId),
    ).toEqual([]);
    editor.destroy();

    editor = makeEditor();
    applyReplacement(editor, 7, 12, 'planet');
    pairId = replacementPairId(editor);
    expect(
      captureCommentsConsumedByTrackedRemoval(editor.state.doc, 'tracked_delete', pairId),
    ).toEqual([]);
  });

  it('captures a comment on an insertion that rejection will remove', () => {
    editor = makeEditor('<p></p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.commands.insertContentAt(1, 'hello');
    editor.commands.setTrackChangesEnabled(false);
    editor.commands.setCommentRange(COMMENT.id, 1, 6);
    const [insertion] = getTrackedChanges(editor);

    expect(
      captureCommentsConsumedByTrackedRemoval(editor.state.doc, 'tracked_insert', insertion.id),
    ).toEqual([{ id: COMMENT.id, from: 1, to: 6, anchorText: 'hello' }]);
  });

  it('auto-resolves from the pre-removal snapshot without mutating unrelated comments', () => {
    const other = { ...COMMENT, id: 'comment-2', anchorText: 'world', from: 7, to: 12 };
    const captured = [{ id: COMMENT.id, anchorText: 'hello', from: 8, to: 13 }];

    const result = autoResolveCapturedComments([COMMENT, other], captured);

    expect(result[0]).toEqual({ ...COMMENT, from: 8, to: 13, resolved: true });
    expect(result[1]).toBe(other);
  });
});
