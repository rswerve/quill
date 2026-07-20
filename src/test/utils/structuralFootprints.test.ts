import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack, type BlockTrackOp } from '../../extensions/BlockTrack';
import {
  structuralFootprints,
  rangesIntersect,
  footprintsIntersecting,
  lockedChangeIds,
} from '../../utils/structuralFootprints';

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [StarterKit, TaskList, TaskItem, BlockTrack],
    content: '<p></p>',
  });
});

afterEach(() => editor.destroy());

function para(text: string, op?: BlockTrackOp, changeId = 'c1') {
  return {
    type: 'paragraph',
    ...(op ? { attrs: { blockTrack: { changeId, op } } } : {}),
    content: [{ type: 'text', text }],
  };
}

// [clean 0..7) [old delete 7..12) [new insert 12..17) [trailing 17..27)
function unionDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [para('clean'), para('old', 'delete'), para('new', 'insert'), para('trailing')],
  });
}

describe('structuralFootprints', () => {
  it('collects each flagged block with its change id, op, and range', () => {
    expect(structuralFootprints(unionDoc())).toEqual([
      { changeId: 'c1', op: 'delete', from: 7, to: 12 },
      { changeId: 'c1', op: 'insert', from: 12, to: 17 },
    ]);
  });

  it('finds no footprints in a clean document', () => {
    const clean = editor.schema.nodeFromJSON({ type: 'doc', content: [para('just text')] });
    expect(structuralFootprints(clean)).toEqual([]);
  });

  it('treats ranges as half-open — adjacent branches do not intersect', () => {
    expect(rangesIntersect(7, 12, 12, 17)).toBe(false);
    expect(rangesIntersect(0, 7, 7, 12)).toBe(false);
    expect(rangesIntersect(8, 13, 7, 12)).toBe(true);
  });

  it('reports the footprints and change ids a range intersects', () => {
    const doc = unionDoc();
    const prints = structuralFootprints(doc);
    expect(footprintsIntersecting(prints, 8, 10)).toEqual([
      { changeId: 'c1', op: 'delete', from: 7, to: 12 },
    ]);
    expect(footprintsIntersecting(prints, 1, 3)).toEqual([]);
    expect(lockedChangeIds(doc, 8, 10)).toEqual(new Set(['c1']));
    expect(lockedChangeIds(doc, 1, 3)).toEqual(new Set());
    // A range spanning both branches of the union reports the one change id.
    expect(lockedChangeIds(doc, 8, 15)).toEqual(new Set(['c1']));
  });
});
