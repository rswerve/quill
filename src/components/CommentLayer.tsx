import { useState, useEffect, useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/react';
import type { Comment, TrackedChangeInfo, TrackedFormatChange, TrackedTextChange } from '../types';
import CommentCard from './CommentCard';
import SuggestionCard from './SuggestionCard';
import ReplacementCard from './ReplacementCard';
import FormattingCard from './FormattingCard';
import CommentComposerCard from './CommentComposerCard';
import type { SelectionInfo } from './Editor';
import {
  layoutAnchoredCards,
  type AnchoredCardInput,
  type AnchoredPanelLayout,
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
  onReply: (commentId: string, text: string) => void;
  onAIReplyRequest: (commentId: string, userText: string) => void;
  onCancelAIReply: (replyId: string) => void;
  onRetryAIReply: (replyId: string) => void;
  onDismissAIReply: (commentId: string, replyId: string) => void;
  onViewReplySuggestion: (suggestionIds: string[]) => void;
  onOpenSessionPicker: () => void;
  onResolve: (commentId: string) => void;
  onUnresolve: (commentId: string) => void;
  onDelete: (commentId: string) => void;
  onActivate: (commentId: string) => void;
  onActivateSuggestion: (id: string) => void;
  onAcceptChange: (id: string) => void;
  onRejectChange: (id: string) => void;
  onSubmitComment: (text: string) => void;
  onCancelComment: () => void;
  /** Lowest card bottom in document space (`nudgedTop + measuredHeight`), so
   *  App can extend the scroll range to reach a below-fold card. 0 when empty. */
  onMaxCardBottomChange: (maxBottom: number) => void;
}

interface CardCatalogEntry extends AnchoredCardInput {
  type: 'comment' | 'suggestion' | 'composer';
}

const CARD_HEIGHT_ESTIMATE = 120;
const CARD_GAP = 12;
const PANEL_HEADER_HEIGHT = 44;
const PANEL_BOTTOM_CHROME_HEIGHT = 62;
const COMMENT_COMPOSER_CARD_ID = 'comment-composer';
const EMPTY_LAYOUT: AnchoredPanelLayout = { positions: [], above: [], below: [] };

/**
 * Extra scrollable height the document needs so the lowest comment/suggestion
 * card can be scrolled fully into view. Cards paint in the overflow-hidden
 * margin column at `nudgedTop − scrollTop`; when a card's bottom sits past the
 * document's own content, no scroll position reveals it. Returns 0 (never
 * negative) when every card already fits, so ordinary docs get no dead space.
 * Pure — exported for tests.
 */
export function computeBottomSpacer(
  maxCardBottom: number,
  baseContentHeight: number,
  margin: number,
): number {
  return Math.max(0, Math.round(maxCardBottom + margin - baseContentHeight));
}

// One margin card's worth of pending change(s): a lone insert or delete, or
// the two halves of a replacement, presented and resolved together. The
// replacement card is keyed and positioned by the shared pairId.
type SuggestionGroup =
  | { kind: 'single'; cardId: string; change: TrackedTextChange }
  | { kind: 'replacement'; cardId: string; del: TrackedTextChange; ins: TrackedTextChange }
  | { kind: 'format'; cardId: string; change: TrackedFormatChange };

function groupChanges(changes: TrackedChangeInfo[]): SuggestionGroup[] {
  const groups: SuggestionGroup[] = [];
  const byPair = new Map<string, TrackedTextChange[]>();
  for (const c of changes) {
    if (c.operation === 'format') {
      groups.push({ kind: 'format', cardId: c.id, change: c });
      continue;
    }
    if (c.pairId) {
      const list = byPair.get(c.pairId) ?? [];
      list.push(c);
      byPair.set(c.pairId, list);
    } else {
      groups.push({ kind: 'single', cardId: c.id, change: c });
    }
  }
  for (const members of byPair.values()) {
    const del = members.find((c) => c.operation === 'delete');
    const ins = members.find((c) => c.operation === 'insert');
    // One card only when both halves are present: a dangling pairId (its other
    // half never got a mark, or was already resolved) renders alone.
    if (del && ins && members.length === 2) {
      groups.push({ kind: 'replacement', cardId: del.pairId!, del, ins });
    } else {
      for (const c of members) groups.push({ kind: 'single', cardId: c.id, change: c });
    }
  }
  return groups;
}

// Top of an annotation's in-text highlight, in scroll-area coordinates. Comments
// and tracked changes anchor identically — they differ only in the data
// attribute the highlight carries.
function getAnchorTopBy(editor: Editor, attr: 'data-comment-id' | 'data-change-id', id: string) {
  try {
    const dom = editor.view.dom;
    const el = dom.querySelector(`[${attr}="${id}"]`);
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
  onActivate,
  onActivateSuggestion,
  onAcceptChange,
  onRejectChange,
  onSubmitComment,
  onCancelComment,
  onMaxCardBottomChange,
}: CommentLayerProps) {
  const [panelLayout, setPanelLayout] = useState<AnchoredPanelLayout>(EMPTY_LAYOUT);
  const rafRef = useRef<number>(0);
  const [showResolved, setShowResolved] = useState(false);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const cardCatalogRef = useRef<Map<string, CardCatalogEntry>>(new Map());

  const visibleComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);
  const displayComments = showResolved ? comments : visibleComments;

  const suggestionGroups = groupChanges(trackedChanges.filter((c) => c.status === 'pending'));
  const pendingSuggestionIds = new Set(
    trackedChanges.filter((change) => change.status === 'pending').map((change) => change.id),
  );

  // A provenance chip is a directed jump, not a toggle: clicking it while its
  // comment is already active must not deactivate the target. Resolved origin
  // comments are still valid provenance, so reveal them before activating.
  const activateOriginComment = useCallback(
    (commentId: string) => {
      const origin = comments.find((comment) => comment.id === commentId);
      if (origin?.resolved) setShowResolved(true);
      if (activeCommentId !== commentId) onActivate(commentId);
    },
    [activeCommentId, comments, onActivate],
  );

  // Stable refs so reflow's identity doesn't change on every render
  // (which would otherwise re-run the editor.on effect → setState → loop).
  const editorRef = useRef(editor);
  const displayCommentsRef = useRef(displayComments);
  const suggestionGroupsRef = useRef(suggestionGroups);
  const commentComposerRef = useRef(commentComposer);
  const scrollTopRef = useRef(scrollTop);
  const activeCommentIdRef = useRef(activeCommentId);
  const activeSuggestionIdRef = useRef(activeSuggestionId);
  const onMaxCardBottomChangeRef = useRef(onMaxCardBottomChange);
  editorRef.current = editor;
  displayCommentsRef.current = displayComments;
  suggestionGroupsRef.current = suggestionGroups;
  commentComposerRef.current = commentComposer;
  scrollTopRef.current = scrollTop;
  activeCommentIdRef.current = activeCommentId;
  activeSuggestionIdRef.current = activeSuggestionId;
  onMaxCardBottomChangeRef.current = onMaxCardBottomChange;

  const reflow = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;

    // A composer can be replaced by a comment card without changing the
    // number of positioned children. Read every live card before laying out
    // so that swap (and first paint) never uses the generic height estimate;
    // ResizeObserver continues to cover later reply/streaming growth.
    containerRef.current?.querySelectorAll<HTMLElement>('[data-card-id]').forEach((element) => {
      const id = element.dataset.cardId;
      if (id) heightsRef.current.set(id, element.getBoundingClientRect().height);
    });

    const catalog: CardCatalogEntry[] = [];
    let documentOrder = 0;

    for (const comment of displayCommentsRef.current) {
      const top = getAnchorTop(ed, comment.id) ?? getDocumentPositionTop(ed, comment.from);
      catalog.push({
        cardId: comment.id,
        type: 'comment',
        anchorTop: top ?? comment.from * 0.5,
        height: heightsRef.current.get(comment.id) ?? CARD_HEIGHT_ESTIMATE,
        documentOrder: documentOrder++,
      });
    }

    for (const group of suggestionGroupsRef.current) {
      // A replacement is anchored by its delete half — the original text's
      // location, where the eye lands first.
      const anchor = group.kind === 'replacement' ? group.del : group.change;
      const fallbackFrom =
        anchor.operation === 'format' ? (anchor.segments[0]?.from ?? 0) : anchor.from;
      const top = getChangeAnchorTop(ed, anchor.id) ?? getDocumentPositionTop(ed, fallbackFrom);
      catalog.push({
        cardId: group.cardId,
        type: 'suggestion',
        anchorTop: top ?? fallbackFrom * 0.5,
        height: heightsRef.current.get(group.cardId) ?? CARD_HEIGHT_ESTIMATE,
        documentOrder: documentOrder++,
      });
    }

    const composer = commentComposerRef.current;
    if (composer) {
      const top = getDocumentPositionTop(ed, composer.from);
      catalog.push({
        cardId: COMMENT_COMPOSER_CARD_ID,
        type: 'composer',
        anchorTop: top ?? composer.from * 0.5,
        height: heightsRef.current.get(COMMENT_COMPOSER_CARD_ID) ?? 208,
        documentOrder: documentOrder++,
      });
    }

    cardCatalogRef.current = new Map(catalog.map((entry) => [entry.cardId, entry]));
    const liveIds = new Set(catalog.map((entry) => entry.cardId));
    for (const id of heightsRef.current.keys()) {
      if (!liveIds.has(id)) heightsRef.current.delete(id);
    }

    const groups = suggestionGroupsRef.current;
    const activeSuggestionId = activeSuggestionIdRef.current;
    const activeSuggestionCard = activeSuggestionId
      ? groups.find(
          (group) =>
            group.cardId === activeSuggestionId ||
            (group.kind === 'replacement' &&
              (group.del.id === activeSuggestionId || group.ins.id === activeSuggestionId)),
        )?.cardId
      : null;
    const activeCardId = composer
      ? COMMENT_COMPOSER_CARD_ID
      : (activeCommentIdRef.current ?? activeSuggestionCard ?? null);

    const fullLayout = layoutAnchoredCards(catalog, {
      viewportTop: Number.NEGATIVE_INFINITY,
      viewportBottom: Number.POSITIVE_INFINITY,
      activeCardId,
      gap: CARD_GAP,
    });

    // Lowest card bottom in document space — what App needs to size the bottom
    // spacer so a below-fold card can be scrolled into view. Both positioned
    // tops and measured heights are scroll-independent, so reporting this can't
    // feed a scroll→reflow loop.
    const maxBottom = fullLayout.positions.reduce(
      (maximum, position) => Math.max(maximum, position.top + position.height),
      0,
    );
    onMaxCardBottomChangeRef.current(maxBottom);

    const panelHeight = containerRef.current?.clientHeight ?? 0;
    const viewportTop = scrollTopRef.current;
    const viewportBottom =
      panelHeight > PANEL_HEADER_HEIGHT + PANEL_BOTTOM_CHROME_HEIGHT
        ? scrollTopRef.current + panelHeight
        : Number.POSITIVE_INFINITY;
    const next = layoutAnchoredCards(catalog, {
      viewportTop,
      viewportBottom,
      cardViewportTop: scrollTopRef.current + PANEL_HEADER_HEIGHT,
      cardViewportBottom:
        panelHeight > PANEL_HEADER_HEIGHT + PANEL_BOTTOM_CHROME_HEIGHT
          ? scrollTopRef.current + panelHeight - PANEL_BOTTOM_CHROME_HEIGHT
          : Number.POSITIVE_INFINITY,
      activeCardId,
      gap: CARD_GAP,
    });

    setPanelLayout((previous) => {
      const samePositions =
        previous.positions.length === next.positions.length &&
        previous.positions.every(
          (position, index) =>
            position.cardId === next.positions[index].cardId &&
            position.top === next.positions[index].top &&
            position.height === next.positions[index].height,
        );
      const sameAbove =
        previous.above.length === next.above.length &&
        previous.above.every((id, index) => id === next.above[index]);
      const sameBelow =
        previous.below.length === next.below.length &&
        previous.below.every((id, index) => id === next.below[index]);
      return samePositions && sameAbove && sameBelow ? previous : next;
    });
  }, [containerRef]);

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const observer = new ResizeObserver(() => {
      const cards = containerEl.querySelectorAll<HTMLElement>('[data-card-id]');
      let changed = false;
      cards.forEach((el) => {
        const id = el.dataset.cardId;
        if (!id) return;
        const h = el.getBoundingClientRect().height;
        if (heightsRef.current.get(id) !== h) {
          heightsRef.current.set(id, h);
          changed = true;
        }
      });
      if (changed) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(reflow);
      }
    });
    observer.observe(containerEl);
    const cards = containerEl.querySelectorAll<HTMLElement>('[data-card-id]');
    cards.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [
    containerRef,
    reflow,
    panelLayout.positions.length,
    comments,
    trackedChanges,
    commentComposer,
  ]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(reflow);
    };
    editor.on('update', onUpdate);
    editor.on('selectionUpdate', onUpdate);
    reflow();
    return () => {
      editor.off('update', onUpdate);
      editor.off('selectionUpdate', onUpdate);
      cancelAnimationFrame(rafRef.current);
    };
  }, [editor, reflow]);

  // `zoom` is an invalidation signal: changing inherited document font-size
  // reflows lines and moves anchor rects. No numeric scale compensation is
  // needed, but cards must be measured again after that reflow.
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(reflow);
  }, [
    comments,
    trackedChanges,
    commentComposer,
    showResolved,
    zoom,
    scrollTop,
    activeCommentId,
    activeSuggestionId,
    reflow,
  ]);

  // The comment column has no scrollbar of its own — cards are translated by
  // the editor's scrollTop. So a wheel gesture over the column would otherwise
  // do nothing; forward it to the editor's scroll area so the document (and
  // the cards with it) scroll as expected.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const scrollArea = editorRef.current?.view.dom.closest('.editor-scroll-area');
    if (scrollArea) scrollArea.scrollTop += e.deltaY;
  }, []);

  const revealPinnedCard = useCallback(
    (cardId: string) => {
      const entry = cardCatalogRef.current.get(cardId);
      const scrollArea = editorRef.current?.view.dom.closest('.editor-scroll-area');
      if (!entry || !scrollArea) return;
      scrollArea.scrollTo({
        top: Math.max(0, entry.anchorTop - PANEL_HEADER_HEIGHT - CARD_GAP),
        behavior: 'smooth',
      });
      if (entry.type === 'comment') {
        if (activeCommentId !== cardId) onActivate(cardId);
      } else if (entry.type === 'suggestion' && activeSuggestionId !== cardId) {
        onActivateSuggestion(cardId);
      }
    },
    [activeCommentId, activeSuggestionId, onActivate, onActivateSuggestion],
  );

  const positionById = new Map(
    panelLayout.positions.map((position) => [position.cardId, position]),
  );
  const activeSuggestionCardId = activeSuggestionId
    ? suggestionGroups.find(
        (group) =>
          group.cardId === activeSuggestionId ||
          (group.kind === 'replacement' &&
            (group.del.id === activeSuggestionId || group.ins.id === activeSuggestionId)),
      )?.cardId
    : null;
  const activePanelCardId = commentComposer
    ? COMMENT_COMPOSER_CARD_ID
    : (activeCommentId ?? activeSuggestionCardId ?? null);
  const activePosition = activePanelCardId ? positionById.get(activePanelCardId) : null;
  const openCardCount = visibleComments.length + suggestionGroups.length;

  return (
    <div
      className="comment-layer comments"
      ref={containerRef as React.RefObject<HTMLDivElement>}
      onWheel={handleWheel}
    >
      <header className="comments-head">
        <h3>Comments</h3>
        <span className="count-pill">{openCardCount}</span>
        <span className="grow" />
        <button
          className="filter"
          onClick={() => setShowResolved((value) => !value)}
          disabled={resolvedComments.length === 0}
          title={
            resolvedComments.length ? 'Show or hide resolved comments' : 'No resolved comments'
          }
        >
          {showResolved ? 'All' : 'Open'}
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4 6.5 8 10.5 12 6.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      {panelLayout.above.length > 0 && (
        <button
          className="offscreen-pill offscreen-pill-above"
          onClick={() => revealPinnedCard(panelLayout.above.at(-1)!)}
        >
          ▲ {panelLayout.above.length} above
        </button>
      )}
      {panelLayout.below.length > 0 && (
        <button
          className="offscreen-pill offscreen-pill-below"
          onClick={() => revealPinnedCard(panelLayout.below[0])}
        >
          ▼ {panelLayout.below.length} below
        </button>
      )}

      {activePosition && (
        <span
          className="annotation-connector"
          style={{ top: activePosition.top - scrollTop }}
          aria-hidden
        />
      )}

      {comments.length === 0 && suggestionGroups.length === 0 && !commentComposer && (
        <div className="comments-empty-state">
          <span className="comments-empty-quote" aria-hidden>
            ”
          </span>
          <strong>No comments yet</strong>
          <p>
            Select text and press <b>+</b>, or type <code>@claude</code>.
          </p>
        </div>
      )}

      {/* Cards are positioned in document space (anchor offset + scrollTop), so
          translating this wrapper by -scrollTop makes the comment column scroll
          in lockstep with the editor — like Google Docs. */}
      <div className="comment-layer-scroll" style={{ transform: `translateY(${-scrollTop}px)` }}>
        {commentComposer && positionById.has(COMMENT_COMPOSER_CARD_ID) && (
          <CommentComposerCard
            quote={commentComposer.text}
            top={positionById.get(COMMENT_COMPOSER_CARD_ID)!.top}
            onSubmit={onSubmitComment}
            onCancel={onCancelComment}
          />
        )}

        {displayComments.map((comment) => {
          const position = positionById.get(comment.id);
          if (!position) return null;
          return (
            <CommentCard
              key={comment.id}
              comment={comment}
              isActive={comment.id === activeCommentId}
              top={position.top}
              onReply={onReply}
              onAIReplyRequest={onAIReplyRequest}
              onCancelAIReply={onCancelAIReply}
              onRetryAIReply={onRetryAIReply}
              onDismissAIReply={onDismissAIReply}
              onViewReplySuggestion={onViewReplySuggestion}
              pendingSuggestionIds={pendingSuggestionIds}
              onOpenSessionPicker={onOpenSessionPicker}
              onResolve={onResolve}
              onUnresolve={onUnresolve}
              onDelete={onDelete}
              onClick={onActivate}
            />
          );
        })}

        {suggestionGroups.map((group) => {
          const position = positionById.get(group.cardId);
          if (!position) return null;
          // Provenance link: the change's origin comment, only while it still
          // exists (a deleted comment degrades to no chip and no outline).
          const originId =
            group.kind === 'replacement'
              ? (group.del.originCommentId ?? group.ins.originCommentId)
              : group.change.originCommentId;
          const originComment = originId ? (comments.find((c) => c.id === originId) ?? null) : null;
          const originActive = originComment !== null && originComment.id === activeCommentId;
          if (group.kind === 'replacement') {
            const { del, ins } = group;
            return (
              <ReplacementCard
                key={group.cardId}
                del={del}
                ins={ins}
                isActive={
                  activeSuggestionId === group.cardId ||
                  activeSuggestionId === del.id ||
                  activeSuggestionId === ins.id
                }
                originComment={originComment}
                originActive={originActive}
                top={position.top}
                onAccept={onAcceptChange}
                onReject={onRejectChange}
                onClick={onActivateSuggestion}
                onActivateComment={activateOriginComment}
              />
            );
          }
          if (group.kind === 'format') {
            const change = group.change;
            return (
              <FormattingCard
                key={change.id}
                change={change}
                isActive={change.id === activeSuggestionId}
                originComment={originComment}
                originActive={originActive}
                top={position.top}
                onAccept={onAcceptChange}
                onReject={onRejectChange}
                onClick={onActivateSuggestion}
                onActivateComment={activateOriginComment}
              />
            );
          }
          const change = group.change;
          return (
            <SuggestionCard
              key={change.id}
              change={change}
              isActive={change.id === activeSuggestionId}
              originComment={originComment}
              originActive={originActive}
              top={position.top}
              onAccept={onAcceptChange}
              onReject={onRejectChange}
              onClick={onActivateSuggestion}
              onActivateComment={activateOriginComment}
            />
          );
        })}
      </div>

      <div className="comments-compose-chrome">
        <div className="new-comment general-comment-field">General comment — no selection</div>
      </div>
    </div>
  );
}
