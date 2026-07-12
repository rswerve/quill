import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function setupEditor(page: Page) {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await page.waitForTimeout(100);
  return editor;
}

test('bold button applies formatting to selected text', async ({ page }) => {
  const editor = await setupEditor(page);

  await page.keyboard.type('hello world');
  await page.waitForTimeout(100);

  // Select all with Cmd+A
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(100);

  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).toContain('<strong>');
  expect(html).toContain('hello world');
});

test('italic button applies formatting to selected text', async ({ page }) => {
  const editor = await setupEditor(page);

  await page.keyboard.type('hello world');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForTimeout(100);

  await page.locator('[title="Italic (Cmd+I)"]').click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).toContain('<em>');
});

test('bold button with partial selection', async ({ page }) => {
  const editor = await setupEditor(page);

  await page.keyboard.type('hello world');
  // Select "world" (last 5 chars)
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);

  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.waitForTimeout(200);

  const html = await editor.innerHTML();
  expect(html).toContain('<strong>world</strong>');
});

test('bold rail state distinguishes full, mixed, and plain selections', async ({ page }) => {
  await setupEditor(page);
  const bold = page.locator('[title="Bold (Cmd+B)"]');

  await page.keyboard.type('bold plain');
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await bold.click();
  await expect(bold).toHaveClass(/active/);
  await expect(bold).not.toHaveClass(/mixed/);

  await page.keyboard.press('ControlOrMeta+a');
  await expect(bold).toHaveClass(/mixed/);
  await expect(bold).not.toHaveClass(/active/);

  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await expect(bold).not.toHaveClass(/active|mixed/);
});
