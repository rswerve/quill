import { expect, test, type Page } from '@playwright/test';
import { ipcFixtures } from './helpers/ipcFixtures';
import {
  activeEditor,
  activeTabHost,
  openMemoryFile,
  setupMemoryTauri,
} from './helpers/memoryTauri';

type MockScriptStep =
  | { kind: 'model'; model: string }
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'pause' };

async function setupChatScripts(page: Page, scripts: MockScriptStep[][]) {
  await page.addInitScript(
    ({ scriptList, session }) => {
      type Event =
        | { kind: 'model'; model: string }
        | { kind: 'delta'; text: string }
        | { kind: 'done' }
        | { kind: 'error'; message: string }
        | { kind: 'cancelled' };
      let spawnIndex = 0;
      let nextToken = 0;
      const cancelers = new Map<string, () => void>();
      const globals = window as unknown as Record<string, unknown>;
      globals.__quillTestSession = session;
      globals.__quillMock = {
        spawn: (args: unknown, onEvent: (event: Event) => void) => {
          globals.__quillLastSpawnArgs = args;
          const steps = scriptList[Math.min(spawnIndex++, scriptList.length - 1)];
          globals.__quillSpawnCount = spawnIndex;
          const token = `chat-${++nextToken}`;
          let cancelled = false;
          cancelers.set(token, () => {
            cancelled = true;
            onEvent({ kind: 'cancelled' });
            cancelers.delete(token);
          });
          void (async () => {
            for (const step of steps) {
              if (cancelled) return;
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (cancelled) return;
              if (step.kind === 'pause') return;
              onEvent(step);
              if (step.kind === 'done' || step.kind === 'error') {
                cancelers.delete(token);
                return;
              }
            }
          })();
          return token;
        },
        cancel: (token: string) => cancelers.get(token)?.(),
      };
    },
    { scriptList: scripts, session: ipcFixtures.autoBindSession },
  );
  await page.goto('/');
  await activeEditor(page).waitFor({ timeout: 5000 });
}

async function openChat(page: Page) {
  const host = activeTabHost(page);
  await host.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(host.locator('.chat-view')).toBeVisible();
}

async function sendChat(page: Page, text: string) {
  const composer = activeTabHost(page).getByLabel('Ask Claude about this document');
  await composer.fill(text);
  await composer.press('ControlOrMeta+Enter');
}

test('chat streams a suggestions-only edit with bidirectional provenance', async ({ page }) => {
  const reply =
    'I tightened the sentence.\n```quill-edits\n' +
    JSON.stringify({
      summary: 'Tightened the sentence.',
      edits: [{ find: 'The opening is too long', replace: 'The opening is concise' }],
    }) +
    '\n```';
  await setupChatScripts(page, [
    [
      { kind: 'model', model: 'claude-sonnet' },
      { kind: 'delta', text: reply.slice(0, 19) },
      { kind: 'delta', text: reply.slice(19) },
      { kind: 'done' },
    ],
  ]);
  await activeEditor(page).fill('The opening is too long');
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.getByLabel('Ask Claude about this document')).toBeFocused();
  await sendChat(page, 'Make the opening concise');

  const assistant = page.locator('.chat-message-assistant').last();
  await expect(assistant).toContainText('I tightened the sentence.', { timeout: 3000 });
  await expect(assistant).not.toContainText('quill-edits');
  await expect(assistant.locator('.chat-assistant-model')).toHaveText('claude-sonnet');
  const jump = assistant.locator('.chat-suggestion-chip');
  await expect(jump).toBeVisible();
  await expect(jump).toHaveText(/→ 1 suggestion in the doc/);
  await expect(activeTabHost(page).locator('.panel-tab-count')).toHaveText('1');
  await expect(page.locator('[title="Accept all suggestions"] .review-count')).toHaveText('1');
  await expect(page.locator('[title="Reject all suggestions"] .review-count')).toHaveText('1');
  await jump.click();

  const suggestion = activeTabHost(page).locator('.suggestion-card-replace');
  await expect(suggestion).toBeVisible();
  await expect(suggestion.getByRole('button', { name: '↳ from chat' })).toBeVisible();
  await expect(activeTabHost(page).locator('.comment-card')).toHaveCount(0);
  await suggestion.getByRole('button', { name: '↳ from chat' }).click();
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(assistant).toBeFocused();

  const spawn = await page.evaluate(
    () => (window as unknown as { __quillLastSpawnArgs: { prompt: string } }).__quillLastSpawnArgs,
  );
  expect(spawn.prompt).toContain('=== FULL DOCUMENT ===');
  expect(spawn.prompt).toContain('The opening is too long');
  expect(spawn.prompt).not.toContain('quill-comments');
});

test('chat applies a Markdown-spelled link edit as one tracked link replacement', async ({
  page,
}) => {
  const reply =
    "I'll clean up the placeholder header and link text.\n```quill-edits\n" +
    JSON.stringify({
      summary: 'Cleaned up the first two test lines.',
      edits: [
        { find: 'Header', replace: 'Test Notes' },
        {
          find: '[some text](https://www.cnn.com)',
          replace: '[CNN](https://www.cnn.com)',
        },
      ],
    }) +
    '\n```';
  await setupChatScripts(page, [
    [{ kind: 'model', model: 'claude-sonnet' }, { kind: 'delta', text: reply }, { kind: 'done' }],
  ]);

  const editor = activeEditor(page);
  await editor.click();
  await page.keyboard.type('# Header');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[some text](https://www.cnn.com)');
  await expect(editor.locator('a')).toHaveText('some text');

  await page.keyboard.press('ControlOrMeta+/');
  await sendChat(page, 'Can you clean up the first two test lines here?');
  const assistant = activeTabHost(page).locator('.chat-message-assistant').last();
  await expect(assistant.locator('.chat-suggestion-chip')).toHaveText(/→ 2 suggestions in the doc/);
  await expect(assistant).not.toContainText('change was skipped');
  await assistant.locator('.chat-suggestion-chip').click();

  const replacements = activeTabHost(page).locator('.suggestion-card-replace');
  await expect(replacements).toHaveCount(2);
  const linkReplacement = replacements.filter({ hasText: 'CNN' });
  await linkReplacement.getByRole('button', { name: 'Accept' }).click();
  await expect(editor.locator('a')).toHaveText('CNN');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://www.cnn.com');

  const spawn = await page.evaluate(
    () => (window as unknown as { __quillLastSpawnArgs: { prompt: string } }).__quillLastSpawnArgs,
  );
  expect(spawn.prompt).toContain('{"find":"some text","replace":"better text"}');
  expect(spawn.prompt).toContain('visible text only');
});

test('chat identifies a skipped edit and its precise reason', async ({ page }) => {
  const reply =
    'I could not apply one requested change.\n```quill-edits\n' +
    JSON.stringify({
      summary: 'Tried the requested change.',
      edits: [{ find: 'missing phrase', replace: 'new phrase' }],
    }) +
    '\n```';
  await setupChatScripts(page, [[{ kind: 'delta', text: reply }, { kind: 'done' }]]);
  await activeEditor(page).fill('The document has other text.');
  await openChat(page);
  await sendChat(page, 'Fix the missing phrase');

  const assistant = activeTabHost(page).locator('.chat-message-assistant').last();
  await expect(assistant).toContainText('1 change was skipped:');
  await expect(assistant).toContainText('“missing phrase” — text wasn’t found.');
  await expect(assistant).not.toContainText('was already formatted as proposed');
});

test('chat shows a thinking indicator before the first streamed delta', async ({ page }) => {
  await setupChatScripts(page, [[{ kind: 'pause' }]]);
  await openChat(page);
  await sendChat(page, 'Think about this draft');

  const assistant = activeTabHost(page).locator('.chat-message-assistant').last();
  await expect(assistant.getByRole('status')).toHaveText('Claude is thinking…');
  await expect(assistant.locator('.chat-thinking-dot')).toBeVisible();
  await expect(assistant.locator('.chat-stream-caret')).toHaveCount(0);
  await expect(assistant.getByRole('button', { name: 'Stop' })).toHaveClass(/chat-stop-btn/);
});

test('Stop cancels a live turn and Retry reuses the same message', async ({ page }) => {
  await setupChatScripts(page, [
    [{ kind: 'delta', text: 'Partial response' }, { kind: 'pause' }],
    [{ kind: 'delta', text: 'Recovered response' }, { kind: 'done' }],
  ]);
  await openChat(page);
  await sendChat(page, 'Explain the draft');
  const assistant = page.locator('.chat-message-assistant').last();
  await expect(assistant).toContainText('Partial response');
  await expect(assistant.locator('.chat-stream-caret')).toBeVisible();
  await expect(assistant.getByRole('status')).toHaveCount(0);
  const stop = assistant.getByRole('button', { name: 'Stop' });
  await expect(stop).toHaveClass(/chat-action-btn/);
  await expect(stop.locator('svg')).toBeVisible();
  await stop.click();
  await expect(assistant).toContainText('Stopped');
  const retry = assistant.getByRole('button', { name: 'Retry' });
  await expect(retry).toHaveClass(/chat-action-btn/);
  await expect(assistant.getByRole('button', { name: 'Dismiss' })).toHaveClass(/chat-action-btn/);
  await retry.click();
  await expect(assistant).toContainText('Recovered response', { timeout: 3000 });
  await expect(page.locator('.chat-message-assistant')).toHaveCount(1);
});

test('document chat and anchored Claude replies never resume the same session concurrently', async ({
  page,
}) => {
  await setupChatScripts(page, [
    [{ kind: 'delta', text: 'Still working…' }, { kind: 'pause' }],
    [{ kind: 'delta', text: 'Comment reply complete.' }, { kind: 'done' }],
  ]);
  await activeEditor(page).fill('One document, one session');
  await openChat(page);
  await sendChat(page, 'Review the whole draft');
  await expect(page.locator('.chat-message-assistant').last()).toContainText('Still working…');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __quillSpawnCount: number }).__quillSpawnCount),
    )
    .toBe(1);

  await activeTabHost(page)
    .getByRole('tab', { name: /Comments/ })
    .click();
  await activeEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill('Please tighten this');
  await page.getByRole('button', { name: 'Ask Claude', exact: true }).click();

  const busyReply = activeTabHost(page).locator('.comment-reply-ai').last();
  await expect(busyReply).toContainText('already responding in this document');
  const spawnCountWhileBusy = await page.evaluate(
    () => (window as unknown as { __quillSpawnCount: number }).__quillSpawnCount,
  );
  expect(spawnCountWhileBusy).toBe(1);

  await activeTabHost(page).getByRole('tab', { name: 'Chat', exact: true }).click();
  await page
    .locator('.chat-message-assistant')
    .last()
    .getByRole('button', { name: 'Stop' })
    .click();
  await activeTabHost(page)
    .getByRole('tab', { name: /Comments/ })
    .click();
  await busyReply.getByRole('button', { name: 'Retry' }).click();
  await expect(busyReply).toContainText('Comment reply complete.');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __quillSpawnCount: number }).__quillSpawnCount),
    )
    .toBe(2);
});

test('the first no-session send queues through the picker and starts after linking', async ({
  page,
}) => {
  const path = '/docs/queued-chat.md';
  await setupMemoryTauri(page, {
    files: { [path]: 'Saved document' },
    openPath: path,
    mockAI: true,
    aiReplyText: 'Queued turn received.',
  });
  await openMemoryFile(page);
  await openChat(page);
  await sendChat(page, 'Please summarize this');
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toBeVisible();
  await expect(activeTabHost(page).locator('.chat-message')).toHaveCount(0);

  await page.getByRole('button', { name: 'Start new session' }).click();
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toHaveCount(0);
  await expect(activeTabHost(page).locator('.chat-message-user')).toHaveText(
    'Please summarize this',
  );
  await expect(activeTabHost(page).locator('.chat-message-assistant')).toContainText(
    'Queued turn received.',
  );
  const spawn = await page.evaluate(
    () =>
      (
        window as unknown as {
          __quillLastSpawnArgs: { cwd: string; allowCreate: boolean; prompt: string };
        }
      ).__quillLastSpawnArgs,
  );
  expect(spawn).toMatchObject({ cwd: '/docs', allowCreate: true });
  expect(spawn.prompt).toContain('USER MESSAGE:\nPlease summarize this');
});

test('an imported sidecar cannot silently grant Claude filesystem scope', async ({ page }) => {
  const path = '/docs/imported.md';
  const sidecarPath = '/docs/imported.comments.json';
  const untrustedRoot = '/private/imported-secret';
  await setupMemoryTauri(page, {
    files: {
      [path]: 'Imported document',
      [sidecarPath]: JSON.stringify({
        version: 2,
        comments: [],
        suggestions: [],
        aiSession: {
          provider: 'claude-code',
          sessionId: 'imported-session',
          cwd: untrustedRoot,
          linkedAt: '2026-07-13T00:00:00.000Z',
          createdByQuill: false,
        },
        contextFolder: untrustedRoot,
      }),
    },
    openPath: path,
    mockAI: true,
    aiReplyText: 'Safe local response.',
  });

  await openMemoryFile(page);
  const permissionNotice = page.getByRole('dialog', { name: 'Reconnect Claude access' });
  await expect(permissionNotice).toContainText('Reconnect Claude access');
  await expect(permissionNotice.getByRole('button', { name: 'Relink session' })).toBeVisible();
  await expect(permissionNotice.getByRole('button', { name: 'Choose folder' })).toBeVisible();
  await expect(permissionNotice.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  const spawnedBeforeConsent = await page.evaluate(
    () => (window as unknown as { __quillLastSpawnArgs?: unknown }).__quillLastSpawnArgs,
  );
  expect(spawnedBeforeConsent).toBeUndefined();
  await permissionNotice.getByRole('button', { name: 'Relink session' }).click();
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toBeVisible();
  const stillNotSpawned = await page.evaluate(
    () => (window as unknown as { __quillLastSpawnArgs?: unknown }).__quillLastSpawnArgs,
  );
  expect(stillNotSpawned).toBeUndefined();

  await page.getByRole('button', { name: 'Start new session' }).click();
  await openChat(page);
  await sendChat(page, 'Review this imported document');
  await expect(activeTabHost(page).locator('.chat-message-assistant')).toContainText(
    'Safe local response.',
  );
  const spawn = await page.evaluate(
    () =>
      (
        window as unknown as {
          __quillLastSpawnArgs: { cwd: string; addDir: string | null; allowCreate: boolean };
        }
      ).__quillLastSpawnArgs,
  );
  expect(spawn).toMatchObject({ cwd: '/docs', addDir: null, allowCreate: true });
  expect(spawn.cwd).not.toBe(untrustedRoot);
});

test('a Quill-created sidecar session reopens silently with a constrained cwd', async ({
  page,
}) => {
  const path = '/docs/local.md';
  const sidecarPath = '/docs/local.comments.json';
  await setupMemoryTauri(page, {
    files: {
      [path]: 'Local document',
      [sidecarPath]: JSON.stringify({
        version: 2,
        comments: [],
        suggestions: [],
        aiSession: {
          provider: 'claude-code',
          sessionId: 'local-session',
          cwd: '/private/untrusted-sidecar-value',
          linkedAt: '2026-07-13T00:00:00.000Z',
          createdByQuill: true,
        },
      }),
    },
    openPath: path,
    mockAI: true,
    aiReplyText: 'Reopened safely.',
  });

  await openMemoryFile(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toHaveCount(0);
  await openChat(page);
  await sendChat(page, 'Continue');
  await expect(activeTabHost(page).locator('.chat-message-assistant')).toContainText(
    'Reopened safely.',
  );
  const spawn = await page.evaluate(
    () =>
      (
        window as unknown as {
          __quillLastSpawnArgs: { cwd: string; addDir: string | null; allowCreate: boolean };
        }
      ).__quillLastSpawnArgs,
  );
  expect(spawn).toMatchObject({ cwd: '/docs', addDir: null, allowCreate: true });
});

test('an imported context folder is confirmed for the loaded document path', async ({ page }) => {
  const path = '/docs/context.md';
  const sidecarPath = '/docs/context.comments.json';
  const folder = '/refs/imported';
  await setupMemoryTauri(page, {
    files: {
      [path]: 'Context document',
      [sidecarPath]: JSON.stringify({
        version: 2,
        comments: [],
        suggestions: [],
        contextFolder: folder,
      }),
    },
    openPath: path,
    folderPath: folder,
  });

  await openMemoryFile(page);
  const notice = page.getByRole('dialog', { name: 'Reconnect Claude access' });
  await expect(notice).toContainText('This document had a reference folder');
  await notice.getByRole('button', { name: 'Choose folder' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('quill-sidecar-permissions-v1') ?? '{}')),
    )
    .toMatchObject({
      '/docs/context.md': { contextFolder: folder },
    });
});

test('chat persists per document/session and a new session starts a fresh thread', async ({
  page,
}) => {
  const path = '/docs/persistent-chat.md';
  const sidecarPath = '/docs/persistent-chat.comments.json';
  await setupMemoryTauri(page, {
    files: {
      [path]: 'Persistent document',
      [sidecarPath]: JSON.stringify({
        version: 2,
        comments: [],
        suggestions: [],
        aiSession: ipcFixtures.autoBindSession,
      }),
    },
    openPath: path,
    mockAI: true,
    aiReplyText: 'This answer should persist.',
    trustedSidecarPaths: [path],
  });
  await openMemoryFile(page);
  await openChat(page);
  await sendChat(page, 'Remember this turn');
  await expect(activeTabHost(page).locator('.chat-message-assistant')).toContainText(
    'This answer should persist.',
  );
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.dirty-dot')).toHaveCount(0);
  const persisted = await page.evaluate((savedSidecarPath) => {
    const files = (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles;
    return JSON.parse(files[savedSidecarPath]);
  }, sidecarPath);
  expect(persisted.chat).toMatchObject({
    sessionId: ipcFixtures.autoBindSession.sessionId,
    messages: [
      { role: 'user', text: 'Remember this turn' },
      { role: 'assistant', text: 'This answer should persist.' },
    ],
  });

  await page.reload();
  await activeEditor(page).waitFor();
  await openChat(page);
  await expect(activeTabHost(page).locator('.chat-message-user')).toHaveText('Remember this turn');
  await expect(activeTabHost(page).locator('.chat-message-assistant')).toContainText(
    'This answer should persist.',
  );

  const active = activeTabHost(page);
  await active.getByRole('button', { name: 'Chat session menu' }).click();
  await active.getByRole('menuitem', { name: 'Start new session' }).click();
  await expect(active.locator('.chat-message')).toHaveCount(0);
  await expect(active.locator('.panel-session-chip')).not.toContainText(
    ipcFixtures.autoBindSession.sessionId.slice(0, 8).toUpperCase(),
  );
});

test('a background tab finishes only its own chat suggestions', async ({ page }) => {
  const editReply =
    'Done.\n```quill-edits\n' +
    JSON.stringify({
      summary: 'Done.',
      edits: [{ find: 'First tab text', replace: 'First edit' }],
    }) +
    '\n```';
  await setupChatScripts(page, [
    [
      { kind: 'delta', text: 'Working…' },
      { kind: 'delta', text: 'still working…' },
      { kind: 'delta', text: editReply },
      { kind: 'done' },
    ],
  ]);
  await activeEditor(page).fill('First tab text');
  await openChat(page);
  await sendChat(page, 'Revise it');
  await page.locator('.tab-add').click();
  await activeEditor(page).fill('Second tab text');
  const firstTab = page.locator('.document-tab-host').first();
  await expect(firstTab.locator('.chat-suggestion-chip')).toHaveText(/→ 1 suggestion in the doc/);
  await expect(activeEditor(page)).toHaveText('Second tab text');
  await expect(activeTabHost(page).locator('.suggestion-card')).toHaveCount(0);

  await page.locator('.document-tab').first().click();
  await activeTabHost(page)
    .getByRole('tab', { name: /Comments/ })
    .click();
  await expect(activeTabHost(page).locator('.suggestion-card-replace')).toBeVisible();
  await expect(activeEditor(page)).toContainText('First tab text');
});
