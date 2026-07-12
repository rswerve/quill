/** Fixed, bundled document typography and its persistent zoom multiplier. */
import { expect, test, type Locator, type Page } from '@playwright/test';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  return { editor };
}

async function seedHeadingAndBody(page: Page) {
  await page.keyboard.type('# Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('body text');
}

test('uses fixed Mulish body, Lora headings, and 13.5px body text', async ({ page }) => {
  const { editor } = await setup(page);
  await seedHeadingAndBody(page);

  await expect(page.locator('.font-controls')).toHaveCount(0);
  await expect(page.getByTitle('Document font')).toHaveCount(0);
  await expect(page.getByTitle('Document text size')).toHaveCount(0);

  const body = await editor.evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: parseFloat(style.fontSize) };
  });
  expect(body.family).toContain('Mulish Variable');
  expect(body.size).toBeCloseTo(13.5, 1);

  const headingFont = await editor
    .locator('h1')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(headingFont).toContain('Lora Variable');
});

test('keeps fixed document fonts separate from chrome and clears retired picker keys', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('quill-doc-font', 'retired-face');
    localStorage.setItem('quill-doc-font-size', '16');
  });
  await page.reload();

  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  const stored = await page.evaluate(() => ({
    font: localStorage.getItem('quill-doc-font'),
    size: localStorage.getItem('quill-doc-font-size'),
  }));
  expect(stored).toEqual({ font: null, size: null });

  const documentFont = await editor.evaluate((element) => getComputedStyle(element).fontFamily);
  const chromeFont = await page
    .locator('.mode-switch-label')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(documentFont).toContain('Mulish Variable');
  expect(chromeFont).toContain('Mulish Variable');
  expect(chromeFont).not.toContain('Lora Variable');
});

test('places the Editing toggle directly after the link divider', async ({ page }) => {
  await setup(page);

  const toggle = page.locator('.link-button-wrap + .toolbar-divider + .mode-switch');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText('Editing');
  await toggle.click();
  await expect(toggle).toContainText('Suggesting');
});

test('persists zoom across reloads and restores the document scale', async ({ page }) => {
  const { editor } = await setup(page);
  await page.locator('.footer-zoom-slider').fill('1.8');
  await expect(page.locator('.footer-zoom-label')).toHaveText('180%');
  await expect(page.locator('[data-editor-zoom]')).toHaveAttribute('data-editor-zoom', '1.8');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('quill-zoom'))).toBe('1.8');

  const zoomedSize = await editor.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize),
  );
  expect(zoomedSize).toBeCloseTo(13.5 * 1.8, 1);

  await page.reload();
  await page.locator('.ProseMirror').waitFor({ timeout: 5000 });
  await expect(page.locator('.footer-zoom-label')).toHaveText('180%');
  await expect(page.locator('[data-editor-zoom]')).toHaveAttribute('data-editor-zoom', '1.8');
  const restoredSize = await page
    .locator('.ProseMirror')
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(restoredSize).toBeCloseTo(13.5 * 1.8, 1);
});
