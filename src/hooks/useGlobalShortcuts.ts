import { useEffect } from 'react';
import { clampZoom, DEFAULT_ZOOM } from '../utils/zoomPreference';

/**
 * The narrow slice of the active tab this hook drives — just the four commands
 * the shortcuts invoke. A DocumentTabHandle satisfies it structurally, but the
 * hook depends only on this, not the full 21-method handle.
 */
export interface ShortcutTarget {
  clearActiveAnnotation: () => void;
  focusFind: () => void;
  openChat: () => void;
  setZoom: (zoom: number) => void;
}

/** File/tab actions are fire-and-forget; some return a promise we intentionally drop. */
type ShortcutAction = () => void | Promise<unknown>;

export interface GlobalShortcutOptions {
  /**
   * When the native menu owns the file accelerators, the web listener must not
   * handle or preventDefault N/O/S/Shift-S/P — only Find, Chat, Zoom, and
   * unmodified Escape stay web-driven.
   */
  hasNativeMenu: boolean;
  /** Resolve the active tab AT event time (not render time). */
  getActiveHandle: () => ShortcutTarget | null;
  /** Read the live document zoom AT event time (preserves chromeRef semantics). */
  getCurrentZoom: () => number;
  setDefaultZoom: (zoom: number) => void;
  onNewTab: ShortcutAction;
  onOpen: ShortcutAction;
  onSave: ShortcutAction;
  onSaveAs: ShortcutAction;
  onExportPdf: ShortcutAction;
}

/**
 * Wires App's window-level keyboard shortcuts as a single `keydown` listener:
 * Cmd/Ctrl+N/O/S, Cmd+Shift+S, Cmd+P (all gated behind `!hasNativeMenu`), plus
 * Cmd+F (find), Cmd+/ (chat), Cmd±/0 (zoom), and unmodified Escape (clear the
 * active annotation) which stay web-driven regardless of the native menu.
 *
 * Extracted verbatim from App — every dispatch, guard, and preventDefault edge
 * is preserved (see the per-branch tests). The listener re-subscribes when
 * `hasNativeMenu` flips and is removed on unmount.
 */
export function useGlobalShortcuts(options: GlobalShortcutOptions): void {
  const {
    hasNativeMenu,
    getActiveHandle,
    getCurrentZoom,
    setDefaultZoom,
    onNewTab,
    onOpen,
    onSave,
    onSaveAs,
    onExportPdf,
  } = options;

  useEffect(() => {
    function handleBrowserFileShortcut(event: KeyboardEvent): boolean {
      if (hasNativeMenu) return false;
      if (event.key.toLowerCase() === 's' && event.shiftKey) {
        event.preventDefault();
        void onSaveAs();
        return true;
      }

      const action = {
        s: onSave,
        o: onOpen,
        n: onNewTab,
      }[event.key];
      if (action) {
        event.preventDefault();
        void action();
        return true;
      }

      if (event.key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        void onExportPdf();
        return true;
      }
      return false;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) {
        if (event.key === 'Escape') getActiveHandle()?.clearActiveAnnotation();
        return;
      }
      if (handleBrowserFileShortcut(event)) return;

      if (event.key === 'f' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        getActiveHandle()?.focusFind();
        return;
      }
      if (event.key === '/' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        getActiveHandle()?.openChat();
        return;
      }
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        const next = clampZoom(Math.round((getCurrentZoom() + 0.12) * 100) / 100);
        setDefaultZoom(next);
        getActiveHandle()?.setZoom(next);
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        const next = clampZoom(Math.round((getCurrentZoom() - 0.12) * 100) / 100);
        setDefaultZoom(next);
        getActiveHandle()?.setZoom(next);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        setDefaultZoom(DEFAULT_ZOOM);
        getActiveHandle()?.setZoom(DEFAULT_ZOOM);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    hasNativeMenu,
    getActiveHandle,
    getCurrentZoom,
    setDefaultZoom,
    onNewTab,
    onOpen,
    onSave,
    onSaveAs,
    onExportPdf,
  ]);
}
