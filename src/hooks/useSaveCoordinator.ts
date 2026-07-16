import { useCallback, useRef, useState } from 'react';
import type { SaveOutcome } from './useFileManager';

/**
 * Coarse save state for the UI. Derived from the last write's typed outcome; a
 * `cancelled` outcome (no write happened) leaves the coordinator idle.
 */
export type SaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'blocked' }
  | { state: 'conflict' }
  | { state: 'failed'; message: string };

export interface SaveCoordinator {
  /**
   * Coalescing, single-flight save to the current path. Resolves with the outcome
   * of a write that captured a change-revision >= the revision at call time, so a
   * caller's latest edit is guaranteed on disk when its promise resolves. Multiple
   * requests issued while a write is in flight collapse into ONE follow-up write.
   */
  requestSave: () => Promise<SaveOutcome>;
  /**
   * Run a distinct save job (e.g. Save As, which prompts and changes the target
   * path) with exclusive access: it waits for any in-flight save and blocks new
   * saves until it finishes, so writes never overlap or race the path change.
   */
  runExclusive: (job: () => Promise<SaveOutcome>) => Promise<SaveOutcome>;
  /**
   * Await quiescence: resolves once no save is running or queued. Does NOT force a
   * new write when idle. Used to serialize open/new/close/quit against saves.
   */
  flush: () => Promise<void>;
  status: SaveStatus;
}

interface Options {
  /**
   * Perform ONE save to the current path with the CURRENT live payload, returning
   * the typed outcome. The coordinator calls this at write-BEGIN, so it must read
   * its payload synchronously (before its first await) to match the revision
   * captured at the same instant.
   */
  performSave: () => Promise<SaveOutcome>;
  /**
   * The current monotonic change-revision (document + review + chat mutations).
   * Read at request time and at each write's begin to decide whether a completed
   * write covered a given request.
   */
  getRevision: () => number;
}

interface DefaultWaiter {
  minRevision: number;
  resolve: (outcome: SaveOutcome) => void;
}

interface ExclusiveJob {
  job: () => Promise<SaveOutcome>;
  resolve: (outcome: SaveOutcome) => void;
  reject: (error: unknown) => void;
}

function statusFor(outcome: SaveOutcome): SaveStatus {
  switch (outcome.status) {
    case 'saved':
      return { state: 'saved' };
    case 'blocked':
      return { state: 'blocked' };
    case 'conflict':
      return { state: 'conflict' };
    case 'failed':
      return { state: 'failed', message: outcome.message };
    case 'cancelled':
      return { state: 'idle' };
  }
}

/**
 * Per-tab save coordinator. Every save route funnels through here so writes are
 * serialized (never overlapping), coalesced (a burst of requests → one write), and
 * revision-covered (a request resolves only once its edit is on disk). It performs
 * NO scheduling of its own — autosave (a later phase) drives it by calling
 * requestSave; this phase is manual-only.
 */
export function useSaveCoordinator({ performSave, getRevision }: Options): SaveCoordinator {
  // Keep the latest closures without re-creating the coordinator identity.
  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;
  const getRevisionRef = useRef(getRevision);
  getRevisionRef.current = getRevision;

  const runningRef = useRef(false);
  const defaultWaitersRef = useRef<DefaultWaiter[]>([]);
  const exclusiveQueueRef = useRef<ExclusiveJob[]>([]);
  // A single "the document changed while the last write was in flight" slot. It
  // forces exactly ONE more default pass so the on-disk state catches up to the
  // latest edit — even with no second requestSave. Re-derived from the coverage
  // watermark after any SUCCESSFUL write (a successful Save As retires it if it
  // covered the edit); a TERMINAL default clears it, while a cancelled/failed
  // exclusive leaves it untouched so a fresh pass owed to the original path survives.
  const freshPassPendingRef = useRef(false);
  // The highest start-revision any SUCCESSFUL write (default or exclusive) has
  // covered. A request/edit at revision R is on disk once coveredRevision >= R.
  // A successful Save As advances this too, so it resolves default waiters it
  // covered and retires a now-redundant fresh pass. Starts below revision 0.
  const coveredRevisionRef = useRef(-1);
  // Resolves when the currently-running drain loop goes idle. Replaced per loop.
  const idleRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });

  const pump = useCallback(() => {
    if (runningRef.current) return; // a drain loop is already running; it will pick up new work
    runningRef.current = true;
    let resolveIdle!: () => void;
    idleRef.current = {
      promise: new Promise<void>((resolve) => {
        resolveIdle = resolve;
      }),
      resolve: () => resolveIdle(),
    };
    void (async () => {
      // Resolve every default waiter the coverage watermark now satisfies (its
      // requested edit is on disk), leaving newer waiters to a later pass.
      const resolveCoveredWaiters = (outcome: SaveOutcome) => {
        const covered = coveredRevisionRef.current;
        const resolved = defaultWaitersRef.current.filter((w) => w.minRevision <= covered);
        defaultWaitersRef.current = defaultWaitersRef.current.filter(
          (w) => w.minRevision > covered,
        );
        for (const waiter of resolved) waiter.resolve(outcome);
      };
      try {
        while (
          exclusiveQueueRef.current.length > 0 ||
          defaultWaitersRef.current.length > 0 ||
          freshPassPendingRef.current
        ) {
          setStatus({ state: 'saving' }); // every pass/job re-enters the saving state
          // Exclusive jobs (Save As) drain first and run entirely alone. The dialog
          // is modal, so the revision captured here still reflects the content the
          // job snapshots after it.
          if (exclusiveQueueRef.current.length > 0) {
            const { job, resolve, reject } = exclusiveQueueRef.current.shift()!;
            const startRevision = getRevisionRef.current();
            try {
              const outcome = await job();
              setStatus(statusFor(outcome));
              if (outcome.status === 'saved') {
                // A successful Save As put the current state on disk: advance the
                // watermark, resolve the default waiters it covered, and re-derive
                // the fresh-pass need — retiring a now-redundant pass, or keeping
                // one only for edits made during its write.
                coveredRevisionRef.current = Math.max(coveredRevisionRef.current, startRevision);
                resolveCoveredWaiters(outcome);
                freshPassPendingRef.current = getRevisionRef.current() > coveredRevisionRef.current;
              }
              // A terminal exclusive (cancelled / failed) touches neither coverage
              // nor the fresh-pass slot, so a fresh pass owed to the original path
              // survives a cancelled Save As.
              resolve(outcome);
            } catch (error) {
              setStatus({ state: 'failed', message: String(error) });
              reject(error);
            }
            continue;
          }
          // One coalesced default save. Consume the fresh-pass slot (this IS that
          // pass if it was set) and capture the revision at write-BEGIN, in the same
          // synchronous step as performSave reads its payload.
          freshPassPendingRef.current = false;
          const startRevision = getRevisionRef.current();
          let outcome: SaveOutcome;
          try {
            outcome = await performSaveRef.current();
          } catch (error) {
            outcome = { status: 'failed', message: String(error) };
          }
          setStatus(statusFor(outcome));
          if (outcome.status === 'saved') {
            coveredRevisionRef.current = Math.max(coveredRevisionRef.current, startRevision);
            resolveCoveredWaiters(outcome);
            // If the document moved on past the watermark, schedule exactly one more
            // pass so the on-disk state reaches the latest edit — even with no
            // second requestSave.
            freshPassPendingRef.current = getRevisionRef.current() > coveredRevisionRef.current;
          } else {
            // Terminal (failed / blocked / conflict / cancelled): resolve ALL pending
            // default waiters with this outcome and STOP. The slot stays cleared, so
            // there is no unbacked retry — retry/backoff and conflict resolution are
            // later phases; a new explicit requestSave starts a fresh loop.
            const pending = defaultWaitersRef.current;
            defaultWaitersRef.current = [];
            for (const waiter of pending) waiter.resolve(outcome);
          }
        }
      } finally {
        runningRef.current = false;
        const idle = idleRef.current;
        idleRef.current = null;
        idle?.resolve();
        // Leave a terminal outcome status in place; only clear a dangling 'saving'.
        setStatus((current) => (current.state === 'saving' ? { state: 'idle' } : current));
      }
    })();
  }, []);

  const requestSave = useCallback((): Promise<SaveOutcome> => {
    const minRevision = getRevisionRef.current();
    const promise = new Promise<SaveOutcome>((resolve) => {
      defaultWaitersRef.current.push({ minRevision, resolve });
    });
    pump();
    return promise;
  }, [pump]);

  const runExclusive = useCallback(
    (job: () => Promise<SaveOutcome>): Promise<SaveOutcome> => {
      const promise = new Promise<SaveOutcome>((resolve, reject) => {
        exclusiveQueueRef.current.push({ job, resolve, reject });
      });
      pump();
      return promise;
    },
    [pump],
  );

  const flush = useCallback(async (): Promise<void> => {
    // Wait out every drain loop until one leaves the coordinator idle. New work
    // added while draining keeps the loop alive, so we re-await until it settles.
    while (runningRef.current) {
      await idleRef.current?.promise;
    }
  }, []);

  return { requestSave, runExclusive, flush, status };
}
