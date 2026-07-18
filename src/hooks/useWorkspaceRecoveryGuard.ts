import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { WorkspaceRecoveryOutcome } from '../components/DocumentTab';

/**
 * Holds workspace persistence SUSPENDED across a hydration that restores snapshot-bearing tabs,
 * so a corrupt lossless snapshot can never be overwritten by the immediate post-recovery write
 * before it is preserved. Any hydration with snapshots begins suspended — Recover, clean
 * auto-load, or Discard — because an untrusted but envelope-valid workspace can carry a
 * malformed docJSON in a clean Untitled tab too.
 *
 * Flow: `begin(expectedIds)` sets suspension SYNCHRONOUSLY (a ref, so the write gate can't race
 * a re-render) before the tabs mount; each tab reports via `report`; once all expected tabs are
 * in, the guard resumes if every outcome is clean, or stays suspended and flags `degraded` so
 * the shell can require preservation. After the original is quarantined, `resumeAfterPreservation`
 * releases the hold. No snapshot-bearing tabs → no guard.
 */
export interface WorkspaceRecoveryGuard {
  /** True while snapshot-bearing tabs are still reporting, or a degraded one awaits preservation. */
  suspended: boolean;
  /** Synchronous mirror of `suspended` — the write gate reads this so it can't race a re-render. */
  suspendedRef: RefObject<boolean>;
  /** True when a degraded tab is holding suspension pending an explicit Preserve & Continue. */
  degraded: boolean;
  /** Begin guarding a hydration. Suspends synchronously before the tabs mount. Empty ids → no-op. */
  begin: (expectedTabIds: string[]) => void;
  /** A snapshot-bearing tab reported how it recovered. */
  report: (tabId: string, outcome: WorkspaceRecoveryOutcome) => void;
  /**
   * Preserve the corrupt original, then resume — atomically owned here so resumption can NEVER
   * happen without a successful quarantine. Runs `quarantine`; on a truthy result the hold is
   * released and it returns true; on a falsy result nothing changes (stays suspended + degraded)
   * and it returns false so the caller can surface the failure.
   */
  preserve: (quarantine: () => Promise<string | null>) => Promise<boolean>;
}

export function useWorkspaceRecoveryGuard(): WorkspaceRecoveryGuard {
  const [suspended, setSuspended] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const suspendedRef = useRef(false);
  const accRef = useRef<{
    expected: Set<string>;
    outcomes: Map<string, WorkspaceRecoveryOutcome>;
  } | null>(null);

  const setBoth = useCallback((value: boolean) => {
    suspendedRef.current = value;
    setSuspended(value);
  }, []);

  const finalize = useCallback(() => {
    const acc = accRef.current;
    if (!acc) return;
    accRef.current = null;
    if ([...acc.outcomes.values()].includes('degraded')) {
      setDegraded(true); // stays suspended until preservation
    } else {
      setBoth(false);
    }
  }, [setBoth]);

  const begin = useCallback(
    (expectedTabIds: string[]) => {
      if (expectedTabIds.length === 0) {
        accRef.current = null;
        return; // nothing carries a snapshot → no guard needed
      }
      accRef.current = { expected: new Set(expectedTabIds), outcomes: new Map() };
      setBoth(true); // synchronous ref set BEFORE hydration mounts the tabs
    },
    [setBoth],
  );

  const report = useCallback(
    (tabId: string, outcome: WorkspaceRecoveryOutcome) => {
      const acc = accRef.current;
      if (!acc || !acc.expected.has(tabId)) return;
      acc.outcomes.set(tabId, outcome);
      if (acc.outcomes.size === acc.expected.size) finalize();
    },
    [finalize],
  );

  const preserve = useCallback(
    async (quarantine: () => Promise<string | null>): Promise<boolean> => {
      const preserved = await quarantine();
      if (!preserved) return false; // preservation failed → stay suspended + degraded, retryable
      setDegraded(false);
      setBoth(false);
      return true;
    },
    [setBoth],
  );

  return { suspended, suspendedRef, degraded, begin, report, preserve };
}
