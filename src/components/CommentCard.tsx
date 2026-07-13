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
              className="reply-view-suggestion"
              onClick={(event) => {
                event.stopPropagation();
                onViewSuggestion(linkedSuggestionIds);
              }}
            >
              <span aria-hidden>↗</span> View suggestion
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
    <div className={`comment-reply${isAI ? ' comment-reply-ai' : ''}`}>
      <div className="comment-header">
        <span className="comment-author">
          {isAI && <span className="ai-badge">AI</span>}
          {reply.author}
        </span>
        <span className="comment-time">{timeAgo(reply.createdAt)}</span>
        {isAI && reply.model && (
          <span className="comment-reply-model" title={`Model: ${reply.model}`}>
            {reply.model}
          </span>
        )}
      </div>
      {replyBody}
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
}: CommentCardProps) {
  const [replyText, setReplyText] = useState('');
  const [showReply, setShowReply] = useState(false);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    // No session linked yet is fine — the request handler opens the session
    // picker and fires the request once one is chosen.
    if (/@claude\b/i.test(trimmed)) {
      onAIReplyRequest(comment.id, trimmed);
    }
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
      className={`comment-card${isActive ? ' comment-card-active' : ''}${comment.resolved ? ' comment-card-resolved' : ''}`}
      style={top === undefined ? undefined : { top }}
      data-card-id={comment.id}
      onClick={() => onClick(comment.id)}
    >
      <div className="comment-thread-line" />

      <div className="comment-header">
        <span className="comment-avatar">
          {(comment.author.trim().charAt(0) || '?').toUpperCase()}
        </span>
        <span className="comment-author">{comment.author}</span>
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

      {comment.replies
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

      {showReply ? (
        <form className="comment-reply-form" onSubmit={handleReplySubmit}>
          <textarea
            ref={textareaRef}
            className="comment-reply-input"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply… (@claude to get an AI response)"
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
      ) : (
        !comment.resolved && (
          <button
            className="comment-reply-trigger"
            onClick={(e) => {
              e.stopPropagation();
              setShowReply(true);
              setTimeout(() => textareaRef.current?.focus(), 0);
            }}
          >
            Reply
          </button>
        )
      )}
    </div>
  );
}
