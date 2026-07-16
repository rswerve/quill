import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveOutcome } from './useFileManager';

const IDLE_MS = 2000; // save this long after the last edit…
const MAX_MS = 15000; // …but never wait longer than this while edits keep coming.
const BACKOFF_MS = [5000, 15000, 60000]; // retry schedule after a failed autosave.

/**
 * Coarse autosave state for a per-tab indicator. `pending` = a debounce is running;
 * `stopped` = an autosave hit a conflict or block and won't retry until the user
 * resolves it; `failed` = a transient error, retrying after `retryInMs`.
 */
export type AutosaveStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'failed'; retryInMs: number }
  | { state: 'stopped' };

interface Options {
  /**
   * Autosave runs only when this is true — Tauri present, a real saved path, and
   * (later) any user preference. When it flips false the scheduler cancels its timers.
   */
  enabled: boolean;
  /**
   * Whether an autosave is currently eligible: a saved path that is not already in a
   * conflict the user must resolve. Re-checked at fire time, not just at schedule time.
   */
  isEligible: () => boolean;
  /**
   * Save through the coordinator and drain to full quiescence, returning the FINAL
   * outcome plus the highest change-revision now on disk. Wired to the coordinator's
   * `saveAndDrain`, so a follow-up pass's failure/conflict is what the scheduler sees.
   */
  performAutosave: () => Promise<{ outcome: SaveOutcome; revision: number }>;
  /** The current change-revision — read at fire time to detect edits during a write. */
  getRevision: () => number;
  /**
   * A value that changes whenever the document IDENTITY changes (path via Save As,
   * New, Open, or restore). A change bumps the scheduler epoch: it cancels every timer,
   * drops any in-flight completion, and resets backoff / no-op / pause state, so no
   * timer or late save armed for the previous document can fire against a different one.
   */
  resetKey: string | null;
}

export interface AutosaveController {
  /** Signal an edit — (re)arms the idle debounce and the max-wait ceiling. */
  notifyChange: () => void;
  /**
   * Save now if eligible and there is unsaved work, and resolve once it settles —
   * joining an already-running autosave rather than skipping it. Used on blur /
   * tab-deactivate / stream-end / close / quit.
   */
  flush: () => Promise<void>;
  status: AutosaveStatus;
}

/**
 * Debounced autosave scheduler. It owns only WHEN to save; the coordinator owns the
 * save itself (serialization, coalescing, conflict detection, quiescence). Keyed on an
 * imperative change signal — NOT React state — so it doesn't re-render per keystroke,
 * and NOT on isDirty (which stays true and so can't debounce successive edits).
 */
export function useAutosave({
  enabled,
  isEligible,
  performAutosave,
  getRevision,
  resetKey,
}: Options): AutosaveController {
  const isEligibleRef = useRef(isEligible);
  isEligibleRef.current = isEligible;
  const performRef = useRef(performAutosave);
  performRef.current = performAutosave;
  const getRevisionRef = useRef(getRevision);
  getRevisionRef.current = getRevision;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffIndex = useRef(0);
  // The highest revision an autosave has persisted. Skipping when the current revision
  // still equals it is a safe no-op (nothing changed locally); the CONTENT-byte no-op
  // that must never skip the fingerprint check lives in the native op, not here.
  const savedRevision = useRef<number | null>(null);
  // A latched pause: `conflict` (the resolution banner is up) or `blocked` (a protected
  // sidecar / unknown baseline). A bare edit must NOT re-arm while latched. A resolved
  // conflict (eligibility regained) clears it; a block waits for an identity change.
  const pauseReason = useRef<'conflict' | 'blocked' | null>(null);
  // Single-flight for the drive loop, plus its in-flight promise (so flush can JOIN it)
  // and a rerun request (a fire during a running save schedules one more pass).
  const runningRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const rerunRef = useRef(false);
  // Bumped on every resetKey change. A drive captures the epoch at start and drops its
  // result if the epoch moved on, so a save that resolves after the document changed
  // identity cannot mutate the new document's status / no-op / single-flight state.
  const epochRef = useRef(0);
  const [status, setStatus] = useState<AutosaveStatus>({ state: 'idle' });

  const clearTimers = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (maxTimer.current) clearTimeout(maxTimer.current);
    if (backoffTimer.current) clearTimeout(backoffTimer.current);
    idleTimer.current = null;
    maxTimer.current = null;
    backoffTimer.current = null;
  }, []);

  // Stable indirection so the backoff timer and flush can re-enter the drive loop
  // without a dependency cycle (drive is defined once, below).
  const driveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Whether a save may run right now: enabled, eligible, and not latched on a pause.
  const canSave = useCallback(
    () => enabledRef.current && isEligibleRef.current() && !pauseReason.current,
    [],
  );

  // Apply one completed save's outcome to status / backoff / pause state, and report
  // whether the drive loop may continue ('continue', only after a success) or must stop.
  const applyResult = useCallback(
    (result: { outcome: SaveOutcome; revision: number }): 'continue' | 'break' => {
      const { outcome } = result;
      if (outcome.status === 'saved') {
        savedRevision.current = result.revision;
        backoffIndex.current = 0;
        setStatus({ state: 'saved' });
        // Loop only if a concurrent fire requested a rerun; the gate's revision check
        // then suppresses a redundant write once the coordinator's drain has caught up.
        return 'continue';
      }
      if (outcome.status === 'conflict' || outcome.status === 'blocked') {
        // The user must resolve this (conflict banner / protected sidecar). Latch and
        // stop hammering it; a later edit will not re-arm until the cause clears.
        pauseReason.current = outcome.status;
        setStatus({ state: 'stopped' });
        return 'break';
      }
      if (outcome.status === 'cancelled') {
        // No write happened and it is NOT an I/O failure (e.g. a dialog dismissed):
        // do not enter the retry loop. Settle to idle.
        setStatus({ state: 'idle' });
        return 'break';
      }
      // failed → a transient I/O error. Back off, then retry; edits meanwhile must NOT
      // reset the debounce and bypass this backoff (notifyChange guards on it).
      const delay = BACKOFF_MS[Math.min(backoffIndex.current, BACKOFF_MS.length - 1)];
      backoffIndex.current += 1;
      setStatus({ state: 'failed', retryInMs: delay });
      if (backoffTimer.current) clearTimeout(backoffTimer.current);
      backoffTimer.current = setTimeout(() => {
        backoffTimer.current = null;
        void driveRef.current();
      }, delay);
      return 'break';
    },
    [],
  );

  // Run autosaves until nothing is left to do. Single-flight: a call made while a drive
  // is running JOINS it (awaits the in-flight promise) and requests one more pass, so a
  // late edit is never dropped and flush truly waits out the save.
  const drive = useCallback(async (): Promise<void> => {
    if (runningRef.current) {
      rerunRef.current = true;
      await inFlightRef.current;
      return;
    }
    runningRef.current = true;
    let release!: () => void;
    inFlightRef.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const epoch = epochRef.current;
    try {
      do {
        rerunRef.current = false;
        const revision = getRevisionRef.current();
        // Gate each pass: disabled/ineligible/latched, or nothing new since the last
        // success. A latch keeps its 'stopped' status; else settle a stale 'saving'.
        if (!canSave() || revision === savedRevision.current) {
          if (!pauseReason.current) {
            setStatus((s) => (s.state === 'saving' ? { state: 'idle' } : s));
          }
          break;
        }
        setStatus({ state: 'saving' });
        let result: { outcome: SaveOutcome; revision: number };
        try {
          result = await performRef.current();
        } catch (error) {
          result = { outcome: { status: 'failed', message: String(error) }, revision };
        }
        // The document changed identity while we were writing — this save belongs to a
        // document that is gone. Drop it without touching the new document's state.
        if (epoch !== epochRef.current) return;
        if (applyResult(result) === 'break') break;
      } while (rerunRef.current);
    } finally {
      // Only the drive that still owns the current epoch clears the single-flight; a
      // superseded drive leaves the reset effect's fresh state intact, but always
      // releases its own in-flight promise so any joiner unblocks.
      if (epoch === epochRef.current) {
        runningRef.current = false;
        inFlightRef.current = null;
      }
      release();
    }
  }, [canSave, applyResult]);
  driveRef.current = drive;

  const notifyChange = useCallback(() => {
    if (!enabledRef.current) return;
    // Latched: a bare edit must not re-arm a blocked/conflicted save. A conflict that
    // the user has since resolved (eligibility regained) clears the latch and resumes;
    // a block stays latched until the document identity changes (resetKey).
    if (pauseReason.current) {
      if (pauseReason.current === 'conflict' && isEligibleRef.current()) {
        pauseReason.current = null;
      } else {
        return;
      }
    }
    // A transient-failure backoff is pending: let it run. An edit must not reset the
    // debounce and issue an immediate save that bypasses the backoff.
    if (backoffTimer.current) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      if (maxTimer.current) {
        clearTimeout(maxTimer.current);
        maxTimer.current = null;
      }
      void driveRef.current();
    }, IDLE_MS);
    if (!maxTimer.current) {
      maxTimer.current = setTimeout(() => {
        maxTimer.current = null;
        if (idleTimer.current) {
          clearTimeout(idleTimer.current);
          idleTimer.current = null;
        }
        void driveRef.current();
      }, MAX_MS);
    }
    setStatus((current) => (current.state === 'saving' ? current : { state: 'pending' }));
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    // Cancel the debounce/backoff and save now, JOINING an in-flight autosave so we
    // resolve only once the save actually settles (close/quit depend on this).
    clearTimers();
    if (!enabledRef.current) return;
    await driveRef.current();
  }, [clearTimers]);

  // Identity change: invalidate the previous document's timers and any in-flight or
  // late-arriving save, and reset all per-document scheduler state.
  useEffect(() => {
    epochRef.current += 1;
    clearTimers();
    runningRef.current = false;
    inFlightRef.current = null;
    rerunRef.current = false;
    backoffIndex.current = 0;
    savedRevision.current = null;
    pauseReason.current = null;
    setStatus({ state: 'idle' });
  }, [resetKey, clearTimers]);

  // When disabled (no path, non-Tauri), cancel pending work and drop any latch so a
  // later re-enable starts clean and re-detects a conflict if one still exists.
  useEffect(() => {
    if (!enabled) {
      clearTimers();
      backoffIndex.current = 0;
      pauseReason.current = null;
      setStatus({ state: 'idle' });
    }
  }, [enabled, clearTimers]);

  // Cancel timers on unmount so a torn-down tab never fires a save.
  useEffect(() => () => clearTimers(), [clearTimers]);

  return { notifyChange, flush, status };
}
