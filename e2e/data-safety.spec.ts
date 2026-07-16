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
      const sha256Hex = async (content: string): Promise<string> => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      };

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
          // Derive read_file_with_fingerprint from the test's read_file handler:
          // a not-found read (returns null / throws) is typed absence, otherwise
          // present with the real hash.
          if (cmd === 'read_file_with_fingerprint') {
            // Faithful to the native contract: only a null/missing read is typed
            // absence; a thrown read (permission/symlink/etc.) propagates as a reject.
            const content = await handler('read_file', args);
            if (content === null || content === undefined) return { state: 'absent' };
            return { state: 'present', content, hash: await sha256Hex(content as string) };
          }
          const result = await handler(cmd, args);
          // Legacy shim convention: a null/undefined return from a write means
          // "succeeds silently". Supply the atomic-contract success shape so the
          // frontend's typed save path doesn't read a bare null as a conflict.
          if (result === null || result === undefined) {
            if (cmd === 'write_file_atomic') return { status: 'written', hash: 'e2e-hash' };
            if (cmd === 'delete_file_if_match') return { status: 'deleted' };
          }
          return result;
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

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
  await expect(page.locator('[aria-label="Document location"]')).toContainText('Untitled');
});

test('dirty document: Cmd+N preserves it in a background tab without a guard', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'precious unsaved words');
  await pressShortcut(page, 'n');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('precious unsaved words');
});

test('dirty tab close: Cancel keeps the tab and its document', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'disposable draft');
  await page.locator('.document-tab.active .document-tab-close').click();

  const modal = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(modal).toBeVisible({ timeout: 2000 });
  await modal.getByRole('button', { name: 'Cancel' }).click();

  await expect(modal).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(activeEditor(page)).toContainText('disposable draft');
});

test('dirty tab close: modal traps focus and Escape safely cancels', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'precious keyboard-only draft');
  const closeButton = page.locator('.document-tab.active .document-tab-close');
  await closeButton.click();

  const modal = page.getByRole('dialog', { name: 'Unsaved changes' });
  const saveButton = modal.getByRole('button', { name: 'Save', exact: true });
  const cancelButton = modal.getByRole('button', { name: 'Cancel' });
  await expect(modal).toBeVisible({ timeout: 2000 });
  await expect(saveButton).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(saveButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(activeEditor(page)).toContainText('precious keyboard-only draft');
  await expect(closeButton).toBeFocused();
});

test("dirty tab close: Don't Save closes it and leaves a fresh Untitled", async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'disposable draft');
  await page.locator('.document-tab.active .document-tab-close').click();
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: "Don't Save" })
    .click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(activeEditor(page)).not.toContainText('disposable draft');
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
});

test('dirty tab close: Save writes the file, then closes the tab', async ({ page }) => {
  const handler = (cmd: string) => {
    if (cmd === 'show_save_dialog') return '/tmp/guarded.md';
    return null; // the shim defaults writes/deletes to success
  };
  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  await typeIntoEditor(page, 'words worth keeping');
  await page.locator('.document-tab.active .document-tab-close').click();

  const modal = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(modal).toBeVisible({ timeout: 2000 });
  await modal.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(modal).toHaveCount(0, { timeout: 3000 });
  // The save went through the dialog to /tmp/guarded.md…
  const write = await page.evaluate(() => {
    const calls = (window as unknown as Record<string, unknown>).__capturedCalls as {
      cmd: string;
      args: { path?: string; content?: string };
    }[];
    return calls.find((c) => c.cmd === 'write_file_atomic' && c.args.path === '/tmp/guarded.md');
  });
  expect(write?.args.content).toContain('words worth keeping');
  // …and closing the last tab leaves a fresh Untitled editor.
  await expect(activeEditor(page)).not.toContainText('words worth keeping');
  await expect(page.locator('.document-tab')).toHaveCount(1);
});

test('Save As writes the document to the chosen path and rebinds the tab clean', async ({
  page,
}) => {
  const handler = (cmd: string) => {
    if (cmd === 'show_save_dialog') return '/tmp/report.md';
    return null; // the shim defaults writes/deletes to success
  };
  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  await typeIntoEditor(page, 'Quarterly summary content');

  // Cmd+Shift+S — Save As always prompts for a destination path.
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Shift');
  await page.keyboard.up('ControlOrMeta');

  // The active tab rebinds to the chosen filename and goes clean.
  await expect(page.locator('.document-tab.active')).toContainText('report', { timeout: 3000 });
  await expect(page.locator('[aria-label="Document location"]')).toContainText('report');
  await expect(page.locator('[aria-label="Document location"] [aria-label="Unsaved"]')).toHaveCount(
    0,
  );

  // The Markdown was written to exactly the chosen path, with the content.
  const write = await page.evaluate(() => {
    const calls = (window as unknown as Record<string, unknown>).__capturedCalls as {
      cmd: string;
      args: { path?: string; content?: string };
    }[];
    return calls.find((c) => c.cmd === 'write_file_atomic' && c.args.path === '/tmp/report.md');
  });
  expect(write?.args.content).toContain('Quarterly summary content');
});

test('dirty document: Cmd+O opens in a new tab and preserves the dirty tab', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_open_dialog') return '/tmp/next.md';
    if (cmd === 'read_file') {
      if ((args.path as string) === '/tmp/next.md') return '# The next document';
      return null; // sidecar missing → typed absent
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };
  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  await typeIntoEditor(page, 'unsaved before open');
  await pressShortcut(page, 'o');

  // Cmd+O adds a tab and must NOT raise the dirty-save guard (the session picker
  // may appear and is dismissed below — scope this to the guard specifically).
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
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
    if (cmd === 'write_file_atomic') throw new Error('Permission denied (os error 13)');
    return null;
  };
  await setupWithIPC(page, { handler });

  await typeIntoEditor(page, 'doomed save');
  await pressShortcut(page, 's');

  const modal = page.getByRole('dialog', { name: 'Could not save file' });
  await expect(modal).toBeVisible({ timeout: 3000 });
  await expect(modal).toContainText('Could not save file');
  // A manual save names the destination that failed (actionable) and the reason.
  // useFileManager returns the typed failure now; the caller shows it, so an autosave
  // failure stays quiet instead of interrupting with this modal.
  await expect(modal).toContainText('/tmp/readonly.md');
  await expect(modal).toContainText('Permission denied');

  await modal.locator('button:has-text("OK")').click();
  await expect(modal).toHaveCount(0);
  // The document is still dirty — Untitled drops folder/meta chrome but keeps
  // the compact dirty dot after its filename.
  await expect(
    page.locator('[aria-label="Document location"] [aria-label="Unsaved"]'),
  ).toBeVisible();
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

  const modal = page.getByRole('dialog', { name: 'Comments file could not be read' });
  await expect(modal).toBeVisible({ timeout: 3000 });
  await expect(modal).toContainText('Comments file could not be read');
  await expect(modal).toContainText('/tmp/doc.comments.json');

  await modal.locator('button:has-text("OK")').click();
  await expect(modal).toHaveCount(0);
  await expect(activeEditor(page)).toContainText('Document with broken sidecar');
});
