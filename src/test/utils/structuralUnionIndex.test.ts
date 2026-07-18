import { Editor, Extension, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  analyzeStructuralUnions,
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
    expect(union?.deleteRoot.node.type.name).toBe('heading');
    expect(union?.insertRoot.node.type.name).toBe('paragraph');
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
      name: 'duplicate delete branches',
      content: [
        heading('x', { changeId: 'c1', op: 'delete' }),
        heading('x', { changeId: 'c1', op: 'delete' }),
        paragraph('x', { changeId: 'c1', op: 'insert' }),
      ],
      code: 'branch-count',
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
