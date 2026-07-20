/**
 * Playwright coverage for the AI comment-reply state machine.
 *
 * The real `spawn_claude_resume` Tauri command isn't available in CI, so each
 * test installs `window.__quillMock` via `page.addInitScript()` before the app
 * mounts. The mock plays scripted ChunkEvents and `window.__quillTestSession`
 * seeds a fake binding so the anchored Ask-Claude path runs without a SessionPicker.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { expectSelectionText } from './helpers/deterministicWaits';
import { ipcFixtures } from './helpers/ipcFixtures';
import { activeEditor, openMemoryFile, setupMemoryTauri } from './helpers/memoryTauri';

type MockScriptStep =
  | { kind: 'model'; model: string }
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'gate'; name: string }
  | { kind: 'pause' }; // hold open until cancel

// Installs a mock that plays a DIFFERENT script for each successive spawn. The
// Nth spawn (0-indexed) plays scripts[N]; once past the end, the last script
// repeats. This lets a test drive an error-then-success retry flow: the first
// spawn fails, the retry (a second spawn) succeeds.
async function setupWithMockScripts(
  page: Page,
  scripts: MockScriptStep[][],
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ({
      scriptList,
      overrides,
      session,
    }: {
      scriptList: MockScriptStep[][];
      overrides: Record<string, unknown>;
      session: Record<string, unknown>;
    }) => {
      type Ev =
        | { kind: 'model'; model: string }
        | { kind: 'delta'; text: string }
        | { kind: 'done' }
        | { kind: 'error'; message: string }
        | { kind: 'cancelled' };

      let nextTokenId = 0;
      let spawnIndex = 0;
      const pending = new Map<string, () => void>(); // token → cancel resolver
      const releasedGates = new Set<string>();
      const gateWaiters = new Map<string, () => void>();

      (
        window as unknown as { __quillReleaseMockGate: (name: string) => void }
      ).__quillReleaseMockGate = (name) => {
        releasedGates.add(name);
        gateWaiters.get(name)?.();
        gateWaiters.delete(name);
      };

      (window as unknown as { __quillTestSession: unknown }).__quillTestSession = {
        ...session,
        ...overrides,
      };

      (window as unknown as { __quillMock: unknown }).__quillMock = {
        spawn: (args: unknown, onEvent: (e: Ev) => void) => {
          // Exposed so tests can assert on what the app would send the backend.
          (window as unknown as { __lastSpawnArgs: unknown }).__lastSpawnArgs = args;
          const steps = scriptList[Math.min(spawnIndex, scriptList.length - 1)];
          spawnIndex++;
          const token = `mock-${++nextTokenId}`;
          let cancelled = false;
          pending.set(token, () => {
            cancelled = true;
            onEvent({ kind: 'cancelled' });
            pending.delete(token);
          });
          (async () => {
            for (const step of steps) {
              if (cancelled) return;
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (cancelled) return;
              if (step.kind === 'pause') {
                // Park indefinitely; only cancel will resolve.
                await new Promise(() => undefined);
                return;
              }
              if (step.kind === 'gate') {
                if (!releasedGates.has(step.name)) {
                  await new Promise<void>((resolve) => gateWaiters.set(step.name, resolve));
                }
                continue;
              }
              onEvent(step as Ev);
              if (step.kind === 'done' || step.kind === 'error') {
                pending.delete(token);
                return;
              }
            }
          })();
          return token;
        },
        cancel: (token: string) => {
          pending.get(token)?.();
        },
      };
    },
    { scriptList: scripts, overrides: sessionOverrides, session: ipcFixtures.autoBindSession },
  );

  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
}

// The common case: one script replayed for every spawn.
async function setupWithMock(
  page: Page,
  script: MockScriptStep[],
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {
  await setupWithMockScripts(page, [script], sessionOverrides);
}

async function addCommentWithAIReply(page: Page, anchor: string, replyText: string) {
  await page.keyboard.type(anchor);
  // Select all
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, anchor);
  // Open the anchored composer and ask Claude directly.
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  await page.locator('[data-card-id="comment-composer"] textarea').fill(replyText);
  await page.getByRole('button', { name: 'Ask Claude' }).click();
}

// Mounts the app WITHOUT seeding a session, so Ask Claude must link first.
// Used to verify the prompt-to-link behavior.
async function setupWithoutSession(page: Page): Promise<void> {
  await page.goto('/');
  const editor = activeEditor(page);
  await editor.waitFor({ timeout: 5000 });
  await editor.click();
  await expect(editor).toBeFocused();
}

// Creates a Claude thread directly from the anchored composer.
async function addClaudeThread(page: Page, anchor: string, body: string) {
  await page.keyboard.type(anchor);
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, anchor);
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  await page.locator('[data-card-id="comment-composer"] textarea').fill(body);
  await page.getByRole('button', { name: /Ask Claude|Link a session to ask/ }).click();
}

async function addLocalNote(page: Page, anchor: string, body: string) {
  await page.keyboard.type(anchor);
  await page.keyboard.press('ControlOrMeta+a');
  await expectSelectionText(page, anchor);
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  await page.locator('[data-card-id="comment-composer"] textarea').fill(body);
  await page.getByRole('button', { name: 'Add note' }).click();
}

test('local note stays private and never starts an AI request', async ({ page }) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'Must not appear.' }, { kind: 'done' }]);

  await addLocalNote(page, 'hello world', 'Remember this');

  const note = page.locator('[data-comment-card="note"]');
  await expect(note).toContainText('Remember this');
  await expect(note.getByText('Note', { exact: true })).toHaveText('Note');
  await expect(page.locator('mark.comment-mark[data-comment-kind="note"]')).toHaveText(
    'hello world',
  );
  await expect(page.locator('[data-reply-role="ai"]')).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(
    await page.evaluate(() => (window as unknown as { __lastSpawnArgs?: unknown }).__lastSpawnArgs),
  ).toBeUndefined();
});

test('promoting a note converts its identity and asks Claude once', async ({ page }) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'Promoted response.' }, { kind: 'done' }]);
  await addLocalNote(page, 'hello world', 'Please review this');

  await page.getByRole('button', { name: 'Ask Claude about this' }).click();

  const thread = page.locator('[data-comment-card="claude"]');
  await expect(thread).toContainText('Please review this');
  await expect(thread.getByText('Note', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-comment-card="note"]')).toHaveCount(0);
  await expect(page.locator('mark.comment-mark[data-comment-kind="claude"]')).toHaveText(
    'hello world',
  );
  await expect(thread.locator('[data-reply-role="ai"] [data-reply-text]')).toContainText(
    'Promoted response.',
  );
  expect(
    await page.evaluate(() => (window as unknown as { __lastSpawnArgs?: unknown }).__lastSpawnArgs),
  ).toBeDefined();
});

test('AI reply: pending → delta → done streams chunks and clears spinner', async ({ page }) => {
  await setupWithMock(page, [
    { kind: 'gate', name: 'pending-visible' },
    { kind: 'model', model: 'claude-fable-5' },
    { kind: 'delta', text: 'Sure — ' },
    { kind: 'delta', text: 'the answer ' },
    { kind: 'delta', text: 'is 42.' },
    { kind: 'done' },
  ]);

  await expect(page.getByRole('group', { name: 'Claude settings' })).toHaveAttribute(
    'title',
    'Model: Auto — Claude decides\nEffort: Auto — Claude decides',
  );

  await addCommentWithAIReply(page, 'hello world', 'What is the answer?');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  // Spinner present while streaming.
  await expect(aiReply.locator('[data-ai-spinner]')).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __quillReleaseMockGate: (name: string) => void }
    ).__quillReleaseMockGate('pending-visible'),
  );
  // Wait for accumulated text and spinner clearance.
  await expect(aiReply.locator('[data-reply-text]')).toContainText('Sure — the answer is 42.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0);
  await expect(aiReply.getByRole('button', { name: 'Cancel Claude reply' })).toHaveCount(0);
  // The model chip shows the observed family bare (no "· AUTO"); the tooltip
  // notes it was auto-selected and names the last observed model.
  await expect(page.getByLabel('Claude model').locator('option:checked')).toHaveText('FABLE');
  await expect(page.getByRole('group', { name: 'Claude settings' })).toHaveAttribute(
    'title',
    'Model: Auto — last observed FABLE\nEffort: Auto — Claude decides',
  );
});

test('Claude model and effort choices persist and reach an anchored Ask-Claude spawn', async ({
  page,
}) => {
  await setupWithMock(page, [{ kind: 'delta', text: 'Done.' }, { kind: 'done' }]);

  const model = page.getByLabel('Claude model');
  const effort = page.getByLabel('Claude effort');
  await expect(model.locator('option')).toHaveText(['AUTO', 'FABLE', 'OPUS', 'SONNET', 'HAIKU']);
  await expect(effort.locator('option')).toHaveText([
    'AUTO',
    'LOW',
    'MEDIUM',
    'HIGH',
    'XHIGH',
    'MAX',
  ]);

  await model.selectOption('opus');
  await effort.selectOption('max');
  await page.reload();
  await activeEditor(page).waitFor({ timeout: 5000 });
  await expect(page.getByLabel('Claude model')).toHaveValue('opus');
  await expect(page.getByLabel('Claude effort')).toHaveValue('max');

  await activeEditor(page).click();
  await addCommentWithAIReply(page, 'hello world', 'Revise this');
  await expect(page.locator('[data-reply-role="ai"] [data-ai-spinner]')).toHaveCount(0, {
    timeout: 3000,
  });
  const args = await page.evaluate(
    () => (window as unknown as { __lastSpawnArgs: unknown }).__lastSpawnArgs,
  );
  expect(args).toMatchObject({ model: 'opus', effort: 'max' });
});

test('AI reply: Ask Claude in the anchored composer triggers a reply', async ({ page }) => {
  await setupWithMock(page, [
    { kind: 'delta', text: 'On it — ' },
    { kind: 'delta', text: 'done.' },
    { kind: 'done' },
  ]);

  await addClaudeThread(page, 'hello world', 'Please review this');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('[data-reply-text]')).toContainText('On it — done.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0);

  // Thread order: the user's question must render above Claude's answer.
  const replies = page.locator('[data-reply-role]');
  await expect(replies.first()).toContainText('Please review this');
  await expect(replies.first()).toHaveAttribute('data-reply-role', 'user');
  await expect(replies.nth(1)).toHaveAttribute('data-reply-role', 'ai');
});

test('AI reply: Ask Claude with no linked session preserves the request and opens the picker', async ({
  page,
}) => {
  await setupWithoutSession(page);
  // Session picker must not be open yet.
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toHaveCount(0);

  await page.keyboard.type('hello world');
  await page.keyboard.press('ControlOrMeta+a');
  await expectSelectionText(page, 'hello world');
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  const composer = page.locator('[data-card-id="comment-composer"]');
  await composer.locator('textarea').fill('Take a look');
  await expect(composer.getByRole('button', { name: 'Link a session to ask' })).toBeVisible();
  await expect(composer).toContainText('No Claude session linked yet — note works offline.');
  await composer.getByRole('button', { name: 'Link a session to ask' }).click();

  // The request is retained in its new Claude-thread card while linking.
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toBeVisible({
    timeout: 2000,
  });
  await expect(page.locator('[data-comment-card="claude"]')).toContainText('Take a look');
});

test('AI reply: a Claude-thread reply with no linked session opens the session picker', async ({
  page,
}) => {
  await setupWithoutSession(page);
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toHaveCount(0);

  // Create a thread with an unsent request, dismiss linking, then continue that
  // same Claude thread. No magic token is involved in the reply.
  await addClaudeThread(page, 'hello world', 'Take a look');
  await page
    .getByRole('dialog', { name: 'Link Claude Code session' })
    .getByRole('button', { name: 'Close' })
    .click();
  await page.getByRole('button', { name: /Reply to Claude/ }).click();
  await page.getByPlaceholder('Reply to Claude…').fill('A follow-up');
  await page.locator('[data-reply-form]').getByRole('button', { name: 'Reply' }).click();

  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toBeVisible({
    timeout: 2000,
  });
});

test('Session picker: Start new session is disabled until the document is saved', async ({
  page,
}) => {
  await setupWithoutSession(page);
  await addClaudeThread(page, 'hello world', 'Take a look');

  const startNew = page.getByRole('button', { name: 'Start new session' });
  await expect(startNew).toBeVisible();
  await expect(startNew).toBeDisabled();
});

test('Session picker: a saved document mints and fires a canonical Quill binding', async ({
  page,
}) => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const path = '/docs/review.md';
  await setupMemoryTauri(page, {
    files: { [path]: 'hello world' },
    openPath: path,
    mockAI: true,
    newSessionId: sessionId,
  });
  await openMemoryFile(page);
  const editor = activeEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  await page.locator('[data-card-id="comment-composer"] textarea').fill('Take a look');
  await page.getByRole('button', { name: 'Link a session to ask' }).click();

  const startNew = page.getByRole('button', { name: 'Start new session' });
  await expect(startNew).toBeEnabled();
  await startNew.click();

  await expect(page.locator('[data-reply-role="ai"] [data-reply-text]')).toContainText(
    'Persist this answer.',
  );
  const args = await page.evaluate(
    () => (window as unknown as { __quillLastSpawnArgs: unknown }).__quillLastSpawnArgs,
  );
  expect(args).toMatchObject({
    sessionId,
    cwd: '/docs',
    allowCreate: true,
  });
  const prompt = (args as { prompt: string }).prompt;
  expect(prompt).not.toContain('previously authored');
  expect(prompt).toContain('Here is the full current document:');

  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const files = (window as unknown as { __quillFiles: Record<string, string> }).__quillFiles;
        const raw = files['/docs/review.comments.json'];
        return raw ? JSON.parse(raw).aiSession : null;
      }),
    )
    .toMatchObject({
      provider: ipcFixtures.autoBindSession.provider,
      sessionId,
      cwd: '/docs',
      createdByQuill: true,
    });
});

test('AI reply: a session-loss error shows Re-link primary plus a secondary Retry', async ({
  page,
}) => {
  // "session not found" classifies as kind:'session' → Re-link is the primary
  // affordance, and because a session error is still retryable a secondary
  // Retry is offered too.
  await setupWithMock(page, [
    { kind: 'delta', text: 'partial...' },
    { kind: 'error', message: 'session not found' },
  ]);

  await addCommentWithAIReply(page, 'hello world', 'Help');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('[data-reply-error]')).toContainText('session not found', {
    timeout: 3000,
  });
  await expect(aiReply.getByRole('button', { name: /Re-link session/i })).toBeVisible();
  await expect(aiReply.getByRole('button', { name: /^Retry$/i })).toBeVisible();
  await expect(aiReply.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0);
});

test('AI reply: a transient error shows Retry (no Re-link) and retry succeeds in place', async ({
  page,
}) => {
  // First spawn fails with a transient API error; the failed reply offers a
  // primary Retry and no Re-link. Clicking Retry re-issues the identical
  // request against the SAME reply entry, which the second script completes.
  await setupWithMockScripts(page, [
    [
      { kind: 'delta', text: 'partial...' },
      { kind: 'error', message: 'API Error: overloaded' },
    ],
    [{ kind: 'delta', text: 'Second time worked.' }, { kind: 'done' }],
  ]);

  await addCommentWithAIReply(page, 'hello world', 'Help');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('[data-reply-error]')).toContainText('API Error: overloaded', {
    timeout: 3000,
  });
  // Transient → Retry is the primary action; Re-link is demoted to a ghost
  // secondary rather than hidden.
  const retryBtn = aiReply.getByRole('button', { name: /^Retry$/i });
  await expect(retryBtn).toBeVisible();
  await expect(retryBtn).toHaveClass(/btn-primary/);
  await expect(aiReply.getByRole('button', { name: /Re-link session/i })).toHaveClass(/btn-ghost/);

  await retryBtn.click();

  // Same reply entry recovers: error clears and the second script's text lands.
  await expect(aiReply.locator('[data-reply-text]')).toContainText('Second time worked.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('[data-reply-error]')).toHaveCount(0);
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0);
  // Exactly one AI reply — retry reused the entry, it did not append a new one.
  await expect(page.locator('[data-reply-role="ai"]')).toHaveCount(1);
});

// Selects the first `count` characters of the current line (from its start),
// then opens the comment composer and asks Claude. Used to exercise
// document-scale edits: the highlight frames the request, but edits may land
// anywhere in the document.
async function addCommentOnPrefix(page: Page, anchor: string, count: number, replyText: string) {
  await page.keyboard.type(anchor);
  await page.keyboard.press('Home'); // to line start (platform-agnostic; Cmd/Ctrl+Left differ across OSes)
  await page.keyboard.down('Shift');
  for (let i = 0; i < count; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await expectSelectionText(page, anchor.slice(0, count));
  await page.getByRole('button', { name: 'Add comment to selection' }).click();
  await page.locator('[data-card-id="comment-composer"] textarea').fill(replyText);
  await page.getByRole('button', { name: 'Ask Claude' }).click();
}

test('AI edits: prose + quill-edits block (fence split across deltas) becomes a suggestion', async ({
  page,
}) => {
  // The opening fence is split across two deltas to prove the holdback strategy
  // never leaks a partial fence into the visible reply.
  await setupWithMock(page, [
    { kind: 'delta', text: 'Fixed the subject-verb agreement.\n\n```quil' },
    { kind: 'delta', text: 'l-edits\n' },
    {
      kind: 'delta',
      text: '{"summary":"Fixed subject-verb agreement.","edits":[{"find":"cat are","replace":"cats are"}]}\n```',
    },
    { kind: 'done' },
  ]);

  await addCommentWithAIReply(page, 'the cat are happy', 'Fix the grammar');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });

  const replyText = aiReply.locator('[data-reply-text]');
  await expect(replyText).toContainText('Fixed the subject-verb agreement.', { timeout: 3000 });
  // The JSON block must never reach the user.
  await expect(replyText).not.toContainText('quill-edits');
  await expect(replyText).not.toContainText('"find"');
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0);

  // A suggestion card appears for the edit, authored by Claude.
  const card = page.locator('[data-suggestion-kind]');
  await expect(card.first()).toBeVisible({ timeout: 2000 });
  await expect(card.first().getByText('Claude', { exact: true })).toBeVisible();
  // The redundant "AI" chip was removed; the "Claude" author label alone marks it.
  await expect(page.locator('[data-suggestion-kind] .ai-badge')).toHaveCount(0);
  // The new text "cats are" shows up as a tracked insertion in the document.
  await expect(activeEditor(page)).toContainText('cats are');

  // Q7's linkage is bidirectional: the reply jumps to the already-applied
  // tracked suggestion (there is no second Apply-edit path), and that card
  // remains the sole Accept/Reject surface.
  const viewSuggestion = aiReply.getByRole('button', { name: /suggestions?/i });
  await expect(viewSuggestion).toBeVisible();
  await viewSuggestion.click();
  await expect(card.first()).toHaveAttribute('data-active');
  await expect(card.first().getByRole('button', { name: 'Accept' })).toBeVisible();
  await expect(card.first().getByRole('button', { name: 'Reject' })).toBeVisible();

  // The card's provenance chip completes the return trip to the thread.
  await card
    .first()
    .getByRole('button', { name: /from comment/i })
    .click();
  await expect(page.locator('[data-comment-card]')).toHaveAttribute('data-active');

  // Dismiss removes only Claude's reply block: the thread and its linked,
  // accept/rejectable suggestion remain intact.
  await aiReply.getByRole('button', { name: 'Dismiss' }).click();
  await expect(aiReply).toHaveCount(0);
  await expect(page.locator('[data-comment-card]')).toHaveCount(1);
  await expect(card.first()).toBeVisible();
});

test('AI edits: an edit outside the highlight applies (edits are document-scale)', async ({
  page,
}) => {
  // Highlight only "alpha" (first 5 chars). The edit targets "gamma", outside
  // the highlight — edits are document-scale, so it must apply anyway.
  await setupWithMock(page, [
    { kind: 'delta', text: 'Capitalized the closing word.\n\n```quill-edits\n' },
    {
      kind: 'delta',
      text: '{"summary":"x","edits":[{"find":"gamma","replace":"GAMMA"}]}\n```',
    },
    { kind: 'done' },
  ]);

  await addCommentOnPrefix(page, 'alpha beta gamma', 5, 'Tidy this up');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0, { timeout: 3000 });
  // The edit landed even though it was outside the highlight.
  await expect(page.locator('[data-suggestion-kind]').first()).toBeVisible({ timeout: 2000 });
  await expect(activeEditor(page)).toContainText('GAMMA');
});

test('AI edits: an edit whose find is nowhere in the document is skipped and surfaced', async ({
  page,
}) => {
  await setupWithMock(page, [
    { kind: 'delta', text: 'Tried to fix a word.\n\n```quill-edits\n' },
    {
      kind: 'delta',
      text: '{"summary":"x","edits":[{"find":"delta","replace":"DELTA"}]}\n```',
    },
    { kind: 'done' },
  ]);

  await addCommentOnPrefix(page, 'alpha beta gamma', 5, 'Tidy this up');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  // With zero successful edits, optimistic prose is replaced by the honest
  // nothing-applied result and the document remains unchanged.
  await expect(aiReply.locator('[data-reply-text]')).toContainText('Nothing was applied:', {
    timeout: 3000,
  });
  await expect(aiReply.locator('[data-reply-text]')).toContainText(
    '“delta” — this text isn’t in the document.',
  );
  await expect(aiReply.locator('[data-reply-text]')).not.toContainText('Tried to fix a word.');
  await expect(page.locator('[data-suggestion-kind]')).toHaveCount(0);
  await expect(activeEditor(page)).not.toContainText('DELTA');
});

test('AI reply: cancel resolves to a neutral Re-run, and Re-run succeeds in place', async ({
  page,
}) => {
  // First spawn streams a little then parks; the second (post-Re-run) completes.
  await setupWithMockScripts(page, [
    [{ kind: 'delta', text: 'starting...' }, { kind: 'pause' }],
    [{ kind: 'delta', text: 'Second time worked.' }, { kind: 'done' }],
  ]);

  await addCommentWithAIReply(page, 'hello world', 'Handle this long task');

  const aiReply = page.locator('[data-reply-role="ai"]').first();
  await expect(aiReply).toBeVisible({ timeout: 2000 });
  await expect(aiReply.locator('[data-reply-text]')).toContainText('starting...', {
    timeout: 2000,
  });
  await expect(aiReply.getByRole('button', { name: 'Cancel Claude reply' })).toBeVisible();
  await aiReply.getByRole('button', { name: 'Cancel Claude reply' }).click();

  // Cancel is a neutral terminal state (not an error): spinner and Cancel go
  // away, the partial text is discarded, and a Re-run button is offered.
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0, { timeout: 2000 });
  await expect(aiReply.getByRole('button', { name: 'Cancel Claude reply' })).toHaveCount(0);
  await expect(aiReply.locator('[data-reply-error]')).toHaveCount(0);
  const rerun = aiReply.locator('[data-reply-cancelled]').getByRole('button', { name: /Re-run/i });
  await expect(rerun).toBeVisible();

  await rerun.click();

  // Same reply entry recovers: the second script's text lands, cancelled UI gone.
  await expect(aiReply.locator('[data-reply-text]')).toContainText('Second time worked.', {
    timeout: 3000,
  });
  await expect(aiReply.locator('[data-reply-cancelled]')).toHaveCount(0);
  await expect(aiReply.locator('[data-ai-spinner]')).toHaveCount(0);
  // Exactly one AI reply — Re-run reused the entry, it did not append a new one.
  await expect(page.locator('[data-reply-role="ai"]')).toHaveCount(1);
});
