import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabRegistry } from '../../hooks/useTabRegistry';
import type { TabMeta, TabRegistryState } from '../../hooks/tabsReducer';

const tab = (id: string): TabMeta => ({
  id,
  title: 'Untitled',
  isDirty: false,
  filePath: null,
  initialFilePath: null,
  initialWorkspaceSnapshot: null,
  initialWorkspaceDirty: false,
  restoredFromWorkspace: false,
});

const init = (): TabRegistryState => ({ tabs: [tab('a')], activeTabId: 'a' });

describe('useTabRegistry', () => {
  it('renders the initial state', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    expect(result.current.tabs.map((t) => t.id)).toEqual(['a']);
    expect(result.current.activeTabId).toBe('a');
  });

  it('commit returns the next state', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    let returned: TabRegistryState | undefined;
    act(() => {
      returned = result.current.commit({ type: 'addTab', tab: tab('b') });
    });
    expect(returned?.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(returned?.activeTabId).toBe('b');
  });

  // THE contract the sync-commit pattern exists for: two commits in the same
  // tick must compose. The second reduces off the first's result via the
  // private stateRef, NOT the state React last rendered. Deleting
  // `stateRef.current = next` in the hook makes the second commit start from the
  // stale rendered state and drop the first tab — this test guards exactly that.
  it('composes two commits in a single tick', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    let afterSecond: TabRegistryState | undefined;
    act(() => {
      result.current.commit({ type: 'addTab', tab: tab('b') });
      afterSecond = result.current.commit({ type: 'addTab', tab: tab('c') });
    });
    // The second commit's own return value already reflects the first.
    expect(afterSecond?.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    // ...and the rendered state matches after the tick settles.
    expect(result.current.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.activeTabId).toBe('c');
  });

  it('composes a close that reads the just-added tab in the same tick', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    let afterClose: TabRegistryState | undefined;
    act(() => {
      result.current.commit({ type: 'addTab', tab: tab('b') }); // -> [a, b], active b
      // Close the ORIGINAL tab. Off the fresh [a, b] this leaves [b] (a survivor
      // remains). Off the stale rendered [a] it would instead empty the set and
      // mint the fallback — so asserting [b] pins that close reduced off [a, b],
      // not [a]. (Closing the just-added 'b' would no-op on the stale [a] and
      // pass by accident; closing 'a' does not.)
      afterClose = result.current.commit({
        type: 'close',
        tabId: 'a',
        fallbackTab: null, // survivors remain -> no fallback needed
      });
    });
    expect(afterClose?.tabs.map((t) => t.id)).toEqual(['b']);
    expect(afterClose?.activeTabId).toBe('b');
    expect(result.current.tabs.map((t) => t.id)).toEqual(['b']);
    expect(result.current.activeTabId).toBe('b');
  });

  it('keeps a stable commit identity across renders', () => {
    const { result, rerender } = renderHook(() => useTabRegistry(init));
    const first = result.current.commit;
    act(() => {
      result.current.commit({ type: 'addTab', tab: tab('b') });
    });
    rerender();
    expect(result.current.commit).toBe(first);
  });
});
