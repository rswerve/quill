import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack, type BlockTrackOp } from '../../extensions/BlockTrack';
import { reconstructBlockUnions } from '../../utils/structuralReconstruction';
import {
  extractStructuralRecords,
  type StructuralRecordMetadata,
} from '../../utils/structuralExtraction';
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

const heading = (text: string) => ({
  type: 'heading',
  attrs: { level: 1 },
  content: [{ type: 'text', text }],
});
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

function docFrom(children: unknown[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content: children });
}
function fingerprintRange(doc: PMNode, index: number, count: number): string {
  const nodes: PMNode[] = [];
  for (let i = index; i < index + count; i += 1) nodes.push(doc.child(i));
  return serialize(Fragment.fromArray(nodes));
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

describe('extractStructuralRecords', () => {
  it('round-trips: extract from a reconstructed review doc reproduces the review doc', () => {
    const source = docFrom([heading('H0'), paragraph('keep'), heading('H2')]);
    const op = { kind: 'headingToParagraph', level: 1 } as const;
    const meta = new Map<string, StructuralRecordMetadata>([
      ['c0', { op, author: 'a', createdAt: '2026-01-01T00:00:00Z' }],
      ['c2', { op, author: 'b', createdAt: '2026-01-02T00:00:00Z', originCommentId: 'cm' }],
    ]);
    const original: StructuralSuggestionRecord[] = [
      {
        changeId: 'c0',
        author: 'a',
        createdAt: '2026-01-01T00:00:00Z',
        op,
        anchor: { parentPath: [], childIndex: 0, childCount: 1 },
        sourceFingerprint: fingerprintRange(source, 0, 1),
        proposed: [paragraph('H0')],
      },
      {
        changeId: 'c2',
        author: 'b',
        createdAt: '2026-01-02T00:00:00Z',
        op,
        originCommentId: 'cm',
        anchor: { parentPath: [], childIndex: 2, childCount: 1 },
        sourceFingerprint: fingerprintRange(source, 2, 1),
        proposed: [paragraph('H2')],
      },
    ];

    const reviewDoc = reconstructBlockUnions(source, original, serialize).doc;
    const extracted = extractStructuralRecords(reviewDoc, meta, serialize).sort((a, b) =>
      a.changeId.localeCompare(b.changeId),
    );

    expect(extracted.map((r) => r.changeId)).toEqual(['c0', 'c2']);
    expect(extracted.map((r) => r.anchor)).toEqual([
      { parentPath: [], childIndex: 0, childCount: 1 },
      { parentPath: [], childIndex: 2, childCount: 1 },
    ]);
    expect(extracted[0].sourceFingerprint).toBe(fingerprintRange(source, 0, 1));
    expect(extracted[0].op).toEqual({ kind: 'headingToParagraph', level: 1 });
    expect(extracted[1].originCommentId).toBe('cm');

    // Proposed content carries no review identity.
    for (const rec of extracted) {
      for (const node of rec.proposed) {
        expect((node.attrs as Record<string, unknown> | undefined)?.blockTrack).toBeUndefined();
      }
    }

    // Reconstructing from the extracted records reproduces the same review doc.
    const rebuilt = reconstructBlockUnions(source, extracted, serialize).doc;
    expect(topTexts(rebuilt)).toEqual(topTexts(reviewDoc));
    expect(topOps(rebuilt)).toEqual(topOps(reviewDoc));
  });

  it('skips a change with no matching metadata and an incomplete union', () => {
    // A union missing its insert branch, and a complete one lacking metadata.
    const reviewDoc = docFrom([
      {
        type: 'paragraph',
        attrs: { blockTrack: { changeId: 'lonely', op: 'delete' } },
        content: [{ type: 'text', text: 'x' }],
      },
      {
        type: 'heading',
        attrs: { level: 1, blockTrack: { changeId: 'full', op: 'delete' } },
        content: [{ type: 'text', text: 'y' }],
      },
      {
        type: 'paragraph',
        attrs: { blockTrack: { changeId: 'full', op: 'insert' } },
        content: [{ type: 'text', text: 'y' }],
      },
    ]);
    const meta = new Map<string, StructuralRecordMetadata>(); // no metadata for any change
    expect(extractStructuralRecords(reviewDoc, meta, serialize)).toEqual([]);
  });
});
