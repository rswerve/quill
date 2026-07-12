import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FormattingCard, { describeFormatSegments } from '../../components/FormattingCard';
import type { Comment, TrackedFormatChange } from '../../types';

const change: TrackedFormatChange = {
  id: 'fmt1',
  operation: 'format',
  authorID: 'claude',
  status: 'pending',
  createdAt: Date.parse('2026-07-11T12:00:00Z'),
  originCommentId: 'c1',
  segments: [
    { from: 1, to: 4, text: 'one', adds: ['bold'], removes: [] },
    { from: 9, to: 12, text: 'two', adds: ['italic'], removes: ['strike'] },
  ],
};

const originComment: Comment = {
  id: 'c1',
  anchorText: 'Please fix this formatting',
  from: 1,
  to: 4,
  author: 'Maz',
  createdAt: '2026-07-11T12:00:00Z',
  resolved: false,
  replies: [],
};

describe('describeFormatSegments', () => {
  it('summarizes unique operations in deterministic order', () => {
    expect(describeFormatSegments(change.segments)).toBe(
      'bold added · italic added · strikethrough removed',
    );
  });
});

describe('FormattingCard', () => {
  it('shows the format delta, disjoint text preview, author, and provenance chip', () => {
    render(
      <FormattingCard
        change={change}
        isActive={false}
        originComment={originComment}
        originActive={false}
        top={20}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClick={vi.fn()}
        onActivateComment={vi.fn()}
      />,
    );

    expect(screen.getByText('Formatting')).toBeInTheDocument();
    expect(screen.getByText('Claude (AI)')).toBeInTheDocument();
    expect(
      screen.getByText('bold added · italic added · strikethrough removed'),
    ).toBeInTheDocument();
    expect(screen.getByText(/one … two/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '↳ comment' })).toHaveAttribute(
      'title',
      originComment.anchorText,
    );
  });

  it('resolves and activates by logical change id and links to the origin comment', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onClick = vi.fn();
    const onActivateComment = vi.fn();
    const { container } = render(
      <FormattingCard
        change={change}
        isActive
        originComment={originComment}
        originActive
        top={20}
        onAccept={onAccept}
        onReject={onReject}
        onClick={onClick}
        onActivateComment={onActivateComment}
      />,
    );

    const card = container.querySelector('[data-card-id="fmt1"]');
    expect(card).toHaveClass('suggestion-card-format', 'suggestion-card-active');
    fireEvent.click(card!);
    fireEvent.click(screen.getByTitle('Accept formatting'));
    fireEvent.click(screen.getByTitle('Reject formatting'));
    fireEvent.click(screen.getByRole('button', { name: '↳ comment' }));

    expect(onClick).toHaveBeenCalledWith('fmt1');
    expect(onAccept).toHaveBeenCalledWith('fmt1');
    expect(onReject).toHaveBeenCalledWith('fmt1');
    expect(onActivateComment).toHaveBeenCalledWith('c1');
  });
});
