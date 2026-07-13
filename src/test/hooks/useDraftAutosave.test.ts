import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { sanitizeWorkspace, useWorkspaceAutosave } from '../../hooks/useDraftAutosave';
import type { DraftSnapshot } from '../../hooks/useDraftAutosave';
import type { DraftFile, WorkspaceFile } from '../../types';

const mockInvoke = vi.mocked(invoke);

const SNAPSHOT: DraftSnapshot = {
  filePath: '/docs/test.md',
  content: '# Hello',
  comments: [],
  suggestions: [],
  aiSession: null,
  contextFolder: null,
};

const VALID_DRAFT: DraftFile = {
  version: 1,
  savedAt: '2026-06-11T00:00:00.000Z',
  ...SNAPSHOT,
};

const WORKSPACE: WorkspaceFile = {
  version: 1,
  savedAt: '2026-07-13T00:00:00.000Z',
  activeTabId: 'tab-dirty',
  tabs: [
    { tabId: 'tab-clean', filePath: '/docs/clean.md', dirty: false },
    {
      tabId: 'tab-dirty',
      filePath: '/docs/test.md',
      dirty: true,
      snapshot: VALID_DRAFT,
    },
  ],
};

function writeCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'write_draft');
}

function deleteCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_draft');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkspaceAutosave', () => {
  it('writes the full workspace immediately, then every five seconds while any tab is dirty', async () => {
    const { rerender } = renderHook(
      ({ enabled, hasDirtyTabs, revision }) =>
        useWorkspaceAutosave({
          enabled,
          hasDirtyTabs,
          revision,
          getWorkspace: () => WORKSPACE,
        }),
      { initialProps: { enabled: false, hasDirtyTabs: true, revision: 'initial' } },
    );
    expect(writeCalls()).toHaveLength(0);

    rerender({ enabled: true, hasDirtyTabs: true, revision: 'ready' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(writeCalls()).toHaveLength(2);

    const [, args] = writeCalls()[0] as [string, { content: string }];
    const written = JSON.parse(args.content) as WorkspaceFile;
    expect(written.version).toBe(1);
    expect(written.activeTabId).toBe('tab-dirty');
    expect(written.tabs).toEqual(WORKSPACE.tabs);
  });

  it('writes clean open-set revisions but does not keep an interval running', async () => {
    const { rerender } = renderHook(
      ({ revision }) =>
        useWorkspaceAutosave({
          enabled: true,
          hasDirtyTabs: false,
          revision,
          getWorkspace: () => WORKSPACE,
        }),
      { initialProps: { revision: 'tab-1' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(1);

    rerender({ revision: 'tab-1,tab-2' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(2);
    expect(deleteCalls()).toHaveLength(0);

    // The interval is gone: time passing writes nothing more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(writeCalls()).toHaveLength(2);
  });

  it('does not read, write, or delete before shell hydration enables persistence', async () => {
    renderHook(() =>
      useWorkspaceAutosave({
        enabled: false,
        hasDirtyTabs: true,
        revision: 'loading',
        getWorkspace: () => WORKSPACE,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(deleteCalls()).toHaveLength(0);
    expect(writeCalls()).toHaveLength(0);
  });

  it('swallows invoke failures (non-Tauri context is a no-op)', async () => {
    mockInvoke.mockRejectedValue(new Error('not in tauri'));
    const { result } = renderHook(() =>
      useWorkspaceAutosave({
        enabled: true,
        hasDirtyTabs: true,
        revision: 'dirty',
        getWorkspace: () => WORKSPACE,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await result.current.writeWorkspace()).toBe(false);
    await result.current.deleteWorkspace();
  });

  describe('readWorkspace', () => {
    it('returns a valid workspace', async () => {
      mockInvoke.mockResolvedValue(JSON.stringify(WORKSPACE));
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );
      expect(await result.current.readWorkspace()).toEqual(WORKSPACE);
    });

    it('migrates a legacy single-document draft into one dirty workspace tab', async () => {
      expect(sanitizeWorkspace(VALID_DRAFT)).toEqual({
        version: 1,
        savedAt: VALID_DRAFT.savedAt,
        activeTabId: 'legacy-draft',
        tabs: [
          {
            tabId: 'legacy-draft',
            filePath: VALID_DRAFT.filePath,
            dirty: true,
            snapshot: VALID_DRAFT,
          },
        ],
      });
    });

    it('returns null when no workspace exists', async () => {
      mockInvoke.mockResolvedValue(null);
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );
      expect(await result.current.readWorkspace()).toBeNull();
    });

    it('drops malformed tabs and rejects an unusable envelope', async () => {
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );

      mockInvoke.mockResolvedValue('not json {');
      expect(await result.current.readWorkspace()).toBeNull();

      mockInvoke.mockResolvedValue(JSON.stringify({ version: 99, tabs: [] }));
      expect(await result.current.readWorkspace()).toBeNull();

      mockInvoke.mockResolvedValue(
        JSON.stringify({ version: 1, activeTabId: 'bad', tabs: [{ tabId: 'bad' }] }),
      );
      expect(await result.current.readWorkspace()).toBeNull();
    });

    it('returns null when invoke throws (non-Tauri context)', async () => {
      mockInvoke.mockRejectedValue(new Error('not in tauri'));
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );
      expect(await result.current.readWorkspace()).toBeNull();
    });
  });
});
