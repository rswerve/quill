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

function renderHeader(mode: 'comments' | 'chat', aiSession: AISessionBinding | null = binding) {
  const props: React.ComponentProps<typeof PanelHeader> = {
    mode,
    commentCount: 4,
    showResolved: false,
    resolvedCount: 2,
    aiSession,
    onModeChange: vi.fn(),
    onToggleResolved: vi.fn(),
    onChangeSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onUnlinkSession: vi.fn(),
  };
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
    fireEvent.click(screen.getByRole('button', { name: 'Toggle resolved comments' }));
    expect(props.onToggleResolved).toHaveBeenCalledOnce();
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
