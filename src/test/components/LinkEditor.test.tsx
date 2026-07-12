import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LinkEditor from '../../components/LinkEditor';
import type { LinkTarget } from '../../utils/linkEditing';

const existing: LinkTarget = {
  from: 4,
  to: 15,
  href: 'https://example.com/guide',
  text: 'style guide',
  existing: true,
};

const anchor = { top: 80, right: 220, bottom: 102, left: 120 };

function renderEditor(target: LinkTarget = existing) {
  const callbacks = {
    onApply: vi.fn(),
    onRemove: vi.fn(),
    onOpen: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(<LinkEditor target={target} anchor={anchor} {...callbacks} />);
  return callbacks;
}

describe('LinkEditor', () => {
  it('prefills both fields and applies edited text and URL together', async () => {
    const { onApply } = renderEditor();
    const text = screen.getByLabelText('Text');
    const url = screen.getByLabelText('URL');

    expect(text).toHaveValue('style guide');
    expect(url).toHaveValue('https://example.com/guide');
    await waitFor(() => expect(url).toHaveFocus());

    fireEvent.change(text, { target: { value: 'writing guide' } });
    fireEvent.change(url, { target: { value: 'docs.example.com/writing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onApply).toHaveBeenCalledWith('writing guide', 'docs.example.com/writing');
  });

  it('removes an existing link while keeping removal separate from Apply', () => {
    const { onRemove, onApply } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('opens absolute links and disables Open for relative or fragment targets', () => {
    const { onOpen } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Open/ }));
    expect(onOpen).toHaveBeenCalledWith('https://example.com/guide');

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: './sibling.md' } });
    const relativeOpen = screen.getByRole('button', { name: /Open/ });
    expect(relativeOpen).toBeDisabled();
    expect(relativeOpen).toHaveAttribute('title', expect.stringContaining('document navigation'));

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: '#notes' } });
    expect(screen.getByRole('button', { name: /Open/ })).toBeDisabled();
  });

  it('dismisses on Escape and outside pointer interaction', () => {
    const escape = renderEditor();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(escape.onDismiss).toHaveBeenCalledOnce();

    escape.onDismiss.mockClear();
    fireEvent.pointerDown(document.body);
    expect(escape.onDismiss).toHaveBeenCalledOnce();
  });

  it('uses the same URL-focused editor for a new selected-text link', async () => {
    const createTarget: LinkTarget = {
      from: 1,
      to: 6,
      href: '',
      text: 'Draft',
      existing: false,
    };
    renderEditor(createTarget);

    expect(screen.getByRole('dialog', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Text')).toHaveValue('Draft');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText('URL')).toHaveFocus());
  });
});
