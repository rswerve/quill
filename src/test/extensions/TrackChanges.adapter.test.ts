import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';

const mounted: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content: '<p>alpha beta</p>',
  });
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('alice');
  mounted.push(editor);
  return editor;
}

describe('tracking transaction adapter', () => {
  afterEach(() => {
    for (const editor of mounted.splice(0)) editor.destroy();
  });

  it('preserves arbitrary metadata, time, scroll, stored marks, and the tracked selection', () => {
    const editor = makeEditor();
    let dispatched = editor.state.tr;
    editor.on('transaction', ({ transaction }) => {
      dispatched = transaction;
    });
    const bold = editor.schema.marks['bold'].create();
    const source = editor.state.tr
      .insertText('X', 3)
      .setMeta('customEnvelope', { requestId: 'request-1' })
      .setStoredMarks([bold])
      .setTime(12_345)
      .scrollIntoView();

    editor.view.dispatch(source);

    expect(dispatched.getMeta('customEnvelope')).toEqual({ requestId: 'request-1' });
    expect(dispatched.time).toBe(12_345);
    expect(dispatched.scrolledIntoView).toBe(true);
    expect(dispatched.storedMarks?.map((mark) => mark.type.name)).toEqual(['bold']);
    expect(dispatched.selection.from).toBe(4);
  });

  it('maps an explicitly changed selection for a mark-only transaction', () => {
    const editor = makeEditor();
    let dispatched = editor.state.tr;
    editor.on('transaction', ({ transaction }) => {
      dispatched = transaction;
    });
    const source = editor.state.tr.addMark(1, 6, editor.schema.marks['bold'].create());
    source.setSelection(TextSelection.create(source.doc, 7));

    editor.view.dispatch(source);

    expect(dispatched.selection.from).toBe(7);
    expect(dispatched.selection.empty).toBe(true);
  });
});
