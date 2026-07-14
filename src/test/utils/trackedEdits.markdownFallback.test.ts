import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { planEdits, type PlacedEdit } from '../../utils/trackedEdits';

function makeEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content,
  });
}

function applyTextEdit(editor: Editor, edit: PlacedEdit): string {
  if (edit.kind !== 'text') throw new Error('expected a text edit');
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('claude');
  editor
    .chain()
    .setTextSelection({ from: edit.from, to: edit.to })
    .insertContent(edit.replace)
    .run();
  const change = getTrackedChanges(editor).find(
    (candidate) =>
      candidate.segments.some((segment) => segment.kind === 'insert') &&
      candidate.segments.some((segment) => segment.kind === 'delete'),
  );
  if (!change) throw new Error('expected a tracked replacement');
  return change.id;
}

describe('Markdown-tolerant edit planning', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.innerHTML = '';
  });

  it('locates the reported bold-line edit and normalizes its replacement', () => {
    editor = makeEditor('<p><strong>Q2 contrast — a real Design spec bug</strong></p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      {
        find: '**Q2 contrast — a real Design spec bug**',
        replace: '**Clearer Q2 contrast**',
      },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed).toEqual([
      {
        kind: 'text',
        from: 1,
        to: 37,
        replace: 'Clearer Q2 contrast',
      },
    ]);
  });

  it.each([
    ['italic', '<p><em>target words</em></p>', '_target words_'],
    ['inline code', '<p><code>target words</code></p>', '`target words`'],
    ['strikethrough', '<p><s>target words</s></p>', '~~target words~~'],
  ])('locates a %s-marked find against the matching live mark', (_name, content, find) => {
    editor = makeEditor(content);
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find, replace: 'replacement' },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed[0]).toMatchObject({ kind: 'text', from: 1, to: 13 });
    expect(editor.state.doc.textBetween(placed[0].from, placed[0].to)).toBe('target words');
  });

  it.each([
    ['heading', '<h1>Target title</h1>', '# Target title'],
    ['bullet list', '<ul><li><p>Target item</p></li></ul>', '- Target item'],
    ['ordered list', '<ol><li><p>Target item</p></li></ol>', '1. Target item'],
  ])('locates a %s prefix only in the corresponding block shape', (_name, content, find) => {
    editor = makeEditor(content);
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find, replace: 'Replacement' },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed).toHaveLength(1);
    expect(editor.state.doc.textBetween(placed[0].from, placed[0].to)).toBe(
      find.replace(/^(?:#|-|1\.)\s+/, ''),
    );
  });

  it('rejects a block prefix when the live candidate is in a different block shape', () => {
    editor = makeEditor('<p>Target title</p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: '# Target title', replace: 'Replacement' },
    ]);

    expect(placed).toHaveLength(0);
    expect(results[0]).toMatchObject({
      status: 'not-found',
      reason: 'markdown-format-mismatch',
    });
  });

  it('validates nested and partial formatting across the whole normalized find', () => {
    editor = makeEditor('<p>Start <strong>bold <em>and italic</em></strong> then plain</p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      {
        find: 'Start **bold _and italic_** then plain',
        replace: 'A clearer mixed-format sentence',
      },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed).toHaveLength(1);
    expect(editor.state.doc.textBetween(placed[0].from, placed[0].to)).toBe(
      'Start bold and italic then plain',
    );
  });

  it('fails closed when more than one candidate has the implied formatting', () => {
    editor = makeEditor('<p><strong>repeat</strong> and <strong>repeat</strong></p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: '**repeat**', replace: 'replacement' },
    ]);

    expect(placed).toHaveLength(0);
    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'ambiguous-markdown' });
  });

  it('keeps verbatim marker text ahead of normalization', () => {
    editor = makeEditor('<p>Literal **target** then <strong>target</strong></p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: '**target**', replace: 'literal replacement' },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed).toHaveLength(1);
    expect(editor.state.doc.textBetween(placed[0].from, placed[0].to)).toBe('**target**');
  });

  it.each(['Use * literally', 'Use _ literally', 'Use ` literally'])(
    'does not reinterpret the verbatim text %j',
    (find) => {
      editor = makeEditor(`<p>${find}</p>`);
      const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
        { find, replace: 'replacement' },
      ]);

      expect(results[0]).toMatchObject({ status: 'applied' });
      expect(editor.state.doc.textBetween(placed[0].from, placed[0].to)).toBe(find);
    },
  );

  it('rejects a normalized candidate whose live marks do not match the implied bold', () => {
    editor = makeEditor('<p>plain</p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: '**plain**', replace: 'replacement' },
    ]);

    expect(placed).toHaveLength(0);
    expect(results[0]).toMatchObject({
      status: 'not-found',
      reason: 'markdown-format-mismatch',
    });
  });

  it('uses the only candidate whose live formatting matches the Markdown find', () => {
    editor = makeEditor('<p>plain then <strong>plain</strong></p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: '**plain**', replace: 'replacement' },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed).toHaveLength(1);
    expect(placed[0].from).toBeGreaterThan(1);
    expect(editor.state.doc.textBetween(placed[0].from, placed[0].to)).toBe('plain');
  });

  it('fails closed when replacement Markdown requests a different formatting shape', () => {
    editor = makeEditor('<p><strong>old words</strong></p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: '**old words**', replace: '_new words_' },
    ]);

    expect(placed).toHaveLength(0);
    expect(results[0]).toMatchObject({
      status: 'malformed',
      reason: 'markdown-format-change',
    });
  });

  it('leaves the verbatim plain-text planning path unchanged', () => {
    editor = makeEditor('<p>plain control line</p>');
    const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
      { find: 'plain control line', replace: 'clear control line' },
    ]);

    expect(results[0]).toMatchObject({ status: 'applied' });
    expect(placed).toEqual([{ kind: 'text', from: 1, to: 19, replace: 'clear control line' }]);
  });

  it.each(['accept', 'reject'] as const)(
    '%s resolves a normalized replacement without losing the original bold mark',
    (action) => {
      editor = makeEditor('<p><strong>old words</strong></p>');
      const { placed, results } = planEdits(editor.state.doc, 0, editor.state.doc.content.size, [
        { find: '**old words**', replace: 'new words' },
      ]);
      expect(results[0]).toMatchObject({ status: 'applied' });
      const id = applyTextEdit(editor, placed[0]);

      editor.commands.resolveChange(id, action);

      const expected = action === 'accept' ? 'new words' : 'old words';
      expect(editor.getHTML()).toBe(`<p><strong>${expected}</strong></p>`);
      expect(getTrackedChanges(editor)).toHaveLength(0);
    },
  );
});
