import { useCallback, useRef, useState } from 'react';

/**
 * Cross-tab "one Claude session per open document" registry.
 *
 * Owns the invariant that a given Claude session id is linked to at most one
 * open tab at a time, and that a tab owns at most one session. Presentation-
 * independent by design: it speaks only in tab ids and session ids — the shell
 * (App) translates an owning tab id into a human title for its notices.
 *
 * `revision` bumps only when a mutation actually changes ownership — a rejected
 * claim, an idempotent re-claim, releasing a tab that owns nothing, or clearing
 * an already-empty registry are all no-ops that leave revision untouched — so a
 * component that reads ownership (e.g. the session picker) re-renders exactly
 * when claims move. `clear` (workspace hydration resets every claim) bumps when
 * it drops any claim, matching the pre-extraction hydration behavior.
 */
export interface SessionClaimResult {
  allowed: boolean;
  /** When `allowed` is false, the tab that already owns the session. */
  ownerTabId?: string;
}

export interface SessionClaimRegistry {
  /** Claim `sessionId` for `tabId`. Rejects if another tab owns it; otherwise
   *  grants it and drops any other session this tab held (one session per tab). */
  claim: (tabId: string, sessionId: string) => SessionClaimResult;
  /** Release every session owned by `tabId` (tab close). */
  releaseTab: (tabId: string) => void;
  /** Drop all claims (workspace hydration). */
  clear: () => void;
  getOwnerTabId: (sessionId: string) => string | undefined;
  revision: number;
}

export function useSessionClaimRegistry(): SessionClaimRegistry {
  // sessionId → owning tabId
  const claimsRef = useRef(new Map<string, string>());
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((current) => current + 1), []);

  const claim = useCallback(
    (tabId: string, sessionId: string): SessionClaimResult => {
      const ownerId = claimsRef.current.get(sessionId);
      if (ownerId && ownerId !== tabId) {
        return { allowed: false, ownerTabId: ownerId };
      }

      let changed = false;
      // A tab owns at most one session — drop this tab's other claims.
      for (const [held, holder] of claimsRef.current) {
        if (holder !== tabId || held === sessionId) continue;
        claimsRef.current.delete(held);
        changed = true;
      }
      if (ownerId !== tabId) {
        claimsRef.current.set(sessionId, tabId);
        changed = true;
      }
      if (changed) bump();
      return { allowed: true };
    },
    [bump],
  );

  const releaseTab = useCallback(
    (tabId: string) => {
      let changed = false;
      for (const [sessionId, ownerId] of claimsRef.current) {
        if (ownerId !== tabId) continue;
        claimsRef.current.delete(sessionId);
        changed = true;
      }
      if (changed) bump();
    },
    [bump],
  );

  const clear = useCallback(() => {
    const changed = claimsRef.current.size > 0;
    claimsRef.current.clear();
    if (changed) bump();
  }, [bump]);

  const getOwnerTabId = useCallback((sessionId: string) => claimsRef.current.get(sessionId), []);

  return { claim, releaseTab, clear, getOwnerTabId, revision };
}
