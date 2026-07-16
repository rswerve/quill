import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, TrackedChangeInfo } from '../types';
import { classifyReplyError } from '../hooks/useClaudeReply';
import { countLinkedSuggestionCards } from '../utils/suggestionCards';
import { cx } from '../utils/cx';
import styles from './ChatPanel.module.css';

interface ChatPanelProps {
  hidden: boolean;
  messages: ChatMessage[];
  trackedChanges: TrackedChangeInfo[];
  focusRevision: number;
  onSend: (text: string) => void;
  onCancel: (assistantMessageId: string) => void;
  onRetry: (assistantMessageId: string) => void;
  onDismiss: (assistantMessageId: string) => void;
  onViewSuggestions: (suggestionIds: string[]) => void;
  busy: boolean;
}

export default function ChatPanel({
  hidden,
  messages,
  trackedChanges,
  focusRevision,
  onSend,
  onCancel,
  onRetry,
  onDismiss,
  onViewSuggestions,
  busy,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const streaming = messages.some((message) => message.role === 'assistant' && message.pending);

  useEffect(() => {
    if (hidden) return;
    inputRef.current?.focus();
  }, [focusRevision, hidden]);

  useEffect(() => {
    if (hidden) return;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [hidden, messages]);

  const resize = () => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 94)}px`;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || streaming || busy) return;
    onSend(text);
    setDraft('');
    requestAnimationFrame(resize);
  };

  return (
    <section className={cx(styles.view, 'panel-view')} hidden={hidden} aria-label="Document chat">
      <div className={styles.log} ref={logRef}>
        {messages.length === 0 && (
          <p className={styles.empty}>
            Ask anything about this document. Edits land as suggestions you review.
          </p>
        )}
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div
                className={cx(styles.message, styles.messageUser)}
                key={message.id}
                data-chat-message-id={message.id}
                data-chat-role="user"
              >
                {message.text}
              </div>
            );
          }
          const errorClass = message.error ? classifyReplyError(message.error) : null;
          const suggestionCount = message.suggestionIds
            ? countLinkedSuggestionCards(trackedChanges, message.suggestionIds)
            : 0;
          return (
            <div
              className={cx(styles.message, styles.messageAssistant)}
              key={message.id}
              data-chat-message-id={message.id}
              data-chat-role="assistant"
              tabIndex={-1}
            >
              <div className={styles.assistantHead}>
                <span className={styles.assistantName}>Claude</span>
              </div>
              {message.text && (
                <div className={styles.assistantText}>
                  {message.text}
                  {message.pending && (
                    <span className={styles.streamCaret} data-chat-caret aria-hidden />
                  )}
                </div>
              )}
              {message.pending && (
                <div className={styles.streamingState}>
                  {!message.text && (
                    <span className={styles.thinkingStatus} role="status" aria-live="polite">
                      <span className={styles.thinkingDot} aria-hidden />
                      Claude is thinking…
                    </span>
                  )}
                  <button
                    type="button"
                    className={cx(styles.actionBtn, styles.stopBtn)}
                    onClick={() => onCancel(message.id)}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" />
                    </svg>
                    Stop
                  </button>
                </div>
              )}
              {message.error && (
                <div className={cx(styles.terminalState, styles.errorState)}>
                  <span>{message.error}</span>
                  <div className={styles.terminalActions}>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      title={
                        errorClass?.kind === 'session' ? 'Retry after changing session' : 'Retry'
                      }
                      onClick={() => onRetry(message.id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                        <path
                          d="M9.7 4.1A4 4 0 1 0 9.8 8M9.7 1.8v2.5H7.2"
                          stroke="currentColor"
                          strokeWidth="1.25"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Retry
                    </button>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => onDismiss(message.id)}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                        <path
                          d="M2 2l6 6M8 2L2 8"
                          stroke="currentColor"
                          strokeWidth="1.25"
                          strokeLinecap="round"
                        />
                      </svg>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {message.cancelled && !message.error && (
                <div className={styles.terminalState}>
                  <span>Stopped</span>
                  <div className={styles.terminalActions}>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => onRetry(message.id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                        <path
                          d="M9.7 4.1A4 4 0 1 0 9.8 8M9.7 1.8v2.5H7.2"
                          stroke="currentColor"
                          strokeWidth="1.25"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Retry
                    </button>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => onDismiss(message.id)}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                        <path
                          d="M2 2l6 6M8 2L2 8"
                          stroke="currentColor"
                          strokeWidth="1.25"
                          strokeLinecap="round"
                        />
                      </svg>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {message.suggestionIds && suggestionCount > 0 && (
                <button
                  className={styles.suggestionChip}
                  onClick={() => onViewSuggestions(message.suggestionIds!)}
                >
                  → {suggestionCount} {suggestionCount === 1 ? 'suggestion' : 'suggestions'} in the
                  doc
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.composer}>
        <div className={styles.box}>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Ask about this document…"
            aria-label="Ask Claude about this document"
            onChange={(event) => {
              setDraft(event.target.value);
              requestAnimationFrame(resize);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className={styles.boxFoot}>
            <span className={styles.kbdHint}>⌘↵ SEND</span>
            <span className="grow" />
            <button
              className={styles.sendBtn}
              aria-label="Send chat message"
              disabled={!draft.trim() || streaming || busy}
              title={busy && !streaming ? 'Claude is already responding in this document' : ''}
              onClick={submit}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M8 13V3M4 7l4-4 4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
