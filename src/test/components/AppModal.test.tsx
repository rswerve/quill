import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppModal, { type AppModalButton } from '../../components/AppModal';

afterEach(() => {
  document.body.innerHTML = '';
});

const btn = (over: Partial<AppModalButton> & Pick<AppModalButton, 'label'>): AppModalButton => ({
  onClick: vi.fn(),
  ...over,
});

describe('AppModal — dialog safety contract', () => {
  it('renders an accessible modal dialog with title and message', () => {
    render(
      <AppModal
        title="Unsaved changes"
        message="Save before closing?"
        buttons={[btn({ label: 'OK' })]}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Unsaved changes');
    // getByText throws if absent, so this is the assertion:
    screen.getByText('Save before closing?');
  });

  it('maps button kind to its class and defaults to ghost, and fires onClick', () => {
    const onSave = vi.fn();
    render(
      <AppModal
        title="t"
        message="m"
        buttons={[
          btn({ label: 'Save', kind: 'primary', onClick: onSave }),
          btn({ label: 'Discard', kind: 'danger' }),
          btn({ label: 'Cancel' }),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' }).className).toBe('btn-primary');
    expect(screen.getByRole('button', { name: 'Discard' }).className).toBe('btn-danger');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toBe('btn-ghost');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('focuses the primary action on open so Enter confirms the safe default', () => {
    render(
      <AppModal
        title="t"
        message="m"
        buttons={[
          btn({ label: 'Save', kind: 'primary' }),
          btn({ label: 'Cancel', isCancel: true }),
        ]}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('focuses the first button when no primary is present', () => {
    render(
      <AppModal
        title="t"
        message="m"
        buttons={[btn({ label: 'First' }), btn({ label: 'Second' })]}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('Escape triggers ONLY the reversible cancel action — never a destructive one', () => {
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(
      <AppModal
        title="t"
        message="m"
        buttons={[
          btn({ label: 'Save', kind: 'primary' }),
          btn({ label: 'Discard', kind: 'danger', onClick: onDiscard }),
          btn({ label: 'Cancel', isCancel: true, onClick: onCancel }),
        ]}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('Escape does nothing when there is no cancel action (never a destructive default)', () => {
    const onDelete = vi.fn();
    render(
      <AppModal
        title="t"
        message="m"
        buttons={[btn({ label: 'Delete', kind: 'danger', onClick: onDelete })]}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('traps Tab focus within the dialog (wraps first↔last both directions)', () => {
    render(
      <AppModal
        title="t"
        message="m"
        buttons={[btn({ label: 'A', kind: 'primary' }), btn({ label: 'B' })]}
      />,
    );
    const a = screen.getByRole('button', { name: 'A' });
    const b = screen.getByRole('button', { name: 'B' });
    const dialog = screen.getByRole('dialog');

    a.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(b); // Shift+Tab from first wraps to last

    b.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(a); // Tab from last wraps to first
  });

  it('restores focus to the previously-focused element on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(
      <AppModal title="t" message="m" buttons={[btn({ label: 'OK', kind: 'primary' })]} />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));

    unmount();
    expect(document.activeElement).toBe(opener);
  });
});
