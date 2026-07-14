import { useRef, useState } from 'react';

/** Which action the composer fired: a private note or a request to Claude. */
export type ComposerIntent = 'note' | 'claude';

interface CommentComposerCardProps {
  quote: string;
  top: number;
  /** Whether a Claude session is linked. Drives the primary label and the
   *  offline banner; asking with no session is still allowed (it links first,
   *  then sends — handled upstream). */
  hasSession: boolean;
  onSubmit: (text: string, intent: ComposerIntent) => void;
  onCancel: () => void;
}

export default function CommentComposerCard({
  quote,
  top,
  hasSession,
  onSubmit,
  onCancel,
}: CommentComposerCardProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();

  function submit(intent: ComposerIntent) {
    if (trimmed) onSubmit(trimmed, intent);
  }

  return (
    <section
      className="add-comment-compose anchored-comment-composer"
      data-card-id="comment-composer"
      style={{ top }}
      aria-label="Add a note or ask Claude about the selection"
    >
      <blockquote className="comment-composer-quote">“{quote}”</blockquote>
      <textarea
        ref={textareaRef}
        className="comment-reply-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter = newline (you're writing prose). Cmd/Ctrl+Enter = Ask Claude
          // (the networked primary). Cmd/Ctrl+Shift+Enter = Add note.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(event.shiftKey ? 'note' : 'claude');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Ask Claude to change this, or jot a private note…"
        rows={3}
        autoFocus
      />
      {!hasSession && (
        <div className="composer-no-session" role="note">
          No Claude session linked yet —{' '}
          <span className="composer-no-session-hint">note works offline</span>.
        </div>
      )}
      <div className="comment-reply-actions comment-composer-actions">
        <button
          type="button"
          className="btn-ghost composer-add-note"
          disabled={!trimmed}
          onClick={() => submit('note')}
          title="Add a private note (⌘⇧⏎)"
        >
          Add note
        </button>
        <button
          type="button"
          className="btn-primary composer-ask-claude"
          disabled={!trimmed}
          onClick={() => submit('claude')}
          title={hasSession ? 'Ask Claude (⌘⏎)' : 'Link a Claude session, then ask (⌘⏎)'}
        >
          {hasSession ? (
            <>
              <span aria-hidden>✦</span> Ask Claude
            </>
          ) : (
            'Link a session to ask'
          )}
        </button>
      </div>
    </section>
  );
}
