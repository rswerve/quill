import styles from './AddCommentButton.module.css';

interface AddCommentButtonProps {
  top: number;
  left?: number;
  visible: boolean;
  onOpen: () => void;
}

export default function AddCommentButton({ top, left, visible, onOpen }: AddCommentButtonProps) {
  if (!visible) return null;

  return (
    <button
      className={styles.btn}
      style={{ position: 'fixed', top, ...(left !== undefined ? { left } : {}) }}
      title="Add comment"
      aria-label="Add comment to selection"
      data-print-hidden
      onClick={onOpen}
    >
      +
    </button>
  );
}
