import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { locateDetachedCommentAnchor } from '../../utils/commentAnchors';

describe('locateDetachedCommentAnchor', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it('keeps a validated stored range even when the same text occurs elsewhere', () => {
    editor = new Editor({ extensions: [StarterKit], content: '<p>repeat</p><p>repeat</p>' });

    expect(
      locateDetachedCommentAnchor(editor.state.doc, {
        anchorText: 'repeat',
        from: 1,
        to: 7,
      }),
    ).toEqual({ from: 1, to: 7 });
  });

  it('finds an anchor that moved to one unique location', () => {
    editor = new Editor({
      extensions: [StarterKit],
      content: '<p>stale position</p><p>unique moved anchor</p>',
    });

    expect(
      locateDetachedCommentAnchor(editor.state.doc, {
        anchorText: 'unique moved anchor',
        from: 1,
        to: 15,
      }),
    ).toEqual({ from: 17, to: 36 });
  });

  it('rejects missing and ambiguous anchors instead of guessing', () => {
    editor = new Editor({ extensions: [StarterKit], content: '<p>repeat</p><p>repeat</p>' });

    expect(
      locateDetachedCommentAnchor(editor.state.doc, {
        anchorText: 'repeat',
        from: 3,
        to: 5,
      }),
    ).toBeNull();
    expect(
      locateDetachedCommentAnchor(editor.state.doc, {
        anchorText: 'missing',
        from: 1,
        to: 8,
      }),
    ).toBeNull();
  });
});
