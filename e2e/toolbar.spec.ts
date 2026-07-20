import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectSelectionText } from './helpers/deterministicWaits';
import { activeEditor } from './helpers/memoryTauri';

async function setupEditor(page: Page) {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}

test('bold button applies formatting to selected text', async ({ page }) => {
  const editor = await setupEditor(page);

  await page.keyboard.type('hello world');

  // Select all with Cmd+A
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'hello world');

  await page.locator('[title="Bold (Cmd+B)"]').click();
  await expect(editor.locator('strong')).toHaveText('hello world');
});

test('italic button applies formatting to selected text', async ({ page }) => {
  const editor = await setupEditor(page);

  await page.keyboard.type('hello world');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'hello world');

  await page.locator('[title="Italic (Cmd+I)"]').click();
  await expect(editor.locator('em')).toHaveText('hello world');
});

test('bold button with partial selection', async ({ page }) => {
  const editor = await setupEditor(page);

  await page.keyboard.type('hello world');
  // Select "world" (last 5 chars)
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await expectSelectionText(page, 'world');

  await page.locator('[title="Bold (Cmd+B)"]').click();
  await expect(editor.locator('strong')).toHaveText('world');
});

test('bold rail state distinguishes full, mixed, and plain selections', async ({ page }) => {
  await setupEditor(page);
  const bold = page.getByRole('button', { name: 'Bold (Cmd+B)' });
  // State is read through aria-pressed (the semantic contract), plus a computed
  // background for mixed. Rail's state classes are hashed CSS-module names, so a
  // class-name regex would only pass by accident — and would still pass if the
  // mixed slot were mis-mapped to the active class while rendering the wrong
  // fill. The gradient check is what actually pins the mixed treatment.
  const backgroundImage = () =>
    bold.evaluate((element) => getComputedStyle(element).backgroundImage);

  await page.keyboard.type('bold plain');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await bold.click();
  // Full-bold selection → active: a solid accent wash, never a gradient. Move the
  // mouse off the button before reading — its hover fill (higher specificity than
  // the state classes) would otherwise mask the real state treatment.
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(600, 400);
  expect(await backgroundImage()).not.toContain('gradient');

  await page.keyboard.press('ControlOrMeta+a');
  // Part-bold selection → mixed: the diagonal gradient fill.
  await expect(bold).toHaveAttribute('aria-pressed', 'mixed');
  await page.mouse.move(600, 400);
  expect(await backgroundImage()).toContain('linear-gradient');

  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
});
