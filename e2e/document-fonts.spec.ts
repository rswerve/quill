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

test('uses Source Serif 4 for 18px body text and 38px headings', async ({ page }) => {
  const { editor } = await setup(page);
  await seedHeadingAndBody(page);

  await expect(page.locator('.font-controls')).toHaveCount(0);
  await expect(page.getByTitle('Document font')).toHaveCount(0);
  await expect(page.getByTitle('Document text size')).toHaveCount(0);

  const body = await editor.evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: parseFloat(style.fontSize) };
  });
  expect(body.family).toContain('Source Serif 4 Variable');
  expect(body.size).toBeCloseTo(18, 1);

  const heading = await editor.locator('h1').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      family: style.fontFamily,
      size: parseFloat(style.fontSize),
      weight: style.fontWeight,
      lineHeight: parseFloat(style.lineHeight),
    };
  });
  expect(heading.family).toContain('Source Serif 4 Variable');
  expect(heading.size).toBeCloseTo(38, 1);
  expect(heading.weight).toBe('600');
  expect(heading.lineHeight).toBeCloseTo(38 * 1.15, 1);
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
    .locator('.topbar .seg')
    .first()
    .evaluate((element) => getComputedStyle(element).fontFamily);
  const statusFont = await page
    .locator('.footer')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(documentFont).toContain('Source Serif 4 Variable');
  expect(chromeFont).toContain('Instrument Sans Variable');
  expect(chromeFont).not.toContain('Source Serif 4 Variable');
  expect(statusFont).toContain('JetBrains Mono Variable');
});

test('places the link at the end of the formatting rail and Editing in the topbar', async ({
  page,
}) => {
  await setup(page);

  const link = page.locator('.rail .link-button-wrap');
  const toggle = page.locator('.topbar .mode-switch');
  await expect(link).toBeVisible();
  await expect(link.locator('xpath=following-sibling::*[1]')).toHaveClass(/rail-spacer/);
  await expect(toggle).toBeVisible();
  await expect(toggle.getByRole('button', { name: 'Editing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await toggle.getByRole('button', { name: 'Suggesting' }).click();
  await expect(toggle.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
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
  expect(zoomedSize).toBeCloseTo(18 * 1.8, 1);

  await page.reload();
  await page.locator('.ProseMirror').waitFor({ timeout: 5000 });
  await expect(page.locator('.footer-zoom-label')).toHaveText('180%');
  await expect(page.locator('[data-editor-zoom]')).toHaveAttribute('data-editor-zoom', '1.8');
  const restoredSize = await page
    .locator('.ProseMirror')
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(restoredSize).toBeCloseTo(18 * 1.8, 1);
});
