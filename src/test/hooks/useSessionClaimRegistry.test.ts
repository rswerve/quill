import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionClaimRegistry } from '../../hooks/useSessionClaimRegistry';
import type { SessionClaimResult } from '../../hooks/useSessionClaimRegistry';

describe('useSessionClaimRegistry', () => {
  it('grants a session to the first tab that claims it', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    let claim: SessionClaimResult | undefined;
    act(() => {
      claim = result.current.claim('tab-a', 's1');
    });
    expect(claim).toEqual({ allowed: true });
    expect(result.current.getOwnerTabId('s1')).toBe('tab-a');
  });

  // Conflict rejection: a second tab claiming a session another tab owns is
  // refused and told WHO owns it — and the existing claim must NOT move. Delete
  // the `ownerId && ownerId !== tabId` guard in the hook and this claim would be
  // granted, silently stealing the session; this test guards exactly that.
  it('rejects a session already owned by another tab and leaves it put', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      result.current.claim('tab-a', 's1');
    });
    const before = result.current.revision;
    let conflict: SessionClaimResult | undefined;
    act(() => {
      conflict = result.current.claim('tab-b', 's1');
    });
    expect(conflict).toEqual({ allowed: false, ownerTabId: 'tab-a' });
    // The rejected claim changed nothing — ownership held, and no revision bump
    // (a rejected conflict must not force a re-render). Drop the early return in
    // the hook and the claim falls through, stealing s1 AND bumping; this pins
    // both halves.
    expect(result.current.getOwnerTabId('s1')).toBe('tab-a');
    expect(result.current.revision).toBe(before);
  });

  // One session per tab: when a tab claims a new session it drops its previous
  // one. Remove the "drop this tab's other claims" loop and the old session
  // stays owned forever, so a tab could hold two sessions; this test guards it.
  it('drops a tab’s previous session when it rebinds to a new one', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      result.current.claim('tab-a', 's1');
    });
    act(() => {
      result.current.claim('tab-a', 's2');
    });
    expect(result.current.getOwnerTabId('s2')).toBe('tab-a');
    // s1 is released — a different tab may now take it.
    expect(result.current.getOwnerTabId('s1')).toBeUndefined();
  });

  // Idempotence: a tab re-claiming the session it already holds succeeds without
  // churning the registry or bumping revision (nothing changed). If the hook
  // bumped unconditionally, every no-op re-claim would force a re-render; this
  // pins revision stability across an idempotent claim.
  it('treats a re-claim of the same session by the same tab as a no-op', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      result.current.claim('tab-a', 's1');
    });
    const before = result.current.revision;
    let again: SessionClaimResult | undefined;
    act(() => {
      again = result.current.claim('tab-a', 's1');
    });
    expect(again).toEqual({ allowed: true });
    expect(result.current.getOwnerTabId('s1')).toBe('tab-a');
    expect(result.current.revision).toBe(before);
  });

  // Release: closing a tab drops the session it held, and only that tab's claim —
  // another tab's session survives. Break the `ownerId !== tabId` continue and
  // releaseTab('tab-a') would wipe tab-b's session too; this test guards it.
  it('releases only the closing tab’s session', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      result.current.claim('tab-a', 's1');
      result.current.claim('tab-b', 's2');
    });
    act(() => {
      result.current.releaseTab('tab-a');
    });
    expect(result.current.getOwnerTabId('s1')).toBeUndefined();
    expect(result.current.getOwnerTabId('s2')).toBe('tab-b');
  });

  it('releasing a tab that owns nothing is a no-op and does not bump revision', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      result.current.claim('tab-a', 's1');
    });
    const before = result.current.revision;
    act(() => {
      result.current.releaseTab('tab-unknown');
    });
    expect(result.current.getOwnerTabId('s1')).toBe('tab-a');
    expect(result.current.revision).toBe(before);
  });

  // Hydration clear: workspace restore drops every claim and bumps revision so a
  // reader (the session picker) re-renders against the empty registry. Drop the
  // bump from clear() and the picker keeps showing stale owners after a restore.
  it('clear() empties every claim and bumps revision', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      result.current.claim('tab-a', 's1');
      result.current.claim('tab-b', 's2');
    });
    const before = result.current.revision;
    act(() => {
      result.current.clear();
    });
    expect(result.current.getOwnerTabId('s1')).toBeUndefined();
    expect(result.current.getOwnerTabId('s2')).toBeUndefined();
    expect(result.current.revision).toBe(before + 1);
  });

  it('clear() on an empty registry does not bump revision', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    const before = result.current.revision;
    act(() => {
      result.current.clear();
    });
    expect(result.current.revision).toBe(before);
  });

  // Immediate reads: ownership lives in a ref, not state, so a claim is visible
  // to getOwnerTabId in the SAME tick — before React commits the revision bump.
  // App's session-claim callbacks depend on this synchronous read. Back the
  // registry with useState instead of a ref and this in-tick read returns
  // undefined; this test guards the ref semantics.
  it('reflects a claim synchronously, before the revision re-render commits', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    act(() => {
      const claim = result.current.claim('tab-a', 's1');
      expect(claim.allowed).toBe(true);
      expect(result.current.getOwnerTabId('s1')).toBe('tab-a');
    });
  });

  it('bumps revision when a claim actually changes ownership', () => {
    const { result } = renderHook(() => useSessionClaimRegistry());
    const start = result.current.revision;
    act(() => {
      result.current.claim('tab-a', 's1');
    });
    expect(result.current.revision).toBe(start + 1);
    act(() => {
      result.current.releaseTab('tab-a');
    });
    expect(result.current.revision).toBe(start + 2);
  });
});
