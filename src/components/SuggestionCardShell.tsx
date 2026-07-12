import type { ReactNode } from 'react';
import type { Comment } from '../types';
import { clip, timeAgo } from '../utils/format';

export type SuggestionCardKind = 'insert' | 'delete' | 'replace' | 'format';

interface SuggestionCardShellProps {
  cardId: string;
  kind: SuggestionCardKind;
  label: string;
  authorID: string;
  createdAt: number;
  isActive: boolean;
  originComment: Comment | null;
  originActive: boolean;
  top: number;
  acceptTitle: string;
  rejectTitle: string;
  onAccept: () => void;
  onReject: () => void;
  onClick: () => void;
  onActivateComment: (commentId: string) => void;
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
  originActive,
  top,
  acceptTitle,
  rejectTitle,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  children,
}: SuggestionCardShellProps) {
  const isClaude = authorID.toLowerCase() === 'claude';

  return (
    <article
      className={`suggestion-card suggestion-card-${kind}${isActive ? ' suggestion-card-active' : ''}${originActive ? ' card-origin-active' : ''}`}
      style={{ top }}
      data-card-id={cardId}
      onClick={onClick}
    >
      <div className="suggestion-head">
        <span className={`suggestion-type-badge ${kind}`}>{label}</span>
        <span className="comment-author">{isClaude ? 'Claude' : authorID}</span>
        {isClaude && <span className="ai-badge suggestion-ai-badge">AI</span>}
        <span className="suggestion-head-spacer" />
        <time className="comment-time">{timeAgo(createdAt)}</time>
      </div>

      {originComment && (
        <button
          className="suggestion-origin-chip"
          title={clip(originComment.anchorText, 80)}
          onClick={(event) => {
            event.stopPropagation();
            onActivateComment(originComment.id);
          }}
        >
          ↳ from comment
        </button>
      )}

      {children}

      <footer className="suggestion-actions">
        <button
          className="suggestion-accept-btn"
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
          className="suggestion-reject-btn"
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
