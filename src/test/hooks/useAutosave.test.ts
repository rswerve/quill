import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutosave } from '../../hooks/useAutosave';
import type { SaveOutcome } from '../../hooks/useFileManager';

const IDLE_MS = 2000;
const MAX_MS = 15000;
const BACKOFF_1 = 5000;

const saved = (): SaveOutcome => ({
  status: 'saved',
  path: '/doc.md',
  docHash: 'h',
  sidecar: { state: 'absent' },
});
const failed = (message = 'disk full'): SaveOutcome => ({ status: 'failed', message });
const blocked = (): SaveOutcome => ({ status: 'blocked', reason: 'sidecar-protected' });
const conflict = (): SaveOutcome => ({
  status: 'conflict',
  path: '/doc.md',
  which: 'doc',
  actual: { state: 'absent' },
});
const cancelled = (): SaveOutcome => ({ status: 'cancelled' });
const reviewBlocked = (): SaveOutcome => ({
  status: 'review-blocked',
  unmappable: [{ kind: 'comment', id: 'c1' }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Ctl {
  revision: number;
  eligible: boolean;
  perform: ReturnType<typeof vi.fn>;
}

/**
 * Render the scheduler with a controllable revision / eligibility and a mock
 * performAutosave. `perform` defaults to a clean save that reports the current revision.
 */
function setup(perform?: () => Promise<{ outcome: SaveOutcome; revision: number }>) {
  const ctl: Ctl = { revision: 1, eligible: true, perform: vi.fn() };
  ctl.perform.mockImplementation(
    perform ?? (async () => ({ outcome: saved(), revision: ctl.revision })),
  );
  const view = renderHook(
    (props: { enabled: boolean; resetKey: string | null }) =>
      useAutosave({
        enabled: props.enabled,
        isEligible: () => ctl.eligible,
        performAutosave: ctl.perform as unknown as () => Promise<{
          outcome: SaveOutcome;
          revision: number;
        }>,
        getRevision: () => ctl.revision,
        resetKey: props.resetKey,
      }),
    { initialProps: { enabled: true, resetKey: 'doc-a' } },
  );
  return { ...view, ctl };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves once the idle debounce elapses after an edit', async () => {
    const { result, ctl } = setup();
    act(() => result.current.notifyChange());
    expect(result.current.status).toEqual({ state: 'pending' });

    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ state: 'saved' });
  });

  it('resets the idle debounce on each edit but fires at the max-wait ceiling', async () => {
    const { result, ctl } = setup();
    // Edit every 1s (< IDLE_MS) so the idle timer keeps resetting; the max ceiling wins.
    for (let elapsed = 0; elapsed < MAX_MS; elapsed += 1000) {
      act(() => result.current.notifyChange());
      await advance(1000);
    }
    expect(ctl.perform).toHaveBeenCalledTimes(1); // fired at MAX_MS, not per-edit
  });

  it('does not save when nothing changed since the last successful autosave', async () => {
    const { result, ctl } = setup();
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);

    // revision unchanged → a flush must be a no-op (revision === savedRevision).
    await act(async () => {
      await result.current.flush();
    });
    expect(ctl.perform).toHaveBeenCalledTimes(1);
  });

  it('flush saves a later edit and joins an in-flight autosave', async () => {
    const d = deferred<{ outcome: SaveOutcome; revision: number }>();
    const { result, ctl } = setup(() => d.promise);
    act(() => result.current.notifyChange());
    await advance(IDLE_MS); // idle fires → perform in flight (unresolved)
    expect(ctl.perform).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ state: 'saving' });

    let flushed = false;
    act(() => {
      void result.current.flush().then(() => {
        flushed = true;
      });
    });
    await act(async () => {});
    expect(flushed).toBe(false); // flush joins the in-flight save, does not resolve early

    await act(async () => {
      d.resolve({ outcome: saved(), revision: 1 });
    });
    expect(flushed).toBe(true);
    expect(ctl.perform).toHaveBeenCalledTimes(1); // no redundant second write
  });

  it('latches on a conflict and a bare edit does not re-arm; resolution resumes it', async () => {
    const { result, ctl } = setup(async () => ({ outcome: conflict(), revision: 1 }));
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(result.current.status).toEqual({ state: 'stopped', reason: 'conflict' });
    expect(ctl.perform).toHaveBeenCalledTimes(1);

    // Still conflicted (ineligible): another edit must NOT re-arm.
    ctl.eligible = false;
    act(() => result.current.notifyChange());
    await advance(IDLE_MS + MAX_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);

    // The user resolves the conflict (eligibility regained). Now an edit resumes autosave.
    ctl.eligible = true;
    ctl.perform.mockImplementation(async () => ({ outcome: saved(), revision: 2 }));
    ctl.revision = 2;
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(2);
    expect(result.current.status).toEqual({ state: 'saved' });
  });

  it('latches on a block and a later edit does not re-arm even while eligible', async () => {
    const { result, ctl } = setup(async () => ({ outcome: blocked(), revision: 1 }));
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(result.current.status).toEqual({ state: 'stopped', reason: 'blocked' });

    // A block is not a conflict: eligibility stays true, but edits must not hammer it.
    ctl.revision = 2;
    act(() => result.current.notifyChange());
    await advance(IDLE_MS + MAX_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);
  });

  it('review-blocked shows a distinct status; a later edit re-arms a retry (no backoff)', async () => {
    const { result, ctl } = setup(async () => ({
      outcome: reviewBlocked(),
      revision: ctl.revision,
    }));
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(result.current.status).toEqual({ state: 'review-blocked' });
    expect(ctl.perform).toHaveBeenCalledTimes(1);

    // UNLIKE a block: fixing the annotation is a normal edit that re-arms and retries.
    ctl.perform.mockImplementation(async () => ({ outcome: saved(), revision: 2 }));
    ctl.revision = 2;
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(2);
    expect(result.current.status).toEqual({ state: 'saved' });
  });

  it('backs off after a failure; an edit during backoff does not reset the debounce', async () => {
    let attempt = 0;
    const { result, ctl } = setup(async () => {
      attempt += 1;
      return { outcome: attempt === 1 ? failed() : saved(), revision: ctl.revision };
    });
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ state: 'failed', retryInMs: BACKOFF_1 });

    // An edit during backoff must NOT arm a fresh 2s debounce that bypasses the backoff.
    ctl.revision = 2;
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1); // still waiting out the backoff

    // The backoff elapses → retry, which now succeeds.
    await advance(BACKOFF_1 - IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(2);
    expect(result.current.status).toEqual({ state: 'saved' });
  });

  it('retries on the exact 5s → 15s → 60s → 60s (capped) backoff schedule', async () => {
    // Locks the whole sequence, not just the first delay — a [5,5,5] mutation must fail.
    const { result, ctl } = setup(async () => ({ outcome: failed(), revision: ctl.revision }));
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ state: 'failed', retryInMs: 5000 });

    await advance(5000);
    expect(ctl.perform).toHaveBeenCalledTimes(2);
    expect(result.current.status).toEqual({ state: 'failed', retryInMs: 15000 });

    await advance(15000);
    expect(ctl.perform).toHaveBeenCalledTimes(3);
    expect(result.current.status).toEqual({ state: 'failed', retryInMs: 60000 });

    await advance(60000);
    expect(ctl.perform).toHaveBeenCalledTimes(4);
    expect(result.current.status).toEqual({ state: 'failed', retryInMs: 60000 }); // capped

    await advance(60000);
    expect(ctl.perform).toHaveBeenCalledTimes(5);
    expect(result.current.status).toEqual({ state: 'failed', retryInMs: 60000 });
  });

  it('treats a cancelled outcome as a no-op and never backs off', async () => {
    const { result, ctl } = setup(async () => ({ outcome: cancelled(), revision: 1 }));
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(ctl.perform).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ state: 'idle' });

    // No backoff timer should be pending: advancing well past any backoff yields no retry.
    await advance(60000);
    expect(ctl.perform).toHaveBeenCalledTimes(1);
  });

  it('an identity change (resetKey) cancels timers and drops a late completion', async () => {
    const d = deferred<{ outcome: SaveOutcome; revision: number }>();
    const { result, rerender, ctl } = setup(() => d.promise);
    act(() => result.current.notifyChange());
    await advance(IDLE_MS); // perform in flight for doc-a
    expect(result.current.status).toEqual({ state: 'saving' });

    // The tab switches documents before the save resolves.
    act(() => rerender({ enabled: true, resetKey: 'doc-b' }));
    expect(result.current.status).toEqual({ state: 'idle' });

    // The stale doc-a save resolves — it must not stamp doc-b as 'saved'.
    await act(async () => {
      d.resolve({ outcome: saved(), revision: 1 });
    });
    expect(result.current.status).toEqual({ state: 'idle' });
    // And a fresh edit on doc-b still schedules normally.
    ctl.perform.mockImplementation(async () => ({ outcome: saved(), revision: 5 }));
    ctl.revision = 5;
    act(() => result.current.notifyChange());
    await advance(IDLE_MS);
    expect(result.current.status).toEqual({ state: 'saved' });
  });

  it('cancels pending work when disabled', async () => {
    const { result, rerender, ctl } = setup();
    act(() => result.current.notifyChange());
    act(() => rerender({ enabled: false, resetKey: 'doc-a' }));
    await advance(IDLE_MS + MAX_MS);
    expect(ctl.perform).not.toHaveBeenCalled();
    expect(result.current.status).toEqual({ state: 'idle' });
  });
});
