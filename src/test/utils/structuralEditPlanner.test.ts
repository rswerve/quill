import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { planStructuralEdits } from '../../utils/structuralEditPlanner';
import type { QuillStructuralEdit } from '../../types';

/**
 * 6b-1: the pure structural-edit planner. Locates the target block by find text,
 * derives the directional StructuralOp from (current type, requested `to`), and
 * returns source-coordinate geometry — or a typed refusal. Only heading↔paragraph
 * plans (V1a); list source/target refuse `unsupported-op` until the V1b mint.
 */

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [StarterKit.configure({ trailingNode: false })],
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

  it('refuses list targets and list sources as unsupported (V1b)', () => {
    expect(
      planStructuralEdits(docOf([para('turn me')]), [edit('turn me', { to: 'bulletList' })])
        .results[0],
    ).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
    expect(
      planStructuralEdits(docOf([bullet('item')]), [edit('item', { to: 'paragraph' })]).results[0],
    ).toMatchObject({ status: 'unsupported', reason: 'unsupported-op' });
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
