/**
 * The toolbar Font / Size selectors: document typography follows the choice,
 * persists like the theme, and never drags the UI chrome along. Fonts are
 * bundled, so the computed stacks are asserted as specified values — no
 * network is involved.
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return { editor };
}

const fontSelect = (page: Page) => page.locator('.font-control-select').first();
const sizeSelect = (page: Page) => page.locator('.font-control-select-size');

test('defaults: Mulish body, Petrona headings, 13.5px body text', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('# Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('body text');

  const bodyFont = await editor.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(bodyFont).toContain('Mulish Variable');
  const headingFont = await editor.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(headingFont).toContain('Petrona Variable');

  const bodySize = await editor.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(bodySize).toBeCloseTo(13.5, 1);

  await expect(fontSelect(page)).toHaveValue('mulish');
  await expect(sizeSelect(page)).toHaveValue('13.5');
});

test('Font selection restyles the document, spares the chrome, and persists', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('styled text');

  await fontSelect(page).selectOption('new-york');
  const bodyFont = await editor.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(bodyFont).toContain('ui-serif');

  // UI chrome stays on its own token.
  const chromeFont = await page
    .locator('.mode-switch-label')
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(chromeFont).toContain('Mulish Variable');
  expect(chromeFont).not.toContain('ui-serif');

  // Global persistence, like the theme.
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor({ timeout: 5000 });
  await expect(fontSelect(page)).toHaveValue('new-york');
  const reloadedFont = await page
    .locator('.ProseMirror')
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(reloadedFont).toContain('ui-serif');
});

test('Size selection scales body and headings together; zoom multiplies on top', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await page.keyboard.type('# Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('body text');

  await sizeSelect(page).selectOption('16');
  const bodySize = await editor.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(bodySize).toBeCloseTo(16, 1);
  // Headings keep their ratio (title = 26/13.5 of body).
  const h1Size = await editor
    .locator('h1')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(h1Size).toBeCloseTo(16 * (26 / 13.5), 1);

  // Zoom still multiplies independently of the chosen size.
  await page.keyboard.press('ControlOrMeta+=');
  const zoomed = await editor.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(zoomed).toBeGreaterThan(16.5);
});

test('the Editing toggle survives its move right of the font controls', async ({ page }) => {
  await setup(page);

  // Order: font controls, then a divider, then the mode switch.
  const controls = page.locator('.font-controls');
  const badge = page.locator('.mode-switch');
  await expect(controls).toBeVisible();
  const controlsBox = (await controls.boundingBox())!;
  const badgeBox = (await badge.boundingBox())!;
  expect(badgeBox.x).toBeGreaterThan(controlsBox.x + controlsBox.width);

  await expect(badge).toContainText('Editing');
  await badge.click();
  await expect(badge).toContainText('Suggesting');
});
