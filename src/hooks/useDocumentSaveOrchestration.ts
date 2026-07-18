import { useCallback, useState, type MutableRefObject, type RefObject } from 'react';
import { useSaveCoordinator } from './useSaveCoordinator';
import { setImageBaseDir } from '../extensions/MarkdownImage';
import { dirname } from '../utils/path';
import {
  rememberContextFolderPermission,
  rememberSessionPermission,
} from '../utils/sidecarPermissions';
import type { SaveOutcome } from './useFileManager';
import type { CanonicalSaveState } from '../utils/canonicalPersistence';
import type { DraftSnapshot } from './useDraftAutosave';
import type { EditorRef } from '../components/Editor';
import type { AnnotationKind } from '../extensions/AnnotationFocus';
import type {
  AISessionBinding,
  Comment,
  DocumentChatThread,
  StructuralSuggestionRecord,
  Suggestion,
} from '../types';

/** The manual-save "Save blocked" notice, pluralized for the offending records. */
export function reviewBlockedNotice(
  unmappable: ReadonlyArray<{ kind: 'comment' | 'suggestion'; id: string }>,
): { title: string; message: string } {
  const comments = unmappable.filter((u) => u.kind === 'comment').length;
  const suggestions = unmappable.length - comments;
  const parts: string[] = [];
  if (comments) parts.push(`${comments} comment${comments === 1 ? '' : 's'}`);
  if (suggestions) parts.push(`${suggestions} suggestion${suggestions === 1 ? '' : 's'}`);
  const verb = unmappable.length === 1 ? 'covers' : 'cover';
  const pointer = unmappable.length === 1 ? "It's highlighted" : 'The first is highlighted';
  return {
    title: "Save blocked — an annotation can't be anchored",
    message:
      `${parts.join(' and ')} ${verb} text that changes shape when the file is written ` +
      '(for example, extra spaces that collapse on save), so Quill can’t save without ' +
      `risking a mismatched anchor. ${pointer} — adjust or remove it, then save again.`,
  };
}

type SaveFileFn = (
  content: string,
  comments: Comment[],
  suggestions: Suggestion[],
  aiSession: AISessionBinding | null,
  contextFolder: string | null,
  forcePath?: string,
  chat?: DocumentChatThread | null,
  structural?: StructuralSuggestionRecord[],
) => Promise<SaveOutcome>;

type SaveFileAsFn = (
  content: string,
  comments: Comment[],
  suggestions: Suggestion[],
  aiSession: AISessionBinding | null,
  contextFolder: string | null,
  chat?: DocumentChatThread | null,
  requestPathOwnership?: (path: string) => boolean,
  structural?: StructuralSuggestionRecord[],
) => Promise<SaveOutcome>;

export interface DocumentSaveOrchestrationDeps {
  filePath: string | null;
  /** The composed pre-write capture primitive (reads the live review-state graph). */
  captureCanonicalSaveState: () => CanonicalSaveState;
  getChangeRevision: () => number;
  saveFile: SaveFileFn;
  saveFileAs: SaveFileAsFn;
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
  documentChat: { getThread: (sessionId: string) => DocumentChatThread };
  editorRef: RefObject<EditorRef | null>;
  tabId: string;
  /** Shared by reference with the component: performSaveAs nulls it on a path change. */
  lastGoodWorkspaceSnapshotRef: MutableRefObject<DraftSnapshot | null>;
  /** Stays in the component (also keys autosave's resetKey); bumped on a manual reconcile. */
  bumpSchedulerGen: () => void;
  /** Stays in the component (also written by load/new/restore). */
  setLastSavedAt: (value: number | null) => void;
  onRecentFile: (path: string) => void;
  onRequestSavePath: (tabId: string, path: string) => boolean;
  /** Injected presentation callbacks — the hook is not a presentation controller. */
  showError: (title: string, message: string) => void;
  focusAnnotation: (annotation: { kind: AnnotationKind; id: string }) => void;
}

/**
 * The save/conflict ORCHESTRATION for one document tab, lifted out of DocumentTab so the
 * god-component shrinks and the save routes become independently testable. It owns the three
 * save routes (Save / Save As / Overwrite-conflict), the save coordinator, the manual-outcome
 * handling, and the external-conflict STATE. It deliberately does NOT own: markDirty, autosave,
 * snapshot capture/restore, or load/open/new — those stay in the component (autosave consumes
 * the returned `saveAndDrain`; open/new consume `runExclusive`/`flushSaves`; reload-conflict
 * lives in the component and drives the returned `runConflictResolution`).
 *
 * The correctness-critical counters (change-revision, covered-revision, save-epoch, baselines)
 * are already owned by useFileManager / useSaveCoordinator / useAutosave — this hook only wires
 * them. `saveConflict` moves here but is returned so the component's autosave-eligibility,
 * meta/chrome effects, and ConflictBanner keep reading it in the same render.
 */
export function useDocumentSaveOrchestration(deps: DocumentSaveOrchestrationDeps) {
  const {
    filePath,
    captureCanonicalSaveState,
    getChangeRevision,
    saveFile,
    saveFileAs,
    aiSession,
    contextFolder,
    documentChat,
    editorRef,
    tabId,
    lastGoodWorkspaceSnapshotRef,
    bumpSchedulerGen,
    setLastSavedAt,
    onRecentFile,
    onRequestSavePath,
    showError,
    focusAnnotation,
  } = deps;

  // External-conflict state for this tab: which on-disk file changed underneath us.
  // Persists through edits and failed/cancelled resolutions; cleared only by a
  // successful Overwrite / Save-a-Copy / Reload, or by New / a successful Open.
  const [saveConflict, setSaveConflict] = useState<{ which: 'doc' | 'sidecar' } | null>(null);
  // True while a resolution job (Overwrite / Save-a-Copy / Reload) is running, so the
  // banner disables its actions. A bump of `conflictFlash` re-announces the banner
  // when a conflicted Cmd+S is pressed (no write happens).
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [conflictFlash, setConflictFlash] = useState(0);

  /** Named clear action for the component's external clear sites (successful Open, New). */
  const clearSaveConflict = useCallback(() => setSaveConflict(null), []);

  const structuralSaveFailure = useCallback(
    (error: string): SaveOutcome => ({
      status: 'failed',
      message:
        `This document has a structural suggestion that can't be saved safely (${error}). ` +
        `Nothing was written — undo the change or reopen the file, then try again.`,
      ...(filePath ? { path: filePath } : {}),
    }),
    [filePath],
  );

  // Shared by every write (manual AND autosave, via performSave): raise the persistent
  // conflict banner when the on-disk file changed underneath us. This is wanted for both
  // sources — autosave detecting an external change is exactly when the banner should
  // appear. `blocked` and `failed` are NOT presented here: a background write must never
  // pop a modal (see presentManualSaveFailure). `saved`/`cancelled` are silent.
  const notifySaveOutcome = useCallback((outcome: SaveOutcome) => {
    if (outcome.status === 'conflict') {
      // Sticky until the user resolves it (Overwrite / Save a Copy / Reload).
      setSaveConflict({ which: outcome.which });
    }
  }, []);

  // Present a save failure LOUDLY — only from a manual save. Autosave leaves these to
  // the footer/tab status (blocked → 'stopped', failed → 'retrying') so a background
  // write never interrupts the user; a manual Cmd+S promotes them to these modals.
  const presentManualSaveFailure = useCallback(
    (outcome: SaveOutcome) => {
      if (outcome.status === 'blocked' && outcome.reason === 'sidecar-protected') {
        showError(
          'Comments not saved',
          'The document text was saved, but its comments and suggestions could not be ' +
            "written: the existing .comments.json file is unreadable and Quill won't " +
            'overwrite it. Recover or remove that file, then save again.',
        );
      } else if (outcome.status === 'blocked' && outcome.reason === 'structural-protected') {
        showError(
          'Nothing saved — structural suggestions file is unreadable',
          "This document's .comments.json has a damaged structural-suggestions block, which " +
            'may hold the only copy of a proposed change. Quill did NOT save (neither the ' +
            'document nor the comments file) so the original text those suggestions point at ' +
            'stays intact. Repair or remove that file, then save again.',
        );
      } else if (outcome.status === 'blocked') {
        // baseline-unknown: a recovered draft with no trustworthy on-disk baseline.
        showError(
          "Couldn't save — this file's state is unknown",
          "Quill recovered unsaved work for this file but can't tell whether the file on " +
            "disk changed while Quill was closed, so it won't overwrite it. Reopen the file " +
            'to reconcile, or use Save As to write your recovered work to a new file.',
        );
      } else if (outcome.status === 'failed') {
        // Name the destination that failed when we know it (actionable), else just why.
        const detail = outcome.path ? `${outcome.path}\n\n${outcome.message}` : outcome.message;
        showError('Could not save file', detail);
      } else if (outcome.status === 'review-blocked') {
        // Focus the first offending annotation so the user can find and fix it.
        const [first] = outcome.unmappable;
        if (first) focusAnnotation({ kind: first.kind, id: first.id });
        const notice = reviewBlockedNotice(outcome.unmappable);
        showError(notice.title, notice.message);
      }
    },
    [showError, focusAnnotation],
  );

  // The coordinator's default-save job: capture the live payload NOW (at
  // write-begin) and save to the current path. Post-write side effects and
  // notices live here so they run exactly once per write, even when several
  // coalesced requests share it.
  const performSave = useCallback(async (): Promise<SaveOutcome> => {
    // Capture BOTH axes in one composed, fail-closed primitive before any byte is written:
    // the structural source payload (fail-closed on a quarantined/incomplete union) and the
    // inline anchors normalized + captured against the reconstructed canonical review union.
    const state = captureCanonicalSaveState();
    if (!state.ok) {
      if (state.reason === 'structural') return structuralSaveFailure(state.error);
      const outcome: SaveOutcome = { status: 'review-blocked', unmappable: state.unmappable };
      notifySaveOutcome(outcome);
      return outcome;
    }
    const outcome = await saveFile(
      state.markdown,
      state.comments,
      state.suggestions,
      aiSession,
      contextFolder,
      undefined,
      aiSession ? documentChat.getThread(aiSession.sessionId) : null,
      state.structural,
    );
    if (outcome.status === 'saved') {
      rememberSessionPermission(window.localStorage, outcome.path, aiSession);
      rememberContextFolderPermission(window.localStorage, outcome.path, contextFolder);
      setLastSavedAt(Date.now());
    }
    notifySaveOutcome(outcome);
    return outcome;
  }, [
    saveFile,
    captureCanonicalSaveState,
    structuralSaveFailure,
    aiSession,
    contextFolder,
    documentChat,
    notifySaveOutcome,
    setLastSavedAt,
  ]);

  const {
    requestSave,
    runExclusive,
    flush: flushSaves,
    saveAndDrain,
  } = useSaveCoordinator({
    performSave,
    getRevision: getChangeRevision,
  });

  // Save As is a distinct job (it prompts and changes the target path), so it runs
  // through the coordinator's exclusive lane — waiting for any in-flight save and
  // blocking new saves until it finishes — so writes never overlap the path change.
  const performSaveAs = useCallback(async (): Promise<SaveOutcome> => {
    // Capture both axes before prompting for a path — don't open the dialog for a save that
    // would fail, and never write the live union or non-canonical positions under a source hash.
    const state = captureCanonicalSaveState();
    if (!state.ok) {
      if (state.reason === 'structural') return structuralSaveFailure(state.error);
      const blocked: SaveOutcome = { status: 'review-blocked', unmappable: state.unmappable };
      notifySaveOutcome(blocked);
      return blocked;
    }
    const outcome = await saveFileAs(
      state.markdown,
      state.comments,
      state.suggestions,
      aiSession,
      contextFolder,
      aiSession ? documentChat.getThread(aiSession.sessionId) : null,
      (path) => onRequestSavePath(tabId, path),
      state.structural,
    );
    if (outcome.status === 'saved') {
      // The document gained (or moved) a directory — relative image paths now
      // resolve against it for anything drawn from here on.
      const liveEditor = editorRef.current?.getEditor();
      if (liveEditor) setImageBaseDir(liveEditor, dirname(outcome.path));
      rememberSessionPermission(window.localStorage, outcome.path, aiSession);
      rememberContextFolderPermission(window.localStorage, outcome.path, contextFolder);
      onRecentFile(outcome.path);
      setLastSavedAt(Date.now());
      // Save As changed the path/baselines — drop the last-good snapshot (captured
      // under the OLD path) so a payload failure right after can't return it.
      lastGoodWorkspaceSnapshotRef.current = null;
    }
    notifySaveOutcome(outcome);
    return outcome;
  }, [
    saveFileAs,
    captureCanonicalSaveState,
    structuralSaveFailure,
    aiSession,
    contextFolder,
    documentChat,
    onRecentFile,
    onRequestSavePath,
    tabId,
    notifySaveOutcome,
    editorRef,
    lastGoodWorkspaceSnapshotRef,
    setLastSavedAt,
  ]);

  const handleSaveAs = useCallback(async () => {
    const outcome = await runExclusive(performSaveAs);
    // Manual save: reconcile the scheduler on success, present blocked/failed loudly.
    if (outcome.status === 'saved') bumpSchedulerGen();
    else presentManualSaveFailure(outcome);
    return outcome.status === 'saved' ? outcome.path : null;
  }, [runExclusive, performSaveAs, bumpSchedulerGen, presentManualSaveFailure]);

  const handleSave = useCallback(async () => {
    // While conflicted, Cmd+S must not write or re-pop a modal — it re-announces the
    // banner so the user resolves it there (Overwrite / Save a Copy / Reload).
    if (saveConflict) {
      setConflictFlash((flash) => flash + 1);
      return null;
    }
    if (!filePath) {
      return handleSaveAs();
    }
    const outcome = await requestSave();
    if (outcome.status === 'saved') bumpSchedulerGen();
    else presentManualSaveFailure(outcome);
    return outcome.status === 'saved' ? outcome.path : null;
  }, [
    saveConflict,
    filePath,
    requestSave,
    handleSaveAs,
    bumpSchedulerGen,
    presentManualSaveFailure,
  ]);

  // --- External-conflict resolution. Each action runs through the coordinator (never
  // a raw save) and clears the conflict only on success; a failed/cancelled action
  // keeps it. Actions are disabled by the banner while `resolvingConflict` is true.
  const handleOverwriteConflict = useCallback(async () => {
    if (!filePath || resolvingConflict) return;
    setResolvingConflict(true);
    try {
      // Overwrite = an explicit same-path Save As: an unconditional write that also
      // re-syncs the baseline, through the exclusive lane, with a FRESH live payload.
      const outcome = await runExclusive(async () => {
        const state = captureCanonicalSaveState();
        if (!state.ok) {
          return state.reason === 'structural'
            ? structuralSaveFailure(state.error)
            : ({ status: 'review-blocked', unmappable: state.unmappable } as SaveOutcome);
        }
        return saveFile(
          state.markdown,
          state.comments,
          state.suggestions,
          aiSession,
          contextFolder,
          filePath,
          aiSession ? documentChat.getThread(aiSession.sessionId) : null,
          state.structural,
        );
      });
      if (outcome.status === 'saved') {
        setSaveConflict(null);
        bumpSchedulerGen(); // reconciled: clear the scheduler's latch, drop stale epochs
        rememberSessionPermission(window.localStorage, outcome.path, aiSession);
        rememberContextFolderPermission(window.localStorage, outcome.path, contextFolder);
        setLastSavedAt(Date.now());
      } else {
        presentManualSaveFailure(outcome); // e.g. a protected sidecar or unanchored annotation
      }
    } finally {
      setResolvingConflict(false);
    }
  }, [
    filePath,
    resolvingConflict,
    runExclusive,
    saveFile,
    captureCanonicalSaveState,
    structuralSaveFailure,
    aiSession,
    contextFolder,
    documentChat,
    presentManualSaveFailure,
    bumpSchedulerGen,
    setLastSavedAt,
  ]);

  const handleSaveCopyConflict = useCallback(async () => {
    if (resolvingConflict) return;
    setResolvingConflict(true);
    try {
      const path = await handleSaveAs(); // exclusive Save As to a NEW file
      if (path) setSaveConflict(null); // now editing the copy — nothing to conflict with
    } finally {
      setResolvingConflict(false);
    }
  }, [resolvingConflict, handleSaveAs]);

  // Owns the resolvingConflict lifecycle for a conflict-resolution job the COMPONENT drives
  // (reload lives there because it depends on performOpenPath, which is declared after the
  // save coordinator — passing it in would be a dependency cycle).
  const runConflictResolution = useCallback(
    async (job: () => Promise<unknown>): Promise<void> => {
      if (resolvingConflict) return;
      setResolvingConflict(true);
      try {
        await job();
      } finally {
        setResolvingConflict(false);
      }
    },
    [resolvingConflict],
  );

  return {
    handleSave,
    handleSaveAs,
    handleOverwriteConflict,
    handleSaveCopyConflict,
    // Coordinator outputs the COMPONENT still consumes: flushSaves drains before load/open/new
    // change identity; saveAndDrain feeds useAutosave. requestSave/runExclusive stay internal.
    flushSaves,
    saveAndDrain,
    // Conflict state read by the component's autosave-eligibility, meta/chrome effects, and banner.
    saveConflict,
    resolvingConflict,
    conflictFlash,
    // Named external actions the component drives (clear on load/new; reload-conflict lifecycle).
    clearSaveConflict,
    runConflictResolution,
  };
}
