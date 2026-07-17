import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';

const mounted: Editor[] = [];

function makeEditor(suggesting = true): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content: '<p>alpha beta gamma</p>',
  });
  editor.commands.setTrackChangesEnabled(suggesting);
  editor.commands.setTrackChangesAuthor('claude');
  editor.commands.setTrackChangesOrigin({ chatMessageId: 'turn-1' });
  mounted.push(editor);
  return editor;
}

function makeReplacement(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.insertText('ALPHA', 1, 6));
}

function textRange(editor: Editor, find: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isText) return;
    const offset = node.text?.indexOf(find) ?? -1;
    if (offset >= 0) range = { from: pos + offset, to: pos + offset + find.length };
  });
  if (!range) throw new Error(`missing test text: ${find}`);
  return range;
}

function makeMixedChanges(editor: Editor): void {
  makeReplacement(editor);
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!');
  // Address the same accepted-content word in both modes. Raw positions differ
  // in Suggesting mode because the replaced "alpha" remains as review-only
  // deleted text until resolution.
  editor.chain().setTextSelection(textRange(editor, 'beta')).toggleBold().run();
}

describe('logical change resolution', () => {
  afterEach(() => {
    for (const editor of mounted.splice(0)) editor.destroy();
  });

  it.each(['accept', 'reject'] as const)(
    'resolves one replacement with both halves and one-step undo (%s)',
    (action) => {
      const editor = makeEditor();
      const original = editor.getJSON();
      makeReplacement(editor);
      const beforeResolve = editor.getJSON();
      const editing = makeEditor(false);
      makeReplacement(editing);
      const accepted = editing.getJSON();
      const id = getTrackedChanges(editor)[0].id;

      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.resolveChange(id, action);

      expect(editor.getJSON()).toEqual(action === 'accept' ? accepted : original);
      expect(getTrackedChanges(editor)).toEqual([]);
      editor.commands.undo();
      expect(editor.getJSON()).toEqual(beforeResolve);
    },
  );

  it.each(['accept', 'reject'] as const)(
    'resolves every text and format card in one reverse-position transaction (%s)',
    (action) => {
      const editor = makeEditor();
      const original = editor.getJSON();
      makeMixedChanges(editor);
      const beforeResolve = editor.getJSON();
      const editing = makeEditor(false);
      makeMixedChanges(editing);
      const accepted = editing.getJSON();

      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.resolveChange(null, action);

      expect(editor.getJSON()).toEqual(action === 'accept' ? accepted : original);
      expect(getTrackedChanges(editor)).toEqual([]);
      editor.commands.undo();
      expect(editor.getJSON()).toEqual(beforeResolve);
    },
  );
});
