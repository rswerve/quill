import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSaveCoordinator } from '../../hooks/useSaveCoordinator';
import type { SaveOutcome } from '../../hooks/useFileManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const saved = (): SaveOutcome => ({
  status: 'saved',
  path: '/doc.md',
  docHash: 'h',
  sidecar: { state: 'absent' },
});
const failed = (message = 'disk full'): SaveOutcome => ({ status: 'failed', message });

/** Render the coordinator with a mutable revision counter the test controls. */
function setup(performSave: () => Promise<SaveOutcome>, initialRevision = 1) {
  const revisionRef = { current: initialRevision };
  const view = renderHook(() =>
    useSaveCoordinator({ performSave, getRevision: () => revisionRef.current }),
  );
  return { ...view, revisionRef };
}

describe('useSaveCoordinator', () => {
  it('coalesces a burst of same-tick requests into a single write', async () => {
    const performSave = vi.fn(async () => saved());
    const { result } = setup(performSave);

    let outcomes: SaveOutcome[] = [];
    await act(async () => {
      outcomes = await Promise.all([
        result.current.requestSave(),
        result.current.requestSave(),
        result.current.requestSave(),
      ]);
    });

    expect(performSave).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status)).toEqual(['saved', 'saved', 'saved']);
  });

  it('runs exactly one fresh pass when a change arrives during a successful write', async () => {
    const d1 = deferred<SaveOutcome>();
    const d2 = deferred<SaveOutcome>();
    const performSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const { result, revisionRef } = setup(performSave);

    let p1!: Promise<SaveOutcome>;
    act(() => {
      p1 = result.current.requestSave(); // write 1 begins, startRevision = 1
    });
    // A change lands while write 1 is in flight; a new request wants it persisted.
    revisionRef.current = 2;
    let p2!: Promise<SaveOutcome>;
    act(() => {
      p2 = result.current.requestSave(); // waiter minRevision = 2 (uncovered by write 1)
    });

    await act(async () => {
      d1.resolve(saved()); // write 1 completes → p1 covered; write 2 begins (startRevision = 2)
    });
    expect(performSave).toHaveBeenCalledTimes(2);

    await act(async () => {
      d2.resolve(saved());
    });
    expect((await p1).status).toBe('saved');
    expect((await p2).status).toBe('saved');
    expect(performSave).toHaveBeenCalledTimes(2); // exactly two — one fresh pass, no third
  });

  it('resolves a request only once a write covering its revision lands', async () => {
    const d1 = deferred<SaveOutcome>();
    const d2 = deferred<SaveOutcome>();
    const performSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const { result, revisionRef } = setup(performSave);

    act(() => {
      result.current.requestSave(); // write 1, startRevision = 1
    });
    revisionRef.current = 5;
    let late!: Promise<SaveOutcome>;
    act(() => {
      late = result.current.requestSave(); // minRevision = 5, NOT covered by write 1
    });

    let lateResolved = false;
    void late.then(() => {
      lateResolved = true;
    });

    await act(async () => {
      d1.resolve(saved()); // write 1 (startRevision 1) completes; does NOT cover minRevision 5
    });
    await act(async () => {});
    expect(lateResolved).toBe(false); // still waiting for a covering write

    await act(async () => {
      d2.resolve(saved()); // write 2 (startRevision 5) covers it
    });
    expect((await late).status).toBe('saved');
    expect(lateResolved).toBe(true);
  });

  it('does NOT auto-retry after a failed write, even with an uncovered waiter', async () => {
    const d1 = deferred<SaveOutcome>();
    const performSave = vi.fn<() => Promise<SaveOutcome>>().mockReturnValue(d1.promise);
    const { result, revisionRef } = setup(performSave);

    let p1!: Promise<SaveOutcome>;
    act(() => {
      p1 = result.current.requestSave(); // write 1 begins, startRevision = 1
    });
    revisionRef.current = 2;
    let p2!: Promise<SaveOutcome>;
    act(() => {
      p2 = result.current.requestSave(); // waiter minRevision = 2, uncovered by write 1
    });

    await act(async () => {
      d1.resolve(failed()); // write 1 FAILS
    });
    await act(async () => {});

    expect((await p1).status).toBe('failed');
    expect((await p2).status).toBe('failed'); // uncovered waiter resolved with failure, not retried
    expect(performSave).toHaveBeenCalledTimes(1); // NO unbacked retry loop
  });

  it.each(['blocked', 'conflict'] as const)(
    'treats a %s outcome as terminal and does not auto-retry',
    async (kind) => {
      const terminal: SaveOutcome =
        kind === 'blocked'
          ? { status: 'blocked', reason: 'sidecar-protected' }
          : { status: 'conflict', path: '/doc.md', which: 'doc', actual: { state: 'absent' } };
      const d1 = deferred<SaveOutcome>();
      const performSave = vi.fn<() => Promise<SaveOutcome>>().mockReturnValue(d1.promise);
      const { result, revisionRef } = setup(performSave);

      act(() => {
        result.current.requestSave();
      });
      revisionRef.current = 2;
      let p2!: Promise<SaveOutcome>;
      act(() => {
        p2 = result.current.requestSave();
      });

      await act(async () => {
        d1.resolve(terminal);
      });
      await act(async () => {});

      expect((await p2).status).toBe(kind);
      expect(performSave).toHaveBeenCalledTimes(1);
    },
  );

  it('recovers a rejected performSave into a typed failed outcome', async () => {
    const performSave = vi.fn(async () => {
      throw new Error('write threw');
    });
    const { result } = setup(performSave);

    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.requestSave();
    });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(performSave).toHaveBeenCalledTimes(1);
  });

  it('runs an exclusive job only after an in-flight save finishes', async () => {
    const d1 = deferred<SaveOutcome>();
    const performSave = vi.fn<() => Promise<SaveOutcome>>().mockReturnValue(d1.promise);
    const exclusiveJob = vi.fn(async (): Promise<SaveOutcome> => saved());
    const { result } = setup(performSave);

    act(() => {
      result.current.requestSave();
    });
    act(() => {
      result.current.runExclusive(exclusiveJob);
    });
    expect(exclusiveJob).not.toHaveBeenCalled(); // waits for the in-flight save

    await act(async () => {
      d1.resolve(saved());
    });
    await act(async () => {});
    expect(exclusiveJob).toHaveBeenCalledTimes(1);
  });

  it('flush resolves only after in-flight work drains', async () => {
    const d1 = deferred<SaveOutcome>();
    const performSave = vi.fn<() => Promise<SaveOutcome>>().mockReturnValue(d1.promise);
    const { result } = setup(performSave);

    act(() => {
      result.current.requestSave();
    });
    let flushed = false;
    act(() => {
      void result.current.flush().then(() => {
        flushed = true;
      });
    });
    await act(async () => {});
    expect(flushed).toBe(false); // save still in flight

    await act(async () => {
      d1.resolve(saved());
    });
    await act(async () => {});
    expect(flushed).toBe(true);
  });

  it('flush is a no-op when idle', async () => {
    const performSave = vi.fn(async () => saved());
    const { result } = setup(performSave);
    await act(async () => {
      await result.current.flush();
    });
    expect(performSave).not.toHaveBeenCalled();
  });

  it('drives status idle → saving → saved', async () => {
    const d1 = deferred<SaveOutcome>();
    const performSave = vi.fn<() => Promise<SaveOutcome>>().mockReturnValue(d1.promise);
    const { result } = setup(performSave);

    expect(result.current.status).toEqual({ state: 'idle' });
    act(() => {
      result.current.requestSave();
    });
    expect(result.current.status).toEqual({ state: 'saving' });
    await act(async () => {
      d1.resolve(saved());
    });
    expect(result.current.status).toEqual({ state: 'saved' });
  });
});
