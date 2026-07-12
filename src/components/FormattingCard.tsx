import type { Comment, FormatSegment, TrackedFormatChange } from '../types';
import { timeAgo, clip } from '../utils/format';

interface FormattingCardProps {
  change: TrackedFormatChange;
  isActive: boolean;
  originComment: Comment | null;
  originActive: boolean;
  top: number;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClick: (id: string) => void;
  onActivateComment: (commentId: string) => void;
}

const MARK_LABELS: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strikethrough',
};

/** Compact, deterministic summary for a possibly multi-span format change. */
export function describeFormatSegments(segments: FormatSegment[]): string {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const segment of segments) {
    segment.adds.forEach((mark) => added.add(mark));
    segment.removes.forEach((mark) => removed.add(mark));
  }
  const label = (mark: string) => MARK_LABELS[mark] ?? mark;
  return [
    ...[...added].sort().map((mark) => `${label(mark)} added`),
    ...[...removed].sort().map((mark) => `${label(mark)} removed`),
  ].join(' · ');
}

function previewText(segments: FormatSegment[]): string {
  const values = segments.map((segment) => segment.text).filter(Boolean);
  return clip(values.join(' … '));
}

export default function FormattingCard({
  change,
  isActive,
  originComment,
  originActive,
  top,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
}: FormattingCardProps) {
  const authorLabel = change.authorID === 'claude' ? 'Claude (AI)' : change.authorID;
  const description = describeFormatSegments(change.segments);
  const preview = previewText(change.segments);

  return (
    <div
      className={`suggestion-card suggestion-card-format${isActive ? ' suggestion-card-active' : ''}${originActive ? ' card-origin-active' : ''}`}
      style={{ top }}
      data-card-id={change.id}
      onClick={() => onClick(change.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className="suggestion-type-badge format">Formatting</span>
        <span className="comment-author">{authorLabel}</span>
        <span className="comment-time">{timeAgo(change.createdAt)}</span>
      </div>

      <div className="formatting-change-description">{description}</div>

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
          onClick={(event) => {
            event.stopPropagation();
            onActivateComment(originComment.id);
          }}
        >
          ↳ comment
        </button>
      )}

      <div className="suggestion-actions">
        <button
          className="suggestion-accept-btn"
          title="Accept formatting"
          onClick={(event) => {
            event.stopPropagation();
            onAccept(change.id);
          }}
        >
          ✓ Accept
        </button>
        <button
          className="suggestion-reject-btn"
          title="Reject formatting"
          onClick={(event) => {
            event.stopPropagation();
            onReject(change.id);
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
