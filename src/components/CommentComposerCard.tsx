import { useRef, useState } from 'react';
import styles from './CommentComposerCard.module.css';

/** Which action the composer fired: a private note or a request to Claude. */
export type ComposerIntent = 'note' | 'claude';

interface CommentComposerCardProps {
  quote: string;
  /** Whether a Claude session is linked. Drives the primary label and the
   *  offline banner; asking with no session is still allowed (it links first,
   *  then sends — handled upstream). */
  hasSession: boolean;
  onSubmit: (text: string, intent: ComposerIntent) => void;
  onCancel: () => void;
}

export default function CommentComposerCard({
  quote,
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
      className={styles.composer}
      data-card-id="comment-composer"
      aria-label="Add a note or ask Claude about the selection"
    >
      <blockquote className={styles.quote}>“{quote}”</blockquote>
      <textarea
        ref={textareaRef}
        className={styles.input}
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
        <div className={styles.noSession} role="note">
          No Claude session linked yet —{' '}
          <span className={styles.noSessionHint}>note works offline</span>.
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className="btn-ghost"
          disabled={!trimmed}
          onClick={() => submit('note')}
          title="Add a private note (⌘⇧⏎)"
        >
          Add note
        </button>
        <button
          type="button"
          className="btn-primary"
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
