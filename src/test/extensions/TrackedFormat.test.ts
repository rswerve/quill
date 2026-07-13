import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import type { TrackedChangeInfo, TrackedFormatSegment, TrackedTextSegment } from '../../types';

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content,
  });
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('alice');
  return editor;
}

type CanonicalFormatChange = Omit<TrackedChangeInfo, 'segments'> & {
  segments: TrackedFormatSegment[];
};

function formatChanges(editor: Editor): CanonicalFormatChange[] {
  return getTrackedChanges(editor).flatMap((change) => {
    const segments = change.segments.filter(
      (segment): segment is TrackedFormatSegment => segment.kind === 'format',
    );
    return segments.length === change.segments.length ? [{ ...change, segments }] : [];
  });
}

function textChanges(
  editor: Editor,
): Array<Omit<TrackedChangeInfo, 'segments'> & TrackedTextSegment & { operation: string }> {
  return getTrackedChanges(editor).flatMap((change) =>
    change.segments.flatMap((segment) =>
      segment.kind === 'format'
        ? []
        : [
            {
              id: change.id,
              authorID: change.authorID,
              status: change.status,
              createdAt: change.createdAt,
              ...(change.originCommentId ? { originCommentId: change.originCommentId } : {}),
              ...(change.originChatMessageId
                ? { originChatMessageId: change.originChatMessageId }
                : {}),
              ...segment,
              operation: segment.kind,
            },
          ],
    ),
  );
}

/** Whether the text node whose text is exactly `text` carries `markName`. */
function textHasMark(editor: Editor, text: string, markName: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.isText && node.text === text) {
      found = node.marks.some((mark) => mark.type.name === markName);
    }
  });
  return found;
}

/** Simplified view of a format change's segments for assertions. */
function segmentShapes(change: CanonicalFormatChange) {
  return change.segments.map(({ text, adds, removes }) => ({ text, adds, removes }));
}

describe('tracked formatting (suggesting mode)', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  it('bolding text mints one pending format suggestion in one dispatch', () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    let dispatched = 0;
    editor.on('transaction', () => dispatched++);

    editor.commands.toggleBold();
    expect(dispatched).toBe(1);
    // Selection survives the rebuilt transaction.
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    // The formatting itself is applied immediately…
    expect(textHasMark(editor, 'Hello', 'bold')).toBe(true);
    // …and the suggestion records the net delta.
    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0].authorID).toBe('alice');
    expect(changes[0].status).toBe('pending');
    expect(segmentShapes(changes[0])).toEqual([{ text: 'Hello', adds: ['bold'], removes: [] }]);
    expect(textChanges(editor)).toHaveLength(0);
  });

  it('undo reverts both the formatting and the marker in one step', () => {
    editor = makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    editor.commands.undo();
    expect(textHasMark(editor, 'Hello', 'bold')).toBe(false);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('only suggests where the format state actually changed on partial overlap', () => {
    editor = makeEditor('<p><strong>abc</strong>def</p>');
    editor.chain().setTextSelection({ from: 1, to: 7 }).toggleBold().run();

    expect(textHasMark(editor, 'abc', 'bold')).toBe(true);
    expect(textHasMark(editor, 'def', 'bold')).toBe(true);
    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([{ text: 'def', adds: ['bold'], removes: [] }]);

    editor.commands.rejectChange(changes[0].id);
    expect(textHasMark(editor, 'abc', 'bold')).toBe(true);
    expect(textHasMark(editor, 'def', 'bold')).toBe(false);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('unbolding suggests a remove delta; reject restores the bold', () => {
    editor = makeEditor('<p><strong>abcdef</strong></p>');
    editor.chain().setTextSelection({ from: 1, to: 7 }).unsetBold().run();

    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([{ text: 'abcdef', adds: [], removes: ['bold'] }]);
    expect(textHasMark(editor, 'abcdef', 'bold')).toBe(false);

    editor.commands.rejectChange(changes[0].id);
    expect(textHasMark(editor, 'abcdef', 'bold')).toBe(true);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('accepting an unbold keeps the removal and drops the marker', () => {
    editor = makeEditor('<p><strong>abcdef</strong></p>');
    editor.chain().setTextSelection({ from: 1, to: 7 }).unsetBold().run();

    const [change] = formatChanges(editor);
    editor.commands.acceptChange(change.id);
    expect(textHasMark(editor, 'abcdef', 'bold')).toBe(false);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('overlapping gestures split into homogeneous segments under one id', () => {
    editor = makeEditor('<p>abcdef</p>');
    editor.chain().setTextSelection({ from: 1, to: 5 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 3, to: 7 }).toggleItalic().run();

    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([
      { text: 'ab', adds: ['bold'], removes: [] },
      { text: 'cd', adds: ['bold', 'italic'], removes: [] },
      { text: 'ef', adds: ['italic'], removes: [] },
    ]);
  });

  it('a gesture that restores the original formatting cancels the suggestion', () => {
    editor = makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();

    expect(textHasMark(editor, 'Hello', 'bold')).toBe(false);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('one gesture bridging two prior suggestions unions them into one id', () => {
    editor = makeEditor('<p>abcdef</p>');
    editor.chain().setTextSelection({ from: 1, to: 3 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 5, to: 7 }).toggleBold().run();
    expect(formatChanges(editor)).toHaveLength(2);

    editor.chain().setTextSelection({ from: 1, to: 7 }).toggleItalic().run();
    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([
      { text: 'ab', adds: ['bold', 'italic'], removes: [] },
      { text: 'cd', adds: ['italic'], removes: [] },
      { text: 'ef', adds: ['bold', 'italic'], removes: [] },
    ]);
  });

  it('a disjoint multi-run gesture is one suggestion (unsetBold across runs)', () => {
    editor = makeEditor('<p><strong>ab</strong>cd<strong>ef</strong></p>');
    editor.chain().setTextSelection({ from: 1, to: 7 }).unsetBold().run();

    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([
      { text: 'ab', adds: [], removes: ['bold'] },
      { text: 'ef', adds: [], removes: ['bold'] },
    ]);
  });

  it("blocks only the spans owned by another author's pending format suggestion", () => {
    editor = makeEditor('<p>abcdef</p>');
    editor.chain().setTextSelection({ from: 1, to: 4 }).toggleBold().run();

    editor.commands.setTrackChangesAuthor('bob');
    let blockedMeta = false;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('trackedFormatBlocked')) blockedMeta = true;
    });
    editor.chain().setTextSelection({ from: 1, to: 7 }).toggleItalic().run();
    // The gesture that skipped foreign spans flags its transaction so the UI
    // can tell the user why part of the selection was left unchanged.
    expect(blockedMeta).toBe(true);

    // alice's span is untouched; bob's suggestion covers only the free text.
    expect(textHasMark(editor, 'abc', 'italic')).toBe(false);
    const changes = formatChanges(editor);
    expect(changes).toHaveLength(2);
    const alice = changes.find((c) => c.authorID === 'alice')!;
    const bob = changes.find((c) => c.authorID === 'bob')!;
    expect(segmentShapes(alice)).toEqual([{ text: 'abc', adds: ['bold'], removes: [] }]);
    expect(segmentShapes(bob)).toEqual([{ text: 'def', adds: ['italic'], removes: [] }]);
  });

  it('formatting your own pending insertion folds in raw, no format suggestion', () => {
    editor = makeEditor();
    editor.commands.insertContentAt(7, 'beautiful ');
    editor.chain().setTextSelection({ from: 7, to: 16 }).toggleBold().run();

    expect(textHasMark(editor, 'beautiful', 'bold')).toBe(true);
    expect(formatChanges(editor)).toHaveLength(0);
    // Still exactly one insertion suggestion.
    expect(textChanges(editor).filter((c) => c.operation === 'insert')).toHaveLength(1);
  });

  it('typing over a selection inside a format span keeps the marker off fresh text', () => {
    editor = makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();

    // Emulate real typing (which inherits marks across the replaced range,
    // unlike insertContent): replace "ell" with "X".
    const trSel = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 5));
    editor.view.dispatch(trSel);
    const trType = editor.state.tr.replaceSelectionWith(editor.schema.text('X'), true);
    editor.view.dispatch(trType);

    let xHasInsert = false;
    let xHasFormatMarker = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'X') {
        xHasInsert = node.marks.some((m) => m.type.name === 'tracked_insert');
        xHasFormatMarker = node.marks.some((m) => m.type.name === 'tracked_format');
      }
    });
    expect(xHasInsert).toBe(true);
    expect(xHasFormatMarker).toBe(false);
  });

  it('acceptAllChanges keeps the formatting and drops every marker', () => {
    editor = makeEditor('<p>abc def</p>');
    editor.chain().setTextSelection({ from: 1, to: 4 }).toggleBold().run();
    editor.chain().setTextSelection({ from: 5, to: 8 }).toggleItalic().run();

    editor.commands.acceptAllChanges();
    expect(textHasMark(editor, 'abc', 'bold')).toBe(true);
    expect(textHasMark(editor, 'def', 'italic')).toBe(true);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('rejectAllChanges inverts formatting before deleting rejected insertions', () => {
    editor = makeEditor('<p>abc def</p>');
    // A pending insertion BEFORE the formatted text: if reject-all deleted it
    // first, the format span's positions would shift and the inversion would
    // strike the wrong text.
    editor.commands.insertContentAt(1, 'NEW ');
    editor.chain().setTextSelection({ from: 9, to: 12 }).toggleBold().run();

    editor.commands.rejectAllChanges();
    expect(editor.state.doc.textContent).toBe('abc def');
    expect(textHasMark(editor, 'def', 'bold')).toBe(false);
    expect(getTrackedChanges(editor)).toHaveLength(0);
  });

  it('merges adjacent equal-delta spans split by unrelated mark boundaries', () => {
    editor = makeEditor('<p>a<em>b</em>c</p>');
    editor.chain().setTextSelection({ from: 1, to: 4 }).toggleBold().run();

    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    // Three text nodes (a / italic b / c) but one logical span in the read
    // model — same delta, contiguous.
    expect(segmentShapes(changes[0])).toEqual([{ text: 'abc', adds: ['bold'], removes: [] }]);
  });

  it('editing-mode unbold cancels the pending suggestion that added the bold', () => {
    // Codex adversarial repro: suggest bold, switch to Editing, unbold — the
    // stale marker kept advertising "bold added" over plain text and Accept /
    // Reject became indistinguishable.
    editor = makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    editor.commands.setTrackChangesEnabled(false);
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();

    expect(textHasMark(editor, 'Hello', 'bold')).toBe(false);
    expect(formatChanges(editor)).toHaveLength(0);

    // One undo restores the manual unbold AND the suggestion marker together.
    editor.commands.undo();
    expect(textHasMark(editor, 'Hello', 'bold')).toBe(true);
    expect(formatChanges(editor)).toHaveLength(1);
  });

  it('an independent editing-mode mark change never enters the suggestion delta', () => {
    editor = makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    editor.commands.setTrackChangesEnabled(false);
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleItalic().run();

    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([{ text: 'Hello', adds: ['bold'], removes: [] }]);

    // Rejecting the suggestion strips only its bold; the user's own italic stays.
    editor.commands.rejectChange(changes[0].id);
    expect(textHasMark(editor, 'Hello', 'bold')).toBe(false);
    expect(textHasMark(editor, 'Hello', 'italic')).toBe(true);
  });

  it('a partial editing-mode unbold shrinks the suggestion to the untouched span', () => {
    editor = makeEditor();
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    editor.commands.setTrackChangesEnabled(false);
    editor.chain().setTextSelection({ from: 1, to: 4 }).toggleBold().run();

    expect(textHasMark(editor, 'Hel', 'bold')).toBe(false);
    const changes = formatChanges(editor);
    expect(changes).toHaveLength(1);
    expect(segmentShapes(changes[0])).toEqual([{ text: 'lo', adds: ['bold'], removes: [] }]);
  });

  it('does not track formatting when suggesting mode is off', () => {
    editor = makeEditor();
    editor.commands.setTrackChangesEnabled(false);
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();

    expect(textHasMark(editor, 'Hello', 'bold')).toBe(true);
    expect(formatChanges(editor)).toHaveLength(0);
  });

  it('blocks link mark changes instead of committing them untracked', () => {
    editor = makeEditor();
    editor
      .chain()
      .setTextSelection({ from: 1, to: 6 })
      .setLink({ href: 'https://example.com' })
      .run();

    expect(textHasMark(editor, 'Hello', 'link')).toBe(false);
    expect(formatChanges(editor)).toHaveLength(0);
    expect(textChanges(editor)).toHaveLength(0);
  });
});
