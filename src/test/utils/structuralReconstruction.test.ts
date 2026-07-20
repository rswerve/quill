import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack, type BlockTrackOp } from '../../extensions/BlockTrack';
import { projectBlockUnions } from '../../utils/blockUnionProjection';
import { reconstructBlockUnions } from '../../utils/structuralReconstruction';
import type { StructuralOp, StructuralSuggestionRecord } from '../../types';

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
  return {
    author: 'a',
    createdAt: '2026-01-01T00:00:00Z',
    op: { kind: 'headingToParagraph', level: 1 },
    ...over,
  };
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
    // paragraph->list inserts a list immediately before an existing list; a
    // Markdown reparse would merge them, direct node insertion keeps them separate.
    const source = docFrom([paragraph('AB'), bulletList(['X'])]);
    const rec = record({
      changeId: 'c1',
      op: { kind: 'paragraphToList', listType: 'bulletList' },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [bulletList(['AB'])],
    });

    const { doc } = reconstructBlockUnions(source, [rec], serialize);
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(doc.child(1).type.name).toBe('bulletList');
    expect(doc.child(1).childCount).toBe(1);
    expect(doc.child(2).type.name).toBe('bulletList');
    expect(doc.child(2).childCount).toBe(1);
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

  it('quarantines a tampered multi-item list→paragraph proposal that drops an item', () => {
    // The 3-item list's fingerprint matches, but the persisted proposal is "one two" — the
    // LAST item's content is gone. validateRecord re-runs content conservation at the
    // RECONSTRUCTION boundary (not just at mint), so the tamper quarantines rather than
    // silently accepting a card that would drop "three" on Accept. Pins the all-item
    // conservation defense against an untrusted sidecar.
    const source = docFrom([bulletList(['one', 'two', 'three'])]);
    const tampered = record({
      changeId: 'c1',
      op: { kind: 'listToParagraph', listType: 'bulletList' },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('one two')], // "three" dropped
    });
    const { doc, quarantined } = reconstructBlockUnions(source, [tampered], serialize);
    expect(quarantined).toHaveLength(1);
    expect(doc.childCount).toBe(1); // no union built
    expect(doc.child(0).type.name).toBe('bulletList');
    expect(doc.child(0).attrs.blockTrack).toBeNull();
  });

  it('reconstructs the SAME list→paragraph when the proposal conserves every item (control)', () => {
    const source = docFrom([bulletList(['one', 'two', 'three'])]);
    const honest = record({
      changeId: 'c1',
      op: { kind: 'listToParagraph', listType: 'bulletList' },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('one two three')],
    });
    const { doc, quarantined } = reconstructBlockUnions(source, [honest], serialize);
    expect(quarantined).toEqual([]);
    expect(topOps(doc)).toEqual(['delete', 'insert']);
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(doc.child(1).textContent).toBe('one two three');
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

describe('reconstructBlockUnions hardening', () => {
  it('maps positions across a paragraph->list union', () => {
    const source = docFrom([paragraph('AB'), paragraph('tail')]);
    const rec = record({
      changeId: 'c1',
      op: { kind: 'paragraphToList', listType: 'bulletList' },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [bulletList(['AB'])],
    });
    const { doc, mapping, restored } = reconstructBlockUnions(source, [rec], serialize);
    expect(restored).toHaveLength(1);
    expect(topTexts(doc)).toEqual(['AB', 'AB', 'tail']);
    expect(topOps(doc)).toEqual(['delete', 'insert', null]);
    const insertedSize = doc.child(1).nodeSize; // the proposed bulletList
    expect(mapping.map(1)).toBe(1); // inside source "AB", before the insertion at pos 4
    expect(mapping.map(5)).toBe(5 + insertedSize); // inside "tail": shifted by the inserted list
    expect(topTexts(projectBlockUnions(doc, 'source').doc)).toEqual(['AB', 'tail']);
    expect(topTexts(projectBlockUnions(doc, 'accepted').doc)).toEqual(['AB', 'tail']);
  });

  it('R3: a valid record still reconstructs when another is quarantined', () => {
    const source = docFrom([heading('H0'), heading('H2')]);
    const good = record({
      changeId: 'g',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('H0')],
    });
    const bad = record({
      changeId: 'b',
      anchor: { parentPath: [], childIndex: 1, childCount: 1 },
      sourceFingerprint: 'wrong',
      proposed: [paragraph('H2')],
    });
    const { doc, restored, quarantined } = reconstructBlockUnions(source, [good, bad], serialize);
    expect(restored.map((r) => r.changeId)).toEqual(['g']);
    expect(quarantined).toEqual([bad]);
    expect(topTexts(doc)).toEqual(['H0', 'H0', 'H2']);
  });

  it('quarantines an untrackable proposed root and a bare listItem', () => {
    const source = docFrom([paragraph('x')]);
    const anchor = { parentPath: [] as number[], childIndex: 0, childCount: 1 };
    const fp = fingerprintRange(source, 0, 1);
    const codeBlock = record({
      changeId: 'c',
      anchor,
      sourceFingerprint: fp,
      proposed: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }],
    });
    const bareItem = record({
      changeId: 'l',
      anchor,
      sourceFingerprint: fp,
      proposed: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
        },
      ],
    });
    expect(reconstructBlockUnions(source, [codeBlock], serialize).quarantined).toHaveLength(1);
    expect(reconstructBlockUnions(source, [bareItem], serialize).quarantined).toHaveLength(1);
    expect(reconstructBlockUnions(source, [codeBlock], serialize).doc.childCount).toBe(1);
  });

  it('quarantines an untrackable source root', () => {
    const source = docFrom([{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }]);
    const rec = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('x')],
    });
    expect(reconstructBlockUnions(source, [rec], serialize).quarantined).toHaveLength(1);
  });

  it('quarantines every record sharing a duplicate changeId', () => {
    const source = docFrom([heading('H0'), heading('H2')]);
    const r1 = record({
      changeId: 'dup',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('H0')],
    });
    const r2 = record({
      changeId: 'dup',
      anchor: { parentPath: [], childIndex: 1, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 1, 1),
      proposed: [paragraph('H2')],
    });
    const { doc, quarantined, restored } = reconstructBlockUnions(source, [r1, r2], serialize);
    expect(quarantined).toHaveLength(2);
    expect(restored).toHaveLength(0);
    expect(doc.childCount).toBe(2);
  });

  it('does not let a typed-valid record adopt an id duplicated by a malformed raw record', () => {
    const source = docFrom([heading('H0')]);
    const valid = record({
      changeId: 'dup',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('H0')],
    });
    const malformed = { changeId: 'dup', proposed: 'not-json' };
    const { doc, quarantined, restored } = reconstructBlockUnions(
      source,
      [valid, malformed],
      serialize,
    );

    expect(restored).toEqual([]);
    expect(quarantined).toEqual([malformed, valid]);
    expect(doc.eq(source)).toBe(true);
  });

  it('quarantines forbidden marks and unknown attributes in proposed JSON', () => {
    const source = docFrom([paragraph('x')]);
    const anchor = { parentPath: [] as number[], childIndex: 0, childCount: 1 };
    const fp = fingerprintRange(source, 0, 1);
    const forbiddenMark = record({
      changeId: 'm',
      anchor,
      sourceFingerprint: fp,
      proposed: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'tracked_insert' }] }],
        },
      ],
    });
    const unknownAttr = record({
      changeId: 'u',
      anchor,
      sourceFingerprint: fp,
      proposed: [
        { type: 'paragraph', attrs: { bogus: 1 }, content: [{ type: 'text', text: 'x' }] },
      ],
    });
    expect(reconstructBlockUnions(source, [forbiddenMark], serialize).quarantined).toHaveLength(1);
    expect(reconstructBlockUnions(source, [unknownAttr], serialize).quarantined).toHaveLength(1);
  });

  it('quarantines an unknown inline node nested inside proposed content', () => {
    const source = docFrom([paragraph('x')]);
    const rec = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [{ type: 'paragraph', content: [{ type: 'notAnInlineNode' }] }],
    });
    expect(reconstructBlockUnions(source, [rec], serialize).quarantined).toHaveLength(1);
    expect(reconstructBlockUnions(source, [rec], serialize).doc.childCount).toBe(1);
  });

  it('quarantines hostile leaf-node and mark attributes in proposed JSON', () => {
    const source = docFrom([paragraph('x')]);
    const anchor = { parentPath: [] as number[], childIndex: 0, childCount: 1 };
    const fp = fingerprintRange(source, 0, 1);
    const hostile = [
      // nested hardBreak with an unknown attribute
      [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak', attrs: { bogus: 1 } },
          ],
        },
      ],
      // nested hardBreak with an injected blockTrack
      [{ type: 'paragraph', content: [{ type: 'hardBreak', attrs: { blockTrack: null } }] }],
      // text with a bold mark carrying an unknown attribute
      [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [{ type: 'bold', attrs: { bogus: 1 } }] }],
        },
      ],
      // link mark with an unknown attribute
      [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a',
              marks: [{ type: 'link', attrs: { href: 'https://x', bogus: 1 } }],
            },
          ],
        },
      ],
      // a mark name absent from the schema (separate from the review-mark denylist)
      [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a', marks: [{ type: 'notInThisSchema' }] }],
        },
      ],
    ];
    for (const proposed of hostile) {
      const rec = record({ changeId: 'c1', anchor, sourceFingerprint: fp, proposed });
      const result = reconstructBlockUnions(source, [rec], serialize);
      expect(result.quarantined).toHaveLength(1);
      expect(result.restored).toHaveLength(0);
    }
  });

  it('quarantines invalid ops and op/shape mismatches', () => {
    const headingSrc = docFrom([heading('Title')]);
    const paraSrc = docFrom([paragraph('Title')]);
    const twoItemSrc = docFrom([bulletList(['a', 'b'])]);
    const a = { parentPath: [] as number[], childIndex: 0, childCount: 1 };
    const orderedList = [
      { type: 'orderedList', content: [{ type: 'listItem', content: [paragraph('x')] }] },
    ];
    const q = (src: PMNode, op: unknown, proposed: unknown[]) =>
      reconstructBlockUnions(
        src,
        [
          record({
            changeId: 'c',
            op: op as StructuralOp,
            anchor: a,
            sourceFingerprint: fingerprintRange(src, 0, 1),
            proposed: proposed as StructuralSuggestionRecord['proposed'],
          }),
        ],
        serialize,
      ).quarantined.length;

    expect(q(headingSrc, { kind: 'nope' }, [paragraph('Title')])).toBe(1); // invalid kind
    expect(q(headingSrc, { kind: 'headingToParagraph', level: 9 }, [paragraph('Title')])).toBe(1); // bad level
    expect(q(headingSrc, { kind: 'paragraphToHeading', level: 1 }, [heading('Title')])).toBe(1); // source mismatch
    expect(q(headingSrc, { kind: 'headingToParagraph', level: 2 }, [paragraph('Title')])).toBe(1); // level mismatch
    expect(q(paraSrc, { kind: 'paragraphToList', listType: 'bulletList' }, orderedList)).toBe(1); // listType mismatch
    expect(
      q(twoItemSrc, { kind: 'listToParagraph', listType: 'bulletList' }, [paragraph('x')]),
    ).toBe(1); // not single-item
    expect(q(headingSrc, { kind: 'headingToParagraph', level: 1 }, [paragraph('Title')])).toBe(0); // valid op reconstructs
  });

  it('quarantines malformed runtime records without throwing', () => {
    const source = docFrom([paragraph('x')]);
    const fp = fingerprintRange(source, 0, 1);
    const hostile = [
      {
        changeId: 'f',
        anchor: { parentPath: [], childIndex: 0.5, childCount: 1 },
        sourceFingerprint: fp,
        proposed: [paragraph('x')],
      },
      { changeId: 'n', sourceFingerprint: fp, proposed: [paragraph('x')] },
      {
        changeId: 'p',
        anchor: { parentPath: [], childIndex: 0, childCount: 1 },
        sourceFingerprint: fp,
        proposed: 'nope',
      },
    ];
    const { doc, quarantined } = reconstructBlockUnions(source, hostile, serialize);
    expect(quarantined).toHaveLength(3);
    expect(doc.childCount).toBe(1);
  });

  it('leaves no residual blockTrack after resolving either projection', () => {
    const source = docFrom([heading('Title')]);
    const rec = record({
      changeId: 'c1',
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: fingerprintRange(source, 0, 1),
      proposed: [paragraph('Title')],
    });
    const { doc } = reconstructBlockUnions(source, [rec], serialize);
    for (const mode of ['source', 'accepted'] as const) {
      let residual = false;
      projectBlockUnions(doc, mode).doc.descendants((n) => {
        if (n.attrs.blockTrack) residual = true;
      });
      expect(residual).toBe(false);
    }
  });
});
