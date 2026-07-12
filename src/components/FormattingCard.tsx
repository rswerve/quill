import type { Comment, FormatSegment, TrackedFormatChange } from '../types';
import { clip } from '../utils/format';
import SuggestionCardShell from './SuggestionCardShell';

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
  const description = describeFormatSegments(change.segments);
  const preview = previewText(change.segments);

  return (
    <SuggestionCardShell
      cardId={change.id}
      kind="format"
      label="Formatting"
      authorID={change.authorID}
      createdAt={change.createdAt}
      isActive={isActive}
      originComment={originComment}
      originActive={originActive}
      top={top}
      acceptTitle="Accept formatting"
      rejectTitle="Reject formatting"
      onAccept={() => onAccept(change.id)}
      onReject={() => onReject(change.id)}
      onClick={() => onClick(change.id)}
      onActivateComment={onActivateComment}
    >
      <div className="suggestion-preview suggestion-format-preview">
        <div className="formatting-change-description">{description}</div>
        {preview && <div className="suggestion-format-quote">“{preview}”</div>}
      </div>
    </SuggestionCardShell>
  );
}
