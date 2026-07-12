import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import {
  locateEdit,
  mapRangeTextOffsetToPos,
  planEdits,
  rangeText,
  resolveScopeRange,
} from '../../utils/trackedEdits';

function makeEditor(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit,
      Image.configure({ inline: true }),
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
}

describe('trackedEdits helpers', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = '';
  });

  describe('rangeText + mapRangeTextOffsetToPos across a bullet list', () => {
    it('reads list items as newline-separated plaintext and maps offsets back', () => {
      editor = makeEditor('<ul><li>buy milk</li><li>buy eggs</li></ul>');
      const doc = editor.state.doc;
      const text = rangeText(doc, 0, doc.content.size);
      // No markdown bullets; items separated by newline(s).
      expect(text).toContain('buy milk');
      expect(text).toContain('buy eggs');
      expect(text).not.toContain('- ');

      // Mapping the offset of "buy eggs" (in the second list item, after a
      // newline separator) back to a doc position should let us re-select
      // exactly that text via locateEdit's round-trip.
      const idx = text.indexOf('buy eggs');
      const pos = mapRangeTextOffsetToPos(doc, 0, doc.content.size, idx);
      expect(pos).not.toBeNull();

      const at = locateEdit(doc, 0, doc.content.size, 'buy eggs');
      expect(at).not.toBeNull();
      expect(at!.from).toBe(pos);
      expect(doc.textBetween(at!.from, at!.to, '\n', ' ')).toBe('buy eggs');
    });
  });

  describe('locateEdit', () => {
    it('finds a substring within a paragraph and returns positions that select it', () => {
      editor = makeEditor('<p>the cat are happy</p>');
      const doc = editor.state.doc;
      const at = locateEdit(doc, 0, doc.content.size, 'cat are');
      expect(at).not.toBeNull();
      expect(doc.textBetween(at!.from, at!.to)).toBe('cat are');
    });

    it('returns null when the text is absent', () => {
      editor = makeEditor('<p>hello world</p>');
      const doc = editor.state.doc;
      expect(locateEdit(doc, 0, doc.content.size, 'goodbye')).toBeNull();
    });

    it.each([
      ['bold', '<p>hello <strong>world</strong></p>', 'world'],
      ['italic', '<p>hello <em>world</em></p>', 'world'],
      ['link', '<p>hello <a href="https://example.com">world</a></p>', 'world'],
      ['hard break', '<p>line one<br>line two</p>', 'line two'],
      ['inline image', '<p>before <img src="x.png"> after</p>', 'after'],
      ['empty paragraph', '<p>alpha</p><p></p><p>omega</p>', 'omega'],
    ])('round-trips a match across %s boundaries without shifting it', (_label, html, find) => {
      editor = makeEditor(html);
      const doc = editor.state.doc;
      const at = locateEdit(doc, 0, doc.content.size, find);

      expect(at).not.toBeNull();
      expect(doc.textBetween(at!.from, at!.to, '\n', ' ')).toBe(find);
    });

    it('round-trips a match spanning adjacent differently-marked text runs', () => {
      editor = makeEditor('<p>plain <strong>bold</strong> <em>italic</em></p>');
      const doc = editor.state.doc;
      const find = 'plain bold italic';
      const at = locateEdit(doc, 0, doc.content.size, find);

      expect(at).not.toBeNull();
      expect(doc.textBetween(at!.from, at!.to, '\n', ' ')).toBe(find);
    });
  });

  describe('resolveScopeRange', () => {
    it('returns comment bounds for highlight scope', () => {
      editor = makeEditor('<p>hello world</p>');
      const r = resolveScopeRange(editor.state.doc, { from: 1, to: 6 }, 'highlight');
      expect(r).toEqual({ from: 1, to: 6 });
    });

    it('expands to the enclosing paragraph for paragraph scope', () => {
      editor = makeEditor('<p>hello world</p>');
      const doc = editor.state.doc;
      const r = resolveScopeRange(doc, { from: 3, to: 5 }, 'paragraph');
      expect(r.from).toBe(1);
      expect(r.to).toBe(doc.content.size - 1);
    });

    it('covers the whole doc for doc scope', () => {
      editor = makeEditor('<p>a</p><p>b</p>');
      const doc = editor.state.doc;
      const r = resolveScopeRange(doc, { from: 1, to: 2 }, 'doc');
      expect(r).toEqual({ from: 0, to: doc.content.size });
    });
  });

  describe('planEdits', () => {
    it('places located edits back-to-front and counts skips', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha', replace: 'A' },
        { find: 'gamma', replace: 'G' },
        { find: 'missing', replace: 'X' },
      ]);
      expect(skipped).toBe(1);
      expect(placed).toHaveLength(2);
      // Back-to-front: gamma (later) comes first.
      expect(placed[0].from).toBeGreaterThan(placed[1].from);
      expect(placed[0]).toMatchObject({ kind: 'text', replace: 'G' });
    });

    it('skips a text-identical edit (formatting-only ask) instead of placing it', () => {
      // find === replace can only be a formatting change, which find/replace
      // cannot express — placing it would mint a fake tracked pair whose
      // accept no-ops or strips formatting. It must count as skipped.
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', replace: 'beta' },
      ]);
      expect(skipped).toBe(1);
      expect(placed).toHaveLength(0);
    });

    it('still places a real edit alongside a skipped text-identical one', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha', replace: 'alpha' },
        { find: 'gamma', replace: 'G' },
      ]);
      expect(skipped).toBe(1);
      expect(placed).toHaveLength(1);
      expect(placed[0]).toMatchObject({ kind: 'text', replace: 'G' });
    });
  });

  describe('planEdits format ops', () => {
    it('places a format edit with mapped mark names (strikethrough → strike)', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', format: { bold: true, strikethrough: false } },
      ]);
      expect(skipped).toBe(0);
      expect(placed).toEqual([
        {
          kind: 'format',
          from: 7,
          to: 11,
          marks: [
            { mark: 'bold', set: true },
            { mark: 'strike', set: false },
          ],
        },
      ]);
    });

    it('skips malformed entries: both replace and format, neither, empty find, no known styles', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', replace: 'B', format: { bold: true } } as never,
        { find: 'beta' } as never,
        { find: '', format: { bold: true } },
        { find: 'beta', format: { underline: true } as never },
      ]);
      expect(skipped).toBe(4);
      expect(placed).toHaveLength(0);
    });

    it('skips structurally invalid entries from untrusted model JSON without throwing', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        null as never,
        'not an edit' as never,
        { find: 42, replace: 'X' } as never,
        { find: 'beta', format: ['bold'] as never },
        { find: 'gamma', replace: 'G' },
      ]);
      expect(skipped).toBe(4);
      expect(placed).toEqual([{ kind: 'text', from: 12, to: 17, replace: 'G' }]);
    });

    it('skips a format op that overlaps a text replacement from the same block', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, skipped } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha beta', replace: 'rewritten' },
        { find: 'beta', format: { italic: true } },
      ]);
      expect(skipped).toBe(1);
      expect(placed).toEqual([{ kind: 'text', from: 1, to: 11, replace: 'rewritten' }]);
    });

    it("blocks a format op touching another author's pending format suggestion", () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      // Maz suggests bolding "beta" first…
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('maz');
      editor.chain().setTextSelection({ from: 7, to: 11 }).toggleBold().run();

      const doc = editor.state.doc;
      // …then a Claude reply proposes italicizing overlapping text.
      const { placed, skipped } = planEdits(
        doc,
        0,
        doc.content.size,
        [
          { find: 'beta gamma', format: { italic: true } },
          { find: 'alpha', format: { italic: true } },
        ],
        'claude',
      );
      expect(skipped).toBe(1);
      expect(placed).toEqual([
        {
          kind: 'format',
          from: 1,
          to: 6,
          marks: [{ mark: 'italic', set: true }],
        },
      ]);
    });

    it('applies through the engine as one format suggestion with origin stamped', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', format: { bold: true } },
      ]);

      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('claude');
      editor.commands.setTrackChangesOrigin('comment-9');
      for (const e of placed) {
        if (e.kind !== 'format') continue;
        let chain = editor.chain().setTextSelection({ from: e.from, to: e.to });
        for (const op of e.marks) {
          chain = op.set ? chain.setMark(op.mark) : chain.unsetMark(op.mark);
        }
        chain.run();
      }
      editor.commands.setTrackChangesOrigin(null);

      const formats = getTrackedChanges(editor).filter((c) => c.operation === 'format');
      expect(formats).toHaveLength(1);
      expect(formats[0]).toMatchObject({
        authorID: 'claude',
        status: 'pending',
        originCommentId: 'comment-9',
      });
    });
  });

  describe('applying planned edits as tracked changes', () => {
    it('produces tracked delete+insert with the claude author and restores mode', () => {
      editor = makeEditor('<p>the cat are happy</p>');
      const doc = editor.state.doc;
      const { placed } = planEdits(doc, 0, doc.content.size, [
        { find: 'cat are', replace: 'cats are' },
      ]);

      // Simulate what App.applyTrackedEdits does.
      const storage = editor.storage as unknown as Record<
        string,
        { enabled: boolean; authorID: string }
      >;
      const priorEnabled = storage['trackChanges'].enabled;
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('claude');
      for (const e of placed) {
        if (e.kind !== 'text') continue;
        editor.chain().setTextSelection({ from: e.from, to: e.to }).insertContent(e.replace).run();
      }
      editor.commands.setTrackChangesEnabled(priorEnabled);

      const changes = getTrackedChanges(editor);
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((c) => c.authorID === 'claude')).toBe(true);
      const ops = new Set(changes.map((c) => c.operation));
      expect(ops.has('delete')).toBe(true);
      expect(ops.has('insert')).toBe(true);

      // Mode restored to its prior (disabled) value.
      expect(storage['trackChanges'].enabled).toBe(priorEnabled);
    });
  });
});
