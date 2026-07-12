import type { Comment, TrackedTextChange } from '../types';
import { timeAgo, clip } from '../utils/format';

interface SuggestionCardProps {
  change: TrackedTextChange;
  isActive: boolean;
  /** The still-existing comment this change originated from, or null (either
   *  no provenance, or the comment was deleted — degrade to no chip). */
  originComment: Comment | null;
  /** True while the origin comment is the active annotation — the card gets a
   *  subtle outline linking it back to its comment. */
  originActive: boolean;
  top: number;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClick: (id: string) => void;
  onActivateComment: (commentId: string) => void;
}

export default function SuggestionCard({
  change,
  isActive,
  originComment,
  originActive,
  top,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
}: SuggestionCardProps) {
  const isInsert = change.operation === 'insert';
  const preview = clip(change.text);
  const authorLabel = change.authorID === 'claude' ? 'Claude (AI)' : change.authorID;

  return (
    <div
      className={`suggestion-card ${isInsert ? 'suggestion-card-insert' : 'suggestion-card-delete'}${isActive ? ' suggestion-card-active' : ''}${originActive ? ' card-origin-active' : ''}`}
      style={{ top }}
      data-card-id={change.id}
      onClick={() => onClick(change.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className={`suggestion-type-badge ${isInsert ? 'insert' : 'delete'}`}>
          {isInsert ? 'Insertion' : 'Deletion'}
        </span>
        <span className="comment-author">{authorLabel}</span>
        <span className="comment-time">{timeAgo(change.createdAt)}</span>
      </div>

      {preview && (
        <div className="comment-anchor-text">
          {'"'}
          {preview}
          {'"'}
        </div>
      )}

      {originComment && (
        <button
          className="suggestion-origin-chip"
          title={clip(originComment.anchorText, 80)}
          onClick={(e) => {
            e.stopPropagation();
            onActivateComment(originComment.id);
          }}
        >
          ↳ comment
        </button>
      )}

      <div className="suggestion-actions">
        <button
          className="suggestion-accept-btn"
          title="Accept change"
          onClick={(e) => {
            e.stopPropagation();
            onAccept(change.id);
          }}
        >
          ✓ Accept
        </button>
        <button
          className="suggestion-reject-btn"
          title="Reject change"
          onClick={(e) => {
            e.stopPropagation();
            onReject(change.id);
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
