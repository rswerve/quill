/**
 * Autosave (PRD autosave, Phase 4): a saved document's edits are written to disk in the
 * background — debounced after a pause, flushed immediately when focus leaves — while a
 * clean document is never written. The scheduler/coordinator seam is unit-covered; this
 * pins the enabled behavior through the real app + the atomic-write IPC.
 */
import { expect, test } from '@playwright/test';
import {
  activeEditor,
  closeSessionPickerIfOpen,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

/** How many atomic writes have targeted a given path so far. */
function writeCount(page: import('@playwright/test').Page, path: string): Promise<number> {
  return page.evaluate(
    (p) =>
      (
        window as unknown as { __quillCalls: Array<{ cmd: string; args: { path?: string } }> }
      ).__quillCalls.filter((call) => call.cmd === 'write_file_atomic' && call.args.path === p)
        .length,
    path,
  );
}

async function openSavedDoc(page: import('@playwright/test').Page, contents: string) {
  await setupMemoryTauri(page, { files: { '/tmp/doc.md': contents }, openPath: '/tmp/doc.md' });
  await activeEditor(page).waitFor({ timeout: 5000 });
  await openMemoryFile(page);
  await closeSessionPickerIfOpen(page);
  await expect(activeEditor(page)).toContainText(contents);
}

test('a clean saved document is never autosaved, even on blur', async ({ page }) => {
  await openSavedDoc(page, 'clean content');
  const before = await writeCount(page, '/tmp/doc.md');

  // Blur: with no edit there is no armed debounce and the flush's eligibility gate
  // (isDirty === false) breaks before any write. Settle the flush's microtasks, then
  // assert it stayed a zero-write no-op.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  expect(await writeCount(page, '/tmp/doc.md')).toBe(before);
});

test('editing a saved document autosaves it after the idle debounce', async ({ page }) => {
  await openSavedDoc(page, 'original');
  const before = await writeCount(page, '/tmp/doc.md');

  await activeEditor(page).click();
  await page.keyboard.type(' AUTOSAVED');

  // The 2s idle debounce elapses → a background write lands without any manual save.
  await expect
    .poll(() => writeCount(page, '/tmp/doc.md'), { timeout: 6000 })
    .toBeGreaterThan(before);
  const onDisk = await page.evaluate(
    () =>
      (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'],
  );
  expect(onDisk).toContain('AUTOSAVED');
});

test('blurring after an edit flushes the autosave without waiting the full debounce', async ({
  page,
}) => {
  await openSavedDoc(page, 'original');
  await activeEditor(page).click();
  await page.keyboard.type(' FLUSHED');
  const before = await writeCount(page, '/tmp/doc.md');

  // Blur flushes immediately — the write must land well inside the 2s idle window.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect
    .poll(() => writeCount(page, '/tmp/doc.md'), { timeout: 1500 })
    .toBeGreaterThan(before);
  const onDisk = await page.evaluate(
    () =>
      (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'],
  );
  expect(onDisk).toContain('FLUSHED');
});

test('closing a saved tab within the debounce autosaves it instead of prompting', async ({
  page,
}) => {
  await openSavedDoc(page, 'original');
  await activeEditor(page).click();
  await page.keyboard.type(' CLOSED EDIT');
  const before = await writeCount(page, '/tmp/doc.md');

  // Close the active (saved, dirty) tab immediately, inside the 2s debounce. The close
  // flushes first, so it autosaves and closes WITHOUT the unsaved-changes prompt.
  await page.locator('.document-tab.active .document-tab-close').click();
  await expect
    .poll(() => writeCount(page, '/tmp/doc.md'), { timeout: 2000 })
    .toBeGreaterThan(before);
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0);
  const onDisk = await page.evaluate(
    () =>
      (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'],
  );
  expect(onDisk).toContain('CLOSED EDIT');
});

test('closing a saved tab whose flush conflicts still prompts to save', async ({ page }) => {
  await openSavedDoc(page, 'original');
  await activeEditor(page).click();
  await page.keyboard.type(' edit');
  // The file changed on disk, so the close flush hits a conflict — the tab can't be
  // auto-persisted and must stay guarded, not silently closed.
  await page.evaluate(() => {
    (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'] =
      'CHANGED EXTERNALLY';
  });
  await page.locator('.document-tab.active .document-tab-close').click();
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible();
});

function writeFileBlocked(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __quillWriteFileBlocked?: boolean }).__quillWriteFileBlocked === true,
  );
}

test('a recovered dirty saved draft autosaves after recovery, with no fresh edit', async ({
  page,
}) => {
  // Hold the first document write so the edit stays dirty in the recovery envelope
  // (never reaching disk) across the reload — a saved draft that crashed mid-debounce.
  await setupMemoryTauri(page, {
    deferFirstWriteFile: true,
    openPath: '/tmp/recovered.md',
    files: { '/tmp/recovered.md': 'disk bytes' },
  });
  await openMemoryFile(page);
  await page.locator('.document-tab').first().click();
  await page.locator('.document-tab.active .document-tab-close').click();
  await activeEditor(page).click();
  await page.keyboard.type(' UNSAVED');
  await expect.poll(() => writeFileBlocked(page), { timeout: 6000 }).toBe(true);

  // Relaunch with the edit still only in the workspace snapshot, and Recover it.
  await page.reload();
  await page
    .getByRole('dialog', { name: 'Recover unsaved workspace?' })
    .getByRole('button', { name: 'Recover' })
    .click();
  await expect(page.locator('.document-tab.active')).toContainText('recovered.md');

  // Without any new edit, the recovered dirty saved draft ARMS autosave and its write
  // fires (blocked again by the harness) — proving recovered work is not left unsaved
  // until the user happens to type.
  await expect.poll(() => writeFileBlocked(page), { timeout: 6000 }).toBe(true);
});

test('a background tab whose autosave fails stays visibly flagged, with no modal', async ({
  page,
}) => {
  // Injected write failure for this path: every save to it throws.
  await setupMemoryTauri(page, {
    files: { '/tmp/failing.md': 'original' },
    openPath: '/tmp/failing.md',
    failWritePaths: ['/tmp/failing.md'],
  });
  await openMemoryFile(page);
  await expect(page.locator('.document-tab.active')).toContainText('failing', { timeout: 3000 });
  await activeEditor(page).click();
  await page.keyboard.type(' EDIT');

  // Switch away → the now-background failing tab deactivate-flushes → the write throws →
  // autosave fails. The failure must be VISIBLE on the background tab (spec: a background
  // failure is never silent) and must NOT pop a modal (autosave stays quiet).
  await page.locator('.tab-add').click();
  await expect(
    page
      .locator('.document-tab', { hasText: 'failing.md' })
      .locator('[aria-label="Autosave failed"]'),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Could not save file' })).toHaveCount(0);
});
