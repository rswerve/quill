import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommentLayer from '../../components/CommentLayer';
import type { Comment, TrackedChangeInfo } from '../../types';

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CommentLayer anchor fallbacks', () => {
  it('positions comment and suggestion ticks from document coordinates when marks are absent', async () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const scrollArea = document.createElement('div');
    scrollArea.className = 'editor-scroll-area';
    scrollArea.scrollTop = 30;
    Object.defineProperty(scrollArea, 'clientHeight', { value: 600 });
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue(rect(20));

    const editorDom = document.createElement('div');
    scrollArea.append(editorDom);
    document.body.append(scrollArea);
    const coordsAtPos = vi.fn((position: number) => ({
      top: 100 + position,
      bottom: 100 + position,
      left: 0,
      right: 0,
    }));
    const editor = {
      on: vi.fn(),
      off: vi.fn(),
      state: { doc: { content: { size: 100 } } },
      view: { dom: editorDom, coordsAtPos },
    } as unknown as Editor;

    const comment: Comment = {
      id: 'comment-without-mark',
      kind: 'note',
      from: 5,
      to: 9,
      anchorText: 'text',
      author: 'User',
      createdAt: '2026-07-29T12:00:00.000Z',
      resolved: false,
      replies: [],
    };
    const suggestion: TrackedChangeInfo = {
      id: 'suggestion-without-mark',
      authorID: 'Claude',
      status: 'pending',
      createdAt: 1,
      segments: [{ kind: 'insert', from: 40, to: 44, text: 'word' }],
    };

    render(
      <CommentLayer
        editor={editor}
        comments={[comment]}
        activeCommentId={null}
        activeSuggestionId={null}
        activeStructuralId={null}
        containerRef={{ current: document.createElement('div') }}
        trackedChanges={[suggestion]}
        structuralChanges={[]}
        structuralAttention={[]}
        commentComposer={null}
        scrollTop={30}
        zoom={1}
        layoutRevision={0}
        highlightActivationRevision={0}
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
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show note' })).toHaveStyle({ top: '85px' });
      expect(screen.getByRole('button', { name: 'Show Claude thread' })).toHaveStyle({
        top: '120px',
      });
    });
    expect(coordsAtPos).toHaveBeenCalledWith(comment.from);
    expect(coordsAtPos).toHaveBeenCalledWith(suggestion.segments[0].from);

    scrollArea.remove();
  });
});
