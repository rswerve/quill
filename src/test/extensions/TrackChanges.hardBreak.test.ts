import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import {
  getTrackedChanges,
  TRACKING_BLOCKED_META,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import type { TrackingBlockedInfo } from '../../extensions/TrackChanges';
import { projectTrackedDocument } from '../../extensions/trackChangesProjection';
import { planEdits } from '../../utils/trackedEdits';

const REVIEW_MARKS = new Set(['tracked_insert', 'tracked_delete', 'tracked_format']);
const mounted: Editor[] = [];

function makeEditor(content: string, suggesting: boolean): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      MarkdownImage,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
  editor.commands.setTrackChangesEnabled(suggesting);
  editor.commands.setTrackChangesAuthor('alice');
  mounted.push(editor);
  return editor;
}

function hardBreakPosition(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'hardBreak') found = pos;
  });
  if (found < 0) throw new Error('hard break missing');
  return found;
}

function replaceInlineContent(editor: Editor, replacement: string): void {
  const paragraph = editor.state.doc.firstChild;
  if (!paragraph) throw new Error('paragraph missing');
  editor
    .chain()
    .setTextSelection({ from: 1, to: 1 + paragraph.content.size })
    .insertContent(replacement)
    .run();
}

function deleteHardBreak(editor: Editor): void {
  const from = hardBreakPosition(editor);
  editor
    .chain()
    .setTextSelection({ from, to: from + 1 })
    .deleteSelection()
    .run();
}

function reviewMarks(editor: Editor): string[] {
  const marks: string[] = [];
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (REVIEW_MARKS.has(mark.type.name)) marks.push(mark.type.name);
    }
  });
  return marks;
}

function expectAcceptRejectParity(
  content: string,
  gesture: (editor: Editor) => void,
  inspectPending?: (editor: Editor) => void,
): void {
  const editing = makeEditor(content, false);
  const accepted = makeEditor(content, true);
  const rejected = makeEditor(content, true);
  const original = rejected.getJSON();

  gesture(editing);
  gesture(accepted);
  gesture(rejected);
  inspectPending?.(accepted);

  expect(projectTrackedDocument(accepted.state.doc).accepted.toJSON()).toEqual(editing.getJSON());
  accepted.commands.acceptAllChanges();
  expect(accepted.getJSON()).toEqual(editing.getJSON());
  expect(reviewMarks(accepted)).toEqual([]);

  rejected.commands.rejectAllChanges();
  expect(rejected.getJSON()).toEqual(original);
  expect(reviewMarks(rejected)).toEqual([]);
}

function captureBlocks(editor: Editor): TrackingBlockedInfo[] {
  const blocks: TrackingBlockedInfo[] = [];
  editor.on('transaction', ({ transaction }) => {
    const blocked = transaction.getMeta(TRACKING_BLOCKED_META) as TrackingBlockedInfo | undefined;
    if (blocked) blocks.push(blocked);
  });
  return blocks;
}

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

describe('TrackChanges hard-break tracking', () => {
  it('inserts a hard break with accepted/accept/reject parity', () => {
    expectAcceptRejectParity(
      '<p>onetwo</p>',
      (editor) => {
        editor.commands.setTextSelection(4);
        editor.commands.setHardBreak();
      },
      (editor) => {
        const hardBreak = editor.state.doc.nodeAt(hardBreakPosition(editor));
        expect(hardBreak?.marks.map((mark) => mark.type.name)).toContain('tracked_insert');
      },
    );
  });

  it('deletes only a hard break with accepted/accept/reject parity', () => {
    expectAcceptRejectParity('<p>one<br>two</p>', deleteHardBreak, (editor) => {
      const hardBreak = editor.state.doc.nodeAt(hardBreakPosition(editor));
      expect(hardBreak?.marks.map((mark) => mark.type.name)).toContain('tracked_delete');
    });
  });

  it('replaces text across a hard break as one logical suggestion', () => {
    expectAcceptRejectParity(
      '<p>one<br>two</p>',
      (editor) => replaceInlineContent(editor, 'combined'),
      (editor) => {
        const changes = getTrackedChanges(editor);
        expect(changes).toHaveLength(1);
        expect(new Set(changes[0].segments.map((segment) => segment.kind))).toEqual(
          new Set(['delete', 'insert']),
        );
        const hardBreak = editor.state.doc.nodeAt(hardBreakPosition(editor));
        expect(hardBreak?.marks.map((mark) => mark.type.name)).toContain('tracked_delete');
      },
    );
  });

  it('reuses a pending break deletion identity when the deletion expands across its text', () => {
    const editor = makeEditor('<p>one<br>two</p>', true);
    const original = editor.getJSON();
    deleteHardBreak(editor);
    const firstId = getTrackedChanges(editor)[0]?.id;
    expect(firstId).toBeTruthy();

    replaceInlineContent(editor, '');

    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe(firstId);
    expect(changes[0].segments).toEqual([
      expect.objectContaining({ kind: 'delete', from: 1, to: 8, text: 'one two' }),
    ]);
    editor.commands.rejectAllChanges();
    expect(editor.getJSON()).toEqual(original);
    expect(reviewMarks(editor)).toEqual([]);
  });

  it.each(['before', 'after'] as const)(
    'reuses a pending hard-break deletion identity for text immediately %s it',
    (side) => {
      const editor = makeEditor('<p>one<br>two</p>', true);
      const original = editor.getJSON();
      deleteHardBreak(editor);
      const firstId = getTrackedChanges(editor)[0]?.id;
      expect(firstId).toBeTruthy();
      const breakPos = hardBreakPosition(editor);
      const range =
        side === 'before'
          ? { from: breakPos - 1, to: breakPos }
          : { from: breakPos + 1, to: breakPos + 2 };

      editor.commands.deleteRange(range);

      expect(getTrackedChanges(editor).map((change) => change.id)).toEqual([firstId]);
      editor.commands.rejectAllChanges();
      expect(editor.getJSON()).toEqual(original);
      expect(reviewMarks(editor)).toEqual([]);
    },
  );

  it('removes an own pending inserted hard break instead of stacking a deletion', () => {
    const editor = makeEditor('<p>onetwo</p>', true);
    const original = editor.getJSON();
    editor.commands.setTextSelection(4);
    editor.commands.setHardBreak();
    expect(getTrackedChanges(editor)).toHaveLength(1);

    deleteHardBreak(editor);

    expect(editor.getJSON()).toEqual(original);
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(reviewMarks(editor)).toEqual([]);
  });

  it('keeps an already pending hard-break deletion stable', () => {
    const editor = makeEditor('<p>one<br>two</p>', true);
    deleteHardBreak(editor);
    const once = editor.getJSON();
    const [change] = getTrackedChanges(editor);

    deleteHardBreak(editor);

    expect(editor.getJSON()).toEqual(once);
    expect(getTrackedChanges(editor)).toEqual([change]);
  });

  it("blocks deleting another author's pending inserted hard break", () => {
    const editor = makeEditor('<p>onetwo</p>', true);
    editor.commands.setTrackChangesAuthor('bob');
    editor.commands.setTextSelection(4);
    editor.commands.setHardBreak();
    const before = editor.getJSON();
    const blocks = captureBlocks(editor);

    editor.commands.setTrackChangesAuthor('alice');
    deleteHardBreak(editor);

    expect(editor.getJSON()).toEqual(before);
    expect(blocks.at(-1)?.operation).toBe('foreignInsertionOverlap');
  });

  it("planner-blocks text edits touching another author's pending deleted hard break", () => {
    const editor = makeEditor('<p>one<br>two</p>', true);
    editor.commands.setTrackChangesAuthor('bob');
    deleteHardBreak(editor);
    const hardBreak = editor.state.doc.nodeAt(hardBreakPosition(editor));
    expect(hardBreak?.marks).toEqual([
      expect.objectContaining({
        type: expect.objectContaining({ name: 'tracked_delete' }),
        attrs: expect.objectContaining({
          dataTracked: expect.objectContaining({ authorID: 'bob', status: 'pending' }),
        }),
      }),
    ]);

    const planned = planEdits(
      editor.state.doc,
      0,
      editor.state.doc.content.size,
      [{ find: 'one two', replace: 'onetwo' }],
      'alice',
    );

    expect(planned.placed).toEqual([]);
    expect(planned.results).toEqual([
      expect.objectContaining({ status: 'conflict', reason: 'pending-suggestion' }),
    ]);
  });

  it('keeps images blocked and replacement newlines out of Slice 1', () => {
    const imageEditor = makeEditor(
      '<p>before<img src="https://example.com/pixel.png" alt="pixel">after</p>',
      true,
    );
    const imagePlan = planEdits(
      imageEditor.state.doc,
      0,
      imageEditor.state.doc.content.size,
      [{ find: 'before after', replace: 'combined' }],
      'alice',
    );
    expect(imagePlan.placed).toEqual([]);
    expect(imagePlan.results[0]).toMatchObject({ status: 'conflict', reason: 'engine-blocked' });

    const breakEditor = makeEditor('<p>one<br>two</p>', true);
    const newlinePlan = planEdits(
      breakEditor.state.doc,
      0,
      breakEditor.state.doc.content.size,
      [{ find: 'one two', replace: 'one\ntwo' }],
      'alice',
    );
    expect(newlinePlan.placed).toEqual([]);
    expect(newlinePlan.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'structural-change',
    });
  });
});
