import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { StrikeWithoutSaveShortcut } from '../../extensions/StrikeWithoutSaveShortcut';

let editor: Editor | null = null;

function makeEditor(content = '<p></p>'): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ strike: false }), StrikeWithoutSaveShortcut, Markdown],
    content,
  });
  return editor;
}

function pressSaveAs(editor: Editor): KeyboardEvent {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
  const event = new KeyboardEvent('keydown', {
    key: 's',
    code: 'KeyS',
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    metaKey: mac,
    ctrlKey: !mac,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function typeText(editor: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (handler) =>
      handler(editor.view, from, to, character, () =>
        editor.state.tr.insertText(character, from, to),
      ),
    );
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}

function getMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

describe('StrikeWithoutSaveShortcut', () => {
  it('leaves no stored strike mark when Save As is pressed at the cursor', () => {
    const editor = makeEditor();
    let bubbled = 0;
    const onKeyDown = () => bubbled++;
    window.addEventListener('keydown', onKeyDown);

    const event = pressSaveAs(editor);
    window.removeEventListener('keydown', onKeyDown);

    expect(bubbled).toBe(1);
    expect(event.defaultPrevented).toBe(false);
    expect(editor.state.storedMarks ?? []).not.toContainEqual(
      expect.objectContaining({ type: expect.objectContaining({ name: 'strike' }) }),
    );

    editor.commands.insertContent('edited during save');
    expect(editor.getHTML()).toBe('<p>edited during save</p>');
  });

  it('does not strike an active selection when Save As is pressed', () => {
    const editor = makeEditor('<p>plain text</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });

    const event = pressSaveAs(editor);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.getHTML()).toBe('<p>plain text</p>');
    expect(editor.isActive('strike')).toBe(false);
  });

  it('retains the Strike command and Markdown serialization', () => {
    const editor = makeEditor('<p>plain text</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(editor.commands.toggleStrike()).toBe(true);

    expect(editor.getHTML()).toBe('<p><s>plain</s> text</p>');
    expect(getMarkdown(editor)).toBe('~~plain~~ text');
  });

  it('retains the typed Markdown Strike input rule', () => {
    const editor = makeEditor();

    typeText(editor, '~~typed~~');

    expect(editor.getHTML()).toBe('<p><s>typed</s></p>');
    expect(getMarkdown(editor)).toBe('~~typed~~');
  });
});
