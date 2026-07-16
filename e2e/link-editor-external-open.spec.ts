import { expect, test } from '@playwright/test';
import { activeEditor, setupMemoryTauri } from './helpers/memoryTauri';

test('Open in the link editor delegates an absolute URL to the native opener', async ({ page }) => {
  await setupMemoryTauri(page);
  const editor = activeEditor(page);
  await editor.click();
  await page.keyboard.type('Quill website');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+k');

  const linkEditor = page.getByRole('dialog', { name: 'Create link' });
  await linkEditor.getByLabel('URL').fill('https://example.com/quill');
  await linkEditor.getByRole('button', { name: 'Apply' }).click();
  await editor.locator('a').click();

  const editLink = page.getByRole('dialog', { name: 'Edit link' });
  await editLink.getByRole('button', { name: /Open/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__quillCalls.find((call) => call.cmd === 'plugin:opener|open_url')?.args.url,
      ),
    )
    .toBe('https://example.com/quill');
  await expect(editor.locator('a[href="https://example.com/quill"]')).toHaveText('Quill website');
});
