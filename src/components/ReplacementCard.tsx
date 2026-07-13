import type { Comment, TrackedChangeInfo, TrackedTextSegment } from '../types';
import { clip } from '../utils/format';
import SuggestionCardShell from './SuggestionCardShell';

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
  top: number;
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
  top,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  onActivateChatMessage,
}: ReplacementCardProps) {
  const originalText = deletions.map((segment) => segment.text).join(' … ');
  const replacementText = insertions.map((segment) => segment.text).join(' … ');

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
      top={top}
      acceptTitle="Accept replacement"
      rejectTitle="Reject replacement"
      onAccept={() => onAccept(change.id)}
      onReject={() => onReject(change.id)}
      onClick={() => onClick(change.id)}
      onActivateComment={onActivateComment}
      onActivateChatMessage={onActivateChatMessage}
    >
      <div className="suggestion-preview suggestion-replace-preview">
        <span className="suggestion-replace-old suggestion-removed">“{clip(originalText)}”</span>
        <span className="suggestion-replace-new suggestion-added">“{clip(replacementText)}”</span>
      </div>
    </SuggestionCardShell>
  );
}
