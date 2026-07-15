import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SessionPicker from '../../components/SessionPicker';

// The picker fetches sessions on open; an empty list keeps the modal's fixed
// controls (Close / Start new / Cancel / Link) as the focus set.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'list_claude_sessions' ? [] : null)),
}));

function renderPicker(open = true) {
  const onClose = vi.fn();
  const props = {
    open,
    onClose,
    onPick: vi.fn(),
    newSessionCwd: '/tmp/project',
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
});
