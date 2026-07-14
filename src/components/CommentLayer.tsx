import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { Comment, TrackedChangeInfo } from '../types';
import CommentCard from './CommentCard';
import SuggestionCard from './SuggestionCard';
import ReplacementCard from './ReplacementCard';
import FormattingCard from './FormattingCard';
import CommentComposerCard, { type ComposerIntent } from './CommentComposerCard';
import AnnotationGutter from './AnnotationGutter';
import type { SelectionInfo } from './Editor';
import { groupSuggestionCards } from '../utils/suggestionCards';
import {
  nearestGutterTick,
  panelNudgeTarget,
  type GutterAnnotationKind,
  type GutterTargetKind,
  type GutterTickInput,
} from './commentPositioning';

interface CommentLayerProps {
  editor: Editor | null;
  comments: Comment[];
  activeCommentId: string | null;
  activeSuggestionId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  trackedChanges: TrackedChangeInfo[];
  commentComposer: SelectionInfo | null;
  scrollTop: number;
  zoom: number;
  /** Explicit layout invalidation for a mounted editor becoming visible again. */
  layoutRevision: number;
  /** Increments when the active annotation came from a click in the document. */
  highlightActivationRevision: number;
  hidden: boolean;
  showResolved: boolean;
  onShowResolvedChange: (showResolved: boolean) => void;
  onReply: (commentId: string, text: string) => void;
  onAIReplyRequest: (commentId: string, userText: string) => void;
  onCancelAIReply: (replyId: string) => void;
  onRetryAIReply: (replyId: string) => void;
  onDismissAIReply: (commentId: string, replyId: string) => void;
  onViewReplySuggestion: (suggestionIds: string[]) => void;
  onOpenSessionPicker: () => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => boolean;
  onDelete: (commentId: string) => void;
  onPromoteNote: (commentId: string) => void;
  onActivate: (commentId: string) => void;
  onActivateHistory: (commentId: string) => void;
  onActivateSuggestion: (id: string) => void;
  /** Focuses a card/tick without causing either scroll surface to navigate. */
  onSyncActivate: (kind: GutterTargetKind, id: string) => void;
  onActivateChatMessage: (messageId: string) => void;
  onAcceptChange: (id: string) => void;
  onRejectChange: (id: string) => void;
  onSubmitComment: (text: string, intent: ComposerIntent) => void;
  onCancelComment: () => void;
  /** Whether a Claude session is linked — drives the composer's Ask-Claude
   *  primary label and the offline note banner. */
  hasSession: boolean;
}

type SuggestionGroup = ReturnType<typeof groupSuggestionCards>[number];

type OpenPanelItem =
  | {
      type: 'comment';
      cardId: string;
      documentPosition: number;
      documentOrder: number;
      comment: Comment;
    }
  | {
      type: 'suggestion';
      cardId: string;
      documentPosition: number;
      documentOrder: number;
      group: SuggestionGroup;
    }
  | {
      type: 'composer';
      cardId: typeof COMMENT_COMPOSER_CARD_ID;
      documentPosition: number;
      documentOrder: number;
      selection: SelectionInfo;
    };

const COMMENT_COMPOSER_CARD_ID = 'comment-composer';
const PANEL_USER_SCROLL_SUPPRESSION_MS = 1100;
const DOCUMENT_SCROLL_INTENT_WINDOW_MS = 1400;

export function sortCommentsInDocumentOrder(comments: Comment[]): Comment[] {
  return [...comments].sort(
    (a, b) => a.from - b.from || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function sameNumberMap(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

// Top of an annotation's in-text highlight, in scroll-area coordinates. Comments
// and tracked changes anchor identically — they differ only in the data
// attribute the highlight carries.
function getAnchorTopBy(editor: Editor, attr: 'data-comment-id' | 'data-change-id', id: string) {
  try {
    const dom = editor.view.dom;
    const el = dom.querySelector(`[${attr}="${CSS.escape(id)}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const scrollArea = dom.closest('.editor-scroll-area');
    const containerRect = scrollArea?.getBoundingClientRect();
    if (!containerRect) return null;
    return rect.top - containerRect.top + (scrollArea?.scrollTop ?? 0);
  } catch {
    return null;
  }
}

function getAnchorTop(editor: Editor, commentId: string): number | null {
  return getAnchorTopBy(editor, 'data-comment-id', commentId);
}

function getChangeAnchorTop(editor: Editor, changeId: string): number | null {
  return getAnchorTopBy(editor, 'data-change-id', changeId);
}

function getDocumentPositionTop(editor: Editor, position: number): number | null {
  try {
    const rect = editor.view.coordsAtPos(
      Math.max(0, Math.min(position, editor.state.doc.content.size)),
    );
    const scrollArea = editor.view.dom.closest('.editor-scroll-area');
    const containerRect = scrollArea?.getBoundingClientRect();
    if (!containerRect) return null;
    return rect.top - containerRect.top + (scrollArea?.scrollTop ?? 0);
  } catch {
    return null;
  }
}

function suggestionPosition(group: SuggestionGroup): number {
  const anchor = group.kind === 'replacement' ? group.deletions[0] : group.segments[0];
  return anchor?.from ?? 0;
}

export default function CommentLayer({
  editor,
  comments,
  activeCommentId,
  activeSuggestionId,
  containerRef,
  trackedChanges,
  commentComposer,
  scrollTop,
  zoom,
  layoutRevision,
  highlightActivationRevision,
  hidden,
  showResolved,
  onShowResolvedChange,
  onReply,
  onAIReplyRequest,
  onCancelAIReply,
  onRetryAIReply,
  onDismissAIReply,
  onViewReplySuggestion,
  onOpenSessionPicker,
  onResolve,
  onUnresolve,
  onDelete,
  onPromoteNote,
  onActivate,
  onActivateHistory,
  onActivateSuggestion,
  onSyncActivate,
  onActivateChatMessage,
  onAcceptChange,
  onRejectChange,
  onSubmitComment,
  onCancelComment,
  hasSession,
}: CommentLayerProps) {
  const panelListRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const viewSuggestionRafRef = useRef<number>(0);
  const panelScrollTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const panelUserSuppressedUntilRef = useRef(0);
  const lastHighlightActivationRef = useRef(highlightActivationRevision);
  const lastActiveSyncScrollTopRef = useRef(scrollTop);
  const previousActivePanelCardIdRef = useRef<string | null>(null);
  const lastDocumentScrollIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [anchorTops, setAnchorTops] = useState<Map<string, number>>(new Map());
  const [viewportHeight, setViewportHeight] = useState(0);

  const visibleComments = useMemo(
    () => comments.filter((comment) => !comment.resolved),
    [comments],
  );
  const resolvedComments = useMemo(
    () => sortCommentsInDocumentOrder(comments.filter((comment) => comment.resolved)),
    [comments],
  );
  const suggestionGroups = useMemo(
    () => groupSuggestionCards(trackedChanges.filter((change) => change.status === 'pending')),
    [trackedChanges],
  );
  const pendingSuggestionIds = useMemo(
    () =>
      new Set(
        trackedChanges.filter((change) => change.status === 'pending').map((change) => change.id),
      ),
    [trackedChanges],
  );

  const openItems = useMemo(() => {
    const items: OpenPanelItem[] = [];
    let documentOrder = 0;
    visibleComments.forEach((comment) => {
      items.push({
        type: 'comment',
        cardId: comment.id,
        documentPosition: comment.from,
        documentOrder: documentOrder++,
        comment,
      });
    });
    suggestionGroups.forEach((group) => {
      items.push({
        type: 'suggestion',
        cardId: group.cardId,
        documentPosition: suggestionPosition(group),
        documentOrder: documentOrder++,
        group,
      });
    });
    if (commentComposer) {
      items.push({
        type: 'composer',
        cardId: COMMENT_COMPOSER_CARD_ID,
        documentPosition: commentComposer.from,
        documentOrder: documentOrder++,
        selection: commentComposer,
      });
    }
    return items.sort(
      (a, b) => a.documentPosition - b.documentPosition || a.documentOrder - b.documentOrder,
    );
  }, [commentComposer, suggestionGroups, visibleComments]);

  // A provenance chip is a directed jump, not a toggle: clicking it while its
  // comment is already active must not deactivate the target. Resolved origin
  // comments are still valid provenance, so reveal them before activating.
  const activateOriginComment = useCallback(
    (commentId: string) => {
      const origin = comments.find((comment) => comment.id === commentId);
      if (origin?.resolved) {
        onShowResolvedChange(true);
        if (activeCommentId !== commentId) onActivateHistory(commentId);
      } else if (activeCommentId !== commentId) {
        onActivate(commentId);
      }
    },
    [activeCommentId, comments, onActivate, onActivateHistory, onShowResolvedChange],
  );

  const editorRef = useRef(editor);
  const commentsRef = useRef(visibleComments);
  const suggestionGroupsRef = useRef(suggestionGroups);
  const composerRef = useRef(commentComposer);
  const hiddenRef = useRef(hidden);
  const showResolvedRef = useRef(showResolved);
  const activeCommentIdRef = useRef(activeCommentId);
  const activeSuggestionIdRef = useRef(activeSuggestionId);
  editorRef.current = editor;
  commentsRef.current = visibleComments;
  suggestionGroupsRef.current = suggestionGroups;
  composerRef.current = commentComposer;
  hiddenRef.current = hidden;
  showResolvedRef.current = showResolved;
  activeCommentIdRef.current = activeCommentId;
  activeSuggestionIdRef.current = activeSuggestionId;

  const refreshAnchors = useCallback(() => {
    const currentEditor = editorRef.current;
    if (!currentEditor || hiddenRef.current || showResolvedRef.current) {
      setAnchorTops((previous) => (previous.size === 0 ? previous : new Map()));
      return;
    }

    const next = new Map<string, number>();
    commentsRef.current.forEach((comment) => {
      const top =
        getAnchorTop(currentEditor, comment.id) ??
        getDocumentPositionTop(currentEditor, comment.from);
      if (top !== null) next.set(comment.id, top);
    });
    suggestionGroupsRef.current.forEach((group) => {
      const fallbackFrom = suggestionPosition(group);
      const top =
        getChangeAnchorTop(currentEditor, group.change.id) ??
        getDocumentPositionTop(currentEditor, fallbackFrom);
      if (top !== null) next.set(group.cardId, top);
    });
    const composer = composerRef.current;
    if (composer) {
      const top = getDocumentPositionTop(currentEditor, composer.from);
      if (top !== null) next.set(COMMENT_COMPOSER_CARD_ID, top);
    }

    const scrollArea = currentEditor.view.dom.closest('.editor-scroll-area');
    const nextViewportHeight = scrollArea?.clientHeight ?? 0;
    setViewportHeight((previous) =>
      previous === nextViewportHeight ? previous : nextViewportHeight,
    );
    setAnchorTops((previous) => (sameNumberMap(previous, next) ? previous : next));
  }, []);

  const scheduleAnchorRefresh = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(refreshAnchors);
  }, [refreshAnchors]);

  useEffect(() => {
    if (!editor) return;
    editor.on('update', scheduleAnchorRefresh);
    editor.on('selectionUpdate', scheduleAnchorRefresh);
    scheduleAnchorRefresh();
    return () => {
      editor.off('update', scheduleAnchorRefresh);
      editor.off('selectionUpdate', scheduleAnchorRefresh);
      cancelAnimationFrame(rafRef.current);
    };
  }, [editor, scheduleAnchorRefresh]);

  useEffect(() => {
    const currentEditor = editorRef.current;
    const container = containerRef.current;
    if (!currentEditor || !container) return;
    const observer = new ResizeObserver(scheduleAnchorRefresh);
    observer.observe(container);
    observer.observe(currentEditor.view.dom);
    return () => observer.disconnect();
  }, [containerRef, editor, scheduleAnchorRefresh]);

  // Active-sync follows a user scrolling the document, not incidental layout
  // scrolls caused by focus, composition, or browser reflow. This distinction
  // keeps Escape/plain-text dismissal visibly cleared until the next genuine
  // scroll gesture while still covering trackpad, keyboard, touch, and a drag
  // on the scroll area's own scrollbar.
  useEffect(() => {
    const scrollArea = editor?.view.dom.closest('.editor-scroll-area');
    if (!scrollArea) return;
    const markIntent = () => {
      lastDocumentScrollIntentAtRef.current = performance.now();
    };
    const handlePointerDown = (event: Event) => {
      if (event.target === scrollArea) markIntent();
    };
    const handleKeyDown = (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) {
        markIntent();
      }
    };
    scrollArea.addEventListener('wheel', markIntent, { passive: true });
    scrollArea.addEventListener('touchmove', markIntent, { passive: true });
    scrollArea.addEventListener('pointerdown', handlePointerDown, { passive: true });
    scrollArea.addEventListener('keydown', handleKeyDown);
    return () => {
      scrollArea.removeEventListener('wheel', markIntent);
      scrollArea.removeEventListener('touchmove', markIntent);
      scrollArea.removeEventListener('pointerdown', handlePointerDown);
      scrollArea.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor]);

  useEffect(() => {
    scheduleAnchorRefresh();
  }, [
    comments,
    trackedChanges,
    commentComposer,
    showResolved,
    hidden,
    zoom,
    layoutRevision,
    scheduleAnchorRefresh,
  ]);

  const activeSuggestionCardId = activeSuggestionId
    ? (suggestionGroups.find((group) => group.cardId === activeSuggestionId)?.cardId ??
      activeSuggestionId)
    : null;
  const activePanelCardId = commentComposer
    ? COMMENT_COMPOSER_CARD_ID
    : (activeCommentId ?? activeSuggestionCardId ?? null);

  // An explicit clear (Escape, plain-text click, or toggling the active card)
  // must remain visibly clear until the document actually scrolls again. A
  // composer/layout update can otherwise leave the sync baseline one render
  // behind and immediately reselect the nearest annotation.
  useEffect(() => {
    const previous = previousActivePanelCardIdRef.current;
    if (previous !== null && activePanelCardId === null) {
      lastActiveSyncScrollTopRef.current = scrollTop;
    }
    previousActivePanelCardIdRef.current = activePanelCardId;
  }, [activePanelCardId, scrollTop]);

  const scrollPanelCard = useCallback((cardId: string, forceCenter = false) => {
    requestAnimationFrame(() => {
      const panel = panelListRef.current;
      const card = panel?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`);
      if (!panel || !card) return;
      const target = forceCenter
        ? Math.max(0, card.offsetTop + card.offsetHeight / 2 - panel.clientHeight / 2)
        : panelNudgeTarget(panel.scrollTop, panel.clientHeight, card.offsetTop, card.offsetHeight);
      if (target !== null) panel.scrollTo({ top: target, behavior: 'smooth' });
    });
  }, []);

  // Highlight clicks are explicit navigation: reveal and briefly flash the
  // target even if a recent manual panel scroll would normally suppress sync.
  // Ordinary active-sync only nudges when the focused card leaves the middle
  // comfort band and yields to a panel scroll the user initiated.
  useEffect(() => {
    if (!activePanelCardId || hidden || showResolved) return;
    const fromHighlight = highlightActivationRevision !== lastHighlightActivationRef.current;
    lastHighlightActivationRef.current = highlightActivationRevision;
    if (!fromHighlight && performance.now() < panelUserSuppressedUntilRef.current) return;
    scrollPanelCard(activePanelCardId, fromHighlight);
    if (!fromHighlight) return;
    requestAnimationFrame(() => {
      const card = panelListRef.current?.querySelector<HTMLElement>(
        `[data-card-id="${CSS.escape(activePanelCardId)}"]`,
      );
      if (!card) return;
      card.classList.remove('annotation-card-flash');
      void card.offsetWidth;
      card.classList.add('annotation-card-flash');
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => {
        card.classList.remove('annotation-card-flash');
        flashTimerRef.current = null;
      }, 520);
    });
  }, [activePanelCardId, hidden, highlightActivationRevision, scrollPanelCard, showResolved]);

  const gutterTicks = useMemo(() => {
    if (hidden || showResolved) return [];
    return openItems.flatMap<GutterTickInput>((item, documentOrder) => {
      if (item.type === 'composer') return [];
      const anchorTop = anchorTops.get(item.cardId);
      if (anchorTop === undefined) return [];
      let annotationKind: GutterAnnotationKind;
      let targetKind: GutterTargetKind;
      if (item.type === 'comment') {
        annotationKind = item.comment.kind;
        targetKind = 'comment';
      } else {
        const origin = item.group.change.originCommentId
          ? comments.find((comment) => comment.id === item.group.change.originCommentId)
          : null;
        const isClaude =
          origin?.kind === 'claude' ||
          Boolean(item.group.change.originChatMessageId) ||
          item.group.change.authorID.toLowerCase() === 'claude';
        annotationKind = isClaude ? 'claude' : 'note';
        targetKind = 'suggestion';
      }
      return [
        {
          cardId: item.cardId,
          targetKind,
          annotationKind,
          anchorTop,
          viewportY: anchorTop - scrollTop,
          documentOrder,
        },
      ];
    });
  }, [anchorTops, comments, hidden, openItems, scrollTop, showResolved]);

  // Document scrolling updates focus to the nearest line-aligned annotation.
  // The panel movement itself is handled separately so focus can keep tracking
  // while a recent user panel-scroll temporarily suppresses auto-nudging.
  useEffect(() => {
    if (hidden || showResolved || commentComposer || gutterTicks.length === 0) return;
    if (lastActiveSyncScrollTopRef.current === scrollTop) return;
    lastActiveSyncScrollTopRef.current = scrollTop;
    if (
      performance.now() - lastDocumentScrollIntentAtRef.current >
      DOCUMENT_SCROLL_INTENT_WINDOW_MS
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const nearest = nearestGutterTick(gutterTicks, scrollTop + viewportHeight / 2);
      if (!nearest) return;
      const alreadyActive =
        nearest.targetKind === 'comment'
          ? activeCommentIdRef.current === nearest.cardId
          : activeSuggestionIdRef.current === nearest.cardId;
      if (!alreadyActive) onSyncActivate(nearest.targetKind, nearest.cardId);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    commentComposer,
    gutterTicks,
    hidden,
    layoutRevision,
    onSyncActivate,
    scrollTop,
    showResolved,
    viewportHeight,
  ]);

  const handleGutterActivate = useCallback(
    (tick: GutterTickInput) => {
      onSyncActivate(tick.targetKind, tick.cardId);
      const scrollArea = editorRef.current?.view.dom.closest('.editor-scroll-area');
      if (scrollArea) {
        scrollArea.scrollTo({
          top: Math.max(0, tick.anchorTop - scrollArea.clientHeight / 2),
          behavior: 'smooth',
        });
      }
      scrollPanelCard(tick.cardId, true);
    },
    [onSyncActivate, scrollPanelCard],
  );

  const handleViewReplySuggestion = useCallback(
    (suggestionIds: string[]) => {
      if (!showResolved) {
        onViewReplySuggestion(suggestionIds);
        return;
      }
      onShowResolvedChange(false);
      cancelAnimationFrame(viewSuggestionRafRef.current);
      viewSuggestionRafRef.current = requestAnimationFrame(() => {
        viewSuggestionRafRef.current = requestAnimationFrame(() => {
          onViewReplySuggestion(suggestionIds);
        });
      });
    },
    [onShowResolvedChange, onViewReplySuggestion, showResolved],
  );

  const markPanelUserIntent = useCallback(() => {
    panelUserSuppressedUntilRef.current = performance.now() + PANEL_USER_SCROLL_SUPPRESSION_MS;
  }, []);

  const handlePanelScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const panel = event.currentTarget;
    panel.dataset.scrolling = 'true';
    if (panelScrollTimerRef.current !== null) window.clearTimeout(panelScrollTimerRef.current);
    panelScrollTimerRef.current = window.setTimeout(() => {
      delete panel.dataset.scrolling;
      panelScrollTimerRef.current = null;
    }, 700);
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(viewSuggestionRafRef.current);
      if (panelScrollTimerRef.current !== null) window.clearTimeout(panelScrollTimerRef.current);
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const renderComment = (comment: Comment, resolved: boolean) => (
    <CommentCard
      key={comment.id}
      comment={comment}
      isActive={comment.id === activeCommentId}
      onReply={onReply}
      onAIReplyRequest={onAIReplyRequest}
      onCancelAIReply={onCancelAIReply}
      onRetryAIReply={onRetryAIReply}
      onDismissAIReply={onDismissAIReply}
      onViewReplySuggestion={handleViewReplySuggestion}
      pendingSuggestionIds={pendingSuggestionIds}
      onOpenSessionPicker={onOpenSessionPicker}
      onResolve={onResolve}
      onUnresolve={onUnresolve}
      onDelete={onDelete}
      onPromoteNote={onPromoteNote}
      onClick={resolved ? onActivateHistory : onActivate}
    />
  );

  const renderSuggestion = (group: SuggestionGroup) => {
    const originId = group.change.originCommentId;
    const originComment = originId
      ? (comments.find((comment) => comment.id === originId) ?? null)
      : null;
    const originChatMessageId = group.change.originChatMessageId;
    const originActive = originComment !== null && originComment.id === activeCommentId;
    if (group.kind === 'replacement') {
      return (
        <ReplacementCard
          key={group.cardId}
          change={group.change}
          deletions={group.deletions}
          insertions={group.insertions}
          isActive={activeSuggestionId === group.cardId}
          originComment={originComment}
          originChatMessageId={originChatMessageId}
          originActive={originActive}
          top={0}
          onAccept={onAcceptChange}
          onReject={onRejectChange}
          onClick={onActivateSuggestion}
          onActivateComment={activateOriginComment}
          onActivateChatMessage={onActivateChatMessage}
        />
      );
    }
    if (group.kind === 'format') {
      return (
        <FormattingCard
          key={group.change.id}
          change={group.change}
          segments={group.segments}
          isActive={group.change.id === activeSuggestionId}
          originComment={originComment}
          originChatMessageId={originChatMessageId}
          originActive={originActive}
          top={0}
          onAccept={onAcceptChange}
          onReject={onRejectChange}
          onClick={onActivateSuggestion}
          onActivateComment={activateOriginComment}
          onActivateChatMessage={onActivateChatMessage}
        />
      );
    }
    return (
      <SuggestionCard
        key={group.change.id}
        change={group.change}
        operation={group.operation}
        segments={group.segments}
        isActive={group.change.id === activeSuggestionId}
        originComment={originComment}
        originChatMessageId={originChatMessageId}
        originActive={originActive}
        top={0}
        onAccept={onAcceptChange}
        onReject={onRejectChange}
        onClick={onActivateSuggestion}
        onActivateComment={activateOriginComment}
        onActivateChatMessage={onActivateChatMessage}
      />
    );
  };

  const listIsEmpty = showResolved ? resolvedComments.length === 0 : openItems.length === 0;

  return (
    <section
      className="comments-view panel-view"
      hidden={hidden}
      aria-label="Comments and suggestions"
    >
      <AnnotationGutter
        ticks={gutterTicks}
        viewportHeight={viewportHeight}
        activeCardId={activePanelCardId}
        hidden={showResolved}
        onActivate={handleGutterActivate}
      />

      <div
        ref={panelListRef}
        className={`comment-panel-list${showResolved ? ' comment-history-list' : ''}`}
        onScroll={handlePanelScroll}
        onWheel={markPanelUserIntent}
        onPointerDown={markPanelUserIntent}
        onTouchStart={markPanelUserIntent}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
            markPanelUserIntent();
          }
        }}
        tabIndex={0}
      >
        {listIsEmpty && (
          <div className="comments-empty-state">
            <span className="comments-empty-quote" aria-hidden>
              ”
            </span>
            <strong>{showResolved ? 'No resolved comments' : 'No comments yet'}</strong>
            {!showResolved && (
              <p>
                Select text and press <b>+</b> to add a note or ask Claude.
              </p>
            )}
          </div>
        )}

        {showResolved
          ? resolvedComments.map((comment) => renderComment(comment, true))
          : openItems.map((item) => {
              if (item.type === 'comment') return renderComment(item.comment, false);
              if (item.type === 'suggestion') return renderSuggestion(item.group);
              return (
                <CommentComposerCard
                  key={item.cardId}
                  quote={item.selection.text}
                  top={0}
                  hasSession={hasSession}
                  onSubmit={onSubmitComment}
                  onCancel={onCancelComment}
                />
              );
            })}
      </div>

      {/* MAZ OVERRIDE (2026-07-12): Quill supports anchored comments only.
          Design Q4's unwired general-comment field is intentionally omitted. */}
    </section>
  );
}
