import { describe, expect, it } from 'vitest';
import { tabsReducer, type TabMeta, type TabRegistryState } from '../../hooks/tabsReducer';
import type { DocumentTabMetaSnapshot } from '../../components/DocumentTab';

const tab = (over: Partial<TabMeta> & { id: string }): TabMeta => ({
  title: 'Untitled',
  isDirty: false,
  filePath: null,
  initialFilePath: null,
  initialWorkspaceSnapshot: null,
  initialWorkspaceDirty: false,
  restoredFromWorkspace: false,
  ...over,
});

const snap = (over: Partial<DocumentTabMetaSnapshot>): DocumentTabMetaSnapshot =>
  ({ filePath: null, title: 'Untitled', isDirty: false, ...over }) as DocumentTabMetaSnapshot;

const state = (tabs: TabMeta[], activeTabId: string): TabRegistryState => ({ tabs, activeTabId });

// Invariants relied on by App: nonempty tabs, and activeTabId names a real tab.
const holdsInvariants = (s: TabRegistryState) =>
  s.tabs.length > 0 && s.tabs.some((t) => t.id === s.activeTabId);

describe('tabsReducer', () => {
  describe('hydrate', () => {
    it('replaces tabs and active id atomically', () => {
      const next = tabsReducer(state([tab({ id: 'a' })], 'a'), {
        type: 'hydrate',
        tabs: [tab({ id: 'x' }), tab({ id: 'y' })],
        activeTabId: 'y',
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['x', 'y']);
      expect(next.activeTabId).toBe('y');
      expect(holdsInvariants(next)).toBe(true);
    });
    // hydrate is the one transition fed external (workspace) data, so it must
    // enforce the invariants rather than trust the payload.
    it('rejects an empty tab set (same reference — nothing to activate)', () => {
      const s = state([tab({ id: 'a' })], 'a');
      expect(tabsReducer(s, { type: 'hydrate', tabs: [], activeTabId: 'whatever' })).toBe(s);
    });
    it('clamps a stray active id (not present in the payload) to the first tab', () => {
      const next = tabsReducer(state([tab({ id: 'a' })], 'a'), {
        type: 'hydrate',
        tabs: [tab({ id: 'x' }), tab({ id: 'y' })],
        activeTabId: 'ghost',
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['x', 'y']);
      expect(next.activeTabId).toBe('x');
      expect(holdsInvariants(next)).toBe(true);
    });
  });

  describe('activate', () => {
    it('sets the active id', () => {
      const next = tabsReducer(state([tab({ id: 'a' }), tab({ id: 'b' })], 'a'), {
        type: 'activate',
        tabId: 'b',
      });
      expect(next.activeTabId).toBe('b');
    });
    it('is a no-op (same reference) for an unknown id', () => {
      const s = state([tab({ id: 'a' })], 'a');
      expect(tabsReducer(s, { type: 'activate', tabId: 'ghost' })).toBe(s);
    });
    it('is idempotent (same reference) when already active', () => {
      const s = state([tab({ id: 'a' })], 'a');
      expect(tabsReducer(s, { type: 'activate', tabId: 'a' })).toBe(s);
    });
  });

  describe('addTab', () => {
    it('appends the tab AND activates it in one step (add-then-activate atomicity)', () => {
      const next = tabsReducer(state([tab({ id: 'a' })], 'a'), {
        type: 'addTab',
        tab: tab({ id: 'new' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['a', 'new']);
      expect(next.activeTabId).toBe('new');
    });
  });

  describe('close', () => {
    // [a,b,c] active c, close the non-active FIRST tab: the active id must be
    // left as 'c'. If close instead *always* recomputed the active from the
    // closed index (min(0, …) -> 'b'), 'c' would separate it — a plain [a,b]
    // non-active close can't, because the survivor sits at the closed index.
    it('removing a non-active tab leaves the active id untouched', () => {
      const next = tabsReducer(state([tab({ id: 'a' }), tab({ id: 'b' }), tab({ id: 'c' })], 'c'), {
        type: 'close',
        tabId: 'a',
        fallbackTab: tab({ id: 'fresh' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['b', 'c']);
      expect(next.activeTabId).toBe('c');
    });
    it('closing the active tab activates the tab that slid into its index', () => {
      const next = tabsReducer(state([tab({ id: 'a' }), tab({ id: 'b' }), tab({ id: 'c' })], 'b'), {
        type: 'close',
        tabId: 'b',
        fallbackTab: tab({ id: 'fresh' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['a', 'c']);
      expect(next.activeTabId).toBe('c'); // index 1 slid to 'c'
    });
    // The FIRST-tab close is the only case that pins the exact index: unlike the
    // middle/last/only cases, the clamp does NOT saturate here, so it separates
    // "the tab that slid into the closed slot" (correct) from "the next tab".
    it('closing the active FIRST tab of three activates the tab that slid into slot 0', () => {
      const next = tabsReducer(state([tab({ id: 'a' }), tab({ id: 'b' }), tab({ id: 'c' })], 'a'), {
        type: 'close',
        tabId: 'a',
        fallbackTab: tab({ id: 'fresh' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['b', 'c']);
      expect(next.activeTabId).toBe('b'); // index 0 now holds 'b', not 'c'
    });
    it('closing the active LAST tab clamps to the new last', () => {
      const next = tabsReducer(state([tab({ id: 'a' }), tab({ id: 'b' })], 'b'), {
        type: 'close',
        tabId: 'b',
        fallbackTab: tab({ id: 'fresh' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['a']);
      expect(next.activeTabId).toBe('a');
    });
    it('closing the only tab falls back to a fresh Untitled and activates it', () => {
      const next = tabsReducer(state([tab({ id: 'only' })], 'only'), {
        type: 'close',
        tabId: 'only',
        fallbackTab: tab({ id: 'fresh' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['fresh']);
      expect(next.activeTabId).toBe('fresh');
      expect(holdsInvariants(next)).toBe(true);
    });
    // The reducer is PURE — it only consumes the fallback. App allocates a
    // fresh Untitled solely when the close empties the set (its provider,
    // createUntitledTab, advances a counter); on an ordinary close App passes
    // null. So a supplied fallback must be ignored when survivors remain.
    it('ignores a supplied fallbackTab when survivors remain', () => {
      const next = tabsReducer(state([tab({ id: 'a' }), tab({ id: 'b' })], 'a'), {
        type: 'close',
        tabId: 'a',
        fallbackTab: tab({ id: 'unused' }),
      });
      expect(next.tabs.map((t) => t.id)).toEqual(['b']);
    });
    // If App miscomputes and a would-empty close arrives with no fallback, the
    // reducer refuses rather than violate the never-empty invariant.
    it('rejects a would-empty close with a null fallback (same reference)', () => {
      const s = state([tab({ id: 'only' })], 'only');
      expect(tabsReducer(s, { type: 'close', tabId: 'only', fallbackTab: null })).toBe(s);
    });
    it('is a no-op (same reference) for an unknown id', () => {
      const s = state([tab({ id: 'a' })], 'a');
      expect(tabsReducer(s, { type: 'close', tabId: 'ghost', fallbackTab: tab({ id: 'f' }) })).toBe(
        s,
      );
    });
  });

  describe('clearInitialFilePath / clearInitialWorkspaceSnapshot', () => {
    it('clears the target initial file path', () => {
      const next = tabsReducer(state([tab({ id: 'a', initialFilePath: '/x.md' })], 'a'), {
        type: 'clearInitialFilePath',
        tabId: 'a',
      });
      expect(next.tabs[0].initialFilePath).toBeNull();
    });
    it('clears the target initial workspace snapshot', () => {
      const next = tabsReducer(
        state([tab({ id: 'a', initialWorkspaceSnapshot: {} as never })], 'a'),
        { type: 'clearInitialWorkspaceSnapshot', tabId: 'a' },
      );
      expect(next.tabs[0].initialWorkspaceSnapshot).toBeNull();
    });
  });

  describe('applyMetaSnapshot', () => {
    it('applies filePath/title/isDirty and clears initialFilePath', () => {
      const next = tabsReducer(state([tab({ id: 'a', initialFilePath: '/x.md' })], 'a'), {
        type: 'applyMetaSnapshot',
        tabId: 'a',
        snapshot: snap({ filePath: '/x.md', title: 'x', isDirty: true }),
      });
      expect(next.tabs[0]).toMatchObject({
        filePath: '/x.md',
        initialFilePath: null,
        title: 'x',
        isDirty: true,
      });
    });
    it('keeps a pending path/title when the snapshot is still blank (filePath null)', () => {
      const s = state([tab({ id: 'a', initialFilePath: '/x.md', title: 'x' })], 'a');
      const next = tabsReducer(s, {
        type: 'applyMetaSnapshot',
        tabId: 'a',
        snapshot: snap({ filePath: null, title: 'Untitled' }),
      });
      // Pending tab is left intact — same state reference (nothing published).
      expect(next).toBe(s);
    });
    // The guard is (initialFilePath || initialWorkspaceSnapshot). A snapshot-
    // backed recovery tab has a null initialFilePath but a live
    // initialWorkspaceSnapshot, so this pins the second half of the OR: dropping
    // it would let the blank first meta wipe the recovered title.
    it('keeps a pending workspace-snapshot tab when the snapshot is still blank', () => {
      const s = state(
        [tab({ id: 'a', initialWorkspaceSnapshot: {} as never, title: 'Recovered' })],
        'a',
      );
      const next = tabsReducer(s, {
        type: 'applyMetaSnapshot',
        tabId: 'a',
        snapshot: snap({ filePath: null, title: 'Untitled' }),
      });
      expect(next).toBe(s);
    });
    it('skips the publish (same reference) when nothing actually changed', () => {
      const s = state([tab({ id: 'a', title: 'Doc', filePath: '/d.md', isDirty: false })], 'a');
      const next = tabsReducer(s, {
        type: 'applyMetaSnapshot',
        tabId: 'a',
        snapshot: snap({ filePath: '/d.md', title: 'Doc', isDirty: false }),
      });
      expect(next).toBe(s);
    });
  });

  it('every transition preserves the invariants', () => {
    const base = state([tab({ id: 'a' }), tab({ id: 'b' })], 'a');
    const actions: Parameters<typeof tabsReducer>[1][] = [
      { type: 'activate', tabId: 'b' },
      { type: 'addTab', tab: tab({ id: 'c' }) },
      { type: 'close', tabId: 'a', fallbackTab: tab({ id: 'f' }) },
      { type: 'close', tabId: 'b', fallbackTab: tab({ id: 'f' }) },
      { type: 'hydrate', tabs: [tab({ id: 'z' })], activeTabId: 'z' },
    ];
    for (const action of actions) {
      expect(holdsInvariants(tabsReducer(base, action))).toBe(true);
    }
  });
});
