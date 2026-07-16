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
    trustedSidecarPaths: [firstPath, secondPath],
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
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toHaveCount(0);
});

test('an edit made while Save is pending is rescued onto the file by a fresh pass', async ({
  page,
}) => {
  const path = '/tmp/save-race.md';
  await setupMemoryTauri(page, {
    openPath: path,
    deferFirstWriteFile: true,
    files: {
      [path]: 'Last saved content',
      ['/tmp/save-race.comments.json']: linkedSidecar,
    },
    trustedSidecarPaths: [path],
  });
  await openMemoryFile(page);
  await page.locator('.document-tab').first().click();
  await page.locator('.document-tab.active .document-tab-close').click();
  await activeEditor(page).fill('Snapshot captured when Save started');

  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(
    () => (window as unknown as { __quillWriteFileBlocked: boolean }).__quillWriteFileBlocked,
  );
  await activeEditor(page).fill('Newer content while Save was pending');
  // An open-set revision forces an immediate aggregate snapshot while the
  // original file write is still blocked.
  await page.locator('.tab-add').click();
  await page.locator('.document-tab').first().click();
  await expect
    .poll(async () => {
      const workspace = (await persistedWorkspace(page)) as {
        tabs: Array<{
          filePath: string | null;
          dirty: boolean;
          snapshot?: { content?: string };
        }>;
      };
      return workspace.tabs.find((tab) => tab.filePath === path);
    })
    .toMatchObject({
      dirty: true,
      snapshot: { content: 'Newer content while Save was pending' },
    });

  await page.evaluate(() => {
    (window as unknown as { __quillReleaseWriteFile: () => void }).__quillReleaseWriteFile();
  });

  // The coordinator's fresh pass rescues the mid-save edit ONTO the real file: the
  // deferred original write lands first, then exactly one fresh pass carrying the
  // newer content — two atomic writes to the .md, no more (sidecar writes excluded).
  await expect
    .poll(() =>
      page.evaluate((docPath) => {
        const calls = (
          window as unknown as {
            __quillCalls: Array<{ cmd: string; args: { path?: string } }>;
          }
        ).__quillCalls;
        return calls.filter((c) => c.cmd === 'write_file_atomic' && c.args.path === docPath).length;
      }, path),
    )
    .toBe(2);

  // The newer content is what actually reached disk — the edit was not lost.
  expect(
    await page.evaluate(
      (docPath) =>
        (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles[docPath],
      path,
    ),
  ).toBe('Newer content while Save was pending');

  // Everything is saved, so the tab settles clean in the recovery snapshot.
  await expect
    .poll(async () => {
      const workspace = (await persistedWorkspace(page)) as {
        tabs: Array<{ filePath: string | null; dirty: boolean }>;
      };
      return workspace.tabs.find((tab) => tab.filePath === path);
    })
    .toMatchObject({ dirty: false });
});

test('an edit during a Save As write is rescued onto the NEW path, never the old', async ({
  page,
}) => {
  // Save As from Untitled with the doc write deferred; edit during the blocked
  // write; on release the fresh pass must target the newly-chosen path (read from
  // the synchronous filePathRef, before React commits Save As's setState), never a
  // stale/old path.
  const savePath = '/tmp/renamed.md';
  await setupMemoryTauri(page, { savePath, deferFirstWriteFile: true });

  await activeEditor(page).click();
  await page.keyboard.type('first draft');

  // Cmd+Shift+S — Save As. The doc write to savePath is the first write, so it blocks.
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Shift');
  await page.keyboard.up('ControlOrMeta');
  await page.waitForFunction(
    () => (window as unknown as { __quillWriteFileBlocked: boolean }).__quillWriteFileBlocked,
  );

  // Edit while the Save As write is still blocked.
  await activeEditor(page).fill('edited during save');

  await page.evaluate(() => {
    (window as unknown as { __quillReleaseWriteFile: () => void }).__quillReleaseWriteFile();
  });

  // The fresh pass rescued the edit onto the NEW path.
  await expect
    .poll(() =>
      page.evaluate(
        (docPath) =>
          (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles[docPath],
        savePath,
      ),
    )
    .toBe('edited during save');

  // No document write ever targeted a path other than savePath (no stale/old target).
  const strayTarget = await page.evaluate((docPath) => {
    const calls = (
      window as unknown as { __quillCalls: Array<{ cmd: string; args: { path?: string } }> }
    ).__quillCalls;
    return calls.some(
      (c) =>
        c.cmd === 'write_file_atomic' &&
        c.args.path !== docPath &&
        !(c.args.path ?? '').endsWith('.comments.json'),
    );
  }, savePath);
  expect(strayTarget).toBe(false);
});

test('one recovery decision atomically restores every dirty tab and its annotations', async ({
  page,
}) => {
  await setupMemoryTauri(page);
  await activeEditor(page).fill('First dirty document');
  await selectAll(page);
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  await page.locator('[data-card-id="comment-composer"] textarea').fill('Recovered comment');
  await page.getByRole('button', { name: 'Add note' }).click();

  await page.locator('.tab-add').click();
  await page.getByRole('button', { name: 'Suggesting' }).click();
  await activeEditor(page).fill('Second dirty suggestion');
  await waitForDirtyTabCount(page, 2);

  await page.reload();
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved workspace?' });
  await expect(recovery).toContainText('Restore 2 unsaved documents');
  await expect(recovery).toHaveCount(1);
  await recovery.getByRole('button', { name: 'Recover' }).click();

  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(activeEditor(page)).toContainText('Second dirty suggestion');
  await expect(activeTabHost(page).locator('[data-suggestion-kind]')).toHaveCount(1);
  await page.locator('.document-tab').first().click();
  await expect(activeEditor(page)).toContainText('First dirty document');
  await expect(activeTabHost(page).locator('[data-comment-card]')).toContainText(
    'Recovered comment',
  );
  await expect(
    page.locator('[aria-label="Document location"] [aria-label="Unsaved"]'),
  ).toBeVisible();
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
    trustedSidecarPaths: [savedPath],
  });
  await openMemoryFile(page);
  await page.locator('.document-tab').first().click();
  await page.locator('.document-tab.active .document-tab-close').click();
  await activeEditor(page).fill('Unsaved edit in the saved tab');
  await page.locator('.tab-add').click();
  await activeEditor(page).fill('Throw this away');
  await waitForDirtyTabCount(page, 2);

  await page.reload();
  await page
    .getByRole('dialog', { name: 'Recover unsaved workspace?' })
    .getByRole('button', { name: 'Discard' })
    .click();

  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('saved-after-discard.md');
  await expect(activeEditor(page)).toHaveText('Last saved content on disk');
  await expect(activeEditor(page)).not.toContainText('Unsaved edit in the saved tab');
  await expect(activeEditor(page)).not.toContainText('Throw this away');
});

for (const [label, workspace] of [
  ['malformed JSON', '{ not valid JSON'],
  [
    'an unsupported version',
    JSON.stringify({ version: 99, savedAt: '2026-07-13T05:00:00.000Z', tabs: [] }),
  ],
] as const) {
  test(`${label} is preserved and never overwritten before recovery is acknowledged`, async ({
    page,
  }) => {
    await setupMemoryTauri(page, { workspace });

    const recovery = page.getByRole('dialog', { name: 'Workspace recovery could not be read' });
    await expect(recovery).toContainText('Workspace recovery could not be read');
    const stateBeforeAcknowledgement = await page.evaluate(() => ({
      raw: sessionStorage.getItem('__quill_test_workspace'),
      writes: (window as unknown as { __quillCalls: Array<{ cmd: string }> }).__quillCalls.filter(
        (call) => call.cmd === 'write_draft',
      ).length,
    }));
    expect(stateBeforeAcknowledgement).toEqual({ raw: workspace, writes: 0 });

    await recovery.getByRole('button', { name: 'Preserve & Continue' }).click();
    await expect(recovery).toHaveCount(0);
    const stateAfterAcknowledgement = await page.evaluate(() => ({
      quarantined: sessionStorage.getItem('__quill_test_quarantined_workspace'),
      quarantineCalls: (
        window as unknown as { __quillCalls: Array<{ cmd: string }> }
      ).__quillCalls.filter((call) => call.cmd === 'quarantine_draft').length,
    }));
    expect(stateAfterAcknowledgement).toEqual({ quarantined: workspace, quarantineCalls: 1 });
  });
}

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

  await expect(page.getByRole('dialog', { name: 'Recover unsaved workspace?' })).toContainText(
    'Restore 1 unsaved document',
  );
  await page
    .getByRole('dialog', { name: 'Recover unsaved workspace?' })
    .getByRole('button', { name: 'Recover' })
    .click();
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(activeEditor(page)).toHaveText('Legacy unsaved document');
  await expect(
    page.locator('[aria-label="Document location"] [aria-label="Unsaved"]'),
  ).toBeVisible();
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
    trustedSidecarPaths: [existingPath],
  });

  await expect(page.getByRole('dialog', { name: 'Could not open file' })).toContainText(
    'Could not open file',
  );
  await page
    .getByRole('dialog', { name: 'Could not open file' })
    .getByRole('button', { name: 'OK' })
    .click();
  await expect(page.locator('.document-tab')).toHaveCount(1);
  await expect(page.locator('.document-tab.active')).toContainText('still-here.md');
  await expect(activeEditor(page)).toHaveText('The remaining clean file');
});
