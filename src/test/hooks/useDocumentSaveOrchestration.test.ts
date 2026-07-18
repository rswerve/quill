import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useDocumentSaveOrchestration } from '../../hooks/useDocumentSaveOrchestration';
import type { CanonicalSaveState } from '../../utils/canonicalPersistence';
import type { SaveOutcome } from '../../hooks/useFileManager';

/**
 * Extraction oracles for useDocumentSaveOrchestration (Slice E4b-1). The full mounted
 * save/recovery suites prove the lift is behavior-identical; these cover the moved-state
 * COMPOSITION the coordinator/autosave unit tests don't: the conflict gate on Cmd+S, the
 * clear action, and the single-flight conflict-resolution guard.
 */

const okCapture = (): CanonicalSaveState => ({
  ok: true,
  markdown: 'body',
  comments: [],
  suggestions: [],
  structural: [],
});

const saved: SaveOutcome = {
  status: 'saved',
  path: '/d.md',
  docHash: 'h'.repeat(64),
  sidecar: { state: 'present', hash: 's'.repeat(64) },
};
const conflict: SaveOutcome = {
  status: 'conflict',
  path: '/d.md',
  which: 'doc',
  actual: { state: 'present', hash: 'x'.repeat(64) },
};

function makeDeps(over: Partial<Parameters<typeof useDocumentSaveOrchestration>[0]> = {}) {
  return {
    filePath: '/d.md',
    captureCanonicalSaveState: okCapture,
    getChangeRevision: () => 1,
    saveFile: vi.fn(async () => saved),
    saveFileAs: vi.fn(async () => saved),
    aiSession: null,
    contextFolder: null,
    documentChat: { getThread: () => ({ sessionId: 's', messages: [] }) },
    editorRef: { current: null },
    tabId: 't',
    lastGoodWorkspaceSnapshotRef: { current: null },
    bumpSchedulerGen: vi.fn(),
    setLastSavedAt: vi.fn(),
    onRecentFile: vi.fn(),
    onRequestSavePath: () => true,
    showError: vi.fn(),
    focusAnnotation: vi.fn(),
    ...over,
  } as Parameters<typeof useDocumentSaveOrchestration>[0];
}

describe('useDocumentSaveOrchestration', () => {
  it('a conflict outcome blocks a subsequent Cmd+S (zero further writes) and bumps conflictFlash', async () => {
    const saveFile = vi.fn(async () => conflict);
    const { result } = renderHook(() => useDocumentSaveOrchestration(makeDeps({ saveFile })));

    await act(async () => {
      await result.current.handleSave();
    });
    expect(saveFile).toHaveBeenCalledTimes(1); // the write that hit the conflict
    expect(result.current.saveConflict).toEqual({ which: 'doc' });

    const flashBefore = result.current.conflictFlash;
    await act(async () => {
      await result.current.handleSave(); // Cmd+S while conflicted
    });
    expect(saveFile).toHaveBeenCalledTimes(1); // NO additional write
    expect(result.current.conflictFlash).toBe(flashBefore + 1); // banner re-announced
  });

  it('clearSaveConflict lets a save go through again', async () => {
    const saveFile = vi.fn<() => Promise<SaveOutcome>>().mockResolvedValueOnce(conflict);
    saveFile.mockResolvedValue(saved);
    const { result } = renderHook(() => useDocumentSaveOrchestration(makeDeps({ saveFile })));

    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.saveConflict).not.toBeNull();

    act(() => {
      result.current.clearSaveConflict();
    });
    expect(result.current.saveConflict).toBeNull();

    await act(async () => {
      await result.current.handleSave();
    });
    expect(saveFile).toHaveBeenCalledTimes(2); // the write is no longer blocked
  });

  it('runConflictResolution is single-flight — two same-tick jobs run only one', async () => {
    const { result } = renderHook(() => useDocumentSaveOrchestration(makeDeps()));
    let running = 0;
    let maxConcurrent = 0;
    const job = vi.fn(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    });

    await act(async () => {
      const a = result.current.runConflictResolution(job);
      const b = result.current.runConflictResolution(job); // same tick — ref is already set
      await Promise.all([a, b]);
    });

    expect(job).toHaveBeenCalledTimes(1); // the second call is dropped synchronously
    expect(maxConcurrent).toBe(1);
    expect(result.current.resolvingConflict).toBe(false); // lifecycle released
  });
});
