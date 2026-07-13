import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import type { TrackedChangeInfo, TrackedTextSegment } from '../../types';

type TestTextChange = Omit<TrackedChangeInfo, 'segments'> &
  TrackedTextSegment & { operation: 'insert' | 'delete' };

// Most historical assertions are segment-level. Flatten the canonical logical
// cards locally without reintroducing the old two-record runtime model.
function textChanges(editor: Editor): TestTextChange[] {
  return getTrackedChanges(editor).flatMap((change) =>
    change.segments.flatMap((segment) => {
      if (segment.kind === 'format') return [];
      return [
        {
          id: change.id,
          authorID: change.authorID,
          status: change.status,
          createdAt: change.createdAt,
          ...(change.originCommentId ? { originCommentId: change.originCommentId } : {}),
          ...(change.originChatMessageId
            ? { originChatMessageId: change.originChatMessageId }
            : {}),
          ...segment,
          operation: segment.kind,
        },
      ];
    }),
  );
}

function makeEditor(content = '<p>Hello world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackChanges],
    content,
  });
}

function hasMarkOfType(editor: Editor, markName: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.marks.some((m) => m.type.name === markName)) {
      found = true;
    }
  });
  return found;
}

function getMarkAttrs(editor: Editor, markName: string): Record<string, unknown>[] {
  const attrs: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    node.marks.filter((m) => m.type.name === markName).forEach((m) => attrs.push(m.attrs));
  });
  return attrs;
}

function getTextContent(editor: Editor): string {
  return editor.state.doc.textContent;
}

describe('TrackChanges extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor.destroy();
    document.body.innerHTML = '';
  });

  describe('tracking disabled (default)', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
    });

    it('inserting text creates no tracked_insert mark', () => {
      // Position 7 = after the space in "Hello world", giving "Hello beautiful world"
      editor.commands.insertContentAt(7, 'beautiful ');
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(getTextContent(editor)).toBe('Hello beautiful world');
    });

    it('deleting text creates no tracked_delete mark', () => {
      // Delete "Hello"
      editor.commands.deleteRange({ from: 1, to: 6 });
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe(' world');
    });
  });

  describe('tracking enabled', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
    });

    it('inserting text wraps the new text in a tracked_insert mark', () => {
      editor.commands.insertContentAt(7, 'beautiful ');
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(true);
      const attrs = getMarkAttrs(editor, 'tracked_insert');
      expect(attrs[0].dataTracked).toMatchObject({
        authorID: 'alice',
        status: 'pending',
        operation: 'insert',
      });
    });

    it('deleting text wraps the deleted text in a tracked_delete mark (text stays in doc)', () => {
      // Delete "Hello" (positions 1–6)
      editor.commands.deleteRange({ from: 1, to: 6 });
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(true);
      // Text should still be present in the document
      expect(getTextContent(editor)).toContain('Hello');
    });

    it('replacing text produces both a tracked_insert and tracked_delete mark', () => {
      // Replace "Hello" with "Hi" using the chain API
      editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('Hi').run();
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(true);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(true);
    });

    // This editor doesn't register the TrackedFormat mark, so format tracking
    // degrades to the old passthrough (TrackedFormat.test.ts covers tracking).
    it('bold formatting is not tracked when the TrackedFormat mark is absent', () => {
      editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
      // Bold should be applied
      const hasBold = (() => {
        let found = false;
        editor.state.doc.descendants((node) => {
          if (node.marks.some((m) => m.type.name === 'bold')) found = true;
        });
        return found;
      })();
      expect(hasBold).toBe(true);
      // But no track marks should exist for formatting changes
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
    });

    it('reports a single contiguous change when its run is split across text nodes', () => {
      // Insert a tracked run, then bold part of it. Bold splits the text node in
      // two while both halves keep the same tracked_insert id — the exact
      // multi-node shape getTrackedChanges merges. It must still surface one
      // change whose range spans the whole run, not two fragments.
      editor.commands.insertContentAt(7, 'beautiful ');
      editor.chain().setTextSelection({ from: 7, to: 11 }).toggleBold().run();

      // Two adjacent text nodes now carry the run: "beau" (bold) + "tiful ".
      const insertNodes: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === 'tracked_insert')) {
          insertNodes.push(node.text ?? '');
        }
      });
      expect(insertNodes.length).toBeGreaterThan(1);

      const changes = textChanges(editor);
      const inserts = changes.filter((c) => c.operation === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toBe('beautiful ');
      expect(inserts[0].to - inserts[0].from).toBe('beautiful '.length);
    });
  });

  describe('acceptChange', () => {
    it('accepting an insertion removes the tracked_insert mark, leaving plain text', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = textChanges(editor);
      expect(changes).toHaveLength(1);
      const id = changes[0].id;

      editor.commands.acceptChange(id);
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(getTextContent(editor)).toContain('beautiful');
    });

    it('accepting a deletion physically removes the marked text from the document', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.deleteRange({ from: 1, to: 6 });

      const changes = textChanges(editor);
      expect(changes).toHaveLength(1);
      const id = changes[0].id;

      editor.commands.acceptChange(id);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).not.toContain('Hello');
    });
  });

  describe('rejectChange', () => {
    it('rejecting an insertion removes the inserted text from the document', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = textChanges(editor);
      const id = changes[0].id;

      editor.commands.rejectChange(id);
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(getTextContent(editor)).not.toContain('beautiful');
    });

    it('rejecting a deletion removes the tracked_delete mark, restoring the text as plain', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.deleteRange({ from: 1, to: 6 });

      const changes = textChanges(editor);
      const id = changes[0].id;

      editor.commands.rejectChange(id);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      // Text still present and no longer marked
      expect(getTextContent(editor)).toContain('Hello');
    });
  });

  describe('acceptAllChanges', () => {
    it('removes all pending insert marks and deletes all pending deleted text', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.insertContentAt(7, 'beautiful ');
      editor.commands.deleteRange({ from: 1, to: 6 });

      editor.commands.acceptAllChanges();
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe(' beautiful world');
    });
  });

  describe('rejectAllChanges', () => {
    it('removes all inserted text and all delete marks', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.insertContentAt(7, 'beautiful ');
      editor.commands.deleteRange({ from: 1, to: 6 });

      editor.commands.rejectAllChanges();
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe('Hello world');
    });
  });

  describe('multi-step and structural transactions', () => {
    function replaceAllAlphaWithGamma() {
      editor = makeEditor('<p>alpha beta alpha</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor
        .chain()
        .setTextSelection({ from: 12, to: 17 })
        .insertContent('gamma')
        .setTextSelection({ from: 1, to: 6 })
        .insertContent('gamma')
        .run();
    }

    it('tracks a back-to-front Replace All without moving either replacement', () => {
      replaceAllAlphaWithGamma();

      const changes = textChanges(editor);
      expect(
        changes
          .filter((change) => change.operation === 'delete')
          .map((change) => change.text)
          .sort(),
      ).toEqual(['alpha', 'alpha']);
      expect(
        changes
          .filter((change) => change.operation === 'insert')
          .map((change) => change.text)
          .sort(),
      ).toEqual(['gamma', 'gamma']);

      editor.commands.acceptAllChanges();
      expect(getTextContent(editor)).toBe('gamma beta gamma');
    });

    it('rejects a back-to-front Replace All back to the exact original text', () => {
      replaceAllAlphaWithGamma();
      editor.commands.rejectAllChanges();
      expect(getTextContent(editor)).toBe('alpha beta alpha');
    });

    it('accepts a back-to-front Replace All as the exact requested text', () => {
      replaceAllAlphaWithGamma();
      editor.commands.acceptAllChanges();
      expect(getTextContent(editor)).toBe('gamma beta gamma');
    });

    it('undoes a back-to-front Replace All in one step', () => {
      replaceAllAlphaWithGamma();
      editor.commands.undo();
      expect(getTextContent(editor)).toBe('alpha beta alpha');
      expect(getTrackedChanges(editor)).toEqual([]);
    });

    it("keeps replacement text in place when typing over the author's pending insertion", () => {
      editor = makeEditor('<p>abc</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
      editor.chain().setTextSelection(4).insertContent('xyz').run();
      editor.chain().setTextSelection({ from: 4, to: 7 }).insertContent('Q').run();

      expect(getTextContent(editor)).toBe('abcQ');
      const changes = textChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ operation: 'insert', text: 'Q', authorID: 'alice' });
    });

    it('blocks a multi-block paste rather than committing structure untracked', () => {
      editor = makeEditor('<p>start end</p>');
      editor.commands.setTrackChangesEnabled(true);
      const before = editor.getJSON();
      editor.chain().setTextSelection(7).insertContent('<p>pasted one</p><p>pasted two</p>').run();

      expect(editor.getJSON()).toEqual(before);
      expect(textChanges(editor)).toEqual([]);
    });
  });

  describe('logical replacements', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('alice');
    });

    function replaceHelloWithHi() {
      // One ReplaceStep that both deletes and inserts — typing over a selection.
      editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('Hi').run();
    }

    it('replacing text produces one logical change with delete and insert segments', () => {
      replaceHelloWithHi();
      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].segments.map((segment) => segment.kind).sort()).toEqual([
        'delete',
        'insert',
      ]);
    });

    it('a pure insertion is one logical change', () => {
      editor.commands.insertContentAt(7, 'beautiful ');
      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].segments.map((segment) => segment.kind)).toEqual(['insert']);
    });

    it('a pure deletion is one logical change', () => {
      editor.commands.deleteRange({ from: 1, to: 6 });
      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].segments.map((segment) => segment.kind)).toEqual(['delete']);
    });

    it('continued typing after a replacement extends the same logical change', () => {
      replaceHelloWithHi();
      const logicalId = getTrackedChanges(editor)[0].id;
      // The caret sits at the end of "Hi" (position 3); keep typing there.
      editor.commands.insertContentAt(3, '!');

      const inserts = textChanges(editor).filter((c) => c.operation === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toBe('Hi!');
      expect(inserts[0].id).toBe(logicalId);
    });

    it('resolveChange resolves both halves: old text removed, new text kept', () => {
      replaceHelloWithHi();
      const id = getTrackedChanges(editor)[0].id;

      editor.commands.resolveChange(id, 'accept');
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe('Hi world');
    });

    it('resolveChange reject resolves both halves: old text restored, new text removed', () => {
      replaceHelloWithHi();
      const id = getTrackedChanges(editor)[0].id;

      editor.commands.resolveChange(id, 'reject');
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(false);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(false);
      expect(getTextContent(editor)).toBe('Hello world');
    });

    it('resolving a logical replacement is a single undo step', () => {
      replaceHelloWithHi();
      const id = getTrackedChanges(editor)[0].id;

      // Close the history group so undo targets the accept alone — without
      // this, the accept merges into the replacement's group (newGroupDelay).
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.resolveChange(id, 'accept');
      editor.commands.undo();
      // One undo restores BOTH halves — they were resolved in one transaction.
      expect(hasMarkOfType(editor, 'tracked_insert')).toBe(true);
      expect(hasMarkOfType(editor, 'tracked_delete')).toBe(true);
    });
  });

  describe('origin comment stamping', () => {
    beforeEach(() => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('claude');
    });

    it('stamps originCommentId on a fresh insertion while an origin is set', () => {
      editor.commands.setTrackChangesOrigin('comment-1');
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = textChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].originCommentId).toBe('comment-1');
    });

    it('stamps originCommentId on both halves of a fresh replacement', () => {
      editor.commands.setTrackChangesOrigin('comment-1');
      editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('Hi').run();

      const changes = textChanges(editor);
      const del = changes.find((c) => c.operation === 'delete');
      const ins = changes.find((c) => c.operation === 'insert');
      expect(del?.originCommentId).toBe('comment-1');
      expect(ins?.originCommentId).toBe('comment-1');
    });

    it('omits originCommentId when no origin is set (default)', () => {
      editor.commands.insertContentAt(7, 'beautiful ');
      const changes = textChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0].originCommentId).toBeUndefined();
    });

    it('stops stamping once the origin is reset to null', () => {
      editor.commands.setTrackChangesOrigin('comment-1');
      editor.commands.insertContentAt(7, 'beautiful ');
      editor.commands.setTrackChangesOrigin(null);
      // A fresh change elsewhere in the doc (not adjacent to the first one).
      editor.commands.deleteRange({ from: 1, to: 3 });

      const changes = textChanges(editor);
      const ins = changes.find((c) => c.operation === 'insert');
      const del = changes.find((c) => c.operation === 'delete');
      expect(ins?.originCommentId).toBe('comment-1');
      expect(del?.originCommentId).toBeUndefined();
    });

    it('a reused (coalesced) change keeps the origin it was minted with', () => {
      editor.commands.setTrackChangesOrigin('comment-1');
      editor.commands.insertContentAt(7, 'beautiful');
      // Continued typing from the same request coalesces into the SAME change
      // and retains that request's provenance. A different origin intentionally
      // mints a separate card (covered by the provenance-adversary suite).
      editor.commands.setTrackChangesOrigin('comment-1');
      editor.commands.insertContentAt(16, ' shiny');

      const inserts = textChanges(editor).filter((c) => c.operation === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toBe('beautiful shiny');
      expect(inserts[0].originCommentId).toBe('comment-1');
    });
  });

  describe('getTrackedChanges', () => {
    it('returns an empty array when no changes exist', () => {
      editor = makeEditor('<p>Hello world</p>');
      expect(getTrackedChanges(editor)).toEqual([]);
    });

    it('returns a TrackedChangeInfo for each tracked change', () => {
      editor = makeEditor('<p>Hello world</p>');
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('bob');
      editor.commands.insertContentAt(7, 'beautiful ');

      const changes = textChanges(editor);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        operation: 'insert',
        authorID: 'bob',
        status: 'pending',
        text: 'beautiful ',
      });
      expect(changes[0].id).toBeTruthy();
    });
  });
});
