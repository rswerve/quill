import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import type { AnnotationKind } from '../extensions/AnnotationFocus';
import { locateCommentForRepair } from '../utils/commentAnchors';
import type { Comment, StructuralChangeInfo, TrackedChangeInfo } from '../types';

/**
 * The active-annotation kinds the review panel tracks. Structural changes are a
 * distinct kind: they anchor to a block-union node (`blockTrack` attr), not an
 * inline mark, so they navigate to their delete branch rather than through the
 * mark-based {@link findAnnotationRange} lookup used for comments/suggestions.
 */
export type ReviewAnnotationKind = AnnotationKind | 'structural';

type ActiveAnnotation = { kind: ReviewAnnotationKind; id: string } | null;

interface UseAnnotationNavigationOptions {
  editor: TiptapEditor | null;
  comments: Comment[];
  trackedChanges: TrackedChangeInfo[];
  /** Live structural changes, so a reply/View jump can target a structural id. */
  structuralChanges: StructuralChangeInfo[];
  /** The review panel element; used to scroll the target card into view. */
  commentLayerRef: RefObject<HTMLDivElement | null>;
  setActiveAnnotation: Dispatch<SetStateAction<ActiveAnnotation>>;
}

export interface AnnotationNavigation {
  handleActivateComment: (commentId: string) => void;
  handleActivateHistoryComment: (commentId: string) => void;
  handleActivateSuggestion: (id: string) => void;
  handleActivateStructural: (changeId: string) => void;
  handleViewReplySuggestion: (suggestionIds: string[]) => void;
  handleSyncActivate: (kind: ReviewAnnotationKind, id: string) => void;
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
  structuralChanges,
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
    (kind: ReviewAnnotationKind, id: string) => {
      setActiveAnnotation((previous) =>
        previous?.kind === kind && previous.id === id ? previous : { kind, id },
      );
    },
    [setActiveAnnotation],
  );

  // A structural change anchors to its DELETE branch node (the original block),
  // decorated by StructuralRedline with a distinguishing op attribute. Target
  // that specific branch — never a bare `[data-change-id]`, which a stray inline
  // suggestion sharing the id would also match.
  const scrollToStructuralDeleteBranch = useCallback(
    (changeId: string) => {
      if (!editor) return;
      const el = editor.view.dom.querySelector(
        `[data-structural-op="delete"][data-change-id="${CSS.escape(changeId)}"]`,
      );
      el?.scrollIntoView({ behavior: 'instant', block: 'center' });
    },
    [editor],
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
      // A mark-less record (resolved or detached) is located by text — detached ones by
      // unique text only; a live comment navigates to its actual mark.
      const range =
        comment.resolved || comment.detached
          ? locateCommentForRepair(editor.state.doc, comment)
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

  // Card click TOGGLES the active structural change off on re-click, like the
  // other card-activation handlers, and snaps the document to its delete branch.
  const handleActivateStructural = useCallback(
    (changeId: string) => {
      setActiveAnnotation((prev) =>
        prev?.kind === 'structural' && prev.id === changeId
          ? null
          : { kind: 'structural', id: changeId },
      );
      scrollToStructuralDeleteBranch(changeId);
      scrollCardIntoView(changeId);
    },
    [scrollToStructuralDeleteBranch, scrollCardIntoView, setActiveAnnotation],
  );

  // Reply -> suggestion is a directed provenance jump, so it never toggles an
  // already-active target off. If one linked change has been resolved, advance
  // to the first linked suggestion that is still pending. A linked STRUCTURAL id
  // (block-union, invisible to trackedChanges) is recognized as a fallback so the
  // chip activates its card rather than silently no-opping.
  const handleViewReplySuggestion = useCallback(
    (suggestionIds: string[]) => {
      const change = trackedChanges.find(
        (candidate) => suggestionIds.includes(candidate.id) && candidate.status === 'pending',
      );
      if (change) {
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
        return;
      }
      const structural = structuralChanges.find((candidate) =>
        suggestionIds.includes(candidate.changeId),
      );
      if (!structural) return;
      setActiveAnnotation({ kind: 'structural', id: structural.changeId });
      scrollToStructuralDeleteBranch(structural.changeId);
      scrollCardIntoView(structural.changeId);
    },
    [
      editor,
      scrollCardIntoView,
      scrollToStructuralDeleteBranch,
      structuralChanges,
      trackedChanges,
      setActiveAnnotation,
    ],
  );

  return {
    handleActivateComment,
    handleActivateHistoryComment,
    handleActivateSuggestion,
    handleActivateStructural,
    handleViewReplySuggestion,
    handleSyncActivate,
  };
}
