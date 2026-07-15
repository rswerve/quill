import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import type { AnnotationKind } from '../extensions/AnnotationFocus';
import { locateDetachedCommentAnchor } from '../utils/commentAnchors';
import type { Comment, TrackedChangeInfo } from '../types';

type ActiveAnnotation = { kind: AnnotationKind; id: string } | null;

interface UseAnnotationNavigationOptions {
  editor: TiptapEditor | null;
  comments: Comment[];
  trackedChanges: TrackedChangeInfo[];
  /** The review panel element; used to scroll the target card into view. */
  commentLayerRef: RefObject<HTMLDivElement | null>;
  setActiveAnnotation: Dispatch<SetStateAction<ActiveAnnotation>>;
}

export interface AnnotationNavigation {
  handleActivateComment: (commentId: string) => void;
  handleActivateHistoryComment: (commentId: string) => void;
  handleActivateSuggestion: (id: string) => void;
  handleViewReplySuggestion: (suggestionIds: string[]) => void;
  handleSyncActivate: (kind: AnnotationKind, id: string) => void;
}

/**
 * The text <-> card navigation for the review panel, lifted out of DocumentTab.
 * These handlers look alike but their semantics genuinely differ and are kept
 * distinct on purpose: card clicks TOGGLE the active annotation off on re-click,
 * provenance jumps (reply -> suggestion) never toggle off, resolved comments
 * need a safe detached-anchor lookup, a reply jump advances to the first still-
 * pending linked suggestion, and a direct comment click uses its live DOM mark
 * rather than a position lookup. Behavior (and the exact effect dependencies) is
 * preserved verbatim from the original DocumentTab implementation.
 */
export function useAnnotationNavigation({
  editor,
  comments,
  trackedChanges,
  commentLayerRef,
  setActiveAnnotation,
}: UseAnnotationNavigationOptions): AnnotationNavigation {
  // The panel is an independent flat list. Directed provenance/highlight jumps
  // reveal their card without moving the document scroll surface.
  const scrollCardIntoView = useCallback(
    (cardId: string) => {
      requestAnimationFrame(() => {
        const panel = commentLayerRef.current?.querySelector(
          '.comment-panel-list',
        ) as HTMLElement | null;
        const card = commentLayerRef.current?.querySelector(
          `[data-card-id="${CSS.escape(cardId)}"]`,
        ) as HTMLElement | null;
        if (!panel || !card) return;
        const panelRect = panel.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        if (cardRect.top >= panelRect.top + 24 && cardRect.bottom <= panelRect.bottom - 24) return;
        panel.scrollTo({
          top: Math.max(0, card.offsetTop + card.offsetHeight / 2 - panel.clientHeight / 2),
          behavior: 'smooth',
        });
      });
    },
    [commentLayerRef],
  );

  const handleSyncActivate = useCallback(
    (kind: AnnotationKind, id: string) => {
      setActiveAnnotation((previous) =>
        previous?.kind === kind && previous.id === id ? previous : { kind, id },
      );
    },
    [setActiveAnnotation],
  );

  const handleActivateComment = useCallback(
    (commentId: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'comment' && prev.id === commentId
          ? null
          : { kind: 'comment', id: commentId },
      );
      // Snap the anchor into range instantly (a smooth anchor scroll would
      // fight the card's smooth scroll on the same container), then bring the
      // full card on-screen.
      if (editor) {
        const dom = editor.view.dom.querySelector(`[data-comment-id="${commentId}"]`);
        dom?.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
      scrollCardIntoView(commentId);
    },
    [editor, scrollCardIntoView, setActiveAnnotation],
  );

  const handleActivateHistoryComment = useCallback(
    (commentId: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'comment' && prev.id === commentId
          ? null
          : { kind: 'comment', id: commentId },
      );
      const comment = comments.find((candidate) => candidate.id === commentId);
      if (!editor || !comment) return;
      const range = comment.resolved
        ? locateDetachedCommentAnchor(editor.state.doc, comment)
        : findAnnotationRange(editor.state.doc, 'comment', commentId);
      if (!range) return;
      const { node } = editor.view.domAtPos(range.from);
      const element = node instanceof HTMLElement ? node : node.parentElement;
      element?.scrollIntoView({ behavior: 'instant', block: 'center' });
      scrollCardIntoView(commentId);
    },
    [comments, editor, scrollCardIntoView, setActiveAnnotation],
  );

  const handleActivateSuggestion = useCallback(
    (id: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'suggestion' && prev.id === id ? null : { kind: 'suggestion', id },
      );
      if (editor) {
        const range = findAnnotationRange(editor.state.doc, 'suggestion', id);
        if (range) {
          const { node } = editor.view.domAtPos(range.from);
          const el = node instanceof HTMLElement ? node : node.parentElement;
          el?.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
      }
      scrollCardIntoView(id);
    },
    [editor, scrollCardIntoView, setActiveAnnotation],
  );

  // Reply -> suggestion is a directed provenance jump, so it never toggles an
  // already-active target off. If one linked change has been resolved, advance
  // to the first linked suggestion that is still pending.
  const handleViewReplySuggestion = useCallback(
    (suggestionIds: string[]) => {
      const change = trackedChanges.find(
        (candidate) => suggestionIds.includes(candidate.id) && candidate.status === 'pending',
      );
      if (!change) return;
      const cardId = change.id;
      setActiveAnnotation({ kind: 'suggestion', id: cardId });
      if (editor) {
        const range = findAnnotationRange(editor.state.doc, 'suggestion', cardId);
        if (range) {
          const { node } = editor.view.domAtPos(range.from);
          const element = node instanceof HTMLElement ? node : node.parentElement;
          element?.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
      }
      scrollCardIntoView(cardId);
    },
    [editor, scrollCardIntoView, trackedChanges, setActiveAnnotation],
  );

  return {
    handleActivateComment,
    handleActivateHistoryComment,
    handleActivateSuggestion,
    handleViewReplySuggestion,
    handleSyncActivate,
  };
}
