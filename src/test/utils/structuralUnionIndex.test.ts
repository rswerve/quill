import { Editor, Extension, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  analyzeStructuralUnions,
  structuralOpShapeValid,
  type StructuralUnionIssueCode,
} from '../../utils/structuralUnionIndex';

const paragraph = (text: string, blockTrack?: unknown): JSONContent => ({
  type: 'paragraph',
  ...(blockTrack ? { attrs: { blockTrack } } : {}),
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

const heading = (text: string, blockTrack?: unknown): JSONContent => ({
  type: 'heading',
  attrs: { level: 1, ...(blockTrack ? { blockTrack } : {}) },
  content: [{ type: 'text', text }],
});

const item = (text: string, blockTrack?: unknown): JSONContent => ({
  type: 'listItem',
  ...(blockTrack ? { attrs: { blockTrack } } : {}),
  content: [paragraph(text)],
});

const bulletList = (items: JSONContent[], blockTrack?: unknown): JSONContent => ({
  type: 'bulletList',
  ...(blockTrack ? { attrs: { blockTrack } } : {}),
  content: items,
});

function makeEditor(content: JSONContent[], extra: Extension[] = []): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit, BlockTrack, ...extra],
    content: { type: 'doc', content },
  });
}

function issueCodes(editor: Editor): Set<string> {
  return new Set(analyzeStructuralUnions(editor.state.doc).issues.map((i) => i.code));
}

function codesFor(editor: Editor, changeId: string): Set<StructuralUnionIssueCode> {
  return new Set(
    analyzeStructuralUnions(editor.state.doc)
      .issues.filter((issue) => issue.changeId === changeId)
      .map((issue) => issue.code),
  );
}

describe('structuralOpShapeValid — per-op shape (V1 one-to-one, V2 N→M)', () => {
  const doc = makeEditor([paragraph('a'), paragraph('b'), heading('H'), bulletList([item('x')])])
    .state.doc;
  const p0 = doc.child(0);
  const p1 = doc.child(1);
  const h1 = doc.child(2);
  const list = doc.child(3);

  it('splitParagraph accepts one paragraph → ≥2 paragraphs, rejects other shapes', () => {
    const op = { kind: 'splitParagraph' as const };
    expect(structuralOpShapeValid(op, [p0], [p0, p1])).toBe(true);
    expect(structuralOpShapeValid(op, [p0], [p0, p1, p0])).toBe(true);
    expect(structuralOpShapeValid(op, [p0], [p0])).toBe(false); // needs ≥2 proposed
    expect(structuralOpShapeValid(op, [h1], [p0, p1])).toBe(false); // source not a paragraph
    expect(structuralOpShapeValid(op, [p0], [p0, h1])).toBe(false); // a proposed block isn't a paragraph
    expect(structuralOpShapeValid(op, [p0, p1], [p0, p1])).toBe(false); // needs exactly one source
  });

  it('mergeParagraphs accepts ≥2 paragraphs → one paragraph, rejects other shapes', () => {
    const op = { kind: 'mergeParagraphs' as const };
    expect(structuralOpShapeValid(op, [p0, p1], [p0])).toBe(true);
    expect(structuralOpShapeValid(op, [p0, p1, p0], [p0])).toBe(true);
    expect(structuralOpShapeValid(op, [p0], [p0])).toBe(false); // needs ≥2 source
    expect(structuralOpShapeValid(op, [p0, p1], [p0, p1])).toBe(false); // needs exactly one proposed
    expect(structuralOpShapeValid(op, [p0, h1], [p0])).toBe(false); // a source block isn't a paragraph
    expect(structuralOpShapeValid(op, [p0, p1], [h1])).toBe(false); // proposed not a paragraph
  });

  it('the four V1 ops still require exactly one source and one proposed block', () => {
    const h2p = { kind: 'headingToParagraph' as const, level: 1 as const };
    expect(structuralOpShapeValid(h2p, [h1], [p0])).toBe(true);
    expect(structuralOpShapeValid(h2p, [h1, h1], [p0])).toBe(false); // 2 source rejected
    expect(structuralOpShapeValid(h2p, [h1], [p0, p1])).toBe(false); // 2 proposed rejected
    expect(
      structuralOpShapeValid({ kind: 'listToParagraph', listType: 'bulletList' }, [list], [p0]),
    ).toBe(true);
  });
});

describe('analyzeStructuralUnions', () => {
  it('indexes one exact V1 union in review and source coordinates', () => {
    const editor = makeEditor([
      paragraph('before'),
      heading('Title', { changeId: 'c1', op: 'delete' }),
      paragraph('Title', { changeId: 'c1', op: 'insert' }),
      paragraph('after'),
    ]);
    const metadata = new Map([
      ['c1', { op: { kind: 'headingToParagraph' as const, level: 1 as const } }],
    ]);

    const index = analyzeStructuralUnions(editor.state.doc, metadata);
    const union = index.persistable.get('c1');
    expect(index.issues).toEqual([]);
    expect([...index.allIdentityIds]).toEqual(['c1']);
    expect([...index.topologyValid]).toHaveLength(1);
    expect(union?.sourceChildIndex).toBe(1);
    expect(union?.sourceChildCount).toBe(1);
    expect(union?.deleteRoots[0].node.type.name).toBe('heading');
    expect(union?.insertRoots[0].node.type.name).toBe('paragraph');
    editor.destroy();
  });

  it('separates topology validity from metadata presence and op validity', () => {
    const editor = makeEditor([
      heading('Title', { changeId: 'c1', op: 'delete' }),
      paragraph('Title', { changeId: 'c1', op: 'insert' }),
    ]);

    const missing = analyzeStructuralUnions(editor.state.doc, new Map());
    expect(missing.topologyValid.has('c1')).toBe(true);
    expect(missing.missingMetadataIds).toEqual(new Set(['c1']));
    expect(missing.persistable.size).toBe(0);

    const wrongOp = analyzeStructuralUnions(
      editor.state.doc,
      new Map([['c1', { op: { kind: 'paragraphToHeading' as const, level: 1 as const } }]]),
    );
    expect(wrongOp.topologyValid.has('c1')).toBe(true);
    expect(wrongOp.persistable.size).toBe(0);
    expect(wrongOp.issues.map((issue) => issue.code)).toContain('operation-shape');
    editor.destroy();
  });

  it.each([
    {
      name: 'a lone branch',
      content: [heading('x', { changeId: 'c1', op: 'delete' })],
      code: 'branch-count',
    },
    {
      name: 'an insert branch with no delete',
      content: [
        paragraph('x', { changeId: 'c1', op: 'insert' }),
        paragraph('y', { changeId: 'c1', op: 'insert' }),
      ],
      code: 'branch-count',
    },
    {
      name: 'interleaved delete/insert/delete',
      content: [
        paragraph('a', { changeId: 'c1', op: 'delete' }),
        paragraph('b', { changeId: 'c1', op: 'insert' }),
        paragraph('c', { changeId: 'c1', op: 'delete' }),
      ],
      code: 'branch-order',
    },
    {
      name: 'insert before delete',
      content: [
        paragraph('x', { changeId: 'c1', op: 'insert' }),
        heading('x', { changeId: 'c1', op: 'delete' }),
      ],
      code: 'branch-order',
    },
    {
      name: 'nonadjacent branches',
      content: [
        heading('x', { changeId: 'c1', op: 'delete' }),
        paragraph('intervening'),
        paragraph('x', { changeId: 'c1', op: 'insert' }),
      ],
      code: 'non-adjacent',
    },
  ])('refuses $name', ({ content, code }) => {
    const editor = makeEditor(content);
    const index = analyzeStructuralUnions(editor.state.doc);
    expect(index.allIdentityIds.has('c1')).toBe(true);
    expect(index.topologyValid.has('c1')).toBe(false);
    expect(index.issues.map((issue) => issue.code)).toContain(code);
    editor.destroy();
  });

  it('accepts a V2 merge topology (K delete roots immediately followed by one insert)', () => {
    const editor = makeEditor([
      paragraph('A', { changeId: 'm1', op: 'delete' }),
      paragraph('B', { changeId: 'm1', op: 'delete' }),
      paragraph('A B', { changeId: 'm1', op: 'insert' }),
    ]);
    const union = analyzeStructuralUnions(editor.state.doc).topologyValid.get('m1');
    expect(union).toBeDefined();
    expect(union?.deleteRoots).toHaveLength(2);
    expect(union?.insertRoots).toHaveLength(1);
    expect(union?.sourceChildCount).toBe(2);
    expect(union?.sourceChildIndex).toBe(0);
    editor.destroy();
  });

  it('accepts a V2 split topology (one delete root immediately followed by M inserts)', () => {
    const editor = makeEditor([
      paragraph('alpha beta', { changeId: 's1', op: 'delete' }),
      paragraph('alpha', { changeId: 's1', op: 'insert' }),
      paragraph('beta', { changeId: 's1', op: 'insert' }),
    ]);
    const union = analyzeStructuralUnions(editor.state.doc).topologyValid.get('s1');
    expect(union).toBeDefined();
    expect(union?.deleteRoots).toHaveLength(1);
    expect(union?.insertRoots).toHaveLength(2);
    expect(union?.sourceChildCount).toBe(1);
    editor.destroy();
  });

  it('refuses branches under different parents', () => {
    const editor = makeEditor([
      bulletList([item('old', { changeId: 'c1', op: 'delete' })]),
      bulletList([item('new', { changeId: 'c1', op: 'insert' })]),
    ]);
    expect(codesFor(editor, 'c1')).toContain('different-parent');
    expect(analyzeStructuralUnions(editor.state.doc).topologyValid.has('c1')).toBe(false);
    editor.destroy();
  });

  it('detects nested identities even when the ancestor footprint would hide them', () => {
    const editor = makeEditor([
      bulletList(
        [
          item('old', { changeId: 'nested', op: 'delete' }),
          item('new', { changeId: 'nested', op: 'insert' }),
        ],
        { changeId: 'outer', op: 'delete' },
      ),
      paragraph('replacement', { changeId: 'outer', op: 'insert' }),
    ]);
    expect(codesFor(editor, 'outer')).toContain('nested-identity');
    expect(codesFor(editor, 'nested')).toContain('nested-identity');
    expect(analyzeStructuralUnions(editor.state.doc).topologyValid.size).toBe(0);
    editor.destroy();
  });

  it('marks interleaved union envelopes as overlapping', () => {
    const editor = makeEditor([
      heading('a', { changeId: 'a', op: 'delete' }),
      heading('b', { changeId: 'b', op: 'delete' }),
      paragraph('a', { changeId: 'a', op: 'insert' }),
      paragraph('b', { changeId: 'b', op: 'insert' }),
    ]);
    expect(codesFor(editor, 'a')).toEqual(new Set(['non-adjacent', 'overlapping-unions']));
    expect(codesFor(editor, 'b')).toEqual(new Set(['non-adjacent', 'overlapping-unions']));
    editor.destroy();
  });

  it('refuses malformed identities and roots outside the trackable policy', () => {
    const UnsafeCodeTrack = Extension.create({
      name: 'unsafeCodeTrackFixture',
      addGlobalAttributes() {
        return [
          {
            types: ['codeBlock'],
            attributes: { blockTrack: { default: null, rendered: false } },
          },
        ];
      },
    });
    const malformed = makeEditor([
      heading('x', { changeId: 'bad', op: 'rewrite' }),
      paragraph('x'),
    ]);
    expect(issueCodes(malformed)).toContain('invalid-identity');
    expect(analyzeStructuralUnions(malformed.state.doc).allIdentityIds.has('bad')).toBe(true);
    malformed.destroy();

    const untrackable = makeEditor(
      [
        {
          type: 'codeBlock',
          attrs: { blockTrack: { changeId: 'code', op: 'delete' } },
          content: [{ type: 'text', text: 'x' }],
        },
        paragraph('x', { changeId: 'code', op: 'insert' }),
      ],
      [UnsafeCodeTrack],
    );
    expect(codesFor(untrackable, 'code')).toContain('untrackable-root');
    expect(analyzeStructuralUnions(untrackable.state.doc).topologyValid.has('code')).toBe(false);
    untrackable.destroy();
  });
});
