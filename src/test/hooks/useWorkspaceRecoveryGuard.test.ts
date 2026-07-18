import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceRecoveryGuard } from '../../hooks/useWorkspaceRecoveryGuard';
import { useWorkspaceAutosave } from '../../hooks/useDraftAutosave';
import type { DraftFile, WorkspaceFile } from '../../types';

/**
 * The guard's load-bearing proof: composed with the REAL workspace-autosave effect, it must
 * SUPPRESS write_draft while a snapshot-bearing hydration is suspended (so a corrupt snapshot
 * is never overwritten before preservation), and only allow writes once every tab resumed
 * cleanly OR the degraded original was explicitly preserved.
 */

const mockInvoke = vi.mocked(invoke);
const writeCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === 'write_draft');

const SNAPSHOT: DraftFile = {
  version: 1,
  savedAt: 'now',
  filePath: null,
  content: '# hi',
  docJSONState: 'valid',
  comments: [],
  suggestions: [],
  aiSession: null,
  contextFolder: null,
};
const WORKSPACE: WorkspaceFile = {
  version: 1,
  savedAt: 'now',
  activeTabId: 't1',
  tabs: [{ tabId: 't1', filePath: null, dirty: true, snapshot: SNAPSHOT }],
};

/** App-shaped composition: the guard gates `enabled` AND suppresses getWorkspace via its ref. */
function useComposed(revision: string) {
  const guard = useWorkspaceRecoveryGuard();
  useWorkspaceAutosave({
    enabled: !guard.suspended,
    hasDirtyTabs: true,
    revision,
    getWorkspace: () => (guard.suspendedRef.current ? null : WORKSPACE),
  });
  return guard;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('useWorkspaceRecoveryGuard composed with useWorkspaceAutosave', () => {
  it('suppresses every write_draft while a degraded recovery is unpreserved, then allows one after', async () => {
    const { result, rerender } = renderHook(({ revision }) => useComposed(revision), {
      initialProps: { revision: 'r0' },
    });
    // Suspend BEFORE any write can land, then flush: zero writes while degraded/unpreserved.
    act(() => result.current.begin(['t1']));
    await flush();
    mockInvoke.mockClear();

    act(() => result.current.report('t1', 'degraded'));
    rerender({ revision: 'r1' }); // a revision change would normally write — but it's suspended
    await flush();
    expect(result.current.degraded).toBe(true);
    expect(writeCalls()).toHaveLength(0);

    // A SUCCESSFUL quarantine (truthy result) resumes → the fresh workspace finally writes.
    const quarantineOk = vi.fn(async () => '/quarantined/workspace.corrupt-1.json');
    let preserved = false;
    await act(async () => {
      preserved = await result.current.preserve(quarantineOk);
    });
    expect(preserved).toBe(true);
    expect(quarantineOk).toHaveBeenCalledTimes(1);
    rerender({ revision: 'r2' });
    await flush();
    expect(result.current.degraded).toBe(false);
    expect(writeCalls().length).toBeGreaterThan(0); // writes resume once the original is preserved
  });

  it('quarantine FAILURE (falsy result) cannot resume — stays suspended, still zero writes', async () => {
    const { result, rerender } = renderHook(({ revision }) => useComposed(revision), {
      initialProps: { revision: 'r0' },
    });
    act(() => result.current.begin(['t1']));
    await flush();
    mockInvoke.mockClear();
    act(() => result.current.report('t1', 'degraded'));

    // The hook OWNS this: a null quarantine result must NOT resume.
    const quarantineFail = vi.fn(async () => null);
    let preserved = true;
    await act(async () => {
      preserved = await result.current.preserve(quarantineFail);
    });
    expect(preserved).toBe(false);
    expect(quarantineFail).toHaveBeenCalledTimes(1);
    expect(result.current.suspended).toBe(true);
    expect(result.current.degraded).toBe(true);
    rerender({ revision: 'r1' });
    await flush();
    expect(writeCalls()).toHaveLength(0);
  });

  it('an ALL-CLEAN recovery resumes and writes without any preservation gate', async () => {
    const { result, rerender } = renderHook(({ revision }) => useComposed(revision), {
      initialProps: { revision: 'r0' },
    });
    act(() => result.current.begin(['t1']));
    await flush();
    mockInvoke.mockClear();
    act(() => result.current.report('t1', 'lossless'));
    expect(result.current.suspended).toBe(false);
    expect(result.current.degraded).toBe(false);
    rerender({ revision: 'r1' });
    await flush();
    expect(writeCalls().length).toBeGreaterThan(0);
  });

  it('a legacy recovery does not enter the preservation path', async () => {
    const { result } = renderHook(({ revision }) => useComposed(revision), {
      initialProps: { revision: 'r0' },
    });
    act(() => result.current.begin(['t1']));
    act(() => result.current.report('t1', 'legacy'));
    expect(result.current.degraded).toBe(false);
    expect(result.current.suspended).toBe(false);
  });

  it('ONE degraded tab in a multi-tab hydration protects the whole envelope', async () => {
    const { result, rerender } = renderHook(({ revision }) => useComposed(revision), {
      initialProps: { revision: 'r0' },
    });
    act(() => result.current.begin(['t1', 't2']));
    await flush();
    mockInvoke.mockClear();
    // The clean tab reports first — still suspended, waiting on t2.
    act(() => result.current.report('t1', 'lossless'));
    expect(result.current.suspended).toBe(true);
    // The second tab is degraded → the whole workspace stays suspended.
    act(() => result.current.report('t2', 'degraded'));
    rerender({ revision: 'r1' });
    await flush();
    expect(result.current.degraded).toBe(true);
    expect(writeCalls()).toHaveLength(0);
  });

  it('no snapshot-bearing tabs → the guard no-ops (never suspends)', async () => {
    const { result, rerender } = renderHook(({ revision }) => useComposed(revision), {
      initialProps: { revision: 'r0' },
    });
    mockInvoke.mockClear();
    act(() => result.current.begin([])); // nothing to guard
    expect(result.current.suspended).toBe(false);
    rerender({ revision: 'r1' });
    await flush();
    expect(writeCalls().length).toBeGreaterThan(0);
  });
});
