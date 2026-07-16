import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isOpenableHref, normalizeHref, type LinkTarget } from '../utils/linkEditing';
import { cx } from '../utils/cx';
import styles from './LinkEditor.module.css';

export interface LinkEditorAnchor {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface LinkEditorProps {
  target: LinkTarget;
  anchor: LinkEditorAnchor;
  onApply: (text: string, href: string) => void;
  onRemove: () => void;
  onOpen: (href: string) => void;
  onDismiss: () => void;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 8;

export default function LinkEditor({
  target,
  anchor,
  onApply,
  onRemove,
  onOpen,
  onDismiss,
}: LinkEditorProps) {
  const [text, setText] = useState(target.text);
  const [href, setHref] = useState(target.href);
  const [position, setPosition] = useState({ top: anchor.bottom + ANCHOR_GAP, left: anchor.left });
  const cardRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    setText(target.text);
    setHref(target.href);
    // Focus before paint. A delayed animation-frame focus can steal focus back
    // from the Text field when someone clicks it immediately after opening,
    // causing their label edit to be appended to the URL instead.
    urlRef.current?.focus();
    if (!target.existing) urlRef.current?.select();
  }, [target]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), maxLeft);
    const below = anchor.bottom + ANCHOR_GAP;
    const above = anchor.top - rect.height - ANCHOR_GAP;
    const top =
      below + rect.height <= window.innerHeight - VIEWPORT_MARGIN
        ? below
        : Math.max(VIEWPORT_MARGIN, above);
    setPosition({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (cardRef.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);

  const normalizedHref = normalizeHref(href);
  const canApply = Boolean(normalizedHref && (text.trim() || normalizedHref));
  const canOpen = isOpenableHref(href);
  const openTitle = canOpen
    ? 'Open link'
    : 'Relative and in-page links open after Quill supports document navigation';

  const submit = () => {
    if (canApply) onApply(text, href);
  };

  return createPortal(
    <div
      ref={cardRef}
      className={styles.card}
      role="dialog"
      aria-label={target.existing ? 'Edit link' : 'Create link'}
      style={{ top: position.top, left: position.left }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className={styles.row}>
        <label htmlFor="link-editor-text">Text</label>
        <input
          id="link-editor-text"
          className={styles.input}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
        />
      </div>
      <div className={cx(styles.row, styles.urlRow)}>
        <label htmlFor="link-editor-url">URL</label>
        <input
          ref={urlRef}
          id="link-editor-url"
          className={styles.input}
          type="text"
          value={href}
          onChange={(event) => setHref(event.target.value)}
          placeholder="https://example.com"
          spellCheck={false}
        />
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className={cx(styles.btn, styles.remove)}
          onClick={onRemove}
          disabled={!target.existing}
          title={target.existing ? 'Remove link but keep its text' : 'No link to remove yet'}
        >
          Remove
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.btn}
          onClick={() => onOpen(href)}
          disabled={!canOpen}
          title={openTitle}
        >
          Open <span aria-hidden>↗</span>
        </button>
        <button
          type="button"
          className={cx(styles.btn, styles.apply)}
          onClick={submit}
          disabled={!canApply}
        >
          Apply
        </button>
      </div>
    </div>,
    document.body,
  );
}
