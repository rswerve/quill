import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack, type BlockTrackOp } from '../../extensions/BlockTrack';
import { projectBlockUnions } from '../../utils/blockUnionProjection';
import { reconstructBlockUnions } from '../../utils/structuralReconstruction';
import type { StructuralSuggestionRecord } from '../../types';

interface MarkdownStorage {
  markdown: { serializer: { serialize: (content: PMNode | Fragment) => string } };
}

let editor: Editor;
let serialize: (content: PMNode | Fragment) => string;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem,
      BlockTrack,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: '<p></p>',
  });
  const storage = editor.storage as unknown as MarkdownStorage;
  serialize = (content) => storage.markdown.serializer.serialize(content);
});

afterEach(() => editor.destroy());

const heading = (text: string, level = 1) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const bulletList = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })),
});

function docFrom(children: unknown[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content: children });
}

/** Fingerprint of a contiguous run of top-level source children. */
function fingerprintRange(doc: PMNode, index: number, count: number): string {
  const nodes: PMNode[] = [];
  for (let i = index; i < index + count; i += 1) nodes.push(doc.child(i));
  return serialize(Fragment.fromArray(nodes));
}

function record(
  over: Partial<StructuralSuggestionRecord> & {
    changeId: string;
    anchor: StructuralSuggestionRecord['anchor'];
    sourceFingerprint: string;
    proposed: StructuralSuggestionRecord['proposed'];
  },
): StructuralSuggestionRecord {
  return { author: 'a', createdAt: '2026-01-01T00:00:00Z', ...over };
}

function topTexts(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.textContent));
  return out;
}
function topOps(doc: PMNode): Array<BlockTrackOp | null> {
  const out: Array<BlockTrackOp | null> = [];
  doc.forEach((n) => out.push((n.attrs.blockTrack?.op as BlockTrackOp) ?? null));
  return out;
}

describe('reconstructBlockUnions', () => {
  it('rebuilds a heading→paragraph union and round-trips through the source projection', () => {
    const source = docFrom([heading('Title')]);
    const rec = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('Title')],
    });

    const { doc, quarantined } = reconstructBlockUnions(source, [rec], serialize);
    expect(quarantined).toEqual([]);
    expect(topTexts(doc)).toEqual(['Title', 'Title']);
    expect(topOps(doc)).toEqual(['delete', 'insert']);
    expect(doc.child(0).type.name).toBe('heading');
    expect(doc.child(1).type.name).toBe('paragraph');

    // The reconstructed review doc projects back to the exact source.
    const back = projectBlockUnions(doc, 'source').doc;
    expect(back.childCount).toBe(1);
    expect(back.child(0).type.name).toBe('heading');
  });

  it('R4: inserts proposed JSON directly so adjacent lists never coalesce', () => {
    const source = docFrom([bulletList(['A', 'B'])]);
    const rec = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [bulletList(['C'])],
    });

    const { doc } = reconstructBlockUnions(source, [rec], serialize);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('bulletList');
    expect(doc.child(0).childCount).toBe(2);
    expect(doc.child(1).type.name).toBe('bulletList');
    expect(doc.child(1).childCount).toBe(1);
  });

  it('reconstructs multiple disjoint unions in reverse source order, keeping middle content', () => {
    const source = docFrom([heading('H0'), paragraph('keep'), heading('H2')]);
    const recs = [
      record({
        changeId: 'c0',
        anchor: { parentPath: [], childIndex: 0, childCount: 1 },
        sourceFingerprint: fingerprintRange(source, 0, 1),
        proposed: [paragraph('H0')],
      }),
      record({
        changeId: 'c2',
        anchor: { parentPath: [], childIndex: 2, childCount: 1 },
        sourceFingerprint: fingerprintRange(source, 2, 1),
        proposed: [paragraph('H2')],
      }),
    ];

    const { doc, quarantined } = reconstructBlockUnions(source, recs, serialize);
    expect(quarantined).toEqual([]);
    expect(topTexts(doc)).toEqual(['H0', 'H0', 'keep', 'H2', 'H2']);
    expect(topOps(doc)).toEqual(['delete', 'insert', null, 'delete', 'insert']);
    expect(topTexts(projectBlockUnions(doc, 'source').doc)).toEqual(['H0', 'keep', 'H2']);
  });

  it('F5: quarantines a record whose source fingerprint no longer matches', () => {
    const source = docFrom([heading('Title')]);
    const rec = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: 'does-not-match',
      proposed: [paragraph('Title')],
    });

    const { doc, quarantined } = reconstructBlockUnions(source, [rec], serialize);
    expect(quarantined).toHaveLength(1);
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).attrs.blockTrack).toBeNull();
  });

  it('quarantines overlapping anchors without applying either', () => {
    const source = docFrom([heading('Title'), paragraph('x')]);
    const fp = fingerprintRange(source, 0, 1);
    const recs = [
      record({
        changeId: 'c1',
        anchor: { parentPath: [], childIndex: 0, childCount: 1 },
        sourceFingerprint: fp,
        proposed: [paragraph('a')],
      }),
      record({
        changeId: 'c2',
        anchor: { parentPath: [], childIndex: 0, childCount: 1 },
        sourceFingerprint: fp,
        proposed: [paragraph('b')],
      }),
    ];
    const { doc, quarantined } = reconstructBlockUnions(source, recs, serialize);
    expect(quarantined).toHaveLength(2);
    expect(doc.childCount).toBe(2);
  });

  it('trust boundary: quarantines an unknown node type and a nested blockTrack', () => {
    const source = docFrom([heading('Title')]);
    const fp = fingerprintRange(source, 0, 1);
    const unknown = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fp,
      proposed: [{ type: 'notARealNode', content: [] }],
    });
    const nestedFlag = record({
      changeId: 'c2',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fp,
      proposed: [
        {
          type: 'paragraph',
          attrs: { blockTrack: { changeId: 'x', op: 'insert' } },
          content: [{ type: 'text', text: 'Title' }],
        },
      ],
    });

    expect(reconstructBlockUnions(source, [unknown], serialize).quarantined).toHaveLength(1);
    expect(reconstructBlockUnions(source, [nestedFlag], serialize).quarantined).toHaveLength(1);
    expect(reconstructBlockUnions(source, [unknown], serialize).doc.childCount).toBe(1);
  });
});
