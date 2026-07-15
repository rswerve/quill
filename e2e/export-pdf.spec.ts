import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { expectEditorHtml, expectSelectionText } from './helpers/deterministicWaits';

// Export to PDF is print-to-PDF: the artifact is defined entirely by the
// `@media print` rules in App.css (handleExportPdf just calls window.print()).
// CI can't open the OS print dialog or diff a binary PDF, but it *can* emulate
// print media and read computed styles — which is exactly what these rules
// produce. So we drive the editor into a state with all three kinds of markup
// (a tracked insertion, a tracked deletion, a comment highlight), flip the page
// to print media, and assert the clean-copy contract: chrome gone, deletions
// hidden, insertions and comment highlights rendered as plain text.

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return { editor };
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

    await page.emulateMedia({ media: 'print' });

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
    const screenSize = await page
      .locator('.ProseMirror')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(screenSize).toBeCloseTo(43.2, 1);

    await page.emulateMedia({ media: 'print' });
    const printSize = await page
      .locator('.ProseMirror')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(printSize).toBeCloseTo(18, 1);
  });

  test('renders suggesting-mode markup as an accepted clean copy', async ({ page }) => {
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

    await page.emulateMedia({ media: 'print' });

    // The struck-out original is removed entirely from the printed copy.
    expect(await display(page, 'del.track-delete')).toBe('none');

    // The insertion reads as plain text: no strike/underline decoration, no
    // background wash — indistinguishable from accepted body text.
    const ins = page.locator('ins.track-insert').first();
    const insStyle = await ins.evaluate((el) => {
      const s = getComputedStyle(el);
      return { decoration: s.textDecorationLine, bg: s.backgroundColor };
    });
    expect(insStyle.decoration).toBe('none');
    expect(insStyle.bg).toBe('rgba(0, 0, 0, 0)');

    // The visible text of the clean copy is the kept text plus the insertion,
    // with the deletion absent. (textContent still includes <del> text, so we
    // assert on the rendered/visible text instead.)
    await expect(page.locator('ins.track-insert')).toHaveText(' added');
  });

  test('strips comment highlight under print media', async ({ page }) => {
    const { editor } = await setup(page);

    await editor.click();
    await page.keyboard.type('Commented text');

    // Select all and add a comment via the floating + button.
    await page.keyboard.down('ControlOrMeta');
    await page.keyboard.press('a');
    await page.keyboard.up('ControlOrMeta');
    await expectSelectionText(page, 'Commented text');
    await page.getByRole('button', { name: 'Add comment to selection' }).click();
    await page.locator('.add-comment-compose textarea').fill('a remark');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expectEditorHtml(editor, { contains: ['comment-mark'] });

    await page.emulateMedia({ media: 'print' });

    // The highlight background and underline are gone; the text remains.
    const markStyle = await page
      .locator('mark.comment-mark')
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, borderBottom: s.borderBottomWidth };
      });
    expect(markStyle.bg).toBe('rgba(0, 0, 0, 0)');
    expect(markStyle.borderBottom).toBe('0px');
  });
});
