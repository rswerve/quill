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
import { projectTrackedDocument } from '../../extensions/trackChangesProjection';

const mounted: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content: '<p>alpha beta gamma</p>',
  });
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('claude');
  editor.commands.setTrackChangesOrigin({ chatMessageId: 'turn-1' });
  mounted.push(editor);
  return editor;
}

function makeReplacement(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.insertText('ALPHA', 1, 6));
}

function makeMixedChanges(editor: Editor): void {
  makeReplacement(editor);
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!');
  editor.chain().setTextSelection({ from: 8, to: 12 }).toggleBold().run();
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
      const accepted = projectTrackedDocument(editor.state.doc).accepted.toJSON();
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
      const accepted = projectTrackedDocument(editor.state.doc).accepted.toJSON();

      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.resolveChange(null, action);

      expect(editor.getJSON()).toEqual(action === 'accept' ? accepted : original);
      expect(getTrackedChanges(editor)).toEqual([]);
      editor.commands.undo();
      expect(editor.getJSON()).toEqual(beforeResolve);
    },
  );
});
