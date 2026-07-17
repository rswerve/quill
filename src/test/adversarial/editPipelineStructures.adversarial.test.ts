import { afterEach, describe, expect, it } from 'vitest';
import type { QuillEdit } from '../../types';
import {
  acceptedText,
  applyEdits,
  destroyPipelineEditors,
  makePipelineEditor,
  trackedIds,
} from './editPipelineHarness';

describe('edit pipeline adversarial document structures', () => {
  afterEach(destroyPipelineEditors);

  it.each([
    ['RTL', '<p>Start שלום עולם end</p>', 'שלום עולם', 'مرحبا بالعالم'],
    ['ZWJ emoji', '<p>Family 👩‍👩‍👧‍👦 launch</p>', '👩‍👩‍👧‍👦', '🧑🏽‍🚀'],
    ['combining marks', '<p>Cafe\u0301 noir</p>', 'Cafe\u0301', 'Cre\u0300me'],
  ])('tracks and resolves a replacement containing %s text', (_label, html, find, replace) => {
    const editor = makePipelineEditor(html);
    const original = editor.state.doc;

    const outcome = applyEdits(editor, [{ find, replace }]);

    expect(outcome.results).toEqual([{ edit: { find, replace }, status: 'applied' }]);
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toContain(replace);
    editor.commands.rejectAllChanges();
    expect(editor.state.doc.eq(original)).toBe(true);
  });

  it('tracks a replacement inside one deeply nested task-list item', () => {
    const editor = makePipelineEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>parent</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>deep target</p></div></li></ul></div></li></ul>',
    );

    const outcome = applyEdits(editor, [{ find: 'deep target', replace: 'deep result' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toContain('deep result');
  });

  it('fails closed for a text replacement spanning nested list items', () => {
    const editor = makePipelineEditor(
      '<ul><li><p>outer item</p><ul><li><p>inner item</p></li></ul></li></ul>',
    );
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [
      { find: 'outer item\n\ninner item', replace: 'flattened item' },
    ]);

    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'structural-change',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('tracks a format operation spanning nested list items without changing structure', () => {
    const editor = makePipelineEditor(
      '<ul><li><p>outer item</p><ul><li><p>inner item</p></li></ul></li></ul>',
    );
    const beforeText = acceptedText(editor);

    const outcome = applyEdits(editor, [
      { find: 'outer item\n\ninner item', format: { italic: true } },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe(beforeText);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toContain('<em>outer item</em>');
    expect(editor.getHTML()).toContain('<em>inner item</em>');
  });

  it('tracks a within-cell table replacement', () => {
    const editor = makePipelineEditor(
      '<table><tbody><tr><th><p>Key</p></th><th><p>Value</p></th></tr><tr><td><p>price</p></td><td><p>twelve dollars</p></td></tr></tbody></table>',
    );

    const outcome = applyEdits(editor, [{ find: 'twelve dollars', replace: 'fifteen dollars' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toContain('fifteen dollars');
  });

  it('fails closed for a replacement spanning table cells', () => {
    const editor = makePipelineEditor(
      '<table><tbody><tr><td><p>left cell</p></td><td><p>right cell</p></td></tr></tbody></table>',
    );
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [
      { find: 'left cell\n\nright cell', replace: 'merged cells' },
    ]);

    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'structural-change',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it.each([
    ['text replacement', { find: 'const value = 1;', replace: 'const value = 2;' }],
    ['format operation', { find: 'const value = 1;', format: { bold: true } }],
  ] as Array<[string, QuillEdit]>)('fails closed for a %s inside a code block', (_label, edit) => {
    const editor = makePipelineEditor('<pre><code>const value = 1;</code></pre>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [edit]);

    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'engine-blocked' });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('tracks a replacement across adjacent inline mark boundaries in a heading', () => {
    const editor = makePipelineEditor(
      '<h2><strong>Launch</strong> <em>brief</em> <a href="https://example.com">ready</a></h2>',
    );

    const outcome = applyEdits(editor, [
      { find: 'Launch brief ready', replace: 'Launch plan approved' },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(acceptedText(editor)).toBe('Launch plan approved');
  });

  it('tracks a within-paragraph replacement in a blockquote', () => {
    const editor = makePipelineEditor('<blockquote><p>quoted target words</p></blockquote>');

    const outcome = applyEdits(editor, [{ find: 'target words', replace: 'revised words' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(acceptedText(editor)).toBe('quoted revised words');
    expect(editor.getHTML()).toContain('<blockquote>');
  });

  it('fails closed when a text replacement consumes an inline image', () => {
    const editor = makePipelineEditor(
      '<p>before<img src="https://example.com/pixel.png" alt="pixel">after</p>',
    );
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [{ find: 'before after', replace: 'combined' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'engine-blocked' });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('tracks and resolves a text replacement that consumes a hard break', () => {
    const editor = makePipelineEditor('<p>before<br>after</p>');

    const outcome = applyEdits(editor, [{ find: 'before after', replace: 'combined' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    expect(trackedIds(editor)).toEqual(outcome.suggestionIds);
    expect(acceptedText(editor)).toBe('combined');
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe('<p>combined</p>');

    const rejected = makePipelineEditor('<p>before<br>after</p>');
    const original = rejected.state.doc;
    const rejectedOutcome = applyEdits(rejected, [{ find: 'before after', replace: 'combined' }]);
    expect(rejectedOutcome.results[0]).toMatchObject({ status: 'applied' });
    rejected.commands.rejectAllChanges();
    expect(rejected.state.doc.eq(original)).toBe(true);
  });

  it('tracks formatting across a hard break because no leaf is consumed', () => {
    const editor = makePipelineEditor('<p>before<br>after</p>');

    const outcome = applyEdits(editor, [{ find: 'before after', format: { strikethrough: true } }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toBe('<p><s>before</s><br><s>after</s></p>');
  });

  it('fails closed for an entire multi-block document replacement', () => {
    const editor = makePipelineEditor('<h1>Title</h1><p>First body.</p><p>Second body.</p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [
      {
        find: 'Title\n\nFirst body.\n\nSecond body.',
        replace: 'One flattened document',
      },
    ]);

    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'structural-change',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('formats an entire multi-block document while preserving every block', () => {
    const editor = makePipelineEditor('<h1>Title</h1><p>First body.</p><p>Second body.</p>');

    const outcome = applyEdits(editor, [
      {
        find: 'Title\n\nFirst body.\n\nSecond body.',
        format: { italic: true },
      },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.suggestionIds).toHaveLength(1);
    editor.commands.acceptAllChanges();
    expect(editor.getHTML()).toContain('<h1><em>Title</em></h1>');
    expect(editor.getHTML()).toContain('<p><em>Second body.</em></p>');
  });

  it('preserves pathological whitespace around a precise replacement', () => {
    const editor = makePipelineEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'alpha\t\tbe\u00a0ta   omega' }],
        },
      ],
    });

    const outcome = applyEdits(editor, [{ find: 'be\u00a0ta', replace: 'BETA' }]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(acceptedText(editor)).toBe('alpha\t\tBETA   omega');
  });

  it('does not mutate a genuine empty paragraph when a structural edit is skipped', () => {
    const editor = makePipelineEditor('<p>alpha</p><p></p><p>omega</p>');
    const before = editor.state.doc;
    const beforeTracked = trackedIds(editor);

    const outcome = applyEdits(editor, [{ find: 'alpha\n\nomega', replace: 'collapsed content' }]);

    expect(outcome.results[0]).toMatchObject({
      status: 'conflict',
      reason: 'structural-change',
    });
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(trackedIds(editor)).toEqual(beforeTracked);
  });

  it('does not broaden a single-newline find across a genuine empty paragraph', () => {
    const editor = makePipelineEditor('<p>alpha</p><p></p><p>omega</p>');
    const before = editor.state.doc;

    const outcome = applyEdits(editor, [{ find: 'alpha\nomega', format: { bold: true } }]);

    expect(outcome.results[0]).toMatchObject({
      status: 'not-found',
      reason: 'text-not-found',
    });
    expect(outcome.suggestionIds).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });
});
