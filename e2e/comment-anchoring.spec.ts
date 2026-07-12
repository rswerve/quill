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
  await page.locator('.add-comment-btn').click();
  const textarea = page.locator('.add-comment-compose textarea');
  await textarea.fill(text);
  await textarea.press('ControlOrMeta+Enter');
  await expect(page.locator('.comment-card-active')).toBeVisible();
}

test('off-screen anchors collapse into navigable above and below pills', async ({ page }) => {
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

  await expect(page.locator('.count-pill')).toHaveText('2');
  const above = page.locator('.offscreen-pill-above');
  await expect(above).toHaveText('▲ 1 above');
  await above.click();
  await expect(page.locator('.comment-card-active')).toContainText('top note');
  await expect(page.locator('.offscreen-pill-below')).toHaveText('▼ 1 below');

  await page.locator('.offscreen-pill-below').click();
  await expect(page.locator('.comment-card-active')).toContainText('bottom note');
  await expect(page.locator('.offscreen-pill-above')).toHaveText('▲ 1 above');
});
