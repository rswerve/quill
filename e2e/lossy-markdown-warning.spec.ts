/**
 * The lossy-construct warning (PRD 3.2): opening a file containing constructs
 * Quill can't round-trip (footnotes, raw HTML) shows a one-time, non-destructive
 * warning BEFORE any edit, so a user can't silently mangle the file on save.
 * detectLossyConstructs has unit coverage; this pins the open -> warning
 * integration through the real app.
 */
import { expect, test } from '@playwright/test';
import {
  activeEditor,
  closeSessionPickerIfOpen,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

test('opening a footnote file warns before editing, non-destructively', async ({ page }) => {
  await setupMemoryTauri(page, {
    files: { '/tmp/lossy.md': 'A claim with a footnote.[^1]\n\n[^1]: The supporting note.' },
    openPath: '/tmp/lossy.md',
  });
  await activeEditor(page).waitFor({ timeout: 5000 });

  // Open directly rather than via openMemoryFile: the warning modal sits atop
  // any session picker, so it must be dismissed before the picker is reachable.
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('KeyO');
  await page.keyboard.up('ControlOrMeta');

  const modal = page.getByRole('dialog', { name: 'Some formatting may not survive' });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await expect(modal).toContainText('footnotes');
  await expect(modal).toContainText('which Quill cannot edit yet');

  // Non-destructive: dismissing leaves the document open with its text intact.
  await modal.getByRole('button', { name: 'OK' }).click();
  await expect(modal).toHaveCount(0);
  await closeSessionPickerIfOpen(page);
  await expect(activeEditor(page)).toContainText('A claim with a footnote');
});

test('a clean Markdown file opens with no warning (negative control)', async ({ page }) => {
  await setupMemoryTauri(page, {
    files: { '/tmp/clean.md': '# Clean doc\n\nJust plain prose, no footnotes or raw HTML.' },
    openPath: '/tmp/clean.md',
  });
  await openMemoryFile(page);

  await expect(page.getByRole('dialog', { name: 'Some formatting may not survive' })).toHaveCount(
    0,
  );
  await expect(activeEditor(page)).toContainText('Just plain prose');
});
