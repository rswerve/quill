import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import { TrackedInsert, TrackedDelete, TrackedFormat } from '../../extensions/TrackChanges';
import { cleanSourceSlice } from '../../utils/cleanSourceProjection';

/**
 * cleanSourceSlice — the clipboard seam for copy → clean source. Copy places the
 * pending-ignored version of the selection on the clipboard, so a selection over
 * hidden or frozen review content copies only the real, source-visible text.
 * These pin the eight controls Codex specified; the thin handleDOMEvents.copy
 * wrapper in Editor.tsx just serializes whatever slice this returns.
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
      CommentMark,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
    ],
    content: '<p></p>',
  });
});

afterEach(() => editor.destroy());

function docOf(content: unknown[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content });
}

/** An inline pending tracked_insert / tracked_delete mark. */
function tracked(text: string, operation: 'insert' | 'delete') {
  const type = operation === 'insert' ? 'tracked_insert' : 'tracked_delete';
  return {
    type: 'text',
    text,
    marks: [
      { type, attrs: { dataTracked: { id: 'i1', operation, authorID: 'u', status: 'pending' } } },
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

const sliceText = (slice: Slice): string =>
  slice.content.textBetween(0, slice.content.size, '\n', ' ');

function sliceHasMark(slice: Slice, name: string): boolean {
  let found = false;
  slice.content.nodesBetween(0, slice.content.size, (node) => {
    if (node.marks.some((mark) => mark.type.name === name)) found = true;
    return true;
  });
  return found;
}

function sliceHasNode(slice: Slice, name: string): boolean {
  let found = false;
  slice.content.nodesBetween(0, slice.content.size, (node) => {
    if (node.type.name === name) found = true;
    return true;
  });
  return found;
}

describe('cleanSourceSlice — copy → clean source', () => {
  it('returns null for an empty selection', () => {
    const doc = docOf([{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]);
    expect(cleanSourceSlice(doc, 2, 2)).toBeNull();
  });

  it('copies a clean selection verbatim', () => {
    const doc = docOf([{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }]);
    const r = liveRangeOf(doc, 'world');
    const slice = cleanSourceSlice(doc, r.from, r.to)!;
    expect(sliceText(slice)).toBe('world');
  });

  it('copies NOTHING when the selection is entirely hidden pending content', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'keep' },
          tracked('HIDDEN', 'insert'),
          { type: 'text', text: 'tail' },
        ],
      },
    ]);
    const r = liveRangeOf(doc, 'HIDDEN');
    const slice = cleanSourceSlice(doc, r.from, r.to);
    expect(slice).not.toBeNull();
    expect(slice!.size).toBe(0);
  });

  it('copies only source-visible text for a selection spanning a hidden insertion', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'alpha' },
          tracked('MID', 'insert'),
          { type: 'text', text: 'beta' },
        ],
      },
    ]);
    const a = liveRangeOf(doc, 'alpha');
    const b = liveRangeOf(doc, 'beta');
    const slice = cleanSourceSlice(doc, a.from, b.to)!;
    expect(sliceText(slice)).toBe('alphabeta');
  });

  it('copies a retained deletion as its original text with no tracking marks', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'keep' },
          tracked('GONE', 'delete'),
          { type: 'text', text: 'rest' },
        ],
      },
    ]);
    const slice = cleanSourceSlice(doc, 1, doc.content.size)!;
    expect(sliceText(slice)).toContain('GONE');
    expect(sliceHasMark(slice, 'tracked_delete')).toBe(false);
  });

  it('copies pending-formatted text as its original (un-accepted) formatting', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'plain ' },
          {
            type: 'text',
            text: 'word',
            marks: [
              { type: 'bold' },
              {
                type: 'tracked_format',
                attrs: {
                  dataTracked: {
                    id: 'f1',
                    operation: 'format',
                    authorID: 'u',
                    status: 'pending',
                    delta: { adds: ['bold'], removes: [] },
                  },
                },
              },
            ],
          },
        ],
      },
    ]);
    const r = liveRangeOf(doc, 'word');
    const slice = cleanSourceSlice(doc, r.from, r.to)!;
    expect(sliceText(slice)).toBe('word');
    expect(sliceHasMark(slice, 'bold')).toBe(false);
    expect(sliceHasMark(slice, 'tracked_format')).toBe(false);
  });

  it('copies a structural union as its source branch only', () => {
    const doc = docOf([
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
      { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
    ]);
    const slice = cleanSourceSlice(doc, 0, doc.content.size)!;
    expect(sliceText(slice)).toContain('Old');
    expect(sliceText(slice)).toContain('Body');
    expect(sliceText(slice)).not.toContain('New');
  });

  it('strips comment marks from the copied slice', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before ' },
          {
            type: 'text',
            text: 'annotated',
            marks: [{ type: 'comment', attrs: { commentId: 'c1', resolved: false, kind: 'note' } }],
          },
          { type: 'text', text: ' after' },
        ],
      },
    ]);
    const r = liveRangeOf(doc, 'annotated');
    const slice = cleanSourceSlice(doc, r.from, r.to)!;
    expect(sliceText(slice)).toBe('annotated');
    expect(sliceHasMark(slice, 'comment')).toBe(false);
  });

  it('preserves hard breaks and links in the copied slice', () => {
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a' },
          { type: 'hardBreak' },
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
        ],
      },
    ]);
    const slice = cleanSourceSlice(doc, 1, doc.content.size)!;
    expect(sliceHasNode(slice, 'hardBreak')).toBe(true);
    expect(sliceHasMark(slice, 'link')).toBe(true);
  });

  it('serializes the slice (as the copy handler does) to redline-free HTML and plain text', () => {
    // The end of the pipeline: view.serializeForClipboard over a cleanSourceSlice,
    // exactly what handleDOMEvents.copy writes to the clipboard. A selection
    // spanning a hidden insertion yields the source-visible text as clean HTML.
    const doc = docOf([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'alpha' },
          tracked('MID', 'insert'),
          { type: 'text', text: 'beta' },
        ],
      },
    ]);
    const a = liveRangeOf(doc, 'alpha');
    const b = liveRangeOf(doc, 'beta');
    const slice = cleanSourceSlice(doc, a.from, b.to)!;
    const { dom, text } = editor.view.serializeForClipboard(slice);
    expect(text).toBe('alphabeta');
    expect(dom.innerHTML).toContain('alphabeta');
    expect(dom.innerHTML).not.toMatch(/track-insert|track-delete|data-tracked|<ins\b|<del\b/);
  });
});
