import { forwardRef, useState, useCallback, useRef, useEffect, useImperativeHandle } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './Editor';
import type { AnnotationClickInfo, EditorRef, SelectionInfo } from './Editor';
import type { ComposerIntent } from './CommentComposerCard';
import CommentLayer from './CommentLayer';
import AddCommentButton from './AddCommentButton';
import FindBar from './FindBar';
import PanelHeader from './PanelHeader';
import ChatPanel from './ChatPanel';
import {
  useFileManager,
  stripTransientReplyState,
  type SaveOutcome,
  type OpenResult,
  type ReviewUnboundReason,
} from '../hooks/useFileManager';
import { useSaveCoordinator } from '../hooks/useSaveCoordinator';
import { useAutosave, type AutosaveStatus } from '../hooks/useAutosave';
import ConflictBanner from './ConflictBanner';
import { useAnnotationNavigation } from '../hooks/useAnnotationNavigation';
import type { DraftSnapshot } from '../hooks/useDraftAutosave';
import { useComments } from '../hooks/useComments';
import { useSuggestions } from '../hooks/useSuggestions';
import { useClaudeReply } from '../hooks/useClaudeReply';
import { useDocumentChat, type ChatCursorContext } from '../hooks/useDocumentChat';
import { useDocumentAIGate } from '../hooks/useDocumentAIGate';
import {
  FORMAT_BLOCKED_META,
  getTrackedChanges,
  TRACKING_BLOCKED_META,
} from '../extensions/TrackChanges';
import type { TrackingBlockedInfo } from '../extensions/TrackChanges';
import { setImageBaseDir } from '../extensions/MarkdownImage';
import { detectLossyConstructs } from '../utils/markdownFidelity';
import { isEffort } from '../utils/claudePreferences';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import type { AnnotationKind } from '../extensions/AnnotationFocus';
import { rangeText } from '../utils/trackedEdits';
import { applyTrackedEditsToEditor } from '../utils/applyTrackedEdits';
import {
  mergeQuarantinedSuggestions,
  normalizePersistedSuggestions,
  restoreReviewMarks,
  suggestionsFromTrackedChanges,
  type ReviewRestoreMode,
  type ReviewRestoreResult,
} from '../utils/reviewPersistence';
import {
  buildStructuralSavePayload,
  type StructuralSavePayload,
} from '../utils/structuralSavePayload';
import {
  reconstructStructuralIntoEditor,
  reconstructStructuralFromRecords,
} from '../utils/structuralReload';
import { resetStructuralRecords } from '../extensions/StructuralRecordStore';
import {
  prepareCanonicalPersistence,
  rebaseForDegradedRecovery,
  type CanonicalSaveState,
} from '../utils/canonicalPersistence';
import { countLogicalSuggestionCards } from '../utils/suggestionCards';
import { reconcileCommentsWithDocument } from '../utils/commentReconciler';
import { locateCommentForRepair } from '../utils/commentAnchors';
import {
  autoResolveCapturedComments,
  captureCommentsConsumedByTrackedRemoval,
  captureCommentsResolvedByAccept,
} from '../utils/trackedCommentResolution';
import { basename, dirname } from '../utils/path';
import { sidecarPath } from '../utils/sidecarPath';
import { computeDocumentStats } from '../utils/documentStats';
import type { DocumentStats } from '../utils/documentStats';
import { clampZoom } from '../utils/zoomPreference';
import {
  authorizeSidecarAccess,
  constrainSessionBinding,
  rememberContextFolderPermission,
  rememberSessionPermission,
} from '../utils/sidecarPermissions';
import type {
  AISessionBinding,
  ClaudeRunOptions,
  Comment,
  DraftFile,
  EditScope,
  QuillEdit,
  Suggestion,
  StructuralReviewEnvelope,
  StructuralSuggestionRecord,
  TrackedChangeInfo,
  TrackedEditOrigin,
  DocumentChatThread,
} from '../types';

const CLAUDE_AUTHOR_ID = 'claude';

const AUTHOR = 'Anonymous';

// Breathing room (px) left above/below a card when it's scrolled into view, and
// the extra scroll range the bottom spacer adds past the lowest card's bottom.

/**
 * The newest observed value of a field across every AI reply and assistant chat
 * message, ranked by that field's observation time (`modelObservedAt` /
 * `effortObservedAt`, falling back to `createdAt` for records that predate the
 * timestamps) — so a retry that reuses `createdAt` still ranks by when the value
 * was actually seen. "Last observed" is genuinely the most recent, not comment
 * order and not chat-before-replies. Each field is scanned independently: a
 * newer run that lacked an effort reading does not erase the last effort we did
 * observe, which keeps reopen consistent with the live "last observed" state.
 */
type ObservationRecord = {
  createdAt: string;
  model?: string;
  effort?: string;
  modelObservedAt?: string;
  effortObservedAt?: string;
};

function newestObserved(
  comments: Comment[],
  thread: DocumentChatThread | undefined,
  pick: (record: ObservationRecord) => string | null | undefined,
  at: (record: ObservationRecord) => string,
): string | null {
  const observed: { at: string; value: string }[] = [];
  const collect = (record: ObservationRecord) => {
    const value = pick(record);
    if (value) observed.push({ at: at(record), value });
  };
  for (const comment of comments) {
    for (const reply of comment.replies) {
      if (reply.authorKind === 'ai') collect(reply);
    }
  }
  for (const message of thread?.messages ?? []) {
    if (message.role === 'assistant') collect(message);
  }
  // Newest by observation time; a strict `>` keeps the first-seen at equal times.
  return (
    observed.reduce<{ at: string; value: string } | null>(
      (best, record) => (!best || record.at > best.at ? record : best),
      null,
    )?.value ?? null
  );
}

export const newestObservedModel = (comments: Comment[], thread: DocumentChatThread | undefined) =>
  newestObserved(
    comments,
    thread,
    (record) => record.model,
    (record) => record.modelObservedAt ?? record.createdAt,
  );

export const newestObservedEffort = (comments: Comment[], thread: DocumentChatThread | undefined) =>
  newestObserved(
    comments,
    thread,
    // Validate against the effort enum so a malformed sidecar value is ignored.
    (record) => (isEffort(record.effort) ? record.effort : null),
    (record) => record.effortObservedAt ?? record.createdAt,
  );

/** The lead sentence, tailored to WHY the load was unbound (Maz's wording). */
function unboundLead(context: ReviewUnboundReason | 'recovery'): string {
  if (context === 'source-mismatch') return 'This file was changed outside Quill.';
  if (context === 'recovery') return 'Quill recovered unsaved work from a previous session.';
  return 'This file was saved in an older version of Quill.'; // legacy / version-mismatch
}

/**
 * The notice for a load that had to relocate anchors by text (an unbound file or crash
 * recovery). Silent when nothing was set aside — don't nag when there's nothing to act on.
 * The lead sentence is tailored to the reason; the body and its "open the review panel"
 * call-to-action are shared across reasons.
 */
export function unboundRecoveryNotice(
  context: ReviewUnboundReason | 'recovery',
  setAsideCount: number,
): { title: string; message: string } | null {
  if (setAsideCount <= 0) return null;
  const n = setAsideCount;
  return {
    title: 'Some annotations need review',
    message:
      `${unboundLead(context)} We re-anchored your comments and suggestions to the new text; ${n} ` +
      `couldn’t be placed and ${n === 1 ? 'is' : 'are'} set aside — open the review panel to see them.`,
  };
}

/**
 * Shown when a crash snapshot's lossless document was PRESENT but corrupt — distinct from a
 * clean recovery. The Markdown text is salvaged (it's stored independently), but exact
 * review anchoring is lost, so it degrades to text-only + best-effort relocation.
 */
export function degradedRecoveryNotice(): { title: string; message: string } {
  return {
    title: 'Recovered in text-only mode',
    message:
      'This file’s saved review state was damaged and could not be restored exactly. Your text ' +
      'was recovered; some comments and suggestions may be detached or set aside. Save the file ' +
      'to store a fresh copy of your work.',
  };
}

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

export interface DocumentTabChromeSnapshot {
  editor: TiptapEditor | null;
  filePath: string | null;
  isDirty: boolean;
  lastSavedAt: number | null;
  isSuggesting: boolean;
  pendingSuggestionCount: number;
  zoom: number;
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
  lastKnownModel: string | null;
  lastKnownEffort: string | null;
  stats: DocumentStats;
  autosaveStatus: AutosaveStatus;
}

export interface DocumentTabHandle {
  getEditor: () => TiptapEditor | null;
  save: () => Promise<string | null>;
  saveAs: () => Promise<string | null>;
  open: () => Promise<void>;
  openPath: (path: string) => Promise<boolean>;
  newDocument: () => Promise<void>;
  exportPdf: () => void;
  setMode: (suggesting: boolean) => void;
  setZoom: (zoom: number) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  openSessionPicker: () => void;
  closeSessionPicker: () => void;
  pickSession: (binding: AISessionBinding) => boolean;
  focusFind: () => void;
  openChat: () => void;
  clearActiveAnnotation: () => void;
  unlinkSession: () => void;
  linkContextFolder: () => void;
  unlinkContextFolder: () => void;
  getWorkspaceSnapshot: () => DraftSnapshot | null;
  /**
   * Flush a pending autosave and drain the coordinator; awaited by the shell on
   * close/quit. Resolves with whether the tab is STILL dirty afterward (true = the
   * shell must still guard it — e.g. an Untitled doc or a failed/blocked/conflicted save).
   */
  flushPendingSave: () => Promise<boolean>;
  /**
   * Synchronous persistence snapshot: the monotonic change-revision and current dirty
   * state. The shell's quit flush uses `revision` to detect a tab edited DURING a flush
   * round (its value advances), so it can re-flush until the tab set is quiescent.
   */
  getPersistenceSnapshot: () => { revision: number; dirty: boolean };
}

export interface DocumentTabMetaSnapshot {
  filePath: string | null;
  title: string;
  isDirty: boolean;
  /** This tab has an unresolved external conflict — surfaced on the tab strip so a
   *  background tab's conflict is visible even while its in-document banner is hidden. */
  conflict: boolean;
  /** Latched autosave attention (a background tab's flush failed or is blocked), surfaced
   *  on the tab strip so a background save failure is never silent. `review-blocked` is kept
   *  distinct from `blocked` so its tooltip names the actual cause. Null when healthy. */
  autosaveAttention: 'failed' | 'blocked' | 'review-blocked' | null;
}

/**
 * How a workspace snapshot recovered, reported so the shell can hold persistence suspended
 * and preserve a corrupt original before any degraded write overwrites it:
 *  - `lossless` — byte-exact restore from a valid docJSON;
 *  - `legacy`   — a genuine pre-docJSON snapshot restored from Markdown;
 *  - `degraded` — an intended-but-corrupt docJSON; text salvaged, the ORIGINAL must be preserved.
 */
export type WorkspaceRecoveryOutcome = 'lossless' | 'legacy' | 'degraded';

interface DocumentTabProps {
  tabId: string;
  isActive: boolean;
  initialFilePath?: string | null;
  initialWorkspaceSnapshot?: DraftFile | null;
  initialWorkspaceDirty?: boolean;
  restoredFromWorkspace?: boolean;
  defaultZoom: number;
  getClaudeRunOptions: () => ClaudeRunOptions;
  onChromeChange: (tabId: string, snapshot: DocumentTabChromeSnapshot) => void;
  onMetaChange: (tabId: string, snapshot: DocumentTabMetaSnapshot) => void;
  onInitialFileLoaded: (tabId: string, loaded: boolean) => void;
  onInitialWorkspaceLoaded: (tabId: string, outcome: WorkspaceRecoveryOutcome) => void;
  onOpenSessionPicker: (tabId: string) => void;
  onNotice: (notice: {
    title: string;
    message: string;
    actions?: Array<{ label: string; onClick: () => void | Promise<void> }>;
  }) => void;
  onRecentFile: (path: string) => void;
  onRequestSavePath: (tabId: string, path: string) => boolean;
  onClaimSession: (
    tabId: string,
    binding: AISessionBinding,
  ) => { allowed: boolean; ownerTitle?: string };
  onReleaseSession: (tabId: string) => void;
}

const DocumentTab = forwardRef<DocumentTabHandle, DocumentTabProps>(function DocumentTab(
  {
    tabId,
    isActive,
    initialFilePath = null,
    initialWorkspaceSnapshot = null,
    initialWorkspaceDirty = true,
    restoredFromWorkspace = false,
    defaultZoom,
    getClaudeRunOptions,
    onChromeChange,
    onMetaChange,
    onInitialFileLoaded,
    onInitialWorkspaceLoaded,
    onOpenSessionPicker,
    onNotice,
    onRecentFile,
    onRequestSavePath,
    onClaimSession,
    onReleaseSession,
  },
  ref,
) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [chromeRevision, setChromeRevision] = useState(0);
  const initialOpenStartedRef = useRef(false);
  const initialWorkspaceRestoreStartedRef = useRef(false);
  const editorRef = useRef<EditorRef>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  // The one annotation (comment or suggestion) currently in focus: its card
  // is outlined and its text highlighted. Set by clicking either side.
  const [activeAnnotation, setActiveAnnotation] = useState<{
    kind: AnnotationKind;
    id: string;
  } | null>(null);
  const [highlightActivationRevision, setHighlightActivationRevision] = useState(0);
  const activeCommentId = activeAnnotation?.kind === 'comment' ? activeAnnotation.id : null;
  const activeSuggestionId = activeAnnotation?.kind === 'suggestion' ? activeAnnotation.id : null;
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] = useState<SelectionInfo | null>(
    null,
  );
  const [commentComposerOpen, setCommentComposerOpen] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const commentLayerRef = useRef<HTMLDivElement>(null);
  const [editorKey] = useState(0);
  const [zoom, setZoom] = useState(defaultZoom);
  const [scrollTick, setScrollTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [suggestingModeNotice, setSuggestingModeNotice] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<'comments' | 'chat'>('comments');
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [chatFocusRevision, setChatFocusRevision] = useState(0);
  const [trackedChanges, setTrackedChanges] = useState<TrackedChangeInfo[]>([]);
  const [aiSession, setAISession] = useState<AISessionBinding | null>(null);
  const aiGate = useDocumentAIGate();
  const [lastKnownModel, setLastKnownModel] = useState<string | null>(null);
  const [lastKnownEffort, setLastKnownEffort] = useState<string | null>(null);
  // Folder of reference documents linked to this doc (persisted in the
  // sidecar). Claude gets read access to it plus a file manifest per ask.
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  // Ref mirror so useClaudeReply reads the live value at ask time without the
  // hook's options identity churning on every link/unlink.
  const contextFolderRef = useRef(contextFolder);
  contextFolderRef.current = contextFolder;
  // A @claude request made before a session was linked; fired once the user
  // picks a session via the picker we open for them.
  const pendingAIRequestRef = useRef<{ commentId: string; userText: string } | null>(null);
  const pendingChatTurnRef = useRef<string | null>(null);
  const chatThreadRef = useRef<DocumentChatThread | undefined>(undefined);
  const openSessionPicker = useCallback(
    () => onOpenSessionPicker(tabId),
    [onOpenSessionPicker, tabId],
  );

  const showError = useCallback(
    (title: string, message: string) => onNotice({ title, message }),
    [onNotice],
  );

  const {
    filePath,
    isDirty,
    markDirty: markFileDirty,
    openFile,
    openFilePath,
    saveFile,
    saveFileAs,
    newFile,
    restoreDraft,
    getChangeRevision,
    getBaselines,
    getIsDirty,
  } = useFileManager(showError);

  // markDirty is the single change choke point — it bumps the change-revision and
  // marks the tab dirty at every mutation site (edits, accept/reject, comments, chat).
  // Piggyback the autosave debounce signal here so every edit path notifies through one
  // ref (the scheduler is created below, so notifyAutosaveRef is populated after it).
  const notifyAutosaveRef = useRef<() => void>(() => {});
  const markDirty = useCallback(() => {
    markFileDirty();
    notifyAutosaveRef.current();
  }, [markFileDirty]);

  // A scheduler generation that changes on every NON-autosave baseline reconciliation
  // (Open / Reopen / Reload / New / manual Save / Save As / Overwrite). It keys the
  // autosave scheduler's reset so same-path reconciliation — which leaves filePath
  // unchanged — still cancels stale timers, drops a late completion, and clears a
  // latched conflict/block. A steady-state autosave deliberately does NOT bump it.
  const [schedulerGen, setSchedulerGen] = useState(0);
  const bumpSchedulerGen = useCallback(() => setSchedulerGen((generation) => generation + 1), []);

  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // External-conflict state for this tab: which on-disk file changed underneath us.
  // Persists through edits and failed/cancelled resolutions; cleared only by a
  // successful Overwrite / Save-a-Copy / Reload, or by New / a successful Open.
  const [saveConflict, setSaveConflict] = useState<{ which: 'doc' | 'sidecar' } | null>(null);
  // True while a resolution job (Overwrite / Save-a-Copy / Reload) is running, so the
  // banner disables its actions. A bump of `conflictFlash` re-announces the banner
  // when a conflicted Cmd+S is pressed (no write happens).
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [conflictFlash, setConflictFlash] = useState(0);

  const chooseContextFolder = useCallback(
    async (permissionPath = filePath) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const folder = await invoke<string | null>('show_folder_dialog');
        if (folder) {
          setContextFolder(folder);
          if (permissionPath) {
            rememberContextFolderPermission(window.localStorage, permissionPath, folder);
          }
          markDirty();
        }
      } catch (error) {
        console.error('Failed to pick context folder:', error);
        showError('Could not link folder', String(error));
      }
    },
    [filePath, markDirty, showError],
  );

  const adoptLoadedSession = useCallback(
    (binding: AISessionBinding | null, documentPath: string | null): AISessionBinding | null => {
      onReleaseSession(tabId);
      const constrained = constrainSessionBinding(binding, documentPath);
      if (!constrained) {
        setAISession(null);
        return null;
      }
      const claim = onClaimSession(tabId, constrained);
      if (!claim.allowed) {
        setAISession(null);
        return null;
      }
      setAISession(constrained);
      return constrained;
    },
    [onClaimSession, onReleaseSession, tabId],
  );

  const claimInteractiveSession = useCallback(
    (binding: AISessionBinding): AISessionBinding | null => {
      const constrained = constrainSessionBinding(binding, filePath);
      if (!constrained) {
        onNotice({
          title: 'Save before starting a session',
          message: 'A Quill-created Claude session must run in the saved document’s folder.',
        });
        return null;
      }
      const claim = onClaimSession(tabId, constrained);
      if (!claim.allowed) {
        onNotice({
          title: 'Claude session already linked',
          message: `This session is already linked to ${claim.ownerTitle ?? 'another open document'}. Choose a different session or unlink it there first.`,
        });
        return null;
      }
      setAISession(constrained);
      if (filePath) rememberSessionPermission(window.localStorage, filePath, constrained);
      return constrained;
    },
    [filePath, onClaimSession, onNotice, tabId],
  );

  const {
    comments,
    setComments,
    addComment,
    addReply,
    resolveComment,
    unresolveComment,
    deleteComment,
    startAIReply,
    appendAIReplyChunk,
    setAIReplyModel,
    setAIReplyEffort,
    finishAIReply,
    failAIReply,
    cancelAIReply,
    retryAIReply,
    linkAIReplySuggestions,
    dismissAIReply,
  } = useComments();
  const { suggestions, setSuggestions } = useSuggestions();
  const quarantinedSuggestionsRef = useRef<Suggestion[]>([]);
  // Structural records that failed reconstruction on the last load (whole-doc hash
  // mismatch or a per-record validation failure). Kept so the notice can report
  // them; re-persistence of quarantined structural records lands with the mint
  // slice (the only path that puts structural records on disk today), so no real
  // sidecar can carry one yet.
  const quarantinedStructuralRef = useRef<StructuralSuggestionRecord[]>([]);
  // The most recent successfully-built workspace snapshot, retained so that if the
  // structural payload can't be built the recovery data is kept intact rather than
  // degraded (Codex's crash-recovery correction). Never source-flattened.
  const lastGoodWorkspaceSnapshotRef = useRef<DraftSnapshot | null>(null);

  const getDocMarkdown = useCallback(() => editorRef.current?.getMarkdown() ?? '', []);

  // Marks are the runtime truth for review data. The update listener below
  // projects comments into React state while editing; write paths reconcile once
  // more defensively, and tracked changes exist only as marks until captured here.
  const getLiveReviewState = useCallback(() => {
    const ed = editorRef.current?.getEditor();
    if (!ed) return { comments, suggestions };
    const liveSuggestions = suggestionsFromTrackedChanges(getTrackedChanges(ed));
    return {
      comments: reconcileCommentsWithDocument(comments, ed.state.doc),
      suggestions: mergeQuarantinedSuggestions(liveSuggestions, quarantinedSuggestionsRef.current),
    };
  }, [comments, suggestions]);

  // The combined pre-write pipeline every FILE save route funnels through lives in
  // `prepareCanonicalPersistence` (pure, editor-scoped). This thin wrapper supplies the live
  // editor, serialization, quarantined structural records, and live review state.
  const captureCanonicalSaveState = useCallback((): CanonicalSaveState => {
    const ed = editorRef.current?.getEditor();
    if (!ed) return { ok: false, reason: 'structural', error: 'editor not ready' };
    return prepareCanonicalPersistence(
      ed,
      getDocMarkdown(),
      quarantinedStructuralRef.current,
      getLiveReviewState(),
    );
  }, [getDocMarkdown, getLiveReviewState]);

  // The shell owns persistence and asks each mounted tab for a live snapshot.
  // Keep transient AI reply state out of this second on-disk write path just as
  // the regular sidecar serializer does.
  const getWorkspaceSnapshot = useCallback((): DraftSnapshot | null => {
    // Symmetric with captureDiskPayload's fail-closed: while there are unreconciled
    // quarantined structural records (the on-disk sidecar holds the only copy), do
    // NOT produce a snapshot that would launder that state away. Retain the last
    // good snapshot so recovery re-reads the sidecar — which still holds the
    // records — instead of restoring a quarantine-free doc and then overwriting the
    // sidecar on the next save. A crash here reopens the file from disk, which
    // re-establishes the quarantine; the un-saveable edits were already blocked.
    if (quarantinedStructuralRef.current.length > 0) {
      return lastGoodWorkspaceSnapshotRef.current;
    }
    const reviewMd = getDocMarkdown();
    const ed = editorRef.current?.getEditor();
    // Capture the structural SOURCE (the `.md` view) + records, mirroring a disk
    // save, so recovery reconstructs unions the same way a file reload does. If the
    // payload can't be built (a malformed/orphan union — the same should-never-happen
    // state the save path fails closed on), do NOT degrade the recovery data: retain
    // the last good snapshot (or skip the write, leaving the existing workspace file
    // untouched) rather than flatten the document and drop the proposed branch.
    const payload = ed
      ? buildStructuralSavePayload(ed, reviewMd)
      : ({ ok: true, content: reviewMd, structural: [] } satisfies StructuralSavePayload);
    if (!payload.ok) return lastGoodWorkspaceSnapshotRef.current;
    // The DEGRADED-recovery bundle: the same structural records rebased into the canonical
    // source coordinate space (the normalized reparse of `payload.content`). Lossless recovery
    // uses `structural` (live) against the byte-exact docJSON; the degraded path reparses the
    // source (normalizing whitespace) and needs these instead, or a proposal would spuriously
    // quarantine. Fail closed like the payload guard: if the rebase can't be built, keep the
    // last good snapshot rather than emit a degraded bundle that can't be reconstructed.
    const degraded = ed
      ? rebaseForDegradedRecovery(ed, payload.content, payload.structural)
      : { ok: true as const, records: [] as StructuralSuggestionRecord[] };
    if (!degraded.ok) return lastGoodWorkspaceSnapshotRef.current;
    // One stable document node for BOTH the lossless docJSON and the records derived from
    // its marks, so the snapshot is internally coherent (the bijection recovery relies on).
    const doc = ed?.state.doc;
    const live = getLiveReviewState();
    const baselines = getBaselines();
    const snapshot: DraftSnapshot = {
      filePath,
      content: payload.content,
      // The lossless representation: byte-exact recovery when it survives; Markdown remains
      // the back-compat + degraded-salvage fallback.
      ...(doc ? { docJSON: doc.toJSON(), docJSONVersion: 1 as const } : {}),
      comments: stripTransientReplyState(live.comments),
      suggestions: live.suggestions,
      ...(payload.structural.length > 0 ? { structural: payload.structural } : {}),
      ...(degraded.records.length > 0 ? { degradedStructural: degraded.records } : {}),
      aiSession,
      contextFolder,
      ...(chatThreadRef.current ? { chat: chatThreadRef.current } : {}),
      // Persist the on-disk baselines + protection so a recovered dirty draft can
      // still detect an external change on the next save (never re-hashing disk).
      expectedDoc: baselines.expectedDoc,
      expectedSidecar: baselines.expectedSidecar,
      sidecarProtected: baselines.sidecarProtected,
      structuralProtected: baselines.structuralProtected,
    };
    lastGoodWorkspaceSnapshotRef.current = snapshot;
    return snapshot;
  }, [filePath, getDocMarkdown, getLiveReviewState, aiSession, contextFolder, getBaselines]);

  // Read the live document text for a comment's anchored range and its
  // enclosing paragraph, as plaintext (matching how Claude's `find` strings are
  // expected to match). Uses the current doc, not the stale anchorText snapshot.
  const getRangeTexts = useCallback(
    (comment: Comment) => {
      const doc = editor?.state.doc;
      if (!doc) return { highlightText: comment.anchorText, paragraphText: comment.anchorText };
      const size = doc.content.size;
      const cFrom = Math.min(comment.from, size);
      const cTo = Math.min(comment.to, size);
      const $from = doc.resolve(cFrom);
      const pFrom = $from.start($from.depth);
      const pTo = $from.end($from.depth);
      return {
        highlightText: rangeText(doc, cFrom, cTo),
        paragraphText: rangeText(doc, pFrom, pTo),
      };
    },
    [editor],
  );

  // True while applyTrackedEdits is dispatching Claude's edits, so the
  // blocked-formatting notice only ever fires for the user's own gestures.
  const applyingClaudeEditsRef = useRef(false);

  // Apply Claude's quote-based edits as tracked-change suggestions. Forces
  // suggesting mode on (under Claude's author id, stamped with the originating
  // comment when one is given) for the duration, applies each located edit
  // back-to-front, then restores the user's prior mode/author.
  const applyTrackedEdits = useCallback(
    (
      comment: { from: number; to: number },
      edits: QuillEdit[],
      scope: EditScope,
      origin?: TrackedEditOrigin,
    ) => {
      const ed = editor;
      if (!ed) {
        return {
          results: edits.map((edit) => ({
            edit,
            status: 'not-found' as const,
            reason: 'document-unavailable' as const,
          })),
          suggestionIds: [],
        };
      }

      // The seam itself (plan → dispatch → engine-honest results) lives in
      // utils/applyTrackedEdits.ts so it is testable against a real editor.
      // This wrapper owns only the React-specific parts: the null-editor early
      // return above, and suppressing the blocked-gesture notices for
      // automated applies (planEdits pre-blocks Claude's conflicting format
      // ops and reports them as skipped; a modal mid-apply would be noise —
      // the engine-veto flip inside the seam keeps the RESULT honest while
      // the notice stays quiet).
      try {
        applyingClaudeEditsRef.current = true;
        return applyTrackedEditsToEditor({
          editor: ed,
          comment,
          edits,
          scope,
          authorID: CLAUDE_AUTHOR_ID,
          fallbackAuthor: AUTHOR,
          origin,
        });
      } finally {
        applyingClaudeEditsRef.current = false;
      }
    },
    [editor],
  );

  // Review-only mutations (replies, AI completions, resolve state) change no
  // document text, so no editor transaction fires onUpdate for them — they must mark
  // the document dirty themselves or quitting silently drops them. EVERY AI-reply
  // lifecycle outcome (finish / fail / cancel / retry) mutates review state, so all of
  // them mark dirty; otherwise a mid-stream autosave clears dirty and a later error /
  // cancel state survives only in memory. A terminal outcome (finish/fail/cancel) also
  // flushes — but via a post-commit tick (below), never synchronously here, or the
  // flush would capture the pre-terminal React state and persist the wrong payload.
  const [aiTerminalTick, setAiTerminalTick] = useState(0);
  // Bump the post-commit terminal-flush tick (see the effect below). Chat wires this to
  // its onTerminal directly (chat already marks dirty via onChanged); comment replies go
  // through noteAITerminal, which also marks dirty because their raw handlers don't.
  const signalTerminalFlush = useCallback(() => setAiTerminalTick((tick) => tick + 1), []);
  const noteAITerminal = useCallback(() => {
    markDirty();
    signalTerminalFlush();
  }, [markDirty, signalTerminalFlush]);
  const finishAIReplyAndDirty = useCallback(
    (commentId: string, replyId: string) => {
      finishAIReply(commentId, replyId);
      noteAITerminal();
    },
    [finishAIReply, noteAITerminal],
  );
  const failAIReplyAndDirty = useCallback(
    (commentId: string, replyId: string, message: string) => {
      failAIReply(commentId, replyId, message);
      noteAITerminal();
    },
    [failAIReply, noteAITerminal],
  );
  const cancelAIReplyAndDirty = useCallback(
    (commentId: string, replyId: string) => {
      cancelAIReply(commentId, replyId);
      noteAITerminal();
    },
    [cancelAIReply, noteAITerminal],
  );
  const retryAIReplyAndDirty = useCallback(
    (commentId: string, replyId: string) => {
      retryAIReply(commentId, replyId);
      // Retry restarts the stream — not a terminal outcome, so mark dirty (persist the
      // cleared error state) but do NOT flush mid-stream.
      markDirty();
    },
    [retryAIReply, markDirty],
  );

  const claudeReply = useClaudeReply({
    startAIReply,
    appendAIReplyChunk,
    setAIReplyModel,
    setAIReplyEffort,
    onModelObserved: setLastKnownModel,
    onEffortObserved: setLastKnownEffort,
    finishAIReply: finishAIReplyAndDirty,
    failAIReply: failAIReplyAndDirty,
    cancelAIReply: cancelAIReplyAndDirty,
    retryAIReply: retryAIReplyAndDirty,
    linkAIReplySuggestions,
    getDocMarkdown,
    getRangeTexts,
    applyTrackedEdits,
    getContextFolder: useCallback(() => contextFolderRef.current, []),
    // Read live at ask time (not from the trackedChanges state mirror) so the
    // prompt's pending-suggestions section can't lag a just-applied edit.
    getPendingSuggestions: useCallback(
      () => (editor ? getTrackedChanges(editor).filter((c) => c.status === 'pending') : []),
      [editor],
    ),
    getRunOptions: getClaudeRunOptions,
    aiGate,
  });

  const getCursorContext = useCallback((): ChatCursorContext => {
    const ed = editorRef.current?.getEditor();
    if (!ed) return { selectedText: null, blockText: '' };
    const { from, to } = ed.state.selection;
    const $from = ed.state.doc.resolve(from);
    return {
      selectedText: from === to ? null : rangeText(ed.state.doc, from, to),
      blockText: rangeText(ed.state.doc, $from.start($from.depth), $from.end($from.depth)),
    };
  }, []);

  const documentChat = useDocumentChat({
    getDocMarkdown,
    getCursorContext,
    applyTrackedEdits: useCallback(
      (edits: QuillEdit[], originChatMessageId: string) =>
        applyTrackedEdits({ from: 0, to: 0 }, edits, 'doc', {
          chatMessageId: originChatMessageId,
        }),
      [applyTrackedEdits],
    ),
    getContextFolder: useCallback(() => contextFolderRef.current, []),
    getPendingSuggestions: useCallback(
      () =>
        editor ? getTrackedChanges(editor).filter((change) => change.status === 'pending') : [],
      [editor],
    ),
    getRunOptions: getClaudeRunOptions,
    onModelObserved: setLastKnownModel,
    onEffortObserved: setLastKnownEffort,
    onChanged: markDirty,
    onTerminal: signalTerminalFlush,
    aiGate,
  });
  chatThreadRef.current = aiSession ? documentChat.getThread(aiSession.sessionId) : undefined;

  // Re-render on scroll so the line-aligned annotation gutter and the
  // add-comment button track the visible document coordinates.
  // Keyed on `editor` so the listener attaches once the editor subtree has
  // mounted `.editor-scroll-area` — with an empty dep array the query could
  // run before the element existed, leaving scrollTop stuck at 0 (cards never
  // move on scroll).
  useEffect(() => {
    const el = scrollAreaRef.current?.querySelector('.editor-scroll-area');
    if (!el) return;
    const onScroll = () => {
      setScrollTick((t) => t + 1);
      setScrollTop((el as HTMLElement).scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Sync once on attach in case the document is already scrolled.
    setScrollTop((el as HTMLElement).scrollTop);
    return () => el.removeEventListener('scroll', onScroll);
  }, [editor]);

  // Re-render once after a text-size change so the add-comment button re-reads
  // coordsAtPos after the editor has reflowed. The style lands in the DOM after
  // render, so measuring in that same render would leave the button one layout
  // behind.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setScrollTick((t) => t + 1));
    return () => cancelAnimationFrame(raf);
  }, [zoom]);

  const restorePersistedReviewMarks = useCallback(
    (
      ed: TiptapEditor,
      persistedComments: Comment[],
      persistedSuggestions: Suggestion[],
      mode: ReviewRestoreMode,
    ) => {
      const result = restoreReviewMarks(ed, persistedComments, persistedSuggestions, mode);
      // Adopt the AUTHORITATIVE comment set restore produced. This is essential, not
      // cosmetic: a comment that failed validation is returned `detached` with no live
      // mark, and only the detached flag stops the reconciler from dropping it on the next
      // editor update. Keeping the stale non-detached record would lose the comment.
      setComments(result.comments);
      quarantinedSuggestionsRef.current = result.quarantinedSuggestions;
      setTrackedChanges(getTrackedChanges(ed));
      // The caller decides the notice: the wording depends on WHY the load was unbound
      // (a file's provenance vs. crash recovery), which only the caller knows.
      return result;
    },
    [setComments],
  );

  // Announce a text-relocated (unbound) load, once, tailored to the reason — but only when
  // something couldn't be placed. `null` context = a bound load, nothing to say.
  const announceUnboundLoad = useCallback(
    (context: ReviewUnboundReason | 'recovery' | null, restored: ReviewRestoreResult) => {
      if (!context) return;
      const setAside = restored.detachedComments.length + restored.quarantinedSuggestions.length;
      const notice = unboundRecoveryNotice(context, setAside);
      if (notice) onNotice(notice);
    },
    [onNotice],
  );

  const warnStructuralQuarantine = useCallback(
    (count: number) => {
      if (count <= 0) return;
      onNotice({
        title: 'Structural suggestions need review',
        message:
          `${count} saved structural suggestion${count === 1 ? '' : 's'} could not be restored — ` +
          `the document may have changed outside Quill, or a saved record is no longer valid. ` +
          `Quill will not overwrite the saved data while this is unresolved; reconcile the ` +
          `document (reopen or fix it) to clear this.`,
      });
    },
    [onNotice],
  );

  // A document-identity reconciliation (New / Open / recover). Clear the per-document
  // structural refs so a payload failure can't return a prior document's last-good
  // snapshot, and quarantine/last-good state never leaks across documents.
  const resetStructuralIdentity = useCallback(() => {
    quarantinedStructuralRef.current = [];
    lastGoodWorkspaceSnapshotRef.current = null;
  }, []);

  // The structural half of the two-axis FILE reload: rebuild the block unions (and
  // reset the canonical record store) BEFORE inline/comment marks are restored, then
  // stash any quarantined records and warn about them.
  const restoreStructuralUnions = useCallback(
    (ed: TiptapEditor, envelope: StructuralReviewEnvelope | null, docHash: string) => {
      resetStructuralIdentity();
      const result = reconstructStructuralIntoEditor(ed, envelope, docHash);
      quarantinedStructuralRef.current = result.quarantined;
      warnStructuralQuarantine(result.quarantined.length);
    },
    [resetStructuralIdentity, warnStructuralQuarantine],
  );

  // The workspace-RECOVERY counterpart: reconstruct from in-memory records (no hash
  // gate — the snapshot's source and records were captured together). There is no
  // on-disk envelope to preserve, so a save after recovery rebuilds from live state.
  const restoreStructuralFromDraft = useCallback(
    (ed: TiptapEditor, records: StructuralSuggestionRecord[]) => {
      resetStructuralIdentity();
      const result = reconstructStructuralFromRecords(ed, records);
      quarantinedStructuralRef.current = result.quarantined;
      warnStructuralQuarantine(result.quarantined.length);
    },
    [resetStructuralIdentity, warnStructuralQuarantine],
  );

  // A mounted background tab keeps its editor state, but layout APIs return
  // stale/zero coordinates while its host is display:none. Re-measure after
  // activation so comments and the selection affordance snap back to the
  // preserved scroll position in the newly visible geometry.
  useEffect(() => {
    if (!isActive || !editor) return;
    const raf = requestAnimationFrame(() => {
      const scrollArea = scrollAreaRef.current?.querySelector(
        '.editor-scroll-area',
      ) as HTMLElement | null;
      if (scrollArea) setScrollTop(scrollArea.scrollTop);
      setScrollTick((tick) => tick + 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [editor, isActive]);

  const loadFileResult = useCallback(
    (result: OpenResult, promptForSession = true) => {
      // A successful (re)load reconciles the document with disk, resolving any
      // pending conflict for this tab. Bump the scheduler generation so a same-path
      // Reload/Reopen also resets autosave (clears a latch, drops a stale completion).
      setSaveConflict(null);
      bumpSchedulerGen();
      // Must precede setContent: ProseMirror draws the document (and thus
      // resolves image srcs) synchronously when content is set.
      const liveEditor = editorRef.current?.getEditor();
      if (liveEditor) setImageBaseDir(liveEditor, dirname(result.filePath));
      onRecentFile(result.filePath);
      setLastSavedAt(Date.now());
      // setContent parses the structural SOURCE Markdown (original branches only).
      editorRef.current?.setContent(result.content);
      const loadedComments = result.sidecar.comments ?? [];
      const loadedSuggestions = normalizePersistedSuggestions(result.sidecar.suggestions ?? []);
      setComments(loadedComments);
      setSuggestions(loadedSuggestions);
      // Two-axis reload. Reconstruct the structural unions FIRST — that rebuilds the
      // review document whose positions the inline/comment marks were captured
      // against — THEN stamp those marks back on top. Reconstruction resets the
      // canonical record store (even with no envelope, clearing a prior document's
      // records). The mark restore suppresses the update event (a load must not look
      // dirty), so the tracked-changes state is refreshed by hand.
      const ed = editorRef.current?.getEditor();
      if (ed) {
        // Two-axis reload (Codex's composition invariant): reconstruct the structural
        // unions FIRST — that rebuilds the review document whose positions the inline/comment
        // marks were captured against — THEN restore those marks under the load's bound/unbound
        // authority. A legacy/externally-edited file (unbound) relocates its anchors instead of
        // trusting stale coordinates; a missing mode is a compile error, never a silent default.
        restoreStructuralUnions(ed, result.sidecar.structural ?? null, result.docHash);
        const restored = restorePersistedReviewMarks(
          ed,
          loadedComments,
          loadedSuggestions,
          result.reviewMode,
        );
        // An unbound load relocates by text; tell the user, tailored to WHY it was unbound,
        // and only when something couldn't be placed. `reviewUnboundReason` is present iff
        // the load was unbound, so it doubles as the bound/unbound gate (null ⇒ silent).
        announceUnboundLoad(result.reviewUnboundReason ?? null, restored);
      }
      const access = authorizeSidecarAccess(
        window.localStorage,
        result.filePath,
        result.sidecar,
        result.autoBound === true,
      );
      const session = adoptLoadedSession(access.aiSession, result.filePath);
      documentChat.restore(result.sidecar.chat, session);
      // A sidecar that exists but failed to parse means real comments/suggestions
      // may be at risk. Warn loudly; the save path keeps the on-disk file intact.
      if (result.sidecarError) {
        const name = sidecarPath(result.filePath);
        onNotice({
          title: 'Comments file could not be read',
          message:
            `${name}\n\n${result.sidecarError}\n\n` +
            `Your comments and suggestions are NOT loaded, but the file on disk is preserved. ` +
            `Saving will not overwrite it. Fix or remove the file, then reopen.`,
        });
      } else {
        // Warn before the user edits, not after they've saved over the file.
        const lossy = detectLossyConstructs(result.content);
        if (lossy.length > 0) {
          onNotice({
            title: 'Some formatting may not survive',
            message:
              `This file contains ${lossy.join(' and ')}, which Quill cannot edit yet. ` +
              `Those parts will be altered if you save this document from Quill. ` +
              `To keep them intact, edit this file in another tool.`,
          });
        }
      }
      setLastKnownModel(newestObservedModel(loadedComments, result.sidecar.chat));
      setLastKnownEffort(newestObservedEffort(loadedComments, result.sidecar.chat));
      setContextFolder(access.contextFolder);
      if (result.autoBound && session) {
        rememberSessionPermission(window.localStorage, result.filePath, session);
        markDirty();
      }
      const hasBlockedSidecarAccess = access.blockedSession || access.blockedContextFolder;
      if (hasBlockedSidecarAccess) {
        const blockedSession = access.blockedSession;
        const blockedFolder = access.blockedContextFolder;
        let message = 'This document had linked Claude access. Relink it to use Claude here.';
        if (blockedSession && !blockedFolder) {
          message = 'This document had a linked Claude session. Relink it to use Claude here.';
        } else if (!blockedSession && blockedFolder) {
          message =
            'This document had a reference folder. Choose the folder again to let Claude use it here.';
        }
        onNotice({
          title: 'Reconnect Claude access',
          message,
          actions: [
            ...(blockedSession
              ? [{ label: 'Relink session', onClick: () => onOpenSessionPicker(tabId) }]
              : []),
            ...(blockedFolder
              ? [
                  {
                    label: 'Choose folder',
                    onClick: () => chooseContextFolder(result.filePath),
                  },
                ]
              : []),
          ],
        });
      }
      // Force the session choice up front: if we opened a non-empty doc with no
      // linked Claude session, surface the picker so the user binds one (and can
      // then call @claude from within the doc). Auto-bind is intentionally not
      // attempted — the user picks.
      if (
        promptForSession &&
        !session &&
        !hasBlockedSidecarAccess &&
        result.content.trim().length > 0
      ) {
        openSessionPicker();
      }
    },
    [
      adoptLoadedSession,
      documentChat,
      setComments,
      setSuggestions,
      onNotice,
      openSessionPicker,
      onRecentFile,
      markDirty,
      chooseContextFolder,
      onOpenSessionPicker,
      restorePersistedReviewMarks,
      restoreStructuralUnions,
      announceUnboundLoad,
      tabId,
      bumpSchedulerGen,
    ],
  );

  // Test escape hatch: bind an AI session without going through SessionPicker.
  useEffect(() => {
    const seed = typeof window !== 'undefined' ? window.__quillTestSession : undefined;
    const constrained = constrainSessionBinding(seed, filePath);
    if (constrained && onClaimSession(tabId, constrained).allowed) setAISession(constrained);
  }, [filePath, onClaimSession, tabId]);

  // Keep one durable display-name index for every real document/session
  // binding, regardless of whether it came from link-existing, start-new, or
  // auto-bind. Watching filePath also records a session linked while Untitled
  // as soon as Save As gives the document a real path.
  useEffect(() => {
    if (!aiSession || !filePath) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        invoke('record_session_document', {
          sessionId: aiSession.sessionId,
          docPath: filePath,
        }),
      )
      .catch((error) => console.warn('Could not record Claude session document:', error));
  }, [aiSession, filePath]);

  // A failed structural payload build aborts the save before any byte is written
  // (fail closed). Presented like any other save failure: loud for a manual save,
  // quiet (footer + backoff) for autosave.
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

  // Reduce a typed save outcome to a path for callers that only care whether the
  // save landed, surfacing the outcomes that must not read as silent success:
  // a `blocked` sidecar (text saved, annotations withheld) and an external
  // `conflict`. `failed` already reported itself inside useFileManager; a
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
        if (first) setActiveAnnotation({ kind: first.kind, id: first.id });
        const notice = reviewBlockedNotice(outcome.unmappable);
        showError(notice.title, notice.message);
      }
    },
    [showError, setActiveAnnotation],
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

  // Autosave: a debounced background save for documents with a real saved path, running
  // only inside Tauri (there is no file I/O in the browser dev server). It drives the
  // coordinator's saveAndDrain, so a background write is serialized with manual saves,
  // reports the coordinator's terminal outcome, and raises the conflict banner if the
  // file changed on disk. Ineligible while a conflict is unresolved. resetKey keys on a
  // generation that changes on every reconciliation, so same-path Reload/Overwrite reset
  // it too. notifyAutosaveRef is populated here, after the scheduler exists.
  const autosaveEnabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const {
    notifyChange: autosaveNotify,
    flush: autosaveFlush,
    status: autosaveStatus,
  } = useAutosave({
    enabled: autosaveEnabled && filePath !== null,
    // Only save a saved path that is actually DIRTY and not mid-conflict. The isDirty
    // guard is what makes flush after opening a clean document a true no-op: without it
    // a blur/quit right after open would write despite no edit (savedRevision starts null).
    isEligible: () => filePath !== null && saveConflict === null && isDirty,
    performAutosave: saveAndDrain,
    getRevision: getChangeRevision,
    resetKey: `${filePath ?? ''}#${schedulerGen}`,
  });
  notifyAutosaveRef.current = autosaveNotify;

  // Persist a pending autosave promptly when the user's attention leaves this document:
  // switching tabs (isActive → false) or the window losing focus. flush joins an
  // in-flight write and is a no-op when the tab is clean/ineligible. Both drain the
  // coordinator too, so nothing is left half-written when focus moves on.
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = isActive;
    if (wasActive && !isActive) void autosaveFlush();
  }, [isActive, autosaveFlush]);

  useEffect(() => {
    if (!isActive) return;
    const onBlur = () => void autosaveFlush();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [isActive, autosaveFlush]);

  // Stream-terminal flush: an AI reply reaching finish/fail/cancel is a natural save
  // checkpoint. This effect runs AFTER React commits the terminal mutation, so the
  // flush captures the final review state (not the pre-terminal payload). Skip the
  // initial mount (tick 0).
  const aiTerminalSeenRef = useRef(0);
  useEffect(() => {
    if (aiTerminalTick === aiTerminalSeenRef.current) return;
    aiTerminalSeenRef.current = aiTerminalTick;
    if (aiTerminalTick > 0) void autosaveFlush();
  }, [aiTerminalTick, autosaveFlush]);

  // Arm autosave for a document that becomes eligible-and-dirty WITHOUT an edit — a
  // recovered dirty draft, or an auto-bound session stamped during initial load — where
  // markDirty's notifyChange either never fired or was cleared by the reset effect.
  // Keyed on the reconciliation inputs; the hook's reset effect registers first, so this
  // arms the fresh scheduler. isDirty stays true across ordinary edits, so it does not
  // re-arm per keystroke.
  useEffect(() => {
    if (autosaveEnabled && filePath !== null && isDirty && saveConflict === null) {
      autosaveNotify();
    }
  }, [autosaveEnabled, filePath, isDirty, saveConflict, schedulerGen, autosaveNotify]);

  // Latched autosave attention for the tab strip: a background tab's flush failure/block
  // must stay visibly flagged even though only the ACTIVE tab's footer shows live status.
  // Latch failed/blocked (a retry's failed→saving must NOT clear it early); clear only on
  // a successful save or a reconciliation (schedulerGen). Conflict has its own marker.
  const [autosaveAttention, setAutosaveAttention] = useState<
    'failed' | 'blocked' | 'review-blocked' | null
  >(null);
  useEffect(() => {
    if (autosaveStatus.state === 'failed') setAutosaveAttention('failed');
    else if (autosaveStatus.state === 'stopped' && autosaveStatus.reason === 'blocked') {
      setAutosaveAttention('blocked');
    } else if (autosaveStatus.state === 'review-blocked') {
      setAutosaveAttention('review-blocked'); // distinct: an annotation must be fixed
    } else if (autosaveStatus.state === 'saved') setAutosaveAttention(null);
  }, [autosaveStatus]);
  useEffect(() => {
    setAutosaveAttention(null); // a reconciliation (Open/Save/Reload/New/…) resets attention
  }, [schedulerGen]);

  // Exposed to the shell for close/quit: flush a pending autosave AND drain the
  // coordinator, so the tab is fully quiescent before it is torn down or the app exits.
  // Resolves with the tab's dirty state AFTER the flush (read synchronously), so the
  // shell's guard doesn't re-prompt for work autosave just persisted.
  const flushPendingSave = useCallback(async (): Promise<boolean> => {
    await autosaveFlush();
    await flushSaves();
    return getIsDirty();
  }, [autosaveFlush, flushSaves, getIsDirty]);

  const getPersistenceSnapshot = useCallback(
    () => ({ revision: getChangeRevision(), dirty: getIsDirty() }),
    [getChangeRevision, getIsDirty],
  );

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

  // Export to PDF is print-to-PDF: the `@media print` rules in App.css strip
  // the chrome and the track-changes/comment markup, leaving a clean copy of
  // the document, and the OS print dialog offers "Save as PDF". We set
  // document.title first so that dialog defaults the filename to the doc's
  // name instead of "Quill"; it's restored after the dialog returns
  // (window.print blocks synchronously until then).
  const handleExportPdf = useCallback(() => {
    const docName = filePath ? basename(filePath).replace(/\.md$/i, '') : 'Untitled';
    const prevTitle = document.title;
    document.title = docName;
    try {
      window.print();
    } finally {
      document.title = prevTitle;
    }
  }, [filePath]);

  const performOpen = useCallback(async () => {
    // Drain any in-flight save BEFORE opening: openFile mutates identity (filePath,
    // epoch, revision) inside openFilePath, and a fresh pass triggered by that
    // revision bump could otherwise write the old editor content to the new path.
    await flushSaves();
    const result = await openFile();
    if (!result) return;
    loadFileResult(result);
  }, [openFile, loadFileResult, flushSaves]);

  const performOpenPath = useCallback(
    async (path: string, promptForSession = true) => {
      await flushSaves(); // drain before openFilePath mutates identity (see performOpen)
      const result = await openFilePath(path);
      if (!result) return false;
      loadFileResult(result, promptForSession);
      return true;
    },
    [openFilePath, loadFileResult, flushSaves],
  );

  useEffect(() => {
    if (!editor || !initialFilePath || initialOpenStartedRef.current) return;
    initialOpenStartedRef.current = true;
    void performOpenPath(initialFilePath, !restoredFromWorkspace).then((loaded) =>
      onInitialFileLoaded(tabId, loaded),
    );
  }, [editor, initialFilePath, onInitialFileLoaded, performOpenPath, restoredFromWorkspace, tabId]);

  const performNew = useCallback(async () => {
    // Drain any in-flight save before clearing to a new document, so a late write
    // can't complete against the old identity (epoch guard is the backstop).
    await flushSaves();
    newFile();
    setSaveConflict(null); // a brand-new document has nothing to conflict with
    bumpSchedulerGen(); // reset autosave even when replacing an Untitled (filePath stays null)
    const liveEditor = editorRef.current?.getEditor();
    if (liveEditor) setImageBaseDir(liveEditor, null);
    editorRef.current?.setContent('');
    // Clear a prior document's canonical structural records; setContent alone does
    // not reset the session-retained store.
    if (liveEditor) {
      liveEditor.view.dispatch(
        resetStructuralRecords(liveEditor.state.tr, [])
          .setMeta('preventUpdate', true)
          .setMeta('skipTracking', true)
          .setMeta('addToHistory', false),
      );
    }
    setComments([]);
    setSuggestions([]);
    quarantinedSuggestionsRef.current = [];
    quarantinedStructuralRef.current = [];
    lastGoodWorkspaceSnapshotRef.current = null; // new identity: forget prior last-good
    onReleaseSession(tabId);
    setAISession(null);
    documentChat.reset();
    setLastKnownModel(null);
    setLastKnownEffort(null);
    setContextFolder(null);
    setLastSavedAt(null);
    setPanelMode('comments');
  }, [
    documentChat,
    newFile,
    onReleaseSession,
    setComments,
    setSuggestions,
    tabId,
    flushSaves,
    bumpSchedulerGen,
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

  const handleReloadConflict = useCallback(() => {
    if (!filePath || resolvingConflict) return;
    onNotice({
      title: 'Discard your changes and reload?',
      message: `${filePath}\n\nThis reloads the file from disk and discards the unsaved changes in this tab. This can't be undone.`,
      actions: [
        {
          label: 'Discard and reload',
          onClick: async () => {
            setResolvingConflict(true);
            try {
              // performOpenPath flushes, re-reads, and loadFileResult clears the
              // conflict on success. A failed reload keeps the conflict.
              await performOpenPath(filePath, false);
            } finally {
              setResolvingConflict(false);
            }
          },
        },
        { label: 'Keep editing', onClick: () => {} },
      ],
    });
  }, [filePath, resolvingConflict, onNotice, performOpenPath]);

  // Adopt a shell-selected workspace snapshot without reading the older file
  // from disk. Dirty recovery snapshots remain dirty; clean Untitled tabs are
  // restored as clean browser-session state.
  const restoreWorkspaceSnapshot = useCallback(
    (draft: DraftFile, dirty: boolean): WorkspaceRecoveryOutcome => {
      restoreDraft(draft.filePath, dirty, {
        expectedDoc: draft.expectedDoc ?? null,
        expectedSidecar: draft.expectedSidecar ?? null,
        sidecarProtected: draft.sidecarProtected,
        structuralProtected: draft.structuralProtected,
      });
      setLastSavedAt(null);
      const liveEditor = editorRef.current?.getEditor();
      if (liveEditor) {
        setImageBaseDir(liveEditor, draft.filePath ? dirname(draft.filePath) : null);
      }
      const draftComments = draft.comments ?? [];
      const draftSuggestions = draft.suggestions ?? [];
      setLastKnownModel(newestObservedModel(draftComments, draft.chat));
      setLastKnownEffort(newestObservedEffort(draftComments, draft.chat));

      // Prefer the LOSSLESS path: a `valid` docJSON restores the document + every mark at
      // byte-exact positions (nothing relocates, no whitespace drift). restoreDocJSON
      // validates structure + doc↔records bijection and fails closed, so we only install
      // the matching records when it actually restored. `docJSONState` (from the sanitizer)
      // distinguishes a genuine legacy snapshot (`absent`) from a corrupt one (`invalid`).
      const state = draft.docJSONState ?? (draft.docJSON ? 'valid' : 'absent');
      const lossless =
        state === 'valid' && draft.docJSON
          ? editorRef.current?.restoreDocJSON(
              draft.docJSON,
              draftComments,
              draftSuggestions,
              draft.structural ?? [],
            )
          : undefined;
      const ed = editorRef.current?.getEditor();
      let outcome: WorkspaceRecoveryOutcome;
      if (lossless?.ok && ed) {
        outcome = 'lossless';
        setComments(draftComments);
        setSuggestions(draftSuggestions);
        // Detached/quarantined records are mark-less BY DESIGN, so they cannot be rebuilt
        // from the live marks — seed them back into the quarantine store, or they'd vanish.
        quarantinedSuggestionsRef.current = draftSuggestions.filter((s) => s.detached === true);
        // The lossless docJSON restore is self-contained: it restored the document and every
        // mark byte-exact AND seeded the structural record store (metadata-only, in the same
        // transaction, after validating the records against the restored union) — so nothing is
        // re-reconstructed here, which would disturb the byte-exact restored document.
        setTrackedChanges(getTrackedChanges(ed));
      } else {
        // A lossless doc that was INTENDED but couldn't be used — `invalid` envelope, or a
        // `valid` one that failed deep validation — is corruption: degrade EXPLICITLY. Genuine
        // `absent` legacy snapshots take the normal Markdown + unbound relocation path.
        const degraded = state === 'invalid' || (state === 'valid' && !!lossless && !lossless.ok);
        outcome = degraded ? 'degraded' : 'legacy';
        editorRef.current?.setContent(draft.content);
        setComments(draftComments);
        setSuggestions(draftSuggestions);
        const ed2 = editorRef.current?.getEditor();
        if (ed2) {
          // Reconstruct the structural unions FIRST (source → union), then restore inline marks.
          // `setContent(draft.content)` above normalized whitespace, so use the records rebased
          // to that canonical source (`degradedStructural`); a legacy snapshot without them falls
          // back to the live-coordinate `structural` (its pre-fix, possibly-quarantining behavior).
          restoreStructuralFromDraft(ed2, draft.degradedStructural ?? draft.structural ?? []);
          const restored = restorePersistedReviewMarks(
            ed2,
            draftComments,
            draftSuggestions,
            'unbound',
          );
          if (degraded) onNotice(degradedRecoveryNotice());
          else announceUnboundLoad('recovery', restored);
        }
      }
      const session = adoptLoadedSession(draft.aiSession ?? null, draft.filePath);
      documentChat.restore(draft.chat, session);
      const restoredContextFolder = draft.contextFolder ?? null;
      setContextFolder(restoredContextFolder);
      // Workspace recovery is local application state, unlike a portable
      // sidecar. Preserve its bindings as locally approved permissions.
      if (draft.filePath) {
        rememberSessionPermission(window.localStorage, draft.filePath, session);
        rememberContextFolderPermission(window.localStorage, draft.filePath, restoredContextFolder);
      }
      return outcome;
    },
    [
      adoptLoadedSession,
      documentChat,
      restoreDraft,
      restorePersistedReviewMarks,
      restoreStructuralFromDraft,
      announceUnboundLoad,
      onNotice,
      setComments,
      setSuggestions,
    ],
  );

  useEffect(() => {
    if (!editor || !initialWorkspaceSnapshot || initialWorkspaceRestoreStartedRef.current) {
      return;
    }
    initialWorkspaceRestoreStartedRef.current = true;
    const outcome = restoreWorkspaceSnapshot(initialWorkspaceSnapshot, initialWorkspaceDirty);
    onInitialWorkspaceLoaded(tabId, outcome);
  }, [
    editor,
    initialWorkspaceDirty,
    initialWorkspaceSnapshot,
    onInitialWorkspaceLoaded,
    restoreWorkspaceSnapshot,
    tabId,
  ]);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      setTrackedChanges(getTrackedChanges(editor));
      setComments((current) => reconcileCommentsWithDocument(current, editor.state.doc));
    };
    editor.on('update', refresh);
    refresh();
    return () => {
      editor.off('update', refresh);
    };
  }, [editor, setComments]);

  // Chrome reads word/character counts and the current line/column through a
  // value snapshot rather than reaching into this tab. Selection-only
  // transactions matter even when the document did not update — they move the
  // line/column and change the selected word/character counts.
  useEffect(() => {
    if (!editor) return;
    const refreshChrome = () => setChromeRevision((revision) => revision + 1);
    editor.on('transaction', refreshChrome);
    return () => {
      editor.off('transaction', refreshChrome);
    };
  }, [editor]);

  // A formatting gesture that ran into someone else's pending formatting
  // suggestion silently leaves those spans unchanged (v1 cross-author
  // policy) — surface why, but never for Claude's automated applies, whose
  // conflicts planEdits already blocks and reports as skipped.
  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({
      transaction,
    }: {
      transaction: import('@tiptap/pm/state').Transaction;
    }) => {
      if (!transaction.getMeta(FORMAT_BLOCKED_META) || applyingClaudeEditsRef.current) return;
      onNotice({
        title: 'Formatting suggestion in the way',
        message:
          'Part of the selection already carries a pending formatting suggestion by another author, so that part was left unchanged. Resolve the existing suggestion first, then reformat it.',
      });
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor, onNotice]);

  // Unsupported Suggesting-mode gestures are vetoed atomically by the
  // tracking engine. Confirm the block without interrupting the user's flow.
  useEffect(() => {
    if (!editor) return;
    let dismissTimer: number | null = null;
    const onTransaction = ({
      transaction,
    }: {
      transaction: import('@tiptap/pm/state').Transaction;
    }) => {
      const blocked = transaction.getMeta(TRACKING_BLOCKED_META) as TrackingBlockedInfo | undefined;
      if (!blocked || applyingClaudeEditsRef.current) return;
      setSuggestingModeNotice(blocked.notice);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(() => {
        setSuggestingModeNotice(null);
        dismissTimer = null;
      }, 3200);
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    };
  }, [editor]);

  // Mirror the active annotation into the editor as a focus decoration so
  // its text is visibly highlighted alongside the outlined card.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activeAnnotation) {
      editor.commands.setAnnotationFocus(activeAnnotation.kind, activeAnnotation.id);
    } else {
      editor.commands.clearAnnotationFocus();
    }
  }, [editor, activeAnnotation]);

  // Drop the focus when the annotation it points at goes away (resolved,
  // accepted, rejected, deleted) — a stale focus would point at nothing.
  const clearActiveIf = useCallback((kind: AnnotationKind, id: string) => {
    setActiveAnnotation((prev) => (prev?.kind === kind && prev.id === id ? null : prev));
  }, []);

  // A click in the editor reports every annotation layered under it (or none —
  // clicking plain text dismisses the focus). Focus the innermost one, by
  // smallest live range, like Google Docs.
  const handleAnnotationClick = useCallback(
    ({ commentIds, suggestionIds }: AnnotationClickInfo) => {
      const doc = editor?.state.doc;
      if (!doc) return;
      const candidates: { kind: AnnotationKind; id: string; size: number }[] = [];
      for (const id of commentIds) {
        const range = findAnnotationRange(doc, 'comment', id);
        if (range) candidates.push({ kind: 'comment', id, size: range.to - range.from });
      }
      for (const id of suggestionIds) {
        const range = findAnnotationRange(doc, 'suggestion', id);
        if (range) candidates.push({ kind: 'suggestion', id, size: range.to - range.from });
      }
      if (candidates.length === 0) {
        setActiveAnnotation(null);
        return;
      }
      candidates.sort((a, b) => a.size - b.size);
      const winner = candidates[0];
      setActiveAnnotation({ kind: winner.kind, id: winner.id });
      setHighlightActivationRevision((revision) => revision + 1);
    },
    [editor],
  );

  const queueAutoResolveForTrackedRemoval = useCallback(
    (markName: 'tracked_delete' | 'tracked_insert', targetId?: string) => {
      if (!editor) return;
      // Capture before accept/reject mutates the document. Queue this functional
      // update first so the editor-update reconciler sees resolved records after
      // the tracked text and its comment marks disappear.
      const captured = captureCommentsConsumedByTrackedRemoval(
        editor.state.doc,
        markName,
        targetId,
      );
      if (captured.length === 0) return;
      setComments((current) => autoResolveCapturedComments(current, captured));
    },
    [editor, setComments],
  );

  const prepareCommentsForAccept = useCallback(
    (targetId?: string) => {
      if (!editor) return;
      // Capture both protective geometry and accepted-suggestion provenance
      // before either the comment marks or tracked marks are removed.
      const { captured, provenanceCommentIds } = captureCommentsResolvedByAccept(
        editor.state.doc,
        getTrackedChanges(editor),
        targetId,
      );
      if (captured.length > 0) {
        // Queue resolved state first so each mark-removal update reconciles
        // against resolved records rather than dropping them mid-accept.
        setComments((current) => autoResolveCapturedComments(current, captured));
      }
      for (const commentId of provenanceCommentIds) {
        // A provenance-resolved comment may not overlap the accepted edit, so
        // mirror manual Resolve by stripping its still-live highlight.
        editor.commands.unsetComment(commentId);
        clearActiveIf('comment', commentId);
      }
    },
    [editor, setComments, clearActiveIf],
  );

  const handleAcceptAll = useCallback(() => {
    if (!editor) return;
    prepareCommentsForAccept();
    editor.commands.resolveChange(null, 'accept');
  }, [editor, prepareCommentsForAccept]);

  const handleRejectAll = useCallback(() => {
    if (!editor) return;
    queueAutoResolveForTrackedRemoval('tracked_insert');
    editor.commands.resolveChange(null, 'reject');
  }, [editor, queueAutoResolveForTrackedRemoval]);

  const handleAcceptChange = useCallback(
    (id: string) => {
      prepareCommentsForAccept(id);
      editor?.commands.resolveChange(id, 'accept');
      clearActiveIf('suggestion', id);
    },
    [editor, clearActiveIf, prepareCommentsForAccept],
  );

  const handleRejectChange = useCallback(
    (id: string) => {
      queueAutoResolveForTrackedRemoval('tracked_insert', id);
      editor?.commands.resolveChange(id, 'reject');
      clearActiveIf('suggestion', id);
    },
    [editor, clearActiveIf, queueAutoResolveForTrackedRemoval],
  );

  const handleAddComment = useCallback(
    (text: string, intent: ComposerIntent) => {
      const sel = pendingCommentSelection ?? selectionInfo;
      if (!sel || !editor) return;
      const { from, to, text: anchorText } = sel;
      const kind: Comment['kind'] = intent === 'claude' ? 'claude' : 'note';
      const comment = addComment(anchorText, from, to, AUTHOR, kind);
      // Apply comment mark
      editor.chain().focus().setTextSelection({ from, to }).setComment(comment.id, kind).run();
      // The comment has no body field — the user's text is stored as the first
      // reply. Must run before claudeReply.ask() queues its pending AI reply, or
      // Claude's answer renders above the user's question in the thread.
      if (text) {
        addReply(comment.id, text, AUTHOR);
      }
      // Ask Claude only when the user chose the Claude action. The @claude text
      // trigger is retired — intent now comes from the composer's Ask/Note
      // buttons. With no linked session, defer: open the picker and fire once
      // linked (the typed text is preserved on pendingAIRequestRef).
      if (intent === 'claude' && text) {
        if (aiSession) {
          void claudeReply.ask(comment, text, aiSession);
        } else {
          pendingAIRequestRef.current = { commentId: comment.id, userText: text };
          openSessionPicker();
        }
      }
      setActiveAnnotation({ kind: 'comment', id: comment.id });
      setCommentComposerOpen(false);
      editor.commands.clearPendingCommentRange();
      setPendingCommentSelection(null);
      setSelectionInfo(null);
    },
    [
      pendingCommentSelection,
      selectionInfo,
      editor,
      addComment,
      addReply,
      aiSession,
      claudeReply,
      openSessionPicker,
    ],
  );

  const handleSelectionChange = useCallback(
    (info: SelectionInfo | null) => {
      setSelectionInfo(info);
      if (info && !commentComposerOpen) setPendingCommentSelection(info);
    },
    [commentComposerOpen],
  );

  // Keep the target range visibly highlighted while the comment composer is
  // open (the native selection highlight disappears when the textarea takes
  // focus). Rendered as a decoration, so it never dirties the document; it
  // hands off to the real comment mark on submit and vanishes on cancel.
  const handleOpenCommentComposer = useCallback(() => {
    const sel = selectionInfo;
    if (!sel || !editor || editor.isDestroyed) return;
    setPendingCommentSelection(sel);
    setPanelMode('comments');
    editor.commands.setPendingCommentRange(sel.from, sel.to);
    setCommentComposerOpen(true);
  }, [editor, selectionInfo]);

  const handleCancelCommentComposer = useCallback(() => {
    if (editor && !editor.isDestroyed) editor.commands.clearPendingCommentRange();
    setCommentComposerOpen(false);
  }, [editor]);

  const handleDeleteComment = useCallback(
    (commentId: string) => {
      deleteComment(commentId);
      editor?.commands.unsetComment(commentId);
      clearActiveIf('comment', commentId);
      // Deleting a RESOLVED comment dispatches a zero-step transaction (its
      // mark was already stripped on resolve), so onUpdate never fires — dirty
      // must be set explicitly or the deletion is lost on quit.
      markDirty();
    },
    [deleteComment, editor, clearActiveIf, markDirty],
  );

  // "Ask Claude about this" on a note: flip the same anchored card to a Claude
  // thread in place (no duplicate) and send its own text as the first request.
  // Reuses the no-session deferral so a note can be promoted before linking.
  const handlePromoteNote = useCallback(
    (commentId: string) => {
      const note = comments.find((c) => c.id === commentId);
      if (!note) return;
      const userText = note.replies.find((r) => r.authorKind !== 'ai')?.text ?? '';
      if (!userText) return;
      const promoted: Comment = { ...note, kind: 'claude' };
      setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, kind: 'claude' } : c)));
      // Switch the in-document highlight from a note (dotted gray) to a Claude
      // thread (amber): drop the note mark, then re-stamp the span as 'claude'.
      // Two separate commands, not a chain — unsetComment dispatches its own
      // transaction (matching how resolve/unresolve use these commands), and
      // removeMark leaves positions unchanged so the stored range stays valid.
      editor?.commands.unsetComment(commentId);
      editor?.commands.setCommentRange(commentId, note.from, note.to, 'claude');
      markDirty();
      if (aiSession) {
        void claudeReply.ask(promoted, userText, aiSession);
      } else {
        pendingAIRequestRef.current = { commentId, userText };
        openSessionPicker();
      }
      setActiveAnnotation({ kind: 'comment', id: commentId });
    },
    [comments, setComments, editor, markDirty, aiSession, claudeReply, openSessionPicker],
  );

  // Resolving hides the card (unless "Show resolved" is on), so it also drops
  // the focus rather than leaving an outline on a vanished card. The in-text
  // mark is removed entirely so the text goes plain — a resolved comment leaves
  // no highlight behind (the stored from/to lets unresolve put it back).
  const handleResolveComment = useCallback(
    (commentId: string) => {
      resolveComment(commentId);
      editor?.commands.unsetComment(commentId);
      clearActiveIf('comment', commentId);
      markDirty();
    },
    [resolveComment, editor, clearActiveIf, markDirty],
  );

  const handleUnresolveComment = useCallback(
    (commentId: string) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment || !editor) return false;
      // A detached record's stored range is known-bad, so repair relocates by unique
      // text only; a resolved-but-attached record keeps the trust-range rule.
      const anchor = locateCommentForRepair(editor.state.doc, comment);
      if (!anchor) return false;
      // Queue the validated range and unresolved state before restoring the
      // mark, so the mark transaction reconciles against the updated record.
      unresolveComment(commentId, anchor);
      editor.commands.setCommentRange(commentId, anchor.from, anchor.to, comment.kind);
      markDirty();
      return true;
    },
    [unresolveComment, editor, comments, markDirty],
  );

  const {
    handleActivateComment,
    handleActivateHistoryComment,
    handleActivateSuggestion,
    handleViewReplySuggestion,
    handleSyncActivate,
  } = useAnnotationNavigation({
    editor,
    comments,
    trackedChanges,
    commentLayerRef,
    setActiveAnnotation,
  });

  const openChat = useCallback(() => {
    setPanelMode('chat');
    setChatFocusRevision((revision) => revision + 1);
  }, []);

  const handleViewChatSuggestions = useCallback(
    (suggestionIds: string[]) => {
      setPanelMode('comments');
      setShowResolvedComments(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => handleViewReplySuggestion(suggestionIds));
      });
    },
    [handleViewReplySuggestion],
  );

  const handleActivateChatMessage = useCallback((messageId: string) => {
    setPanelMode('chat');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const message = commentLayerRef.current?.querySelector(
          `[data-chat-message-id="${CSS.escape(messageId)}"]`,
        ) as HTMLElement | null;
        message?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        message?.focus({ preventScroll: true });
      });
    });
  }, []);

  const handleAIReplyRequest = useCallback(
    (commentId: string, userText: string) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment) return;
      if (!aiSession) {
        // No session linked yet — stash the request and prompt the user to
        // link one. handlePickSession fires the stashed request afterwards.
        pendingAIRequestRef.current = { commentId, userText };
        openSessionPicker();
        return;
      }
      // Fire-and-forget; useClaudeReply handles errors via failAIReply.
      void claudeReply.ask(comment, userText, aiSession);
    },
    [aiSession, comments, claudeReply, openSessionPicker],
  );

  const handlePickSession = useCallback(
    (binding: AISessionBinding) => {
      const claimed = claimInteractiveSession(binding);
      if (!claimed) return false;
      if (claimed.sessionId !== aiSession?.sessionId) documentChat.restore(undefined, claimed);
      markDirty();
      // If the picker was opened because of a @claude request with no session,
      // fire that request now against the freshly-linked session.
      const pending = pendingAIRequestRef.current;
      pendingAIRequestRef.current = null;
      if (pending) {
        const comment = comments.find((c) => c.id === pending.commentId);
        if (comment) void claudeReply.ask(comment, pending.userText, claimed);
      }
      const pendingChatTurn = pendingChatTurnRef.current;
      pendingChatTurnRef.current = null;
      if (pendingChatTurn) {
        setPanelMode('chat');
        void documentChat.send(pendingChatTurn, claimed);
      }
      return true;
    },
    [aiSession?.sessionId, claimInteractiveSession, markDirty, comments, claudeReply, documentChat],
  );

  const handleChatSend = useCallback(
    (text: string) => {
      if (!aiSession) {
        pendingChatTurnRef.current = text;
        openSessionPicker();
        return;
      }
      void documentChat.send(text, aiSession);
    },
    [aiSession, documentChat, openSessionPicker],
  );

  const handleStartNewSession = useCallback(() => {
    void (async () => {
      const path = filePath ?? (await handleSaveAs());
      if (!path) return;
      handlePickSession({
        provider: 'claude-code',
        sessionId: crypto.randomUUID(),
        cwd: dirname(path) ?? '.',
        linkedAt: new Date().toISOString(),
        createdByQuill: true,
      });
    })();
  }, [filePath, handlePickSession, handleSaveAs]);

  const handleUnlinkSession = useCallback(() => {
    onReleaseSession(tabId);
    setAISession(null);
    if (filePath) rememberSessionPermission(window.localStorage, filePath, null);
    documentChat.reset();
    markDirty();
  }, [documentChat, filePath, markDirty, onReleaseSession, tabId]);

  const handleLinkContextFolder = useCallback(() => {
    void chooseContextFolder();
  }, [chooseContextFolder]);

  const handleUnlinkContextFolder = useCallback(() => {
    setContextFolder(null);
    if (filePath) rememberContextFolderPermission(window.localStorage, filePath, null);
    markDirty();
  }, [filePath, markDirty]);

  const pendingSuggestionCount = countLogicalSuggestionCards(
    trackedChanges.filter((change) => change.status === 'pending'),
  );
  const unresolvedCommentCount = comments.filter((comment) => !comment.resolved).length;
  const resolvedCommentCount = comments.length - unresolvedCommentCount;

  const handleCloseSessionPicker = useCallback(() => {
    pendingChatTurnRef.current = null;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getEditor: () => editor,
      save: handleSave,
      saveAs: handleSaveAs,
      open: performOpen,
      openPath: performOpenPath,
      newDocument: performNew,
      exportPdf: handleExportPdf,
      setMode: setIsSuggesting,
      setZoom: (nextZoom) => setZoom(clampZoom(nextZoom)),
      acceptAll: handleAcceptAll,
      rejectAll: handleRejectAll,
      openSessionPicker,
      closeSessionPicker: handleCloseSessionPicker,
      pickSession: handlePickSession,
      focusFind: () => setFindOpen(true),
      openChat,
      clearActiveAnnotation: () => setActiveAnnotation(null),
      unlinkSession: handleUnlinkSession,
      linkContextFolder: handleLinkContextFolder,
      unlinkContextFolder: handleUnlinkContextFolder,
      getWorkspaceSnapshot,
      flushPendingSave,
      getPersistenceSnapshot,
    }),
    [
      editor,
      flushPendingSave,
      getPersistenceSnapshot,
      getWorkspaceSnapshot,
      handleAcceptAll,
      handleCloseSessionPicker,
      handleExportPdf,
      handleLinkContextFolder,
      handlePickSession,
      handleRejectAll,
      handleSave,
      handleSaveAs,
      handleUnlinkContextFolder,
      handleUnlinkSession,
      openSessionPicker,
      openChat,
      performNew,
      performOpen,
      performOpenPath,
    ],
  );

  useEffect(() => {
    onMetaChange(tabId, {
      filePath,
      title: filePath ? basename(filePath) : 'Untitled',
      isDirty,
      conflict: saveConflict !== null,
      autosaveAttention,
    });
  }, [filePath, isDirty, saveConflict, autosaveAttention, onMetaChange, tabId]);

  useEffect(() => {
    if (!isActive) return;
    onChromeChange(tabId, {
      editor,
      filePath,
      isDirty,
      lastSavedAt,
      isSuggesting,
      pendingSuggestionCount,
      zoom,
      aiSession,
      contextFolder,
      lastKnownModel,
      lastKnownEffort,
      stats: computeDocumentStats(editor),
      autosaveStatus,
    });
  }, [
    aiSession,
    autosaveStatus,
    chromeRevision,
    contextFolder,
    editor,
    filePath,
    isActive,
    isDirty,
    isSuggesting,
    lastKnownModel,
    lastKnownEffort,
    lastSavedAt,
    onChromeChange,
    pendingSuggestionCount,
    tabId,
    zoom,
  ]);

  return (
    <>
      {saveConflict && (
        <ConflictBanner
          which={saveConflict.which}
          flash={conflictFlash}
          busy={resolvingConflict}
          onOverwrite={handleOverwriteConflict}
          onSaveCopy={handleSaveCopyConflict}
          onReload={handleReloadConflict}
        />
      )}
      <div className="studio-body">
        <div className="workspace doc-scroll" ref={scrollAreaRef}>
          {suggestingModeNotice && (
            <div className="suggesting-mode-notice" role="status" aria-live="polite">
              {suggestingModeNotice}
            </div>
          )}
          {findOpen && isActive && (
            <FindBar
              editor={editor}
              onClose={() => {
                setFindOpen(false);
                editor?.commands.focus();
              }}
            />
          )}
          <div className="editor-scroll-area">
            <div
              className="editor-page-zoom-wrapper"
              style={{ fontSize: `${Math.round(zoom * 100)}%` }}
              data-editor-zoom={zoom}
            >
              <QuillEditor
                key={editorKey}
                ref={editorRef}
                initialContent=""
                isActive={isActive}
                isSuggesting={isSuggesting}
                authorID={AUTHOR}
                onUpdate={markDirty}
                onSelectionChange={handleSelectionChange}
                onEditorReady={setEditor}
                onAnnotationClick={handleAnnotationClick}
                onOpenChat={openChat}
              />
            </div>
          </div>

          {selectionInfo &&
            !commentComposerOpen &&
            (() => {
              const commentLayer = commentLayerRef.current;
              const commentLayerRect = commentLayer?.getBoundingClientRect();
              // Fixed positioning: coordsAtPos reports the post-reflow viewport
              // coordinates directly, so no scale compensation is needed.
              const top = editor
                ? editor.view.coordsAtPos(selectionInfo.from).top
                : selectionInfo.top;
              const left = commentLayerRect ? commentLayerRect.left - 36 : undefined;
              return (
                <AddCommentButton
                  top={top}
                  left={left}
                  visible
                  onOpen={handleOpenCommentComposer}
                />
              );
            })()}
        </div>

        <aside className="comment-layer" ref={commentLayerRef} aria-label="Review panel">
          <PanelHeader
            mode={panelMode}
            commentCount={unresolvedCommentCount + pendingSuggestionCount}
            showResolved={showResolvedComments}
            resolvedCount={resolvedCommentCount}
            aiSession={aiSession}
            onModeChange={(mode) => {
              setPanelMode(mode);
              if (mode === 'chat') setChatFocusRevision((revision) => revision + 1);
            }}
            onToggleResolved={() => setShowResolvedComments((show) => !show)}
            onChangeSession={openSessionPicker}
            onStartNewSession={handleStartNewSession}
            onUnlinkSession={handleUnlinkSession}
          />
          <CommentLayer
            editor={editor}
            comments={comments}
            activeCommentId={activeCommentId}
            activeSuggestionId={activeSuggestionId}
            containerRef={commentLayerRef}
            trackedChanges={trackedChanges}
            commentComposer={commentComposerOpen ? pendingCommentSelection : null}
            scrollTop={scrollTop}
            zoom={zoom}
            layoutRevision={scrollTick}
            highlightActivationRevision={highlightActivationRevision}
            hidden={panelMode !== 'comments'}
            showResolved={showResolvedComments}
            onShowResolvedChange={setShowResolvedComments}
            onReply={(id, text) => {
              addReply(id, text, AUTHOR);
              markDirty();
            }}
            onAIReplyRequest={handleAIReplyRequest}
            onCancelAIReply={claudeReply.cancel}
            onRetryAIReply={claudeReply.retry}
            onDismissAIReply={(commentId, replyId) => {
              dismissAIReply(commentId, replyId);
              markDirty();
            }}
            onViewReplySuggestion={handleViewReplySuggestion}
            onOpenSessionPicker={openSessionPicker}
            onResolve={handleResolveComment}
            onUnresolve={handleUnresolveComment}
            onDelete={handleDeleteComment}
            onPromoteNote={handlePromoteNote}
            onActivate={handleActivateComment}
            onActivateHistory={handleActivateHistoryComment}
            onActivateSuggestion={handleActivateSuggestion}
            onSyncActivate={handleSyncActivate}
            onActivateChatMessage={handleActivateChatMessage}
            onAcceptChange={handleAcceptChange}
            onRejectChange={handleRejectChange}
            onSubmitComment={handleAddComment}
            onCancelComment={handleCancelCommentComposer}
            hasSession={aiSession != null}
          />
          <ChatPanel
            hidden={panelMode !== 'chat'}
            messages={documentChat.messages}
            trackedChanges={trackedChanges}
            focusRevision={chatFocusRevision}
            onSend={handleChatSend}
            onCancel={(messageId) => void documentChat.cancel(messageId)}
            onRetry={(messageId) => void documentChat.retry(messageId)}
            onDismiss={documentChat.dismiss}
            onViewSuggestions={handleViewChatSuggestions}
            busy={aiGate.busy}
          />
        </aside>
      </div>
    </>
  );
});

export default DocumentTab;
