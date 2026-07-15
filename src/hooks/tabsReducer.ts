import type { TabMeta } from '../App';
import type { DocumentTabMetaSnapshot } from '../components/DocumentTab';

/**
 * The pure tab-registry state model, lifted out of App's hand-synced
 * tabs/activeTabId. It owns ONLY {tabs, activeTabId}; App keeps the session-claim
 * registry, chrome cache, imperative handles, and native side effects. Every
 * transition is behavior-preserving with the original App implementation.
 *
 * Invariants (enforced here, relied on by App): `tabs` is never empty, and
 * `activeTabId` always names a tab in `tabs`.
 */
export interface TabRegistryState {
  tabs: TabMeta[];
  activeTabId: string;
}

export type TabAction =
  // Restore an open set (from workspace/crash recovery). App separately clears
  // its registries/caches and sets chrome for the same tick.
  | { type: 'hydrate'; tabs: TabMeta[]; activeTabId: string }
  // No-op for an unknown id, and idempotent when already active (matches the
  // original setActiveTabId state-bail, avoiding a needless rerender).
  | { type: 'activate'; tabId: string }
  // Append a pre-created tab and make it active in one step (preserves the
  // original addNewTab/addOrFocusPath add-then-activate atomicity). ID creation
  // stays in App; the created tab is passed in.
  | { type: 'addTab'; tab: TabMeta }
  // Remove a tab; if it was the last, fall back to the passed-in fresh Untitled.
  // If the closed tab was active, the next active is the tab that slid into its
  // index (clamped), else the active id is unchanged.
  | { type: 'close'; tabId: string; fallbackTab: TabMeta }
  | { type: 'clearInitialFilePath'; tabId: string }
  | { type: 'clearInitialWorkspaceSnapshot'; tabId: string }
  | { type: 'applyMetaSnapshot'; tabId: string; snapshot: DocumentTabMetaSnapshot };

export function tabsReducer(state: TabRegistryState, action: TabAction): TabRegistryState {
  switch (action.type) {
    case 'hydrate':
      return { tabs: action.tabs, activeTabId: action.activeTabId };

    case 'activate':
      if (state.activeTabId === action.tabId) return state;
      if (!state.tabs.some((tab) => tab.id === action.tabId)) return state;
      return { ...state, activeTabId: action.tabId };

    case 'addTab':
      return { tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };

    case 'close': {
      const closingIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (closingIndex < 0) return state;
      let nextTabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      if (nextTabs.length === 0) nextTabs = [action.fallbackTab];
      const closingActive = state.activeTabId === action.tabId;
      const activeTabId = closingActive
        ? nextTabs[Math.min(closingIndex, nextTabs.length - 1)].id
        : state.activeTabId;
      return { tabs: nextTabs, activeTabId };
    }

    // The initial-* clears always publish a new tabs array (matching the
    // original unconditional setTabs on the one-shot async-load completion).
    case 'clearInitialFilePath':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, initialFilePath: null } : tab,
        ),
      };

    case 'clearInitialWorkspaceSnapshot':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, initialWorkspaceSnapshot: null } : tab,
        ),
      };

    case 'applyMetaSnapshot': {
      const { tabId, snapshot } = action;
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        // A file tab publishes its initial blank hook state before its async
        // load finishes. Keep the pending path/title until the real load lands.
        if ((tab.initialFilePath || tab.initialWorkspaceSnapshot) && snapshot.filePath === null) {
          return tab;
        }
        const next = {
          ...tab,
          filePath: snapshot.filePath,
          initialFilePath: null,
          title: snapshot.title,
          isDirty: snapshot.isDirty,
        };
        changed =
          changed ||
          next.filePath !== tab.filePath ||
          next.initialFilePath !== tab.initialFilePath ||
          next.title !== tab.title ||
          next.isDirty !== tab.isDirty;
        return next;
      });
      // Skip the publish entirely when nothing actually changed (matches the
      // original handleTabMetaChange's `if (!changed) return`).
      return changed ? { ...state, tabs } : state;
    }

    default:
      return state;
  }
}
