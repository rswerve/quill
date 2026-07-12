import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { getFormattingContext } from '../../utils/formattingContext';

let editor: Editor | null = null;

function makeEditor(content: string) {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table,
      TableRow,
      TableCell,
      TableHeader,
    ],
    content,
  });
  return editor;
}

function context() {
  return getFormattingContext(editor!.state);
}

function placeCursorIn(text: string) {
  let target: number | null = null;
  editor!.state.doc.descendants((node, pos) => {
    if (target === null && node.isText && node.text?.includes(text)) target = pos + 1;
  });
  if (target === null) throw new Error(`Text not found: ${text}`);
  editor!.commands.setTextSelection(target);
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('formatting context', () => {
  it('reads active marks at a collapsed cursor', () => {
    const ed = makeEditor('<p><strong><em>marked</em></strong> plain</p>');
    ed.commands.setTextSelection(3);

    expect(context().marks).toMatchObject({ bold: 'on', italic: 'on', strike: 'off' });
    expect(context().primary).toEqual({ kind: 'paragraph', label: 'Paragraph', state: 'on' });
  });

  it('distinguishes mixed marks from on and off across a selection', () => {
    const ed = makeEditor('<p><strong>bold</strong> plain <em>italic</em></p>');
    ed.commands.setTextSelection({ from: 1, to: 18 });

    expect(context().marks).toMatchObject({
      bold: 'mixed',
      italic: 'mixed',
      underline: 'off',
      link: 'off',
    });
  });

  it('returns an honest H4 primary label', () => {
    const ed = makeEditor('<h4>Legacy heading</h4>');
    ed.commands.setTextSelection(4);

    expect(context().primary).toEqual({ kind: 'heading-4', label: 'H4', state: 'on' });
  });

  it('returns the primary block plus nested wrappers', () => {
    makeEditor(
      '<blockquote><ul><li><p>List lead</p><h2>Nested heading</h2></li></ul></blockquote>',
    );
    placeCursorIn('Nested heading');

    expect(context().primary.label).toBe('H2');
    expect(context().wrappers).toEqual([
      { kind: 'blockquote', label: 'Blockquote', state: 'on' },
      { kind: 'bulletList', label: 'Bullet list', state: 'on' },
    ]);
  });

  it('marks primary blocks and wrappers mixed across block boundaries', () => {
    const ed = makeEditor('<blockquote><p>quoted</p></blockquote><p>plain</p>');
    ed.commands.setTextSelection({ from: 2, to: 16 });

    expect(context().primary).toEqual({ kind: 'paragraph', label: 'Paragraph', state: 'on' });
    expect(context().wrappers).toContainEqual({
      kind: 'blockquote',
      label: 'Blockquote',
      state: 'mixed',
    });
  });

  it('reports mixed blocks when a selection crosses unlike textblocks', () => {
    const ed = makeEditor('<h2>Heading</h2><p>paragraph</p>');
    ed.commands.setTextSelection({ from: 1, to: 18 });

    expect(context().primary).toEqual({ kind: 'mixed', label: 'Mixed blocks', state: 'mixed' });
  });

  it('reports a uniform link only when the entire selection has one href', () => {
    const ed = makeEditor('<p><a href="https://one.example">one link</a></p>');
    ed.commands.setTextSelection({ from: 1, to: 9 });

    expect(context().marks.link).toBe('on');
    expect(context().link).toEqual({ kind: 'single', href: 'https://one.example' });
  });

  it('distinguishes partial and multiple link selections', () => {
    const ed = makeEditor(
      '<p><a href="https://one.example">one</a> plain <a href="https://two.example">two</a></p>',
    );

    ed.commands.setTextSelection({ from: 1, to: 7 });
    expect(context().marks.link).toBe('mixed');
    expect(context().link).toEqual({ kind: 'partial' });

    ed.commands.setTextSelection({ from: 1, to: 14 });
    expect(context().link).toEqual({ kind: 'multiple' });
  });

  it('labels supported task-list and table wrappers', () => {
    const task = makeEditor(
      '<ul data-type="taskList"><li data-type="taskItem"><p>todo</p></li></ul>',
    );
    task.commands.setTextSelection(3);
    expect(context().wrappers).toContainEqual({
      kind: 'taskList',
      label: 'Task list',
      state: 'on',
    });
    task.destroy();

    editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableCell, TableHeader],
      content: '<table><tbody><tr><td><p>cell</p></td></tr></tbody></table>',
    });
    editor.commands.setTextSelection(3);
    expect(context().wrappers).toContainEqual({
      kind: 'tableCell',
      label: 'Table cell',
      state: 'on',
    });
  });
});
