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
