import { test, expect } from './fixtures';
import type { Page, Locator } from '@playwright/test';
import { expectEditorHtml, expectSelectionText } from './helpers/deterministicWaits';
import { activeEditor, activeTabHost } from './helpers/memoryTauri';

// Export to PDF is print-to-PDF. DocumentTab serializes the clean-source
// projection into a detached [data-print-doc] container on beforeprint, then
// @media print hides the live redline editor and shows that clean snapshot.
// CI cannot drive the OS dialog, but it can exercise the same lifecycle and
// assert the DOM and computed styles that the browser prints.

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return { editor };
}

function printDoc(page: Page): Locator {
  return activeTabHost(page).locator('[data-print-doc]');
}

async function enterPrintMedia(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
}

async function enableSuggesting(page: Page) {
  const badge = page.getByRole('group', { name: 'Editing mode' });
  await expect(badge.getByRole('button', { name: 'Editing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await badge.getByRole('button', { name: 'Suggesting' }).click();
  await expect(badge.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

function display(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).display);
}

test.describe('Export to PDF — print stylesheet (clean copy)', () => {
  test('hides app chrome under print media', async ({ page }) => {
    await setup(page);

    // On screen the rail, topbar, and status bar are visible…
    await expect(page.getByRole('navigation', { name: 'Formatting' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Document actions' })).toBeVisible();
    await expect(page.getByRole('contentinfo', { name: 'Document status' })).toBeVisible();

    await enterPrintMedia(page);

    // …and gone under print media.
    expect(await display(page, 'nav[aria-label="Formatting"]')).toBe('none');
    expect(await display(page, 'header[aria-label="Document actions"]')).toBe('none');
    expect(await display(page, 'footer[aria-label="Document status"]')).toBe('none');
    expect(await display(page, '.comment-layer')).toBe('none');
  });

  test('screen text zoom does not carry into print', async ({ page }) => {
    await setup(page);
    await page.getByRole('slider', { name: 'Zoom' }).fill('2.4');
    await expect(
      page
        .getByRole('group', { name: 'Document zoom' })
        .getByRole('status', { name: 'Zoom level' }),
    ).toHaveText('240%');
    const screenSize = await activeEditor(page).evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    );
    expect(screenSize).toBeCloseTo(43.2, 1);

    await enterPrintMedia(page);
    const printSize = await printDoc(page).evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    );
    expect(printSize).toBeCloseTo(18, 1);
  });

  test('prints the clean original while pending suggestions remain only in the live editor', async ({
    page,
  }) => {
    const { editor } = await setup(page);

    // Committed text, then a tracked deletion of part of it and a tracked
    // insertion — both halves of suggesting-mode markup present in the doc.
    await editor.click();
    await page.keyboard.type('Keep cut');

    await enableSuggesting(page);
    await editor.click();

    // Delete " cut" → wrapped in <del class="track-delete">.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    // Insert " added" → wrapped in <ins class="track-insert">.
    await page.keyboard.type(' added');
    await expectEditorHtml(editor, { contains: ['track-delete', 'track-insert'] });

    await enterPrintMedia(page);

    // Maz's clean-source policy ignores pending edits: the deletion remains,
    // the insertion disappears, and no review markup reaches the print tree.
    await expect(printDoc(page)).toHaveText('Keep cut');
    await expect(printDoc(page).locator('ins, del')).toHaveCount(0);
    await expect(printDoc(page).locator('[class*="track-"], [data-change-id]')).toHaveCount(0);
    await expect(activeEditor(page).locator('ins.track-insert, del.track-delete')).toHaveCount(2);
  });

  test('strips comment markup from the detached print document', async ({ page }) => {
    const { editor } = await setup(page);

    await editor.click();
    await page.keyboard.type('Commented text');

    // Select all and add a comment via the floating + button.
    await page.keyboard.down('ControlOrMeta');
    await page.keyboard.press('a');
    await page.keyboard.up('ControlOrMeta');
    await expectSelectionText(page, 'Commented text');
    await page.getByRole('button', { name: 'Add comment to selection' }).click();
    await page.locator('[data-card-id="comment-composer"] textarea').fill('a remark');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expectEditorHtml(editor, { contains: ['comment-mark'] });

    await enterPrintMedia(page);

    await expect(printDoc(page)).toHaveText('Commented text');
    await expect(printDoc(page).locator('mark, [data-comment-id], .comment-mark')).toHaveCount(0);
    await expect(activeEditor(page).locator('mark.comment-mark')).toHaveCount(1);
  });
});
