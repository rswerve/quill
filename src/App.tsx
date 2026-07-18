import { useCallback, useEffect, useRef, useState } from 'react';
import AppModal from './components/AppModal';
import DocumentTab from './components/DocumentTab';
import type {
  DocumentTabChromeSnapshot,
  DocumentTabHandle,
  DocumentTabMetaSnapshot,
  WorkspaceRecoveryOutcome,
} from './components/DocumentTab';
import Footer from './components/Footer';
import Rail from './components/Rail';
import SessionPicker from './components/SessionPicker';
import TabStrip from './components/TabStrip';
import Topbar from './components/Topbar';
import { useWorkspaceAutosave } from './hooks/useDraftAutosave';
import type { WorkspaceReadResult } from './hooks/useDraftAutosave';
import { useTabRegistry } from './hooks/useTabRegistry';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useSessionClaimRegistry } from './hooks/useSessionClaimRegistry';
import {
  readClaudeRunOptions,
  writeClaudeEffort,
  writeClaudeModel,
} from './utils/claudePreferences';
import { basename, canonicalDocumentPath, dirname } from './utils/path';
import {
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  syncRecentMenu,
} from './utils/recentFiles';
import { clampZoom, loadZoomPreference, saveZoomPreference } from './utils/zoomPreference';
import {
  buildDiscardedRecoveryWorkspaceFile,
  buildDiscardedWorkspaceFile,
  buildWorkspaceFile,
  type WorkspaceTabSource,
} from './utils/workspacePersistence';
import type {
  AISessionBinding,
  ClaudeEffort,
  ClaudeModelAlias,
  ClaudeRunOptions,
  DraftFile,
  WorkspaceFile,
  WorkspaceTab,
} from './types';
import './App.css';
import type { TabAction, TabMeta } from './hooks/tabsReducer';

interface DiscardGuard {
  tabIds: string[];
  run: () => void;
}

let nextTabNumber = 1;

// Max flush rounds before the quit guard fails closed (guards every dirty tab).
const MAX_FLUSH_ROUNDS = 5;

function createUntitledTab(): TabMeta {
  return {
    id: `tab-${nextTabNumber++}`,
    filePath: null,
    initialFilePath: null,
    title: 'Untitled',
    isDirty: false,
    initialWorkspaceSnapshot: null,
    initialWorkspaceDirty: false,
    restoredFromWorkspace: false,
  };
}

function createFileTab(path: string): TabMeta {
  return {
    id: `tab-${nextTabNumber++}`,
    filePath: path,
    initialFilePath: path,
    title: basename(path),
    isDirty: false,
    initialWorkspaceSnapshot: null,
    initialWorkspaceDirty: false,
    restoredFromWorkspace: false,
  };
}

function workspaceTabMeta(tab: WorkspaceTab): TabMeta {
  return {
    id: tab.tabId,
    filePath: tab.filePath,
    initialFilePath: tab.snapshot ? null : tab.filePath,
    initialWorkspaceSnapshot: tab.snapshot ?? null,
    initialWorkspaceDirty: tab.dirty,
    restoredFromWorkspace: true,
    title: tab.filePath ? basename(tab.filePath) : 'Untitled',
    isDirty: tab.dirty,
  };
}

function tabsFromWorkspace(
  workspace: WorkspaceFile,
  includeDirty: boolean,
): { tabs: TabMeta[]; activeTabId: string } {
  const restored = workspace.tabs.filter((tab) => includeDirty || !tab.dirty).map(workspaceTabMeta);
  const tabs = restored.length > 0 ? restored : [createUntitledTab()];
  const activeTabId = tabs.some((tab) => tab.id === workspace.activeTabId)
    ? workspace.activeTabId
    : tabs[0].id;
  return { tabs, activeTabId };
}

function draftSnapshot(draft: DraftFile) {
  return {
    filePath: draft.filePath,
    content: draft.content,
    // Carry the lossless representation through the shell so a restored-but-not-remounted
    // tab keeps byte-exact recovery instead of silently degrading to Markdown.
    ...(draft.docJSON && draft.docJSONVersion
      ? { docJSON: draft.docJSON, docJSONVersion: draft.docJSONVersion }
      : {}),
    comments: draft.comments,
    suggestions: draft.suggestions,
    aiSession: draft.aiSession,
    contextFolder: draft.contextFolder,
  };
}

function emptyChrome(tab: TabMeta, zoom: number): DocumentTabChromeSnapshot {
  return {
    editor: null,
    filePath: tab.filePath,
    isDirty: tab.isDirty,
    lastSavedAt: null,
    isSuggesting: false,
    pendingSuggestionCount: 0,
    zoom,
    aiSession: null,
    contextFolder: null,
    lastKnownModel: null,
    lastKnownEffort: null,
    stats: { words: 0, chars: 0, line: 1, column: 1 },
    autosaveStatus: { state: 'idle' },
  };
}

export default function App() {
  const {
    tabs,
    activeTabId,
    commit: rawCommitTabs,
  } = useTabRegistry(() => {
    const first = createUntitledTab();
    return { tabs: [first], activeTabId: first.id };
  });
  const [chrome, setChrome] = useState<DocumentTabChromeSnapshot>(() =>
    emptyChrome(tabs[0], loadZoomPreference()),
  );
  const [defaultZoom, setDefaultZoom] = useState(loadZoomPreference);
  const [hasNativeMenu, setHasNativeMenu] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTabId, setPickerTabId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    title: string;
    message: string;
    actions?: Array<{ label: string; onClick: () => void | Promise<void> }>;
  } | null>(null);
  const [discardGuard, setDiscardGuard] = useState<DiscardGuard | null>(null);
  const [closeGuardTabId, setCloseGuardTabId] = useState<string | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<WorkspaceFile | null>(null);
  const [invalidWorkspace, setInvalidWorkspace] = useState<Extract<
    WorkspaceReadResult,
    { status: 'invalid' }
  > | null>(null);
  const [persistenceSuspended, setPersistenceSuspended] = useState(false);
  // A degraded workspace recovery is holding persistence suspended until the user preserves
  // the corrupt original (mirrors `invalidWorkspace`, but discovered AFTER hydration).
  const [degradedRecovery, setDegradedRecovery] = useState(false);
  // Recovery hydration accumulator: which snapshot-bearing tabs we're still waiting on, and
  // the outcome each reported. A ref (not state) so a tab reporting can't race a re-render.
  const recoveryRef = useRef<{
    expected: Set<string>;
    outcomes: Map<string, WorkspaceRecoveryOutcome>;
  } | null>(null);
  const [tabHandleRevision, setTabHandleRevision] = useState(0);
  // Cross-tab "one Claude session per document" registry. Its callbacks are
  // referentially stable; destructuring them keeps App's dependency arrays
  // granular (a member-expression dep collapses to the whole object in eslint).
  const {
    claim: registryClaimSession,
    releaseTab: releaseSessionClaim,
    clear: clearSessionClaims,
    getOwnerTabId: getSessionClaimOwner,
    revision: sessionClaimRevision,
  } = useSessionClaimRegistry();
  const [claudeModel, setClaudeModel] = useState<ClaudeModelAlias | null>(
    () => readClaudeRunOptions(window.localStorage).model,
  );
  const [claudeEffort, setClaudeEffort] = useState<ClaudeEffort | null>(
    () => readClaudeRunOptions(window.localStorage).effort,
  );

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  // Mirror each committed transition into the same-tick refs App reads. The
  // registry's own stateRef drives multi-commit composition; this keeps App's
  // read-refs (which eslint recognizes as stable useRefs) in lockstep.
  const commitTabs = useCallback(
    (action: TabAction) => {
      const next = rawCommitTabs(action);
      tabsRef.current = next.tabs;
      activeTabIdRef.current = next.activeTabId;
      return next;
    },
    [rawCommitTabs],
  );
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const defaultZoomRef = useRef(defaultZoom);
  defaultZoomRef.current = defaultZoom;
  const workspaceReadyRef = useRef(workspaceReady);
  workspaceReadyRef.current = workspaceReady;
  const persistenceSuspendedRef = useRef(persistenceSuspended);
  persistenceSuspendedRef.current = persistenceSuspended;
  const pendingOpenPathsRef = useRef<string[]>([]);
  const hydrationStartedRef = useRef(false);
  const tabHandlesRef = useRef(new Map<string, DocumentTabHandle>());
  const tabHandleReadyIdsRef = useRef(new Set<string>());
  const tabRefCallbacksRef = useRef(new Map<string, (handle: DocumentTabHandle | null) => void>());
  const chromeByTabRef = useRef(new Map<string, DocumentTabChromeSnapshot>());
  const runOptionsRef = useRef<ClaudeRunOptions>({
    model: claudeModel,
    effort: claudeEffort,
  });
  runOptionsRef.current = { model: claudeModel, effort: claudeEffort };

  const getClaudeRunOptions = useCallback(() => runOptionsRef.current, []);
  const showNotice = useCallback(
    (nextNotice: {
      title: string;
      message: string;
      actions?: Array<{ label: string; onClick: () => void | Promise<void> }>;
    }) => setNotice(nextNotice),
    [],
  );
  const handleRecentFile = useCallback((path: string) => {
    void syncRecentMenu(addRecentFile(path));
  }, []);

  const activeHandle = useCallback(
    () => tabHandlesRef.current.get(activeTabIdRef.current) ?? null,
    [],
  );

  const getTabSnapshot = useCallback((tabId: string) => {
    const initial = tabsRef.current.find((tab) => tab.id === tabId)?.initialWorkspaceSnapshot;
    if (initial) return draftSnapshot(initial);
    return tabHandlesRef.current.get(tabId)?.getWorkspaceSnapshot() ?? null;
  }, []);

  const getCurrentWorkspace = useCallback(() => {
    if (persistenceSuspendedRef.current) return null;
    return buildWorkspaceFile(tabsRef.current, activeTabIdRef.current, getTabSnapshot);
  }, [getTabSnapshot]);

  const workspaceRevision = [
    activeTabId,
    tabHandleRevision,
    ...tabs.map((tab) => `${tab.id}:${tab.filePath ?? ''}:${tab.isDirty ? 1 : 0}`),
  ].join('|');
  const { readWorkspace, writeWorkspace, deleteWorkspace, quarantineWorkspace } =
    useWorkspaceAutosave({
      enabled: workspaceReady && !pendingRecovery && !persistenceSuspended,
      hasDirtyTabs: tabs.some((tab) => tab.isDirty),
      revision: workspaceRevision,
      getWorkspace: getCurrentWorkspace,
    });

  const handleTabRef = useCallback((tabId: string, handle: DocumentTabHandle | null) => {
    const previous = tabHandlesRef.current.get(tabId);
    if (handle) {
      tabHandlesRef.current.set(tabId, handle);
      if (!previous && !tabHandleReadyIdsRef.current.has(tabId)) {
        tabHandleReadyIdsRef.current.add(tabId);
        setTabHandleRevision((revision) => revision + 1);
      }
    } else tabHandlesRef.current.delete(tabId);
  }, []);

  const tabRefFor = (tabId: string) => {
    let callback = tabRefCallbacksRef.current.get(tabId);
    if (!callback) {
      callback = (handle) => handleTabRef(tabId, handle);
      tabRefCallbacksRef.current.set(tabId, callback);
    }
    return callback;
  };

  const chromeForTab = useCallback((tabId: string) => {
    const cached = chromeByTabRef.current.get(tabId);
    if (cached) return cached;
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    return tab ? emptyChrome(tab, defaultZoomRef.current) : chromeRef.current;
  }, []);

  const applyWorkspaceState = useCallback(
    (workspace: WorkspaceFile, includeDirty: boolean) => {
      const restored = tabsFromWorkspace(workspace, includeDirty);
      for (const tab of restored.tabs) {
        const numericId = /^tab-(\d+)$/.exec(tab.id)?.[1];
        if (numericId) nextTabNumber = Math.max(nextTabNumber, Number(numericId) + 1);
      }
      tabHandlesRef.current.clear();
      tabHandleReadyIdsRef.current.clear();
      tabRefCallbacksRef.current.clear();
      chromeByTabRef.current.clear();
      clearSessionClaims();
      commitTabs({ type: 'hydrate', tabs: restored.tabs, activeTabId: restored.activeTabId });
      setChrome(
        emptyChrome(
          restored.tabs.find((tab) => tab.id === restored.activeTabId) ?? restored.tabs[0],
          defaultZoomRef.current,
        ),
      );
      return restored;
    },
    [commitTabs, clearSessionClaims],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
      commitTabs({ type: 'activate', tabId });
      // Refresh chrome even when the tab is already active — the reducer bails
      // to the same state in that case, but the original activateTab always
      // re-pushed chrome, so preserve that.
      setChrome(chromeForTab(tabId));
    },
    [chromeForTab, commitTabs],
  );

  // Translate the registry's tab-id verdict into a human notice for DocumentTab.
  const claimSession = useCallback(
    (tabId: string, binding: AISessionBinding) => {
      const result = registryClaimSession(tabId, binding.sessionId);
      if (result.allowed) return { allowed: true };
      const owner = tabsRef.current.find((tab) => tab.id === result.ownerTabId);
      return { allowed: false, ownerTitle: owner?.title ?? 'another open document' };
    },
    [registryClaimSession],
  );

  const addNewTab = useCallback(() => {
    if (!workspaceReadyRef.current) return;
    const tab = createUntitledTab();
    // addTab appends AND activates atomically; chrome is the only side the
    // reducer doesn't own, so push it here (what activateTab did before).
    commitTabs({ type: 'addTab', tab });
    setChrome(chromeForTab(tab.id));
  }, [chromeForTab, commitTabs]);

  const addOrFocusPath = useCallback(
    (path: string) => {
      if (!workspaceReadyRef.current) {
        if (!pendingOpenPathsRef.current.includes(path)) pendingOpenPathsRef.current.push(path);
        return null;
      }
      const pathIdentity = canonicalDocumentPath(path);
      const existing = tabsRef.current.find((tab) => {
        const ownedPath = tab.filePath ?? tab.initialFilePath;
        return ownedPath !== null && canonicalDocumentPath(ownedPath) === pathIdentity;
      });
      if (existing) {
        activateTab(existing.id);
        return existing.id;
      }

      // Canonical-path dedup stays here (App owns path identity); the registry
      // just gets a clean add-then-activate.
      const tab = createFileTab(path);
      commitTabs({ type: 'addTab', tab });
      setChrome(chromeForTab(tab.id));
      return tab.id;
    },
    [activateTab, chromeForTab, commitTabs],
  );

  const handleRequestSavePath = useCallback(
    (tabId: string, path: string) => {
      const pathIdentity = canonicalDocumentPath(path);
      const owner = tabsRef.current.find((tab) => {
        if (tab.id === tabId) return false;
        const ownedPath = tab.filePath ?? tab.initialFilePath;
        return ownedPath !== null && canonicalDocumentPath(ownedPath) === pathIdentity;
      });
      if (!owner) return true;

      activateTab(owner.id);
      setNotice({
        title: 'File already open',
        message: `“${owner.title}” is already open in another tab. Close that tab before saving a different document to this path.`,
      });
      return false;
    },
    [activateTab],
  );

  useEffect(() => {
    if (hydrationStartedRef.current) return;
    hydrationStartedRef.current = true;
    void (async () => {
      const result = await readWorkspace();
      if (result.status === 'valid') {
        const { workspace } = result;
        const hasDirtyTabs = workspace.tabs.some((tab) => tab.dirty);
        applyWorkspaceState(workspace, !hasDirtyTabs);
        if (hasDirtyTabs) setPendingRecovery(workspace);
      } else if (result.status === 'invalid') {
        persistenceSuspendedRef.current = true;
        setPersistenceSuspended(true);
        setInvalidWorkspace(result);
      }
      workspaceReadyRef.current = true;
      setWorkspaceReady(true);
    })();
  }, [applyWorkspaceState, readWorkspace]);

  useEffect(() => {
    if (!workspaceReady) return;
    const pending = pendingOpenPathsRef.current.splice(0);
    for (const path of pending) addOrFocusPath(path);
  }, [addOrFocusPath, workspaceReady]);

  const closeTabImmediately = useCallback(
    (tabId: string) => {
      const currentTabs = tabsRef.current;
      if (!currentTabs.some((tab) => tab.id === tabId)) return;
      // Capture before the commit — the commit rewrites activeTabIdRef.
      const closingActiveTab = activeTabIdRef.current === tabId;
      // Allocate the fresh Untitled ONLY when this close empties the set, so an
      // ordinary close never advances the tab counter — and the reducer stays
      // pure (it consumes fallbackTab, never mints it).
      const willEmpty = currentTabs.length === 1;
      const next = commitTabs({
        type: 'close',
        tabId,
        fallbackTab: willEmpty ? createUntitledTab() : null,
      });
      tabHandlesRef.current.delete(tabId);
      tabHandleReadyIdsRef.current.delete(tabId);
      chromeByTabRef.current.delete(tabId);
      releaseSessionClaim(tabId);
      tabRefCallbacksRef.current.delete(tabId);
      if (pickerTabId === tabId) {
        setPickerOpen(false);
        setPickerTabId(null);
      }
      // Only an active close moves focus; push chrome for the tab the reducer
      // promoted (the slid-in survivor, or the fresh fallback).
      if (closingActiveTab) setChrome(chromeForTab(next.activeTabId));
    },
    [chromeForTab, commitTabs, pickerTabId, releaseSessionClaim],
  );

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (!tab.isDirty) {
        closeTabImmediately(tabId);
        return;
      }
      // A dirty tab: try to autosave-flush it first (a saved tab edited inside the
      // debounce shouldn't prompt), then close if it's now clean, else fall back to the
      // guard. A flush error fails closed → guard rather than close-and-lose.
      void (async () => {
        const handle = tabHandlesRef.current.get(tabId);
        let stillDirty = true;
        try {
          stillDirty = handle ? await handle.flushPendingSave() : true;
        } catch {
          stillDirty = true;
        }
        if (!tabsRef.current.some((candidate) => candidate.id === tabId)) return; // closed meanwhile
        if (stillDirty) setCloseGuardTabId(tabId);
        else closeTabImmediately(tabId);
      })();
    },
    [closeTabImmediately],
  );

  const handleInitialFileLoaded = useCallback(
    (tabId: string, loaded: boolean) => {
      if (!loaded) {
        closeTabImmediately(tabId);
        return;
      }
      commitTabs({ type: 'clearInitialFilePath', tabId });
    },
    [closeTabImmediately, commitTabs],
  );

  // Called after all snapshot-bearing tabs of a suspended recovery have reported: resume
  // persistence when everything restored cleanly, or hold it suspended and raise the
  // Preserve gate when any tab degraded (a corrupt lossless doc) so the original recovery
  // file is quarantined BEFORE a fresh write can overwrite it.
  const finalizeRecovery = useCallback(() => {
    const recovery = recoveryRef.current;
    if (!recovery) return;
    recoveryRef.current = null;
    const anyDegraded = [...recovery.outcomes.values()].includes('degraded');
    if (anyDegraded) {
      setDegradedRecovery(true); // stays suspended until Preserve & Continue
    } else {
      persistenceSuspendedRef.current = false;
      setPersistenceSuspended(false);
    }
  }, []);

  const handleInitialWorkspaceLoaded = useCallback(
    (tabId: string, outcome: WorkspaceRecoveryOutcome) => {
      commitTabs({ type: 'clearInitialWorkspaceSnapshot', tabId });
      const recovery = recoveryRef.current;
      if (recovery?.expected.has(tabId)) {
        recovery.outcomes.set(tabId, outcome);
        if (recovery.outcomes.size === recovery.expected.size) finalizeRecovery();
      }
    },
    [commitTabs, finalizeRecovery],
  );

  const handleTabMetaChange = useCallback(
    (tabId: string, snapshot: DocumentTabMetaSnapshot) => {
      // The keep-pending guard and skip-if-unchanged bail now live in the
      // reducer; a same-ref return means React re-renders nothing.
      commitTabs({ type: 'applyMetaSnapshot', tabId, snapshot });
    },
    [commitTabs],
  );

  const handleChromeChange = useCallback((tabId: string, snapshot: DocumentTabChromeSnapshot) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (tab?.initialFilePath && snapshot.filePath === null) return;
    chromeByTabRef.current.set(tabId, snapshot);
    if (activeTabIdRef.current === tabId) setChrome(snapshot);
  }, []);

  const handleOpenSessionPicker = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      setPickerTabId(tabId);
      setPickerOpen(true);
    },
    [activateTab],
  );

  useEffect(() => {
    saveZoomPreference(defaultZoom);
  }, [defaultZoom]);

  useEffect(() => {
    const name = chrome.filePath ? basename(chrome.filePath) : 'Untitled';
    document.title = chrome.isDirty ? `${name} •` : name;
  }, [chrome.filePath, chrome.isDirty]);

  // Flush every open tab's pending autosave (and drain its coordinator) before a
  // close/quit, then report which tabs are STILL dirty, from a QUIESCENT read. Because a
  // tab can be edited AFTER its own flush resolved but BEFORE the round ends (its stale
  // result would read clean), this loops: each round snapshots every tab's persistence
  // revision, flushes all, then re-checks — if the tab SET changed or any revision
  // advanced during the round, it flushes again, until the set is stable. It iterates the
  // AUTHORITATIVE tab list (a handleless dirty tab is retained, a thrown flush is
  // retained — fail closed). If the bound is exhausted without quiescing, it THROWS so
  // both quit paths abort the close (a dirty-filter could be empty and let quit proceed).
  const flushAllPendingSaves = useCallback(async (): Promise<string[]> => {
    const revisionOf = (id: string): number | null =>
      tabHandlesRef.current.get(id)?.getPersistenceSnapshot().revision ?? null;
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
      const ids = tabsRef.current.map((tab) => tab.id);
      const before = new Map(ids.map((id) => [id, revisionOf(id)]));
      const results = await Promise.all(
        ids.map(async (id) => {
          const handle = tabHandlesRef.current.get(id);
          if (!handle)
            return { id, dirty: tabsRef.current.find((t) => t.id === id)?.isDirty ?? false };
          try {
            return { id, dirty: await handle.flushPendingSave() };
          } catch {
            return { id, dirty: true };
          }
        }),
      );
      // Quiescent iff the tab set is unchanged AND no tab's revision advanced (i.e. no
      // edit and no handle appearing/vanishing) during the round.
      const afterIds = tabsRef.current.map((tab) => tab.id);
      const setChanged = afterIds.length !== ids.length || afterIds.some((id) => !before.has(id));
      const advanced = afterIds.some((id) => before.has(id) && before.get(id) !== revisionOf(id));
      if (!setChanged && !advanced) {
        return [...new Set(results.filter((entry) => entry.dirty).map((entry) => entry.id))];
      }
    }
    // Bound exhausted without quiescing → FAIL CLOSED by THROWING. Returning a
    // dirty-filter here is not reliably fail-closed: it can be empty (stale React
    // metadata, or a round that saved clean before re-dirtying), which would let quit
    // proceed. Throwing propagates to both quit paths' catch blocks, which abort the
    // close/exit and keep the window open.
    throw new Error('Quit flush did not reach a stable state; aborting close to avoid data loss.');
  }, []);

  const guardDirtyTabs = useCallback(
    (action: () => void) => {
      void (async () => {
        try {
          const dirtyTabIds = await flushAllPendingSaves();
          if (dirtyTabIds.length === 0) action();
          else setDiscardGuard({ tabIds: dirtyTabIds, run: action });
        } catch (error) {
          // Fail CLOSED: if the pre-quit flush errors, do NOT run the action (exit /
          // close) — that could quit before unsaved work is persisted.
          console.error('Quit flush failed; aborting the quit:', error);
        }
      })();
    },
    [flushAllPendingSaves],
  );

  const handleSave = useCallback(
    () => activeHandle()?.save() ?? Promise.resolve(null),
    [activeHandle],
  );
  const handleSaveAs = useCallback(
    () => activeHandle()?.saveAs() ?? Promise.resolve(null),
    [activeHandle],
  );

  const handleOpen = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('show_open_dialog');
      if (path) addOrFocusPath(path);
    } catch (error) {
      setNotice({ title: 'Could not open file', message: String(error) });
    }
  }, [addOrFocusPath]);

  const handleExportPdf = useCallback(() => activeHandle()?.exportPdf(), [activeHandle]);
  const handleQuit = useCallback(() => {
    guardDirtyTabs(() => {
      void (async () => {
        await writeWorkspace();
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('exit_app');
      })();
    });
  }, [guardDirtyTabs, writeWorkspace]);

  const handleCopyDiagnostics = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const diagnostics = await invoke<{
        version: string;
        os: string;
        arch: string;
        log_dir: string;
      }>('get_diagnostics');
      const text = [
        `Quill ${diagnostics.version}`,
        `OS: ${diagnostics.os} (${diagnostics.arch})`,
        `Logs: ${diagnostics.log_dir}`,
      ].join('\n');
      await navigator.clipboard.writeText(text);
      setNotice({
        title: 'Diagnostics copied',
        message: `Paste this into your bug report:\n\n${text}\n\nUse Help → Show Logs to attach the log file.`,
      });
    } catch {
      // Non-Tauri context or clipboard denied — nothing actionable to show.
    }
  }, []);

  const handleRevealLogs = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_logs');
    } catch {
      // Non-Tauri context.
    }
  }, []);

  const menuHandlersRef = useRef({
    addNewTab,
    addOrFocusPath,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExportPdf,
    handleQuit,
    handleCopyDiagnostics,
    handleRevealLogs,
  });
  menuHandlersRef.current = {
    addNewTab,
    addOrFocusPath,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExportPdf,
    handleQuit,
    handleCopyDiagnostics,
    handleRevealLogs,
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');
        unlisten = await listen<string>('deep-link-open', (event) => {
          if (event.payload) menuHandlersRef.current.addOrFocusPath(event.payload);
        });

        const pending = await invoke<string | null>('take_pending_deep_link');
        if (pending) menuHandlersRef.current.addOrFocusPath(pending);
      } catch {
        // Non-Tauri context (e.g. plain dev server) — ignore.
      }
    })();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const off = await win.onCloseRequested((event) => {
          // preventDefault must be synchronous; flush + decide happens right after.
          event.preventDefault();
          void (async () => {
            try {
              const dirtyTabIds = await flushAllPendingSaves();
              if (dirtyTabIds.length === 0) {
                void writeWorkspace().finally(() => void win.destroy());
                return;
              }
              setDiscardGuard({ tabIds: dirtyTabIds, run: () => void win.destroy() });
            } catch (error) {
              // Fail CLOSED: a flush/guard error must NOT destroy the window — closing
              // on an errored flush could drop unsaved work. Keep it open (preventDefault
              // already did); the user can retry closing.
              console.error('Close-requested flush failed; keeping the window open:', error);
            }
          })();
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        // Non-Tauri context.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [writeWorkspace, flushAllPendingSaves]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const wire = async (event: string, action: () => void) => {
          unlisteners.push(await listen(event, action));
        };
        await wire('menu-new', () => menuHandlersRef.current.addNewTab());
        await wire('menu-open', () => void menuHandlersRef.current.handleOpen());
        await wire('menu-save', () => void menuHandlersRef.current.handleSave());
        await wire('menu-save-as', () => void menuHandlersRef.current.handleSaveAs());
        await wire('menu-export-pdf', () => menuHandlersRef.current.handleExportPdf());
        await wire('menu-quit', () => menuHandlersRef.current.handleQuit());
        await wire('menu-clear-recent', () => void syncRecentMenu(clearRecentFiles()));
        await wire(
          'menu-copy-diagnostics',
          () => void menuHandlersRef.current.handleCopyDiagnostics(),
        );
        await wire('menu-reveal-logs', () => void menuHandlersRef.current.handleRevealLogs());
        unlisteners.push(
          await listen<string>('menu-open-recent', (event) => {
            if (event.payload) menuHandlersRef.current.addOrFocusPath(event.payload);
          }),
        );
      } catch {
        // Non-Tauri context — no native menu.
      }
    })();
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, []);

  useEffect(() => {
    void syncRecentMenu(getRecentFiles());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const native = await invoke<boolean>('has_native_menu');
        if (!cancelled) setHasNativeMenu(native === true);
      } catch {
        // Non-Tauri context, or command absent (e2e) — keep JS shortcuts.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const getCurrentZoom = useCallback(() => chromeRef.current.zoom, []);
  useGlobalShortcuts({
    hasNativeMenu,
    getActiveHandle: activeHandle,
    getCurrentZoom,
    setDefaultZoom,
    onNewTab: addNewTab,
    onOpen: handleOpen,
    onSave: handleSave,
    onSaveAs: handleSaveAs,
    onExportPdf: handleExportPdf,
  });

  const handleZoomChange = useCallback(
    (nextZoom: number) => {
      const next = clampZoom(nextZoom);
      setChrome((current) => ({ ...current, zoom: next }));
      setDefaultZoom(next);
      activeHandle()?.setZoom(next);
    },
    [activeHandle],
  );

  const handleClaudeModelChange = useCallback((model: ClaudeModelAlias | null) => {
    setClaudeModel(model);
    writeClaudeModel(window.localStorage, model);
  }, []);
  const handleClaudeEffortChange = useCallback((effort: ClaudeEffort | null) => {
    setClaudeEffort(effort);
    writeClaudeEffort(window.localStorage, effort);
  }, []);

  const closeGuardTab = closeGuardTabId
    ? (tabs.find((tab) => tab.id === closeGuardTabId) ?? null)
    : null;
  const pickerTargetId = pickerTabId ?? activeTabId;
  const pickerTab = tabs.find((tab) => tab.id === pickerTargetId) ?? null;
  return (
    <div className="app">
      <Rail editor={chrome.editor} />

      <main className="studio-main">
        <Topbar
          editor={chrome.editor}
          filePath={chrome.filePath}
          isDirty={chrome.isDirty}
          lastSavedAt={chrome.lastSavedAt}
          isSuggesting={chrome.isSuggesting}
          onToggleSuggesting={() => activeHandle()?.setMode(!chromeRef.current.isSuggesting)}
          pendingSuggestionCount={chrome.pendingSuggestionCount}
          onAcceptAll={() => activeHandle()?.acceptAll()}
          onRejectAll={() => activeHandle()?.rejectAll()}
        />

        {workspaceReady && (
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={requestCloseTab}
            onNew={addNewTab}
          />
        )}

        {workspaceReady &&
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="document-tab-host"
              data-tab-id={tab.id}
              hidden={tab.id !== activeTabId}
            >
              <DocumentTab
                ref={tabRefFor(tab.id)}
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                initialFilePath={tab.initialFilePath}
                initialWorkspaceSnapshot={tab.initialWorkspaceSnapshot}
                initialWorkspaceDirty={tab.initialWorkspaceDirty}
                restoredFromWorkspace={tab.restoredFromWorkspace}
                defaultZoom={defaultZoom}
                getClaudeRunOptions={getClaudeRunOptions}
                onChromeChange={handleChromeChange}
                onMetaChange={handleTabMetaChange}
                onInitialFileLoaded={handleInitialFileLoaded}
                onInitialWorkspaceLoaded={handleInitialWorkspaceLoaded}
                onOpenSessionPicker={handleOpenSessionPicker}
                onNotice={showNotice}
                onRecentFile={handleRecentFile}
                onRequestSavePath={handleRequestSavePath}
                onClaimSession={claimSession}
                onReleaseSession={releaseSessionClaim}
              />
            </div>
          ))}

        <Footer
          editor={chrome.editor}
          stats={chrome.stats}
          autosaveStatus={chrome.autosaveStatus}
          zoom={chrome.zoom}
          onZoomChange={handleZoomChange}
          aiSession={chrome.aiSession}
          lastKnownModel={chrome.lastKnownModel}
          lastKnownEffort={chrome.lastKnownEffort}
          claudeModel={claudeModel}
          claudeEffort={claudeEffort}
          onClaudeModelChange={handleClaudeModelChange}
          onClaudeEffortChange={handleClaudeEffortChange}
          onOpenSessionPicker={() => activeHandle()?.openSessionPicker()}
          onUnlinkSession={() => activeHandle()?.unlinkSession()}
          contextFolder={chrome.contextFolder}
          onLinkContextFolder={() => activeHandle()?.linkContextFolder()}
          onUnlinkContextFolder={() => activeHandle()?.unlinkContextFolder()}
        />
      </main>

      <SessionPicker
        open={pickerOpen}
        newSessionCwd={pickerTab?.filePath ? dirname(pickerTab.filePath) : null}
        getSessionOwner={(sessionId) => {
          void sessionClaimRevision;
          const ownerId = getSessionClaimOwner(sessionId);
          if (!ownerId || ownerId === pickerTargetId) return null;
          return tabsRef.current.find((tab) => tab.id === ownerId)?.title ?? 'another document';
        }}
        onClose={() => {
          setPickerOpen(false);
          tabHandlesRef.current.get(pickerTargetId)?.closeSessionPicker();
          setPickerTabId(null);
        }}
        onPick={(binding) => {
          const linked = tabHandlesRef.current.get(pickerTargetId)?.pickSession(binding) ?? false;
          if (linked) {
            setPickerOpen(false);
            setPickerTabId(null);
          }
        }}
      />

      {pendingRecovery && (
        <AppModal
          title="Recover unsaved workspace?"
          message={`Restore ${pendingRecovery.tabs.filter((tab) => tab.dirty).length} unsaved document${
            pendingRecovery.tabs.filter((tab) => tab.dirty).length === 1 ? '' : 's'
          } from ${new Date(pendingRecovery.savedAt).toLocaleString()}?`}
          buttons={[
            {
              label: 'Recover',
              kind: 'primary',
              onClick: () => {
                // Hold persistence suspended THROUGH hydration so no tab's post-restore write
                // can overwrite the original before we know whether any tab degraded. Every
                // snapshot-bearing tab reports its outcome; finalizeRecovery then resumes or
                // raises the Preserve gate. Suspension via the ref is synchronous, so the
                // immediate write effect can't slip through.
                persistenceSuspendedRef.current = true;
                setPersistenceSuspended(true);
                const restored = applyWorkspaceState(pendingRecovery, true);
                recoveryRef.current = {
                  expected: new Set(
                    restored.tabs
                      .filter((tab) => tab.initialWorkspaceSnapshot)
                      .map((tab) => tab.id),
                  ),
                  outcomes: new Map(),
                };
                setPendingRecovery(null);
                if (recoveryRef.current.expected.size === 0) finalizeRecovery();
              },
            },
            {
              label: 'Discard',
              kind: 'danger',
              onClick: () => {
                const discarded = buildDiscardedRecoveryWorkspaceFile(pendingRecovery);
                if (discarded) applyWorkspaceState(discarded, true);
                setPendingRecovery(null);
              },
            },
          ]}
        />
      )}

      {invalidWorkspace && (
        <AppModal
          title="Workspace recovery could not be read"
          message={`${invalidWorkspace.reason} Quill will preserve the original file for manual recovery before starting a fresh workspace.`}
          buttons={[
            {
              label: 'Preserve & Continue',
              kind: 'primary',
              onClick: async () => {
                const preservedPath = await quarantineWorkspace();
                if (!preservedPath) {
                  showNotice({
                    title: 'Could not preserve workspace recovery',
                    message:
                      'Quill has not overwritten the recovery file. Check app-data permissions and try again.',
                  });
                  return;
                }
                setInvalidWorkspace(null);
                persistenceSuspendedRef.current = false;
                setPersistenceSuspended(false);
              },
            },
          ]}
        />
      )}

      {degradedRecovery && (
        <AppModal
          title="Recovered work needs preserving"
          message="Some recovered documents had damaged saved review state. Quill recovered your text, but exact comment and suggestion positions could not be restored. It will preserve the original recovery file for manual repair before saving again."
          buttons={[
            {
              label: 'Preserve & Continue',
              kind: 'primary',
              onClick: async () => {
                const preservedPath = await quarantineWorkspace();
                if (!preservedPath) {
                  showNotice({
                    title: 'Could not preserve recovery',
                    message:
                      'Quill has not overwritten the recovery file. Check app-data permissions and try again.',
                  });
                  return;
                }
                setDegradedRecovery(false);
                persistenceSuspendedRef.current = false;
                setPersistenceSuspended(false);
              },
            },
          ]}
        />
      )}

      {closeGuardTab && (
        <AppModal
          title="Unsaved changes"
          message={`“${closeGuardTab.title}” has unsaved changes. Save them before closing the tab?`}
          buttons={[
            {
              label: 'Save',
              kind: 'primary',
              onClick: async () => {
                const saved = await tabHandlesRef.current.get(closeGuardTab.id)?.save();
                if (saved) {
                  setCloseGuardTabId(null);
                  closeTabImmediately(closeGuardTab.id);
                }
              },
            },
            {
              label: "Don't Save",
              kind: 'danger',
              onClick: () => {
                setCloseGuardTabId(null);
                closeTabImmediately(closeGuardTab.id);
              },
            },
            {
              label: 'Cancel',
              kind: 'ghost',
              isCancel: true,
              onClick: () => setCloseGuardTabId(null),
            },
          ]}
        />
      )}

      {discardGuard && (
        <AppModal
          title="Unsaved changes"
          message={
            discardGuard.tabIds.length === 1
              ? 'This document has unsaved changes. Save it before continuing?'
              : `${discardGuard.tabIds.length} open documents have unsaved changes. Save all before continuing?`
          }
          buttons={[
            {
              label: discardGuard.tabIds.length === 1 ? 'Save' : 'Save All',
              kind: 'primary',
              onClick: async () => {
                const savedPaths = new Map<string, string>();
                for (const tabId of discardGuard.tabIds) {
                  const saved = await tabHandlesRef.current.get(tabId)?.save();
                  if (!saved) return;
                  savedPaths.set(tabId, saved);
                }
                const persistedTabs: WorkspaceTabSource[] = tabsRef.current.map((tab) => ({
                  id: tab.id,
                  filePath: savedPaths.get(tab.id) ?? tab.filePath,
                  isDirty: savedPaths.has(tab.id) ? false : tab.isDirty,
                }));
                const workspace = buildWorkspaceFile(
                  persistedTabs,
                  activeTabIdRef.current,
                  getTabSnapshot,
                );
                persistenceSuspendedRef.current = true;
                setPersistenceSuspended(true);
                if (workspace) await writeWorkspace(workspace);
                setDiscardGuard(null);
                discardGuard.run();
              },
            },
            {
              label: discardGuard.tabIds.length === 1 ? "Don't Save" : 'Discard All',
              kind: 'danger',
              onClick: async () => {
                const workspace = buildDiscardedWorkspaceFile(
                  tabsRef.current,
                  activeTabIdRef.current,
                  getTabSnapshot,
                );
                persistenceSuspendedRef.current = true;
                setPersistenceSuspended(true);
                if (workspace) await writeWorkspace(workspace);
                else await deleteWorkspace();
                setDiscardGuard(null);
                discardGuard.run();
              },
            },
            {
              label: 'Cancel',
              kind: 'ghost',
              isCancel: true,
              onClick: () => setDiscardGuard(null),
            },
          ]}
        />
      )}

      {notice && (
        <AppModal
          title={notice.title}
          message={notice.message}
          buttons={
            notice.actions?.length
              ? [
                  ...notice.actions.map((action, index) => ({
                    label: action.label,
                    kind: index === 0 ? ('primary' as const) : ('ghost' as const),
                    onClick: async () => {
                      setNotice(null);
                      await action.onClick();
                    },
                  })),
                  {
                    label: 'Dismiss',
                    kind: 'ghost' as const,
                    isCancel: true,
                    onClick: () => setNotice(null),
                  },
                ]
              : [
                  {
                    label: 'OK',
                    kind: 'primary',
                    isCancel: true,
                    onClick: () => setNotice(null),
                  },
                ]
          }
        />
      )}
    </div>
  );
}
