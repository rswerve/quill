import type { Page } from '@playwright/test';

interface MemoryTauriOptions {
  files?: Record<string, string>;
  openPath?: string;
  savePath?: string;
  mockAI?: boolean;
  newSessionId?: string;
}

/**
 * Browser-side Tauri shim with a persistent in-memory filesystem. Unlike the
 * older per-spec stubs, this supports save -> new -> reopen assertions without
 * faking the application state between those operations.
 */
export async function setupMemoryTauri(page: Page, options: MemoryTauriOptions = {}) {
  await page.addInitScript(
    ({ files, openPath, savePath, mockAI, newSessionId }) => {
      type Call = { cmd: string; args: Record<string, unknown> };
      type Listener = { event: string; callback: (payload: unknown) => void };
      const memoryFiles: Record<string, string> = { ...files };
      const calls: Call[] = [];
      const callbacks = new Map<number, (payload: unknown) => void>();
      const listeners: Listener[] = [];
      let nextCallbackId = 1;

      const globals = window as unknown as {
        __quillFiles: Record<string, string>;
        __quillCalls: Call[];
        __TAURI_INTERNALS__: unknown;
        __quillMock?: unknown;
        [key: string]: unknown;
      };
      globals.__quillFiles = memoryFiles;
      globals.__quillCalls = calls;
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
          if (cmd === 'read_draft' || cmd === 'take_pending_deep_link') return null;
          if (cmd === 'has_native_menu') return false;
          if (cmd === 'show_open_dialog') return openPath ?? null;
          if (cmd === 'show_save_dialog') return savePath ?? null;
          if (cmd === 'read_file') {
            const path = args.path as string;
            if (Object.prototype.hasOwnProperty.call(memoryFiles, path)) return memoryFiles[path];
            throw new Error(`File not found: ${path}`);
          }
          if (cmd === 'write_file') {
            memoryFiles[args.path as string] = args.content as string;
            return null;
          }
          if (cmd === 'delete_file') {
            delete memoryFiles[args.path as string];
            return null;
          }
          if (cmd === 'find_session_for_markdown') return null;
          return null;
        },
      };

      if (mockAI) {
        globals.__quillMock = {
          compaction: { compacted: true, originalMarkdown: null },
          spawn: (args: unknown, onEvent: (event: unknown) => void) => {
            globals.__quillLastSpawnArgs = args;
            setTimeout(() => {
              onEvent({ kind: 'delta', text: 'Persist this answer.' });
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
      newSessionId: options.newSessionId ?? null,
    },
  );

  await page.goto('/');
  await page.locator('.ProseMirror').waitFor({ timeout: 5000 });
}

export async function closeSessionPickerIfOpen(page: Page) {
  const picker = page.locator('.session-picker');
  if (await picker.count()) await page.locator('.session-picker-close').click();
}

export async function openMemoryFile(page: Page) {
  await page.keyboard.press('ControlOrMeta+o');
  await page.locator('.footer-filename').waitFor();
  await closeSessionPickerIfOpen(page);
}

export async function selectLastCharacters(page: Page, count: number) {
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < count; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
}
