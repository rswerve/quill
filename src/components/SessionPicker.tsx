import { useEffect, useId, useState } from 'react';
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
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span id={headingId}>Link Claude Code session</span>
          <button className={styles.close} onClick={onClose} title="Close" aria-label="Close">
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
