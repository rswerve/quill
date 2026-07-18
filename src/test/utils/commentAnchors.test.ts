import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { CommentMark } from '../../extensions/Comment';
import { locateCommentForRepair, locateDetachedCommentAnchor } from '../../utils/commentAnchors';

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

describe('locateCommentForRepair', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it('a DETACHED record never trusts its stale range on repeated text (unique-only)', () => {
    editor = new Editor({
      extensions: [StarterKit, CommentMark],
      content: '<p>repeat</p><p>repeat</p>',
    });
    // Stored range [1,7] contains "repeat", but a detached record must relocate by unique
    // text — and "repeat" is ambiguous — so it must NOT bind there.
    expect(
      locateCommentForRepair(editor.state.doc, {
        anchorText: 'repeat',
        from: 1,
        to: 7,
        detached: true,
      }),
    ).toBeNull();
  });

  it('a DETACHED record relocates to a globally-unique occurrence', () => {
    editor = new Editor({
      extensions: [StarterKit, CommentMark],
      content: '<p>stale spot</p><p>unique moved anchor</p>',
    });
    expect(
      locateCommentForRepair(editor.state.doc, {
        anchorText: 'unique moved anchor',
        from: 1,
        to: 15,
        detached: true,
      }),
    ).toEqual({ from: 13, to: 32 });
  });

  it('a non-detached (resolved) record keeps the trust-stored-range rule', () => {
    editor = new Editor({
      extensions: [StarterKit, CommentMark],
      content: '<p>repeat</p><p>repeat</p>',
    });
    expect(
      locateCommentForRepair(editor.state.doc, {
        anchorText: 'repeat',
        from: 1,
        to: 7,
        detached: undefined,
      }),
    ).toEqual({ from: 1, to: 7 });
  });
});
