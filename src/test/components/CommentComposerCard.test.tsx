import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommentComposerCard from '../../components/CommentComposerCard';

function renderComposer(hasSession: boolean) {
  const onSubmit = vi.fn();
  const result = render(
    <CommentComposerCard
      quote="Selected prose"
      top={24}
      hasSession={hasSession}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  return { ...result, onSubmit };
}

describe('CommentComposerCard', () => {
  it('renders the explicit Ask-Claude and Add-note actions', () => {
    renderComposer(true);

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Ask Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Ask Claude to change this, or jot a private note…'),
    ).toBeInTheDocument();
  });

  it('keeps notes available while directing an ask through session linking', () => {
    const { container } = renderComposer(false);

    expect(screen.getByRole('button', { name: 'Link a session to ask' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
    expect(container.querySelector('.composer-no-session')).toHaveTextContent(
      'No Claude session linked yet — note works offline.',
    );
  });

  it('submits the intent selected by each action', () => {
    const { onSubmit } = renderComposer(true);
    fireEvent.change(
      screen.getByPlaceholderText('Ask Claude to change this, or jot a private note…'),
      { target: { value: 'Tighten this sentence' } },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Claude' }));

    expect(onSubmit).toHaveBeenNthCalledWith(1, 'Tighten this sentence', 'note');
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'Tighten this sentence', 'claude');
  });
});
