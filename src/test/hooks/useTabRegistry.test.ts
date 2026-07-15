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
    expect(result.current.tabsRef.current).toBe(result.current.tabs);
    expect(result.current.activeTabIdRef.current).toBe('a');
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

  it('advances the refs synchronously, before React re-renders', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    act(() => {
      const next = result.current.commit({ type: 'addTab', tab: tab('b') });
      // Same tick, inside act, before the commit's re-render is observable:
      // the refs must already point at the new state.
      expect(result.current.tabsRef.current).toBe(next.tabs);
      expect(result.current.tabsRef.current.map((t) => t.id)).toEqual(['a', 'b']);
      expect(result.current.activeTabIdRef.current).toBe('b');
    });
  });

  // THE contract that the sync-commit pattern exists for: two commits in the
  // same tick must compose. The second reads the first's result via stateRef,
  // NOT the state React last rendered. Deleting `stateRef.current = next` in
  // the hook makes the second commit start from the stale rendered state and
  // drop the first tab — this test is the guard for exactly that.
  it('composes two commits in a single tick', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    act(() => {
      result.current.commit({ type: 'addTab', tab: tab('b') });
      const afterSecond = result.current.commit({ type: 'addTab', tab: tab('c') });
      expect(afterSecond.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });
    // ...and the rendered state matches after the tick settles.
    expect(result.current.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.activeTabId).toBe('c');
  });

  it('composes a close that reads the just-added tab in the same tick', () => {
    const { result } = renderHook(() => useTabRegistry(init));
    act(() => {
      result.current.commit({ type: 'addTab', tab: tab('b') }); // -> [a, b], active b
      // Close the freshly-added active tab; close must see [a, b] via stateRef,
      // not the rendered [a], so it removes 'b' and re-activates 'a'.
      const afterClose = result.current.commit({
        type: 'close',
        tabId: 'b',
        fallbackTab: tab('fresh'),
      });
      expect(afterClose.tabs.map((t) => t.id)).toEqual(['a']);
      expect(afterClose.activeTabId).toBe('a');
    });
    expect(result.current.tabs.map((t) => t.id)).toEqual(['a']);
    expect(result.current.activeTabId).toBe('a');
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
