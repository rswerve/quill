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
import { useUpdateCheck } from './hooks/useUpdateCheck';
import {
  readClaudeRunOptions,
  writeClaudeEffort,
  writeClaudeModel,
} from './utils/claudePreferences';
import { basename, dirname } from './utils/path';
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
import type { ClaudeEffort, ClaudeModelAlias, ClaudeRunOptions } from './types';
import './App.css';

interface TabMeta extends TabStripItem {
  filePath: string | null;
  initialFilePath: string | null;
  allowDraftRecovery: boolean;
}

interface DiscardGuard {
  tabIds: string[];
  run: () => void;
}

let nextTabNumber = 1;

function createUntitledTab(allowDraftRecovery = false): TabMeta {
  return {
    id: `tab-${nextTabNumber++}`,
    filePath: null,
    initialFilePath: null,
    title: 'Untitled',
    isDirty: false,
    allowDraftRecovery,
  };
}

function createFileTab(path: string): TabMeta {
  return {
    id: `tab-${nextTabNumber++}`,
    filePath: path,
    initialFilePath: path,
    title: basename(path),
    isDirty: false,
    allowDraftRecovery: false,
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
  const [tabs, setTabs] = useState<TabMeta[]>(() => [createUntitledTab(true)]);
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
  const tabHandlesRef = useRef(new Map<string, DocumentTabHandle>());
  const tabRefCallbacksRef = useRef(new Map<string, (handle: DocumentTabHandle | null) => void>());
  const chromeByTabRef = useRef(new Map<string, DocumentTabChromeSnapshot>());
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

  const handleTabRef = useCallback((tabId: string, handle: DocumentTabHandle | null) => {
    if (handle) tabHandlesRef.current.set(tabId, handle);
    else tabHandlesRef.current.delete(tabId);
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

  const activateTab = useCallback(
    (tabId: string) => {
      if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
      activeTabIdRef.current = tabId;
      setActiveTabId(tabId);
      setChrome(chromeForTab(tabId));
    },
    [chromeForTab],
  );

  const addNewTab = useCallback(() => {
    const tab = createUntitledTab();
    const nextTabs = [...tabsRef.current, tab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    activateTab(tab.id);
  }, [activateTab]);

  const addOrFocusPath = useCallback(
    (path: string) => {
      const existing = tabsRef.current.find(
        (tab) => tab.filePath === path || tab.initialFilePath === path,
      );
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
      chromeByTabRef.current.delete(tabId);
      tabRefCallbacksRef.current.delete(tabId);
      setTabs(nextTabs);
      if (pickerTabId === tabId) {
        setPickerOpen(false);
        setPickerTabId(null);
      }
      if (closingActiveTab) activateTab(nextActiveId);
    },
    [activateTab, pickerTabId],
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

  const handleTabMetaChange = useCallback((tabId: string, snapshot: DocumentTabMetaSnapshot) => {
    const currentTabs = tabsRef.current;
    let changed = false;
    const nextTabs = currentTabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      // A file tab publishes its initial blank hook state before its async
      // load finishes. Keep the pending path/title until the real load lands.
      if (tab.initialFilePath && snapshot.filePath === null) return tab;
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
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('exit_app');
      })();
    });
  }, [guardDirtyTabs]);

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
          if (dirtyTabIds.length === 0) return;
          try {
            event.preventDefault();
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
  }, []);

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
        activeHandle()?.openReviewModal();
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
  const shellModalOpen = Boolean(discardGuard || closeGuardTabId || notice);

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
          onReviewDocument={() => activeHandle()?.reviewDocument()}
        />

        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={requestCloseTab}
          onNew={addNewTab}
        />

        {tabs.map((tab) => (
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
              defaultZoom={defaultZoom}
              getClaudeRunOptions={getClaudeRunOptions}
              onChromeChange={handleChromeChange}
              onMetaChange={handleTabMetaChange}
              onInitialFileLoaded={handleInitialFileLoaded}
              onOpenSessionPicker={handleOpenSessionPicker}
              onNotice={showNotice}
              onRecentFile={handleRecentFile}
              shellModalOpen={shellModalOpen}
              allowDraftRecovery={tab.allowDraftRecovery}
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
        onClose={() => {
          setPickerOpen(false);
          tabHandlesRef.current.get(pickerTargetId)?.closeSessionPicker();
          setPickerTabId(null);
        }}
        onPick={(binding) => {
          setPickerOpen(false);
          tabHandlesRef.current.get(pickerTargetId)?.pickSession(binding);
          setPickerTabId(null);
        }}
      />

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
              onClick: async () => {
                await tabHandlesRef.current.get(closeGuardTab.id)?.deleteDraft();
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
                for (const tabId of discardGuard.tabIds) {
                  const saved = await tabHandlesRef.current.get(tabId)?.save();
                  if (!saved) return;
                }
                await tabHandlesRef.current.get(discardGuard.tabIds[0])?.deleteDraft();
                setDiscardGuard(null);
                discardGuard.run();
              },
            },
            {
              label: discardGuard.tabIds.length === 1 ? "Don't Save" : 'Discard All',
              kind: 'danger',
              onClick: async () => {
                await tabHandlesRef.current.get(discardGuard.tabIds[0])?.deleteDraft();
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
