import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SuggestionCardShell, { type SuggestionCardKind } from '../../components/SuggestionCardShell';
import type { Comment } from '../../types';

const originComment: Comment = {
  id: 'comment-1',
  kind: 'claude',
  anchorText: 'A linked comment',
  from: 1,
  to: 4,
  author: 'Maz',
  createdAt: '2026-07-11T12:00:00Z',
  resolved: false,
  replies: [],
};

const labels: Record<SuggestionCardKind, string> = {
  insert: 'Insertion',
  delete: 'Deletion',
  replace: 'Replacement',
  format: 'Formatting',
};

describe('SuggestionCardShell', () => {
  it.each(Object.entries(labels) as [SuggestionCardKind, string][])(
    'renders the shared %s card anatomy',
    (kind, label) => {
      const { container } = render(
        <SuggestionCardShell
          cardId={`${kind}-1`}
          kind={kind}
          label={label}
          authorID="Anonymous"
          createdAt={Date.now()}
          isActive={false}
          originComment={null}
          originActive={false}
          acceptTitle="Accept test"
          rejectTitle="Reject test"
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onClick={vi.fn()}
          onActivateComment={vi.fn()}
        >
          <div>Preview</div>
        </SuggestionCardShell>,
      );

      expect(container.querySelector(`[data-card-id="${kind}-1"]`)).toHaveAttribute(
        'data-suggestion-kind',
        kind,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText('Preview')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    },
  );

  it('renders Claude identity and provenance while isolating action clicks', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onClick = vi.fn();
    const onActivateComment = vi.fn();
    const { container } = render(
      <SuggestionCardShell
        cardId="claude-edit"
        kind="replace"
        label="Replacement"
        authorID="claude"
        createdAt={Date.now()}
        isActive
        originComment={originComment}
        originActive
        acceptTitle="Accept replacement"
        rejectTitle="Reject replacement"
        onAccept={onAccept}
        onReject={onReject}
        onClick={onClick}
        onActivateComment={onActivateComment}
      >
        <div>Preview</div>
      </SuggestionCardShell>,
    );

    const card = container.querySelector('[data-card-id="claude-edit"]')!;
    expect(card).toHaveAttribute('data-active');
    expect(card).toHaveAttribute('data-origin-active');
    expect(screen.getByText('Claude')).toBeInTheDocument();
    // The AI badge keeps the shared global class; its suggestion-specific 20px
    // box is styled via `.head :global(.ai-badge)` in the module.
    expect(screen.getByText('AI')).toHaveClass('ai-badge');

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: '↳ from comment' }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
    expect(onActivateComment).toHaveBeenCalledWith(originComment.id);
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('[data-card-id="claude-edit"]')!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('links a chat-authored suggestion back to its assistant turn', () => {
    const onActivateChatMessage = vi.fn();
    const onClick = vi.fn();
    render(
      <SuggestionCardShell
        cardId="chat-edit"
        kind="insert"
        label="Insertion"
        authorID="claude"
        createdAt={Date.now()}
        isActive={false}
        originComment={null}
        originChatMessageId="chat-message-1"
        originActive={false}
        acceptTitle="Accept insertion"
        rejectTitle="Reject insertion"
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClick={onClick}
        onActivateComment={vi.fn()}
        onActivateChatMessage={onActivateChatMessage}
      >
        <div>Preview</div>
      </SuggestionCardShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: '↳ from chat' }));
    expect(onActivateChatMessage).toHaveBeenCalledWith('chat-message-1');
    expect(onClick).not.toHaveBeenCalled();
  });
});
