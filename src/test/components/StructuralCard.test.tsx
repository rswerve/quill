import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import StructuralCard from '../../components/StructuralCard';
import type { StructuralChangeInfo } from '../../types';

afterEach(cleanup);

const change: StructuralChangeInfo = {
  kind: 'structural',
  changeId: 'c1',
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-07-18T00:00:00.000Z',
  from: 0,
  to: 14,
  source: { from: 0, to: 7 },
  proposed: { from: 7, to: 14 },
};

describe('StructuralCard', () => {
  it('shows the transformation label, resolves by change id, and carries the structural kind', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onClick = vi.fn();
    const { container, getByText } = render(
      <StructuralCard
        change={change}
        isActive={false}
        originComment={null}
        originActive={false}
        onAccept={onAccept}
        onReject={onReject}
        onClick={onClick}
        onActivateComment={vi.fn()}
      />,
    );
    expect(getByText('Heading 1 → Paragraph')).toBeTruthy();
    expect(container.querySelector('[data-suggestion-kind="structural"]')).toBeTruthy();
    expect(container.querySelector('[data-card-id="c1"]')).toBeTruthy();

    fireEvent.click(getByText('Accept'));
    expect(onAccept).toHaveBeenCalledWith('c1');
    fireEvent.click(getByText('Reject'));
    expect(onReject).toHaveBeenCalledWith('c1');
  });

  it('labels a paragraph→heading change with the target level', () => {
    const { getByText } = render(
      <StructuralCard
        change={{ ...change, op: { kind: 'paragraphToHeading', level: 2 } }}
        isActive={false}
        originComment={null}
        originActive={false}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClick={vi.fn()}
        onActivateComment={vi.fn()}
      />,
    );
    expect(getByText('Paragraph → Heading 2')).toBeTruthy();
  });
});
