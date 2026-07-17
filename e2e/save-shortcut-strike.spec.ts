import { expect, test } from '@playwright/test';
import { activeEditor, setupMemoryTauri } from './helpers/memoryTauri';

/**
 * Regression: Cmd/Ctrl+Shift+S is Quill's Save As, and Tiptap StarterKit binds
 * the same chord to toggle Strike. A focused editor therefore struck the
 * selection (or left a stored strike mark the next keystrokes inherited)
 * whenever the user reached for Save As. It was only caught before by a
 * load-sensitive save-race test that failed intermittently and passed on
 * retry — so this asserts the fix deterministically, at both the keyboard
 * chord and the resulting save.
 *
 * The fix removes Strike's keyboard shortcut at its source
 * (extensions/StrikeWithoutSaveShortcut.ts); this proves the composed
 * Editor.tsx never strikes on that chord while Save As still runs.
 */

async function pressSaveAs(page: import('@playwright/test').Page) {
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Shift');
  await page.keyboard.up('ControlOrMeta');
}

test('Cmd+Shift+S (Save As) never toggles strikethrough on a cursor', async ({ page }) => {
  const savePath = '/tmp/save-shortcut.md';
  await setupMemoryTauri(page, { savePath });

  await activeEditor(page).click();
  await page.keyboard.type('before save');

  // Save As fires here; assert it landed (proves the chord still saves, not
  // just that it stopped striking).
  await pressSaveAs(page);
  await expect
    .poll(() => page.evaluate((path) => window.__quillFiles[path], savePath))
    .toContain('before save');

  // Type after the chord: if Cmd+Shift+S had toggled a stored strike mark on,
  // this text would inherit it. This is the assertion that fails pre-fix.
  await page.keyboard.type(' and after');

  const html = await activeEditor(page).innerHTML();
  expect(html).not.toContain('<s>');
  expect(html).not.toContain('track-delete');
  await expect(activeEditor(page)).toContainText('before save and after');

  // The saved copy never carried strikethrough syntax.
  const savedText = await page.evaluate((path) => window.__quillFiles[path], savePath);
  expect(savedText).not.toContain('~~');
});

test('Cmd+Shift+S (Save As) never strikes an existing selection', async ({ page }) => {
  await setupMemoryTauri(page, { savePath: '/tmp/save-shortcut-2.md' });

  await activeEditor(page).click();
  await page.keyboard.type('select and save this');
  // Select all, then reach for Save As over the selection.
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('ControlOrMeta');
  await pressSaveAs(page);

  const html = await activeEditor(page).innerHTML();
  expect(html).not.toContain('<s>');
  await expect(activeEditor(page)).toContainText('select and save this');
});

test('strike is still available via the toggleStrike command after the shortcut removal', async ({
  page,
}) => {
  await setupMemoryTauri(page, { savePath: '/tmp/save-shortcut-3.md' });

  await activeEditor(page).click();
  await page.keyboard.type('make me struck');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('ControlOrMeta');
  // Toolbar Strike button (rail/toolbar exposes it by accessible name).
  const strikeButton = page.getByRole('button', { name: /strike/i }).first();
  await strikeButton.click();

  const html = await activeEditor(page).innerHTML();
  expect(html).toContain('<s>');
});
