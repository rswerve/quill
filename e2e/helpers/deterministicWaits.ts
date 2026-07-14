import { expect, type Locator, type Page } from '@playwright/test';

export async function expectEditorHtml(
  editor: Locator,
  options: { contains?: string[]; excludes?: string[] },
) {
  const contains = options.contains ?? [];
  const excludes = options.excludes ?? [];
  await expect
    .poll(async () => {
      const html = await editor.innerHTML();
      return {
        contains: contains.filter((value) => html.includes(value)),
        excludes: excludes.filter((value) => !html.includes(value)),
      };
    })
    .toEqual({ contains, excludes });
}

export async function expectSelectionText(page: Page, expected?: string) {
  if (expected !== undefined) {
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe(expected);
    return;
  }
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0))
    .toBeGreaterThan(0);
}

export async function expectPageTitleToContain(page: Page, expected: string) {
  await expect.poll(() => page.title()).toContain(expected);
}
