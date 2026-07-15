/**
 * Playwright coverage for the three Tauri-backed AI features:
 *   1. Auto-bind on stray .md open (find_session_for_markdown)
 *   2. Compaction detection branching in the prompt (check_session_compacted)
 *   3. quill:// deep-link → openFilePath flow (deep-link-open event)
 *
 * Real Tauri isn't running, so each test installs a minimal IPC shim at
 * window.__TAURI_INTERNALS__ via addInitScript. invoke() in the app code
 * dispatches through that shim, and event-bus listen()/emit() are simulated
 * by the same dispatcher (Tauri's listen() itself goes through invoke()).
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ipcFixtures } from './helpers/ipcFixtures';
import { activeEditor } from './helpers/memoryTauri';
import { expectPageTitleToContain, expectSelectionText } from './helpers/deterministicWaits';

type InvokeHandler = (cmd: string, args: Record<string, unknown>) => unknown;

async function setupWithIPC(
  page: Page,
  opts: {
    handler: InvokeHandler;
    // Optional: inject a fake aiSession so the anchored Claude path runs.
    testSession?: Record<string, unknown>;
    // Optional: capture invoke calls for later assertions.
    captureKey?: string;
    fixtures?: Record<string, unknown>;
  },
): Promise<void> {
  await page.addInitScript(
    ({ handlerSrc, testSession, captureKey, fixtures }) => {
      // Reconstruct the handler from its source so it can be serialized.

      const handler = new Function('cmd', 'args', 'ctx', `return (${handlerSrc})(cmd, args, ctx);`);

      type Listener = { event: string; cb: (payload: unknown) => void };
      const listeners: Listener[] = [];
      const callbacks = new Map<number, (payload: unknown) => void>();
      let nextCbId = 1;
      const calls: { cmd: string; args: Record<string, unknown> }[] = [];
      const emittedEvents: string[] = [];
      (window as unknown as Record<string, unknown>).__quillTauriListeners = listeners;
      (window as unknown as Record<string, unknown>).__quillEmittedTauriEvents = emittedEvents;

      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback: (cb: (payload: unknown) => void) => {
          const id = nextCbId++;
          callbacks.set(id, cb);
          // Tauri also registers a global function it can call by id; mirror that.
          (window as unknown as Record<string | number, unknown>)[`_${id}`] = (payload: unknown) =>
            cb(payload);
          return id;
        },
        unregisterCallback: (id: number) => {
          callbacks.delete(id);
        },
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args });
          // Built-in event plumbing.
          if (cmd === 'plugin:event|listen') {
            const cbId = args.handler as number;
            const ev = args.event as string;
            const cb = callbacks.get(cbId);
            if (cb) listeners.push({ event: ev, cb });
            return cbId;
          }
          if (cmd === 'plugin:event|unlisten') return null;
          // Delegate everything else to the test handler.
          return handler(cmd, args, {
            fixtures,
            emit: (event: string, payload: unknown) => {
              for (const l of listeners) {
                if (l.event === event) l.cb({ event, id: 0, payload });
              }
            },
          });
        },
      };

      if (testSession) {
        (window as unknown as Record<string, unknown>).__quillTestSession = testSession;
      }
      if (captureKey) {
        (window as unknown as Record<string, unknown>)[captureKey] = calls;
        // Expose a hook to emit deep-link events from the test runner.
        (window as unknown as Record<string, unknown>).__emitTauri = (
          event: string,
          payload: unknown,
        ) => {
          for (const l of listeners) {
            if (l.event === event) l.cb({ event, id: 0, payload });
          }
          emittedEvents.push(event);
        };
      } else {
        (window as unknown as Record<string, unknown>).__emitTauri = (
          event: string,
          payload: unknown,
        ) => {
          for (const l of listeners) {
            if (l.event === event) l.cb({ event, id: 0, payload });
          }
          emittedEvents.push(event);
        };
      }
    },
    {
      handlerSrc: opts.handler.toString(),
      testSession: opts.testSession ?? null,
      captureKey: opts.captureKey ?? null,
      fixtures: opts.fixtures ?? null,
    },
  );

  await page.goto('/');
  await activeEditor(page).waitFor({ timeout: 5000 });
}

async function waitForTauriListener(page: Page, event: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (eventName) =>
          (
            (window as unknown as { __quillTauriListeners: Array<{ event: string }> })
              .__quillTauriListeners ?? []
          ).some((listener) => listener.event === eventName),
        event,
      ),
    )
    .toBe(true);
}

async function emitTauriAndWait(page: Page, event: string, payload: unknown) {
  await waitForTauriListener(page, event);
  const countBefore = await page.evaluate(
    (eventName) =>
      (
        (window as unknown as { __quillEmittedTauriEvents: string[] }).__quillEmittedTauriEvents ??
        []
      ).filter((name) => name === eventName).length,
    event,
  );
  await page.evaluate(
    ({ eventName, eventPayload }) => {
      (window as unknown as { __emitTauri: (name: string, value: unknown) => void }).__emitTauri(
        eventName,
        eventPayload,
      );
    },
    { eventName: event, eventPayload: payload },
  );
  await expect
    .poll(() =>
      page.evaluate(
        (eventName) =>
          (
            (window as unknown as { __quillEmittedTauriEvents: string[] })
              .__quillEmittedTauriEvents ?? []
          ).filter((name) => name === eventName).length,
        event,
      ),
    )
    .toBe(countBefore + 1);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Auto-bind on stray .md open
// ────────────────────────────────────────────────────────────────────────────

test('auto-bind: stray .md with no sidecar links to the canonical IPC session', async ({
  page,
}) => {
  // The handler must be self-contained — no closure variables.
  const handler = (
    cmd: string,
    args: Record<string, unknown>,
    ctx: { fixtures: { autoBindSession: Record<string, unknown> } },
  ) => {
    if (cmd === 'show_open_dialog') return '/tmp/stray.md';
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/stray.md') return '# Doc body that is long enough to match';
      throw new Error('sidecar not found'); // .comments.json miss → empty sidecar
    }
    if (cmd === 'find_session_for_markdown') {
      return ctx.fixtures.autoBindSession;
    }
    return null;
  };

  await setupWithIPC(page, { handler, fixtures: ipcFixtures });

  // Trigger File → Open via Cmd+O (App.tsx wires this to handleOpen → openFile).
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('o');
  await page.keyboard.up('ControlOrMeta');

  // Footer should show the bound session id (Footer.tsx renders `aiSession.sessionId.slice(0,8)`).
  await expect(page.locator('.footer-ai-binding.linked')).toContainText('FIXTURE-', {
    timeout: 3000,
  });
  // Title should show dirty bullet because auto-bind marks the file dirty.
  await expectPageTitleToContain(page, '•');
});

test('auto-bind: no match leaves session unbound (no false link)', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_open_dialog') return '/tmp/orphan.md';
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/orphan.md') return '# Doc that matches nothing';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };

  await setupWithIPC(page, { handler });

  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('o');
  await page.keyboard.up('ControlOrMeta');

  await expect(activeEditor(page)).toContainText('Doc that matches nothing');
  await expect(page.locator('[aria-label="Document location"]')).toContainText('orphan.md');
  // No linked-session chip in the status bar (still showing its link affordance).
  await expect(page.locator('.footer-ai-binding.linked')).toHaveCount(0);
  await expect(page.locator('.footer-ai-binding').first()).toContainText('LINK SESSION');
});

test('session picker headlines prefer document name, then AI title, then untitled id', async ({
  page,
}) => {
  const handler = (cmd: string) => {
    if (cmd === 'list_claude_sessions') {
      return [
        {
          sessionId: 'document-session',
          jsonlPath: '/tmp/document-session.jsonl',
          cwd: '/tmp/project',
          title: 'Claude title loses',
          documentName: 'Design Brief.md',
          lastUsed: 3,
        },
        {
          sessionId: 'title-session',
          jsonlPath: '/tmp/title-session.jsonl',
          cwd: '/tmp/project',
          title: 'Claude fallback title',
          documentName: null,
          lastUsed: 2,
        },
        {
          sessionId: '805faa5a-1234-5678-90ab-cdef12345678',
          jsonlPath: '/tmp/untitled-session.jsonl',
          cwd: '/tmp/project',
          title: null,
          documentName: null,
          lastUsed: 1,
        },
      ];
    }
    return null;
  };

  await setupWithIPC(page, { handler });
  await page.locator('.footer-ai-binding-label').click();

  const sessionDialog = page.getByRole('dialog', { name: 'Link Claude Code session' });
  for (const title of ['Design Brief.md', 'Claude fallback title', 'untitled-805faa5a']) {
    await expect(sessionDialog.getByRole('button', { name: title })).toBeVisible();
  }
});

test('linking a saved document records its session name for the next picker open', async ({
  page,
}) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    const state = window as unknown as { __indexedDocumentName?: string };
    if (cmd === 'show_open_dialog') return '/tmp/Meeting Notes.md';
    if (cmd === 'read_file') {
      if (args.path === '/tmp/Meeting Notes.md') return '# Saved meeting notes';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    if (cmd === 'list_claude_sessions') {
      return [
        {
          sessionId: 'saved-doc-session',
          jsonlPath: '/tmp/saved-doc-session.jsonl',
          cwd: '/tmp',
          title: null,
          documentName: state.__indexedDocumentName ?? null,
          lastUsed: Math.floor(Date.now() / 1000),
        },
      ];
    }
    if (cmd === 'read_claude_session_preview') {
      return {
        sessionId: 'saved-doc-session',
        cwd: '/tmp',
        recentAssistantMessages: ['Session preview'],
      };
    }
    if (cmd === 'record_session_document') {
      state.__indexedDocumentName = String(args.docPath).split('/').at(-1);
      return true;
    }
    return null;
  };

  await setupWithIPC(page, { handler });
  await page.keyboard.press('ControlOrMeta+o');

  const picker = page.getByRole('dialog', { name: 'Link Claude Code session' });
  await expect(picker).toBeVisible({ timeout: 3000 });
  await expect(picker.getByRole('button', { name: 'untitled-saved-do' })).toBeVisible();
  await picker.getByRole('button', { name: 'untitled-saved-do' }).click();
  await picker.getByRole('button', { name: 'Link this session' }).click();
  await expect(picker).toHaveCount(0);
  await page.waitForFunction(
    () =>
      (window as unknown as { __indexedDocumentName?: string }).__indexedDocumentName ===
      'Meeting Notes.md',
  );

  await page.locator('.footer-ai-binding-label').click();
  await expect(
    page
      .getByRole('dialog', { name: 'Link Claude Code session' })
      .getByRole('button', { name: 'Meeting Notes.md' }),
  ).toBeVisible();
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Compaction detection (prompt branch selection)
// ────────────────────────────────────────────────────────────────────────────

async function fireAIReplyAndCaptureCompactionCall(
  page: Page,
): Promise<{ cmd: string; args: Record<string, unknown> }[]> {
  // Ask Claude from the anchored composer so useClaudeReply.ask fires.
  await activeEditor(page).click();
  await page.keyboard.type('content to comment on');
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('a');
  await page.keyboard.up('ControlOrMeta');
  await expectSelectionText(page, 'content to comment on');
  await page.locator('.add-comment-btn').click();
  await page.locator('.add-comment-compose textarea').fill('Evaluate');
  await page.getByRole('button', { name: 'Ask Claude', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          (window as unknown as { __capturedCalls: Array<{ cmd: string }> }).__capturedCalls ?? []
        ).some((call) => call.cmd === 'spawn_claude_resume'),
      ),
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>).__capturedCalls as {
        cmd: string;
        args: Record<string, unknown>;
      }[],
  );
}

test('compaction: non-compacted session still sends the full document (no diff form)', async ({
  page,
}) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'check_session_compacted') {
      return { compacted: false, originalMarkdown: 'original baseline text' };
    }
    if (cmd === 'spawn_claude_resume') {
      (window as unknown as Record<string, unknown>).__capturedPrompt = args.prompt;
      return 'mock-token-1';
    }
    if (cmd === 'cancel_claude_resume') return null;
    return null;
  };

  await setupWithIPC(page, {
    handler,
    testSession: {
      ...ipcFixtures.autoBindSession,
      sessionId: 'sess-not-compacted',
      cwd: '/tmp/x',
    },
    captureKey: '__capturedCalls',
  });

  await fireAIReplyAndCaptureCompactionCall(page);

  // Verify check_session_compacted was invoked.
  const calls = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__capturedCalls as { cmd: string }[],
  );
  expect(calls.some((c) => c.cmd === 'check_session_compacted')).toBe(true);

  // The prompt is document-scale: always the full current document. The
  // compaction probe only picks the note wording — never a diff form.
  const prompt = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__capturedPrompt as string,
  );
  expect(prompt).toContain('Current document (may have been edited since your last turn):');
  expect(prompt).toContain('content to comment on');
  expect(prompt).not.toContain('diff between what you originally wrote');
  expect(prompt).not.toContain('Your context was compacted');
});

test('compaction: compacted session sends full doc with compaction note', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'check_session_compacted') {
      return { compacted: true, originalMarkdown: null };
    }
    if (cmd === 'spawn_claude_resume') {
      (window as unknown as Record<string, unknown>).__capturedPrompt = args.prompt;
      return 'mock-token-2';
    }
    if (cmd === 'cancel_claude_resume') return null;
    return null;
  };

  await setupWithIPC(page, {
    handler,
    testSession: {
      ...ipcFixtures.autoBindSession,
      sessionId: 'sess-compacted',
      cwd: '/tmp/x',
    },
    captureKey: '__capturedCalls',
  });

  await fireAIReplyAndCaptureCompactionCall(page);

  const prompt = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__capturedPrompt as string,
  );
  expect(prompt).toContain('Your context was compacted');
  expect(prompt).not.toContain('Your context is intact');
});

// ────────────────────────────────────────────────────────────────────────────
// 3. quill:// deep-link → openFilePath
// ────────────────────────────────────────────────────────────────────────────

test('deep-link: deep-link-open event opens the file at the payload path', async ({ page }) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/linked.md') return '# Linked document content';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    return null;
  };

  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  await emitTauriAndWait(page, 'deep-link-open', '/tmp/linked.md');

  // Editor should now contain the linked content.
  await expect(activeEditor(page)).toContainText('Linked document content', {
    timeout: 3000,
  });
  // Footer filename should reflect the opened file.
  await expect(page.locator('[aria-label="Document location"]')).toContainText('linked.md');
});

test('deep-link: opening a doc with no linked session forces the session picker', async ({
  page,
}) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'read_file') {
      const path = args.path as string;
      if (path === '/tmp/unbound.md') return '# A document with no linked session';
      throw new Error('sidecar not found');
    }
    if (cmd === 'find_session_for_markdown') return null;
    if (cmd === 'list_claude_sessions') {
      return [
        {
          sessionId: 'sess-abc123',
          jsonlPath: '/tmp/sess-abc123.jsonl',
          cwd: '/tmp/project',
          title: 'My session',
          lastUsed: Math.floor(Date.now() / 1000),
        },
      ];
    }
    if (cmd === 'read_claude_session_preview') {
      return { sessionId: 'sess-abc123', cwd: '/tmp/project', recentAssistantMessages: ['hi'] };
    }
    return null;
  };

  await setupWithIPC(page, { handler });

  await emitTauriAndWait(page, 'deep-link-open', '/tmp/unbound.md');

  // Doc loads…
  await expect(activeEditor(page)).toContainText('no linked session', { timeout: 3000 });
  // …and the picker is surfaced so the user must choose a session.
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toBeVisible({
    timeout: 2000,
  });

  // Picking a session binds it: pick, link, and the picker closes.
  await page
    .getByRole('dialog', { name: 'Link Claude Code session' })
    .getByRole('button', { name: 'My session' })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Link Claude Code session' })
      .getByRole('button', { name: 'Link this session' }),
  ).toBeEnabled({ timeout: 2000 });
  await page
    .getByRole('dialog', { name: 'Link Claude Code session' })
    .getByRole('button', { name: 'Link this session' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Link Claude Code session' })).toHaveCount(0);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Context folder: footer link, sidecar persistence, --add-dir + manifest
// ────────────────────────────────────────────────────────────────────────────

test('context folder: link via footer, persist in sidecar on save, unlink', async ({ page }) => {
  const handler = (cmd: string) => {
    if (cmd === 'show_folder_dialog') return '/refs/research';
    if (cmd === 'show_save_dialog') return '/tmp/doc.md';
    return null;
  };

  await setupWithIPC(page, { handler, captureKey: '__capturedCalls' });

  // Link: the reference-folder status control becomes linked and retains the
  // full folder path in its tooltip while keeping the compact mono label.
  await page.locator('.footer-context-binding').click();
  await expect(page.locator('.footer-context-binding.linked')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.footer-context-binding-label')).toHaveAttribute(
    'title',
    'Reference folder: /refs/research (click to change)',
  );
  // Linking marks the document dirty so the binding gets saved.
  await expectPageTitleToContain(page, '•');

  // Save: the sidecar must be written (not deleted) even though there are no
  // comments/suggestions, and it must carry the folder.
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('s');
  await page.keyboard.up('ControlOrMeta');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const calls = (window as unknown as Record<string, unknown>).__capturedCalls as Array<{
          cmd: string;
          args: Record<string, unknown>;
        }>;
        const write = calls.find(
          (call) =>
            call.cmd === 'write_file' && (call.args.path as string).endsWith('.comments.json'),
        );
        return write ? JSON.parse(write.args.content as string).contextFolder : null;
      }),
    )
    .toBe('/refs/research');

  // Unlink: chip reverts to the link affordance.
  await page.locator('.footer-context-binding-unlink').click();
  await expect(page.locator('.footer-context-binding.linked')).toHaveCount(0);
  await expect(page.locator('.footer-context-binding')).toContainText('REFERENCE FOLDER');
  await expect(page.locator('.footer-context-binding-label')).toHaveAttribute(
    'title',
    'Link a folder of reference documents Claude can read',
  );
});

test('context folder: anchored Claude request passes --add-dir and a file manifest', async ({
  page,
}) => {
  const handler = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'show_folder_dialog') return '/refs/research';
    if (cmd === 'list_context_files') return ['sources.md', 'notes/interview.txt'];
    if (cmd === 'check_session_compacted') return { compacted: true, originalMarkdown: null };
    if (cmd === 'spawn_claude_resume') {
      (window as unknown as Record<string, unknown>).__capturedSpawnArgs = args;
      return 'mock-token-ctx';
    }
    return null;
  };

  await setupWithIPC(page, {
    handler,
    testSession: {
      ...ipcFixtures.autoBindSession,
      sessionId: 'sess-with-folder',
      cwd: '/tmp/x',
    },
    captureKey: '__capturedCalls',
  });

  await page.locator('.footer-context-binding').click();
  await expect(page.locator('.footer-context-binding.linked')).toBeVisible({ timeout: 2000 });

  await fireAIReplyAndCaptureCompactionCall(page);

  const spawnArgs = await page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>).__capturedSpawnArgs as Record<string, unknown>,
  );
  expect(spawnArgs.addDir).toBe('/refs/research');
  const prompt = spawnArgs.prompt as string;
  expect(prompt).toContain('=== REFERENCE FOLDER ===');
  expect(prompt).toContain('/refs/research');
  expect(prompt).toContain('- sources.md');
  expect(prompt).toContain('- notes/interview.txt');
});

test('deep-link: empty payload is ignored (no crash, no file load)', async ({ page }) => {
  const handler = () => null;
  await setupWithIPC(page, { handler });
  await emitTauriAndWait(page, 'deep-link-open', '');

  // Filename stays at Untitled.
  await expect(page.locator('[aria-label="Document location"]')).toContainText('Untitled');
});
