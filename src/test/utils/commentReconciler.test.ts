import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { CommentMark } from '../../extensions/Comment';
import type { Comment } from '../../types';
import { reconcileCommentsWithDocument } from '../../utils/commentReconciler';

const COMMENT: Comment = {
  id: 'c1',
  anchorText: 'hello',
  from: 8,
  to: 13,
  author: 'Reviewer',
  createdAt: '2026-07-11T18:00:00Z',
  resolved: false,
  replies: [],
};

function makeEditor() {
  const editor = new Editor({
    extensions: [StarterKit, CommentMark],
    content: '<p>prefix hello world</p>',
  });
  editor.commands.setCommentRange(COMMENT.id, COMMENT.from, COMMENT.to);
  return editor;
}

describe('reconcileCommentsWithDocument', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it('refreshes the stored range and quote from a shifted live mark', () => {
    editor = makeEditor();
    editor.commands.insertContentAt(1, 'XYZ');

    expect(reconcileCommentsWithDocument([COMMENT], editor.state.doc)).toEqual([
      { ...COMMENT, anchorText: 'hello', from: 11, to: 16 },
    ]);
  });

  it('keeps a partially surviving mark and shrinks its range and quote', () => {
    editor = makeEditor();
    editor.commands.deleteRange({ from: 11, to: 13 });

    expect(reconcileCommentsWithDocument([COMMENT], editor.state.doc)).toEqual([
      { ...COMMENT, anchorText: 'hel', from: 8, to: 11 },
    ]);
  });

  it('drops an unresolved comment after its whole marked range is deleted', () => {
    editor = makeEditor();
    editor.commands.deleteRange({ from: COMMENT.from, to: COMMENT.to });

    expect(reconcileCommentsWithDocument([COMMENT], editor.state.doc)).toEqual([]);
  });

  it('preserves a resolved comment even though resolved comments have no mark', () => {
    editor = new Editor({ extensions: [StarterKit, CommentMark], content: '<p>plain text</p>' });
    const resolved = { ...COMMENT, resolved: true };
    const comments = [resolved];

    const result = reconcileCommentsWithDocument(comments, editor.state.doc);

    expect(result).toBe(comments);
    expect(result).toEqual([resolved]);
  });

  it('preserves array and comment identity when the live snapshot is unchanged', () => {
    editor = makeEditor();
    const comments = [COMMENT];

    const result = reconcileCommentsWithDocument(comments, editor.state.doc);

    expect(result).toBe(comments);
    expect(result[0]).toBe(COMMENT);
  });
});
