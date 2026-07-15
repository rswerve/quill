import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAnnotationNavigation } from '../../hooks/useAnnotationNavigation';
import type { Comment, TrackedChangeInfo } from '../../types';

const change = (id: string, status: TrackedChangeInfo['status']): TrackedChangeInfo =>
  ({ id, authorID: 'user', status, createdAt: 0, segments: [] }) as TrackedChangeInfo;

function setup(over: { comments?: Comment[]; trackedChanges?: TrackedChangeInfo[] } = {}) {
  const setActiveAnnotation = vi.fn();
  const { result } = renderHook(() =>
    useAnnotationNavigation({
      // editor null: the DOM/scroll choreography is skipped (that path is
      // covered by the comment-anchoring / comment-history e2e); these tests
      // pin the active-state SEMANTICS, which run before the editor branch.
      editor: null,
      comments: over.comments ?? [],
      trackedChanges: over.trackedChanges ?? [],
      commentLayerRef: { current: null },
      setActiveAnnotation,
    }),
  );
  return { nav: result.current, setActiveAnnotation };
}

type Active = { kind: string; id: string } | null;
const applyUpdater = (mock: ReturnType<typeof vi.fn>, prev: Active): Active =>
  (mock.mock.calls[0][0] as (p: Active) => Active)(prev);

describe('useAnnotationNavigation — active-state semantics (the distinctions that must not merge)', () => {
  it('handleActivateComment TOGGLES the active comment off on re-click', () => {
    const { nav, setActiveAnnotation } = setup();
    nav.handleActivateComment('c1');
    expect(applyUpdater(setActiveAnnotation, { kind: 'comment', id: 'c1' })).toBeNull();
    expect(applyUpdater(setActiveAnnotation, null)).toEqual({ kind: 'comment', id: 'c1' });
    expect(applyUpdater(setActiveAnnotation, { kind: 'comment', id: 'other' })).toEqual({
      kind: 'comment',
      id: 'c1',
    });
    // A same-id but different-KIND active does not count as already-active.
    expect(applyUpdater(setActiveAnnotation, { kind: 'suggestion', id: 'c1' })).toEqual({
      kind: 'comment',
      id: 'c1',
    });
  });

  it('handleActivateSuggestion TOGGLES the active suggestion off on re-click', () => {
    const { nav, setActiveAnnotation } = setup();
    nav.handleActivateSuggestion('s1');
    expect(applyUpdater(setActiveAnnotation, { kind: 'suggestion', id: 's1' })).toBeNull();
    expect(applyUpdater(setActiveAnnotation, null)).toEqual({ kind: 'suggestion', id: 's1' });
  });

  it('handleViewReplySuggestion is a DIRECTED jump — a plain value, never a toggle', () => {
    const { nav, setActiveAnnotation } = setup({
      trackedChanges: [change('s-pending', 'pending')],
    });
    nav.handleViewReplySuggestion(['s-pending']);
    // A direct value (not an updater function) means it can never resolve to
    // null: a provenance jump always activates, even onto an already-active one.
    expect(setActiveAnnotation).toHaveBeenCalledWith({ kind: 'suggestion', id: 's-pending' });
    expect(typeof setActiveAnnotation.mock.calls[0][0]).not.toBe('function');
  });

  it('handleViewReplySuggestion advances to the FIRST still-pending linked change', () => {
    const { nav, setActiveAnnotation } = setup({
      trackedChanges: [change('s-accepted', 'accepted'), change('s-pending', 'pending')],
    });
    nav.handleViewReplySuggestion(['s-accepted', 's-pending']);
    expect(setActiveAnnotation).toHaveBeenCalledWith({ kind: 'suggestion', id: 's-pending' });
  });

  it('handleViewReplySuggestion is a no-op when no linked change is still pending', () => {
    const { nav, setActiveAnnotation } = setup({
      trackedChanges: [change('s1', 'accepted'), change('s2', 'rejected')],
    });
    nav.handleViewReplySuggestion(['s1', 's2']);
    expect(setActiveAnnotation).not.toHaveBeenCalled();
  });

  it('handleSyncActivate is idempotent — keeps the SAME reference when already active', () => {
    const { nav, setActiveAnnotation } = setup();
    nav.handleSyncActivate('comment', 'c1');
    const prev = { kind: 'comment', id: 'c1' } as Active;
    // Returns the identical previous object (no needless re-render churn)…
    expect(applyUpdater(setActiveAnnotation, prev)).toBe(prev);
    // …but activates when nothing / something else is active.
    expect(applyUpdater(setActiveAnnotation, null)).toEqual({ kind: 'comment', id: 'c1' });
    expect(applyUpdater(setActiveAnnotation, { kind: 'comment', id: 'other' })).toEqual({
      kind: 'comment',
      id: 'c1',
    });
  });
});
