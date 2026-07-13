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
              await new Promise((resolve) => setTimeout(resolve, 35));
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

test('Stop cancels a live turn and Retry reuses the same message', async ({ page }) => {
  await setupChatScripts(page, [
    [{ kind: 'delta', text: 'Partial response' }, { kind: 'pause' }],
    [{ kind: 'delta', text: 'Recovered response' }, { kind: 'done' }],
  ]);
  await openChat(page);
  await sendChat(page, 'Explain the draft');
  const assistant = page.locator('.chat-message-assistant').last();
  await expect(assistant).toContainText('Partial response');
  await assistant.getByRole('button', { name: 'Stop' }).click();
  await expect(assistant).toContainText('Stopped');
  await assistant.getByRole('button', { name: 'Retry' }).click();
  await expect(assistant).toContainText('Recovered response', { timeout: 3000 });
  await expect(page.locator('.chat-message-assistant')).toHaveCount(1);
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
  await expect(page.locator('.session-picker')).toBeVisible();
  await expect(activeTabHost(page).locator('.chat-message')).toHaveCount(0);

  await page.locator('.session-picker-new').click();
  await expect(page.locator('.session-picker')).toHaveCount(0);
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
  await page.waitForTimeout(400);
  await expect(activeEditor(page)).toHaveText('Second tab text');
  await expect(activeTabHost(page).locator('.suggestion-card')).toHaveCount(0);

  await page.locator('.document-tab').first().click();
  await activeTabHost(page)
    .getByRole('tab', { name: /Comments/ })
    .click();
  await expect(activeTabHost(page).locator('.suggestion-card-replace')).toBeVisible();
  await expect(activeEditor(page)).toContainText('First tab text');
});
