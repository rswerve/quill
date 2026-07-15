import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { selectLastCharacters } from './helpers/memoryTauri';

async function focusEditor(page: Page): Promise<Locator> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}

test.describe('Footer selection counts', () => {
  // Guards the live path unit tests can't reach: a selection-only transaction in
  // the real editor must flow DocumentTab → chrome snapshot → Footer and render
  // "chosen/total", then revert to totals when the selection collapses. The unit
  // tests render Footer with a selection already in place, so they don't prove
  // the chrome re-pushes on a selection-only transaction.
  test('render chosen/total live with the selection and revert when it collapses', async ({
    page,
  }) => {
    const editor = await focusEditor(page);
    const footer = page.getByRole('contentinfo', { name: 'Document status' });

    await editor.pressSequentially('one two three');
    // Totals before any selection ("one two three" = 3 words, 13 chars).
    await expect(footer.getByText('3 WORDS', { exact: true })).toBeVisible();
    await expect(footer.getByText('13 CHARS', { exact: true })).toBeVisible();

    // Select the last three characters ("ree"): one touched word, three chars.
    await selectLastCharacters(page, 3);
    await expect(footer.getByText('1/3 WORDS', { exact: true })).toBeVisible();
    await expect(footer.getByText('3/13 CHARS', { exact: true })).toBeVisible();

    // Collapsing the selection is a selection-only transaction — the footer must
    // revert to totals, not keep the stale chosen/total.
    await editor.press('ArrowRight');
    await expect(footer.getByText('3 WORDS', { exact: true })).toBeVisible();
    await expect(footer.getByText('13 CHARS', { exact: true })).toBeVisible();
    await expect(footer.getByText('1/3 WORDS', { exact: true })).toHaveCount(0);
  });
});
