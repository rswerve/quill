/** End-to-end coverage for Quill's consolidated create/edit link card. */
import { test, expect } from './fixtures';
import type { Page, Locator } from '@playwright/test';
import { activeEditor } from './helpers/memoryTauri';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  return { editor };
}

async function selectAll(page: Page) {
  await page.keyboard.press('ControlOrMeta+a');
}

async function pastePlainText(editor: Locator, text: string) {
  await editor.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, text);
}

const linkButton = (page: Page) => page.locator('[title="Link (Cmd+K)"]');
const linkEditor = (page: Page) => page.getByRole('dialog', { name: /Create link|Edit link/ });
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

  test('clicking into a link opens exactly one editor with both values prefilled', async ({
    page,
  }) => {
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
    // Exactly one dialog is open, and the assertion above pins it as LinkEditor.
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByLabel('URL')).toHaveCount(1);
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
    await page.locator('header:has([aria-label="Review panel"])').click();
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
      if (theme === 'gruvbox') await page.getByRole('button', { name: 'Toggle theme' }).click();
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
    await expect(page.locator('[data-suggestion-kind="replace"]')).toHaveCount(1);
  });
});

test.describe('Markdown link shortcuts', () => {
  const syntax = '[text and](https://www.thenalink.com)';

  test('typing the exact Markdown syntax converts it to one clean link', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type(syntax);

    await expect(editor).toHaveText('text and');
    await expect(editor.locator('a[href="https://www.thenalink.com"]')).toHaveText('text and');
  });

  test('continued typing stays outside a converted Markdown link', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('[a](https://x.com) more');

    await expect(editor).toHaveText('a more');
    await expect(editor.locator('a[href="https://x.com"]')).toHaveText('a');
  });

  test('an isolated converted Markdown link keeps its exact label', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('[a](https://x.com)');

    await expect(editor).toHaveText('a');
    await expect(editor.locator('a[href="https://x.com"]')).toHaveText('a');
  });

  test('pasting the exact Markdown syntax converts it before bare-URL autolinking', async ({
    page,
  }) => {
    const { editor } = await setup(page);
    await pastePlainText(editor, syntax);

    await expect(editor).toHaveText('text and');
    await expect(editor.locator('a[href="https://www.thenalink.com"]')).toHaveText('text and');
  });

  test('a bare-domain Markdown href is normalized', async ({ page }) => {
    const { editor } = await setup(page);
    await page.keyboard.type('[x](example.com)');

    await expect(editor.locator('a[href="https://example.com"]')).toHaveText('x');
  });

  for (const gesture of ['type', 'paste'] as const) {
    test(`suggesting mode ${gesture} conversion leaves no tracked punctuation`, async ({
      page,
    }) => {
      const { editor } = await setup(page);
      await page.getByRole('button', { name: 'Suggesting' }).click();
      await editor.click();

      if (gesture === 'type') await page.keyboard.type(syntax);
      else await pastePlainText(editor, syntax);

      await expect(editor).toHaveText('text and');
      await expect(editor.locator('a[href="https://www.thenalink.com"]')).toHaveText('text and');
      await expect(editor.locator('del.track-delete')).toHaveCount(0);
      await expect(editor.locator('ins.track-insert')).toHaveText('text and');
      await expect(page.locator('[data-suggestion-kind="insert"]')).toHaveCount(1);
    });
  }

  test('bare-URL paste autolinks exactly once in suggesting mode', async ({ page }) => {
    const { editor } = await setup(page);
    await page.getByRole('button', { name: 'Suggesting' }).click();
    await editor.click();
    await pastePlainText(editor, 'https://x.com');

    await expect(editor).toHaveText('https://x.com');
    await expect(editor.locator('a[href="https://x.com"]')).toHaveCount(1);
    await expect(editor.locator('a[href="https://x.com"] ins.track-insert')).toHaveText(
      'https://x.com',
    );
  });

  for (const suggesting of [false, true]) {
    test(`one undo fully reverts a paste-converted link (suggesting=${suggesting})`, async ({
      page,
    }) => {
      const { editor } = await setup(page);
      if (suggesting) {
        await page.getByRole('button', { name: 'Suggesting' }).click();
        await editor.click();
      }
      await pastePlainText(editor, syntax);
      await expect(editor).toHaveText('text and');

      await page.keyboard.press('ControlOrMeta+z');
      await expect(editor).toHaveText('');
      await expect(editor.locator('a')).toHaveCount(0);
    });
  }
});
