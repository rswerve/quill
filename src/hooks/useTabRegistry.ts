import { useCallback, useRef, useState } from 'react';
import { tabsReducer, type TabAction, type TabRegistryState } from './tabsReducer';

export interface TabRegistry {
  /** Rendered tabs — read these in JSX. */
  tabs: TabRegistryState['tabs'];
  /** Rendered active id — read this in JSX. */
  activeTabId: string;
  /**
   * Apply one transition. Returns the next state so callers can (a) read the
   * fresh tabs synchronously — e.g. to pick the tab that slid into a closed
   * slot — and (b) mirror it into their own same-tick refs.
   */
  commit: (action: TabAction) => TabRegistryState;
}

/**
 * Owns the pure {tabs, activeTabId} model (see `tabsReducer`). This is the ONLY
 * writer of tab-registry state; App keeps every side effect (chrome cache,
 * session claims, imperative handles, native menu) around the `commit` calls.
 *
 * The sync-commit pattern lives here: `commit` advances a private `stateRef`
 * BEFORE calling setState, so a second commit in the same tick reduces off the
 * just-applied state rather than the value React last rendered. That is what
 * lets App's old dual-write sites (`tabsRef.current = next; setTabs(next)`)
 * collapse to a single `commit(action)`. App reads the current tabs through its
 * own refs, mirrored from `commit`'s return value — the hook deliberately does
 * not expose refs, so callers keep eslint-stable `useRef` identities.
 */
export function useTabRegistry(init: () => TabRegistryState): TabRegistry {
  const [state, setState] = useState<TabRegistryState>(init);

  // Kept current on every render so an external re-render (there are none today,
  // but the invariant is cheap) can't leave the composition source stale.
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((action: TabAction) => {
    const next = tabsReducer(stateRef.current, action);
    // Advance the composition source first: the next commit in this tick must
    // reduce off `next`, not the last rendered state.
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  return { tabs: state.tabs, activeTabId: state.activeTabId, commit };
}
