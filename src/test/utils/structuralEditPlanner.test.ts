import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { planStructuralEdits } from '../../utils/structuralEditPlanner';
import type { QuillStructuralEdit } from '../../types';

/**
 * 6b-1 / V1b: the pure structural-edit planner. Locates the target block by find
 * text, derives the directional StructuralOp from (current type, requested `to`),
 * and returns source-coordinate geometry — or a typed refusal. Plans heading↔paragraph
 * and FLAT-list↔paragraph (any item count, all three list types); a list with
 * nested/multi-block items, a list-kind change, and a heading-level change refuse
 * `unsupported-op`.
 */

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [StarterKit.configure({ trailingNode: false }), TaskList, TaskItem],
    content: '<p></p>',
  });
});

afterEach(() => editor.destroy());

function docOf(content: unknown[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content });
}

const heading = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const bullet = (text: string) => ({
  type: 'bulletList',
  content: [{ type: 'listItem', content: [para(text)] }],
});
const ordered = (text: string) => ({
  type: 'orderedList',
  content: [{ type: 'listItem', content: [para(text)] }],
});
const task = (text: string) => ({
  type: 'taskList',
  content: [{ type: 'taskItem', attrs: { checked: false }, content: [para(text)] }],
});

/** Build a (possibly malformed) structural edit without fighting the strict type. */
const edit = (find: string, structural: unknown): QuillStructuralEdit =>
  ({ find, structural }) as unknown as QuillStructuralEdit;

describe('planStructuralEdits', () => {
  it('plans heading → paragraph, deriving the source level and target geometry', () => {
    const doc = docOf([para('intro'), heading(2, 'Section'), para('body')]);
    const { placed, results } = planStructuralEdits(doc, [edit('Section', { to: 'paragraph' })]);

    expect(results[0].status).toBe('planned');
    expect(placed).toHaveLength(1);
    expect(placed[0].op).toEqual({ kind: 'headingToParagraph', level: 2 });
    // sourceTargetPos is strictly inside the target block's [from, to).
    expect(placed[0].sourceTarget.from).toBeLessThan(placed[0].sourceTargetPos);
    expect(placed[0].sourceTargetPos).toBeLessThan(placed[0].sourceTarget.to);
    // The located block is the heading whose text is "Section".
    const { from, to } = placed[0].sourceTarget;
    expect(doc.textBetween(from + 1, to - 1)).toBe('Section');
  });

  it('plans paragraph → heading with a level', () => {
    const doc = docOf([para('Make me a heading')]);
    const { placed, results } = planStructuralEdits(doc, [
      edit('Make me a heading', { to: 'heading', level: 3 }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed[0].op).toEqual({ kind: 'paragraphToHeading', level: 3 });
  });

  it('refuses paragraph → heading with no level (missing-level)', () => {
    const doc = docOf([para('No level')]);
    const { placed, results } = planStructuralEdits(doc, [edit('No level', { to: 'heading' })]);
    expect(placed).toEqual([]);
    expect(results[0]).toMatchObject({ status: 'malformed', reason: 'missing-level' });
  });

  it('refuses a malformed / out-of-range heading level (invalid-level)', () => {
    const doc = docOf([para('x')]);
    for (const level of [0, 7, 2.5, 'two']) {
      const { results } = planStructuralEdits(doc, [edit('x', { to: 'heading', level })]);
      expect(results[0]).toMatchObject({ status: 'malformed', reason: 'invalid-level' });
    }
  });

  it('refuses a level on a non-heading target (invalid-level)', () => {
    const doc = docOf([heading(1, 'H')]);
    const { results } = planStructuralEdits(doc, [edit('H', { to: 'paragraph', level: 2 })]);
    expect(results[0]).toMatchObject({ status: 'malformed', reason: 'invalid-level' });
  });

  it('refuses a present level KEY (undefined value) on a non-heading target (invalid-level)', () => {
    // Key presence, not value: {to:'paragraph', level:undefined} still declares a contradictory
    // level. A value-only check (level !== undefined) would let it through — this pins hasLevel.
    const doc = docOf([heading(1, 'H')]);
    const { results } = planStructuralEdits(doc, [
      edit('H', { to: 'paragraph', level: undefined }),
    ]);
    expect(results[0]).toMatchObject({ status: 'malformed', reason: 'invalid-level' });
  });

  it('refuses a same-type conversion (no-op)', () => {
    const doc = docOf([para('same'), heading(2, 'H2')]);
    expect(planStructuralEdits(doc, [edit('same', { to: 'paragraph' })]).results[0]).toMatchObject({
      status: 'no-op',
      reason: 'already-target',
    });
    expect(
      planStructuralEdits(doc, [edit('H2', { to: 'heading', level: 2 })]).results[0],
    ).toMatchObject({ status: 'no-op', reason: 'already-target' });
  });

  it('refuses a heading level change — no V1 op (unsupported-op)', () => {
    const doc = docOf([heading(2, 'H')]);
    const { results } = planStructuralEdits(doc, [edit('H', { to: 'heading', level: 4 })]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('plans paragraph → list (V1b), deriving the requested list type', () => {
    const { placed, results } = planStructuralEdits(docOf([para('turn me')]), [
      edit('turn me', { to: 'bulletList' }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed[0].op).toEqual({ kind: 'paragraphToList', listType: 'bulletList' });
  });

  it.each(['bulletList', 'orderedList', 'taskList'] as const)(
    'plans paragraph → %s with multiple items and threads every item unchanged',
    (to) => {
      const items = ['First sentence.', 'Second sentence.', 'Third sentence.'];
      const { placed, results } = planStructuralEdits(docOf([para(items.join(' '))]), [
        edit('Second sentence.', { to, items }),
      ]);
      expect(results[0].status).toBe('planned');
      expect(placed[0].op).toEqual({ kind: 'paragraphToList', listType: to });
      expect(placed[0].listItems).toEqual(items);
    },
  );

  it.each([
    { label: 'items on a paragraph target', structural: { to: 'paragraph', items: ['a', 'b'] } },
    {
      label: 'items on a heading target',
      structural: { to: 'heading', level: 2, items: ['a', 'b'] },
    },
    { label: 'items plus split', structural: { split: ['a', 'b'], items: ['a', 'b'] } },
    { label: 'items plus merge', structural: { merge: true, items: ['a', 'b'] } },
    { label: 'a present undefined items key', structural: { to: 'bulletList', items: undefined } },
    { label: 'a sparse items array', structural: { to: 'bulletList', items: Array(2) } },
    { label: 'fewer than two items', structural: { to: 'bulletList', items: ['a'] } },
    { label: 'a whitespace-only item', structural: { to: 'bulletList', items: ['a', '  '] } },
    { label: 'an untrimmed item', structural: { to: 'bulletList', items: ['a ', 'b'] } },
  ])('refuses malformed multi-item list syntax ($label)', ({ structural }) => {
    const { placed, results } = planStructuralEdits(docOf([para('a b')]), [
      edit('a b', structural),
    ]);
    expect(placed).toEqual([]);
    expect(results[0]).toMatchObject({ status: 'malformed', reason: 'invalid-edit' });
  });

  it('refuses items against an existing list rather than misreporting already-target', () => {
    const { placed, results } = planStructuralEdits(docOf([bullet('one two')]), [
      edit('one two', { to: 'bulletList', items: ['one', 'two'] }),
    ]);
    expect(placed).toEqual([]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('plans a single-item list → paragraph (V1b), deriving the source list type', () => {
    const { placed, results } = planStructuralEdits(docOf([bullet('item')]), [
      edit('item', { to: 'paragraph' }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed[0].op).toEqual({ kind: 'listToParagraph', listType: 'bulletList' });
  });

  it('plans a MULTI-item flat list → paragraph, matching text in any one item', () => {
    const doc = docOf([
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para('one')] },
          { type: 'listItem', content: [para('two')] },
        ],
      },
    ]);
    // A find that matches the SECOND item still targets — and converts — the whole list.
    const { placed, results } = planStructuralEdits(doc, [edit('two', { to: 'paragraph' })]);
    expect(results[0].status).toBe('planned');
    expect(placed[0].op).toEqual({ kind: 'listToParagraph', listType: 'bulletList' });
  });

  it('refuses a list with a MULTI-BLOCK item as unsupported (not a flat list)', () => {
    const doc = docOf([
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para('a'), para('b')] }],
      },
    ]);
    const { results } = planStructuralEdits(doc, [edit('a', { to: 'paragraph' })]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('refuses a list-type change (bulletList → orderedList) as unsupported', () => {
    const { results } = planStructuralEdits(docOf([bullet('item')]), [
      edit('item', { to: 'orderedList' }),
    ]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('refuses a list → heading as unsupported', () => {
    const { results } = planStructuralEdits(docOf([bullet('item')]), [
      edit('item', { to: 'heading', level: 2 }),
    ]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('refuses a find that matches no block (text-not-found)', () => {
    const doc = docOf([para('present')]);
    const { results } = planStructuralEdits(doc, [edit('absent', { to: 'heading', level: 2 })]);
    expect(results[0]).toMatchObject({ status: 'not-found', reason: 'text-not-found' });
  });

  it('refuses a find that matches more than one block (ambiguous)', () => {
    const doc = docOf([para('dup'), para('dup')]);
    const { results } = planStructuralEdits(doc, [edit('dup', { to: 'heading', level: 2 })]);
    expect(results[0]).toMatchObject({ status: 'ambiguous', reason: 'ambiguous-target' });
  });

  it('refuses malformed edits (empty find / bad target)', () => {
    const doc = docOf([para('x')]);
    expect(planStructuralEdits(doc, [edit('  ', { to: 'paragraph' })]).results[0]).toMatchObject({
      status: 'malformed',
      reason: 'invalid-edit',
    });
    expect(planStructuralEdits(doc, [edit('x', { to: 'blockquote' })]).results[0]).toMatchObject({
      status: 'malformed',
      reason: 'invalid-edit',
    });
  });

  it('plans from a partial substring of the block, not the whole block text', () => {
    const doc = docOf([heading(2, 'The Quarterly Report Summary')]);
    const { placed, results } = planStructuralEdits(doc, [
      edit('Quarterly Report', { to: 'paragraph' }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed[0].op).toEqual({ kind: 'headingToParagraph', level: 2 });
    // The whole containing block is the target, even though find was a fragment.
    const { from, to } = placed[0].sourceTarget;
    expect(doc.textBetween(from + 1, to - 1)).toBe('The Quarterly Report Summary');
  });

  it('plans when the substring repeats WITHIN one block (still one target)', () => {
    const doc = docOf([para('go go go')]);
    const { placed, results } = planStructuralEdits(doc, [edit('go', { to: 'heading', level: 2 })]);
    expect(results[0].status).toBe('planned');
    expect(placed).toHaveLength(1);
    expect(placed[0].op).toEqual({ kind: 'paragraphToHeading', level: 2 });
  });

  it('refuses when the substring appears across MULTIPLE blocks (ambiguous)', () => {
    const doc = docOf([para('shared text here'), heading(1, 'also shared text now')]);
    const { placed, results } = planStructuralEdits(doc, [
      edit('shared text', { to: 'paragraph' }),
    ]);
    expect(placed).toEqual([]);
    expect(results[0]).toMatchObject({ status: 'ambiguous', reason: 'ambiguous-target' });
  });

  it('plans a find CROSSING a hard break within one block (one target)', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'hardBreak' },
          { type: 'text', text: 'line two' },
        ],
      },
    ]);
    // The find spans the hard break but stays inside the one paragraph — the
    // complete match envelope is contained in that single top-level block.
    const { placed, results } = planStructuralEdits(doc, [
      edit('line one\nline two', { to: 'heading', level: 3 }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed).toHaveLength(1);
    expect(placed[0].op).toEqual({ kind: 'paragraphToHeading', level: 3 });
  });

  it('refuses a find that spans two blocks (cross-block-target)', () => {
    const doc = docOf([para('alpha'), para('beta')]);
    const { placed, results } = planStructuralEdits(doc, [
      edit('alpha\nbeta', { to: 'paragraph' }),
    ]);
    expect(placed).toEqual([]);
    expect(results[0]).toMatchObject({ status: 'ambiguous', reason: 'cross-block-target' });
  });

  it('treats a list already the requested list type as a no-op (already-target)', () => {
    const doc = docOf([bullet('item')]);
    const { results } = planStructuralEdits(doc, [edit('item', { to: 'bulletList' })]);
    expect(results[0]).toMatchObject({ status: 'no-op', reason: 'already-target' });
  });

  it('keeps results in input order and places only the planned edits', () => {
    const doc = docOf([heading(1, 'Keep'), para('Body')]);
    const { placed, results } = planStructuralEdits(doc, [
      edit('absent', { to: 'paragraph' }), // not-found
      edit('Keep', { to: 'paragraph' }), // planned
      edit('Body', { to: 'heading' }), // missing-level
    ]);
    expect(results.map((r) => r.status)).toEqual(['not-found', 'planned', 'malformed']);
    expect(placed).toHaveLength(1);
    expect(placed[0].editIndex).toBe(1);
    expect(placed[0].op).toEqual({ kind: 'headingToParagraph', level: 1 });
  });
});

describe('planStructuralEdits — list↔paragraph across ALL three list types', () => {
  const LISTS = [
    { to: 'bulletList', make: bullet },
    { to: 'orderedList', make: ordered },
    { to: 'taskList', make: task },
  ] as const;

  for (const { to, make } of LISTS) {
    it(`plans paragraph → ${to}`, () => {
      const { placed, results } = planStructuralEdits(docOf([para('convert me')]), [
        edit('convert me', { to }),
      ]);
      expect(results[0].status).toBe('planned');
      expect(placed[0].op).toEqual({ kind: 'paragraphToList', listType: to });
    });

    it(`plans single-item ${to} → paragraph`, () => {
      const { placed, results } = planStructuralEdits(docOf([make('list item')]), [
        edit('list item', { to: 'paragraph' }),
      ]);
      expect(results[0].status).toBe('planned');
      expect(placed[0].op).toEqual({ kind: 'listToParagraph', listType: to });
    });
  }
});

describe('planStructuralEdits — V2 split', () => {
  it('plans splitParagraph from {split:[...]} on a paragraph, threading the parts', () => {
    const doc = docOf([para('alpha beta'), para('other')]);
    const { placed, results } = planStructuralEdits(doc, [
      edit('alpha beta', { split: ['alpha', 'beta'] }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed).toHaveLength(1);
    expect(placed[0].op).toEqual({ kind: 'splitParagraph' });
    expect(placed[0].splitParts).toEqual(['alpha', 'beta']);
  });

  it('refuses a split of a non-paragraph source (heading) as unsupported', () => {
    const doc = docOf([heading(1, 'Title')]);
    const { placed, results } = planStructuralEdits(doc, [edit('Title', { split: ['Ti', 'tle'] })]);
    expect(placed).toHaveLength(0);
    expect(results[0].reason).toBe('unsupported-op');
  });

  it.each([
    { label: 'both to and split', structural: { to: 'paragraph', split: ['a', 'b'] } },
    {
      label: 'a present split KEY (undefined value) alongside to',
      structural: { to: 'paragraph', split: undefined },
    },
    { label: 'neither to nor split', structural: {} },
    { label: 'split not an array', structural: { split: 'a b' } },
    { label: 'a SPARSE split array', structural: { split: Array(2) } },
    { label: 'fewer than two pieces', structural: { split: ['a'] } },
    { label: 'a whitespace-only piece', structural: { split: ['a', '  '] } },
    { label: 'a level alongside split', structural: { split: ['a', 'b'], level: 2 } },
    {
      label: 'a present level KEY (undefined value) alongside split',
      structural: { split: ['a', 'b'], level: undefined },
    },
    { label: 'to and merge together', structural: { to: 'paragraph', merge: true } },
    { label: 'split and merge together', structural: { split: ['a', 'b'], merge: true } },
    {
      label: 'a present merge KEY alongside to',
      structural: { to: 'paragraph', merge: undefined },
    },
    { label: 'merge with a non-true value', structural: { merge: false } },
    { label: 'a level alongside merge', structural: { merge: true, level: 2 } },
  ])('refuses a malformed structural shape ($label) as invalid-edit', ({ structural }) => {
    const doc = docOf([para('a b')]);
    const { placed, results } = planStructuralEdits(doc, [edit('a b', structural)]);
    expect(placed).toHaveLength(0);
    expect(results[0].reason).toBe('invalid-edit');
  });
});

describe('planStructuralEdits — V2 merge', () => {
  it('plans mergeParagraphs from a find spanning two adjacent paragraphs, threading the count', () => {
    const { placed, results } = planStructuralEdits(docOf([para('one'), para('two')]), [
      edit('one\ntwo', { merge: true }),
    ]);
    expect(results[0].status).toBe('planned');
    expect(placed[0].op).toEqual({ kind: 'mergeParagraphs' });
    expect(placed[0].mergeCount).toBe(2);
    // sourceTarget spans BOTH blocks (from block 0 start to block 1 end).
    expect(placed[0].sourceTarget.from).toBe(0);
  });

  it('plans a three-paragraph merge, count 3', () => {
    const { placed } = planStructuralEdits(docOf([para('a'), para('b'), para('c')]), [
      edit('a\nb\nc', { merge: true }),
    ]);
    expect(placed[0].mergeCount).toBe(3);
  });

  it('refuses a merge whose run includes a NON-paragraph (heading) as unsupported-op', () => {
    const { results } = planStructuralEdits(docOf([para('one'), heading(1, 'H'), para('two')]), [
      edit('one\nH\ntwo', { merge: true }),
    ]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('refuses a merge find that stays within a SINGLE block (needs ≥2 — unsupported-op)', () => {
    const { results } = planStructuralEdits(docOf([para('one two'), para('other')]), [
      edit('one two', { merge: true }),
    ]);
    expect(results[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
  });

  it('refuses a merge find that resolves to TWO distinct runs as ambiguous', () => {
    const { results } = planStructuralEdits(
      docOf([para('x'), para('y'), para('z'), para('x'), para('y')]),
      [edit('x\ny', { merge: true })],
    );
    expect(results[0]).toMatchObject({ status: 'ambiguous', reason: 'ambiguous-target' });
  });
});
