import { expect, test } from '@playwright/test';
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
