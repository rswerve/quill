import { expect, test, type Page } from '@playwright/test';
import { activeEditor, setupMemoryTauri } from './helpers/memoryTauri';

/**
 * Slice 1 of hard-break support: a text edit that spans a Shift+Enter hard
 * break is now a real tracked suggestion for a human editing directly.
 *
 * Pre-fix, replacing across a break in Suggesting mode struck the surrounding
 * text but left the break unmarked, so Accept produced a document with a stray
 * line break the user never kept. Now the break is tracked with the rest of
 * the replacement — Accept removes it, Reject restores it exactly.
 *
 * The gesture is a partial selection spanning the break (from inside "one" to
 * inside "two"). A whole-document select-all is deliberately avoided: it
 * triggers a separate, pre-existing Suggesting-mode paragraph-split quirk that
 * reproduces even without a break and is unrelated to this feature.
 *
 * Scope: delete/replace across an EXISTING break only. Creating a break from a
 * replacement newline, joins as an explicit protocol gesture, and the review
 * card's line-break glyph are Slice 2. Images stay out (separate typed-node
 * protocol).
 */

async function enableSuggesting(page: Page) {
  const mode = page.getByRole('group', { name: 'Editing mode' });
  await mode.getByRole('button', { name: 'Suggesting' }).click();
  await expect(mode.getByRole('button', { name: 'Suggesting' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

// Select from after the first char of "one" to after "tw" — a range that spans
// the hard break without selecting whole paragraph boundaries.
async function selectAcrossBreak(page: Page) {
  await page.evaluate(() => {
    const paragraph = document.querySelector('.ProseMirror p');
    if (!paragraph) throw new Error('no paragraph');
    const oneNode = paragraph.childNodes[0]; // text "one"
    const twoNode = paragraph.childNodes[2]; // text "two" (childNodes[1] is <br>)
    const range = document.createRange();
    range.setStart(oneNode, 1);
    range.setEnd(twoNode, 2);
    const selection = window.getSelection();
    if (!selection) throw new Error('no selection');
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function seedHardBrokenLines(page: Page) {
  await setupMemoryTauri(page);
  await activeEditor(page).click();
  await page.keyboard.type('one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  await expect.poll(() => activeEditor(page).innerHTML()).toBe('<p>one<br>two</p>');
  await enableSuggesting(page);
}

test('replacing across a hard break tracks the break, and Accept drops it', async ({ page }) => {
  await seedHardBrokenLines(page);
  await activeEditor(page).click();
  await selectAcrossBreak(page);
  await page.keyboard.type('X');

  // The break is tracked as part of the deletion (struck, not left behind),
  // and the replacement text is a tracked insertion. The Slice 2 line-break
  // cue is an empty widget kept OUTSIDE the review marks, so it splits the
  // struck run into two same-change deletion fragments with the cue between.
  const pending = await activeEditor(page).innerHTML();
  expect(pending).toContain('track-insert');
  expect(pending).toContain('track-delete');
  expect(pending).toMatch(/<del[^>]*>ne<\/del>/); // first struck fragment
  expect(pending).toContain('data-hard-break-cue="delete"'); // the deleted break's cue
  expect(pending).toMatch(/<del[^>]*><br>tw<\/del>/); // the struck break + trailing text

  await page.locator('[title="Accept all suggestions"]').click();

  // Exact: the break is gone with the struck text, leaving "o" + "X" + "o".
  await expect.poll(() => activeEditor(page).innerHTML()).toBe('<p>oXo</p>');
});

test('rejecting the replacement restores the original hard-broken lines', async ({ page }) => {
  await seedHardBrokenLines(page);
  await activeEditor(page).click();
  await selectAcrossBreak(page);
  await page.keyboard.type('X');

  await page.locator('[title="Reject all suggestions"]').click();

  // Exact byte-equivalent restoration of the original hard-broken lines.
  await expect.poll(() => activeEditor(page).innerHTML()).toBe('<p>one<br>two</p>');
});

// ── Slice 2: creating a break, and its review-card representation ────────────

async function seedSingleLine(page: Page) {
  await setupMemoryTauri(page);
  await activeEditor(page).click();
  await page.keyboard.type('onetwo');
  await expect.poll(() => activeEditor(page).innerHTML()).toBe('<p>onetwo</p>');
  await enableSuggesting(page);
}

// Count real hard breaks (excluding ProseMirror's trailing-break placeholder)
// and the visible text — position-independent, since the exact caret offset
// under headless keyboard nav is not what this UI test is about.
async function breakState(page: Page): Promise<{ breaks: number; text: string }> {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) throw new Error('no editor');
    return {
      breaks: pm.querySelectorAll('br:not(.ProseMirror-trailingBreak)').length,
      text: pm.textContent ?? '',
    };
  });
}

test('an inserted hard break shows a ↵ line-break card (never a blank quote), and Accept keeps the break', async ({
  page,
}) => {
  await seedSingleLine(page);
  await activeEditor(page).click();
  await page.keyboard.press('ArrowLeft'); // caret inside the line
  await page.keyboard.press('Shift+Enter');

  // The break-only suggestion renders with the ↵ glyph, not an empty preview.
  const card = page.locator('[data-card-id]').filter({ hasText: '↵' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();

  await page.locator('[title="Accept all suggestions"]').click();
  // Exactly one real break, and the text is preserved (regardless of position).
  await expect.poll(() => breakState(page)).toEqual({ breaks: 1, text: 'onetwo' });
});

test('rejecting an inserted hard break restores the single line with no break', async ({
  page,
}) => {
  await seedSingleLine(page);
  await activeEditor(page).click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+Enter');

  await page.locator('[title="Reject all suggestions"]').click();
  await expect.poll(() => activeEditor(page).innerHTML()).toBe('<p>onetwo</p>');
});
