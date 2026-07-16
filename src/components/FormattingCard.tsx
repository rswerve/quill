import type { Comment, FormatSegment, TrackedChangeInfo, TrackedFormatSegment } from '../types';
import { clip } from '../utils/format';
import SuggestionCardShell from './SuggestionCardShell';
import { cx } from '../utils/cx';
import styles from './SuggestionCard.module.css';

interface FormattingCardProps {
  change: TrackedChangeInfo;
  segments: TrackedFormatSegment[];
  isActive: boolean;
  originComment: Comment | null;
  originChatMessageId?: string;
  originActive: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClick: (id: string) => void;
  onActivateComment: (commentId: string) => void;
  onActivateChatMessage?: (messageId: string) => void;
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
  segments,
  isActive,
  originComment,
  originChatMessageId,
  originActive,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  onActivateChatMessage,
}: FormattingCardProps) {
  const description = describeFormatSegments(segments);
  const preview = previewText(segments);

  return (
    <SuggestionCardShell
      cardId={change.id}
      kind="format"
      label="Formatting"
      authorID={change.authorID}
      createdAt={change.createdAt}
      isActive={isActive}
      originComment={originComment}
      originChatMessageId={originChatMessageId}
      originActive={originActive}
      acceptTitle="Accept formatting"
      rejectTitle="Reject formatting"
      onAccept={() => onAccept(change.id)}
      onReject={() => onReject(change.id)}
      onClick={() => onClick(change.id)}
      onActivateComment={onActivateComment}
      onActivateChatMessage={onActivateChatMessage}
    >
      <div className={cx(styles.preview, styles.formatPreview)}>
        <div className={styles.changeDescription}>{description}</div>
        {preview && <div className={styles.formatQuote}>“{preview}”</div>}
      </div>
    </SuggestionCardShell>
  );
}
