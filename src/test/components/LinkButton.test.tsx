import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkButton } from '../../components/Toolbar';
import { LINK_OPTIONS } from '../../utils/linkEditing';

let editor: Editor | null = null;
let editorElement: HTMLDivElement | null = null;

function makeEditor(content: string) {
  const element = document.createElement('div');
  editorElement = element;
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ link: LINK_OPTIONS })],
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
    render(<LinkButton editor={ed} baseClassName="test-toolbar-button" />);

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
    render(<LinkButton editor={ed} baseClassName="test-toolbar-button" />);

    fireEvent.click(ed.view.dom.querySelector('a')!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(ed.getHTML()).toBe('<p>keep me</p>');
  });

  it('opens the same editor from Cmd+K for selected text with URL focused', async () => {
    const ed = makeEditor('<p>Draft quickly</p>');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    const { container } = render(<LinkButton editor={ed} baseClassName="test-toolbar-button" />);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    expect(screen.getByRole('dialog', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Text')).toHaveValue('Draft');
    await waitFor(() => expect(screen.getByLabelText('URL')).toHaveFocus());
    expect(container.querySelector('.link-popover')).toBeNull();
  });

  it('forwards the disabled state map and wrapper class (Rail module seam)', () => {
    // Collapsed cursor in plain text → not linkable → the button is disabled, so
    // its state class must come from the supplied map, not the literal fallback.
    const ed = makeEditor('<p>plain</p>');
    ed.commands.setTextSelection({ from: 3, to: 3 });
    render(
      <LinkButton
        editor={ed}
        baseClassName="rail_btn"
        stateClasses={{ active: 'a_hash', mixed: 'm_hash', disabled: 'd_hash' }}
        wrapperClassName="wrap_hash"
      />,
    );
    const button = screen.getByTitle('Link (Cmd+K)');
    expect(button).toHaveClass('rail_btn', 'd_hash');
    expect(button).not.toHaveClass('disabled');
    expect(button.closest('.link-button-wrap')).toHaveClass('wrap_hash');
  });

  it('forwards the active state class when a link is active', () => {
    const ed = makeEditor('<p><a href="https://example.com">linked</a></p>');
    ed.commands.setTextSelection({ from: 2, to: 5 });
    render(
      <LinkButton
        editor={ed}
        baseClassName="rail_btn"
        stateClasses={{ active: 'a_hash', mixed: 'm_hash', disabled: 'd_hash' }}
      />,
    );
    const button = screen.getByTitle('Link (Cmd+K)');
    expect(button).toHaveClass('a_hash');
    expect(button).not.toHaveClass('active');
  });
});
