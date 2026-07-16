import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { basename, dirname } from '../utils/path';
import { RedoIcon, ToolbarButton, UndoIcon } from './Toolbar';
import { cx } from '../utils/cx';
import styles from './Topbar.module.css';

interface TopbarProps {
  editor: Editor | null;
  filePath: string | null;
  isDirty: boolean;
  lastSavedAt: number | null;
  isSuggesting: boolean;
  onToggleSuggesting: () => void;
  pendingSuggestionCount: number;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

function editedLabel(savedAt: number | null): string {
  if (savedAt === null) return 'Edited just now';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - savedAt) / 60_000));
  if (elapsedMinutes < 1) return 'Edited just now';
  if (elapsedMinutes < 60) return `Edited ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Edited ${elapsedHours}h ago`;
  return `Edited ${Math.floor(elapsedHours / 24)}d ago`;
}

export default function Topbar({
  editor,
  filePath,
  isDirty,
  lastSavedAt,
  isSuggesting,
  onToggleSuggesting,
  pendingSuggestionCount,
  onAcceptAll,
  onRejectAll,
}: TopbarProps) {
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const fileName = filePath ? basename(filePath) : 'Untitled';
  const parentPath = filePath ? dirname(filePath) : null;
  const parentName = parentPath ? basename(parentPath) : null;

  return (
    <header
      className={styles.topbar}
      role="toolbar"
      aria-label="Document actions"
      data-print-hidden
    >
      <div className={styles.crumbs} aria-label="Document location">
        {parentName && (
          <>
            <span className={styles.parent}>{parentName}</span>
            <span className={styles.sep}>/</span>
          </>
        )}
        <span className={styles.cur}>{fileName}</span>
        {isDirty && <span className={styles.dirtyDot} aria-label="Unsaved" />}
      </div>
      {filePath && (
        <span className={cx(styles.saved, isDirty && styles.dirty)}>
          {isDirty ? 'Unsaved changes' : editedLabel(lastSavedAt)}
        </span>
      )}

      <span className="grow" />

      <ToolbarButton
        baseClassName={styles.iconBtn}
        onClick={() => editor?.chain().focus().undo().run()}
        disabled={!editor?.can().undo()}
        title="Undo (Cmd+Z)"
      >
        <UndoIcon />
      </ToolbarButton>
      <ToolbarButton
        baseClassName={styles.iconBtn}
        onClick={() => editor?.chain().focus().redo().run()}
        disabled={!editor?.can().redo()}
        title="Redo (Cmd+Shift+Z)"
      >
        <RedoIcon />
      </ToolbarButton>

      {pendingSuggestionCount > 0 && (
        <>
          <button
            className={cx(styles.reviewBtn, styles.acceptAll)}
            onClick={onAcceptAll}
            title="Accept all suggestions"
          >
            <span aria-hidden>✓</span>
            <span>Accept all</span>
            <span className={styles.reviewCount}>{pendingSuggestionCount}</span>
          </button>
          <button
            className={cx(styles.reviewBtn, styles.rejectAll)}
            onClick={onRejectAll}
            title="Reject all suggestions"
          >
            <span aria-hidden>×</span>
            <span>Reject all</span>
            <span className={styles.reviewCount}>{pendingSuggestionCount}</span>
          </button>
          <span className={cx(styles.vsep, styles.reviewVsep)} />
        </>
      )}

      <div className={styles.modeSwitch} role="group" aria-label="Editing mode">
        <button
          className={cx(styles.seg, !isSuggesting && styles.on)}
          aria-pressed={!isSuggesting}
          onClick={() => {
            if (isSuggesting) onToggleSuggesting();
          }}
        >
          Editing
        </button>
        <button
          className={cx(styles.seg, isSuggesting && styles.on)}
          aria-pressed={isSuggesting}
          onClick={() => {
            if (!isSuggesting) onToggleSuggesting();
          }}
        >
          Suggesting
        </button>
      </div>
    </header>
  );
}
