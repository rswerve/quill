import type { Comment, TrackedChangeInfo, TrackedTextSegment } from '../types';
import { clip } from '../utils/format';
import SuggestionCardShell from './SuggestionCardShell';
import styles from './SuggestionCard.module.css';

interface SuggestionCardProps {
  change: TrackedChangeInfo;
  operation: 'insert' | 'delete';
  segments: TrackedTextSegment[];
  isActive: boolean;
  /** The still-existing comment this change originated from, or null (either
   *  no provenance, or the comment was deleted — degrade to no chip). */
  originComment: Comment | null;
  originChatMessageId?: string;
  /** True while the origin comment is the active annotation — the card gets a
   *  subtle outline linking it back to its comment. */
  originActive: boolean;
  top: number;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onClick: (id: string) => void;
  onActivateComment: (commentId: string) => void;
  onActivateChatMessage?: (messageId: string) => void;
}

export default function SuggestionCard({
  change,
  operation,
  segments,
  isActive,
  originComment,
  originChatMessageId,
  originActive,
  top,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  onActivateChatMessage,
}: SuggestionCardProps) {
  const isInsert = operation === 'insert';
  const preview = clip(segments.map((segment) => segment.text).join(' … '));

  return (
    <SuggestionCardShell
      cardId={change.id}
      kind={isInsert ? 'insert' : 'delete'}
      label={isInsert ? 'Insertion' : 'Deletion'}
      authorID={change.authorID}
      createdAt={change.createdAt}
      isActive={isActive}
      originComment={originComment}
      originChatMessageId={originChatMessageId}
      originActive={originActive}
      top={top}
      acceptTitle="Accept change"
      rejectTitle="Reject change"
      onAccept={() => onAccept(change.id)}
      onReject={() => onReject(change.id)}
      onClick={() => onClick(change.id)}
      onActivateComment={onActivateComment}
      onActivateChatMessage={onActivateChatMessage}
    >
      {preview && (
        <div className={styles.preview}>
          <span className={isInsert ? styles.added : styles.removed}>“{preview}”</span>
        </div>
      )}
    </SuggestionCardShell>
  );
}
