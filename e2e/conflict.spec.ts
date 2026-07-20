/**
 * External-conflict detection + resolution (PRD autosave, Phase 3): when the file
 * on disk changes underneath an open document, the next save is stopped and a
 * persistent banner offers Overwrite / Save a Copy / Reload. The fingerprint logic
 * has unit coverage; this pins the open -> external change -> banner -> Overwrite
 * flow through the real app.
 */
import { expect, test } from './fixtures';
import {
  activeEditor,
  closeSessionPickerIfOpen,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

test('an external change surfaces the conflict banner, and Overwrite resolves it', async ({
  page,
}) => {
  await setupMemoryTauri(page, {
    files: { '/tmp/doc.md': 'original on disk' },
    openPath: '/tmp/doc.md',
  });
  await activeEditor(page).waitFor({ timeout: 5000 });
  await openMemoryFile(page);
  await closeSessionPickerIfOpen(page);
  await expect(activeEditor(page)).toContainText('original on disk');

  // Edit the document, then simulate an external process rewriting the file on disk.
  await activeEditor(page).click();
  await page.keyboard.type(' MYEDIT');
  await page.evaluate(() => {
    (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'] =
      'CHANGED EXTERNALLY';
  });

  // Save → the fingerprint no longer matches → the persistent conflict banner.
  await page.keyboard.press('ControlOrMeta+s');
  const overwrite = page.getByRole('button', { name: 'Overwrite' });
  await expect(overwrite).toBeVisible();
  await expect(page.getByText('changed on disk')).toBeVisible();
  // All THREE resolution actions must be within the viewport — a full-width top
  // strip, not a clipped editor child (regression guard for the banner layout).
  await expect(overwrite).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Save a Copy' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeInViewport();

  // Overwrite writes our version (unconditionally) and clears the conflict.
  await overwrite.click();
  await expect(overwrite).toHaveCount(0);
  const onDisk = await page.evaluate(
    () =>
      (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'],
  );
  expect(onDisk).toContain('MYEDIT');
});

test('a conflicted Cmd+S re-announces the banner instead of writing', async ({ page }) => {
  await setupMemoryTauri(page, {
    files: { '/tmp/doc.md': 'original on disk' },
    openPath: '/tmp/doc.md',
  });
  await activeEditor(page).waitFor({ timeout: 5000 });
  await openMemoryFile(page);
  await closeSessionPickerIfOpen(page);

  await activeEditor(page).click();
  await page.keyboard.type(' MYEDIT');
  await page.evaluate(() => {
    (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles['/tmp/doc.md'] =
      'CHANGED EXTERNALLY';
  });
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: 'Overwrite' })).toBeVisible();

  // A second Cmd+S while conflicted must NOT write to the .md path.
  const writesBefore = await page.evaluate(
    () =>
      (
        window as unknown as { __quillCalls: Array<{ cmd: string; args: { path?: string } }> }
      ).__quillCalls.filter((c) => c.cmd === 'write_file_atomic' && c.args.path === '/tmp/doc.md')
        .length,
  );
  await page.keyboard.press('ControlOrMeta+s');
  const writesAfter = await page.evaluate(
    () =>
      (
        window as unknown as { __quillCalls: Array<{ cmd: string; args: { path?: string } }> }
      ).__quillCalls.filter((c) => c.cmd === 'write_file_atomic' && c.args.path === '/tmp/doc.md')
        .length,
  );
  expect(writesAfter).toBe(writesBefore);
  await expect(page.getByRole('button', { name: 'Overwrite' })).toBeVisible(); // still conflicted
});
