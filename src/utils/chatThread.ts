import type { ChatMessage } from '../types';

/**
 * Drop transient chat state before serialization, mirroring `stripTransientReplyState`
 * for comment replies. A `pending` assistant message is a half-streamed turn: if it
 * reaches the sidecar or the workspace snapshot as-is, the next open would resurrect a
 * live spinner for a stream that no longer exists.
 *
 * We DOWNGRADE such a turn to `cancelled` (keeping whatever partial text streamed)
 * rather than deleting it, because that is exactly what `useDocumentChat.restore` does
 * to a pending message loaded from disk — so persistence and restore agree, and the
 * user recovers a retryable partial instead of losing the exchange. Errored and
 * already-cancelled assistant turns are deliberately kept: they are legitimate,
 * retryable history, not in-flight state. Returns a new array; the input is not
 * mutated, and the array reference is preserved when nothing changes.
 */
export function stripTransientChatState(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role === 'assistant' && message.pending) {
      changed = true;
      return { ...message, pending: false, cancelled: true };
    }
    return message;
  });
  return changed ? out : messages;
}
