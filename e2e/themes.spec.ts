import { expect, test } from '@playwright/test';

test('theme selector offers only Paper and Gruvbox and persists Gruvbox', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor();

  await expect(page.locator('html')).toHaveClass(/theme-paper/);
  await expect(page.locator('.theme-selector-trigger .theme-label')).toHaveText('Paper');

  await page.locator('.theme-selector-trigger').click();
  const options = page.locator('.theme-selector-item');
  await expect(options).toHaveCount(2);
  await expect(options.locator('.theme-label')).toHaveText(['Paper', 'Gruvbox']);
  await options.filter({ hasText: 'Gruvbox' }).click();

  await expect(page.locator('html')).toHaveClass(/theme-gruvbox/);
  expect(await page.evaluate(() => localStorage.getItem('quill-theme'))).toBe('gruvbox');

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/theme-gruvbox/);
  await expect(page.locator('.theme-selector-trigger .theme-label')).toHaveText('Gruvbox');
});

test('a removed legacy theme id migrates to Paper', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('quill-theme', 'sage'));
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor();

  await expect(page.locator('html')).toHaveClass(/theme-paper/);
  await expect(page.locator('.theme-selector-trigger .theme-label')).toHaveText('Paper');
  expect(await page.evaluate(() => localStorage.getItem('quill-theme'))).toBe('paper');
});
