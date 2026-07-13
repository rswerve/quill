import { useCallback, useEffect, useRef, useState } from 'react';
import AppModal from './components/AppModal';
import DocumentTab from './components/DocumentTab';
import type { DocumentTabChromeSnapshot, DocumentTabHandle } from './components/DocumentTab';
import Footer from './components/Footer';
import Rail from './components/Rail';
import SessionPicker from './components/SessionPicker';
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

const EMPTY_CHROME: DocumentTabChromeSnapshot = {
  editor: null,
  filePath: null,
  isDirty: false,
  lastSavedAt: null,
  isSuggesting: false,
  pendingSuggestionCount: 0,
  zoom: loadZoomPreference(),
  aiSession: null,
  contextFolder: null,
  lastKnownModel: null,
  stats: { words: 0, chars: 0, line: 1, column: 1 },
};

export default function App() {
  const documentTabRef = useRef<DocumentTabHandle>(null);
  const [chrome, setChrome] = useState<DocumentTabChromeSnapshot>(EMPTY_CHROME);
  const [defaultZoom, setDefaultZoom] = useState(loadZoomPreference);
  const [hasNativeMenu, setHasNativeMenu] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [discardGuard, setDiscardGuard] = useState<{ run: () => void } | null>(null);
  const [claudeModel, setClaudeModel] = useState<ClaudeModelAlias | null>(
    () => readClaudeRunOptions(window.localStorage).model,
  );
  const [claudeEffort, setClaudeEffort] = useState<ClaudeEffort | null>(
    () => readClaudeRunOptions(window.localStorage).effort,
  );
  const updateCheck = useUpdateCheck({ currentVersion: __APP_VERSION__ });

  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const runOptionsRef = useRef<ClaudeRunOptions>({
    model: claudeModel,
    effort: claudeEffort,
  });
  runOptionsRef.current = { model: claudeModel, effort: claudeEffort };

  const getClaudeRunOptions = useCallback(() => runOptionsRef.current, []);
  const handleChromeChange = useCallback((snapshot: DocumentTabChromeSnapshot) => {
    setChrome(snapshot);
  }, []);
  const showNotice = useCallback(
    (nextNotice: { title: string; message: string }) => setNotice(nextNotice),
    [],
  );
  const handleRecentFile = useCallback((path: string) => {
    void syncRecentMenu(addRecentFile(path));
  }, []);
  const handleOpenSessionPicker = useCallback(() => setPickerOpen(true), []);

  useEffect(() => {
    saveZoomPreference(defaultZoom);
  }, [defaultZoom]);

  useEffect(() => {
    const name = chrome.filePath ? basename(chrome.filePath) : 'Untitled';
    document.title = chrome.isDirty ? `${name} •` : name;
  }, [chrome.filePath, chrome.isDirty]);

  const guardDirty = useCallback((action: () => void) => {
    if (!chromeRef.current.isDirty) {
      action();
    } else {
      setDiscardGuard({ run: action });
    }
  }, []);

  const handleSave = useCallback(() => documentTabRef.current?.save() ?? Promise.resolve(null), []);
  const handleSaveAs = useCallback(
    () => documentTabRef.current?.saveAs() ?? Promise.resolve(null),
    [],
  );
  const handleOpen = useCallback(
    () => guardDirty(() => void documentTabRef.current?.open()),
    [guardDirty],
  );
  const handleNew = useCallback(
    () => guardDirty(() => documentTabRef.current?.newDocument()),
    [guardDirty],
  );
  const handleExportPdf = useCallback(() => documentTabRef.current?.exportPdf(), []);
  const handleQuit = useCallback(() => {
    guardDirty(() => {
      void (async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('exit_app');
      })();
    });
  }, [guardDirty]);

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
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExportPdf,
    handleQuit,
    handleCopyDiagnostics,
    handleRevealLogs,
    guardDirty,
  });
  menuHandlersRef.current = {
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExportPdf,
    handleQuit,
    handleCopyDiagnostics,
    handleRevealLogs,
    guardDirty,
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');
        unlisten = await listen<string>('deep-link-open', (event) => {
          const path = event.payload;
          if (!path) return;
          menuHandlersRef.current.guardDirty(() => void documentTabRef.current?.openPath(path));
        });

        const pending = await invoke<string | null>('take_pending_deep_link');
        if (pending) await documentTabRef.current?.openPath(pending);
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
          if (!chromeRef.current.isDirty) return;
          try {
            event.preventDefault();
            setDiscardGuard({ run: () => void win.destroy() });
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
        await wire('menu-new', () => menuHandlersRef.current.handleNew());
        await wire('menu-open', () => menuHandlersRef.current.handleOpen());
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
            const path = event.payload;
            if (!path) return;
            menuHandlersRef.current.guardDirty(() => void documentTabRef.current?.openPath(path));
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
        n: handleNew,
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
        if (event.key === 'Escape') documentTabRef.current?.clearActiveAnnotation();
        return;
      }
      if (handleBrowserFileShortcut(event)) return;

      if (event.key === 'f' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        documentTabRef.current?.focusFind();
        return;
      }
      if (event.key === '/' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        documentTabRef.current?.openReviewModal();
        return;
      }
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        const next = clampZoom(Math.round((chromeRef.current.zoom + 0.12) * 100) / 100);
        setDefaultZoom(next);
        documentTabRef.current?.setZoom(next);
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        const next = clampZoom(Math.round((chromeRef.current.zoom - 0.12) * 100) / 100);
        setDefaultZoom(next);
        documentTabRef.current?.setZoom(next);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        const next = DEFAULT_ZOOM;
        setDefaultZoom(next);
        documentTabRef.current?.setZoom(next);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleExportPdf, handleNew, handleOpen, handleSave, handleSaveAs, hasNativeMenu]);

  const handleZoomChange = useCallback((nextZoom: number) => {
    const next = clampZoom(nextZoom);
    // Keep the controlled range input responsive while the active tab
    // publishes its authoritative snapshot on the following render.
    setChrome((current) => ({ ...current, zoom: next }));
    setDefaultZoom(next);
    documentTabRef.current?.setZoom(next);
  }, []);

  const handleClaudeModelChange = useCallback((model: ClaudeModelAlias | null) => {
    setClaudeModel(model);
    writeClaudeModel(window.localStorage, model);
  }, []);
  const handleClaudeEffortChange = useCallback((effort: ClaudeEffort | null) => {
    setClaudeEffort(effort);
    writeClaudeEffort(window.localStorage, effort);
  }, []);

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
          onToggleSuggesting={() =>
            documentTabRef.current?.setMode(!chromeRef.current.isSuggesting)
          }
          pendingSuggestionCount={chrome.pendingSuggestionCount}
          onAcceptAll={() => documentTabRef.current?.acceptAll()}
          onRejectAll={() => documentTabRef.current?.rejectAll()}
          onReviewDocument={() => documentTabRef.current?.reviewDocument()}
        />

        <DocumentTab
          ref={documentTabRef}
          isActive
          defaultZoom={defaultZoom}
          getClaudeRunOptions={getClaudeRunOptions}
          onChromeChange={handleChromeChange}
          onOpenSessionPicker={handleOpenSessionPicker}
          onNotice={showNotice}
          onRecentFile={handleRecentFile}
          shellModalOpen={Boolean(discardGuard || notice)}
        />

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
          onOpenSessionPicker={() => documentTabRef.current?.openSessionPicker()}
          onUnlinkSession={() => documentTabRef.current?.unlinkSession()}
          contextFolder={chrome.contextFolder}
          onLinkContextFolder={() => documentTabRef.current?.linkContextFolder()}
          onUnlinkContextFolder={() => documentTabRef.current?.unlinkContextFolder()}
        />
      </main>

      <SessionPicker
        open={pickerOpen}
        newSessionCwd={chrome.filePath ? dirname(chrome.filePath) : null}
        onClose={() => {
          setPickerOpen(false);
          documentTabRef.current?.closeSessionPicker();
        }}
        onPick={(binding) => {
          setPickerOpen(false);
          documentTabRef.current?.pickSession(binding);
        }}
      />

      {discardGuard && (
        <AppModal
          title="Unsaved changes"
          message="This document has unsaved changes. Save them before continuing?"
          buttons={[
            {
              label: 'Save',
              kind: 'primary',
              onClick: async () => {
                const saved = await handleSave();
                if (saved) {
                  await documentTabRef.current?.deleteDraft();
                  setDiscardGuard(null);
                  discardGuard.run();
                }
              },
            },
            {
              label: "Don't Save",
              kind: 'danger',
              onClick: async () => {
                await documentTabRef.current?.deleteDraft();
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
