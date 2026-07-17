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
  // and the replacement text is a tracked insertion.
  const pending = await activeEditor(page).innerHTML();
  expect(pending).toContain('track-insert');
  expect(pending).toContain('track-delete');
  expect(pending).toMatch(/<del[^>]*>ne<br>tw<\/del>/); // the break sits inside the struck run

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
