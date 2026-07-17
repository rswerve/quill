import type { Comment, TrackedChangeInfo, TrackedTextSegment } from '../types';
import { clip } from '../utils/format';
import { segmentsToPreview } from '../utils/suggestionCards';
import SuggestionCardShell from './SuggestionCardShell';
import { cx } from '../utils/cx';
import styles from './SuggestionCard.module.css';

interface ReplacementCardProps {
  change: TrackedChangeInfo;
  deletions: TrackedTextSegment[];
  insertions: TrackedTextSegment[];
  isActive: boolean;
  /** The still-existing comment this replacement originated from, or null
   *  (no provenance, or the comment was deleted — degrade to no chip). */
  originComment: Comment | null;
  originChatMessageId?: string;
  /** True while the origin comment is the active annotation — the card gets a
   *  subtle outline linking it back to its comment. */
  originActive: boolean;
  onAccept: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onClick: (changeId: string) => void;
  onActivateComment: (commentId: string) => void;
  onActivateChatMessage?: (messageId: string) => void;
}

export default function ReplacementCard({
  change,
  deletions,
  insertions,
  isActive,
  originComment,
  originChatMessageId,
  originActive,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  onActivateChatMessage,
}: ReplacementCardProps) {
  const originalText = segmentsToPreview(deletions);
  const replacementText = segmentsToPreview(insertions);

  return (
    <SuggestionCardShell
      cardId={change.id}
      kind="replace"
      label="Replacement"
      authorID={change.authorID}
      createdAt={change.createdAt}
      isActive={isActive}
      originComment={originComment}
      originChatMessageId={originChatMessageId}
      originActive={originActive}
      acceptTitle="Accept replacement"
      rejectTitle="Reject replacement"
      onAccept={() => onAccept(change.id)}
      onReject={() => onReject(change.id)}
      onClick={() => onClick(change.id)}
      onActivateComment={onActivateComment}
      onActivateChatMessage={onActivateChatMessage}
    >
      <div className={cx(styles.preview, styles.replacePreview)}>
        <span className={styles.removed} data-replace="old">
          “{clip(originalText)}”
        </span>
        <span className={styles.added} data-replace="new">
          “{clip(replacementText)}”
        </span>
      </div>
    </SuggestionCardShell>
  );
}
