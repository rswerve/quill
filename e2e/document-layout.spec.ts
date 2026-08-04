import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import type { Editor, JSONContent } from '@tiptap/react';
import { activeEditor, activeTabHost } from './helpers/memoryTauri';

type Doc = JSONContent & { type: 'doc'; content: JSONContent[] };

async function setup(page: Page) {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return { editor };
}

const paragraph = (value: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text: value }],
});
const cell = (value: string): JSONContent => ({
  type: 'tableCell',
  content: [paragraph(value)],
});
const table = (left: string, right: string): JSONContent => ({
  type: 'table',
  content: [{ type: 'tableRow', content: [cell(left), cell(right)] }],
});

async function load(page: Page, content: Doc) {
  await page.evaluate((json) => {
    const editor = (window as unknown as { __quillEditor?: Editor }).__quillEditor;
    if (!editor) throw new Error('no editor handle');
    editor.commands.setContent(json);
  }, content);
}

test('the Studio document page tracks its scroll-area width without a cap', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await setup(page);

  const measure = () =>
    activeTabHost(page).evaluate((host) => {
      const area = host.querySelector<HTMLElement>('.editor-scroll-area');
      const documentPage = host.querySelector<HTMLElement>('.editor-page');
      if (!area || !documentPage) throw new Error('document layout is not mounted');
      return {
        areaWidth: area.getBoundingClientRect().width,
        pageWidth: documentPage.getBoundingClientRect().width,
        pageMaxWidth: getComputedStyle(documentPage).maxWidth,
      };
    });

  const narrow = await measure();
  expect(Math.abs(narrow.pageWidth - narrow.areaWidth)).toBeLessThan(1);
  expect(narrow.pageMaxWidth).toBe('none');

  await page.setViewportSize({ width: 1500, height: 720 });
  const wide = await measure();
  expect(Math.abs(wide.pageWidth - wide.areaWidth)).toBeLessThan(1);
  expect(wide.pageMaxWidth).toBe('none');
  expect(wide.pageWidth - narrow.pageWidth).toBeGreaterThan(250);
});

test('screen layout keeps content-sized tables and honest min-content wrapping', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await load(page, { type: 'doc', content: [table('Label', 'Description')] });

  // TipTap injects overflow-wrap: break-word after App.css, so that computed
  // property cannot expose a stylesheet regression. It does not set word-break.
  await expect(editor).toHaveCSS('word-break', 'normal');
  await expect(editor.locator('table')).toHaveCSS('table-layout', 'auto');
});

test('print pins tables to fixed layout in the detached print document', async ({ page }) => {
  await setup(page);
  await load(page, { type: 'doc', content: [table('Label', 'Description')] });

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });

  const printTable = activeTabHost(page).locator('[data-print-doc] table');
  await expect(printTable).toHaveCount(1);
  await expect(printTable).toHaveCSS('table-layout', 'fixed');
});

test('table columns follow content rather than column position', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  const { editor } = await setup(page);
  const long = 'A deliberately long descriptive label whose column should claim the extra room';
  const short = 'ID';
  await load(page, {
    type: 'doc',
    content: [table(long, short), paragraph('Between tables'), table(short, long)],
  });

  const widths = await editor
    .locator('table')
    .evaluateAll((tables) =>
      tables.map((current) =>
        Array.from(current.querySelectorAll('td')).map(
          (currentCell) => currentCell.getBoundingClientRect().width,
        ),
      ),
    );

  expect(widths).toHaveLength(2);
  expect(Math.abs(widths[0][0] - widths[1][1])).toBeLessThan(2);
  expect(Math.abs(widths[0][1] - widths[1][0])).toBeLessThan(2);
  expect(widths[0][0]).toBeGreaterThan(widths[0][1] * 2);
});
