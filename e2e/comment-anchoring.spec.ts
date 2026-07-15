import { expect, test, type Locator, type Page } from '@playwright/test';

async function setup(page: Page): Promise<Locator> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  return editor;
}

async function selectCurrentLine(page: Page) {
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
}

async function addComment(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  const textarea = page.locator('[data-card-id="comment-composer"] textarea');
  await textarea.fill(text);
  await textarea.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('[data-active]')).toBeVisible();
}

test('off-screen anchors collapse into navigable gutter counts', async ({ page }) => {
  const editor = await setup(page);
  await page.keyboard.insertText('Opening anchor.');
  await selectCurrentLine(page);
  await addComment(page, 'top note');
  await page.keyboard.press('Escape');

  await editor.click();
  await page.keyboard.press('End');
  for (let index = 0; index < 50; index += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(
      `Paragraph ${index} with enough text to create document height.`,
    );
  }
  await selectCurrentLine(page);
  await addComment(page, 'bottom note');

  await expect(page.getByRole('tab', { name: 'Comments 2' })).toBeVisible();
  const above = page.getByRole('button', { name: /annotations above the viewport/ });
  await expect(above).toHaveAttribute('aria-label', '1 annotations above the viewport');
  await above.click();
  await expect(page.locator('[data-active]')).toContainText('top note');
  const below = page.getByRole('button', { name: /annotations below the viewport/ });
  await expect(below).toHaveAttribute('aria-label', '1 annotations below the viewport');

  await below.click();
  await expect(page.locator('[data-active]')).toContainText('bottom note');
  await expect(above).toHaveAttribute('aria-label', '1 annotations above the viewport');
});
