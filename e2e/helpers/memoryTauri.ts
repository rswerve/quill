import type { Page } from '@playwright/test';

interface MemoryTauriOptions {
  files?: Record<string, string>;
  openPath?: string;
  savePath?: string;
  mockAI?: boolean;
  /** Raw text the mockAI spawn streams back (may include a quill-edits fence).
   *  Defaults to a plain prose reply. */
  aiReplyText?: string;
  newSessionId?: string;
  /** Initial workspace payload. The shim persists later writes across reloads. */
  workspace?: string;
  /** Hold the first document write until the test calls __quillReleaseWriteFile. */
  deferFirstWriteFile?: boolean;
  /** Session returned by the backend's markdown auto-bind scan. */
  foundSession?: unknown;
  /** Session-picker rows and previews for binding-policy tests. */
  claudeSessions?: unknown[];
  sessionPreviews?: Record<string, unknown>;
}

/**
 * Browser-side Tauri shim with a persistent in-memory filesystem. Unlike the
 * older per-spec stubs, this supports save -> new -> reopen assertions without
 * faking the application state between those operations.
 */
export async function setupMemoryTauri(page: Page, options: MemoryTauriOptions = {}) {
  await page.addInitScript(
    ({
      files,
      openPath,
      savePath,
      mockAI,
      aiReplyText,
      newSessionId,
      workspace,
      deferFirstWriteFile,
      foundSession,
      claudeSessions,
      sessionPreviews,
    }) => {
      type Call = { cmd: string; args: Record<string, unknown> };
      type Listener = { event: string; callback: (payload: unknown) => void };
      const filesKey = '__quill_test_files';
      const workspaceKey = '__quill_test_workspace';
      const storedFiles = sessionStorage.getItem(filesKey);
      const initialFiles = storedFiles
        ? (JSON.parse(storedFiles) as Record<string, string>)
        : { ...files };
      const persistFiles = () => sessionStorage.setItem(filesKey, JSON.stringify(initialFiles));
      const memoryFiles = new Proxy(initialFiles, {
        set(target, property, value: string) {
          target[property as string] = value;
          persistFiles();
          return true;
        },
        deleteProperty(target, property) {
          delete target[property as string];
          persistFiles();
          return true;
        },
      });
      if (!storedFiles) persistFiles();
      if (workspace && sessionStorage.getItem(workspaceKey) === null) {
        sessionStorage.setItem(workspaceKey, workspace);
      }
      const calls: Call[] = [];
      const callbacks = new Map<number, (payload: unknown) => void>();
      const listeners: Listener[] = [];
      let nextCallbackId = 1;

      const globals = window as unknown as {
        __quillFiles: Record<string, string>;
        __quillCalls: Call[];
        __quillListeners: Listener[];
        __TAURI_INTERNALS__: unknown;
        __quillMock?: unknown;
        [key: string]: unknown;
      };
      globals.__quillFiles = memoryFiles;
      globals.__quillCalls = calls;
      globals.__quillListeners = listeners;
      globals.__quillWriteFileBlocked = false;
      if (newSessionId) {
        Object.defineProperty(crypto, 'randomUUID', {
          configurable: true,
          value: () => newSessionId,
        });
      }
      globals.__TAURI_INTERNALS__ = {
        transformCallback: (callback: (payload: unknown) => void) => {
          const id = nextCallbackId++;
          callbacks.set(id, callback);
          globals[`_${id}`] = (payload: unknown) => callback(payload);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args });
          if (cmd === 'plugin:event|listen') {
            const callback = callbacks.get(args.handler as number);
            if (callback) listeners.push({ event: args.event as string, callback });
            return args.handler;
          }
          if (cmd === 'plugin:event|unlisten') return null;
          if (cmd === 'read_draft') return sessionStorage.getItem(workspaceKey);
          if (cmd === 'write_draft') {
            sessionStorage.setItem(workspaceKey, args.content as string);
            return null;
          }
          if (cmd === 'delete_draft') {
            sessionStorage.removeItem(workspaceKey);
            return null;
          }
          if (cmd === 'quarantine_draft') {
            const raw = sessionStorage.getItem(workspaceKey);
            if (raw === null) return null;
            sessionStorage.setItem('__quill_test_quarantined_workspace', raw);
            sessionStorage.removeItem(workspaceKey);
            return '/app/workspace.corrupt-test.json';
          }
          if (cmd === 'take_pending_deep_link') return null;
          if (cmd === 'has_native_menu') return false;
          if (cmd === 'show_open_dialog') return openPath ?? null;
          if (cmd === 'show_save_dialog') return savePath ?? null;
          if (cmd === 'list_claude_sessions') return claudeSessions ?? [];
          if (cmd === 'read_claude_session_preview') {
            return sessionPreviews?.[args.jsonlPath as string] ?? null;
          }
          if (cmd === 'read_file') {
            const path = args.path as string;
            if (Object.prototype.hasOwnProperty.call(memoryFiles, path)) return memoryFiles[path];
            throw new Error(`File not found: ${path}`);
          }
          if (cmd === 'write_file') {
            if (deferFirstWriteFile && globals.__quillReleaseWriteFile === undefined) {
              globals.__quillWriteFileBlocked = true;
              await new Promise<void>((resolve) => {
                globals.__quillReleaseWriteFile = () => {
                  globals.__quillWriteFileBlocked = false;
                  resolve();
                };
              });
            }
            memoryFiles[args.path as string] = args.content as string;
            return null;
          }
          if (cmd === 'delete_file') {
            delete memoryFiles[args.path as string];
            return null;
          }
          if (cmd === 'find_session_for_markdown') return foundSession ?? null;
          return null;
        },
      };

      if (mockAI) {
        globals.__quillMock = {
          compaction: { compacted: true, originalMarkdown: null },
          spawn: (args: unknown, onEvent: (event: unknown) => void) => {
            globals.__quillLastSpawnArgs = args;
            setTimeout(() => {
              onEvent({ kind: 'delta', text: aiReplyText });
              onEvent({ kind: 'done' });
            }, 0);
            return 'fixture-token';
          },
          cancel: () => undefined,
        };
      }

      // Keep the array live for future native-menu tests that emit through the
      // same mocked event transport.
      globals.__quillEmit = (event: string, payload: unknown) => {
        for (const listener of listeners) {
          if (listener.event === event) listener.callback({ event, id: 0, payload });
        }
      };
    },
    {
      files: options.files ?? {},
      openPath: options.openPath ?? null,
      savePath: options.savePath ?? null,
      mockAI: options.mockAI ?? false,
      aiReplyText: options.aiReplyText ?? 'Persist this answer.',
      newSessionId: options.newSessionId ?? null,
      workspace: options.workspace ?? null,
      deferFirstWriteFile: options.deferFirstWriteFile ?? false,
      foundSession: options.foundSession ?? null,
      claudeSessions: options.claudeSessions ?? [],
      sessionPreviews: options.sessionPreviews ?? {},
    },
  );

  await page.goto('/');
  await activeEditor(page).waitFor({ timeout: 5000 });
}

export function activeTabHost(page: Page) {
  return page.locator('.document-tab-host:not([hidden])');
}

export function activeEditor(page: Page) {
  return activeTabHost(page).locator('.ProseMirror');
}

export async function closeSessionPickerIfOpen(page: Page) {
  const picker = page.locator('.session-picker');
  if (await picker.count()) await page.locator('.session-picker-close').click();
}

export async function openMemoryFile(page: Page) {
  await activeEditor(page).waitFor({ timeout: 5000 });
  await page.waitForFunction(() =>
    (
      window as unknown as {
        __quillListeners?: Array<{ event: string }>;
      }
    ).__quillListeners?.some((listener) => listener.event === 'menu-open'),
  );
  const openCallsBefore = await page.evaluate(
    () =>
      (window as unknown as { __quillCalls: Array<{ cmd: string }> }).__quillCalls.filter(
        (call) => call.cmd === 'show_open_dialog',
      ).length,
  );
  await page.keyboard.press('ControlOrMeta+o');
  await page.waitForFunction(
    (previous) =>
      (window as unknown as { __quillCalls: Array<{ cmd: string }> }).__quillCalls.filter(
        (call) => call.cmd === 'show_open_dialog',
      ).length > previous,
    openCallsBefore,
  );
  await page.waitForFunction(
    () => document.querySelector('.crumbs .cur')?.textContent?.trim() !== 'Untitled',
  );
  // filePath publishes before loadFileResult's session-picker state reaches
  // the DOM. Let that same open settle so the helper cannot miss a late picker
  // and leave an invisible modal intercepting the next real interaction.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await closeSessionPickerIfOpen(page);
}

export async function selectLastCharacters(page: Page, count: number) {
  // Keyboard Shift+ArrowLeft events can be dropped while ProseMirror is
  // reconciling focus, and the DOM selection can briefly report the requested
  // width before the editor state catches up. Build the browser range directly
  // instead, then give ProseMirror two animation frames to observe it before
  // the caller types or presses Backspace.
  await activeEditor(page).evaluate((root, requested) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) nodes.push(current as Text);

    const endNode = nodes.at(-1);
    if (!endNode) throw new Error('selectLastCharacters: editor has no text');

    let remaining = requested;
    let startNode = endNode;
    let startOffset = endNode.data.length;
    for (let i = nodes.length - 1; i >= 0 && remaining > 0; i--) {
      const node = nodes[i];
      const consumed = Math.min(remaining, node.data.length);
      startNode = node;
      startOffset = node.data.length - consumed;
      remaining -= consumed;
    }
    if (remaining > 0) {
      throw new Error(`selectLastCharacters: document is shorter than ${requested} characters`);
    }

    (root as HTMLElement).focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endNode.data.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
  }, count);

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const selected = await page.evaluate(() => window.getSelection()?.toString().length ?? 0);
  if (selected !== count) {
    throw new Error(`selectLastCharacters: selected ${selected} characters, expected ${count}`);
  }
}
