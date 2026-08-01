import { cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import CommentLayer from '../../components/CommentLayer';
import type { Comment } from '../../types';

/**
 * Activating the same card twice in quick succession must cancel the first
 * flash timer before starting the second. Without that, the earlier timer
 * still fires mid-flash and strips `annotation-card-flash` off a card that is
 * supposed to be lit, so the second activation shows no flash at all.
 *
 * The branch was reached only by whichever Chromium run happened to land two
 * activations inside 520 ms, which is why it kept moving the coverage gate on
 * unrelated commits.
 */

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const comment: Comment = {
  id: 'comment-1',
  kind: 'note',
  from: 5,
  to: 9,
  anchorText: 'text',
  author: 'User',
  createdAt: '2026-07-29T12:00:00.000Z',
  resolved: false,
  replies: [],
};

function makeEditor() {
  const editorDom = document.createElement('div');
  document.body.append(editorDom);
  return {
    on: vi.fn(),
    off: vi.fn(),
    state: { doc: { content: { size: 100 } } },
    view: {
      dom: editorDom,
      coordsAtPos: () => ({ top: 100, bottom: 100, left: 0, right: 0 }),
    },
  } as unknown as Editor;
}

function layer(highlightActivationRevision: number) {
  return (
    <CommentLayer
      editor={makeEditor()}
      comments={[comment]}
      activeCommentId={comment.id}
      activeSuggestionId={null}
      activeStructuralId={null}
      containerRef={{ current: document.createElement('div') }}
      trackedChanges={[]}
      structuralChanges={[]}
      structuralAttention={[]}
      commentComposer={null}
      scrollTop={0}
      zoom={1}
      layoutRevision={0}
      highlightActivationRevision={highlightActivationRevision}
      hidden={false}
      showResolved={false}
      onShowResolvedChange={vi.fn()}
      onReply={vi.fn()}
      onAIReplyRequest={vi.fn()}
      onCancelAIReply={vi.fn()}
      onRetryAIReply={vi.fn()}
      onDismissAIReply={vi.fn()}
      onViewReplySuggestion={vi.fn()}
      onOpenSessionPicker={vi.fn()}
      onResolve={vi.fn()}
      onUnresolve={() => true}
      onDelete={vi.fn()}
      onPromoteNote={vi.fn()}
      onActivate={vi.fn()}
      onActivateHistory={vi.fn()}
      onActivateSuggestion={vi.fn()}
      onSyncActivate={vi.fn()}
      onActivateChatMessage={vi.fn()}
      onAcceptChange={vi.fn()}
      onRejectChange={vi.fn()}
      onAcceptStructuralChange={vi.fn()}
      onRejectStructuralChange={vi.fn()}
      onActivateStructural={vi.fn()}
      onSubmitComment={vi.fn()}
      onCancelComment={vi.fn()}
      hasSession={false}
    />
  );
}

type TimeoutSpy = MockInstance<typeof window.setTimeout>;

/** Timer ids from the 520 ms flash timeout only, ignoring React's own timers. */
function flashTimerIds(spy: TimeoutSpy): number[] {
  return spy.mock.calls
    .map((call, index) => ({ delay: call[1], id: spy.mock.results[index]?.value }))
    .filter((entry) => entry.delay === 520)
    .map((entry) => entry.id as number);
}

describe('CommentLayer flash timer', () => {
  // jsdom implements no scrolling; the panel sync calls scrollTo before the
  // flash runs, so it has to exist for the effect to reach the timer at all.
  const originalScrollTo = Element.prototype.scrollTo;

  afterEach(() => {
    cleanup();
    Element.prototype.scrollTo = originalScrollTo;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cancels a running flash timer when the same card is re-activated', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    // Run the flash callback inline so the timer is armed synchronously.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Element.prototype.scrollTo = vi.fn();
    const setSpy = vi.spyOn(window, 'setTimeout');
    const clearSpy = vi.spyOn(window, 'clearTimeout');

    // Revision 0 matches the mounted baseline, so this is not a highlight.
    const { rerender } = render(layer(0));
    expect(flashTimerIds(setSpy)).toHaveLength(0);

    rerender(layer(1));
    const [firstTimer] = flashTimerIds(setSpy);
    expect(firstTimer).toBeDefined();
    expect(clearSpy).not.toHaveBeenCalledWith(firstTimer);

    // Second activation while the first timer is still pending.
    rerender(layer(2));

    expect(clearSpy).toHaveBeenCalledWith(firstTimer);
    expect(flashTimerIds(setSpy)).toHaveLength(2);
  });
});
