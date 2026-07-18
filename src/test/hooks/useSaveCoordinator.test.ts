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
const reviewBlocked = (): SaveOutcome => ({
  status: 'review-blocked',
  unmappable: [{ kind: 'comment', id: 'c1' }],
});

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

  it('queues one fresh pass when the revision advances during a write, with NO second request', async () => {
    const d1 = deferred<SaveOutcome>();
    const d2 = deferred<SaveOutcome>();
    const performSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const { result, revisionRef } = setup(performSave);

    let p1!: Promise<SaveOutcome>;
    act(() => {
      p1 = result.current.requestSave(); // write 1, startRevision = 1
    });
    revisionRef.current = 2; // document changes during the write — but no new request

    await act(async () => {
      d1.resolve(saved()); // getRevision() 2 > startRevision 1 → a fresh pass runs
    });
    expect(performSave).toHaveBeenCalledTimes(2);

    await act(async () => {
      d2.resolve(saved()); // getRevision() 2 == startRevision 2 → settles
    });
    expect((await p1).status).toBe('saved');
    expect(performSave).toHaveBeenCalledTimes(2);
  });

  it('chains a further fresh pass if the document changes again during the fresh pass', async () => {
    const d1 = deferred<SaveOutcome>();
    const d2 = deferred<SaveOutcome>();
    const d3 = deferred<SaveOutcome>();
    const performSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
      .mockReturnValueOnce(d3.promise);
    const { result, revisionRef } = setup(performSave);

    act(() => {
      result.current.requestSave(); // write 1, startRevision = 1
    });
    revisionRef.current = 2;
    await act(async () => {
      d1.resolve(saved()); // fresh pass 2, startRevision = 2
    });
    expect(performSave).toHaveBeenCalledTimes(2);

    revisionRef.current = 3; // changes again during pass 2
    await act(async () => {
      d2.resolve(saved()); // fresh pass 3, startRevision = 3
    });
    expect(performSave).toHaveBeenCalledTimes(3);

    await act(async () => {
      d3.resolve(saved()); // getRevision() 3 == 3 → stop
    });
    expect(performSave).toHaveBeenCalledTimes(3);
  });

  it('returns to saving for a queued fresh pass (status does not stick on saved)', async () => {
    const d1 = deferred<SaveOutcome>();
    const d2 = deferred<SaveOutcome>();
    const performSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const { result, revisionRef } = setup(performSave);

    act(() => {
      result.current.requestSave();
    });
    revisionRef.current = 2;
    await act(async () => {
      d1.resolve(saved()); // write 1 done → fresh pass 2 starts
    });
    expect(result.current.status).toEqual({ state: 'saving' }); // not stuck on 'saved'
    await act(async () => {
      d2.resolve(saved());
    });
    expect(result.current.status).toEqual({ state: 'saved' });
  });

  it('flush waits for a queued fresh pass, not just the in-flight write', async () => {
    const d1 = deferred<SaveOutcome>();
    const d2 = deferred<SaveOutcome>();
    const performSave = vi
      .fn<() => Promise<SaveOutcome>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const { result, revisionRef } = setup(performSave);

    act(() => {
      result.current.requestSave();
    });
    revisionRef.current = 2; // a fresh pass will be queued when write 1 finishes
    let flushed = false;
    act(() => {
      void result.current.flush().then(() => {
        flushed = true;
      });
    });

    await act(async () => {
      d1.resolve(saved()); // write 1 done; fresh pass 2 begins
    });
    await act(async () => {});
    expect(flushed).toBe(false); // flush must still be waiting for the fresh pass

    await act(async () => {
      d2.resolve(saved());
    });
    await act(async () => {});
    expect(flushed).toBe(true);
  });

  it('lets a successful exclusive cover a same-revision default request (no redundant write)', async () => {
    // Behaviour (a): default save pending → Save As at the same revision covers it,
    // so the default never runs a redundant write and resolves with the Save As
    // outcome.
    const exclusive = deferred<SaveOutcome>();
    const exclusiveJob = vi.fn(() => exclusive.promise);
    const performSave = vi.fn(async () => saved());
    const { result } = setup(performSave); // revision stays 1

    act(() => {
      result.current.runExclusive(exclusiveJob);
    });
    let defaultResult!: Promise<SaveOutcome>;
    act(() => {
      defaultResult = result.current.requestSave(); // same revision, no intervening edit
    });
    expect(performSave).not.toHaveBeenCalled();

    const exclusiveOutcome: SaveOutcome = {
      status: 'saved',
      path: '/saved-as.md',
      docHash: 'hb',
      sidecar: { state: 'absent' },
    };
    await act(async () => {
      exclusive.resolve(exclusiveOutcome);
    });
    await act(async () => {});

    expect(performSave).not.toHaveBeenCalled(); // covered → no redundant default write
    expect(await defaultResult).toMatchObject({ status: 'saved', path: '/saved-as.md' });
  });

  it('runs a default pass after an exclusive when a newer edit is not covered', async () => {
    // Behaviour (b): an edit during the Save As write leaves the latest revision
    // uncovered, so exactly one fresh default pass runs afterwards.
    const exclusive = deferred<SaveOutcome>();
    const exclusiveJob = vi.fn(() => exclusive.promise);
    const performSave = vi.fn(async () => saved());
    const { result, revisionRef } = setup(performSave); // exclusive startRevision = 1

    act(() => {
      result.current.runExclusive(exclusiveJob);
    });
    revisionRef.current = 2; // edit during the exclusive write
    let defaultResult!: Promise<SaveOutcome>;
    act(() => {
      defaultResult = result.current.requestSave(); // minRevision 2, uncovered by cov=1
    });
    expect(performSave).not.toHaveBeenCalled();

    await act(async () => {
      exclusive.resolve(saved()); // covers rev 1; rev 2 > 1 → one default pass
    });
    await act(async () => {});
    expect(performSave).toHaveBeenCalledTimes(1);
    expect((await defaultResult).status).toBe('saved');
  });

  it('a cancelled exclusive job does not erase a queued default fresh pass', async () => {
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
    revisionRef.current = 2; // change during write 1 → fresh pass will be queued
    const exclusiveJob = vi.fn(async (): Promise<SaveOutcome> => ({ status: 'cancelled' }));
    act(() => {
      result.current.runExclusive(exclusiveJob); // e.g. Save As the user then cancels
    });

    await act(async () => {
      d1.resolve(saved()); // write 1 done; exclusive (cancelled) runs; fresh pass must survive
    });
    await act(async () => {});
    expect(exclusiveJob).toHaveBeenCalledTimes(1);
    expect(performSave).toHaveBeenCalledTimes(2); // the fresh pass ran despite the cancel

    await act(async () => {
      d2.resolve(saved());
    });
  });

  it('reads payload at write-begin (observes the revision at begin, not at request)', async () => {
    const observed: number[] = [];
    const first = deferred<SaveOutcome>();
    const second = deferred<SaveOutcome>();
    const revisionRef = { current: 1 };
    const performSave = vi.fn(() => {
      observed.push(revisionRef.current); // what the payload snapshot would see
      return observed.length === 1 ? first.promise : second.promise;
    });
    const { result } = renderHook(() =>
      useSaveCoordinator({ performSave, getRevision: () => revisionRef.current }),
    );

    act(() => {
      result.current.requestSave(); // write 1 begins now → observes revision 1
    });
    expect(observed).toEqual([1]);

    revisionRef.current = 5; // bump while write 1 is in flight
    act(() => {
      result.current.requestSave(); // minRevision 5, queued
    });
    await act(async () => {
      first.resolve(saved()); // write 2 begins → observes the CURRENT revision (5), not 1
    });
    expect(observed).toEqual([1, 5]);

    await act(async () => {
      second.resolve(saved());
    });
  });

  describe('saveAndDrain (autosave seam)', () => {
    it('returns the terminal outcome + covered revision of a clean save', async () => {
      const performSave = vi.fn(async () => saved());
      const { result } = setup(performSave); // revision 1

      let drained!: { outcome: SaveOutcome; revision: number };
      await act(async () => {
        drained = await result.current.saveAndDrain();
      });
      expect(drained.outcome.status).toBe('saved');
      expect(drained.revision).toBe(1); // covered watermark
      expect(performSave).toHaveBeenCalledTimes(1);
    });

    it('does NOT advance the covered revision on review-blocked (nothing was written)', async () => {
      const performSave = vi.fn(async () => reviewBlocked());
      const { result } = setup(performSave); // revision 1

      let drained!: { outcome: SaveOutcome; revision: number };
      await act(async () => {
        drained = await result.current.saveAndDrain();
      });
      expect(drained.outcome.status).toBe('review-blocked');
      // The watermark starts below 0 and only a SUCCESSFUL write advances it, so the
      // edit at revision 1 stays uncovered — a later save still runs.
      expect(drained.revision).toBe(-1);
    });

    it('reports a FRESH-PASS failure, never the first write’s success (Codex pinned)', async () => {
      // Edit during pass 1 → pass 2 fails → saveAndDrain must report failed, not saved,
      // and must not issue a pass 3.
      const d1 = deferred<SaveOutcome>();
      const d2 = deferred<SaveOutcome>();
      const performSave = vi
        .fn<() => Promise<SaveOutcome>>()
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const { result, revisionRef } = setup(performSave);

      let drained!: Promise<{ outcome: SaveOutcome; revision: number }>;
      act(() => {
        drained = result.current.saveAndDrain(); // write 1, startRevision = 1
      });
      revisionRef.current = 2; // edit while pass 1 is in flight

      await act(async () => {
        d1.resolve(saved()); // pass 1 saved; rev 2 > 1 → fresh pass 2 begins
      });
      expect(performSave).toHaveBeenCalledTimes(2);

      await act(async () => {
        d2.resolve(failed()); // fresh pass 2 FAILS
      });
      const res = await drained;
      expect(res.outcome.status).toBe('failed'); // terminal outcome, not the pass-1 'saved'
      expect(performSave).toHaveBeenCalledTimes(2); // never a pass 3
    });

    it('surfaces a first-write failure directly', async () => {
      const performSave = vi.fn(async () => failed());
      const { result } = setup(performSave);
      let drained!: { outcome: SaveOutcome; revision: number };
      await act(async () => {
        drained = await result.current.saveAndDrain();
      });
      expect(drained.outcome.status).toBe('failed');
    });

    it('does not return a stale outcome from an earlier drain', async () => {
      // A first drain fails; a second drain (with the fault cleared) must report saved,
      // not the previous failure lingering in lastOutcomeRef.
      const performSave = vi
        .fn<() => Promise<SaveOutcome>>()
        .mockResolvedValueOnce(failed())
        .mockResolvedValueOnce(saved());
      const { result, revisionRef } = setup(performSave);

      let first!: { outcome: SaveOutcome; revision: number };
      await act(async () => {
        first = await result.current.saveAndDrain();
      });
      expect(first.outcome.status).toBe('failed');

      revisionRef.current = 2;
      let second!: { outcome: SaveOutcome; revision: number };
      await act(async () => {
        second = await result.current.saveAndDrain();
      });
      expect(second.outcome.status).toBe('saved');
      expect(second.revision).toBe(2);
    });

    it('drains a queued fresh pass and reports its (successful) terminal outcome', async () => {
      const d1 = deferred<SaveOutcome>();
      const d2 = deferred<SaveOutcome>();
      const performSave = vi
        .fn<() => Promise<SaveOutcome>>()
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const { result, revisionRef } = setup(performSave);

      let drained!: Promise<{ outcome: SaveOutcome; revision: number }>;
      act(() => {
        drained = result.current.saveAndDrain(); // startRevision 1
      });
      revisionRef.current = 2;
      await act(async () => {
        d1.resolve(saved()); // fresh pass 2 begins at revision 2
      });
      await act(async () => {
        d2.resolve(saved()); // covers revision 2 → drain settles
      });
      const res = await drained;
      expect(res.outcome.status).toBe('saved');
      expect(res.revision).toBe(2); // watermark reached the latest edit
      expect(performSave).toHaveBeenCalledTimes(2);
    });
  });
});
