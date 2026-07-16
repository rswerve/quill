import styles from './ConflictBanner.module.css';

interface ConflictBannerProps {
  /** Which on-disk file changed: the document or its comments sidecar. */
  which: 'doc' | 'sidecar';
  /**
   * Increments each time a conflicted Cmd+S is pressed. Used as the element `key` so
   * the banner remounts — replaying its attention animation and re-announcing to
   * assistive tech — without another write or modal.
   */
  flash: number;
  /** A resolution job is running; disable the actions to prevent double-submits. */
  busy: boolean;
  onOverwrite: () => void;
  onSaveCopy: () => void;
  onReload: () => void;
}

/**
 * Persistent, non-dismissible banner shown while a document has an unresolved
 * external conflict — the on-disk `.md` or `.comments.json` changed since it was
 * opened. Saving is paused; the user resolves by overwriting the on-disk change,
 * saving their version to a new file, or discarding their edits and reloading.
 */
export default function ConflictBanner({
  which,
  flash,
  busy,
  onOverwrite,
  onSaveCopy,
  onReload,
}: ConflictBannerProps) {
  const subject = which === 'sidecar' ? "This document's comments" : 'This document';
  return (
    <div key={flash} data-print-hidden className={styles.banner} role="alert" aria-live="assertive">
      <span className={styles.message}>
        <strong>{subject} changed on disk</strong> since you opened it. Saving is paused so neither
        your version nor the on-disk version is lost.
      </span>
      <span className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onOverwrite} disabled={busy}>
          Overwrite
        </button>
        <button type="button" className={styles.action} onClick={onSaveCopy} disabled={busy}>
          Save a Copy
        </button>
        <button type="button" className={styles.action} onClick={onReload} disabled={busy}>
          Reload
        </button>
      </span>
    </div>
  );
}
