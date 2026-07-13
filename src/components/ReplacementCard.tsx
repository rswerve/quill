import type { Comment, TrackedTextChange } from '../types';
import { clip } from '../utils/format';
import SuggestionCardShell from './SuggestionCardShell';

interface ReplacementCardProps {
  /** The delete half — the original text being replaced. */
  del: TrackedTextChange;
  /** The insert half — the replacement text. */
  ins: TrackedTextChange;
  isActive: boolean;
  /** The still-existing comment this replacement originated from, or null
   *  (no provenance, or the comment was deleted — degrade to no chip). */
  originComment: Comment | null;
  originChatMessageId?: string;
  /** True while the origin comment is the active annotation — the card gets a
   *  subtle outline linking it back to its comment. */
  originActive: boolean;
  top: number;
  /** All callbacks receive the shared pairId, resolving both halves at once. */
  onAccept: (pairId: string) => void;
  onReject: (pairId: string) => void;
  onClick: (pairId: string) => void;
  onActivateComment: (commentId: string) => void;
  onActivateChatMessage?: (messageId: string) => void;
}

export default function ReplacementCard({
  del,
  ins,
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
  const pairId = del.pairId ?? ins.pairId ?? del.id;

  return (
    <SuggestionCardShell
      cardId={pairId}
      kind="replace"
      label="Replacement"
      authorID={del.authorID}
      createdAt={del.createdAt}
      isActive={isActive}
      originComment={originComment}
      originChatMessageId={originChatMessageId}
      originActive={originActive}
      top={top}
      acceptTitle="Accept replacement"
      rejectTitle="Reject replacement"
      onAccept={() => onAccept(pairId)}
      onReject={() => onReject(pairId)}
      onClick={() => onClick(pairId)}
      onActivateComment={onActivateComment}
      onActivateChatMessage={onActivateChatMessage}
    >
      <div className="suggestion-preview suggestion-replace-preview">
        <span className="suggestion-replace-old suggestion-removed">“{clip(del.text)}”</span>
        <span className="suggestion-replace-new suggestion-added">“{clip(ins.text)}”</span>
      </div>
    </SuggestionCardShell>
  );
}
