import { expect, test, type Locator, type Page } from '@playwright/test';

async function setup(page: Page, text: string): Promise<Locator> {
  await page.goto('/');
  const editor = page.locator('.ProseMirror');
  await editor.waitFor();
  await editor.click();
  if (text) await page.keyboard.type(text);
  return editor;
}

async function enableSuggesting(page: Page): Promise<void> {
  await page.locator('.mode-switch').getByRole('button', { name: 'Suggesting' }).click();
}

async function selectText(editor: Locator, from: number, to: number): Promise<void> {
  await editor.evaluate(
    (root, rangeOffsets) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number; end: number }> = [];
      let offset = 0;
      let current: Node | null;
      while ((current = walker.nextNode())) {
        const node = current as Text;
        nodes.push({ node, start: offset, end: offset + node.data.length });
        offset += node.data.length;
      }
      const start = nodes.find((entry) => rangeOffsets.from <= entry.end);
      const end = nodes.find((entry) => rangeOffsets.to <= entry.end);
      if (!start || !end) throw new Error(`Cannot select ${rangeOffsets.from}..${rangeOffsets.to}`);
      (root as HTMLElement).focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(start.node, Math.max(0, rangeOffsets.from - start.start));
      range.setEnd(end.node, Math.max(0, rangeOffsets.to - end.start));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    },
    { from, to },
  );
  await editor
    .page()
    .evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
}

async function placeCaret(editor: Locator, offset: number): Promise<void> {
  await selectText(editor, offset, offset);
}

async function acceptedText(editor: Locator): Promise<string> {
  return editor.evaluate((root) => {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('del').forEach((node) => node.remove());
    return clone.textContent ?? '';
  });
}

async function expectNoTracking(editor: Locator): Promise<void> {
  await expect(editor.locator('ins, del, [data-tracked-format]')).toHaveCount(0);
}

async function acceptAll(page: Page): Promise<void> {
  await page.locator('[title="Accept all suggestions"]').click();
}

async function rejectAll(page: Page): Promise<void> {
  await page.locator('[title="Reject all suggestions"]').click();
}

test.describe('Suggesting mode adversarial interactions', () => {
  test('mid-word insertion accepts and rejects without losing neighboring characters', async ({
    page,
  }) => {
    const editor = await setup(page, 'abcdef');
    await enableSuggesting(page);
    await placeCaret(editor, 3);
    await page.keyboard.type('XYZ');
    await rejectAll(page);
    await expect(acceptedText(editor)).resolves.toBe('abcdef');
    await expectNoTracking(editor);

    await placeCaret(editor, 3);
    await page.keyboard.type('XYZ');
    await acceptAll(page);
    await expect(acceptedText(editor)).resolves.toBe('abcXYZdef');
    await expectNoTracking(editor);
  });

  test('an insertion deleted by its author annihilates without an orphan card', async ({
    page,
  }) => {
    const editor = await setup(page, 'base');
    await enableSuggesting(page);
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type('added');
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('Backspace');

    await expect(acceptedText(editor)).resolves.toBe('base');
    await expectNoTracking(editor);
    await expect(page.locator('.suggestion-card')).toHaveCount(0);
  });

  test('inserting inside a pending deletion remains accept/reject safe', async ({ page }) => {
    const editor = await setup(page, 'abcde');
    await enableSuggesting(page);
    await selectText(editor, 1, 3);
    await page.keyboard.press('Backspace');
    const deletion = editor.locator('del');
    await expect(deletion).toHaveText('bc');
    await deletion.evaluate((node) => {
      const text = node.firstChild!;
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    });
    await page.keyboard.type('X');

    await acceptAll(page);
    await expect(acceptedText(editor)).resolves.toBe('aXde');
    await expectNoTracking(editor);
  });

  test('deleting across a pending insertion annihilates it and leaves a rejectable deletion', async ({
    page,
  }) => {
    const editor = await setup(page, 'abcd');
    await enableSuggesting(page);
    await placeCaret(editor, 2);
    await page.keyboard.type('X');
    await selectText(editor, 1, 4);
    await page.keyboard.press('Backspace');

    expect(await editor.locator('ins').allTextContents()).not.toContain('X');
    await rejectAll(page);
    await expect(acceptedText(editor)).resolves.toBe('abcd');
    await expectNoTracking(editor);
  });

  test('format on then off is net zero with no format suggestion', async ({ page }) => {
    const editor = await setup(page, 'alpha');
    await enableSuggesting(page);
    await selectText(editor, 0, 5);
    await page.locator('.rail-btn[title^="Bold"]').click();
    await selectText(editor, 0, 5);
    await page.locator('.rail-btn[title^="Bold"]').click();

    await expectNoTracking(editor);
    await expect(page.locator('.suggestion-card')).toHaveCount(0);
    await expect(editor.locator('strong')).toHaveCount(0);
  });

  for (const { shortcut, expected } of [
    { shortcut: 'Alt+Backspace', expected: 'alpha ' },
    { shortcut: 'ControlOrMeta+Backspace', expected: '' },
  ]) {
    test(`${shortcut} creates a rejectable deletion with no lost text`, async ({ page }) => {
      const editor = await setup(page, 'alpha bravo');
      await enableSuggesting(page);
      await editor.click();
      await page.keyboard.press('End');
      await page.keyboard.press(shortcut);

      await expect(acceptedText(editor)).resolves.toBe(expected);
      await rejectAll(page);
      await expect(acceptedText(editor)).resolves.toBe('alpha bravo');
      await expectNoTracking(editor);
    });
  }

  test('deleting an emoji grapheme is rejectable without splitting its surrogate pair', async ({
    page,
  }) => {
    const editor = await setup(page, 'a🙂b');
    await enableSuggesting(page);
    await selectText(editor, 1, 3);
    await page.keyboard.press('Backspace');

    await expect(acceptedText(editor)).resolves.toBe('ab');
    await rejectAll(page);
    await expect(acceptedText(editor)).resolves.toBe('a🙂b');
    await expectNoTracking(editor);
  });

  test('paste over a selection remains one resolvable replacement', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const editor = await setup(page, 'hello world');
    await enableSuggesting(page);
    await selectText(editor, 6, 11);
    await page.evaluate(() => navigator.clipboard.writeText('earth'));
    await page.keyboard.press('ControlOrMeta+v');

    await expect(page.locator('.suggestion-card-replace')).toHaveCount(1);
    await acceptAll(page);
    await expect(acceptedText(editor)).resolves.toBe('hello earth');
    await expectNoTracking(editor);
  });

  test('rapid Backspaces coalesce into the same one-step undo as Editing mode', async ({
    page,
  }) => {
    const editor = await setup(page, 'bravo');
    await enableSuggesting(page);
    await editor.click();
    await page.keyboard.press('End');
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+z');

    await expect(acceptedText(editor)).resolves.toBe('bravo');
  });

  test('typing after deleting a formatted word does not inherit formatting from struck text', async ({
    page,
  }) => {
    const editor = await setup(page, 'alpha beta');
    await selectText(editor, 0, 5);
    await page.locator('.rail-btn[title^="Bold"]').click();
    await enableSuggesting(page);
    await selectText(editor, 0, 5);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('YZ');
    await acceptAll(page);

    await expect(acceptedText(editor)).resolves.toBe('YZ beta');
    await expect(editor.locator('strong')).toHaveCount(0);
    await expectNoTracking(editor);
  });

  test('Enter in committed text is blocked with a structure notice', async ({ page }) => {
    const editor = await setup(page, 'first second');
    await enableSuggesting(page);
    await placeCaret(editor, 5);
    await page.keyboard.press('Enter');

    await expect(editor.locator('p')).toHaveCount(1);
    await expect(acceptedText(editor)).resolves.toBe('first second');
    await expect(page.locator('.suggesting-mode-notice')).toContainText(
      'Switch to Editing to change paragraph structure',
    );
    await expect(page.locator('[title="Reject all suggestions"]')).toHaveCount(0);
  });

  test('select-all Backspace creates a rejectable whole-document deletion', async ({ page }) => {
    const editor = await setup(page, 'keep this text');
    await enableSuggesting(page);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    await expect(acceptedText(editor)).resolves.toBe('');
    await expect(editor.locator('del')).toContainText('keep this text');
    await rejectAll(page);
    await expect(acceptedText(editor)).resolves.toBe('keep this text');
  });

  test('multi-block select-all Backspace is blocked without collapsing the document', async ({
    page,
  }) => {
    const editor = await setup(page, 'first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await enableSuggesting(page);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    await expect(editor.locator('p')).toHaveCount(2);
    await expect(acceptedText(editor)).resolves.toBe('firstsecond');
    await expect(page.locator('.suggesting-mode-notice')).toBeVisible();
    await expectNoTracking(editor);
  });

  test('Backspace at block start is blocked instead of permanently joining blocks', async ({
    page,
  }) => {
    const editor = await setup(page, 'first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await enableSuggesting(page);
    await editor.locator('p').nth(1).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');

    await expect(editor.locator('p')).toHaveCount(2);
    await expect(acceptedText(editor)).resolves.toBe('firstsecond');
    await expect(page.locator('.suggesting-mode-notice')).toBeVisible();
    await expectNoTracking(editor);
  });

  test('cross-block deletion is blocked without changing either paragraph', async ({ page }) => {
    const editor = await setup(page, 'alpha beta');
    await page.keyboard.press('Enter');
    await page.keyboard.type('gamma delta');
    await enableSuggesting(page);
    await selectText(editor, 6, 15);
    await page.keyboard.press('Backspace');

    await expect(editor.locator('p')).toHaveCount(2);
    await expect(acceptedText(editor)).resolves.toBe('alpha betagamma delta');
    await expect(page.locator('.suggesting-mode-notice')).toBeVisible();
    await expectNoTracking(editor);
  });
});
