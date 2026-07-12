/** End-to-end coverage for Quill's consolidated create/edit link card. */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  return { editor };
}

async function selectAll(page: Page) {
  await page.keyboard.press('ControlOrMeta+a');
}

const linkButton = (page: Page) => page.locator('[title="Link (Cmd+K)"]');
const linkEditor = (page: Page) => page.locator('.link-editor-card');
const textInput = (page: Page) => linkEditor(page).getByLabel('Text');
const urlInput = (page: Page) => linkEditor(page).getByLabel('URL');

async function addLink(page: Page, url: string, via: 'rail' | 'shortcut' = 'rail') {
  if (via === 'shortcut') await page.keyboard.press('ControlOrMeta+k');
  else await linkButton(page).click();
  await expect(linkEditor(page)).toHaveAttribute('aria-label', 'Create link');
  await urlInput(page).fill(url);
  await linkEditor(page).getByRole('button', { name: 'Apply' }).click();
}

test.describe('Link editor', () => {
  test('rail button is disabled without a selection', async ({ page }) => {
    await setup(page);
    await page.keyboard.type('plain text');
    await expect(linkButton(page)).toBeDisabled();
  });

  test('adds a normalized link to selected text', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('visit the docs');
    await selectAll(page);
    await addLink(page, 'example.com/docs');

    await expect(editor.locator('a[href="https://example.com/docs"]')).toHaveText('visit the docs');
  });

  test('clicking into a link opens the editor with both values prefilled', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('home page');
    await selectAll(page);
    await addLink(page, 'https://old.example.com');

    const link = editor.locator('a');
    await link.click();

    await expect(linkEditor(page)).toHaveAttribute('aria-label', 'Edit link');
    await expect(textInput(page)).toHaveValue('home page');
    await expect(urlInput(page)).toHaveValue('https://old.example.com');
    await expect(link).toHaveClass(/link-editor-anchor-active/);
    await expect(page.locator('.link-popover')).toHaveCount(0);
  });

  test('editing the URL applies it without changing display text', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('home page');
    await selectAll(page);
    await addLink(page, 'https://old.example.com');

    await editor.locator('a').click();
    await urlInput(page).fill('https://new.example.com');
    await linkEditor(page).getByRole('button', { name: 'Apply' }).click();

    await expect(editor.locator('a[href="https://new.example.com"]')).toHaveText('home page');
  });

  test('editing Text replaces the label while keeping the link mark', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('style guide');
    await selectAll(page);
    await addLink(page, 'https://example.com/style');

    await editor.locator('a').click();
    await textInput(page).fill('writing handbook');
    await linkEditor(page).getByRole('button', { name: 'Apply' }).click();

    await expect(editor.locator('a[href="https://example.com/style"]')).toHaveText(
      'writing handbook',
    );
    await expect(editor).not.toContainText('style guide');
  });

  test('Remove unlinks without removing display text', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('linked words');
    await selectAll(page);
    await addLink(page, 'https://example.com');

    await editor.locator('a').click();
    await linkEditor(page).getByRole('button', { name: 'Remove' }).click();

    await expect(editor.locator('a')).toHaveCount(0);
    await expect(editor).toContainText('linked words');
  });

  test('Open is enabled for absolute links and disabled for relative or fragment links', async ({
    page,
  }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('link target');
    await selectAll(page);
    await addLink(page, 'https://example.com');
    await editor.locator('a').click();

    const open = linkEditor(page).getByRole('button', { name: /Open/ });
    await expect(open).toBeEnabled();
    await urlInput(page).fill('./sibling.md');
    await expect(open).toBeDisabled();
    await expect(open).toHaveAttribute('title', /document navigation/);
    await urlInput(page).fill('#section');
    await expect(open).toBeDisabled();
  });

  test('Escape and outside click dismiss without changing the link', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('unchanged link');
    await selectAll(page);
    await addLink(page, 'https://example.com');

    await editor.locator('a').click();
    await urlInput(page).fill('https://discard.example.com');
    await page.keyboard.press('Escape');
    await expect(linkEditor(page)).toHaveCount(0);

    await editor.locator('a').click();
    await urlInput(page).fill('https://also-discard.example.com');
    await page.locator('.comments-head').click();
    await expect(linkEditor(page)).toHaveCount(0);
    await expect(editor.locator('a[href="https://example.com"]')).toHaveText('unchanged link');
  });

  test('Cmd+K create uses the same card with selected text prefilled and URL focused', async ({
    page,
  }) => {
    await setup(page);
    await page.keyboard.type('shortcut link');
    await selectAll(page);
    await page.keyboard.press('ControlOrMeta+k');

    await expect(linkEditor(page)).toHaveAttribute('aria-label', 'Create link');
    await expect(textInput(page)).toHaveValue('shortcut link');
    await expect(urlInput(page)).toBeFocused();
    await expect(linkEditor(page).getByRole('button', { name: 'Remove' })).toBeDisabled();
    await expect(page.locator('.link-popover')).toHaveCount(0);
  });

  test('Enter applies the create flow', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('enter applies');
    await selectAll(page);
    await page.keyboard.press('ControlOrMeta+k');
    await urlInput(page).fill('https://example.com');
    await urlInput(page).press('Enter');

    await expect(editor.locator('a[href="https://example.com"]')).toHaveText('enter applies');
    await expect(linkEditor(page)).toHaveCount(0);
  });

  test('uses the active theme tokens in Paper and Gruvbox', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('themed link');
    await selectAll(page);
    await addLink(page, 'https://example.com');

    for (const theme of ['paper', 'gruvbox'] as const) {
      if (theme === 'gruvbox') await page.locator('.rail .theme-toggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await editor.locator('a').click();
      const colors = await linkEditor(page).evaluate((card) => {
        const resolvedToken = (property: string) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${property})`;
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        };
        return {
          card: getComputedStyle(card).backgroundColor,
          token: resolvedToken('--bg-card'),
          border: getComputedStyle(card).borderTopColor,
          borderToken: resolvedToken('--border-card'),
        };
      });
      expect(colors.card).toBe(colors.token);
      expect(colors.border).toBe(colors.borderToken);
      await page.keyboard.press('Escape');
    }
  });

  test('suggesting-mode Text and URL edit stays one replacement with the correct hrefs', async ({
    page,
  }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('style guide');
    await selectAll(page);
    await addLink(page, 'https://old.example.com');
    await page.getByRole('button', { name: 'Suggesting' }).click();

    await editor.locator('a').click();
    await textInput(page).fill('writing handbook');
    await urlInput(page).fill('https://new.example.com');
    await linkEditor(page).getByRole('button', { name: 'Apply' }).click();

    await expect(editor.locator('a[href="https://new.example.com"] ins.track-insert')).toHaveText(
      'writing handbook',
    );
    await expect(editor.locator('a[href="https://old.example.com"] del.track-delete')).toHaveText(
      'style guide',
    );
    await expect(page.locator('.suggestion-card-replace')).toHaveCount(1);
  });
});
