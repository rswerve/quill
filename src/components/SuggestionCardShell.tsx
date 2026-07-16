import type { ReactNode } from 'react';
import type { Comment } from '../types';
import { clip, timeAgo } from '../utils/format';
import { cx } from '../utils/cx';
import styles from './SuggestionCard.module.css';

export type SuggestionCardKind = 'insert' | 'delete' | 'replace' | 'format';

interface SuggestionCardShellProps {
  cardId: string;
  kind: SuggestionCardKind;
  label: string;
  authorID: string;
  createdAt: number;
  isActive: boolean;
  originComment: Comment | null;
  originChatMessageId?: string;
  originActive: boolean;
  acceptTitle: string;
  rejectTitle: string;
  onAccept: () => void;
  onReject: () => void;
  onClick: () => void;
  onActivateComment: (commentId: string) => void;
  onActivateChatMessage?: (messageId: string) => void;
  children: ReactNode;
}

export default function SuggestionCardShell({
  cardId,
  kind,
  label,
  authorID,
  createdAt,
  isActive,
  originComment,
  originChatMessageId,
  originActive,
  acceptTitle,
  rejectTitle,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  onActivateChatMessage,
  children,
}: SuggestionCardShellProps) {
  const isClaude = authorID.toLowerCase() === 'claude';

  return (
    <article
      className={cx(
        styles.card,
        styles[kind],
        isActive && styles.active,
        originActive && styles.originActive,
      )}
      data-card-id={cardId}
      data-suggestion-kind={kind}
      data-active={isActive || undefined}
      data-origin-active={originActive || undefined}
      onClick={onClick}
    >
      <div className={styles.head}>
        <span className={cx(styles.typeBadge, styles[kind])}>{label}</span>
        <span className={styles.author}>{isClaude ? 'Claude' : authorID}</span>
        {isClaude && <span className="ai-badge">AI</span>}
        <span className={styles.headSpacer} />
        <time className={styles.time}>{timeAgo(createdAt)}</time>
      </div>

      {originComment && (
        <button
          className={styles.originChip}
          title={clip(originComment.anchorText, 80)}
          onClick={(event) => {
            event.stopPropagation();
            onActivateComment(originComment.id);
          }}
        >
          ↳ from comment
        </button>
      )}
      {!originComment && originChatMessageId && (
        <button
          className={styles.originChip}
          onClick={(event) => {
            event.stopPropagation();
            onActivateChatMessage?.(originChatMessageId);
          }}
        >
          ↳ from chat
        </button>
      )}

      {children}

      <footer className={styles.actions}>
        <button
          className={styles.acceptBtn}
          title={acceptTitle}
          onClick={(event) => {
            event.stopPropagation();
            onAccept();
          }}
        >
          <span aria-hidden>✓</span>
          <span>Accept</span>
        </button>
        <button
          className={styles.rejectBtn}
          title={rejectTitle}
          onClick={(event) => {
            event.stopPropagation();
            onReject();
          }}
        >
          <span aria-hidden>×</span>
          <span>Reject</span>
        </button>
      </footer>
    </article>
  );
}
