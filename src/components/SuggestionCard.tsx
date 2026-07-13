import type { Comment, TrackedTextChange } from '../types';
import { clip } from '../utils/format';
import SuggestionCardShell from './SuggestionCardShell';

interface SuggestionCardProps {
  change: TrackedTextChange;
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
  const isInsert = change.operation === 'insert';
  const preview = clip(change.text);

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
        <div className="suggestion-preview">
          <span className={isInsert ? 'suggestion-added' : 'suggestion-removed'}>“{preview}”</span>
        </div>
      )}
    </SuggestionCardShell>
  );
}
