import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Rail from '../../components/Rail';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function renderRail(from: number, to: number) {
  editor = new Editor({
    extensions: [StarterKit],
    content: '<p><strong>bold</strong> plain</p>',
  });
  editor.commands.setTextSelection({ from, to });
  render(<Rail editor={editor} />);
  return screen.getByTitle('Bold (Cmd+B)');
}

// State is asserted through aria-pressed, the behavioral contract, rather than
// the now-hashed module state classes: mixed→"mixed", full→"true", none→"false".
describe('Rail inline-format state', () => {
  it('shows mixed, not active, when only part of the selection is bold', () => {
    const bold = renderRail(1, 11);
    expect(bold).toHaveAttribute('aria-pressed', 'mixed');
  });

  it('shows active, not mixed, when the full selection is bold', () => {
    const bold = renderRail(1, 5);
    expect(bold).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows neither state for a plain selection', () => {
    const bold = renderRail(6, 11);
    expect(bold).toHaveAttribute('aria-pressed', 'false');
  });
});
