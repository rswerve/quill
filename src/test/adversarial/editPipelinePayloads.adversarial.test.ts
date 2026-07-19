import { afterEach, describe, expect, it } from 'vitest';
import type { QuillEdit } from '../../types';
import {
  acceptedText,
  applyEdits,
  destroyPipelineEditors,
  makePipelineEditor,
  trackedIds,
} from './editPipelineHarness';

describe('edit pipeline adversarial payloads', () => {
  afterEach(destroyPipelineEditors);

  it('treats an empty find as an insertion at the start of scope', () => {
    const editor = makePipelineEditor('<p>existing text</p>');

    const outcome = applyEdits(editor, [{ find: '', replace: 'preface ' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe('preface existing text');
  });

  it('replaces the first exact whitespace-only find without normalizing it', () => {
    const editor = makePipelineEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha  beta   gamma' }] }],
    });

    const outcome = applyEdits(editor, [{ find: '  ', replace: ' / ' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(acceptedText(editor)).toBe('alpha / beta   gamma');
  });

  it('replaces only the first occurrence of repeated plain text', () => {
    const editor = makePipelineEditor('<p>repeat middle repeat end repeat</p>');

    const outcome = applyEdits(editor, [{ find: 'repeat', replace: 'FIRST' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(acceptedText(editor)).toBe('FIRST middle repeat end repeat');
  });

  it('fails closed for an ambiguous Markdown-formatted find', () => {
    const editor = makePipelineEditor('<p><strong>repeat</strong> and <strong>repeat</strong></p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [{ find: '**repeat**', replace: 'replacement' }]);

    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'ambiguous-markdown',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('uses an exact href to disambiguate repeated visible link labels', () => {
    const editor = makePipelineEditor(
      '<p><a href="https://one.example">same</a> and <a href="https://two.example">same</a></p>',
    );

    const outcome = applyEdits(editor, [
      { find: '[same](https://one.example)', replace: '[first](https://one.example)' },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    const links: Array<{ text: string; href: string }> = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const link = node.marks.find((mark) => mark.type.name === 'link');
      if (link) links.push({ text: node.text ?? '', href: link.attrs.href as string });
    });
    expect(links).toEqual([
      { text: 'first', href: 'https://one.example' },
      { text: 'same', href: 'https://two.example' },
    ]);
  });

  it('replaces text spanning bold, italic, strike, and link boundaries', () => {
    const editor = makePipelineEditor(
      '<p><strong>bold</strong> <em>italic</em> <s>strike</s> <a href="https://example.com">link</a></p>',
    );

    const outcome = applyEdits(editor, [
      { find: 'bold italic strike link', replace: 'one replacement' },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe('one replacement');
  });

  it('uses Markdown link syntax to update label and destination through the engine', () => {
    const editor = makePipelineEditor(
      '<p>Read <a href="https://old.example/path">the guide</a> today.</p>',
    );

    const outcome = applyEdits(editor, [
      {
        find: '[the guide](https://old.example/path)',
        replace: '[the handbook](https://new.example/path)',
      },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe('Read the handbook today.');
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toContain('href="https://new.example/path"');
  });

  it.each(['javascript:alert(1)', 'data:text/html,pwned'])(
    'rejects unsafe link href %j',
    (href) => {
      const editor = makePipelineEditor('<p><a href="https://safe.example">safe label</a></p>');
      const before = editor.state.doc;

      const outcome = applyEdits(editor, [
        {
          find: '[safe label](https://safe.example)',
          replace: `[unsafe label](${href})`,
        },
      ]);

      expect(outcome.results[0]).toMatchObject({ status: 'malformed', reason: 'invalid-link' });
      expect(outcome.suggestionIds).toEqual([]);
      expect(editor.state.doc.eq(before)).toBe(true);
    },
  );

  it('cannot even see a foreign pending insertion in the source view (find not found)', () => {
    const editor = makePipelineEditor('<p>alpha omega</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('maz');
    editor.commands.insertContentAt(7, 'pending ');
    const before = editor.state.doc;
    const existingIds = trackedIds(editor);

    const outcome = applyEdits(editor, [{ find: 'pending omega', replace: 'Claude replacement' }]);

    // Source view HIDES the pending insertion, so "pending" is not in the
    // document Claude was given — its find is honestly not found, doc unchanged.
    expect(outcome.results[0]).toMatchObject({
      status: 'not-found',
      reason: 'text-not-found',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(trackedIds(editor)).toEqual(existingIds);
  });

  it('refuses an edit landing on a foreign pending format, leaving the review doc unchanged', () => {
    const editor = makePipelineEditor('<p>alpha beta omega</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('maz');
    editor.chain().setTextSelection({ from: 7, to: 11 }).toggleBold().run();
    const before = editor.state.doc;
    const existingIds = trackedIds(editor);

    const outcome = applyEdits(editor, [{ find: 'beta omega', format: { italic: true } }]);

    // The source view keeps that text but its pending format mark is unresolved:
    // the mapped live range overlaps it → refuse rather than rewrite it.
    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'source-view-conflict',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(trackedIds(editor)).toEqual(existingIds);
  });

  it('refuses an edit landing on a foreign pending deletion, leaving the review doc unchanged', () => {
    const editor = makePipelineEditor('<p>alpha beta omega</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('maz');
    editor.commands.deleteRange({ from: 7, to: 12 });
    const before = editor.state.doc;
    const existingIds = trackedIds(editor);

    const outcome = applyEdits(editor, [{ find: 'beta omega', replace: 'Claude replacement' }]);

    // Source view RETAINS the pending deletion text, so the find matches — but the
    // mapped live range overlaps the pending deletion, so refuse.
    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'source-view-conflict',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(trackedIds(editor)).toEqual(existingIds);
  });

  it('refuses restacking over ANY pending change, including its own (source-view policy)', () => {
    // Stricter than the old cross-author policy by design: with the clean-source
    // document, Claude works from committed text and must never rewrite an
    // unresolved suggestion — even one it made earlier.
    const editor = makePipelineEditor('<p>alpha beta omega</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.commands.deleteRange({ from: 7, to: 12 });
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [{ find: 'beta omega', replace: 'Claude replacement' }]);

    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'source-view-conflict',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('reports a text edit and an overlapping format edit independently', () => {
    const editor = makePipelineEditor('<p>alpha beta gamma</p>');

    const outcome = applyEdits(editor, [
      { find: 'alpha beta', replace: 'rewritten' },
      { find: 'beta', format: { italic: true } },
    ]);

    expect(outcome.results).toMatchObject([
      { status: 'applied' },
      { status: 'conflict', reason: 'overlapping-edit' },
    ]);
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe('rewritten gamma');
  });

  it('handles two partially overlapping text edits without silent mutation', () => {
    const editor = makePipelineEditor('<p>alpha beta gamma</p>');

    const outcome = applyEdits(editor, [
      { find: 'alpha beta', replace: 'FIRST' },
      { find: 'beta gamma', replace: 'SECOND' },
    ]);

    expect(outcome.results).toMatchObject([
      { status: 'conflict', reason: 'overlapping-edit' },
      { status: 'conflict', reason: 'overlapping-edit' },
    ]);
    expect(outcome.suggestionIds).toEqual([]);
    expect(acceptedText(editor)).toBe('alpha beta gamma');
    editor.commands.acceptAllChanges();
    expect(acceptedText(editor)).toBe('alpha beta gamma');
  });

  it('does not mint duplicate suggestions for duplicate identical edits', () => {
    const editor = makePipelineEditor('<p>alpha beta gamma</p>');

    const edit = { find: 'beta', replace: 'BETA' };
    const outcome = applyEdits(editor, [edit, edit]);

    expect(outcome.results).toMatchObject([{ status: 'applied' }, { status: 'no-op' }]);
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe('alpha BETA gamma');
    editor.commands.acceptAllChanges();
    expect(acceptedText(editor)).toBe('alpha BETA gamma');
  });

  it('does not over-report duplicate identical format operations', () => {
    const editor = makePipelineEditor('<p>alpha beta gamma</p>');

    const edit = { find: 'beta', format: { italic: true } } as const;
    const outcome = applyEdits(editor, [edit, edit]);

    expect(outcome.results).toMatchObject([
      { status: 'applied' },
      { status: 'no-op', reason: 'already-applied' },
    ]);
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe('<p>alpha <em>beta</em> gamma</p>');
  });

  it('keeps adjacent text edits independent', () => {
    const editor = makePipelineEditor('<p>alpha beta</p>');

    const outcome = applyEdits(editor, [
      { find: 'alpha', replace: 'A' },
      { find: ' beta', replace: ' B' },
    ]);

    expect(outcome.results).toMatchObject([{ status: 'applied' }, { status: 'applied' }]);
    expect(outcome.suggestionIds.length).toBeGreaterThan(0);
    editor.commands.acceptAllChanges();
    expect(acceptedText(editor)).toBe('A B');
  });

  it('rejects an overlapping group but still applies a disjoint edit from the payload', () => {
    const editor = makePipelineEditor('<p>alpha beta gamma delta</p>');

    const outcome = applyEdits(editor, [
      { find: 'alpha beta', replace: 'FIRST' },
      { find: 'beta gamma', replace: 'SECOND' },
      { find: 'delta', replace: 'DELTA' },
    ]);

    expect(outcome.results).toMatchObject([
      { status: 'conflict', reason: 'overlapping-edit' },
      { status: 'conflict', reason: 'overlapping-edit' },
      { status: 'applied' },
    ]);
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    expect(acceptedText(editor)).toBe('alpha beta gamma DELTA');
  });

  it('rejects different insertions at the same source position as overlapping', () => {
    const editor = makePipelineEditor('<p>alpha</p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [
      { find: '', replace: 'first ' },
      { find: '', replace: 'second ' },
    ]);

    expect(outcome.results).toMatchObject([
      { status: 'conflict', reason: 'overlapping-edit' },
      { status: 'conflict', reason: 'overlapping-edit' },
    ]);
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it.each([
    ['heading', '<h2>Target title</h2>', '## Target title'],
    ['bullet item', '<ul><li><p>Target item</p></li></ul>', '- Target item'],
    ['ordered item', '<ol><li><p>Target item</p></li></ol>', '1. Target item'],
  ])('applies a Markdown-spelled %s find through the engine', (_label, html, find) => {
    const editor = makePipelineEditor(html);

    const outcome = applyEdits(editor, [{ find, replace: 'Replacement' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    expect(acceptedText(editor)).toBe('Replacement');
  });

  it('keeps result indexes aligned in a mixed good, malformed, missing, and blocked payload', () => {
    const editor = makePipelineEditor(
      '<p>alpha beta gamma</p><pre><code>blocked code</code></pre>',
    );
    const beforeCode = 'blocked code';
    const edits = [
      { find: 'alpha', replace: 'ALPHA' },
      { find: 'beta' } as never,
      { find: 'absent', replace: 'missing' },
      { find: beforeCode, format: { bold: true } },
      { find: 'gamma', format: { italic: true } },
    ] satisfies QuillEdit[];

    const outcome = applyEdits(editor, edits);

    expect(outcome.results).toMatchObject([
      { edit: edits[0], status: 'applied' },
      { edit: edits[1], status: 'malformed', reason: 'invalid-edit' },
      { edit: edits[2], status: 'not-found', reason: 'text-not-found' },
      { edit: edits[3], status: 'conflict', reason: 'engine-blocked' },
      { edit: edits[4], status: 'applied' },
    ]);
    expect(outcome.suggestionIds).toHaveLength(2);
    expect(acceptedText(editor)).toContain('ALPHA beta gamma');
    expect(acceptedText(editor)).toContain(beforeCode);
  });

  it('applies 128 unique replacements back-to-front without shifting any target', () => {
    const tokens = Array.from(
      { length: 128 },
      (_, index) => `token-${index.toString().padStart(3, '0')}`,
    );
    const editor = makePipelineEditor(`<p>${tokens.join(' | ')}</p>`);
    const edits = tokens.map((find, index) => ({ find, replace: `value-${index}` }));

    const outcome = applyEdits(editor, edits);

    expect(outcome.results).toHaveLength(128);
    expect(outcome.results.every((result) => result.status === 'applied')).toBe(true);
    expect(outcome.suggestionIds).toHaveLength(128);
    const accepted = acceptedText(editor);
    expect(accepted).toContain('value-0 | value-1');
    expect(accepted).toContain('value-126 | value-127');
    expect(accepted).not.toContain('token-');
  });

  it('leaves the document unchanged for an empty payload', () => {
    const editor = makePipelineEditor('<p>alpha beta</p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, []);

    expect(outcome).toEqual({ results: [], suggestionIds: [] });
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('leaves the document unchanged for exact no-ops and unknown formatting keys', () => {
    const editor = makePipelineEditor('<p>alpha beta</p>');
    const before = editor.state.doc;
    const unknownFormat = { find: 'beta', format: { superscript: true } } as never;

    const outcome = applyEdits(editor, [{ find: 'alpha', replace: 'alpha' }, unknownFormat]);

    expect(outcome.results).toMatchObject([
      { status: 'no-op', reason: 'already-applied' },
      { status: 'malformed', reason: 'invalid-edit' },
    ]);
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('accepts the model echo shape as one pure formatting suggestion', () => {
    const editor = makePipelineEditor('<p>pulled it off</p>');
    const edit = {
      find: 'pulled it off',
      replace: 'pulled it off',
      format: { italic: true },
    } as never;

    const outcome = applyEdits(editor, [edit]);

    expect(outcome.results).toEqual([{ edit, status: 'applied' }]);
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toContain('<em>pulled it off</em>');
  });

  it('inserts a hard break for a newline replacement inside one paragraph (Accept)', () => {
    // Slice 2: a newline replacement within one block is now a tracked
    // hard-break insertion, not a refusal.
    const editor = makePipelineEditor('<p>alpha beta</p>');

    const outcome = applyEdits(editor, [{ find: 'alpha beta', replace: 'alpha\nbeta' }]);
    expect(outcome.results[0].status).toBe('applied');
    expect(outcome.suggestionIds.length).toBeGreaterThan(0);

    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe('<p>alpha<br>beta</p>');
  });

  it('restores the single line when a hard-break insertion is rejected', () => {
    const editor = makePipelineEditor('<p>alpha beta</p>');
    const before = editor.state.doc;

    applyEdits(editor, [{ find: 'alpha beta', replace: 'alpha\nbeta' }]);
    editor.commands.rejectAllChanges();

    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.getHTML()).toBe('<p>alpha beta</p>');
  });

  it('still refuses a newline replacement that would cross a block boundary', () => {
    // The break exemption is single-block only — merging two paragraphs stays
    // structural.
    const editor = makePipelineEditor('<p>alpha</p><p>beta</p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [{ find: 'alpha\nbeta', replace: 'alpha\nbeta merged' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it.each([
    null,
    'string',
    42,
    [],
    { find: 12, replace: 'x' },
    { find: 'alpha', format: [] },
    { find: 'alpha', replace: false },
  ])('does not throw or mutate for malformed model entry %#', (raw) => {
    const editor = makePipelineEditor('<p>alpha beta</p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [raw as never]);

    expect(outcome.results[0]).toMatchObject({ status: 'malformed', reason: 'invalid-edit' });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });
});
