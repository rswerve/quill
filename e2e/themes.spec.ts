import { expect, test } from '@playwright/test';

const THEME_LABELS = [
  'Paper',
  'Sage',
  'Mocha · Dragonfly',
  'Watery · Adirondack',
  'Rodeo · Ecological',
  'Gruvbox',
];

test('theme selector offers all six themes and persists Gruvbox', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor();

  await expect(page.locator('html')).toHaveClass(/theme-paper/);
  await expect(page.locator('.theme-selector-trigger .theme-label')).toHaveText('Paper');

  await page.locator('.theme-selector-trigger').click();
  const options = page.locator('.theme-selector-item');
  await expect(options).toHaveCount(6);
  await expect(options.locator('.theme-label')).toHaveText(THEME_LABELS);
  await options.filter({ hasText: 'Gruvbox' }).click();

  await expect(page.locator('html')).toHaveClass(/theme-gruvbox/);
  expect(await page.evaluate(() => localStorage.getItem('quill-theme'))).toBe('gruvbox');

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/theme-gruvbox/);
  await expect(page.locator('.theme-selector-trigger .theme-label')).toHaveText('Gruvbox');
});

test('the four original persisted theme ids remain valid', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ProseMirror').waitFor();

  for (const [id, label] of [
    ['sage', 'Sage'],
    ['warm', 'Mocha · Dragonfly'],
    ['cool', 'Watery · Adirondack'],
    ['earth', 'Rodeo · Ecological'],
  ]) {
    await page.evaluate((themeId) => localStorage.setItem('quill-theme', themeId), id);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${id}`));
    await expect(page.locator('.theme-selector-trigger .theme-label')).toHaveText(label);
    expect(await page.evaluate(() => localStorage.getItem('quill-theme'))).toBe(id);
  }
});

test('review actions stay tonal, borderless, and distinct in all six themes', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor();
  await editor.click();
  await page.locator('.mode-switch').click();
  await editor.click();
  await page.keyboard.type('A restrained suggestion');

  const accept = page.locator('.suggestion-accept-btn');
  const reject = page.locator('.suggestion-reject-btn');
  const acceptAll = page.locator('.toolbar-btn-accept');
  const rejectAll = page.locator('.toolbar-btn-reject');

  for (const theme of THEME_LABELS) {
    if (theme !== 'Paper') {
      await page.locator('.theme-selector-trigger').click();
      await page.locator('.theme-selector-item').filter({ hasText: theme }).click();
    }

    const base = await Promise.all(
      [accept, reject, acceptAll, rejectAll].map((locator) =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
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
    expect(base[2].background).not.toBe(base[3].background);

    await accept.hover();
    await expect
      .poll(() => accept.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(base[0].background);
    await reject.hover();
    await expect
      .poll(() => reject.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(base[1].background);
  }
});
