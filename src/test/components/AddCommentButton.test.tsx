import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AddCommentButton from '../../components/AddCommentButton';

describe('AddCommentButton', () => {
  it('renders the floating affordance and opens the composer on click', () => {
    const onOpen = vi.fn();
    render(<AddCommentButton top={120} left={40} visible onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: 'Add comment to selection' });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('opts out of print via the data-print-hidden policy attribute', () => {
    // The button is module-scoped chrome; it must rely on the print-policy
    // attribute rather than a preserved global class in the @media print block.
    render(<AddCommentButton top={0} visible onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add comment to selection' })).toHaveAttribute(
      'data-print-hidden',
    );
  });

  it('renders nothing when not visible', () => {
    render(<AddCommentButton top={0} visible={false} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add comment to selection' })).toBeNull();
  });
});
