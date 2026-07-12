import type { Comment, TrackedTextChange } from '../types';
import { timeAgo, clip } from '../utils/format';

interface ReplacementCardProps {
  /** The delete half — the original text being replaced. */
  del: TrackedTextChange;
  /** The insert half — the replacement text. */
  ins: TrackedTextChange;
  isActive: boolean;
  /** The still-existing comment this replacement originated from, or null
   *  (no provenance, or the comment was deleted — degrade to no chip). */
  originComment: Comment | null;
  /** True while the origin comment is the active annotation — the card gets a
   *  subtle outline linking it back to its comment. */
  originActive: boolean;
  top: number;
  /** All callbacks receive the shared pairId, resolving both halves at once. */
  onAccept: (pairId: string) => void;
  onReject: (pairId: string) => void;
  onClick: (pairId: string) => void;
  onActivateComment: (commentId: string) => void;
}

export default function ReplacementCard({
  del,
  ins,
  isActive,
  originComment,
  originActive,
  top,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
}: ReplacementCardProps) {
  const pairId = del.pairId ?? ins.pairId ?? del.id;
  const authorLabel = del.authorID === 'claude' ? 'Claude (AI)' : del.authorID;

  return (
    <div
      className={`suggestion-card suggestion-card-replace${isActive ? ' suggestion-card-active' : ''}${originActive ? ' card-origin-active' : ''}`}
      style={{ top }}
      data-card-id={pairId}
      onClick={() => onClick(pairId)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className="suggestion-type-badge replace">Replacement</span>
        <span className="comment-author">{authorLabel}</span>
        <span className="comment-time">{timeAgo(del.createdAt)}</span>
      </div>

      <div className="comment-anchor-text">
        <span className="suggestion-replace-old">
          {'"'}
          {clip(del.text)}
          {'"'}
        </span>
        <span className="suggestion-replace-arrow"> → </span>
        <span className="suggestion-replace-new">
          {'"'}
          {clip(ins.text)}
          {'"'}
        </span>
      </div>

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
          title="Accept replacement"
          onClick={(e) => {
            e.stopPropagation();
            onAccept(pairId);
          }}
        >
          ✓ Accept
        </button>
        <button
          className="suggestion-reject-btn"
          title="Reject replacement"
          onClick={(e) => {
            e.stopPropagation();
            onReject(pairId);
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
