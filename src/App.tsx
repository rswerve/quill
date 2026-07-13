import { useCallback, useEffect, useRef, useState } from 'react';
import AppModal from './components/AppModal';
import DocumentTab from './components/DocumentTab';
import type {
  DocumentTabChromeSnapshot,
  DocumentTabHandle,
  DocumentTabMetaSnapshot,
} from './components/DocumentTab';
import Footer from './components/Footer';
import Rail from './components/Rail';
import SessionPicker from './components/SessionPicker';
import TabStrip from './components/TabStrip';
import type { TabStripItem } from './components/TabStrip';
import Topbar from './components/Topbar';
import UpdateBanner from './components/UpdateBanner';
import { useWorkspaceAutosave } from './hooks/useDraftAutosave';
import type { WorkspaceReadResult } from './hooks/useDraftAutosave';
import { useUpdateCheck } from './hooks/useUpdateCheck';
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
import {
  clampZoom,
  DEFAULT_ZOOM,
  loadZoomPreference,
  saveZoomPreference,
} from './utils/zoomPreference';
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

interface TabMeta extends TabStripItem {
  filePath: string | null;
  initialFilePath: string | null;
  initialWorkspaceSnapshot: DraftFile | null;
  initialWorkspaceDirty: boolean;
  restoredFromWorkspace: boolean;
}

interface DiscardGuard {
  tabIds: string[];
  run: () => void;
}

let nextTabNumber = 1;

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
    stats: { words: 0, chars: 0, line: 1, column: 1 },
  };
}

export default function App() {
  const [tabs, setTabs] = useState<TabMeta[]>(() => [createUntitledTab()]);
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id);
  const [chrome, setChrome] = useState<DocumentTabChromeSnapshot>(() =>
    emptyChrome(tabs[0], loadZoomPreference()),
  );
  const [defaultZoom, setDefaultZoom] = useState(loadZoomPreference);
  const [hasNativeMenu, setHasNativeMenu] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTabId, setPickerTabId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [discardGuard, setDiscardGuard] = useState<DiscardGuard | null>(null);
  const [closeGuardTabId, setCloseGuardTabId] = useState<string | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState<WorkspaceFile | null>(null);
  const [invalidWorkspace, setInvalidWorkspace] = useState<Extract<
    WorkspaceReadResult,
    { status: 'invalid' }
  > | null>(null);
  const [persistenceSuspended, setPersistenceSuspended] = useState(false);
  const [tabHandleRevision, setTabHandleRevision] = useState(0);
  const [sessionClaimRevision, setSessionClaimRevision] = useState(0);
  const [claudeModel, setClaudeModel] = useState<ClaudeModelAlias | null>(
    () => readClaudeRunOptions(window.localStorage).model,
  );
  const [claudeEffort, setClaudeEffort] = useState<ClaudeEffort | null>(
    () => readClaudeRunOptions(window.localStorage).effort,
  );
  const updateCheck = useUpdateCheck({ currentVersion: __APP_VERSION__ });

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
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
  const sessionClaimsRef = useRef(new Map<string, string>());
  const runOptionsRef = useRef<ClaudeRunOptions>({
    model: claudeModel,
    effort: claudeEffort,
  });
  runOptionsRef.current = { model: claudeModel, effort: claudeEffort };

  const getClaudeRunOptions = useCallback(() => runOptionsRef.current, []);
  const showNotice = useCallback(
    (nextNotice: { title: string; message: string }) => setNotice(nextNotice),
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

  const applyWorkspaceState = useCallback((workspace: WorkspaceFile, includeDirty: boolean) => {
    const restored = tabsFromWorkspace(workspace, includeDirty);
    for (const tab of restored.tabs) {
      const numericId = /^tab-(\d+)$/.exec(tab.id)?.[1];
      if (numericId) nextTabNumber = Math.max(nextTabNumber, Number(numericId) + 1);
    }
    tabsRef.current = restored.tabs;
    activeTabIdRef.current = restored.activeTabId;
    tabHandlesRef.current.clear();
    tabHandleReadyIdsRef.current.clear();
    tabRefCallbacksRef.current.clear();
    chromeByTabRef.current.clear();
    sessionClaimsRef.current.clear();
    setSessionClaimRevision((revision) => revision + 1);
    setTabs(restored.tabs);
    setActiveTabId(restored.activeTabId);
    setChrome(
      emptyChrome(
        restored.tabs.find((tab) => tab.id === restored.activeTabId) ?? restored.tabs[0],
        defaultZoomRef.current,
      ),
    );
  }, []);

  const activateTab = useCallback(
    (tabId: string) => {
      if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
      activeTabIdRef.current = tabId;
      setActiveTabId(tabId);
      setChrome(chromeForTab(tabId));
    },
    [chromeForTab],
  );

  const releaseSessionClaim = useCallback((tabId: string) => {
    let changed = false;
    for (const [sessionId, ownerId] of sessionClaimsRef.current) {
      if (ownerId !== tabId) continue;
      sessionClaimsRef.current.delete(sessionId);
      changed = true;
    }
    if (changed) setSessionClaimRevision((revision) => revision + 1);
  }, []);

  const claimSession = useCallback((tabId: string, binding: AISessionBinding) => {
    const ownerId = sessionClaimsRef.current.get(binding.sessionId);
    if (ownerId && ownerId !== tabId) {
      const owner = tabsRef.current.find((tab) => tab.id === ownerId);
      return { allowed: false, ownerTitle: owner?.title ?? 'another open document' };
    }

    let changed = false;
    for (const [sessionId, currentOwnerId] of sessionClaimsRef.current) {
      if (currentOwnerId !== tabId || sessionId === binding.sessionId) continue;
      sessionClaimsRef.current.delete(sessionId);
      changed = true;
    }
    if (ownerId !== tabId) {
      sessionClaimsRef.current.set(binding.sessionId, tabId);
      changed = true;
    }
    if (changed) setSessionClaimRevision((revision) => revision + 1);
    return { allowed: true };
  }, []);

  const addNewTab = useCallback(() => {
    if (!workspaceReadyRef.current) return;
    const tab = createUntitledTab();
    const nextTabs = [...tabsRef.current, tab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    activateTab(tab.id);
  }, [activateTab]);

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

      const tab = createFileTab(path);
      const nextTabs = [...tabsRef.current, tab];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      activateTab(tab.id);
      return tab.id;
    },
    [activateTab],
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
      const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex < 0) return;

      let nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
      if (nextTabs.length === 0) nextTabs = [createUntitledTab()];
      const closingActiveTab = activeTabIdRef.current === tabId;
      const nextActiveId = closingActiveTab
        ? nextTabs[Math.min(closingIndex, nextTabs.length - 1)].id
        : activeTabIdRef.current;

      tabsRef.current = nextTabs;
      tabHandlesRef.current.delete(tabId);
      tabHandleReadyIdsRef.current.delete(tabId);
      chromeByTabRef.current.delete(tabId);
      releaseSessionClaim(tabId);
      tabRefCallbacksRef.current.delete(tabId);
      setTabs(nextTabs);
      if (pickerTabId === tabId) {
        setPickerOpen(false);
        setPickerTabId(null);
      }
      if (closingActiveTab) activateTab(nextActiveId);
    },
    [activateTab, pickerTabId, releaseSessionClaim],
  );

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (tab.isDirty) setCloseGuardTabId(tabId);
      else closeTabImmediately(tabId);
    },
    [closeTabImmediately],
  );

  const handleInitialFileLoaded = useCallback(
    (tabId: string, loaded: boolean) => {
      if (!loaded) {
        closeTabImmediately(tabId);
        return;
      }
      const currentTabs = tabsRef.current;
      const nextTabs = currentTabs.map((tab) =>
        tab.id === tabId ? { ...tab, initialFilePath: null } : tab,
      );
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    },
    [closeTabImmediately],
  );

  const handleInitialWorkspaceLoaded = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;
    const nextTabs = currentTabs.map((tab) =>
      tab.id === tabId ? { ...tab, initialWorkspaceSnapshot: null } : tab,
    );
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
  }, []);

  const handleTabMetaChange = useCallback((tabId: string, snapshot: DocumentTabMetaSnapshot) => {
    const currentTabs = tabsRef.current;
    let changed = false;
    const nextTabs = currentTabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      // A file tab publishes its initial blank hook state before its async
      // load finishes. Keep the pending path/title until the real load lands.
      if ((tab.initialFilePath || tab.initialWorkspaceSnapshot) && snapshot.filePath === null) {
        return tab;
      }
      const next = {
        ...tab,
        filePath: snapshot.filePath,
        initialFilePath: null,
        title: snapshot.title,
        isDirty: snapshot.isDirty,
      };
      changed =
        changed ||
        next.filePath !== tab.filePath ||
        next.initialFilePath !== tab.initialFilePath ||
        next.title !== tab.title ||
        next.isDirty !== tab.isDirty;
      return next;
    });
    if (!changed) return;
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
  }, []);

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

  const guardDirtyTabs = useCallback((action: () => void) => {
    const dirtyTabIds = tabsRef.current.filter((tab) => tab.isDirty).map((tab) => tab.id);
    if (dirtyTabIds.length === 0) action();
    else setDiscardGuard({ tabIds: dirtyTabIds, run: action });
  }, []);

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
          const dirtyTabIds = tabsRef.current.filter((tab) => tab.isDirty).map((tab) => tab.id);
          try {
            event.preventDefault();
            if (dirtyTabIds.length === 0) {
              void writeWorkspace().finally(() => void win.destroy());
              return;
            }
            setDiscardGuard({ tabIds: dirtyTabIds, run: () => void win.destroy() });
          } catch {
            void win.destroy();
          }
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
  }, [writeWorkspace]);

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

  useEffect(() => {
    function handleBrowserFileShortcut(event: KeyboardEvent): boolean {
      if (hasNativeMenu) return false;
      if (event.key.toLowerCase() === 's' && event.shiftKey) {
        event.preventDefault();
        void handleSaveAs();
        return true;
      }

      const action = {
        s: handleSave,
        o: handleOpen,
        n: addNewTab,
      }[event.key];
      if (action) {
        event.preventDefault();
        void action();
        return true;
      }

      if (event.key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        handleExportPdf();
        return true;
      }
      return false;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) {
        if (event.key === 'Escape') activeHandle()?.clearActiveAnnotation();
        return;
      }
      if (handleBrowserFileShortcut(event)) return;

      if (event.key === 'f' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        activeHandle()?.focusFind();
        return;
      }
      if (event.key === '/' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        activeHandle()?.openChat();
        return;
      }
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        const next = clampZoom(Math.round((chromeRef.current.zoom + 0.12) * 100) / 100);
        setDefaultZoom(next);
        activeHandle()?.setZoom(next);
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        const next = clampZoom(Math.round((chromeRef.current.zoom - 0.12) * 100) / 100);
        setDefaultZoom(next);
        activeHandle()?.setZoom(next);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        setDefaultZoom(DEFAULT_ZOOM);
        activeHandle()?.setZoom(DEFAULT_ZOOM);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeHandle,
    addNewTab,
    handleExportPdf,
    handleOpen,
    handleSave,
    handleSaveAs,
    hasNativeMenu,
  ]);

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
        {updateCheck.update && (
          <UpdateBanner
            version={updateCheck.update.version}
            url={updateCheck.update.url}
            onDismiss={updateCheck.dismiss}
          />
        )}

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
          zoom={chrome.zoom}
          onZoomChange={handleZoomChange}
          aiSession={chrome.aiSession}
          lastKnownModel={chrome.lastKnownModel}
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
          const ownerId = sessionClaimsRef.current.get(sessionId);
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
                applyWorkspaceState(pendingRecovery, true);
                setPendingRecovery(null);
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
              onClick: () => setDiscardGuard(null),
            },
          ]}
        />
      )}

      {notice && (
        <AppModal
          title={notice.title}
          message={notice.message}
          buttons={[{ label: 'OK', kind: 'primary', onClick: () => setNotice(null) }]}
        />
      )}
    </div>
  );
}
