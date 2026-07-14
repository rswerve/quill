import { useEffect, useState, useRef } from 'react';
import type { Comment, Reply } from '../types';
import { timeAgo } from '../utils/format';
import { classifyReplyError } from '../hooks/useClaudeReply';

interface CommentCardProps {
  comment: Comment;
  isActive: boolean;
  top?: number;
  onReply: (commentId: string, text: string) => void;
  onAIReplyRequest: (commentId: string, userText: string) => void;
  onCancelAIReply: (replyId: string) => void;
  onRetryAIReply: (replyId: string) => void;
  onDismissAIReply: (commentId: string, replyId: string) => void;
  onViewReplySuggestion: (suggestionIds: string[]) => void;
  pendingSuggestionIds: Set<string>;
  onOpenSessionPicker: () => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => boolean;
  onDelete: (commentId: string) => void;
  onClick: (commentId: string) => void;
  /** Promote a note into a Claude thread ("Ask Claude about this"): the note's
   *  text + anchor become the thread's first request. */
  onPromoteNote: (commentId: string) => void;
}

function ReplyErrorActions({
  message,
  onRetry,
  onRelink,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onRelink: () => void;
  onDismiss: () => void;
}) {
  const { retryable, kind } = classifyReplyError(message);
  const retryBtn = (
    <button className="btn-primary" onClick={onRetry}>
      Retry
    </button>
  );
  const relinkBtn = (primary: boolean) => (
    <button className={primary ? 'btn-primary' : 'btn-ghost'} onClick={onRelink}>
      Re-link session…
    </button>
  );

  // Which affordances to surface, driven by the classifier:
  //   auth     → not retryable; re-linking is the only path forward.
  //   session  → re-link is primary (session is gone), retry as fallback.
  //   else     → transient/unknown; retry is primary, re-link demoted.
  let actions: React.ReactNode;
  if (kind === 'auth') {
    actions = relinkBtn(true);
  } else if (kind === 'session') {
    actions = (
      <>
        {relinkBtn(true)}
        {retryable && (
          <button className="btn-ghost" onClick={onRetry}>
            Retry
          </button>
        )}
      </>
    );
  } else {
    actions = (
      <>
        {retryable && retryBtn}
        {relinkBtn(false)}
      </>
    );
  }
  return (
    <div className="comment-reply-error-actions">
      {actions}
      <button
        className="btn-ghost"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

function ReplyView({
  reply,
  onCancel,
  onRetry,
  onRelink,
  onDismiss,
  onViewSuggestion,
  linkedSuggestionIds,
}: {
  reply: Reply;
  onCancel: () => void;
  onRetry: () => void;
  onRelink: () => void;
  onDismiss: () => void;
  onViewSuggestion: (suggestionIds: string[]) => void;
  linkedSuggestionIds: string[];
}) {
  const isAI = reply.authorKind === 'ai';
  let replyBody;
  if (reply.error) {
    replyBody = (
      <div className="comment-reply-error">
        <p className="comment-reply-error-title">Couldn’t complete the request.</p>
        <p className="comment-reply-error-detail">{reply.error}</p>
        <ReplyErrorActions
          message={reply.error}
          onRetry={onRetry}
          onRelink={onRelink}
          onDismiss={onDismiss}
        />
      </div>
    );
  } else if (reply.cancelled) {
    replyBody = (
      <div className="comment-reply-cancelled">
        <p>Reply stopped.</p>
        <button className="btn-primary" onClick={onRetry}>
          Re-run
        </button>
      </div>
    );
  } else {
    replyBody = (
      <>
        <p className="comment-reply-text">
          {reply.text}
          {reply.pending && reply.text.length === 0 && (
            <span className="ai-thinking">Claude is thinking</span>
          )}
          {reply.pending && (
            <span
              className={`ai-spinner ${reply.text.length > 0 ? 'ai-stream-caret' : 'ai-thinking-dots'}`}
              aria-hidden="true"
            />
          )}
        </p>
        {reply.pending && (
          <button
            className="btn-ghost btn-cancel-ai"
            aria-label="Cancel Claude reply"
            onClick={onCancel}
          >
            ×
          </button>
        )}
        {!reply.pending && linkedSuggestionIds.length > 0 && (
          <div className="comment-reply-linked-actions">
            <button
              className="reply-suggestions-chip"
              onClick={(event) => {
                event.stopPropagation();
                onViewSuggestion(linkedSuggestionIds);
              }}
            >
              → {linkedSuggestionIds.length} suggestion{linkedSuggestionIds.length === 1 ? '' : 's'}
            </button>
            <button
              className="reply-dismiss"
              onClick={(event) => {
                event.stopPropagation();
                onDismiss();
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className={`comment-reply${isAI ? ' comment-reply-ai' : ' comment-reply-user'}`}>
      {/* Single-player thread turns: your text sits in an unlabeled tinted band;
          Claude's reply sits on the card surface under a small "Claude" label
          (no "AI" chip, and no per-reply model tag or timestamp — the header
          carries the one timestamp, the active model lives in the status bar). */}
      {isAI ? (
        <>
          <span className="comment-reply-claude">Claude</span>
          {replyBody}
        </>
      ) : (
        <div className="comment-user-band">{replyBody}</div>
      )}
    </div>
  );
}

export default function CommentCard({
  comment,
  isActive,
  top,
  onReply,
  onAIReplyRequest,
  onCancelAIReply,
  onRetryAIReply,
  onDismissAIReply,
  onViewReplySuggestion,
  pendingSuggestionIds,
  onOpenSessionPicker,
  onResolve,
  onUnresolve,
  onDelete,
  onClick,
  onPromoteNote,
}: CommentCardProps) {
  const [replyText, setReplyText] = useState('');
  const [showReply, setShowReply] = useState(false);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNote = comment.kind === 'note';

  useEffect(() => {
    if (!inlineNotice) return;
    const timeout = window.setTimeout(() => setInlineNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [inlineNotice]);

  function handleReplySubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(comment.id, trimmed);
    // Every reply in a Claude thread continues the conversation with Claude —
    // the @claude token is retired; the thread's kind carries the intent. No
    // session linked yet is fine: the handler opens the picker and fires once
    // one is chosen.
    onAIReplyRequest(comment.id, trimmed);
    setReplyText('');
    setShowReply(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleReplySubmit(e as unknown as React.FormEvent);
    }
    if (e.key === 'Escape') {
      setShowReply(false);
      setReplyText('');
    }
  }

  return (
    <div
      className={`comment-card comment-card-${comment.kind}${isActive ? ' comment-card-active' : ''}${comment.resolved ? ' comment-card-resolved' : ''}`}
      style={top === undefined ? undefined : { top }}
      data-card-id={comment.id}
      onClick={() => onClick(comment.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        {isNote ? (
          <span className="comment-note-badge">Note</span>
        ) : (
          <span className="comment-thread-title">Claude thread</span>
        )}
        <span className="comment-time">{timeAgo(comment.createdAt)}</span>
        <button
          className="comment-resolve-btn"
          title={comment.resolved ? 'Unresolve' : 'Resolve'}
          onClick={(e) => {
            e.stopPropagation();
            if (comment.resolved) {
              const restored = onUnresolve(comment.id);
              setInlineNotice(
                restored
                  ? null
                  : 'Original text can’t be located uniquely; comment remains resolved.',
              );
            } else {
              onResolve(comment.id);
            }
          }}
        >
          {comment.resolved ? '↺' : '✓'}
        </button>
        <button
          className="comment-delete-btn"
          title="Delete comment"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(comment.id);
          }}
        >
          ×
        </button>
      </div>

      <div className="comment-anchor-text">
        {'"'}
        {comment.anchorText.slice(0, 60)}
        {comment.anchorText.length > 60 ? '…' : ''}
        {'"'}
      </div>

      {inlineNotice && (
        <p className="comment-inline-notice" role="status">
          {inlineNotice}
        </p>
      )}

      {isNote
        ? comment.replies
            .filter((reply) => !reply.dismissed)
            .map((reply) => (
              <p key={reply.id} className="comment-note-body">
                {reply.text}
              </p>
            ))
        : comment.replies
            .filter((reply) => !reply.dismissed)
            .map((reply) => (
              <ReplyView
                key={reply.id}
                reply={reply}
                onCancel={() => onCancelAIReply(reply.id)}
                onRetry={() => onRetryAIReply(reply.id)}
                onRelink={onOpenSessionPicker}
                onDismiss={() => onDismissAIReply(comment.id, reply.id)}
                onViewSuggestion={onViewReplySuggestion}
                linkedSuggestionIds={(reply.suggestionIds ?? []).filter((id) =>
                  pendingSuggestionIds.has(id),
                )}
              />
            ))}

      {isNote && !comment.resolved && (
        <button
          className="comment-promote-note"
          onClick={(e) => {
            e.stopPropagation();
            onPromoteNote(comment.id);
          }}
        >
          <span aria-hidden>✦</span> Ask Claude about this
        </button>
      )}

      {!isNote && showReply && (
        <form className="comment-reply-form" onSubmit={handleReplySubmit}>
          <textarea
            ref={textareaRef}
            className="comment-reply-input"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply to Claude…"
            rows={2}
            autoFocus
          />
          <div className="comment-reply-actions">
            <button type="submit" className="btn-primary" disabled={!replyText.trim()}>
              Reply
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setShowReply(false);
                setReplyText('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {!isNote && !showReply && !comment.resolved && (
        <button
          className="comment-reply-trigger"
          onClick={(e) => {
            e.stopPropagation();
            setShowReply(true);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
        >
          Reply to Claude…
        </button>
      )}
    </div>
  );
}
