import { expect, test, type Page } from '@playwright/test';
import { ipcFixtures } from './helpers/ipcFixtures';
import {
  activeEditor,
  activeTabHost,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

function sidecar() {
  return JSON.stringify({
    version: 2,
    comments: [],
    suggestions: [],
    aiSession: ipcFixtures.autoBindSession,
  });
}

async function selectAll(page: Page) {
  await activeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
}

async function addCommentToSelection(page: Page, body: string) {
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill(body);
  await page.locator('.add-comment-compose .btn-primary').click();
}

test('mounted tabs preserve independent text, undo, zoom, mode, comments, and suggestions', async ({
  page,
}) => {
  await setupMemoryTauri(page);

  await activeEditor(page).fill('First document words');
  await selectAll(page);
  await addCommentToSelection(page, 'First tab comment');
  await page.keyboard.press('ControlOrMeta+f');
  await expect(activeTabHost(page).locator('.find-bar')).toBeVisible();

  await page.locator('.tab-add').click();
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(page.locator('.find-bar')).toHaveCount(0);
  await expect(page.locator('.footer-zoom-label')).toHaveText('100%');
  await page.locator('.document-tab').first().click();
  await expect(activeTabHost(page).locator('.find-bar')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('.footer-zoom-label')).toHaveText('112%');
  await page.locator('.document-tab').nth(1).click();
  await expect(page.locator('.footer-zoom-label')).toHaveText('100%');
  await page.getByRole('button', { name: 'Suggesting' }).click();
  await activeEditor(page).fill('Second tracked words');
  await expect(activeEditor(page).locator('ins')).toHaveText('Second tracked words');
  await expect(activeTabHost(page).locator('.suggestion-card')).toHaveCount(1);
  await expect(activeTabHost(page).locator('.comment-card')).toHaveCount(0);

  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('First document words');
  await expect(activeTabHost(page).locator('.comment-card')).toContainText('First tab comment');
  await expect(activeTabHost(page).locator('.suggestion-card')).toHaveCount(0);
  await expect(page.locator('.footer-zoom-label')).toHaveText('112%');
  await expect(page.getByRole('button', { name: 'Editing' })).toHaveClass(/on/);

  await page.locator('.document-tab').nth(1).click();
  await expect(activeEditor(page)).toContainText('Second tracked words');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(activeEditor(page)).not.toContainText('Second tracked words');
  await expect(page.getByRole('button', { name: 'Suggesting' })).toHaveClass(/on/);

  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('First document words');
});

test('rail formatting always targets the active mounted editor', async ({ page }) => {
  await setupMemoryTauri(page);
  await activeEditor(page).fill('alpha');

  await page.locator('.tab-add').click();
  await activeEditor(page).fill('beta');
  await selectAll(page);
  await page.locator('.rail-btn.bold').click();
  await expect(activeEditor(page).locator('strong')).toHaveText('beta');

  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toHaveText('alpha');
  await expect(activeEditor(page).locator('strong')).toHaveCount(0);
});

test('switching tabs preserves scroll while the mounted editor is hidden', async ({ page }) => {
  await setupMemoryTauri(page);
  const tallDocument = Array.from(
    { length: 70 },
    (_, index) => `Paragraph ${index} keeps this document tall enough to scroll.`,
  ).join('\n\n');
  await activeEditor(page).fill(tallDocument);
  const firstScroll = activeTabHost(page).locator('.editor-scroll-area');
  await firstScroll.evaluate((element) => {
    element.scrollTop = 640;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => firstScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const preservedScrollTop = await firstScroll.evaluate((element) => element.scrollTop);

  await page.locator('.tab-add').click();
  await activeEditor(page).fill('A short second document');
  await page.locator('.document-tab').first().click();

  await expect
    .poll(() => firstScroll.evaluate((element) => element.scrollTop))
    .toBe(preservedScrollTop);
});

test('Open and deep links add or focus by path without replacing other tabs', async ({ page }) => {
  const firstPath = '/tmp/first.md';
  const secondPath = '/tmp/second.md';
  await setupMemoryTauri(page, {
    openPath: firstPath,
    files: {
      [firstPath]: 'First saved document',
      ['/tmp/first.comments.json']: sidecar(),
      [secondPath]: 'Second saved document',
      ['/tmp/second.comments.json']: sidecar(),
    },
  });

  await openMemoryFile(page);
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(activeEditor(page)).toHaveText('First saved document');

  await page.evaluate((path) => {
    const emit = (window as unknown as { __quillEmit: (event: string, value: string) => void })
      .__quillEmit;
    emit('menu-open-recent', path);
  }, secondPath);
  await expect(activeEditor(page)).toHaveText('Second saved document');
  await expect(page.locator('.document-tab')).toHaveCount(3);

  await page.evaluate((path) => {
    const emit = (window as unknown as { __quillEmit: (event: string, value: string) => void })
      .__quillEmit;
    emit('deep-link-open', path);
  }, firstPath);
  await expect(activeEditor(page)).toHaveText('First saved document');
  await expect(page.locator('.document-tab')).toHaveCount(3);
  await expect(page.locator('.document-tab.active')).toContainText('first.md');
});

test('overflow expands into rows without ever horizontally scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 760 });
  await setupMemoryTauri(page);
  for (let index = 0; index < 9; index++) await page.locator('.tab-add').click();

  const strip = page.locator('.tabstrip');
  const overflow = page.locator('.tab-overflow');
  await expect(overflow).toContainText(/⋯ \d+/);
  const collapsedTop = await activeTabHost(page).evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const collapsedOverflow = await strip.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(collapsedOverflow).toBeLessThanOrEqual(0);

  await overflow.click();
  await expect(strip).toHaveClass(/expanded/);
  await expect(page.locator('.document-tab')).toHaveCount(10);
  await expect(overflow).toHaveAttribute('aria-expanded', 'true');
  const expandedHeight = await strip.evaluate((element) => element.getBoundingClientRect().height);
  const expandedTop = await activeTabHost(page).evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(expandedHeight).toBeGreaterThan(37);
  expect(expandedTop).toBeGreaterThan(collapsedTop);
  const rowTops = await page
    .locator('.document-tab')
    .evaluateAll((tabs) => [...new Set(tabs.map((tab) => tab.getBoundingClientRect().top))]);
  expect(rowTops.length).toBeGreaterThan(1);

  await overflow.click();
  await expect(strip).not.toHaveClass(/expanded/);
  await expect(strip).toHaveCSS('height', '37px');
});

test('closing the last clean tab leaves one fresh Untitled tab', async ({ page }) => {
  await setupMemoryTauri(page);
  await page.locator('.document-tab.active .document-tab-close').click();

  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('Untitled');
  await expect(activeEditor(page)).toHaveText('');
  await expect(page.locator('.crumbs .cur')).toHaveText('Untitled');
});

test('quitting with multiple dirty tabs presents one combined guard', async ({ page }) => {
  await setupMemoryTauri(page);
  await activeEditor(page).fill('Dirty first tab');
  await page.locator('.tab-add').click();
  await activeEditor(page).fill('Dirty second tab');

  await page.evaluate(() => {
    const emit = (window as unknown as { __quillEmit: (event: string, value: null) => void })
      .__quillEmit;
    emit('menu-quit', null);
  });
  const modal = page.locator('.app-modal');
  await expect(modal).toContainText('2 open documents have unsaved changes');
  await expect(modal.getByRole('button', { name: 'Save All' })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Discard All' })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);

  const exitedBeforeDiscard = await page.evaluate(() =>
    (window as unknown as { __quillCalls: Array<{ cmd: string }> }).__quillCalls.some(
      (call) => call.cmd === 'exit_app',
    ),
  );
  expect(exitedBeforeDiscard).toBe(false);

  await page.evaluate(() => {
    const emit = (window as unknown as { __quillEmit: (event: string, value: null) => void })
      .__quillEmit;
    emit('menu-quit', null);
  });
  await modal.getByRole('button', { name: 'Discard All' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __quillCalls: Array<{ cmd: string }> }).__quillCalls.some(
          (call) => call.cmd === 'exit_app',
        ),
      ),
    )
    .toBe(true);
});
