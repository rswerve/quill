import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import { TrackedInsert, TrackedDelete, TrackedFormat } from '../../extensions/TrackChanges';
import { cleanSourceClipboard } from '../../utils/cleanSourceProjection';

/**
 * cleanSourceClipboard — the projection seam for copy → clean source. It returns
 * the HTML slice AND the plain text of a selection from the pending-ignored
 * projection, so a selection over hidden or frozen review content yields only the
 * real, source-visible content. These pin the controls Codex specified; the
 * CleanSourceClipboard extension wires this to the DOM copy event.
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

describe('cleanSourceClipboard — copy → clean source', () => {
  it('returns null for an empty selection', () => {
    const doc = docOf([{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]);
    expect(cleanSourceClipboard(doc, 2, 2)).toBeNull();
  });

  it('copies a clean selection verbatim (slice + text)', () => {
    const doc = docOf([{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }]);
    const r = liveRangeOf(doc, 'world');
    const { slice, text } = cleanSourceClipboard(doc, r.from, r.to)!;
    expect(sliceText(slice)).toBe('world');
    expect(text).toBe('world');
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
    const result = cleanSourceClipboard(doc, r.from, r.to);
    expect(result).not.toBeNull();
    expect(result!.slice.size).toBe(0);
    expect(result!.text).toBe('');
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
    const { slice, text } = cleanSourceClipboard(doc, a.from, b.to)!;
    expect(sliceText(slice)).toBe('alphabeta');
    expect(text).toBe('alphabeta');
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
    const { slice, text } = cleanSourceClipboard(doc, 1, doc.content.size)!;
    expect(text).toBe('keepGONErest');
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
    const { slice, text } = cleanSourceClipboard(doc, r.from, r.to)!;
    expect(text).toBe('word');
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
    const { slice, text } = cleanSourceClipboard(doc, 0, doc.content.size)!;
    expect(sliceText(slice)).toContain('Old');
    expect(sliceText(slice)).toContain('Body');
    expect(sliceText(slice)).not.toContain('New');
    expect(text).toBe('Old\n\nBody'); // block separator between the two source blocks
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
    const { slice, text } = cleanSourceClipboard(doc, r.from, r.to)!;
    expect(text).toBe('annotated');
    expect(sliceHasMark(slice, 'comment')).toBe(false);
  });

  it('preserves hard breaks (as a newline in plain text) and links', () => {
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
    const { slice, text } = cleanSourceClipboard(doc, 1, doc.content.size)!;
    expect(sliceHasNode(slice, 'hardBreak')).toBe(true);
    expect(sliceHasMark(slice, 'link')).toBe(true);
    // getTextBetween honors HardBreak's renderText newline — plain textBetween drops it.
    expect(text).toBe('a\nlink');
  });

  it('serializes the slice to redline-free HTML (via serializeForClipboard)', () => {
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
    const { slice } = cleanSourceClipboard(doc, a.from, b.to)!;
    const { dom } = editor.view.serializeForClipboard(slice);
    expect(dom.innerHTML).toContain('alphabeta');
    expect(dom.innerHTML).not.toMatch(/track-insert|track-delete|data-tracked|<ins\b|<del\b/);
  });
});
