import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, TrackedChangeInfo } from '../types';
import { classifyReplyError } from '../hooks/useClaudeReply';
import { countLinkedSuggestionCards } from '../utils/suggestionCards';

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
    <section className="chat-view panel-view" hidden={hidden} aria-label="Document chat">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <p className="chat-empty-state">
            Ask anything about this document. Edits land as suggestions you review.
          </p>
        )}
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div
                className="chat-message chat-message-user"
                key={message.id}
                data-chat-message-id={message.id}
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
              className="chat-message chat-message-assistant"
              key={message.id}
              data-chat-message-id={message.id}
              tabIndex={-1}
            >
              <div className="chat-assistant-head">
                <span className="ai-badge">AI</span>
                <span className="chat-assistant-name">Claude</span>
                {message.model && <span className="chat-assistant-model">{message.model}</span>}
              </div>
              {message.text && <div className="chat-assistant-text">{message.text}</div>}
              {message.pending && (
                <div className="chat-streaming-state">
                  <span className="chat-stream-caret" aria-hidden />
                  <button onClick={() => onCancel(message.id)}>Stop</button>
                </div>
              )}
              {message.error && (
                <div className="chat-terminal-state chat-error-state">
                  <span>{message.error}</span>
                  <div className="chat-terminal-actions">
                    <button
                      title={
                        errorClass?.kind === 'session' ? 'Retry after changing session' : 'Retry'
                      }
                      onClick={() => onRetry(message.id)}
                    >
                      Retry
                    </button>
                    <button onClick={() => onDismiss(message.id)}>Dismiss</button>
                  </div>
                </div>
              )}
              {message.cancelled && !message.error && (
                <div className="chat-terminal-state">
                  <span>Stopped</span>
                  <div className="chat-terminal-actions">
                    <button onClick={() => onRetry(message.id)}>Retry</button>
                    <button onClick={() => onDismiss(message.id)}>Dismiss</button>
                  </div>
                </div>
              )}
              {message.suggestionIds && suggestionCount > 0 && (
                <button
                  className="chat-suggestion-chip"
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

      <div className="chat-composer">
        <div className="chat-box">
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
          <div className="chat-box-foot">
            <span className="kbd-hint">⌘↵ SEND</span>
            <span className="grow" />
            <button
              className="chat-send-btn"
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
