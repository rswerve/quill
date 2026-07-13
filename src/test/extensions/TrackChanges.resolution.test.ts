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

function makeEditor(transformEngine: 'modular' | 'legacy'): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges.configure({ transformEngine }),
    ],
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

function resolveLegacy(editor: Editor, action: 'accept' | 'reject', all: boolean): void {
  if (all) {
    if (action === 'accept') editor.commands.acceptAllChanges();
    else editor.commands.rejectAllChanges();
    return;
  }
  const [change] = getTrackedChanges(editor);
  if (action === 'accept') editor.commands.acceptChange(change.id);
  else editor.commands.rejectChange(change.id);
}

describe('logical change resolution equivalence', () => {
  afterEach(() => {
    for (const editor of mounted.splice(0)) editor.destroy();
  });

  it.each(['accept', 'reject'] as const)(
    'resolves one replacement with both halves and one-step undo (%s)',
    (action) => {
      const modular = makeEditor('modular');
      const legacy = makeEditor('legacy');
      makeReplacement(modular);
      makeReplacement(legacy);
      const beforeResolve = modular.getJSON();
      const id = getTrackedChanges(modular)[0].id;

      modular.view.dispatch(closeHistory(modular.state.tr));
      legacy.view.dispatch(closeHistory(legacy.state.tr));
      modular.commands.resolveChange(id, action);
      resolveLegacy(legacy, action, false);

      expect(modular.getJSON()).toEqual(legacy.getJSON());
      expect(getTrackedChanges(modular)).toEqual([]);
      modular.commands.undo();
      expect(modular.getJSON()).toEqual(beforeResolve);
    },
  );

  it.each(['accept', 'reject'] as const)(
    'resolves every text and format card in the legacy back-to-front order (%s)',
    (action) => {
      const modular = makeEditor('modular');
      const legacy = makeEditor('legacy');
      makeMixedChanges(modular);
      makeMixedChanges(legacy);
      const beforeResolve = modular.getJSON();

      modular.view.dispatch(closeHistory(modular.state.tr));
      legacy.view.dispatch(closeHistory(legacy.state.tr));
      modular.commands.resolveChange(null, action);
      resolveLegacy(legacy, action, true);

      expect(modular.getJSON()).toEqual(legacy.getJSON());
      expect(getTrackedChanges(modular)).toEqual([]);
      modular.commands.undo();
      expect(modular.getJSON()).toEqual(beforeResolve);
    },
  );
});
