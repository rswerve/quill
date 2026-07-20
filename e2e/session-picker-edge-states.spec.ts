import { expect, test } from './fixtures';
import { activeEditor, setupMemoryTauri } from './helpers/memoryTauri';

const EXISTING_SESSION = {
  sessionId: 'existing-session-id',
  jsonlPath: '/tmp/existing-session.jsonl',
  cwd: '/tmp/project',
  title: 'Existing writing session',
  documentName: null,
  lastUsed: 1_784_071_200,
};

async function openPicker(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^(Link|Change) Claude session/ }).click();
  const picker = page.getByRole('dialog', { name: 'Link Claude Code session' });
  await expect(picker).toBeVisible();
  return picker;
}

test('a session-list failure is explicit and Cancel returns to the untouched document', async ({
  page,
}) => {
  await setupMemoryTauri(page);
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__ as {
      invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    const originalInvoke = internals.invoke.bind(internals);
    internals.invoke = async (cmd, args) => {
      if (cmd === 'list_claude_sessions') throw new Error('Claude session directory unavailable');
      return originalInvoke(cmd, args);
    };
  });

  const picker = await openPicker(page);
  await expect(picker.getByText('Claude session directory unavailable')).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unlink Claude session' })).toHaveCount(0);
  await expect(activeEditor(page)).toBeEditable();
});

test('an empty picker explains the state and keeps local note-taking available', async ({
  page,
}) => {
  await setupMemoryTauri(page, { claudeSessions: [] });

  const picker = await openPicker(page);
  await expect(picker.getByText(/No Claude Code sessions found/)).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Start new session' })).toBeDisabled();
  await expect(picker.getByText(/Save the document first/)).toBeVisible();
  await picker.getByRole('button', { name: 'Close' }).click();

  await activeEditor(page).click();
  await page.keyboard.type('Local work continues');
  await expect(activeEditor(page)).toContainText('Local work continues');
});

test('Cancel after previewing a session never binds or records it', async ({ page }) => {
  await setupMemoryTauri(page, {
    claudeSessions: [EXISTING_SESSION],
    sessionPreviews: {
      [EXISTING_SESSION.jsonlPath]: {
        sessionId: EXISTING_SESSION.sessionId,
        cwd: EXISTING_SESSION.cwd,
        recentAssistantMessages: ['A real preview message'],
      },
    },
  });

  const picker = await openPicker(page);
  await picker.getByRole('button', { name: 'Existing writing session' }).click();
  await expect(picker.getByText('A real preview message')).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Link this session' })).toBeEnabled();
  await picker.getByRole('button', { name: 'Cancel' }).click();

  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unlink Claude session' })).toHaveCount(0);
  const bindingCalls = await page.evaluate(() =>
    window.__quillCalls.filter((call) => call.cmd === 'record_session_document'),
  );
  expect(bindingCalls).toEqual([]);
});
