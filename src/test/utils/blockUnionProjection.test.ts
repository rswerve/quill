import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack, type BlockTrackOp } from '../../extensions/BlockTrack';
import { projectBlockUnions } from '../../utils/blockUnionProjection';

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
    content: text ? [{ type: 'text', text }] : [],
  };
}

function bulletList(items: string[], op?: BlockTrackOp, changeId = 'c1') {
  return {
    type: 'bulletList',
    ...(op ? { attrs: { blockTrack: { changeId, op } } } : {}),
    content: items.map((text) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    })),
  };
}

function docFrom(children: unknown[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content: children });
}

function topOps(doc: PMNode): Array<BlockTrackOp | null> {
  const ops: Array<BlockTrackOp | null> = [];
  doc.forEach((node) => ops.push((node.attrs.blockTrack?.op as BlockTrackOp) ?? null));
  return ops;
}

function topTexts(doc: PMNode): string[] {
  const texts: string[] = [];
  doc.forEach((node) => texts.push(node.textContent));
  return texts;
}

// A split union: original paragraph struck, two proposed paragraphs inserted.
const splitUnion = () => [
  para('Hello world', 'delete'),
  para('Hello', 'insert'),
  para('world', 'insert'),
];

describe('projectBlockUnions', () => {
  it('review keeps both branches and their identity untouched', () => {
    const doc = docFrom(splitUnion());
    const projection = projectBlockUnions(doc, 'review');
    expect(projection.doc).toBe(doc);
    expect(projection.removedBranchRanges).toEqual([]);
    expect(projection.mapping.maps).toHaveLength(0);
    expect(topOps(projection.doc)).toEqual(['delete', 'insert', 'insert']);
  });

  it('source keeps the original branch and clears its identity (INV1 shape)', () => {
    const doc = docFrom(splitUnion());
    const { doc: projected, removedBranchRanges } = projectBlockUnions(doc, 'source');
    expect(topTexts(projected)).toEqual(['Hello world']);
    expect(topOps(projected)).toEqual([null]);
    expect(removedBranchRanges).toHaveLength(2);
  });

  it('accepted keeps the proposed branch and clears its identity (INV2 shape)', () => {
    const doc = docFrom(splitUnion());
    const { doc: projected, removedBranchRanges } = projectBlockUnions(doc, 'accepted');
    expect(topTexts(projected)).toEqual(['Hello', 'world']);
    expect(topOps(projected)).toEqual([null, null]);
    expect(removedBranchRanges).toHaveLength(1);
  });

  it('merges a list to a paragraph on accept and restores the exact list on source', () => {
    const doc = docFrom([bulletList(['A', 'B'], 'delete'), para('A B', 'insert')]);

    const accepted = projectBlockUnions(doc, 'accepted').doc;
    expect(accepted.childCount).toBe(1);
    expect(accepted.child(0).type.name).toBe('paragraph');
    expect(accepted.child(0).textContent).toBe('A B');

    const source = projectBlockUnions(doc, 'source').doc;
    expect(source.childCount).toBe(1);
    expect(source.child(0).type.name).toBe('bulletList');
    expect(source.child(0).childCount).toBe(2);
    expect(source.child(0).attrs.blockTrack).toBeNull();
  });

  it('maps a surviving position forward and collapses a removed-branch position', () => {
    const doc = docFrom(splitUnion());
    // Positions in review coords: [0..13) struck "Hello world", [13..20) ins
    // "Hello" (text at 14), [20..27) ins "world".
    const { mapping } = projectBlockUnions(doc, 'accepted');
    // The struck original branch [0,13) is removed; everything after shifts by 13.
    expect(mapping.map(14)).toBe(1); // inside surviving "Hello"
    expect(mapping.map(5)).toBe(0); // inside the removed branch → collapses to the boundary
  });

  it('leaves a clean document unchanged in every mode', () => {
    const doc = docFrom([para('just text')]);
    for (const mode of ['review', 'source', 'accepted'] as const) {
      const { doc: projected, removedBranchRanges } = projectBlockUnions(doc, mode);
      expect(topTexts(projected)).toEqual(['just text']);
      expect(removedBranchRanges).toEqual([]);
    }
  });
});
