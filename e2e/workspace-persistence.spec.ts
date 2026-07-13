import { expect, test, type Page } from '@playwright/test';
import { ipcFixtures } from './helpers/ipcFixtures';
import {
  activeEditor,
  activeTabHost,
  closeSessionPickerIfOpen,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

async function persistedWorkspace(page: Page) {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('__quill_test_workspace');
    return raw ? (JSON.parse(raw) as unknown) : null;
  });
}

async function waitForDirtyTabCount(page: Page, count: number) {
  await expect
    .poll(async () => {
      const workspace = (await persistedWorkspace(page)) as {
        tabs?: Array<{ dirty?: boolean }>;
      } | null;
      return workspace?.tabs?.filter((tab) => tab.dirty).length ?? 0;
    })
    .toBe(count);
}

async function selectAll(page: Page) {
  await activeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
}

const linkedSidecar = JSON.stringify({
  version: 2,
  comments: [],
  suggestions: [],
  aiSession: ipcFixtures.autoBindSession,
});

test('normal relaunch restores clean tab order and active tab, reloading files from disk', async ({
  page,
}) => {
  const firstPath = '/tmp/workspace-first.md';
  const secondPath = '/tmp/workspace-second.md';
  await setupMemoryTauri(page, {
    openPath: firstPath,
    files: {
      [firstPath]: 'First version from disk',
      [secondPath]: 'Second version from disk',
      ['/tmp/workspace-first.comments.json']: linkedSidecar,
      ['/tmp/workspace-second.comments.json']: linkedSidecar,
    },
  });

  await openMemoryFile(page);
  await page.locator('.document-tab').first().click();
  await page.locator('.document-tab.active .document-tab-close').click();
  await page.evaluate((path) => {
    const emit = (window as unknown as { __quillEmit: (event: string, path: string) => void })
      .__quillEmit;
    emit('deep-link-open', path);
  }, secondPath);
  await expect(activeEditor(page)).toHaveText('Second version from disk');
  await closeSessionPickerIfOpen(page);
  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toHaveText('First version from disk');

  await expect
    .poll(async () => {
      const workspace = (await persistedWorkspace(page)) as {
        activeTabId?: string;
        tabs?: Array<{ tabId: string; filePath: string; snapshot?: unknown }>;
      } | null;
      const active = workspace?.tabs?.find((tab) => tab.tabId === workspace.activeTabId);
      return {
        paths: workspace?.tabs?.map((tab) => tab.filePath),
        activePath: active?.filePath,
        snapshots: workspace?.tabs?.filter((tab) => tab.snapshot !== undefined).length,
      };
    })
    .toEqual({ paths: [firstPath, secondPath], activePath: firstPath, snapshots: 0 });

  await page.evaluate(
    ({ path, content }) => {
      (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles[path] = content;
    },
    { path: firstPath, content: 'Updated externally before relaunch' },
  );
  await page.reload();
  await activeEditor(page).waitFor();

  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(page.locator('.document-tab').nth(0)).toContainText('workspace-first.md');
  await expect(page.locator('.document-tab').nth(1)).toContainText('workspace-second.md');
  await expect(page.locator('.document-tab.active')).toContainText('workspace-first.md');
  await expect(activeEditor(page)).toHaveText('Updated externally before relaunch');
  await expect(page.locator('.session-picker')).toHaveCount(0);
});

test('one recovery decision atomically restores every dirty tab and its annotations', async ({
  page,
}) => {
  await setupMemoryTauri(page);
  await activeEditor(page).fill('First dirty document');
  await selectAll(page);
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill('Recovered comment');
  await page.locator('.add-comment-compose .btn-primary').click();

  await page.locator('.tab-add').click();
  await page.getByRole('button', { name: 'Suggesting' }).click();
  await activeEditor(page).fill('Second dirty suggestion');
  await waitForDirtyTabCount(page, 2);

  await page.reload();
  const recovery = page.locator('.app-modal');
  await expect(recovery).toContainText('Restore 2 unsaved documents');
  await expect(recovery).toHaveCount(1);
  await recovery.getByRole('button', { name: 'Recover' }).click();

  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(activeEditor(page)).toContainText('Second dirty suggestion');
  await expect(activeTabHost(page).locator('.suggestion-card')).toHaveCount(1);
  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('First dirty document');
  await expect(activeTabHost(page).locator('.comment-card')).toContainText('Recovered comment');
  await expect(page.locator('.dirty-dot')).toBeVisible();
});

test('Discard reopens dirty saved tabs from disk and drops only dirty Untitled tabs', async ({
  page,
}) => {
  const savedPath = '/tmp/saved-after-discard.md';
  await setupMemoryTauri(page, {
    openPath: savedPath,
    files: {
      [savedPath]: 'Last saved content on disk',
      ['/tmp/saved-after-discard.comments.json']: linkedSidecar,
    },
  });
  await openMemoryFile(page);
  await page.locator('.document-tab').first().click();
  await page.locator('.document-tab.active .document-tab-close').click();
  await activeEditor(page).fill('Unsaved edit in the saved tab');
  await page.locator('.tab-add').click();
  await activeEditor(page).fill('Throw this away');
  await waitForDirtyTabCount(page, 2);

  await page.reload();
  await page.locator('.app-modal').getByRole('button', { name: 'Discard' }).click();

  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('saved-after-discard.md');
  await expect(activeEditor(page)).toHaveText('Last saved content on disk');
  await expect(activeEditor(page)).not.toContainText('Unsaved edit in the saved tab');
  await expect(activeEditor(page)).not.toContainText('Throw this away');
});

test('legacy draft.json payload migrates into a one-tab workspace recovery', async ({ page }) => {
  const legacyDraft = {
    version: 1,
    savedAt: '2026-07-13T04:30:00.000Z',
    filePath: null,
    content: 'Legacy unsaved document',
    comments: [],
    suggestions: [],
    aiSession: null,
    contextFolder: null,
  };
  await setupMemoryTauri(page, { workspace: JSON.stringify(legacyDraft) });

  await expect(page.locator('.app-modal')).toContainText('Restore 1 unsaved document');
  await page.locator('.app-modal').getByRole('button', { name: 'Recover' }).click();
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(activeEditor(page)).toHaveText('Legacy unsaved document');
  await expect(page.locator('.dirty-dot')).toBeVisible();
});

test('a missing clean file is dropped without breaking the rest of the restored workspace', async ({
  page,
}) => {
  const existingPath = '/tmp/still-here.md';
  const workspace = {
    version: 1,
    savedAt: '2026-07-13T05:00:00.000Z',
    activeTabId: 'missing',
    tabs: [
      { tabId: 'missing', filePath: '/tmp/moved-away.md', dirty: false },
      { tabId: 'existing', filePath: existingPath, dirty: false },
    ],
  };
  await setupMemoryTauri(page, {
    workspace: JSON.stringify(workspace),
    files: {
      [existingPath]: 'The remaining clean file',
      ['/tmp/still-here.comments.json']: linkedSidecar,
    },
  });

  await expect(page.locator('.app-modal')).toContainText('Could not open file');
  await page.locator('.app-modal').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('still-here.md');
  await expect(activeEditor(page)).toHaveText('The remaining clean file');
});
