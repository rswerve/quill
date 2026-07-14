/**
 * Comprehensive feature test suite for Quill.
 *
 * Each test runs in its own page via Playwright's `page` fixture; the dev
 * server is started automatically by playwright.config.ts (webServer).
 *
 * Known-broken tests use `test.fixme(...)` so the suite is green on first
 * pass. Goal mode should convert each `.fixme` to a passing `test(...)`.
 */
import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import {
  expectEditorHtml,
  expectPageTitleToContain,
  expectSelectionText,
} from './helpers/deterministicWaits';

// ── helpers ───────────────────────────────────────────────────────────────────

async function setup(page: Page): Promise<{ editor: Locator }> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return { editor };
}

async function enableSuggesting(page: Page) {
  const sw = page.locator('.mode-switch');
  await expect(sw.getByRole('button', { name: 'Editing' })).toHaveAttribute('aria-pressed', 'true');
  await sw.getByRole('button', { name: 'Suggesting' }).click();
  await expect(sw.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

async function disableSuggesting(page: Page) {
  const sw = page.locator('.mode-switch');
  await expect(sw.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await sw.getByRole('button', { name: 'Editing' }).click();
  await expect(sw.getByRole('button', { name: 'Editing' })).toHaveAttribute('aria-pressed', 'true');
}

async function selectAll(page: Page) {
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page);
}

async function selectLastNChars(page: Page, n: number) {
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await expectSelectionText(page);
}

async function addCommentViaPlusButton(page: Page, replyText: string) {
  // The floating "+" button only appears while a selection is active.
  const btn = page.locator('.add-comment-btn');
  await btn.click();
  const textarea = page.locator('.add-comment-compose textarea');
  await textarea.fill(replyText);
  await page.locator('.add-comment-compose .btn-primary').click();
  await expect(page.locator('.add-comment-compose')).toHaveCount(0);
}

async function setZoom(page: Page, zoom: number) {
  await page.locator('.footer-zoom-slider').fill(String(zoom));
  await expect(page.locator('.footer-zoom-label')).toHaveText(`${Math.round(zoom * 100)}%`);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Basic typing & text content
// ────────────────────────────────────────────────────────────────────────────

test('blank document and comments panel show restrained Studio empty states', async ({ page }) => {
  const { editor } = await setup(page);

  const documentEmpty = page.locator('.editor-empty-state');
  await expect(documentEmpty.locator('.editor-empty-title')).toHaveText('Untitled');
  await expect(documentEmpty).toContainText('Start writing… select text to comment');
  await expect(documentEmpty.locator('kbd')).toHaveText('⌘/');

  const commentsEmpty = page.locator('.comments-empty-state');
  await expect(commentsEmpty).toBeVisible();
  await expect(commentsEmpty).toContainText('No comments yet');
  await expect(commentsEmpty).toContainText('Select text and press +, or type @claude.');

  // The empty prompt is chrome, not editor content or saved Markdown.
  await expect(editor).not.toContainText('Untitled');
  await page.keyboard.type('First word');
  await expect(documentEmpty).toHaveCount(0);
});

test('Cmd+/ opens document chat and focuses its composer', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.getByLabel('Ask Claude about this document')).toBeFocused();
});

test('the empty-document Claude hint opens document chat', async ({ page }) => {
  await setup(page);
  await page.locator('.editor-empty-chat').click();
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.getByLabel('Ask Claude about this document')).toBeFocused();
});

test('editor mounts and is focusable', async ({ page }) => {
  const { editor } = await setup(page);
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
});

test('typing inserts text in normal mode', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await expect(editor).toContainText('hello world');
});

test('Enter creates a new paragraph', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  await expect(editor.locator('p')).toHaveCount(2);
});

test('backspace deletes characters in normal mode', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(editor).toContainText('hel');
  await expect(editor).not.toContainText('hello');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Toolbar formatting (normal mode)
// ────────────────────────────────────────────────────────────────────────────

test('bold via toolbar wraps selected text in <strong>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await expect(editor.locator('strong')).toHaveText('hello world');
});

test('italic via toolbar wraps selected text in <em>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Italic (Cmd+I)"]').click();
  await expect(editor.locator('em')).toHaveText('hello world');
});

test('underline is unavailable in Markdown editing', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await expect(page.locator('[title="Underline (Cmd+U)"]')).toHaveCount(0);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('u');
  await page.keyboard.up('ControlOrMeta');
  await expect(editor.locator('u')).toHaveCount(0);
});

test('strikethrough via toolbar wraps selected text in <s>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Strikethrough"]').click();
  await expect(editor.locator('s, strike, del')).toHaveText('hello world');
});

test('Cmd+B keyboard shortcut applies bold', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('b');
  await page.keyboard.up('ControlOrMeta');
  await expect(editor.locator('strong')).toHaveText('hello');
});

test('Cmd+I keyboard shortcut applies italic', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('i');
  await page.keyboard.up('ControlOrMeta');
  await expect(editor.locator('em')).toHaveText('hello');
});

test('bold on partial selection only formats that range', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectLastNChars(page, 5);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await expect(editor.locator('strong')).toHaveText('world');
});

test('toggling bold twice removes the bold mark', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await page.locator('[title="Bold (Cmd+B)"]').click();
  await expect(editor.locator('strong')).toHaveCount(0);
});

test('toolbar button does not lose selection (regression)', async ({ page }) => {
  // Known broken: clicking bold/italic with text selected drops the selection,
  // so subsequent toolbar clicks operate on a collapsed cursor.
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('[title="Bold (Cmd+B)"]').click();
  // After bold, selection should still cover all 11 chars.
  await expectSelectionText(page, 'hello world');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Headings
// ────────────────────────────────────────────────────────────────────────────

test('H1 toolbar button converts paragraph to <h1>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('title');
  await page.locator('[title="Heading 1"]').click();
  await expect(editor.locator('h1')).toContainText('title');
});

test('H2 toolbar button converts paragraph to <h2>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('subtitle');
  await page.locator('[title="Heading 2"]').click();
  await expect(editor.locator('h2')).toContainText('subtitle');
});

test('H3 toolbar button converts paragraph to <h3>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('sub-sub');
  await page.locator('[title="Heading 3"]').click();
  await expect(editor.locator('h3')).toContainText('sub-sub');
});

test('toggling H1 back to paragraph', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('title');
  await page.locator('[title="Heading 1"]').click();
  await page.locator('[title="Heading 1"]').click();
  await expect(editor.locator('h1')).toHaveCount(0);
  await expect(editor.locator('p')).toContainText('title');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Lists & blockquote & inline code
// ────────────────────────────────────────────────────────────────────────────

test('bullet list toolbar wraps lines in <ul><li>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('item one');
  await page.locator('[title="Bullet list"]').click();
  await expect(editor.locator('ul li')).toContainText('item one');
});

test('numbered list toolbar wraps lines in <ol><li>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('item one');
  await page.locator('[title="Numbered list"]').click();
  await expect(editor.locator('ol li')).toContainText('item one');
});

test('pressing Enter inside a list creates a new list item', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('one');
  await page.locator('[title="Bullet list"]').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await expect(editor.locator('ul li')).toHaveCount(2);
});

test('blockquote toolbar wraps paragraph in <blockquote>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('a quote');
  await page.locator('[title="Blockquote"]').click();
  await expect(editor.locator('blockquote')).toContainText('a quote');
});

test('inline code toolbar wraps selection in <code>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('foo bar');
  await selectAll(page);
  await page.locator('[title="Inline code"]').click();
  await expect(editor.locator('code')).toHaveText('foo bar');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Undo / Redo
// ────────────────────────────────────────────────────────────────────────────

test('undo via toolbar reverts the last edit', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.locator('[title="Undo (Cmd+Z)"]').click();
  await expect(editor).not.toContainText('hello');
});

test('redo via toolbar restores an undone edit', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.locator('[title="Undo (Cmd+Z)"]').click();
  await page.locator('[title="Redo (Cmd+Shift+Z)"]').click();
  await expect(editor).toContainText('hello');
});

test('Cmd+Z keyboard shortcut undoes', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('z');
  await page.keyboard.up('ControlOrMeta');
  await expect(editor).not.toContainText('hello');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Mode toggle (Editing ↔ Suggesting)
// ────────────────────────────────────────────────────────────────────────────

test('switch shows "Editing" by default', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.mode-switch')).toContainText('Editing');
});

test('clicking switch toggles to Suggesting mode', async ({ page }) => {
  await setup(page);
  await enableSuggesting(page);
  await expect(page.locator('.mode-switch')).toContainText('Suggesting');
});

test('clicking switch again toggles back to Editing', async ({ page }) => {
  await setup(page);
  await enableSuggesting(page);
  await disableSuggesting(page);
  await expect(page.locator('.mode-switch')).toContainText('Editing');
});

test('Accept All / Reject All buttons appear only when pending changes exist', async ({ page }) => {
  const { editor } = await setup(page);
  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await enableSuggesting(page);
  // Still hidden — no pending changes yet, even in Suggesting mode.
  await expect(page.locator('[title="Accept all suggestions"]')).not.toBeVisible();
  await editor.click();
  await page.keyboard.type('hi');
  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
  await expect(page.locator('[title="Reject all suggestions"]')).toBeVisible();
  // And they persist when we drop out of Suggesting mode.
  await disableSuggesting(page);
  await expect(page.locator('[title="Accept all suggestions"]')).toBeVisible();
});

test('suggestion cards persist after exiting Suggesting mode', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
  await disableSuggesting(page);
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('topbar segmented control shows Suggesting while in suggesting mode', async ({ page }) => {
  await setup(page);
  await enableSuggesting(page);
  await expect(page.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Track changes: insertion
// ────────────────────────────────────────────────────────────────────────────

test('typing in suggesting mode produces <ins> marks', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await expectEditorHtml(editor, { contains: ['<ins', 'track-insert'] });
  await expect(editor).toContainText('hello');
});

test('typing 5 chars in suggesting mode produces ONE suggestion card (not five)', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('suggestion card text matches the inserted text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  const card = page.locator('.suggestion-card').first();
  await expect(card).toContainText('hello');
  // And no garbled repetition like 'hheelllllllooooo'
  const cardText = await card.textContent();
  expect(cardText).not.toMatch(/hh+|ee+|ll+l|oo+o/);
});

test('typing slowly produces ONE suggestion card per logical insertion', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-07-13T12:00:00Z') });
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  for (const ch of 'hello') {
    await page.keyboard.type(ch);
    await page.clock.runFor(80);
  }
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('insertion card shows "Insertion" badge', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hi');
  await expect(page.locator('.suggestion-card').first()).toContainText('Insertion');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Track changes: deletion
// ────────────────────────────────────────────────────────────────────────────

test('selecting and backspacing committed text in suggesting mode produces <del>', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await enableSuggesting(page);
  await editor.click();
  await selectAll(page);
  await page.keyboard.press('Backspace');
  await expectEditorHtml(editor, { contains: ['<del', 'track-delete'] });
});

test('deletion card shows "Deletion" badge with the deleted text', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('delete me');
  await enableSuggesting(page);
  await editor.click();
  await selectAll(page);
  await page.keyboard.press('Backspace');
  const card = page.locator('.suggestion-card').first();
  await expect(card).toContainText('Deletion');
  await expect(card).toContainText('delete me');
});

test('progressive backspace: 5 backspaces delete 5 chars', async ({ page }) => {
  // Known broken: only the last backspace gets tracked. Cursor stays on the
  // already-marked char so consecutive backspaces re-target the same position.
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Backspace');
  }
  const card = page.locator('.suggestion-card').first();
  // Expect "world" to be the marked deletion
  await expect(card).toContainText('world');
});

test('progressive backspace produces ONE deletion card, not five', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Backspace');
  }
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('deleting a pending insertion just removes it (no separate delete mark)', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  // No deletion mark — the user is deleting their own pending insertion
  await expectEditorHtml(editor, { excludes: ['<del'] });
  // And only an insertion card should remain (text "hel")
  await expect(page.locator('.suggestion-card').first()).toContainText('hel');
});

test('repeated letters: backspacing through "aaa" deletes all three', async ({ page }) => {
  // Regression: previously the third backspace was a no-op because the cursor
  // landed at position 0 (outside the paragraph) after the second one.
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('aaa');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  // All inserted 'a's should be gone; no leftover <ins>
  await expectEditorHtml(editor, { excludes: ['<ins', '>a<'] });
});

test('repeated letters in committed text: backspacing "book" produces tracked deletes', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('book');
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  const card = page.locator('.suggestion-card').first();
  // All three backspaces should be tracked — last three chars of "book" deleted
  await expect(card).toContainText('ook');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Accept / Reject individual changes
// ────────────────────────────────────────────────────────────────────────────

test('accepting an insertion keeps the text and removes the <ins> mark', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('keep me');
  await page.locator('.suggestion-accept-btn').first().click();
  await expectEditorHtml(editor, { excludes: ['<ins'] });
  await expect(editor).toContainText('keep me');
});

test('rejecting an insertion removes the text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('discard me');
  await page.locator('.suggestion-reject-btn').first().click();
  await expect(editor).not.toContainText('discard me');
  await expectEditorHtml(editor, { excludes: ['<ins'] });
});

test('accepting a deletion removes the text', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('remove me');
  await enableSuggesting(page);
  await editor.click();
  await selectAll(page);
  await page.keyboard.press('Backspace');
  await page.locator('.suggestion-accept-btn').first().click();
  await expect(editor).not.toContainText('remove me');
  await expectEditorHtml(editor, { excludes: ['<del'] });
});

test('rejecting a deletion restores the text without the <del> mark', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('restore me');
  await enableSuggesting(page);
  await editor.click();
  await selectLastNChars(page, 2);
  await page.keyboard.press('Backspace');
  await page.locator('.suggestion-reject-btn').first().click();
  await expect(editor).toContainText('me');
  await expectEditorHtml(editor, { excludes: ['<del'] });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Accept All / Reject All
// ────────────────────────────────────────────────────────────────────────────

test('Accept All removes all <ins> marks and keeps inserted text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('first ');
  await page.keyboard.type('second');
  await page.locator('[title="Accept all suggestions"]').click();
  await expectEditorHtml(editor, { excludes: ['<ins'] });
  await expect(editor).toContainText('first');
  await expect(editor).toContainText('second');
});

test('Reject All removes all <ins> marks and discards inserted text', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('ephemeral');
  await page.locator('[title="Reject all suggestions"]').click();
  await expectEditorHtml(editor, { excludes: ['<ins'] });
  await expect(editor).not.toContainText('ephemeral');
});

test('Accept All collapses suggestion cards', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.locator('[title="Accept all suggestions"]').click();
  await expect(page.locator('.suggestion-card')).toHaveCount(0);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Mode toggle interaction with tracking
// ────────────────────────────────────────────────────────────────────────────

test('typing after toggling OUT of Suggesting mode is untracked', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await disableSuggesting(page);
  await editor.click();
  await page.keyboard.type('plain');
  await expectEditorHtml(editor, { excludes: ['<ins', '<del'] });
  await expect(editor).toContainText('plain');
});

test('pending changes survive toggling Suggesting off and back on', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await disableSuggesting(page);
  await enableSuggesting(page);
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Comments: floating "+" button
// ────────────────────────────────────────────────────────────────────────────

test('floating "+" button appears when text is selected', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await expect(page.locator('.add-comment-btn')).toBeVisible();
});

test('floating "+" button disappears when selection collapses', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await expect(page.locator('.add-comment-btn')).toBeVisible();
  await page.keyboard.press('End'); // collapses
  await expect(page.locator('.add-comment-btn')).not.toBeVisible();
});

test('clicking "+" opens compose box', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('.add-comment-btn').click();
  const composer = page.locator('.comments .add-comment-compose');
  await expect(composer).toBeVisible();
  await expect(composer.locator('.comment-composer-quote')).toContainText('hello world');
  await expect(page.locator('.add-comment-compose textarea')).toBeFocused();
});

test('selected range stays highlighted while composing a comment', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('.add-comment-btn').click();
  // The textarea has focus (native selection is gone) — the decoration
  // stands in for it.
  await expect(page.locator('.ProseMirror .pending-comment')).toContainText('hello world');
  await page.locator('.add-comment-compose textarea').fill('still highlighted?');
  await expect(page.locator('.ProseMirror .pending-comment')).toContainText('hello world');
});

test('pending highlight hands off to the comment mark on submit', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'shipped');
  await expect(page.locator('.ProseMirror .pending-comment')).toHaveCount(0);
  await expectEditorHtml(editor, { contains: ['comment-mark'] });
});

test('pending highlight disappears when the composer is cancelled', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('.add-comment-btn').click();
  await expect(page.locator('.ProseMirror .pending-comment')).toBeVisible();
  await page.locator('.add-comment-compose .btn-ghost').click(); // Cancel
  await expect(page.locator('.ProseMirror .pending-comment')).toHaveCount(0);
  await expectEditorHtml(editor, { excludes: ['comment-mark'] });
});

test('Escape in the composer also clears the pending highlight', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await page.locator('.add-comment-btn').click();
  await expect(page.locator('.ProseMirror .pending-comment')).toBeVisible();
  await page.locator('.add-comment-compose textarea').press('Escape');
  await expect(page.locator('.ProseMirror .pending-comment')).toHaveCount(0);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 13 — Comments: adding, replying, resolving, deleting
// ────────────────────────────────────────────────────────────────────────────

test('submitting a comment creates a comment card', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'this needs work');
  await expect(page.locator('.comment-card').first()).toBeVisible();
  await expect(page.locator('.comment-card').first()).toContainText('this needs work');
  await expect(page.locator('.comments-empty-state')).toHaveCount(0);
});

test('commented text is wrapped in <mark data-comment-id>', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note');
  await expectEditorHtml(editor, { contains: ['data-comment-id', 'comment-mark'] });
});

test('comment card shows the anchor text snippet', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('the quick brown fox');
  await selectLastNChars(page, 3); // "fox"
  await addCommentViaPlusButton(page, 'animal');
  await expect(page.locator('.comment-anchor-text').first()).toContainText('fox');
});

test('reply button reveals a reply textarea', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'first');
  await page.locator('.comment-reply-trigger').click();
  await expect(page.locator('.comment-reply-input')).toBeVisible();
});

test('submitting a reply appends it to the card', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'first');
  await page.locator('.comment-reply-trigger').click();
  await page.locator('.comment-reply-input').fill('second');
  await page.locator('.comment-card .btn-primary').click();
  const card = page.locator('.comment-card').first();
  await expect(card).toContainText('first');
  await expect(card).toContainText('second');
});

test('resolving a comment hides it from the default view', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await page.locator('.comment-resolve-btn').click();
  await expect(page.locator('.comment-card.comment-card-resolved')).toHaveCount(0);
  await expect(page.locator('.comments-head .filter')).toBeEnabled();
});

test('resolving a comment drops its in-text highlight', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await expect(editor.locator('mark.comment-active')).toHaveCount(1);

  await page.locator('.comment-resolve-btn').click();

  // Resolving strips the comment mark outright — no highlight of any kind
  // remains in the text (active or resolved).
  await expect(editor.locator('mark.comment-active')).toHaveCount(0);
  await expect(editor.locator('mark.comment-resolved')).toHaveCount(0);
  await expect(editor.locator('mark[data-comment-id]')).toHaveCount(0);
});

test('comments filter reveals resolved comments', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await page.locator('.comment-resolve-btn').click();
  await page.locator('.comments-head .filter').click();
  await expect(page.locator('.comment-card-resolved')).toBeVisible();
});

test('deleting a comment removes the card and the mark', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await expectEditorHtml(editor, { contains: ['data-comment-id'] });
  await page.locator('.comment-delete-btn').click();
  await expect(page.locator('.comment-card')).toHaveCount(0);
  await expectEditorHtml(editor, { excludes: ['data-comment-id'] });
});

test('multiple comments stack without overlapping', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('one two three');
  // Comment on "one"
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await addCommentViaPlusButton(page, 'A');
  // Comment on "three"
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await addCommentViaPlusButton(page, 'B');

  const cards = page.locator('.comment-card');
  await expect(cards).toHaveCount(2);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(a && b).toBeTruthy();
  // Document order is preserved with the specified 12px minimum gap.
  expect(b!.y - (a!.y + a!.height)).toBeGreaterThanOrEqual(11);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 13b — Annotation focus: text ↔ card click linking
// ────────────────────────────────────────────────────────────────────────────

test('adding a comment focuses it: card active and text highlighted', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note');
  await expect(page.locator('.comment-card-active')).toBeVisible();
  await expect(page.locator('.ProseMirror .annotation-focus')).toContainText('hello world');
  await expect(page.locator('.annotation-connector')).toBeVisible();
});

test('Escape clears the annotation focus', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note');
  await expect(page.locator('.comment-card-active')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.comment-card-active')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .annotation-focus')).toHaveCount(0);
  await expect(page.locator('.annotation-connector')).toHaveCount(0);
});

test('clicking commented text activates its card', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('hello world');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note');
  await page.keyboard.press('Escape');
  await expect(page.locator('.comment-card-active')).toHaveCount(0);

  await editor.locator('mark.comment-mark').click();
  await expect(page.locator('.comment-card-active')).toBeVisible();
  await expect(page.locator('.ProseMirror .annotation-focus')).toContainText('hello world');
});

test('clicking plain text clears the annotation focus', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('the quick brown fox');
  await selectLastNChars(page, 3); // "fox"
  await addCommentViaPlusButton(page, 'animal');
  await expect(page.locator('.comment-card-active')).toBeVisible();

  // Click the un-commented start of the paragraph.
  await editor
    .locator('p')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.comment-card-active')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .annotation-focus')).toHaveCount(0);
});

test('clicking suggested text activates its accept/reject card', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('suggested text');
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
  await expect(page.locator('.suggestion-card-active')).toHaveCount(0);

  await editor.locator('ins.track-insert').click();
  await expect(page.locator('.suggestion-card-active')).toBeVisible();
  await expect(page.locator('.ProseMirror .annotation-focus')).toContainText('suggested text');
});

test('clicking a suggestion card highlights its text in the document', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('suggested text');

  await page.locator('.suggestion-card').click();
  await expect(page.locator('.suggestion-card-active')).toBeVisible();
  await expect(page.locator('.ProseMirror .annotation-focus')).toContainText('suggested text');

  // Clicking the active card again toggles the focus off.
  await page.locator('.suggestion-card').click();
  await expect(page.locator('.suggestion-card-active')).toHaveCount(0);
  await expect(page.locator('.ProseMirror .annotation-focus')).toHaveCount(0);
});

test('clicking a comment card highlights its anchor text', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('the quick brown fox');
  await selectLastNChars(page, 3); // "fox"
  await addCommentViaPlusButton(page, 'animal');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ProseMirror .annotation-focus')).toHaveCount(0);

  await page.locator('.comment-card').click();
  await expect(page.locator('.comment-card-active')).toBeVisible();
  await expect(page.locator('.ProseMirror .annotation-focus')).toContainText('fox');
});

test('overlapping annotations: the innermost one wins the click', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello world');
  // Comment on "world" — nested inside the tracked insertion covering it all.
  await selectLastNChars(page, 5);
  await addCommentViaPlusButton(page, 'inner');
  await page.keyboard.press('Escape');

  await editor.locator('mark.comment-mark').click();
  await expect(page.locator('.comment-card-active')).toBeVisible();
  await expect(page.locator('.suggestion-card-active')).toHaveCount(0);
});

test('accepting a suggestion clears its focus', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('keep me');
  await editor.locator('ins.track-insert').click();
  await expect(page.locator('.suggestion-card-active')).toBeVisible();

  await page.locator('.suggestion-accept-btn').click();
  await expect(page.locator('.ProseMirror .annotation-focus')).toHaveCount(0);
});

test('resolving a focused comment clears its focus', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'todo');
  await expect(page.locator('.ProseMirror .annotation-focus')).toBeVisible();

  await page.locator('.comment-resolve-btn').click();
  await expect(page.locator('.ProseMirror .annotation-focus')).toHaveCount(0);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 13c — Replacement suggestions (one card for delete + insert)
// ────────────────────────────────────────────────────────────────────────────

/** Type "hello world" untracked, then replace "world" with "earth" in suggesting mode. */
async function makeReplacement(page: Page, editor: Locator) {
  await page.keyboard.type('hello world');
  await enableSuggesting(page);
  await editor.click();
  // Keyboard selection occasionally drops a Shift+ArrowLeft — verify we really
  // selected "world" before typing over it, retrying if not.
  for (let attempt = 0; attempt < 3; attempt++) {
    await selectLastNChars(page, 5);
    const sel = await page.evaluate(() => window.getSelection()?.toString());
    if (sel === 'world') break;
  }
  await page.keyboard.type('earth');
  await expect(page.locator('.suggestion-card-replace')).toHaveCount(1);
  await expect(editor.locator('del')).toContainText('world');
  await expect(editor.locator('ins')).toContainText('earth');
}

test('typing over a selection shows ONE replacement card with old → new', async ({ page }) => {
  const { editor } = await setup(page);
  await makeReplacement(page, editor);

  await expect(page.locator('.suggestion-card')).toHaveCount(1);
  const card = page.locator('.suggestion-card-replace');
  await expect(card).toBeVisible();
  await expect(card.locator('.suggestion-type-badge')).toHaveText('Replacement');
  await expect(card.locator('.suggestion-replace-old')).toContainText('world');
  await expect(card.locator('.suggestion-replace-new')).toContainText('earth');
});

test('accepting a replacement keeps the new text and removes the old', async ({ page }) => {
  const { editor } = await setup(page);
  await makeReplacement(page, editor);

  await page.locator('.suggestion-accept-btn').click();
  await expect(editor).toContainText('hello earth');
  await expect(editor).not.toContainText('world');
  await expectEditorHtml(editor, { excludes: ['<ins', '<del'] });
  await expect(page.locator('.suggestion-card')).toHaveCount(0);
});

test('rejecting a replacement restores the original text', async ({ page }) => {
  const { editor } = await setup(page);
  await makeReplacement(page, editor);

  await page.locator('.suggestion-reject-btn').click();
  await expect(editor).toContainText('hello world');
  await expect(editor).not.toContainText('earth');
  await expectEditorHtml(editor, { excludes: ['<ins', '<del'] });
  await expect(page.locator('.suggestion-card')).toHaveCount(0);
});

test('clicking a replacement card highlights both old and new text', async ({ page }) => {
  const { editor } = await setup(page);
  await makeReplacement(page, editor);

  await page.locator('.suggestion-card-replace').click();
  await expect(page.locator('.suggestion-card-active')).toBeVisible();
  const focused = page.locator('.ProseMirror .annotation-focus');
  await expect(focused.filter({ hasText: 'earth' }).first()).toBeVisible();
  await expect(focused.filter({ hasText: 'world' }).first()).toBeVisible();
});

test('clicking either text half activates the replacement card', async ({ page }) => {
  const { editor } = await setup(page);
  await makeReplacement(page, editor);
  await expect(page.locator('.suggestion-card-active')).toHaveCount(0);

  // The inserted half…
  await editor.locator('ins.track-insert').click();
  await expect(page.locator('.suggestion-card-active')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.suggestion-card-active')).toHaveCount(0);

  // …and the deleted half both focus the pair: card active, both texts lit.
  await editor.locator('del.track-delete').click();
  await expect(page.locator('.suggestion-card-active')).toBeVisible();
  const focused = page.locator('.ProseMirror .annotation-focus');
  await expect(focused.filter({ hasText: 'earth' }).first()).toBeVisible();
  await expect(focused.filter({ hasText: 'world' }).first()).toBeVisible();
});

test('separate insert and delete still render two independent cards', async ({ page }) => {
  const { editor } = await setup(page);
  await page.keyboard.type('alpha beta');
  await enableSuggesting(page);
  await editor.click();
  // Delete "beta" (pure deletion)…
  await selectLastNChars(page, 4);
  await page.keyboard.press('Backspace');
  // …then insert at the start of the line (pure insertion, not adjacent).
  await page.keyboard.press('Home');
  await page.keyboard.type('intro ');

  await expect(page.locator('.suggestion-card')).toHaveCount(2);
  await expect(page.locator('.suggestion-card-replace')).toHaveCount(0);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 14 — Footer (word/char count, line/col, file name)
// ────────────────────────────────────────────────────────────────────────────

test('word count updates as the user types', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('one two three');
  await expect(page.locator('.footer')).toContainText('3 WORDS');
});

test('char count updates as the user types', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('hello');
  await expect(page.locator('.footer')).toContainText('5 CHARS');
});

test('topbar shows "Untitled" when no file is open', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.crumbs .cur')).toHaveText('Untitled');
});

test('Untitled breadcrumb stays collapsed after typing', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('x');
  await expect(page.locator('.crumbs .cur')).toHaveText('Untitled');
  await expect(page.locator('.dirty-dot')).toBeVisible();
  await expect(page.locator('.saved')).toHaveCount(0);
});

test('document title shows dirty bullet when modified', async ({ page }) => {
  await setup(page);
  await page.keyboard.type('x');
  await expectPageTitleToContain(page, '•');
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 15 — Zoom
// ────────────────────────────────────────────────────────────────────────────

test('zoom slider in footer is present', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.footer-zoom-slider')).toBeVisible();
  await expect(page.locator('.footer-zoom-label')).toContainText('100%');
});

test('zoom step buttons change zoom and disable at the bounds', async ({ page }) => {
  await setup(page);
  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  const zoomOut = page.getByRole('button', { name: 'Zoom out' });

  await zoomIn.click();
  await expect(page.locator('.footer-zoom-label')).toHaveText('112%');
  await zoomOut.click();
  await expect(page.locator('.footer-zoom-label')).toHaveText('100%');

  await setZoom(page, 0.6);
  await expect(zoomOut).toBeDisabled();
  await expect(zoomIn).toBeEnabled();

  await setZoom(page, 2.4);
  await expect(zoomIn).toBeDisabled();
  await expect(zoomOut).toBeEnabled();
});

test('Cmd+= zoom shortcut increases zoom', async ({ page }) => {
  await setup(page);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('=');
  await page.keyboard.up('ControlOrMeta');
  await expect(page.locator('.footer-zoom-label')).not.toHaveText('100%');
});

test('Cmd+- zoom shortcut decreases zoom', async ({ page }) => {
  await setup(page);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('-');
  await page.keyboard.up('ControlOrMeta');
  await expect(page.locator('.footer-zoom-label')).not.toHaveText('100%');
});

test('Cmd+0 resets zoom to 100%', async ({ page }) => {
  await setup(page);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('=');
  await page.keyboard.up('ControlOrMeta');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('0');
  await page.keyboard.up('ControlOrMeta');
  await expect(page.locator('.footer-zoom-label')).toContainText('100%');
});

test('double-clicking the zoom label resets to 100%', async ({ page }) => {
  await setup(page);
  await setZoom(page, 2.4);
  await page.locator('.footer-zoom-label').dblclick();
  await expect(page.locator('.footer-zoom-label')).toHaveText('100%');
});

test('zoom scales document text and reflows inside a fixed-width page', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.fill(`${'A readable line of prose wraps naturally. '.repeat(28)}`);

  const metrics = async () => {
    const pageBox = (await page.locator('.editor-page').boundingBox())!;
    return page
      .locator('.ProseMirror')
      .evaluate((element) => {
        const paragraph = element.querySelector('p')!;
        return {
          fontSize: parseFloat(getComputedStyle(element).fontSize),
          paragraphHeight: paragraph.getBoundingClientRect().height,
        };
      })
      .then((text) => ({ ...text, pageWidth: pageBox.width }));
  };

  await setZoom(page, 0.6);
  const small = await metrics();
  await setZoom(page, 2.4);
  const large = await metrics();

  expect(Math.abs(large.pageWidth - small.pageWidth)).toBeLessThan(1);
  expect(large.pageWidth).toBeCloseTo(640, 0);
  expect(large.fontSize / small.fontSize).toBeCloseTo(4, 1);
  expect(large.paragraphHeight).toBeGreaterThan(small.paragraphHeight * 3);
});

test('add-comment button stays aligned with the selection across zoom levels', async ({ page }) => {
  const { editor } = await setup(page);
  for (let i = 0; i < 3; i++) {
    await editor.type(`Paragraph number ${i} with some filler text.`);
    await page.keyboard.press('Enter');
  }
  await selectLastNChars(page, 6);

  const btn = page.locator('.add-comment-btn');
  await expect(btn).toBeVisible();

  const deltaAt = async () => {
    const selTop = await page.evaluate(
      () => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top,
    );
    const btnTop = (await btn.boundingBox())!.y;
    return btnTop - selTop;
  };

  await setZoom(page, 0.6);
  const deltaSmall = await deltaAt();
  await setZoom(page, 2.4);
  const deltaLarge = await deltaAt();
  expect(Math.abs(deltaLarge - deltaSmall)).toBeLessThan(5);
});

test('comment card realigns with its anchor when zoom changes', async ({ page }) => {
  const { editor } = await setup(page);
  for (let i = 0; i < 3; i++) {
    await editor.type(`Paragraph number ${i} with some filler text.`);
    await page.keyboard.press('Enter');
  }
  await selectLastNChars(page, 6);
  await addCommentViaPlusButton(page, 'zoom alignment check');

  const mark = page.locator('mark.comment-mark');
  const card = page.locator('.comment-card');
  await expect(card).toBeVisible();

  const alignmentError = async () => {
    const markBox = (await mark.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    const panelBox = (await page.locator('.comments').boundingBox())!;
    const expectedTop = Math.min(
      Math.max(markBox.y, panelBox.y + 44),
      // Maz removed the 62px general-comment chrome; anchored cards now use
      // the full panel height and clamp directly above its bottom edge.
      panelBox.y + panelBox.height - cardBox.height,
    );
    return Math.abs(cardBox.y - expectedTop);
  };

  await setZoom(page, 0.6);
  expect(await alignmentError()).toBeLessThan(2);
  await setZoom(page, 2.4);
  expect(await alignmentError()).toBeLessThan(2);
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Cross-feature interactions
// ────────────────────────────────────────────────────────────────────────────

test('comment can be added to text that is also tracked-inserted', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await selectAll(page);
  await addCommentViaPlusButton(page, 'note on insertion');
  await expectEditorHtml(editor, { contains: ['<ins', 'data-comment-id'] });
  await expect(page.locator('.comment-card')).toHaveCount(1);
  // Plus one suggestion card for the insertion itself
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
});

test('typing newline in suggesting mode blocks the paragraph split but keeps inline typing', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await expect(editor).toContainText('onetwo');
  await expect(editor.locator('p')).toHaveCount(1);
  await expectEditorHtml(editor, { contains: ['<ins'] });
  await expect(page.locator('.suggesting-mode-notice')).toContainText('Switch to Editing');
});

test('replacement (type over selection) shows both <del> and <ins>', async ({ page }) => {
  const { editor } = await setup(page);
  await editor.click();
  await page.keyboard.type('hello world');
  await enableSuggesting(page);
  await editor.click();
  // Select "world" and type "earth"
  await selectLastNChars(page, 5);
  await page.keyboard.type('earth');
  await expect(editor.locator('del')).toContainText('world');
  await expect(editor.locator('ins')).toContainText('earth');
  await expect(editor).toContainText('hello'); // kept
  await expect(editor).toContainText('earth'); // inserted
  // The paired halves render as a single replacement card.
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
  await expect(page.locator('.suggestion-card-replace')).toHaveCount(1);
});

test('undo in suggesting mode reverts the last tracked change', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('hello');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('z');
  await page.keyboard.up('ControlOrMeta');
  await expectEditorHtml(editor, { excludes: ['<ins'] });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 17 — Regression guards
// ────────────────────────────────────────────────────────────────────────────

test('typing after toggle-off does not produce <ins> even with prior pending', async ({ page }) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('first');
  await disableSuggesting(page);
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('SECOND');
  await expect
    .poll(async () => (await editor.innerHTML()).replace(/<ins[^>]*>.*?<\/ins>/g, ''))
    .toContain('SECOND');
});

test('Enter in suggesting mode leaves the current paragraph structurally unchanged', async ({
  page,
}) => {
  const { editor } = await setup(page);
  await enableSuggesting(page);
  await editor.click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await expect(editor.locator('p')).toHaveCount(1);
  await expect(editor).toContainText('onetwo');
  await expect(page.locator('.suggesting-mode-notice')).toBeVisible();
});

test('editor opts into spellcheck explicitly', async ({ page }) => {
  const { editor } = await setup(page);
  await expect(editor).toHaveAttribute('spellcheck', 'true');
});
