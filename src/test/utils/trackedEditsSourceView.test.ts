import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { TrackedInsert, TrackedDelete, TrackedFormat } from '../../extensions/TrackChanges';
import { planEdits } from '../../utils/trackedEdits';

/**
 * planEdits source-view safety gate for STRUCTURAL unions (Codex's oracle cases
 * that the inline reconciliation doesn't cover). Claude sees the clean-source
 * document; an edit whose live envelope intersects a union footprint — including
 * the RETAINED source branch, which is frozen — must refuse `source-view-conflict`
 * rather than land on it, while clean content adjacent to the union applies.
 */

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Markdown,
      BlockTrack,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
    ],
    content: '<p></p>',
  });
});

afterEach(() => editor.destroy());

/** [before] · heading "Target" (union source) · paragraph "Target" (proposed) · [after]. */
function unionDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
      {
        type: 'heading',
        attrs: { level: 1, blockTrack: { changeId: 'u1', op: 'delete' } },
        content: [{ type: 'text', text: 'Target' }],
      },
      {
        type: 'paragraph',
        attrs: { blockTrack: { changeId: 'u1', op: 'insert' } },
        content: [{ type: 'text', text: 'Target' }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ],
  });
}

describe('planEdits source-view gate — structural union cases', () => {
  it('refuses an edit landing inside a union (the retained source branch is frozen)', () => {
    const doc = unionDoc();
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'Target', replace: 'Retitled' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });

  it('applies an edit on clean content BEFORE a union', () => {
    const doc = unionDoc();
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'before', replace: 'BEFORE' }],
      'claude',
    );
    expect(results[0].status).toBe('applied');
    expect(placed).toHaveLength(1);
  });

  it('applies an edit on clean content AFTER a union (mixed doc, clean target)', () => {
    const doc = unionDoc();
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'after', replace: 'AFTER' }],
      'claude',
    );
    expect(results[0].status).toBe('applied');
    expect(placed).toHaveLength(1);
  });
});

/** An inline pending tracked_insert / tracked_delete mark (production dataTracked shape). */
function tracked(text: string, operation: 'insert' | 'delete', id = 'i1') {
  const type = operation === 'insert' ? 'tracked_insert' : 'tracked_delete';
  return {
    type: 'text',
    text,
    marks: [
      { type, attrs: { dataTracked: { id, operation, authorID: 'other', status: 'pending' } } },
    ],
  };
}

/** Inline text carrying a pending tracked_format marker (bold added, not yet accepted). */
function trackedFormat(text: string, id = 'f1') {
  return {
    type: 'text',
    text,
    marks: [
      { type: 'bold' },
      {
        type: 'tracked_format',
        attrs: {
          dataTracked: {
            id,
            operation: 'format',
            authorID: 'other',
            status: 'pending',
            delta: { adds: ['bold'], removes: [] },
          },
        },
      },
    ],
  };
}

/** First live range of a substring within a single text node. */
function liveRangeOf(doc: PMNode, needle: string): { from: number; to: number } {
  let hit: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit || !node.isText || !node.text) return;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) hit = { from: pos + idx, to: pos + idx + needle.length };
  });
  if (!hit) throw new Error(`needle not found: ${needle}`);
  return hit;
}

/** Document position just before the first top-level block matching `pred`. */
function blockStartWhere(doc: PMNode, pred: (node: PMNode) => boolean): number {
  let at = -1;
  doc.forEach((node, offset) => {
    if (at < 0 && pred(node)) at = offset;
  });
  if (at < 0) throw new Error('no matching block');
  return at;
}

/** paragraph: "alpha" · pending-insert "MID" · "beta". Source view = "alphabeta". */
function insertionDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'alpha' },
          tracked('MID', 'insert'),
          { type: 'text', text: 'beta' },
        ],
      },
    ],
  });
}

/** paragraph: "keep" · pending-delete "GONE" · "rest". Source keeps "GONE" (rejected view). */
function deletionDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'keep' },
          tracked('GONE', 'delete'),
          { type: 'text', text: 'rest' },
        ],
      },
    ],
  });
}

/** paragraph: "plain " · pending-format "styled" (bold) · " tail". */
function formatDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'plain ' },
          trackedFormat('styled'),
          { type: 'text', text: ' tail' },
        ],
      },
    ],
  });
}

/** A block union AND a separate clean paragraph, with an inline insertion between. */
function combinedDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1, blockTrack: { changeId: 'u1', op: 'delete' } },
        content: [{ type: 'text', text: 'Old' }],
      },
      {
        type: 'paragraph',
        attrs: { blockTrack: { changeId: 'u1', op: 'insert' } },
        content: [{ type: 'text', text: 'New' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'mid' },
          tracked('INS', 'insert'),
          { type: 'text', text: 'dle' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'clean tail' }] },
    ],
  });
}

describe('planEdits source-view gate — inline pending marks', () => {
  it('refuses a source-visible quote that SPANS a hidden insertion (removed-branch gate)', () => {
    const doc = insertionDoc();
    // "alphabeta" IS visible in source, but its live envelope crosses the hidden
    // "MID" insertion — the removed-branch overlap must refuse, not land on it.
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'alphabeta', replace: 'X' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });

  it('reports a find CONTAINING hidden inserted text as text-not-found (Claude never saw it)', () => {
    const doc = insertionDoc();
    const { results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'alphaMIDbeta', replace: 'X' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'not-found', reason: 'text-not-found' });
  });

  it('refuses an edit on retained pending-deleted text (visible in source, frozen in live)', () => {
    const doc = deletionDoc();
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'GONE', replace: 'X' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });

  it('refuses an edit on text carrying a pending format suggestion', () => {
    const doc = formatDoc();
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'styled', replace: 'X' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });

  it('refuses a nonempty live scope that is entirely hidden in source', () => {
    const doc = insertionDoc();
    const mid = liveRangeOf(doc, 'MID');
    const { results } = planEdits(doc, mid.from, mid.to, [{ find: 'MID', replace: 'X' }], 'claude');
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
  });

  it('applies a clean-target edit amid a union AND an inline insertion (composition maps)', () => {
    const doc = combinedDoc();
    const { placed, results } = planEdits(
      doc,
      0,
      doc.content.size,
      [{ find: 'clean', replace: 'CLEAN' }],
      'claude',
    );
    expect(results[0].status).toBe('applied');
    expect(placed).toHaveLength(1);
  });
});

describe('planEdits source-view gate — zero-width point controls', () => {
  it('refuses an empty-find insertion collapsed onto a hidden insertion (inversion guard)', () => {
    const doc = insertionDoc();
    const mid = liveRangeOf(doc, 'MID');
    // The insertion point sits on the hidden seam: its source image inverts to
    // liveFrom > liveTo (right of MID vs left of MID) and must refuse.
    const { placed, results } = planEdits(
      doc,
      mid.from,
      mid.from,
      [{ find: '', replace: 'x' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });

  it('allows an empty-find insertion exactly at a pending-mark boundary (strict interior lets the edge through)', () => {
    const doc = deletionDoc();
    const gone = liveRangeOf(doc, 'GONE');
    // Exactly at the deletion's start boundary — NOT strictly inside — so allowed.
    const { placed, results } = planEdits(
      doc,
      gone.from,
      gone.from,
      [{ find: '', replace: 'x' }],
      'claude',
    );
    expect(results[0].status).toBe('applied');
    expect(placed).toHaveLength(1);
  });

  it('refuses an empty-find insertion strictly inside the union envelope', () => {
    const doc = unionDoc();
    const target = liveRangeOf(doc, 'Target'); // retained heading source branch
    const inside = target.from + 1;
    const { placed, results } = planEdits(
      doc,
      inside,
      inside,
      [{ find: '', replace: 'x' }],
      'claude',
    );
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });

  it('allows an empty-find insertion at the clean edge immediately preceding a union', () => {
    const doc = unionDoc();
    // A zero-width point in the clean "before" text, at the union's unambiguous
    // leading outer boundary — deliberately kept editable, unlike the seam. (An
    // empty-find at the raw BLOCK boundary snaps forward into the union's first
    // text position and is correctly refused; the outer edge that stays editable
    // is the clean text position just before it.)
    const leadingEdge = liveRangeOf(doc, 'before').to;
    const { placed, results } = planEdits(
      doc,
      leadingEdge,
      leadingEdge,
      [{ find: '', replace: 'x' }],
      'claude',
    );
    expect(results[0].status).toBe('applied');
    expect(placed).toHaveLength(1);
  });

  it('refuses an empty-find insertion at the collapsed TRAILING seam (inversion, no side guess)', () => {
    const doc = unionDoc();
    // The internal seam between the retained source branch and the proposed
    // branch that source drops — the point collapses across hidden content and
    // inverts, so it must refuse rather than guess the trailing side.
    const seam = blockStartWhere(doc, (node) => node.attrs.blockTrack?.op === 'insert');
    const { placed, results } = planEdits(doc, seam, seam, [{ find: '', replace: 'x' }], 'claude');
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'source-view-conflict' });
    expect(placed).toEqual([]);
  });
});
