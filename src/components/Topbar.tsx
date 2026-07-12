import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { basename, dirname } from '../utils/path';
import { RedoIcon, ToolbarButton, UndoIcon } from './Toolbar';

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
  onReviewDocument: () => void;
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
  onReviewDocument,
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
    <header className="topbar">
      <div className="crumbs" aria-label="Document location">
        {parentName && (
          <>
            <span className="crumb-parent">{parentName}</span>
            <span className="sep">/</span>
          </>
        )}
        <span className="cur">{fileName}</span>
        {isDirty && <span className="dirty-dot footer-dirty" aria-label="Unsaved" />}
      </div>
      {filePath && (
        <span className={`saved${isDirty ? ' dirty' : ''}`}>
          {isDirty ? 'Unsaved changes' : editedLabel(lastSavedAt)}
        </span>
      )}

      <span className="grow" />

      <ToolbarButton
        baseClassName="icon-btn"
        onClick={() => editor?.chain().focus().undo().run()}
        disabled={!editor?.can().undo()}
        title="Undo (Cmd+Z)"
      >
        <UndoIcon />
      </ToolbarButton>
      <ToolbarButton
        baseClassName="icon-btn"
        onClick={() => editor?.chain().focus().redo().run()}
        disabled={!editor?.can().redo()}
        title="Redo (Cmd+Shift+Z)"
      >
        <RedoIcon />
      </ToolbarButton>

      <span className="vsep" />
      <button className="ask-btn review-doc-btn" onClick={onReviewDocument}>
        <span className="spark" aria-hidden>
          ✦
        </span>
        Ask Claude
      </button>

      {pendingSuggestionCount > 0 && (
        <>
          <button
            className="topbar-review-btn topbar-accept-all"
            onClick={onAcceptAll}
            title="Accept all suggestions"
          >
            <span aria-hidden>✓</span>
            <span>Accept all</span>
            <span className="review-count">{pendingSuggestionCount}</span>
          </button>
          <button
            className="topbar-review-btn topbar-reject-all"
            onClick={onRejectAll}
            title="Reject all suggestions"
          >
            <span aria-hidden>×</span>
            <span>Reject all</span>
          </button>
          <span className="vsep review-vsep" />
        </>
      )}

      <div className="segmented mode-switch" role="group" aria-label="Editing mode">
        <button
          className={`seg${!isSuggesting ? ' on' : ''}`}
          aria-pressed={!isSuggesting}
          onClick={() => {
            if (isSuggesting) onToggleSuggesting();
          }}
        >
          Editing
        </button>
        <button
          className={`seg${isSuggesting ? ' on' : ''}`}
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
