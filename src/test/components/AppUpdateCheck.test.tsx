import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import {
  AUTOMATIC_UPDATE_CHECK_STORAGE_KEY,
  DISMISSED_UPDATE_VERSION_STORAGE_KEY,
} from '../../utils/updatePreferences';

const mocks = vi.hoisted(() => ({
  checkOutcome: { state: 'current' } as unknown,
  installOutcome: { state: 'ready-to-restart', version: '1.2.0' } as unknown,
  rejectCheck: null as unknown,
  rejectInstall: null as unknown,
  rejectReveal: null as unknown,
  invoke: vi.fn(),
  revealItemInDir: vi.fn(),
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  quarantineWorkspace: vi.fn(),
}));

vi.mock('../../hooks/useDraftAutosave', () => ({
  useWorkspaceAutosave: () => ({
    readWorkspace: mocks.readWorkspace,
    writeWorkspace: mocks.writeWorkspace,
    deleteWorkspace: mocks.deleteWorkspace,
    quarantineWorkspace: mocks.quarantineWorkspace,
  }),
}));
vi.mock('../../hooks/useGlobalShortcuts', () => ({ useGlobalShortcuts: vi.fn() }));

vi.mock('../../components/DocumentTab', () => ({ default: () => null }));
vi.mock('../../components/Footer', () => ({ default: () => null }));
vi.mock('../../components/Rail', () => ({ default: () => null }));
vi.mock('../../components/SessionPicker', () => ({ default: () => null }));
vi.mock('../../components/TabStrip', () => ({ default: () => null }));
vi.mock('../../components/Topbar', () => ({ default: () => null }));

vi.mock('../../utils/recentFiles', () => ({
  addRecentFile: vi.fn(() => []),
  clearRecentFiles: vi.fn(() => []),
  getRecentFiles: vi.fn(() => []),
  syncRecentMenu: vi.fn(async () => undefined),
}));

async function renderReadyApp() {
  const view = render(<App />);
  await waitFor(() => expect(mocks.readWorkspace).toHaveBeenCalled());
  return view;
}

async function emitMenu(event: string) {
  await waitFor(() =>
    expect(
      (
        window as unknown as {
          __TAURI_INTERNALS__: { callbacks: Map<number, unknown> };
        }
      ).__TAURI_INTERNALS__.callbacks.size,
    ).toBeGreaterThan(10),
  );
  await act(async () => {
    await emit(event);
  });
}

async function closeNotice(title: string) {
  const dialog = await screen.findByRole('dialog', { name: title });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

async function requestAvailableUpdate(version = '1.2.0') {
  mocks.checkOutcome = { state: 'available', version, path: '/Drive/Tools/Quill.app' };
  await emitMenu('menu-check-for-updates');
  return screen.findByRole('dialog', { name: 'Update available' });
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.checkOutcome = { state: 'current' };
  mocks.installOutcome = { state: 'ready-to-restart', version: '1.2.0' };
  mocks.rejectCheck = null;
  mocks.rejectInstall = null;
  mocks.rejectReveal = null;
  mocks.invoke.mockReset();
  mocks.revealItemInDir.mockReset();
  mocks.readWorkspace.mockReset().mockResolvedValue({ status: 'missing' });
  mocks.writeWorkspace.mockReset().mockResolvedValue(true);
  mocks.deleteWorkspace.mockReset().mockResolvedValue(undefined);
  mocks.quarantineWorkspace
    .mockReset()
    .mockResolvedValue('/Users/test/Library/Application Support/Quill/workspace.invalid');
  mocks.invoke.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
    if (command === 'check_for_update') {
      if (mocks.rejectCheck) throw mocks.rejectCheck;
      return mocks.checkOutcome;
    }
    if (command === 'install_update') {
      if (mocks.rejectInstall) throw mocks.rejectInstall;
      return mocks.installOutcome;
    }
    if (command === 'take_pending_deep_link') return null;
    if (command === 'has_native_menu') return false;
    if (command === 'plugin:opener|reveal_item_in_dir') {
      const path = (payload?.paths as string[] | undefined)?.[0];
      mocks.revealItemInDir(path);
      if (mocks.rejectReveal) throw mocks.rejectReveal;
      return null;
    }
    return null;
  });
  mockWindows('main');
  mockIPC((command, payload) => mocks.invoke(command, payload), { shouldMockEvents: true });
});

afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
});

describe('App update orchestration', () => {
  it('lets an early manual check consume the deferred once-per-process launch check', async () => {
    vi.useFakeTimers();
    mocks.checkOutcome = { state: 'already-checked' };
    render(<App />);
    await act(async () => {
      for (let round = 0; round < 20; round++) await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => {
      await emit('menu-check-for-updates');
      await Promise.resolve();
    });
    await act(async () => vi.runOnlyPendingTimersAsync());

    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'check_for_update'),
    ).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledWith('check_for_update', { automatic: false });
  });

  it('honors the automatic preference while leaving the manual Help action active', async () => {
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'false');
    mocks.checkOutcome = {
      state: 'available',
      version: '1.2.0',
      path: '/Drive/Tools/Quill.app',
    };
    await renderReadyApp();
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'check_for_update'),
    ).toHaveLength(0);

    await emitMenu('menu-check-for-updates');
    const prompt = await screen.findByRole('dialog', { name: 'Update available' });
    expect(prompt).toHaveTextContent('Quill 1.2.0');
    expect(screen.getByRole('checkbox', { name: 'Stop checking automatically' })).toBeChecked();
  });

  it('persists Later and the automatic-check checkbox from the update prompt', async () => {
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'false');
    await renderReadyApp();
    await requestAvailableUpdate('1.4.0');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Stop checking automatically' }));
    expect(window.localStorage.getItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY)).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    expect(window.localStorage.getItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY)).toBe('1.4.0');
    expect(screen.queryByRole('dialog', { name: 'Update available' })).not.toBeInTheDocument();
  });

  it('reports every manual check outcome and failures while automatic checks stay quiet', async () => {
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'false');
    await renderReadyApp();

    mocks.checkOutcome = { state: 'current' };
    await emitMenu('menu-check-for-updates');
    await closeNotice('Quill is up to date');

    mocks.checkOutcome = { state: 'running-from-drive', path: '/Drive/Tools/Quill.app' };
    await emitMenu('menu-check-for-updates');
    expect(await screen.findByRole('dialog', { name: 'Update check blocked' })).toHaveTextContent(
      'shared Drive folder',
    );
    await closeNotice('Update check blocked');

    mocks.checkOutcome = { state: 'unavailable', reason: 'privacy-denied' };
    await emitMenu('menu-check-for-updates');
    expect(
      await screen.findByRole('dialog', { name: 'Could not check for updates' }),
    ).toHaveTextContent('Files and Folders permission');
    await closeNotice('Could not check for updates');

    mocks.checkOutcome = { state: 'unavailable', reason: 'unexpected-reason' };
    await emitMenu('menu-check-for-updates');
    expect(
      await screen.findByRole('dialog', { name: 'Could not check for updates' }),
    ).toHaveTextContent('unexpected-reason');
    await closeNotice('Could not check for updates');

    mocks.rejectCheck = new Error('IPC failed');
    await emitMenu('menu-check-for-updates');
    expect(
      await screen.findByRole('dialog', { name: 'Could not check for updates' }),
    ).toHaveTextContent('IPC failed');
  });

  it('reveals the Drive bundle and reports Finder failures', async () => {
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'false');
    await renderReadyApp();
    await requestAvailableUpdate();

    fireEvent.click(screen.getByRole('button', { name: 'Open Drive Folder' }));
    await waitFor(() =>
      expect(mocks.revealItemInDir).toHaveBeenCalledWith('/Drive/Tools/Quill.app'),
    );
    expect(screen.queryByRole('dialog', { name: 'Update available' })).not.toBeInTheDocument();

    mocks.rejectReveal = new Error('Finder unavailable');
    await requestAvailableUpdate();
    fireEvent.click(screen.getByRole('button', { name: 'Open Drive Folder' }));
    expect(
      await screen.findByRole('dialog', { name: 'Could not open Drive folder' }),
    ).toHaveTextContent('could not reveal');
  });

  it.each([
    [{ state: 'current' }, 'Quill is up to date', 'latest Drive build'],
    [
      { state: 'running-from-drive', path: '/Drive/Tools/Quill.app' },
      'Install blocked',
      'shared Drive folder',
    ],
    [
      { state: 'failed', reason: 'target-not-writable' },
      'Could not install update',
      'cannot replace',
    ],
    [
      { state: 'failed', reason: 'unexpected-install-reason' },
      'Could not install update',
      'unexpected-install-reason',
    ],
    [
      { state: 'unavailable', reason: 'update-bundle-missing' },
      'Could not install update',
      'does not currently contain Quill.app',
    ],
  ])('reports install outcome %# without exiting', async (outcome, title, message) => {
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'false');
    mocks.installOutcome = outcome;
    await renderReadyApp();
    await requestAvailableUpdate();

    fireEvent.click(screen.getByRole('button', { name: 'Install and Restart' }));
    expect(await screen.findByRole('dialog', { name: title })).toHaveTextContent(message);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'exit_app')).toBe(false);
  });

  it('persists, stages, and exits for a ready update, and reports install IPC failures', async () => {
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'false');
    await renderReadyApp();
    await requestAvailableUpdate();

    fireEvent.click(screen.getByRole('button', { name: 'Install and Restart' }));
    await waitFor(() =>
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'install_update')).toBe(true),
    );
    expect(mocks.writeWorkspace).toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'exit_app')).toBe(true);

    mocks.rejectInstall = new Error('installer helper failed');
    await requestAvailableUpdate('1.3.0');
    fireEvent.click(screen.getByRole('button', { name: 'Install and Restart' }));
    expect(
      await screen.findByRole('dialog', { name: 'Could not install update' }),
    ).toHaveTextContent('installer helper failed');
  });
});
