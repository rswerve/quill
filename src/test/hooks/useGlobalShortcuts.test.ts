import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGlobalShortcuts, type GlobalShortcutOptions } from '../../hooks/useGlobalShortcuts';
import type { DocumentTabHandle } from '../../components/DocumentTab';

function makeHandle() {
  return {
    clearActiveAnnotation: vi.fn(),
    focusFind: vi.fn(),
    openChat: vi.fn(),
    setZoom: vi.fn(),
  };
}

function setup(overrides: Partial<GlobalShortcutOptions> = {}, handle = makeHandle()) {
  const opts: GlobalShortcutOptions = {
    hasNativeMenu: false,
    getActiveHandle: () => handle as unknown as DocumentTabHandle,
    getCurrentZoom: () => 1,
    setDefaultZoom: vi.fn(),
    onNewTab: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onExportPdf: vi.fn(),
    ...overrides,
  };
  const view = renderHook((props: GlobalShortcutOptions) => useGlobalShortcuts(props), {
    initialProps: opts,
  });
  return { opts, handle, view };
}

function press(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    cancelable: true,
    bubbles: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe('useGlobalShortcuts', () => {
  describe('file/tab accelerators (web-owned when no native menu)', () => {
    it('Cmd+S saves and prevents default', () => {
      const { opts } = setup();
      const e = press('s', { meta: true });
      expect(opts.onSave).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);
    });
    it('Ctrl+S also saves (meta = metaKey OR ctrlKey)', () => {
      const { opts } = setup();
      press('s', { ctrl: true });
      expect(opts.onSave).toHaveBeenCalledTimes(1);
    });
    it('Cmd+Shift+S is Save As, not Save (modifier ordering)', () => {
      const { opts } = setup();
      const e = press('S', { meta: true, shift: true });
      expect(opts.onSaveAs).toHaveBeenCalledTimes(1);
      expect(opts.onSave).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(true);
    });
    it('Cmd+O opens and Cmd+N adds a tab', () => {
      const { opts } = setup();
      press('o', { meta: true });
      press('n', { meta: true });
      expect(opts.onOpen).toHaveBeenCalledTimes(1);
      expect(opts.onNewTab).toHaveBeenCalledTimes(1);
    });
    it('Cmd+P exports to PDF, but only without Shift or Alt', () => {
      const { opts } = setup();
      const printed = press('p', { meta: true });
      expect(opts.onExportPdf).toHaveBeenCalledTimes(1);
      expect(printed.defaultPrevented).toBe(true);

      const shifted = press('P', { meta: true, shift: true });
      expect(opts.onExportPdf).toHaveBeenCalledTimes(1); // unchanged
      expect(shifted.defaultPrevented).toBe(false);
    });
    it('leaves an unhandled Cmd chord alone', () => {
      const { opts } = setup();
      const e = press('x', { meta: true });
      expect(e.defaultPrevented).toBe(false);
      expect(opts.onSave).not.toHaveBeenCalled();
    });
  });

  describe('always-web shortcuts (independent of the native menu)', () => {
    it('Cmd+F focuses find; Cmd+Shift+F does not', () => {
      const { handle } = setup();
      const e = press('f', { meta: true });
      expect(handle.focusFind).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);
      press('f', { meta: true, shift: true });
      expect(handle.focusFind).toHaveBeenCalledTimes(1); // unchanged
    });
    it('Cmd+/ opens chat', () => {
      const { handle } = setup();
      const e = press('/', { meta: true });
      expect(handle.openChat).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);
    });
    it('unmodified Escape clears the active annotation (and does not preventDefault)', () => {
      const { handle } = setup();
      const e = press('Escape');
      expect(handle.clearActiveAnnotation).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(false);
    });
    it('Cmd+Escape does NOT clear (only unmodified Escape)', () => {
      const { handle } = setup();
      press('Escape', { meta: true });
      expect(handle.clearActiveAnnotation).not.toHaveBeenCalled();
    });
    it('resolves the active handle at event time, tolerating a null handle', () => {
      const { opts } = setup({ getActiveHandle: () => null });
      const e = press('f', { meta: true });
      // No throw, still prevents default for a recognized shortcut.
      expect(e.defaultPrevented).toBe(true);
      expect(opts.onSave).not.toHaveBeenCalled();
    });
  });

  describe('zoom (reads live zoom, ±0.12, round to 2 decimals, clamp)', () => {
    it('Cmd+= and Cmd++ both zoom in and update default + active tab', () => {
      const setDefaultZoom = vi.fn();
      const { handle } = setup({ setDefaultZoom, getCurrentZoom: () => 1 });
      const e = press('=', { meta: true });
      expect(setDefaultZoom).toHaveBeenLastCalledWith(1.12);
      expect(handle.setZoom).toHaveBeenLastCalledWith(1.12);
      expect(e.defaultPrevented).toBe(true);
      press('+', { meta: true, shift: true });
      expect(setDefaultZoom).toHaveBeenLastCalledWith(1.12);
    });
    it('Cmd+- zooms out', () => {
      const setDefaultZoom = vi.fn();
      const { handle } = setup({ setDefaultZoom, getCurrentZoom: () => 1 });
      press('-', { meta: true });
      expect(setDefaultZoom).toHaveBeenLastCalledWith(0.88);
      expect(handle.setZoom).toHaveBeenLastCalledWith(0.88);
    });
    it('clamps at the max (2.4) when zooming in past it', () => {
      const setDefaultZoom = vi.fn();
      setup({ setDefaultZoom, getCurrentZoom: () => 2.4 });
      press('=', { meta: true });
      expect(setDefaultZoom).toHaveBeenLastCalledWith(2.4);
    });
    it('clamps at the min (0.6) when zooming out past it', () => {
      const setDefaultZoom = vi.fn();
      setup({ setDefaultZoom, getCurrentZoom: () => 0.6 });
      press('-', { meta: true });
      expect(setDefaultZoom).toHaveBeenLastCalledWith(0.6);
    });
    it('Cmd+0 resets to the default zoom (1)', () => {
      const setDefaultZoom = vi.fn();
      const { handle } = setup({ setDefaultZoom });
      press('0', { meta: true });
      expect(setDefaultZoom).toHaveBeenLastCalledWith(1);
      expect(handle.setZoom).toHaveBeenLastCalledWith(1);
    });
  });

  describe('native-menu ownership', () => {
    it('suppresses N/O/S/Shift-S/P (not handled, not prevented) but keeps Find/Chat/Zoom/Escape', () => {
      const { opts, handle } = setup({ hasNativeMenu: true });

      const save = press('s', { meta: true });
      const open = press('o', { meta: true });
      const neu = press('n', { meta: true });
      const saveAs = press('S', { meta: true, shift: true });
      const pdf = press('p', { meta: true });
      expect(opts.onSave).not.toHaveBeenCalled();
      expect(opts.onOpen).not.toHaveBeenCalled();
      expect(opts.onNewTab).not.toHaveBeenCalled();
      expect(opts.onSaveAs).not.toHaveBeenCalled();
      expect(opts.onExportPdf).not.toHaveBeenCalled();
      // Native accelerators must remain unprevented by JS.
      for (const e of [save, open, neu, saveAs, pdf]) expect(e.defaultPrevented).toBe(false);

      // Non-file shortcuts stay web-driven regardless of the native menu.
      const find = press('f', { meta: true });
      expect(handle.focusFind).toHaveBeenCalledTimes(1);
      expect(find.defaultPrevented).toBe(true);
      press('=', { meta: true });
      expect(handle.setZoom).toHaveBeenCalledTimes(1);
      press('Escape');
      expect(handle.clearActiveAnnotation).toHaveBeenCalledTimes(1);
    });
  });

  describe('listener lifecycle', () => {
    it('replaces (not duplicates) the listener when hasNativeMenu flips', () => {
      const { opts, view } = setup({ hasNativeMenu: false });
      press('s', { meta: true });
      expect(opts.onSave).toHaveBeenCalledTimes(1);

      view.rerender({ ...opts, hasNativeMenu: true });
      press('s', { meta: true });
      // Still 1: the old (web-owned) listener was removed, not left alongside
      // the new native-owned one.
      expect(opts.onSave).toHaveBeenCalledTimes(1);
    });
    it('removes the listener on unmount', () => {
      const { opts, view } = setup();
      view.unmount();
      press('s', { meta: true });
      expect(opts.onSave).not.toHaveBeenCalled();
    });
  });
});
