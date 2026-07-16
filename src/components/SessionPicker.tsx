import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AISessionBinding } from '../types';
import { cx } from '../utils/cx';
import styles from './SessionPicker.module.css';

export interface SessionSummary {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  title: string | null;
  documentName: string | null;
  lastUsed: number; // unix seconds
}

interface SessionPreview {
  sessionId: string;
  cwd: string;
  recentAssistantMessages: string[];
}

interface SessionPickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (binding: AISessionBinding) => void;
  /** Folder used as cwd for a Quill-minted session; null until the doc is saved. */
  newSessionCwd: string | null;
  /** Returns the other open document that already owns this session. */
  getSessionOwner: (sessionId: string) => string | null;
}

function formatRelativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function sessionHeadline(session: SessionSummary): string {
  return session.documentName ?? session.title ?? `untitled-${session.sessionId.slice(0, 8)}`;
}

export default function SessionPicker({
  open,
  onClose,
  onPick,
  newSessionCwd,
  getSessionOwner,
}: SessionPickerProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Modal focus management: on open, move focus to a safe control (Close, which
  // is present immediately — not an async session row) and restore the prior
  // focus on close, mirroring the hardened AppModal pattern.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Stop the native event before it reaches the window keydown listener,
      // whose Escape branch clears the active annotation behind the modal
      // (useGlobalShortcuts). Mirrors AppModal. Without this, one Escape both
      // closes the picker and wipes the annotation the user was working on.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea'),
    ).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('hidden'));
    const first = focusable[0] ?? panel;
    const last = focusable.at(-1) ?? panel;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!open) return;
    setSessions(null);
    setLoadError(null);
    setSelectedPath(null);
    setPreview(null);
    invoke<SessionSummary[]>('list_claude_sessions')
      .then((rows) => setSessions(rows))
      .catch((e) => setLoadError(String(e)));
  }, [open]);

  useEffect(() => {
    if (!selectedPath) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    setPreview(null);
    invoke<SessionPreview>('read_claude_session_preview', { jsonlPath: selectedPath })
      .then((p) => setPreview(p))
      .catch((e) => setPreview({ sessionId: '', cwd: '', recentAssistantMessages: [String(e)] }))
      .finally(() => setPreviewLoading(false));
  }, [selectedPath]);

  if (!open) return null;

  const selectedSummary = sessions?.find((s) => s.jsonlPath === selectedPath) ?? null;
  const selectedSessionId = preview?.sessionId || selectedSummary?.sessionId || null;
  const sessionOwner = selectedSessionId ? getSessionOwner(selectedSessionId) : null;

  function handleLink() {
    if (!preview || !selectedSummary || sessionOwner) return;
    onPick({
      provider: 'claude-code',
      sessionId: preview.sessionId || selectedSummary.sessionId,
      cwd: preview.cwd || selectedSummary.cwd,
      linkedAt: new Date().toISOString(),
    });
  }

  function handleStartNew() {
    if (!newSessionCwd) return;
    onPick({
      provider: 'claude-code',
      sessionId: crypto.randomUUID(),
      cwd: newSessionCwd,
      linkedAt: new Date().toISOString(),
      createdByQuill: true,
    });
  }

  return (
    <div data-print-hidden className={styles.overlay} onClick={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.header}>
          <span id={headingId}>Link Claude Code session</span>
          <button
            ref={closeRef}
            className={styles.close}
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.list}>
            {loadError && <div className={styles.error}>{loadError}</div>}
            {!sessions && !loadError && <div className={styles.loading}>Loading…</div>}
            {sessions?.length === 0 && (
              <div className={styles.empty}>
                No Claude Code sessions found under <code>~/.claude/projects/</code> — you can still
                give this document a fresh one with “Start new session” below.
              </div>
            )}
            {sessions?.map((s) => (
              <button
                key={s.jsonlPath}
                className={cx(styles.row, s.jsonlPath === selectedPath && styles.selected)}
                onClick={() => setSelectedPath(s.jsonlPath)}
              >
                <div className={styles.rowTitle}>{sessionHeadline(s)}</div>
                <div className={styles.rowMeta}>
                  <span className={styles.rowCwd}>{s.cwd}</span>
                  <span className={styles.rowTime}>{formatRelativeTime(s.lastUsed)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className={styles.preview}>
            {!selectedPath && <div className={styles.hint}>Pick a session to preview.</div>}
            {previewLoading && <div className={styles.loading}>Loading preview…</div>}
            {preview && !previewLoading && (
              <>
                <div className={styles.previewMeta}>
                  <div>
                    <strong>Session:</strong> <code>{preview.sessionId}</code>
                  </div>
                  <div>
                    <strong>cwd:</strong> <code>{preview.cwd}</code>
                  </div>
                </div>
                <div>
                  {preview.recentAssistantMessages.length === 0 && (
                    <div className={styles.hint}>No assistant messages in this session.</div>
                  )}
                  {preview.recentAssistantMessages.map((m, i) => (
                    <div key={i} className={styles.previewMsg}>
                      {m}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <div className={styles.newGroup}>
            <button
              className={cx('btn-ghost', styles.new)}
              onClick={handleStartNew}
              disabled={!newSessionCwd}
              title={
                newSessionCwd
                  ? `Bind a fresh Claude session running in ${newSessionCwd}`
                  : 'Save the document first — the new session runs in the document’s folder'
              }
            >
              Start new session
            </button>
            {!newSessionCwd && (
              <span className={styles.newHint}>
                Save the document first — a new session runs in its folder
              </span>
            )}
          </div>
          {sessionOwner && (
            <span className={styles.ownerNotice} role="status">
              This session is already linked to {sessionOwner}.
            </span>
          )}
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleLink}
            disabled={!preview || previewLoading || sessionOwner !== null}
            title={sessionOwner ? `This session is already linked to ${sessionOwner}` : undefined}
          >
            Link this session
          </button>
        </div>
      </div>
    </div>
  );
}
