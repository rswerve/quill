import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import SessionPicker from '../../components/SessionPicker';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

// The picker fetches sessions on open. Most cases want an empty list, which
// keeps the modal's fixed controls (Close / Start new / Cancel / Link) as the
// focus set; the trap-recompute case overrides this with a real session.
const emptyList = async (cmd: string) => (cmd === 'list_claude_sessions' ? [] : null);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyList);
});

function renderPicker(open = true) {
  const onClose = vi.fn();
  const props = {
    open,
    onClose,
    onPick: vi.fn(),
    newSessionCwd: '/Users/test/project',
    getSessionOwner: () => null,
  };
  const view = render(<SessionPicker {...props} />);
  const rerender = (nextOpen: boolean) =>
    view.rerender(<SessionPicker {...props} open={nextOpen} />);
  return { onClose, rerender };
}

describe('SessionPicker — modal a11y', () => {
  it('is a modal dialog with an accessible name and a print-hidden overlay', async () => {
    renderPicker();
    const dialog = await screen.findByRole('dialog', { name: 'Link Claude Code session' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.closest('[data-print-hidden]')).not.toBeNull();
  });

  it('focuses the Close control on open and restores prior focus on close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = renderPicker(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());

    rerender(false);
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it('Escape closes the dialog', async () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stops Escape from reaching the window keydown listener behind the modal', async () => {
    const windowEscape = vi.fn();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') windowEscape();
    };
    window.addEventListener('keydown', listener);
    try {
      const { onClose } = renderPicker();
      fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
      // The window shortcut handler (which clears the active annotation behind
      // the modal — useGlobalShortcuts) must not also fire. stopPropagation is
      // the only thing standing between one Escape and a wiped annotation.
      expect(windowEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('traps Tab focus within the dialog (wraps first↔last both directions)', async () => {
    renderPicker();
    const dialog = await screen.findByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    // Link is disabled without a selection, so Cancel is the last focusable.
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    await waitFor(() => expect(close).toHaveFocus());

    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it('recomputes the trap after a selection enables Link (wraps Link↔Close)', async () => {
    // A loaded session + preview makes "Link this session" the last focusable —
    // unlike the empty-list cases where Cancel is last. This pins that the trap
    // reads the live focusable set on each keydown rather than a stale snapshot
    // captured before the async row/preview arrived.
    const session = {
      sessionId: 'sess-1',
      jsonlPath: '/proj/sess-1.jsonl',
      cwd: '/proj',
      title: 'Design session',
      documentName: null,
      lastUsed: Math.floor(Date.now() / 1000),
    };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_claude_sessions') return [session];
      if (cmd === 'read_claude_session_preview')
        return { sessionId: 'sess-1', cwd: '/proj', recentAssistantMessages: ['hi'] };
      return null;
    });

    renderPicker();
    const dialog = await screen.findByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });

    fireEvent.click(await screen.findByRole('button', { name: /Design session/ }));
    const link = await screen.findByRole('button', { name: 'Link this session' });
    await waitFor(() => expect(link).toBeEnabled());

    link.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    await waitFor(() => expect(close).toHaveFocus());
  });
});
