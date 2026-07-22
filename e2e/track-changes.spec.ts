import { test, expect } from './fixtures';
import type { Page, Locator } from '@playwright/test';
import { expectEditorHtml, expectSelectionText } from './helpers/deterministicWaits';
import { activeEditor, selectEditorText } from './helpers/memoryTauri';

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return { editor };
}

async function enableSuggesting(page: Page) {
  const badge = page.getByRole('group', { name: 'Editing mode' });
  await expect(badge.getByRole('button', { name: 'Editing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await badge.getByRole('button', { name: 'Suggesting' }).click();
  await expect(badge.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

// ── Insertion tracking ────────────────────────────────────────────────────────

test('typing in suggesting mode wraps text in tracked_insert mark', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await expectEditorHtml(editor, { contains: ['<ins', 'track-insert'] });
  // Each keystroke produces a separate <ins> node, so check textContent not innerHTML
  const text = await editor.textContent();
  expect(text).toContain('hello');
});

test('typing in normal mode does NOT produce tracked_insert marks', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('hello');
  await expectEditorHtml(editor, { contains: ['hello'], excludes: ['<ins'] });
});

// ── Deletion tracking ─────────────────────────────────────────────────────────

test('deleting text in suggesting mode wraps it in tracked_delete mark', async ({ page }) => {
  const { editor } = await setup(page);

  // Type some text in normal mode so it is committed content
  await editor.click();
  await page.keyboard.type('hello world');

  await enableSuggesting(page);
  await editor.click();

  // Select all and delete
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'hello world');
  await page.keyboard.press('Backspace');
  await expectEditorHtml(editor, { contains: ['<del', 'track-delete'] });
});

test('deleting text in normal mode removes it outright with no tracked mark', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('hello world');

  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'hello world');
  await page.keyboard.press('Backspace');
  await expectEditorHtml(editor, { excludes: ['<del', 'hello world'] });
});

// ── Suggestion cards ──────────────────────────────────────────────────────────

test('suggestion card appears in the margin after typing in suggesting mode', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('suggested text');

  const card = page.locator('[data-suggestion-kind]').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Insertion');
});

test('deletion suggestion card appears after deleting committed text', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('delete me');

  await enableSuggesting(page);
  await editor.click();

  // Select all text and delete
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'delete me');
  await page.keyboard.press('Backspace');

  const card = page.locator('[data-suggestion-kind]').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Deletion');
});

// ── Per-change accept ─────────────────────────────────────────────────────────

test('accepting an insertion removes the tracked mark and keeps the text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('keep me');

  const acceptBtn = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await expect(acceptBtn).toBeVisible();
  await acceptBtn.click();
  await expectEditorHtml(editor, { contains: ['keep me'], excludes: ['<ins'] });
});

test('rejecting an insertion removes the tracked mark and removes the text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('discard me');

  const rejectBtn = page.getByRole('button', { name: 'Reject', exact: true }).first();
  await expect(rejectBtn).toBeVisible();
  await rejectBtn.click();
  await expectEditorHtml(editor, { excludes: ['<ins', 'discard me'] });
});

test('accepting a deletion removes the tracked mark and removes the text', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('remove me');

  await enableSuggesting(page);
  await editor.click();

  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'remove me');
  await page.keyboard.press('Backspace');

  const acceptBtn = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await acceptBtn.click();
  await expectEditorHtml(editor, { excludes: ['<del', 'remove me'] });
});

test('rejecting a deletion removes the tracked mark and restores the text', async ({ page }) => {
  const { editor } = await setup(page);

  await editor.click();
  await page.keyboard.type('restore me');

  await enableSuggesting(page);
  await editor.click();

  // Select the last word "me" only — avoids block-boundary issues from
  // select-all + delete. Set directly: the selection is setup for the Backspace
  // under test, and the old two-arrow loop carried the same latent race.
  await selectEditorText(page, 'me');
  await page.keyboard.press('Backspace');

  const rejectBtn = page.getByRole('button', { name: 'Reject', exact: true }).first();
  await rejectBtn.click();
  await expectEditorHtml(editor, { excludes: ['<del'] });
  // "me" should be restored
  const text = await editor.textContent();
  expect(text).toContain('me');
});

// ── Accept all / Reject all ───────────────────────────────────────────────────

test('Accept All removes all tracked marks and keeps inserted text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('first ');
  await page.keyboard.type('second');

  await page.locator('[title="Accept all suggestions"]').click();
  await expectEditorHtml(editor, { contains: ['first', 'second'], excludes: ['<ins'] });
});

test('Reject All removes all tracked marks and discards inserted text', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('ephemeral');

  await page.locator('[title="Reject all suggestions"]').click();
  await expectEditorHtml(editor, { excludes: ['<ins', 'ephemeral'] });
});

test('Accept All and Reject All buttons only appear when pending changes exist', async ({
  page,
}) => {
  const { editor } = await setup(page);

  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).not.toBeVisible();

  await enableSuggesting(page);
  // Still hidden — Suggesting mode alone doesn't reveal them; pending changes do.
  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();

  await editor.click();
  await page.keyboard.type('hi');
  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).toBeVisible();
});

// ── Mode toggle ───────────────────────────────────────────────────────────────

test('toggling back to editing mode stops tracking new changes', async ({ page }) => {
  const { editor } = await setup(page);

  await enableSuggesting(page);
  // Exit suggesting mode
  await page.getByRole('button', { name: 'Editing' }).click();
  await expect(page.getByRole('button', { name: 'Editing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await editor.click();
  await page.keyboard.type('normal text');
  await expectEditorHtml(editor, { contains: ['normal text'], excludes: ['<ins'] });
});
