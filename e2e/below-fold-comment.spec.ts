/**
 * A comment anchored at the end of a tall document remains reachable through
 * the independent flat list and its gutter navigation. No annotation card may
 * extend the document's own scroll range.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectSelectionText } from './helpers/deterministicWaits';

async function setup(page: Page) {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}

test('a last-line comment stays reachable without extending document scroll', async ({ page }) => {
  // Belt-and-braces: document setup dominates this test's runtime, and under
  // parallel-worker load the default 30s budget has been blown before the
  // assertion ever ran.
  test.setTimeout(60_000);

  const editor = await setup(page);

  // Fill well past one viewport so there IS empty space below the last card to
  // reproduce the bug — a short doc leaves viewport below the anchor already.
  // insertText (one bulk insertion per paragraph) instead of keyboard.type:
  // char-by-char typing of 60 paragraphs is what blew the test budget.
  const lines = 60;
  for (let i = 0; i < lines; i++) {
    await page.keyboard.insertText(`Paragraph ${i} — some body text to give the document height.`);
    if (i < lines - 1) await page.keyboard.press('Enter');
  }
  await expect(editor.locator('p')).toHaveCount(lines);
  await expect(editor.locator('p').last()).toContainText(`Paragraph ${lines - 1}`);

  // Comment on the very last line (cursor is already at document end).
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Home');
  await page.keyboard.up('Shift');
  await expectSelectionText(
    page,
    `Paragraph ${lines - 1} — some body text to give the document height.`,
  );

  const plusBtn = page.locator('.add-comment-btn');
  await plusBtn.click();
  const textarea = page.locator('.add-comment-compose textarea');
  await textarea.fill('last-line note');
  // Submit the local note via Cmd+Shift+Enter — the compose popover's buttons can render below
  // the fold for a last-line selection, so don't depend on it being on-screen.
  await textarea.press('ControlOrMeta+Shift+Enter');

  // Scroll back to the top. The card remains in the flat list while its text
  // anchor collapses into the gutter's below-viewport count.
  const scrollArea = page.locator('.editor-scroll-area');
  await scrollArea.evaluate((el) => (el.scrollTop = 0));
  await expect.poll(() => scrollArea.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(page.locator('.editor-bottom-spacer')).toHaveCount(0);

  const panelList = page.locator('.comment-panel-list');
  const card = page.locator('.comment-card');
  await expect(card).toBeVisible();
  await expect(
    page.getByRole('button', { name: /annotations below the viewport/ }),
  ).toHaveAttribute('aria-label', '1 annotations below the viewport');
  await page.getByRole('button', { name: /annotations below the viewport/ }).click();
  await expect.poll(() => scrollArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(card).toHaveClass(/comment-card-active/);

  // Its card is contained by the panel's own viewport, independent of the
  // document's scroll geometry.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const area = document.querySelector('.comment-panel-list') as HTMLElement;
        const el = document.querySelector('.comment-card') as HTMLElement;
        const a = area.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        return c.top >= a.top && c.bottom <= a.bottom;
      }),
    )
    .toBe(true);
  await expect(panelList).toHaveCSS('overflow-y', 'auto');
});
