import { useEffect, useId, useRef } from 'react';
import styles from './AppModal.module.css';

export interface AppModalButton {
  label: string;
  kind?: 'primary' | 'danger' | 'ghost';
  /** Safe, reversible action invoked by Escape. */
  isCancel?: boolean;
  onClick: () => void | Promise<void>;
}

interface AppModalProps {
  title: string;
  message: string;
  buttons: AppModalButton[];
}

const BUTTON_CLASS: Record<NonNullable<AppModalButton['kind']>, string> = {
  primary: 'btn-primary',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
};

/**
 * In-app modal for confirmations and notices. Used instead of
 * window.alert/confirm, which are not reliably implemented in Tauri's
 * webviews.
 */
export default function AppModal({ title, message, buttons }: AppModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initialFocus =
      dialog?.querySelector<HTMLElement>('.btn-primary:not(:disabled)') ??
      dialog?.querySelector<HTMLElement>('button:not(:disabled)') ??
      dialog;
    initialFocus?.focus();

    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const cancelButton = buttons.find((button) => button.isCancel);
      if (!cancelButton) return;
      void cancelButton.onClick();
      return;
    }

    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input, select, textarea',
      ),
    ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('hidden'));
    const first = focusable[0] ?? dialog;
    const last = focusable.at(-1) ?? dialog;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      data-print-hidden
      className={styles.overlay}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {/* role="dialog" is on the card, not the backdrop overlay: the card IS
          the dialog. The overlay carries data-print-hidden + the focus/keydown
          container. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className={styles.modal}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={messageId} className={styles.message}>
          {message}
        </p>
        <div className={styles.actions}>
          {buttons.map((b) => (
            <button
              key={b.label}
              className={BUTTON_CLASS[b.kind ?? 'ghost']}
              onClick={() => void b.onClick()}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
