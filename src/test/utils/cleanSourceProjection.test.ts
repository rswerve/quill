import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { TrackedInsert, TrackedDelete, TrackedFormat } from '../../extensions/TrackChanges';
import { projectDocument } from '../../utils/blockUnionProjection';
import { cleanSourceHTML, cleanSourceMarkdown } from '../../utils/cleanSourceProjection';

/**
 * Commit 1 of the coordinate slice — the pure foundation. Asserts that the
 * composed {structural:'source', inline:'source'} projection collapses a block
 * union to its source branch AND rejects pending inline changes (insertions
 * dropped, deletions kept), and that cleanSourceMarkdown serializes exactly that.
 * The inline source semantics themselves are fuzzer-validated in the kernel; this
 * pins the COMPOSITION. No production consumer is wired yet.
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

/** A doc with BOTH a block union (heading→paragraph) and inline tracked marks. */
function mixedDoc(): PMNode {
  return editor.schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
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
          { type: 'text', text: 'a' },
          tracked('X', 'insert'),
          { type: 'text', text: 'b' },
          tracked('Y', 'delete'),
          { type: 'text', text: 'c' },
        ],
      },
    ],
  });
}

const serialize = (doc: PMNode): string =>
  (
    editor.storage as unknown as {
      markdown: { serializer: { serialize: (d: PMNode) => string } };
    }
  ).markdown.serializer.serialize(doc);

describe('projectDocument {structural:source, inline:source} — the composed clean-original view', () => {
  it('keeps the union SOURCE branch and rejects pending inline changes', () => {
    const projection = projectDocument(mixedDoc(), { structural: 'source', inline: 'source' });
    const texts: string[] = [];
    const types: string[] = [];
    projection.doc.forEach((node) => {
      texts.push(node.textContent);
      types.push(node.type.name);
    });
    // The insert-branch paragraph "New" is gone; the source heading "Old" stays.
    // In the last paragraph the insertion "X" is dropped and the deletion "Y" is
    // KEPT (the original text): a + b + Y + c.
    expect(types).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(texts).toEqual(['keep', 'Old', 'abYc']);
    // No tracking identity survives the projection.
    expect(projection.doc.child(1).attrs.blockTrack).toBeNull();
    projection.doc.descendants((node) => {
      expect(node.marks.some((m) => m.type.name.startsWith('tracked_'))).toBe(false);
    });
  });

  it('exposes an invertible review→clean-source mapping', () => {
    const projection = projectDocument(mixedDoc(), { structural: 'source', inline: 'source' });
    // A position in the leading untouched "keep" paragraph survives round-trip.
    const live = 2; // inside "keep"
    const source = projection.mapping.map(live);
    expect(projection.mapping.invert().map(source)).toBe(live);
  });

  it('cleanSourceMarkdown serializes the pending-ignored original', () => {
    const md = cleanSourceMarkdown(mixedDoc(), serialize);
    expect(md).toContain('keep');
    expect(md).toContain('# Old'); // source heading retained, un-redlined
    expect(md).toContain('abYc'); // insertion dropped, deletion kept
    expect(md).not.toContain('New'); // proposed structural branch gone
    expect(md).not.toMatch(/aXb/); // pending insertion never leaks
  });
});

describe('cleanSourceHTML — the pending-ignored original for print', () => {
  it('serializes the source view to HTML with NO redline markup', () => {
    const html = cleanSourceHTML(mixedDoc());
    // Source structure survives: the retained heading and the reject-view text.
    expect(html).toContain('<h1>Old</h1>');
    expect(html).toContain('keep');
    expect(html).toContain('abYc'); // insertion "X" dropped, deletion "Y" kept
    // The proposed structural branch and the pending insertion never appear.
    expect(html).not.toContain('New');
    expect(html).not.toMatch(/aXb/);
    // Crucially, the projected doc carries no tracking marks, so the printed HTML
    // has none of the redline elements or classes the live editor renders.
    expect(html).not.toMatch(/track-insert|track-delete|track-format|data-tracked/);
    expect(html).not.toMatch(/<ins\b|<del\b/);
  });
});
