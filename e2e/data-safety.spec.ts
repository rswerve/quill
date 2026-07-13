/**
 * Playwright coverage for the data-safety guards:
 *   1. New/Open preserve dirty documents in tabs, while closing a dirty tab
 *      requires Save / Don't Save / Cancel.
 *   2. File errors surfaced to the user as an in-app notice instead of being
 *      swallowed (failed save, corrupt sidecar).
 *
 * Real Tauri isn't running; each test installs a minimal IPC shim at
 * window.__TAURI_INTERNALS__ (same pattern as tauri-features.spec.ts).
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activeEditor, closeSessionPickerIfOpen } from './helpers/memoryTauri';

type InvokeHandler = (cmd: string, args: Record<string, unknown>) => unknown;

async function setupWithIPC(
  page: Page,
  opts: {
    handler: InvokeHandler;
    captureKey?: string;
  },
): Promise<void> {
  await page.addInitScript(
    ({ handlerSrc, captureKey }) => {
      const handler = new Function('cmd', 'args', `return (${handlerSrc})(cmd, args);`);

      const callbacks = new Map<number, (payload: unknown) => void>();
      let nextCbId = 1;
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];

      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback: (cb: (payload: unknown) => void) => {
          const id = nextCbId++;
          callbacks.set(id, cb);
          (window as unknown as Record<string | number, unknown>)[`_${id}`] = (payload: unknown) =>
            cb(payload);
          return id;
        },
        unregisterCallback: (id: number) => {
          callbacks.delete(id);
        },
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args });
          if (cmd === 'plugin:event|listen') return args.handler;
          if (cmd === 'plugin:event|unlisten') return null;
          return handler(cmd, args);
        },
      };

      if (captureKey) {
        (window as unknown as Record<string, unknown>)[captureKey] = calls;
      }
    },
    {
      handlerSrc: opts.handler.toString(),
      captureKey: opts.captureKey ?? null,
    },
  );

  await page.goto('/');
  await page.locator('.ProseMirror').waitFor({ timeout: 5000 });
}

async function typeIntoEditor(page: Page, text: string) {
  await activeEditor(page).click();
  await page.keyboard.type(text);
}

async function pressShortcut(page: Page, key: string) {
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press(key);
  await page.keyboard.up('ControlOrMeta');
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Unsaved-changes guard
// ────────────────────────────────────────────────────────────────────────────

test('clean document: Cmd+N adds and focuses a new tab', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await pressShortcut(page, 'n');
  await page.waitForTimeout(200);

  await expect(page.locator('.app-modal')).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
  await expect(page.locator('.crumbs .cur')).toContainText('Untitled');
});

test('dirty document: Cmd+N preserves it in a background tab without a guard', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'precious unsaved words');
  await pressShortcut(page, 'n');

  await expect(page.locator('.app-modal')).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('precious unsaved words');
});

test('dirty tab close: Cancel keeps the tab and its document', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'disposable draft');
  await page.locator('.document-tab.active .document-tab-close').click();

  const modal = page.locator('.app-modal');
  await expect(modal).toBeVisible({ timeout: 2000 });
  await modal.getByRole('button', { name: 'Cancel' }).click();

  await expect(modal).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(activeEditor(page)).toContainText('disposable draft');
});

test("dirty tab close: Don't Save closes it and leaves a fresh Untitled", async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'disposable draft');
  await page.locator('.document-tab.active .document-tab-close').click();
  await page.locator('.app-modal').getByRole('button', { name: "Don't Save" }).click();

  await expect(page.locator('.app-modal')).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(activeEditor(page)).not.toContainText('disposable draft');
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
});

test('dirty tab close: Save writes the file, then closes the tab', async ({ page }) => {
  const handler = (cmd: string) => {
    if (cmd === 'show_save_dialog') return '/tmp/guarded.md';
    return null; // write_file / delete_file succeed silently
  };
  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  await typeIntoEditor(page, 'words worth keeping');
  await page.locator('.document-tab.active .document-tab-close').click();

  const modal = page.locator('.app-modal');
  await expect(modal).toBeVisible({ timeout: 2000 });
  await modal.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(modal).toHaveCount(0, { timeout: 3000 });
  // The save went through the dialog to /tmp/guarded.md…
  const write = await page.evaluate(() => {
    const calls = (window as unknown as Record<string, unknown>).__capturedCalls as {
      cmd: string;
      args: { path?: string; content?: string };
    }[];
    return calls.find((c) => c.cmd === 'write_file' && c.args.path === '/tmp/guarded.md');
  });
  expect(write?.args.content).toContain('words worth keeping');
  // …and closing the last tab leaves a fresh Untitled editor.
  await expect(activeEditor(page)).not.toContainText('words worth keeping');
  await expect(page.locator('.document-tab')).toHaveCount(1);
});

test('dirty document: Cmd+O opens in a new tab and preserves the dirty tab', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_open_dialog') return '/tmp/next.md';
    if (cmd === 'read_file') {
      if ((args.path as string) === '/tmp/next.md') return '# The next document';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };
  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  await typeIntoEditor(page, 'unsaved before open');
  await pressShortcut(page, 'o');

  await expect(page.locator('.app-modal')).toHaveCount(0);
  await expect(activeEditor(page)).toContainText('The next document', { timeout: 3000 });
  const opened = await page.evaluate(() => {
    const calls = (window as unknown as Record<string, unknown>).__capturedCalls as {
      cmd: string;
    }[];
    return calls.some((c) => c.cmd === 'show_open_dialog');
  });
  expect(opened).toBe(true);
  await closeSessionPickerIfOpen(page);
  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('unsaved before open');
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Errors surfaced to the user
// ────────────────────────────────────────────────────────────────────────────

test('failed save shows an error notice instead of failing silently', async ({ page }) => {
  const handler = (cmd: string) => {
    if (cmd === 'show_save_dialog') return '/tmp/readonly.md';
    if (cmd === 'write_file') throw new Error('Permission denied (os error 13)');
    return null;
  };
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'doomed save');
  await pressShortcut(page, 's');

  const modal = page.locator('.app-modal');
  await expect(modal).toBeVisible({ timeout: 3000 });
  await expect(modal).toContainText('Could not save file');
  await expect(modal).toContainText('/tmp/readonly.md');

  await modal.locator('button:has-text("OK")').click();
  await expect(modal).toHaveCount(0);
  // The document is still dirty — Untitled drops folder/meta chrome but keeps
  // the compact dirty dot after its filename.
  await expect(page.locator('.dirty-dot')).toBeVisible();
  expect(await page.title()).toContain('•');
});

test('corrupt sidecar on open shows a notice and the doc still loads', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_open_dialog') return '/tmp/doc.md';
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/doc.md') return '# Document with broken sidecar';
      return '{ this is not valid json';
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };
  await setupWithIPC(page, { handler });

  await pressShortcut(page, 'o');

  const modal = page.locator('.app-modal');
  await expect(modal).toBeVisible({ timeout: 3000 });
  await expect(modal).toContainText('Comments file could not be read');
  await expect(modal).toContainText('/tmp/doc.comments.json');

  await modal.locator('button:has-text("OK")').click();
  await expect(modal).toHaveCount(0);
  await expect(activeEditor(page)).toContainText('Document with broken sidecar');
});
