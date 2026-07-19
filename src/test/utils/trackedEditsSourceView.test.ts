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
