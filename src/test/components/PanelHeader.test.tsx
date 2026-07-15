import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PanelHeader from '../../components/PanelHeader';
import type { AISessionBinding } from '../../types';

const binding: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 'abcdef123456',
  cwd: '/docs',
  linkedAt: 'now',
};

function makeProps(
  mode: 'comments' | 'chat',
  aiSession: AISessionBinding | null = binding,
  showResolved = false,
): React.ComponentProps<typeof PanelHeader> {
  return {
    mode,
    commentCount: 4,
    showResolved,
    resolvedCount: 2,
    aiSession,
    onModeChange: vi.fn(),
    onToggleResolved: vi.fn(),
    onChangeSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onUnlinkSession: vi.fn(),
  };
}

function renderHeader(mode: 'comments' | 'chat', aiSession: AISessionBinding | null = binding) {
  const props = makeProps(mode, aiSession);
  render(<PanelHeader {...props} />);
  return props;
}

describe('PanelHeader', () => {
  it('switches between Comments and Chat while reporting the combined review count', () => {
    const props = renderHeader('comments');
    expect(screen.getByRole('tab', { name: 'Comments 4' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(props.onModeChange).toHaveBeenCalledWith('chat');
    fireEvent.click(screen.getByRole('button', { name: 'Show resolved comments' }));
    expect(props.onToggleResolved).toHaveBeenCalledOnce();
  });

  it('exposes the resolved-filter state to assistive tech via aria-pressed', () => {
    const { rerender } = render(<PanelHeader {...makeProps('comments', binding, false)} />);
    expect(screen.getByRole('button', { name: 'Show resolved comments' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    rerender(<PanelHeader {...makeProps('comments', binding, true)} />);
    expect(screen.getByRole('button', { name: 'Show resolved comments' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the linked session and routes every session-menu action', () => {
    const props = renderHeader('chat');
    expect(screen.getByText('✦ ABCDEF12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chat session menu' }));

    fireEvent.click(screen.getByRole('menuitem', { name: 'Change session' }));
    expect(props.onChangeSession).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Chat session menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start new session' }));
    expect(props.onStartNewSession).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Chat session menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unlink' }));
    expect(props.onUnlinkSession).toHaveBeenCalledOnce();
  });

  it('shows an inert no-session chip and disables unlinking', () => {
    renderHeader('chat', null);
    expect(screen.getByText('✦ NO SESSION')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chat session menu' }));
    expect(screen.getByRole('menuitem', { name: 'Unlink' })).toBeDisabled();
  });
});
