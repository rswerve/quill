import { expect, test } from '@playwright/test';

const THEME_IDS = ['paper', 'gruvbox'] as const;

test('rail theme toggle switches between only Paper and Gruvbox and persists Gruvbox', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  const toggle = page.locator('.rail .theme-toggle');
  await expect(toggle).toHaveAttribute('title', 'Switch to Gruvbox');
  await toggle.click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'gruvbox');
  await expect(toggle).toHaveAttribute('title', 'Switch to Paper');
  expect(await page.evaluate(() => localStorage.getItem('quill-theme'))).toBe('gruvbox');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'gruvbox');
  await expect(page.locator('.rail .theme-toggle')).toHaveAttribute('title', 'Switch to Paper');
});

test('retired persisted theme ids fall back to Paper and are normalized', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor();

  for (const id of ['sage', 'warm', 'cool', 'earth']) {
    await page.evaluate((themeId) => localStorage.setItem('quill-theme', themeId), id);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await expect(page.locator('.rail .theme-toggle')).toHaveAttribute('title', 'Switch to Gruvbox');
    expect(await page.evaluate(() => localStorage.getItem('quill-theme'))).toBe('paper');
  }
});

test('review actions stay tonal, borderless, and distinct in both themes', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor();
  await editor.click();
  await page.getByRole('button', { name: 'Suggesting' }).click();
  await editor.click();
  await page.keyboard.type('A restrained suggestion');

  const accept = page.locator('.suggestion-accept-btn');
  const reject = page.locator('.suggestion-reject-btn');
  const acceptAll = page.locator('.topbar-accept-all');
  const rejectAll = page.locator('.topbar-reject-all');

  for (const theme of THEME_IDS) {
    if (theme !== 'paper') {
      await page.locator('.rail .theme-toggle').click();
    }

    const base = await Promise.all(
      [accept, reject, acceptAll, rejectAll].map((locator) =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            color: style.color,
            shadow: style.boxShadow,
            borderStyle: style.borderTopStyle,
            borderWidth: style.borderTopWidth,
          };
        }),
      ),
    );
    expect(base.every(({ shadow }) => shadow === 'none')).toBe(true);
    expect(
      base.every(({ borderStyle, borderWidth }) => borderStyle === 'none' && borderWidth === '0px'),
    ).toBe(true);
    expect(base[0].background).not.toBe(base[1].background);
    expect(base[2].background).toBe('rgba(0, 0, 0, 0)');
    expect(base[3].background).toBe('rgba(0, 0, 0, 0)');
    expect(base[2].color).not.toBe(base[3].color);

    await accept.hover();
    await expect
      .poll(() => accept.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(base[0].background);
    await reject.hover();
    await expect
      .poll(() => reject.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(base[1].background);
    await acceptAll.hover();
    await expect
      .poll(() => acceptAll.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(base[2].background);
    await rejectAll.hover();
    await expect
      .poll(() => rejectAll.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(base[3].background);
  }
});
