import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReplacementCard from '../../components/ReplacementCard';
import SuggestionCard from '../../components/SuggestionCard';
import type { TrackedChangeInfo, TrackedTextSegment } from '../../types';

const noop = {
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onClick: vi.fn(),
  onActivateComment: vi.fn(),
};

const change: TrackedChangeInfo = {
  id: 'hb1',
  authorID: 'claude',
  status: 'pending',
  createdAt: Date.parse('2026-07-17T12:00:00Z'),
  segments: [],
};

describe('hard-break review-card preview', () => {
  it('renders a break-only insertion as the ↵ glyph, never a blank quote', () => {
    const segments: TrackedTextSegment[] = [
      { kind: 'insert', from: 4, to: 5, text: '\n', nodeType: 'hardBreak' },
    ];
    render(
      <SuggestionCard
        change={change}
        operation="insert"
        segments={segments}
        isActive={false}
        originComment={null}
        originActive={false}
        {...noop}
      />,
    );
    expect(screen.getByText('“↵ line break”')).toBeInTheDocument();
  });

  it('renders a text–break–text replacement as one↵two → oneXtwo', () => {
    const deletions: TrackedTextSegment[] = [
      { kind: 'delete', from: 1, to: 4, text: 'one' },
      { kind: 'delete', from: 4, to: 5, text: '\n', nodeType: 'hardBreak' },
      { kind: 'delete', from: 5, to: 8, text: 'two' },
    ];
    const insertions: TrackedTextSegment[] = [{ kind: 'insert', from: 8, to: 15, text: 'oneXtwo' }];
    render(
      <ReplacementCard
        change={change}
        deletions={deletions}
        insertions={insertions}
        isActive={false}
        originComment={null}
        originActive={false}
        {...noop}
      />,
    );
    expect(screen.getByText('“one↵two”')).toBeInTheDocument();
    expect(screen.getByText('“oneXtwo”')).toBeInTheDocument();
  });
});
