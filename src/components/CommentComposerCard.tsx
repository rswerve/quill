import { useRef, useState } from 'react';

interface CommentComposerCardProps {
  quote: string;
  top: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export default function CommentComposerCard({
  quote,
  top,
  onSubmit,
  onCancel,
}: CommentComposerCardProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const trimmed = text.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <section
      className="add-comment-compose anchored-comment-composer"
      data-card-id="comment-composer"
      style={{ top }}
      aria-label="New comment on selection"
    >
      <blockquote className="comment-composer-quote">“{quote}”</blockquote>
      <textarea
        ref={textareaRef}
        className="comment-reply-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Add a comment…"
        rows={3}
        autoFocus
      />
      <div className="comment-composer-tip">Type @claude to ping</div>
      <div className="comment-reply-actions comment-composer-actions">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={!text.trim()} onClick={submit}>
          Comment
        </button>
      </div>
    </section>
  );
}
