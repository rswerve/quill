import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import {
  activeEditor,
  closeSessionPickerIfOpen,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

const FIRST_PATH = '/docs/first.md';
const SECOND_PATH = '/docs/second.md';

async function emitMenu(page: Page, event: string, payload: unknown = null) {
  await page.evaluate(
    ({ eventName, eventPayload }) => {
      const emit = (window as unknown as { __quillEmit: (name: string, value: unknown) => void })
        .__quillEmit;
      emit(eventName, eventPayload);
    },
    { eventName: event, eventPayload: payload },
  );
}

async function waitForMenuListener(page: Page, event: string) {
  await page.waitForFunction(
    (eventName) =>
      (
        window as unknown as {
          __quillListeners: Array<{ event: string }>;
        }
      ).__quillListeners.some((listener) => listener.event === eventName),
    event,
  );
}

test('Open Recent adds or focuses documents and Clear Recent synchronizes the native menu', async ({
  page,
}) => {
  await setupMemoryTauri(page, {
    files: { [FIRST_PATH]: 'first body', [SECOND_PATH]: 'second body' },
    openPath: FIRST_PATH,
  });
  await openMemoryFile(page);

  await page.waitForFunction(
    (path) =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string; args: { paths?: string[] } }>;
        }
      ).__quillCalls.some(
        (call) => call.cmd === 'update_recent_menu' && call.args.paths?.[0] === path,
      ),
    FIRST_PATH,
  );

  await emitMenu(page, 'menu-open-recent', SECOND_PATH);
  await expect(page.locator('.document-tab.active')).toContainText('second.md');
  await expect(activeEditor(page)).toContainText('second body');
  await closeSessionPickerIfOpen(page);

  await page.waitForFunction(
    ({ first, second }) =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string; args: { paths?: string[] } }>;
        }
      ).__quillCalls.some(
        (call) =>
          call.cmd === 'update_recent_menu' &&
          JSON.stringify(call.args.paths) === JSON.stringify([second, first]),
      ),
    { first: FIRST_PATH, second: SECOND_PATH },
  );

  await emitMenu(page, 'menu-open-recent', FIRST_PATH);
  await expect(page.locator('.document-tab.active')).toContainText('first.md');
  await expect(page.locator('.document-tab')).toHaveCount(3);

  await emitMenu(page, 'menu-clear-recent');
  await page.waitForFunction(() => {
    const calls = (
      window as unknown as {
        __quillCalls: Array<{ cmd: string; args: { paths?: string[] } }>;
      }
    ).__quillCalls.filter((call) => call.cmd === 'update_recent_menu');
    return calls.at(-1)?.args.paths?.length === 0;
  });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('quill-recent-files')))
    .toBeNull();
});

test('a pending launch deep link opens after startup instead of being lost before listeners attach', async ({
  page,
}) => {
  await setupMemoryTauri(page, {
    files: { [FIRST_PATH]: '# Pending launch' },
    pendingDeepLink: FIRST_PATH,
  });

  await expect(page.locator('.document-tab.active')).toContainText('first.md');
  await expect(activeEditor(page)).toContainText('Pending launch');
  await closeSessionPickerIfOpen(page);
});

test('a failed open reports the path and removes the unusable file tab', async ({ page }) => {
  const missingPath = '/docs/missing.md';
  await setupMemoryTauri(page, { openPath: missingPath });
  await page.keyboard.press('ControlOrMeta+o');

  const notice = page.getByRole('dialog', { name: 'Could not open file' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(missingPath);
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
  await notice.getByRole('button', { name: 'OK' }).click();
});

test('Help menu actions copy diagnostics and invoke the native log reveal command', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setupMemoryTauri(page, {
    diagnostics: {
      version: '9.8.7',
      os: 'macOS',
      arch: 'aarch64',
      log_dir: '/Users/test/Library/Logs/Quill',
    },
  });
  await waitForMenuListener(page, 'menu-copy-diagnostics');
  await waitForMenuListener(page, 'menu-reveal-logs');

  await emitMenu(page, 'menu-copy-diagnostics');
  const notice = page.getByRole('dialog', { name: 'Diagnostics copied' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Quill 9.8.7');
  await expect(notice).toContainText('OS: macOS (aarch64)');
  await expect(notice).toContainText('Logs: /Users/test/Library/Logs/Quill');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('Quill 9.8.7');
  await notice.getByRole('button', { name: 'OK' }).click();

  await emitMenu(page, 'menu-reveal-logs');
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.some((call) => call.cmd === 'reveal_logs'),
  );
});

test('disabled automatic checks stay off while the Help command still offers the Drive build', async ({
  page,
}) => {
  const updatePath =
    '/Users/test/Library/CloudStorage/GoogleDrive-test/Shared drives/Truss/Engineering/Tools/Quill.app';
  await setupMemoryTauri(page, {
    updateCheckOutcome: { state: 'available', version: '1.2.0', path: updatePath },
    automaticUpdateChecks: false,
  });
  await waitForMenuListener(page, 'menu-check-for-updates');
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string }>;
        }
      ).__quillCalls.some((call) => call.cmd === 'check_for_update'),
    ),
  ).toBe(false);

  await emitMenu(page, 'menu-check-for-updates');
  const prompt = page.getByRole('dialog', { name: 'Update available' });
  await expect(prompt).toContainText('Quill 1.2.0');
  await expect(prompt.getByRole('button', { name: 'Install and Restart' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Open Drive Folder' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Later' })).toBeVisible();
  await expect(prompt.getByRole('checkbox', { name: 'Stop checking automatically' })).toBeChecked();

  await prompt.getByRole('button', { name: 'Open Drive Folder' }).click();
  await page.waitForFunction(
    (path) =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string; args: { paths?: string[] } }>;
        }
      ).__quillCalls.some(
        (call) => call.cmd === 'plugin:opener|reveal_item_in_dir' && call.args.paths?.[0] === path,
      ),
    updatePath,
  );
});

test('automatic update check runs once after launch and does not poll', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-02T12:00:00-05:00') });
  await setupMemoryTauri(page, { updateCheckOutcome: { state: 'current' } });
  await page.clock.runFor(1);
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string }>;
        }
      ).__quillCalls.filter((call) => call.cmd === 'check_for_update').length === 1,
  );
  await page.clock.runFor(5 * 60 * 1000);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __quillCalls: Array<{ cmd: string }>;
          }
        ).__quillCalls.filter((call) => call.cmd === 'check_for_update').length,
    ),
  ).toBe(1);
});

test('automatic update failures are invisible', async ({ page }) => {
  await setupMemoryTauri(page, {
    updateCheckOutcome: { state: 'unavailable', reason: 'privacy-denied' },
  });
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.some((call) => call.cmd === 'check_for_update'),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/privacy|update check/i)).toHaveCount(0);

  await waitForMenuListener(page, 'menu-check-for-updates');
  await emitMenu(page, 'menu-check-for-updates');
  const manualNotice = page.getByRole('dialog', { name: 'Could not check for updates' });
  await expect(manualNotice).toContainText('Files and Folders permission');
});

test('automatic check suppresses a dismissed version but prompts for a newer one', async ({
  page,
  context,
}) => {
  await setupMemoryTauri(page, {
    dismissedUpdateVersion: '1.2.0',
    updateCheckOutcome: {
      state: 'available',
      version: '1.2.0',
      path: '/Drive/Tools/Quill.app',
    },
  });
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.some((call) => call.cmd === 'check_for_update'),
  );
  await expect(page.getByRole('dialog', { name: 'Update available' })).toHaveCount(0);

  const newerPage = await context.newPage();
  await setupMemoryTauri(newerPage, {
    dismissedUpdateVersion: '1.2.0',
    updateCheckOutcome: {
      state: 'available',
      version: '1.3.0',
      path: '/Drive/Tools/Quill.app',
    },
  });
  const prompt = newerPage.getByRole('dialog', { name: 'Update available' });
  await expect(prompt).toContainText('Quill 1.3.0');
  await prompt.getByRole('checkbox', { name: 'Stop checking automatically' }).check();
  await expect
    .poll(() => newerPage.evaluate(() => localStorage.getItem('quill-update-check-automatic')))
    .toBe('false');
  await prompt.getByRole('button', { name: 'Later' }).click();
  await expect
    .poll(() => newerPage.evaluate(() => localStorage.getItem('quill-update-dismissed-version')))
    .toBe('1.3.0');
});

test('install update waits for the dirty guard, persists, stages, then exits', async ({ page }) => {
  await setupMemoryTauri(page, {
    updateCheckOutcome: {
      state: 'available',
      version: '1.2.0',
      path: '/Drive/Tools/Quill.app',
    },
    installUpdateOutcome: { state: 'ready-to-restart', version: '1.2.0' },
    automaticUpdateChecks: false,
  });
  await activeEditor(page).fill('unsaved update text');
  await waitForMenuListener(page, 'menu-check-for-updates');
  await emitMenu(page, 'menu-check-for-updates');
  await page
    .getByRole('dialog', { name: 'Update available' })
    .getByRole('button', { name: 'Install and Restart' })
    .click();

  const guard = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(guard).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string }>;
        }
      ).__quillCalls.some((call) => call.cmd === 'install_update'),
    ),
  ).toBe(false);

  await guard.getByRole('button', { name: "Don't Save" }).click();
  await page.waitForFunction(() => {
    const commands = (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.map((call) => call.cmd);
    const write = commands.lastIndexOf('write_draft');
    const install = commands.lastIndexOf('install_update');
    const exit = commands.lastIndexOf('exit_app');
    return write >= 0 && install > write && exit > install;
  });
});

test('clean native-menu Quit persists the workspace before exiting', async ({ page }) => {
  await setupMemoryTauri(page);
  await waitForMenuListener(page, 'menu-quit');
  await emitMenu(page, 'menu-quit');

  await page.waitForFunction(() => {
    const commands = (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.map((call) => call.cmd);
    const write = commands.lastIndexOf('write_draft');
    const exit = commands.lastIndexOf('exit_app');
    return write >= 0 && exit > write;
  });
});

test('clean window-close persists the workspace before destroying the Tauri window', async ({
  page,
}) => {
  await setupMemoryTauri(page);
  await waitForMenuListener(page, 'tauri://close-requested');
  await emitMenu(page, 'tauri://close-requested');

  await page.waitForFunction(() => {
    const commands = (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.map((call) => call.cmd);
    const write = commands.lastIndexOf('write_draft');
    const destroy = commands.lastIndexOf('plugin:window|destroy');
    return write >= 0 && destroy > write;
  });
});

test('dirty window-close cannot destroy the Tauri window until the combined guard resolves', async ({
  page,
}) => {
  await setupMemoryTauri(page);
  await activeEditor(page).fill('unsaved window text');
  await waitForMenuListener(page, 'tauri://close-requested');
  await emitMenu(page, 'tauri://close-requested');

  const guard = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(guard).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __quillCalls: Array<{ cmd: string }>;
        }
      ).__quillCalls.some((call) => call.cmd === 'plugin:window|destroy'),
    ),
  ).toBe(false);

  await guard.getByRole('button', { name: 'Cancel' }).click();
  await emitMenu(page, 'tauri://close-requested');
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: "Don't Save" })
    .click();
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __quillCalls: Array<{ cmd: string }>;
      }
    ).__quillCalls.some((call) => call.cmd === 'plugin:window|destroy'),
  );
});
