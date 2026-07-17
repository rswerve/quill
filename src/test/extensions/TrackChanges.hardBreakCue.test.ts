import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnotationFocus, findAnnotationRange } from '../../extensions/AnnotationFocus';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';

const mounted: Editor[] = [];

function makeEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      AnnotationFocus,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('alice');
  mounted.push(editor);
  return editor;
}

function realBreakCount(editor: Editor): number {
  return editor.view.dom.querySelectorAll('br:not(.ProseMirror-trailingBreak)').length;
}

function insertBreak(editor: Editor): void {
  editor.chain().setTextSelection(4).insertContent({ type: 'hardBreak' }).run();
}

function deleteBreak(editor: Editor): void {
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (position < 0 && node.type.name === 'hardBreak') position = pos;
  });
  if (position < 0) throw new Error('hard break missing');
  editor
    .chain()
    .setTextSelection({ from: position, to: position + 1 })
    .deleteSelection()
    .run();
}

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

describe('tracked hard-break document cues', () => {
  it('renders an inserted-break cue outside review marks without changing document text', () => {
    const editor = makeEditor('<p>onetwo</p>');
    insertBreak(editor);

    const cue = editor.view.dom.querySelector<HTMLElement>('[data-hard-break-cue="insert"]');
    expect(cue).not.toBeNull();
    expect(cue?.textContent).toBe('');
    expect(cue?.closest('ins, del')).toBeNull();
    expect(editor.view.dom.textContent).toBe('onetwo');
    expect(editor.getHTML()).not.toContain('track-hard-break-cue');
    expect(realBreakCount(editor)).toBe(1);

    editor.commands.acceptAllChanges();
    expect(editor.view.dom.querySelector('[data-hard-break-cue]')).toBeNull();
    expect(realBreakCount(editor)).toBe(1);
    expect(editor.view.dom.textContent).toBe('onetwo');
  });

  it('removes the cue and the real break when an insertion is rejected', () => {
    const editor = makeEditor('<p>onetwo</p>');
    insertBreak(editor);

    editor.commands.rejectAllChanges();
    expect(editor.view.dom.querySelector('[data-hard-break-cue]')).toBeNull();
    expect(realBreakCount(editor)).toBe(0);
    expect(editor.getHTML()).toBe('<p>onetwo</p>');
  });

  it('renders and focuses a deletion cue while preserving the original break', () => {
    const editor = makeEditor('<p>one<br>two</p>');
    deleteBreak(editor);
    const change = getTrackedChanges(editor)[0];
    expect(change).toBeDefined();

    const cue = editor.view.dom.querySelector<HTMLElement>('[data-hard-break-cue="delete"]');
    expect(cue).not.toBeNull();
    expect(cue?.textContent).toBe('');
    expect(cue?.closest('ins, del')).toBeNull();
    expect(findAnnotationRange(editor.state.doc, 'suggestion', change.id)).not.toBeNull();

    editor.commands.setAnnotationFocus('suggestion', change.id);
    expect(cue?.classList.contains('annotation-focus')).toBe(false);
    expect(
      editor.view.dom
        .querySelector('[data-hard-break-cue="delete"]')
        ?.classList.contains('annotation-focus'),
    ).toBe(true);

    editor.commands.rejectAllChanges();
    expect(editor.view.dom.querySelector('[data-hard-break-cue]')).toBeNull();
    expect(editor.getHTML()).toBe('<p>one<br>two</p>');
  });
});
