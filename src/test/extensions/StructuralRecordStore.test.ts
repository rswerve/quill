import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  StructuralRecordStore,
  activeRecords,
  retainedRecords,
  activeStructuralChangeIds,
  orphanStructuralChangeIds,
  canMintChangeId,
  addStructuralRecord,
  resetStructuralRecords,
  type CanonicalRecord,
} from '../../extensions/StructuralRecordStore';

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [StarterKit, BlockTrack, StructuralRecordStore],
    content: '<h1>Title</h1>',
  });
});

afterEach(() => editor.destroy());

const record = (changeId: string): CanonicalRecord => ({
  changeId,
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'a',
  createdAt: '2026-01-01T00:00:00Z',
});

/** Mint a heading->paragraph union on the first block and add its canonical record. */
function mint(changeId: string) {
  const { state } = editor;
  const heading = state.doc.child(0);
  const tr = state.tr;
  tr.setNodeMarkup(0, undefined, { ...heading.attrs, blockTrack: { changeId, op: 'delete' } });
  tr.insert(
    heading.nodeSize,
    state.schema.nodes.paragraph.create(
      { blockTrack: { changeId, op: 'insert' } },
      state.schema.text(heading.textContent),
    ),
  );
  addStructuralRecord(tr, record(changeId));
  editor.view.dispatch(tr);
}

describe('StructuralRecordStore', () => {
  it('records metadata on mint and marks the change active', () => {
    mint('c1');
    expect(activeStructuralChangeIds(editor.state.doc)).toEqual(new Set(['c1']));
    expect(activeRecords(editor.state).map((r) => r.changeId)).toEqual(['c1']);
  });

  it('retains metadata across Undo (inactive) and restores it on Redo (active)', () => {
    mint('c1');
    const minted = retainedRecords(editor.state).get('c1');

    editor.commands.undo();
    expect(activeStructuralChangeIds(editor.state.doc).size).toBe(0);
    expect(retainedRecords(editor.state).get('c1')).toBe(minted); // retained, immutable
    expect(activeRecords(editor.state)).toEqual([]);

    editor.commands.redo();
    expect(activeStructuralChangeIds(editor.state.doc)).toEqual(new Set(['c1']));
    expect(activeRecords(editor.state)[0]).toBe(minted); // same immutable metadata
  });

  it('never prunes a retained record, so a change id is not reusable even while inactive', () => {
    mint('c1');
    editor.commands.undo();
    expect(canMintChangeId(editor.state, 'c1')).toBe(false);
    expect(canMintChangeId(editor.state, 'c2')).toBe(true);
  });

  it('reset replaces the whole map (New/Open) instead of merging', () => {
    mint('c1');
    editor.view.dispatch(resetStructuralRecords(editor.state.tr, []));
    expect(retainedRecords(editor.state).size).toBe(0);
  });

  it('flags a live union with no retained record as an orphan (save must fail closed)', () => {
    const { state } = editor;
    const heading = state.doc.child(0);
    const tr = state.tr;
    tr.setNodeMarkup(0, undefined, {
      ...heading.attrs,
      blockTrack: { changeId: 'orphan', op: 'delete' },
    });
    tr.insert(
      heading.nodeSize,
      state.schema.nodes.paragraph.create(
        { blockTrack: { changeId: 'orphan', op: 'insert' } },
        state.schema.text('Title'),
      ),
    );
    editor.view.dispatch(tr); // no addStructuralRecord
    expect(orphanStructuralChangeIds(editor.state)).toEqual(['orphan']);
    expect(activeRecords(editor.state)).toEqual([]);
  });
});
