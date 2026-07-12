import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkButton } from '../../components/Toolbar';

let editor: Editor | null = null;
let editorElement: HTMLDivElement | null = null;

function makeEditor(content: string) {
  const element = document.createElement('div');
  editorElement = element;
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content,
  });
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    top: 80,
    right: 200,
    bottom: 102,
    left: 120,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  editorElement?.remove();
  editorElement = null;
});

describe('LinkButton consolidated editor', () => {
  it('opens from a click inside an existing link and edits both values', () => {
    const ed = makeEditor('<p>Read <a href="https://old.example.com">the guide</a>.</p>');
    render(<LinkButton editor={ed} baseClassName="rail-btn" />);

    fireEvent.click(ed.view.dom.querySelector('a')!);
    expect(screen.getByRole('dialog', { name: 'Edit link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Text')).toHaveValue('the guide');
    expect(screen.getByLabelText('URL')).toHaveValue('https://old.example.com');

    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'our handbook' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://new.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(ed.getHTML()).toContain('href="https://new.example.com">our handbook</a>');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('removes a clicked link without removing its display text', () => {
    const ed = makeEditor('<p><a href="https://example.com">keep me</a></p>');
    render(<LinkButton editor={ed} />);

    fireEvent.click(ed.view.dom.querySelector('a')!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(ed.getHTML()).toBe('<p>keep me</p>');
  });

  it('opens the same editor from Cmd+K for selected text with URL focused', async () => {
    const ed = makeEditor('<p>Draft quickly</p>');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    const { container } = render(<LinkButton editor={ed} />);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    expect(screen.getByRole('dialog', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Text')).toHaveValue('Draft');
    await waitFor(() => expect(screen.getByLabelText('URL')).toHaveFocus());
    expect(container.querySelector('.link-popover')).toBeNull();
  });
});
