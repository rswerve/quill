import { expect, type Locator, type Page } from '@playwright/test';

export async function expectEditorHtml(
  editor: Locator,
  options: { contains?: string[]; excludes?: string[] },
) {
  const contains = options.contains ?? [];
  const excludes = options.excludes ?? [];
  await expect
    .poll(async () => {
      const html = await editor.innerHTML();
      return {
        contains: contains.filter((value) => html.includes(value)),
        excludes: excludes.filter((value) => !html.includes(value)),
      };
    })
    .toEqual({ contains, excludes });
}

/**
 * Read the selection ProseMirror has actually committed.
 *
 * NOT `window.getSelection()`. A key press commits the DOM selection first;
 * ProseMirror syncs its own state afterwards, on `selectionchange`. Gating on
 * the DOM therefore lets a test proceed during that gap and act on a selection
 * the editor does not yet have — which is how a Bold click landed on a
 * collapsed caret and set a stored mark instead of formatting text, while the
 * assertion that followed passed anyway. The dev server was slow enough to hide
 * this; a production bundle is not.
 *
 * Returns null when the handle is missing so callers fail loudly. Falling back
 * to the DOM selection would reintroduce exactly the race this exists to close,
 * and would do it invisibly.
 */
async function proseMirrorSelection(page: Page): Promise<{ text: string; empty: boolean } | null> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __quillEditor?: EditorLike }).__quillEditor;
    if (!editor?.state) return null;
    const { from, to, empty } = editor.state.selection;
    // '\n' between blocks, so a multi-block selection reads the way the DOM
    // selection did. Without a separator ProseMirror runs blocks together, and
    // the first test to select across paragraphs would get "endbegin".
    return { text: editor.state.doc.textBetween(from, to, '\n'), empty };
  });
}

interface EditorLike {
  state: {
    selection: { from: number; to: number; empty: boolean };
    doc: { textBetween: (from: number, to: number, blockSeparator?: string) => string };
  };
}

export async function expectSelectionText(page: Page, expected?: string) {
  if (expected !== undefined) {
    await expect
      .poll(async () => (await proseMirrorSelection(page))?.text ?? '<no editor handle>')
      .toBe(expected);
    return;
  }
  // Without an expected value this can only assert "something is selected".
  // Prefer passing the exact text: a partially-committed selection satisfies a
  // non-empty check and the test then acts on the wrong range.
  await expect.poll(async () => (await proseMirrorSelection(page))?.empty ?? true).toBe(false);
}

export async function expectPageTitleToContain(page: Page, expected: string) {
  await expect.poll(() => page.title()).toContain(expected);
}
