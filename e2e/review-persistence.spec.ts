import { test, expect } from '@playwright/test';
import { ipcFixtures } from './helpers/ipcFixtures';
import { openMemoryFile, selectLastCharacters, setupMemoryTauri } from './helpers/memoryTauri';

const DOC_PATH = '/tmp/review-persistence.md';
const SIDECAR_PATH = '/tmp/review-persistence.comments.json';

function sidecar(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ version: 2, comments: [], suggestions: [], ...overrides });
}

async function saveNewAndReopen(page: import('@playwright/test').Page) {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.dirty-dot')).toHaveCount(0);
  const files = await page.evaluate(
    () => (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles,
  );
  const reopened = await page.context().newPage();
  await setupMemoryTauri(reopened, { files, openPath: DOC_PATH });
  await openMemoryFile(reopened);
  await expect(reopened.locator('.crumbs .cur')).toContainText('review-persistence.md');
  return reopened;
}

const LIVE_COMMENT = {
  id: 'live-comment',
  anchorText: 'hello',
  from: 8,
  to: 13,
  author: 'Reviewer',
  createdAt: '2026-07-11T18:00:00Z',
  resolved: false,
  replies: [],
};

async function openLiveComment(
  page: import('@playwright/test').Page,
  options: { resolved?: boolean; mockAI?: boolean } = {},
) {
  await setupMemoryTauri(page, {
    openPath: DOC_PATH,
    savePath: DOC_PATH,
    mockAI: options.mockAI,
    files: {
      [DOC_PATH]: 'prefix hello world',
      [SIDECAR_PATH]: sidecar({
        comments: [{ ...LIVE_COMMENT, resolved: options.resolved ?? false }],
        ...(options.mockAI ? { aiSession: ipcFixtures.autoBindSession } : {}),
      }),
    },
  });
  await openMemoryFile(page);
}

async function placeCaretAtDocumentStart(page: import('@playwright/test').Page) {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+Home');
}

async function selectCommentSlice(page: import('@playwright/test').Page, from: number, to: number) {
  await page.locator('mark[data-comment-id="live-comment"]').evaluate(
    (mark, rangeOffsets) => {
      const text = mark.firstChild;
      if (!(text instanceof Text)) throw new Error('comment mark has no text node');
      const range = document.createRange();
      range.setStart(text, rangeOffsets.from);
      range.setEnd(text, rangeOffsets.to);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      (mark.closest('.ProseMirror') as HTMLElement | null)?.focus();
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    },
    { from, to },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

test.describe('review metadata survives save and reopen', () => {
  test('saving a pending replacement writes sidecar metadata for reload', async ({ page }) => {
    await setupMemoryTauri(page, { openPath: DOC_PATH, savePath: DOC_PATH });
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('old');
    await page.locator('.mode-switch').click();
    await editor.click();
    await selectLastCharacters(page, 'old'.length);
    await page.keyboard.type('new');
    await page.keyboard.press('ControlOrMeta+s');

    const files = await page.evaluate(() => window.__quillFiles);
    expect(files[DOC_PATH]).toBeDefined();
    expect(files[SIDECAR_PATH]).toBeDefined();
    expect(JSON.parse(files[SIDECAR_PATH]).suggestions).not.toHaveLength(0);
  });

  test('pending insertion remains pending after save and reopen', async ({ page }) => {
    await setupMemoryTauri(page, { openPath: DOC_PATH, savePath: DOC_PATH });
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('base');
    await page.locator('.mode-switch').click();
    await editor.click();
    await page.keyboard.type(' added');

    const reopened = await saveNewAndReopen(page);
    const reopenedEditor = reopened.locator('.ProseMirror');

    await expect(reopenedEditor.locator('ins.track-insert')).toHaveText(' added');
    await expect(reopened.locator('.suggestion-card')).toHaveCount(1);
  });

  test('pending deletion remains pending after save and reopen', async ({ page }) => {
    await setupMemoryTauri(page, { openPath: DOC_PATH, savePath: DOC_PATH });
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('keep remove');
    await page.locator('.mode-switch').click();
    await editor.click();
    await selectLastCharacters(page, 'remove'.length);
    await page.keyboard.press('Backspace');

    const reopened = await saveNewAndReopen(page);
    const reopenedEditor = reopened.locator('.ProseMirror');

    await expect(reopenedEditor.locator('del.track-delete')).toHaveText('remove');
    await expect(reopened.locator('.suggestion-card')).toHaveCount(1);
  });

  test('pending replacement remains paired after save and reopen', async ({ page }) => {
    await setupMemoryTauri(page, { openPath: DOC_PATH, savePath: DOC_PATH });
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('old');
    await page.locator('.mode-switch').click();
    await editor.click();
    await selectLastCharacters(page, 'old'.length);
    await page.keyboard.type('new');

    const reopened = await saveNewAndReopen(page);
    const reopenedEditor = reopened.locator('.ProseMirror');

    await expect(reopenedEditor.locator('del.track-delete')).toHaveText('old');
    await expect(reopenedEditor.locator('ins.track-insert')).toHaveText('new');
    await expect(reopened.locator('.suggestion-card-replace')).toHaveCount(1);
  });

  test('re-stamps a loaded unresolved comment over its stored anchor', async ({ page }) => {
    await setupMemoryTauri(page, {
      openPath: DOC_PATH,
      files: {
        [DOC_PATH]: 'hello world',
        [SIDECAR_PATH]: sidecar({
          comments: [
            {
              id: 'fixture-comment',
              anchorText: 'hello',
              from: 1,
              to: 6,
              author: 'Reviewer',
              createdAt: '2026-07-11T18:00:00Z',
              resolved: false,
              replies: [],
            },
          ],
        }),
      },
    });

    await openMemoryFile(page);

    const mark = page.locator('mark.comment-mark[data-comment-id="fixture-comment"]');
    await expect(mark).toHaveText('hello');
  });

  test('pending formatting remains reviewable after save and reopen', async ({ page }) => {
    await setupMemoryTauri(page, { openPath: DOC_PATH, savePath: DOC_PATH });
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('plain text');
    await page.locator('.mode-switch').click();
    await editor.click();
    await selectLastCharacters(page, 'text'.length);
    await page.keyboard.press('ControlOrMeta+b');

    await expect(editor.locator('span.track-format')).toHaveText('text');
    await expect(page.locator('.suggestion-card-format')).toContainText('bold added');

    const reopened = await saveNewAndReopen(page);
    const reopenedEditor = reopened.locator('.ProseMirror');
    await expect(reopenedEditor.locator('span.track-format')).toHaveText('text');
    await expect(reopenedEditor.locator('strong')).toHaveText('text');
    await expect(reopened.locator('.suggestion-card-format')).toContainText('bold added');

    await reopened.locator('.suggestion-card-format .suggestion-reject-btn').click();
    await expect(reopened.locator('.suggestion-card-format')).toHaveCount(0);
    await expect(reopenedEditor.locator('strong')).toHaveCount(0);
    await expect(reopenedEditor).toContainText('plain text');
  });

  test('a multi-span format card focuses exact spans and reject restores each prior state', async ({
    page,
  }) => {
    await setupMemoryTauri(page, {
      openPath: DOC_PATH,
      files: {
        [DOC_PATH]: '**one** gap two',
        [SIDECAR_PATH]: sidecar({
          suggestions: [
            {
              id: 'fmt-multi',
              type: 'format',
              author: 'claude',
              createdAt: '2026-07-11T18:00:00Z',
              status: 'pending',
              segments: [
                { from: 1, to: 4, text: 'one', adds: ['bold'], removes: [] },
                { from: 9, to: 12, text: 'two', adds: [], removes: ['italic'] },
              ],
            },
          ],
        }),
      },
    });
    await openMemoryFile(page);

    const card = page.locator('.suggestion-card-format');
    await expect(card).toContainText('bold added · italic removed');
    await card.click();
    await expect(page.locator('.annotation-focus')).toHaveCount(2);
    expect(await page.locator('.annotation-focus').allTextContents()).toEqual(['one', 'two']);

    await card.locator('.suggestion-reject-btn').click();
    const editor = page.locator('.ProseMirror');
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(editor.locator('em')).toHaveText('two');
    await expect(card).toHaveCount(0);
  });
});

test.describe('live comment reconciliation', () => {
  test('document shifts keep @claude anchored to the current marked text', async ({ page }) => {
    await openLiveComment(page, { mockAI: true });
    await placeCaretAtDocumentStart(page);
    await page.keyboard.type('XYZ');

    await page.locator('.comment-reply-trigger').click();
    await page.locator('.comment-reply-input').fill('@claude inspect this');
    await page.locator('.comment-card .btn-primary').click();
    await expect.poll(() => page.evaluate(() => Boolean(window.__quillLastSpawnArgs))).toBe(true);

    const prompt = await page.evaluate(
      () => (window.__quillLastSpawnArgs as { prompt: string }).prompt,
    );
    const highlighted = prompt
      .split('=== USER IS COMMENTING ON (highlighted) ===')[1]
      .split('=== PARAGRAPH (context) ===')[0]
      .trim();
    expect(highlighted).toBe('hello');
  });

  test('deleting an entire unresolved anchor removes its card and count', async ({ page }) => {
    await openLiveComment(page);
    await selectCommentSlice(page, 0, 'hello'.length);
    await page.keyboard.press('Backspace');

    await expect(page.locator('mark[data-comment-id="live-comment"]')).toHaveCount(0);
    await expect(page.locator('.comment-card')).toHaveCount(0);
    await expect(page.locator('.comments-head .count-pill')).toHaveText('0');
  });

  test('deleting part of an anchor keeps the comment on the surviving text', async ({ page }) => {
    await openLiveComment(page);
    await selectCommentSlice(page, 3, 5);
    await page.keyboard.press('Backspace');

    await expect(page.locator('mark[data-comment-id="live-comment"]')).toHaveText('hel');
    await expect(page.locator('.comment-card')).toHaveCount(1);
    await expect(page.locator('.comment-anchor-text')).toHaveText('"hel"');
    await expect(page.locator('.comments-head .count-pill')).toHaveText('1');
  });

  test('a fully deleted anchor is not persisted or restored on reopen', async ({ page }) => {
    await openLiveComment(page);
    await selectCommentSlice(page, 0, 'hello'.length);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.dirty-dot')).toHaveCount(0);

    const files = await page.evaluate(() => window.__quillFiles);
    expect(files[SIDECAR_PATH]).toBeUndefined();

    const reopened = await page.context().newPage();
    await setupMemoryTauri(reopened, { files, openPath: DOC_PATH });
    await openMemoryFile(reopened);
    await expect(reopened.locator('.comment-card')).toHaveCount(0);
    await expect(reopened.locator('mark[data-comment-id]')).toHaveCount(0);
  });

  test('resolved comments survive doc updates despite having no live mark', async ({ page }) => {
    await openLiveComment(page, { resolved: true });
    await placeCaretAtDocumentStart(page);
    await page.keyboard.type('X');

    await expect(page.locator('mark[data-comment-id="live-comment"]')).toHaveCount(0);
    await expect(page.locator('.comments-head .filter')).toBeEnabled();
    await page.locator('.comments-head .filter').click();
    await expect(page.locator('.comment-card-resolved')).toBeVisible();
    await expect(page.locator('.comment-anchor-text')).toHaveText('"hello"');
  });

  test('resolving a live comment does not let mark removal delete its record', async ({ page }) => {
    await openLiveComment(page);
    await expect(page.locator('mark[data-comment-id="live-comment"]')).toHaveText('hello');

    await page.locator('.comment-resolve-btn').click();

    await expect(page.locator('mark[data-comment-id="live-comment"]')).toHaveCount(0);
    await expect(page.locator('.comment-card')).toHaveCount(0);
    await expect(page.locator('.comments-head .filter')).toBeEnabled();
    await page.locator('.comments-head .filter').click();
    await expect(page.locator('.comment-card-resolved')).toBeVisible();
    await expect(page.locator('.comment-anchor-text')).toHaveText('"hello"');
  });
});

test.describe('suggestion cards link back to their origin comment', () => {
  const comment = {
    id: 'fixture-comment',
    anchorText: 'hello',
    from: 1,
    to: 6,
    author: 'Reviewer',
    createdAt: '2026-07-11T18:00:00Z',
    resolved: false,
    replies: [],
  };
  // The edit targets "world" — OUTSIDE the comment's highlight ("hello") —
  // exercising the document-scale protocol end to end.
  const EDIT_REPLY =
    'Replaced the noun.\n\n```quill-edits\n{"summary":"Replaced the noun.","edits":[{"find":"world","replace":"planet"}]}\n```';

  async function openWithClaudeEdit(page: import('@playwright/test').Page) {
    await setupMemoryTauri(page, {
      openPath: DOC_PATH,
      savePath: DOC_PATH,
      mockAI: true,
      aiReplyText: EDIT_REPLY,
      files: {
        [DOC_PATH]: 'hello world',
        [SIDECAR_PATH]: sidecar({
          comments: [comment],
          aiSession: ipcFixtures.autoBindSession,
        }),
      },
    });
    await openMemoryFile(page);
    await page.locator('.comment-reply-trigger').click();
    await page.locator('.comment-reply-input').fill('@claude replace the noun');
    await page.locator('.comment-card .btn-primary').click();
    await expect(page.locator('.suggestion-card-replace')).toBeVisible({ timeout: 3000 });
  }

  test('a mocked @claude edit stamps the origin and the card chips back to the comment', async ({
    page,
  }) => {
    await openWithClaudeEdit(page);

    const chip = page.locator('.suggestion-card-replace .suggestion-origin-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('↳ from comment');
    // The chip's tooltip carries the origin comment's anchor text.
    await expect(chip).toHaveAttribute('title', 'hello');

    // Posting the reply leaves the comment active. A provenance chip is a
    // directed jump, so clicking it must not toggle its target back off.
    await expect(page.locator('.suggestion-card-replace')).toHaveClass(/card-origin-active/);
    await chip.click();
    await expect(page.locator('.suggestion-card-replace')).toHaveClass(/card-origin-active/);

    // From a different active annotation, the chip activates the origin.
    await page.locator('.suggestion-card-replace').click();
    await expect(page.locator('.suggestion-card-replace')).not.toHaveClass(/card-origin-active/);
    await chip.click();
    await expect(page.locator('.suggestion-card-replace')).toHaveClass(/card-origin-active/);

    // Saving persists the provenance into the sidecar.
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.dirty-dot')).toHaveCount(0);
    const suggestions = await page.evaluate(
      (path) => JSON.parse(window.__quillFiles[path]).suggestions,
      SIDECAR_PATH,
    );
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions as Array<{ originCommentId?: string }>) {
      expect(s.originCommentId).toBe('fixture-comment');
    }
  });

  test('the chip survives save and reopen', async ({ page }) => {
    await openWithClaudeEdit(page);

    const reopened = await saveNewAndReopen(page);
    const card = reopened.locator('.suggestion-card-replace');
    await expect(card).toBeVisible();
    await expect(card.locator('.suggestion-origin-chip')).toHaveText('↳ from comment');
  });

  test('the chip degrades away when the origin comment no longer exists', async ({ page }) => {
    await openWithClaudeEdit(page);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.dirty-dot')).toHaveCount(0);
    const files = await page.evaluate(
      () => (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles,
    );

    // Reopen with the origin comment stripped from the sidecar: the suggestion
    // still restores, but its provenance points at a deleted comment — no chip.
    const stripped = JSON.parse(files[SIDECAR_PATH]);
    stripped.comments = [];
    const reopened = await page.context().newPage();
    await setupMemoryTauri(reopened, {
      files: { ...files, [SIDECAR_PATH]: JSON.stringify(stripped) },
      openPath: DOC_PATH,
    });
    await openMemoryFile(reopened);

    await expect(reopened.locator('.suggestion-card-replace')).toBeVisible();
    await expect(reopened.locator('.suggestion-origin-chip')).toHaveCount(0);
    await expect(reopened.locator('.card-origin-active')).toHaveCount(0);
  });

  test('the chip reveals and activates a resolved origin comment', async ({ page }) => {
    await openWithClaudeEdit(page);
    await page.locator('.comment-resolve-btn').click();
    await expect(page.locator('.comment-card')).toHaveCount(0);

    const card = page.locator('.suggestion-card-replace');
    const chip = card.locator('.suggestion-origin-chip');
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(page.locator('.comment-card.comment-card-resolved')).toBeVisible();
    await expect(card).toHaveClass(/card-origin-active/);
  });
});

test.describe('review-only mutations participate in dirty-state safety', () => {
  const comment = {
    id: 'fixture-comment',
    anchorText: 'hello',
    from: 1,
    to: 6,
    author: 'Reviewer',
    createdAt: '2026-07-11T18:00:00Z',
    resolved: false,
    replies: [],
  };

  async function openAndEstablishCleanBaseline(
    page: import('@playwright/test').Page,
    resolved = false,
    mockAI = false,
  ) {
    await setupMemoryTauri(page, {
      openPath: DOC_PATH,
      mockAI,
      files: {
        [DOC_PATH]: 'hello world',
        [SIDECAR_PATH]: sidecar({
          comments: [{ ...comment, resolved }],
          ...(mockAI ? { aiSession: ipcFixtures.autoBindSession } : {}),
        }),
      },
    });
    await openMemoryFile(page);
    // Current Tiptap setContent incorrectly marks an open dirty. Saving here
    // isolates each review-only mutation so that bug cannot mask another one.
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.dirty-dot')).toHaveCount(0);
  }

  test('opening a clean file does not mark it dirty', async ({ page }) => {
    await setupMemoryTauri(page, {
      openPath: DOC_PATH,
      files: { [DOC_PATH]: 'clean content', [SIDECAR_PATH]: sidecar() },
    });
    await openMemoryFile(page);
    await expect(page.locator('.dirty-dot')).toHaveCount(0);
  });

  test('adding a user reply marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page);
    await page.locator('.comment-reply-trigger').click();
    await page.locator('.comment-reply-input').fill('persist me');
    await page.locator('.comment-card .btn-primary').click();
    await expect(page.locator('.dirty-dot')).toBeVisible();
  });

  test('finishing an AI reply marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page, false, true);
    await page.locator('.comment-reply-trigger').click();
    await page.locator('.comment-reply-input').fill('@claude answer this');
    await page.locator('.comment-card .btn-primary').click();
    await expect(page.locator('.comment-reply-ai')).toContainText('Persist this answer.');
    await expect(page.locator('.dirty-dot')).toBeVisible();
  });

  test('resolving a comment marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page);
    await page.locator('.comment-resolve-btn').click();
    await expect(page.locator('.dirty-dot')).toBeVisible();
  });

  test('unresolving a comment marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page, true);
    await page.locator('.comments-head .filter').click();
    await page.locator('.comment-resolve-btn').click();
    await expect(page.locator('.dirty-dot')).toBeVisible();
  });

  test('deleting a resolved comment marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page, true);
    await page.locator('.comments-head .filter').click();
    await page.locator('.comment-delete-btn').click();
    await expect(page.locator('.dirty-dot')).toBeVisible();
  });
});

test.describe('desktop fallback regressions', () => {
  test('native menu events use the latest open-file save handler', async ({ page }) => {
    await setupMemoryTauri(page, {
      files: { '/docs/menu.md': 'before' },
      openPath: '/docs/menu.md',
    });
    await page.goto('/');
    await openMemoryFile(page);
    await page.locator('.ProseMirror').press('End');
    await page.keyboard.type(' after');

    await page.evaluate(() => {
      window.__quillEmit?.('menu-save');
    });

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            window.__quillCalls.filter(
              (call) => call.cmd === 'write_file' && call.args?.path === '/docs/menu.md',
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__quillFiles['/docs/menu.md'])).toContain('after');
  });

  test('Cmd+Shift+S with an uppercase shifted key invokes Save As', async ({ page }) => {
    await setupMemoryTauri(page, { savePath: '/tmp/save-as.md' });
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('dirty');
    await page.evaluate(() => {
      (window as unknown as { __quillCalls: unknown[] }).__quillCalls.length = 0;
    });
    await page.keyboard.press('ControlOrMeta+Shift+S');

    const commands = await page.evaluate(() =>
      (window as unknown as { __quillCalls: Array<{ cmd: string }> }).__quillCalls.map(
        (call) => call.cmd,
      ),
    );
    expect(commands).toContain('show_save_dialog');
  });

  test('footer line number follows the cursor paragraph, not schema depth', async ({ page }) => {
    await setupMemoryTauri(page);
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');

    await expect(page.locator('.footer')).toContainText('LN 3:6');
  });
});
