import type { Comment, StructuralChangeInfo, StructuralOp } from '../types';
import SuggestionCardShell from './SuggestionCardShell';
import styles from './SuggestionCard.module.css';

/** A short, human before → after label for the card badge. */
function structuralOpLabel(op: StructuralOp): string {
  switch (op.kind) {
    case 'headingToParagraph':
      return `Heading ${op.level} → Paragraph`;
    case 'paragraphToHeading':
      return `Paragraph → Heading ${op.level}`;
    case 'listToParagraph':
      return 'List → Paragraph';
    case 'paragraphToList':
      return 'Paragraph → List';
  }
}

interface StructuralCardProps {
  change: StructuralChangeInfo;
  isActive: boolean;
  /** The still-existing comment this change originated from, or null. */
  originComment: Comment | null;
  originChatMessageId?: string;
  originActive: boolean;
  onAccept: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onClick: (changeId: string) => void;
  onActivateComment: (commentId: string) => void;
  onActivateChatMessage?: (messageId: string) => void;
}

/**
 * The review card for a structural (block-union) change. The actual before/after
 * content is the in-canvas redline, so the card stays a compact decision surface:
 * the transformation as the badge, and Accept/Reject. Mirrors the inline cards'
 * shell (active state, origin chip, provenance activation) for panel parity.
 */
export default function StructuralCard({
  change,
  isActive,
  originComment,
  originChatMessageId,
  originActive,
  onAccept,
  onReject,
  onClick,
  onActivateComment,
  onActivateChatMessage,
}: StructuralCardProps) {
  return (
    <SuggestionCardShell
      cardId={change.changeId}
      kind="structural"
      label={structuralOpLabel(change.op)}
      authorID={change.author}
      createdAt={Date.parse(change.createdAt)}
      isActive={isActive}
      originComment={originComment}
      originChatMessageId={originChatMessageId}
      originActive={originActive}
      acceptTitle="Accept structure change"
      rejectTitle="Reject structure change"
      onAccept={() => onAccept(change.changeId)}
      onReject={() => onReject(change.changeId)}
      onClick={() => onClick(change.changeId)}
      onActivateComment={onActivateComment}
      onActivateChatMessage={onActivateChatMessage}
    >
      <p className={styles.structuralNote}>
        Restructures this block — see the redline in the document.
      </p>
    </SuggestionCardShell>
  );
}
