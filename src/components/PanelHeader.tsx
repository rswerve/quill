import { useEffect, useRef, useState } from 'react';
import type { AISessionBinding } from '../types';
import { cx } from '../utils/cx';
import styles from './PanelHeader.module.css';

interface PanelHeaderProps {
  mode: 'comments' | 'chat';
  commentCount: number;
  showResolved: boolean;
  resolvedCount: number;
  aiSession: AISessionBinding | null;
  onModeChange: (mode: 'comments' | 'chat') => void;
  onToggleResolved: () => void;
  onChangeSession: () => void;
  onStartNewSession: () => void;
  onUnlinkSession: () => void;
}

export default function PanelHeader({
  mode,
  commentCount,
  showResolved,
  resolvedCount,
  aiSession,
  onModeChange,
  onToggleResolved,
  onChangeSession,
  onStartNewSession,
  onUnlinkSession,
}: PanelHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);

  return (
    <header className={styles.head}>
      <div className={styles.toggle} role="tablist" aria-label="Review panel">
        <button
          className={cx(styles.tab, mode === 'comments' && styles.on)}
          role="tab"
          aria-selected={mode === 'comments'}
          onClick={() => onModeChange('comments')}
        >
          Comments <span className={styles.tabCount}>{commentCount}</span>
        </button>
        <button
          className={cx(styles.tab, mode === 'chat' && styles.on)}
          role="tab"
          aria-selected={mode === 'chat'}
          onClick={() => onModeChange('chat')}
        >
          Chat
        </button>
      </div>
      <span className="grow" />

      {mode === 'comments' ? (
        <button
          className={styles.filter}
          aria-label="Show resolved comments"
          aria-pressed={showResolved}
          onClick={onToggleResolved}
          disabled={!showResolved && resolvedCount === 0}
          title={resolvedCount ? 'Show or hide resolved comments' : 'No resolved comments'}
        >
          {showResolved ? 'Resolved' : 'Open'}
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4 6.5 8 10.5 12 6.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : (
        <>
          <span
            className={cx(styles.sessionChip, aiSession && styles.linked)}
            title={aiSession ? `Claude session ${aiSession.sessionId}` : 'No Claude session linked'}
          >
            ✦ {aiSession ? aiSession.sessionId.slice(0, 8).toUpperCase() : 'NO SESSION'}
          </span>
          <div className={styles.sessionMenu} ref={menuRef}>
            <button
              className={styles.trigger}
              aria-label="Chat session menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className={styles.popover} role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onChangeSession();
                  }}
                >
                  Change session
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onStartNewSession();
                  }}
                >
                  Start new session
                </button>
                <button
                  role="menuitem"
                  disabled={!aiSession}
                  onClick={() => {
                    setMenuOpen(false);
                    onUnlinkSession();
                  }}
                >
                  Unlink
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </header>
  );
}
