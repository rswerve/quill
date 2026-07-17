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
  formatEditResultNotice,
  locateEdit,
  mapRangeTextOffsetToPos,
  planEdits,
  rangeText,
  resolveScopeRange,
} from '../../utils/trackedEdits';
import { buildLinkReplacementContent } from '../../utils/linkEditing';

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

    it('locates a Markdown-style blank-line find across sibling paragraphs', () => {
      editor = makeEditor('<p>alpha one</p><p>beta two</p>');
      const doc = editor.state.doc;
      const at = locateEdit(doc, 0, doc.content.size, 'alpha one\n\nbeta two');

      expect(at).not.toBeNull();
      expect(doc.textBetween(at!.from, at!.to, '\n', ' ')).toBe('alpha one\nbeta two');
    });

    it('prefers a genuine verbatim blank-line match over an earlier collapsed match', () => {
      editor = makeEditor('<p>alpha</p><p>beta</p><p>alpha</p><p></p><p>beta</p>');
      const doc = editor.state.doc;
      const at = locateEdit(doc, 0, doc.content.size, 'alpha\n\nbeta');

      expect(at).not.toBeNull();
      expect(at!.from).toBeGreaterThan(1);
      expect(doc.textBetween(at!.from, at!.to, '\n', ' ')).toBe('alpha\n\nbeta');
    });

    it('does not broaden a single-newline find across a genuine empty paragraph', () => {
      editor = makeEditor('<p>alpha</p><p></p><p>beta</p>');
      const doc = editor.state.doc;

      expect(locateEdit(doc, 0, doc.content.size, 'alpha\nbeta')).toBeNull();
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
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha', replace: 'A' },
        { find: 'gamma', replace: 'G' },
        { find: 'missing', replace: 'X' },
      ]);
      expect(results.map((candidate) => candidate.status)).toEqual([
        'applied',
        'applied',
        'not-found',
      ]);
      expect(placed).toHaveLength(2);
      // Back-to-front: gamma (later) comes first.
      expect(placed[0].from).toBeGreaterThan(placed[1].from);
      expect(placed[0]).toMatchObject({ kind: 'text', replace: 'G', editIndex: 1 });
      expect(placed[1]).toMatchObject({ kind: 'text', replace: 'A', editIndex: 0 });
    });

    it('accepts a model edit that spells an existing link with Markdown syntax', () => {
      editor = makeEditor(
        '<h1>Header</h1><p><a href="https://www.cnn.com">some text</a></p>' +
          '<p><strong>bold</strong> word</p><p>Body paragraph.</p>',
      );
      const doc = editor.state.doc;

      // Claude sees Markdown in the prompt, but the planner searches the
      // ProseMirror document's visible text. The link mark itself is locatable;
      // only the Markdown spelling is absent from that plaintext projection.
      expect(locateEdit(doc, 0, doc.content.size, 'some text')).not.toBeNull();
      expect(locateEdit(doc, 0, doc.content.size, '[some text](https://www.cnn.com)')).toBeNull();

      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'Header', replace: 'Test Notes' },
        {
          find: '[some text](https://www.cnn.com)',
          replace: '[CNN](https://www.cnn.com)',
        },
      ]);

      expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
      expect(placed).toHaveLength(2);
      expect(placed).toContainEqual({
        kind: 'text',
        from: 9,
        to: 18,
        replace: 'CNN',
        linkHref: 'https://www.cnn.com',
        editIndex: 1,
      });
    });

    it('uses the href to disambiguate repeated visible link labels', () => {
      editor = makeEditor(
        '<p><a href="https://one.example">same</a> and ' +
          '<a href="https://two.example">same</a> and plain</p>',
      );
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: '[same](https://one.example)', replace: 'first' },
      ]);

      expect(results[0]).toMatchObject({ status: 'applied' });
      expect(placed).toEqual([
        expect.objectContaining({
          kind: 'text',
          replace: 'first',
          linkHref: 'https://one.example',
        }),
      ]);
    });

    it('fails closed for exact duplicates, mismatched, plain, and malformed Markdown links', () => {
      editor = makeEditor(
        '<p><a href="https://one.example">same</a> and ' +
          '<a href="https://one.example">same</a> and plain</p>',
      );
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: '[same](https://one.example)', replace: 'new' },
        { find: '[plain](https://plain.example)', replace: 'new' },
        { find: '[same](https://wrong.example)', replace: 'new' },
        { find: '[same](https://one.example', replace: 'new' },
      ]);

      expect(placed).toHaveLength(0);
      expect(results.map(({ status, reason }) => ({ status, reason }))).toEqual([
        { status: 'conflict', reason: 'ambiguous-link' },
        { status: 'not-found', reason: 'link-not-found' },
        { status: 'not-found', reason: 'link-target-mismatch' },
        { status: 'not-found', reason: 'text-not-found' },
      ]);
    });

    it('keeps the href for a plain replacement and updates it for a Markdown-link replacement', () => {
      editor = makeEditor('<p><a href="https://old.example">old label</a></p>');
      const doc = editor.state.doc;
      const plain = planEdits(doc, 0, doc.content.size, [
        { find: '[old label](https://old.example)', replace: 'new label' },
      ]);
      const changed = planEdits(doc, 0, doc.content.size, [
        {
          find: '[old label](https://old.example)',
          replace: '[new label](https://new.example)',
        },
      ]);

      expect(plain.placed[0]).toMatchObject({
        kind: 'text',
        replace: 'new label',
        linkHref: 'https://old.example',
      });
      expect(changed.placed[0]).toMatchObject({
        kind: 'text',
        replace: 'new label',
        linkHref: 'https://new.example',
      });
    });

    it('rejects a unique label when its live link destination differs', () => {
      editor = makeEditor('<p><a href="https://actual.example">same</a></p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: '[same](https://wrong.example)', replace: 'new' },
      ]);

      expect(placed).toHaveLength(0);
      expect(results[0]).toMatchObject({
        status: 'not-found',
        reason: 'link-target-mismatch',
      });
    });

    it('skips a text-identical edit (formatting-only ask) instead of placing it', () => {
      // find === replace can only be a formatting change, which find/replace
      // cannot express — placing it would mint a fake tracked pair whose
      // accept no-ops or strips formatting. It must count as skipped.
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', replace: 'beta' },
      ]);
      expect(results[0]).toMatchObject({ status: 'no-op', reason: 'already-applied' });
      expect(placed).toHaveLength(0);
    });

    it('still places a real edit alongside a skipped text-identical one', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha', replace: 'alpha' },
        { find: 'gamma', replace: 'G' },
      ]);
      expect(results.map((candidate) => candidate.status)).toEqual(['no-op', 'applied']);
      expect(placed).toHaveLength(1);
      expect(placed[0]).toMatchObject({ kind: 'text', replace: 'G' });
    });
  });

  describe('formatEditResultNotice', () => {
    it('names each skipped edit and its precise reason without dumping a long find', () => {
      const notice = formatEditResultNotice([
        {
          edit: { find: 'missing phrase', replace: 'replacement' },
          status: 'not-found',
          reason: 'text-not-found',
        },
        {
          edit: { find: `[${'x'.repeat(120)}](https://example.com)`, replace: 'short' },
          status: 'conflict',
          reason: 'ambiguous-link',
        },
        {
          edit: { find: 'already right', replace: 'already right' },
          status: 'no-op',
          reason: 'already-applied',
        },
      ]);

      // Heading attributes the outcome (not applied) without the error-tinged
      // "skipped"; pluralizes with the count.
      expect(notice).toContain('3 changes weren’t applied:');
      expect(notice).toContain('“missing phrase” — this text isn’t in the document.');
      expect(notice).toContain('more than one link has that label.');
      expect(notice).toContain('“already right” — it already matches the proposal.');
      expect(notice).not.toContain('x'.repeat(80));
    });

    it('explains planner and engine structural conflicts honestly', () => {
      const notice = formatEditResultNotice([
        {
          edit: { find: 'first\nsecond', replace: 'merged' },
          status: 'conflict',
          reason: 'structural-change',
        },
        {
          edit: { find: 'pending text', replace: 'replacement' },
          status: 'conflict',
          reason: 'engine-blocked',
        },
      ]);

      expect(notice).toContain(
        'structural changes can’t be tracked as suggestions yet. Make this change in Editing mode.',
      );
      expect(notice).toContain(
        'Suggesting mode can’t safely track this change in that content, or it conflicts with another author’s pending suggestion. Make it in Editing mode or resolve the existing suggestion first.',
      );
    });
  });

  describe('planEdits format ops', () => {
    it('places a format edit with mapped mark names (strikethrough → strike)', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', format: { bold: true, strikethrough: false } },
      ]);
      expect(results[0].status).toBe('applied');
      expect(placed).toEqual([
        {
          kind: 'format',
          from: 7,
          to: 11,
          editIndex: 0,
          marks: [
            { mark: 'bold', set: true },
            { mark: 'strike', set: false },
          ],
        },
      ]);
    });

    it('skips malformed entries: ambiguous both, neither, empty find, no known styles', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'beta', replace: 'B', format: { bold: true } } as never,
        { find: 'beta', replace: 'beta', format: { underline: true } } as never,
        { find: 'beta' } as never,
        { find: '', format: { bold: true } },
        { find: 'beta', format: { underline: true } as never },
      ]);
      expect(results.every((candidate) => candidate.status === 'malformed')).toBe(true);
      expect(placed).toHaveLength(0);
    });

    it('blocks cross-paragraph text edits but still plans cross-paragraph format ops', () => {
      editor = makeEditor('<p>alpha one</p><p>beta two</p><p>gamma three</p>');
      const doc = editor.state.doc;
      const find = 'alpha one\n\nbeta two';
      const text = planEdits(doc, 0, doc.content.size, [{ find, replace: 'rewritten' }]);
      const format = planEdits(doc, 0, doc.content.size, [{ find, format: { italic: true } }]);

      expect(text.results[0]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
      expect(text.placed).toHaveLength(0);
      expect(format.results[0].status).toBe('applied');
      expect(format.placed).toEqual([
        {
          kind: 'format',
          from: 1,
          to: 20,
          editIndex: 0,
          marks: [{ mark: 'italic', set: true }],
        },
      ]);
    });

    it('blocks cross-paragraph deletion before the tracking engine can swallow it', () => {
      editor = makeEditor('<p>alpha one</p><p>beta two</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha one\n\nbeta two', replace: '' },
      ]);

      expect(results[0]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
      expect(placed).toHaveLength(0);
    });

    it('allows hard-break replacements in prose but blocks mark-ineligible code blocks', () => {
      editor = makeEditor('<p>alpha beta</p>');
      const prose = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
        { find: 'alpha beta', replace: 'alpha\nbeta' },
      ]);
      expect(prose.results[0]).toMatchObject({ status: 'applied' });
      expect(prose.placed).toEqual([
        expect.objectContaining({ kind: 'text', replace: 'alpha\nbeta' }),
      ]);

      editor.destroy();
      editor = makeEditor('<pre><code>alpha beta</code></pre>');
      const codeNewline = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
        { find: 'alpha beta', replace: 'alpha\nbeta' },
      ]);
      expect(codeNewline.results[0]).toMatchObject({
        status: 'conflict',
        reason: 'engine-blocked',
      });
      expect(codeNewline.placed).toHaveLength(0);

      const codeInline = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
        { find: 'alpha beta', replace: 'gamma' },
      ]);
      expect(codeInline.results[0]).toMatchObject({
        status: 'conflict',
        reason: 'engine-blocked',
      });
      expect(codeInline.placed).toHaveLength(0);

      const codeFormat = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
        { find: 'alpha beta', format: { bold: true } },
      ]);
      expect(codeFormat.results[0]).toMatchObject({
        status: 'conflict',
        reason: 'engine-blocked',
      });
      expect(codeFormat.placed).toHaveLength(0);
    });

    it('skips structurally invalid entries from untrusted model JSON without throwing', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        null as never,
        'not an edit' as never,
        { find: 42, replace: 'X' } as never,
        { find: 'beta', format: ['bold'] as never },
        { find: 'gamma', replace: 'G' },
      ]);
      expect(results.filter((candidate) => candidate.status === 'malformed')).toHaveLength(4);
      expect(placed).toEqual([{ kind: 'text', from: 12, to: 17, replace: 'G', editIndex: 4 }]);
    });

    it('skips format ops whose target already matches the requested state', () => {
      // Bolding already-bold text mints no marker in the engine; counting it
      // as applied would report suggestions that produce no cards.
      editor = makeEditor('<p><strong>alpha</strong> beta</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha', format: { bold: true } },
        { find: 'beta', format: { italic: false } },
        { find: 'beta', format: { bold: true, italic: false } },
      ]);
      expect(results.filter((candidate) => candidate.status === 'no-op')).toHaveLength(2);
      expect(placed).toEqual([
        {
          kind: 'format',
          from: 7,
          to: 11,
          editIndex: 2,
          marks: [
            { mark: 'bold', set: true },
            { mark: 'italic', set: false },
          ],
        },
      ]);
    });

    it('skips a format op that overlaps a text replacement from the same block', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [
        { find: 'alpha beta', replace: 'rewritten' },
        { find: 'beta', format: { italic: true } },
      ]);
      expect(results[1]).toMatchObject({ status: 'conflict', reason: 'overlapping-edit' });
      expect(placed).toEqual([
        { kind: 'text', from: 1, to: 11, replace: 'rewritten', editIndex: 0 },
      ]);
    });

    it("blocks a format op touching another author's pending format suggestion", () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      // Maz suggests bolding "beta" first…
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('maz');
      editor.chain().setTextSelection({ from: 7, to: 11 }).toggleBold().run();

      const doc = editor.state.doc;
      // …then a Claude reply proposes italicizing overlapping text.
      const { placed, results } = planEdits(
        doc,
        0,
        doc.content.size,
        [
          { find: 'beta gamma', format: { italic: true } },
          { find: 'alpha', format: { italic: true } },
        ],
        'claude',
      );
      expect(results[0]).toMatchObject({ status: 'conflict', reason: 'pending-suggestion' });
      expect(placed).toEqual([
        {
          kind: 'format',
          from: 1,
          to: 6,
          editIndex: 1,
          marks: [{ mark: 'italic', set: true }],
        },
      ]);
    });

    it('applies a format op with a redundant identical replacement through the engine', () => {
      editor = makeEditor('<p>alpha beta gamma</p>');
      const doc = editor.state.doc;
      const edit = { find: 'beta', replace: 'beta', format: { bold: true } } as never;
      const { placed, results } = planEdits(doc, 0, doc.content.size, [edit]);

      expect(results).toEqual([{ edit, status: 'applied' }]);
      expect(placed[0]).toMatchObject({ kind: 'format' });

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

      const formats = getTrackedChanges(editor).filter((change) =>
        change.segments.some((segment) => segment.kind === 'format'),
      );
      expect(formats).toHaveLength(1);
      expect(formats[0]).toMatchObject({
        authorID: 'claude',
        status: 'pending',
        originCommentId: 'comment-9',
      });
    });
  });

  describe('applying planned edits as tracked changes', () => {
    function applyPlannedLinkReplacement(replace: string, href: string) {
      const doc = editor.state.doc;
      const { placed } = planEdits(doc, 0, doc.content.size, [
        {
          find: '[old label](https://old.example)',
          replace: `[${replace}](${href})`,
        },
      ]);
      const edit = placed[0];
      expect(edit).toMatchObject({ kind: 'text', replace, linkHref: href });
      if (edit.kind !== 'text' || !edit.linkHref) throw new Error('expected planned link edit');
      const content = buildLinkReplacementContent(editor, edit, edit.linkHref, edit.replace);
      expect(content).not.toBeNull();
      editor.commands.setTrackChangesEnabled(true);
      editor.commands.setTrackChangesAuthor('claude');
      editor
        .chain()
        .setTextSelection({ from: edit.from, to: edit.to })
        .insertContent(content!)
        .run();
      const change = getTrackedChanges(editor).find(
        (candidate) =>
          candidate.segments.some((segment) => segment.kind === 'delete') &&
          candidate.segments.some((segment) => segment.kind === 'insert'),
      );
      if (!change) throw new Error('expected tracked text change');
      return change.id;
    }

    it('accepts or rejects a Markdown-link replacement with the correct href', () => {
      editor = makeEditor('<p><a href="https://old.example">old label</a></p>');
      const acceptedId = applyPlannedLinkReplacement('new label', 'https://new.example');
      editor.commands.resolveChange(acceptedId, 'accept');
      expect(editor.view.dom.querySelector('a')).toMatchObject({
        href: 'https://new.example/',
        textContent: 'new label',
      });

      editor.destroy();
      editor = makeEditor('<p><a href="https://old.example">old label</a></p>');
      const rejectedId = applyPlannedLinkReplacement('new label', 'https://new.example');
      editor.commands.resolveChange(rejectedId, 'reject');
      expect(editor.view.dom.querySelector('a')).toMatchObject({
        href: 'https://old.example/',
        textContent: 'old label',
      });
    });

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
      const ops = new Set(
        changes.flatMap((change) => change.segments.map((segment) => segment.kind)),
      );
      expect(ops.has('delete')).toBe(true);
      expect(ops.has('insert')).toBe(true);

      // Mode restored to its prior (disabled) value.
      expect(storage['trackChanges'].enabled).toBe(priorEnabled);
    });
  });
});
