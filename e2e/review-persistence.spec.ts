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
  await expect(page.locator('.footer-dirty')).toHaveCount(0);
  const files = await page.evaluate(
    () => (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles,
  );
  const reopened = await page.context().newPage();
  await setupMemoryTauri(reopened, { files, openPath: DOC_PATH });
  await openMemoryFile(reopened);
  await expect(reopened.locator('.footer-filename')).toContainText('review-persistence.md');
  return reopened;
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
    await expect(chip).toHaveText('↳ comment');
    // The chip's tooltip carries the origin comment's anchor text.
    await expect(chip).toHaveAttribute('title', 'hello');

    // Posting the reply may have left the comment active (composer clicks
    // bubble to the card). Activate the suggestion first so the chip click
    // below deterministically activates — not toggles — the comment.
    await page.locator('.suggestion-card-replace').click();
    await expect(page.locator('.suggestion-card-replace')).not.toHaveClass(/card-origin-active/);

    // Clicking the chip activates the origin comment, which outlines its
    // child suggestion card (the reverse link).
    await chip.click();
    await expect(page.locator('.suggestion-card-replace')).toHaveClass(/card-origin-active/);

    // Saving persists the provenance into the sidecar.
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.footer-dirty')).toHaveCount(0);
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
    await expect(card.locator('.suggestion-origin-chip')).toHaveText('↳ comment');
  });

  test('the chip degrades away when the origin comment no longer exists', async ({ page }) => {
    await openWithClaudeEdit(page);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.footer-dirty')).toHaveCount(0);
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
    await expect(page.locator('.footer-dirty')).toHaveCount(0);
  }

  test('opening a clean file does not mark it dirty', async ({ page }) => {
    await setupMemoryTauri(page, {
      openPath: DOC_PATH,
      files: { [DOC_PATH]: 'clean content', [SIDECAR_PATH]: sidecar() },
    });
    await openMemoryFile(page);
    await expect(page.locator('.footer-dirty')).toHaveCount(0);
  });

  test('adding a user reply marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page);
    await page.locator('.comment-reply-trigger').click();
    await page.locator('.comment-reply-input').fill('persist me');
    await page.locator('.comment-card .btn-primary').click();
    await expect(page.locator('.footer-dirty')).toBeVisible();
  });

  test('finishing an AI reply marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page, false, true);
    await page.locator('.comment-reply-trigger').click();
    await page.locator('.comment-reply-input').fill('@claude answer this');
    await page.locator('.comment-card .btn-primary').click();
    await expect(page.locator('.comment-reply-ai')).toContainText('Persist this answer.');
    await expect(page.locator('.footer-dirty')).toBeVisible();
  });

  test('resolving a comment marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page);
    await page.locator('.comment-resolve-btn').click();
    await expect(page.locator('.footer-dirty')).toBeVisible();
  });

  test('unresolving a comment marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page, true);
    await page.locator('.show-resolved-btn').click();
    await page.locator('.comment-resolve-btn').click();
    await expect(page.locator('.footer-dirty')).toBeVisible();
  });

  test('deleting a resolved comment marks the document dirty', async ({ page }) => {
    await openAndEstablishCleanBaseline(page, true);
    await page.locator('.show-resolved-btn').click();
    await page.locator('.comment-delete-btn').click();
    await expect(page.locator('.footer-dirty')).toBeVisible();
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

    await expect(page.locator('.footer')).toContainText('Line 3, Col 6');
  });
});
