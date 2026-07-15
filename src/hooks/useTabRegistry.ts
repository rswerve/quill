import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { tabsReducer, type TabAction, type TabRegistryState } from './tabsReducer';

export interface TabRegistry {
  /** Rendered tabs — read these in JSX. */
  tabs: TabRegistryState['tabs'];
  /** Rendered active id — read this in JSX. */
  activeTabId: string;
  /**
   * Same-tick views of the state, for the many App callbacks that read the
   * current tabs/active id synchronously (outside render). `commit` refreshes
   * both BEFORE calling setState, so a read immediately after a commit — or a
   * second commit in the same tick — sees the just-applied value, never the
   * value React last rendered.
   */
  tabsRef: MutableRefObject<TabRegistryState['tabs']>;
  activeTabIdRef: MutableRefObject<string>;
  /**
   * Apply one transition. Returns the next state so callers can read the fresh
   * tabs synchronously (e.g. to pick the tab that slid into a closed slot).
   */
  commit: (action: TabAction) => TabRegistryState;
}

/**
 * Owns the pure {tabs, activeTabId} model (see `tabsReducer`) plus the
 * same-tick refs App relies on. This is the ONLY writer of tab-registry state;
 * App keeps every side effect (chrome cache, session claims, imperative
 * handles, native menu) around the `commit` calls.
 *
 * The sync-commit pattern — advance `stateRef` and the exposed refs before
 * `setState` — is what lets the old dual-write sites (`tabsRef.current = next;
 * setTabs(next)`) collapse to a single `commit(action)` without changing when
 * a synchronous reader observes the update.
 */
export function useTabRegistry(init: () => TabRegistryState): TabRegistry {
  const [state, setState] = useState<TabRegistryState>(init);

  // Kept current on every render so an external re-render (there are none today,
  // but the invariant is cheap) can't leave the refs pointing at a stale state.
  const stateRef = useRef(state);
  stateRef.current = state;
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  const activeTabIdRef = useRef(state.activeTabId);
  activeTabIdRef.current = state.activeTabId;

  const commit = useCallback((action: TabAction) => {
    const next = tabsReducer(stateRef.current, action);
    // Advance the synchronous views first: a same-tick reader (or the next
    // commit in this tick) must see `next`, not the last rendered state.
    stateRef.current = next;
    tabsRef.current = next.tabs;
    activeTabIdRef.current = next.activeTabId;
    setState(next);
    return next;
  }, []);

  return { tabs: state.tabs, activeTabId: state.activeTabId, tabsRef, activeTabIdRef, commit };
}
