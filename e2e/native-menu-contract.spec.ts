import { expect, test, type Page } from '@playwright/test';
import { activeEditor, setupMemoryTauri } from './helpers/memoryTauri';

const OPEN_PATH = '/docs/native-open.md';
const SAVE_AS_PATH = '/docs/native-copy.md';

async function emitMenu(page: Page, event: string, payload: unknown = null) {
  await page.evaluate(
    ({ eventName, eventPayload }) => {
      // memoryTauri retains Strict Mode's cleaned-up first listener, while the
      // real Tauri unlisten removes it. Invoke the latest registration so one
      // native event has exactly one production effect.
      const listener = window.__quillListeners
        ?.filter((candidate) => candidate.event === eventName)
        .at(-1);
      listener?.callback({ event: eventName, id: 0, payload: eventPayload });
    },
    { eventName: event, eventPayload: payload },
  );
}

async function waitForMenuListeners(page: Page, events: string[]) {
  await page.waitForFunction((expected) => {
    const actual = new Set(window.__quillListeners?.map((listener) => listener.event));
    return expected.every((event) => actual.has(event));
  }, events);
}

test('native File-menu commands route to their real document outcomes', async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {
      window.__quillPrintCalls = (window.__quillPrintCalls ?? 0) + 1;
    };
  });
  await setupMemoryTauri(page, {
    files: { [OPEN_PATH]: '# Opened through the native menu' },
    openPath: OPEN_PATH,
    savePath: SAVE_AS_PATH,
    hasNativeMenu: true,
  });
  await waitForMenuListeners(page, [
    'menu-new',
    'menu-open',
    'menu-save',
    'menu-save-as',
    'menu-export-pdf',
  ]);

  await emitMenu(page, 'menu-new');
  await expect(page.locator('.document-tab')).toHaveCount(2);

  await emitMenu(page, 'menu-open');
  await expect(page.locator('.document-tab.active')).toContainText('native-open.md');
  await expect(activeEditor(page)).toContainText('Opened through the native menu');
  await activeEditor(page).press('End');
  await page.keyboard.type(' with a saved edit');

  await emitMenu(page, 'menu-save');
  await expect
    .poll(() => page.evaluate((path) => window.__quillFiles[path], OPEN_PATH))
    .toContain('with a saved edit');

  await emitMenu(page, 'menu-save-as');
  await expect(page.locator('.document-tab.active')).toContainText('native-copy.md');
  await expect
    .poll(() => page.evaluate((path) => window.__quillFiles[path], SAVE_AS_PATH))
    .toContain('with a saved edit');

  await emitMenu(page, 'menu-export-pdf');
  await expect.poll(() => page.evaluate(() => window.__quillPrintCalls ?? 0)).toBe(1);
});

test('a native menu owns file accelerators while editor-only shortcuts remain in JavaScript', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.print = () => {
      window.__quillPrintCalls = (window.__quillPrintCalls ?? 0) + 1;
    };
  });
  await setupMemoryTauri(page, {
    openPath: OPEN_PATH,
    savePath: SAVE_AS_PATH,
    hasNativeMenu: true,
  });
  await expect
    .poll(() => page.evaluate(() => window.__quillCalls.some((c) => c.cmd === 'has_native_menu')))
    .toBe(true);
  await page.evaluate(() => {
    window.__quillCalls.length = 0;
  });

  await activeEditor(page).click();
  await page.keyboard.type('dirty local draft');
  for (const shortcut of [
    'ControlOrMeta+n',
    'ControlOrMeta+o',
    'ControlOrMeta+s',
    'ControlOrMeta+Shift+s',
    'ControlOrMeta+p',
  ]) {
    await page.keyboard.press(shortcut);
  }

  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
  await expect(
    page.locator('[aria-label="Document location"] [aria-label="Unsaved"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      nativeCalls: window.__quillCalls.filter((call) =>
        ['show_open_dialog', 'show_save_dialog', 'write_file_atomic'].includes(call.cmd),
      ),
      prints: window.__quillPrintCalls ?? 0,
    })),
  ).toEqual({ nativeCalls: [], prints: 0 });

  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('.find-bar')).toBeVisible();
});
