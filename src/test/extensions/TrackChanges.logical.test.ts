import { Editor } from '@tiptap/core';
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

function makeEditor(content = '<p>Hello world</p>'): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content,
  });
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('alice');
  mounted.push(editor);
  return editor;
}

describe('logical tracked-change model', () => {
  afterEach(() => {
    for (const editor of mounted.splice(0)) editor.destroy();
  });

  it('collects one replacement change with delete and insert segments', () => {
    const editor = makeEditor();
    editor.view.dispatch(editor.state.tr.insertText('Hi', 1, 6));

    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect([...changes[0].segments].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      expect.objectContaining({ kind: 'delete', text: 'Hello' }),
      expect.objectContaining({ kind: 'insert', text: 'Hi' }),
    ]);
  });
});
