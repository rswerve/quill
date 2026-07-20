import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { canonicalDocumentPath, dirname } from '../../src/utils/path';
import { sidecarPath } from '../../src/utils/sidecarPath';
import { REVIEW_ANCHOR_VERSION } from '../../src/utils/reviewAnchorMap';

interface MemoryTauriOptions {
  files?: Record<string, string>;
  openPath?: string;
  savePath?: string;
  folderPath?: string;
  mockAI?: boolean;
  /** Raw text the mockAI spawn streams back (may include a quill-edits fence).
   *  Defaults to a plain prose reply. */
  aiReplyText?: string;
  /** Terminal event the mockAI spawn emits after the delta. Defaults to 'done'. */
  aiReplyOutcome?: 'done' | 'error' | 'cancelled';
  newSessionId?: string;
  /** Initial workspace payload. The shim persists later writes across reloads. */
  workspace?: string;
  /** Hold the first document write until the test calls __quillReleaseWriteFile. */
  deferFirstWriteFile?: boolean;
  /** Paths whose write_file_atomic always throws — for autosave failure injection. */
  failWritePaths?: string[];
  /** Session returned by the backend's markdown auto-bind scan. */
  foundSession?: unknown;
  /** Session-picker rows and previews for binding-policy tests. */
  claudeSessions?: unknown[];
  sessionPreviews?: Record<string, unknown>;
  /** Documents whose pre-seeded sidecars represent bindings approved locally. */
  trustedSidecarPaths?: string[];
  /** Deep link waiting before the frontend subscribes to runtime events. */
  pendingDeepLink?: string;
  /** Desktop diagnostics returned to Help → Copy Diagnostics. */
  diagnostics?: { version: string; os: string; arch: string; log_dir: string };
  /** Whether the frontend should yield file shortcuts to a real native menu. */
  hasNativeMenu?: boolean;
}

interface SeededDocumentPermission {
  session?: { sessionId: string; cwd: string; createdByQuill: boolean };
  contextFolder?: string;
}

function seededSidecarPermissions(options: MemoryTauriOptions) {
  const permissions: Record<string, SeededDocumentPermission> = {};
  for (const documentPath of options.trustedSidecarPaths ?? []) {
    const raw = options.files?.[sidecarPath(documentPath)];
    if (!raw) continue;
    try {
      const sidecar = JSON.parse(raw) as {
        aiSession?: { sessionId?: string; cwd?: string; createdByQuill?: boolean };
        contextFolder?: string;
      };
      const permission: SeededDocumentPermission = {};
      if (sidecar.aiSession?.sessionId && sidecar.aiSession.cwd) {
        const createdByQuill = sidecar.aiSession.createdByQuill === true;
        const cwd = createdByQuill ? dirname(documentPath) : sidecar.aiSession.cwd;
        if (cwd) {
          permission.session = {
            sessionId: sidecar.aiSession.sessionId,
            cwd: canonicalDocumentPath(cwd),
            createdByQuill,
          };
        }
      }
      if (sidecar.contextFolder) {
        permission.contextFolder = canonicalDocumentPath(sidecar.contextFolder);
      }
      if (permission.session || permission.contextFolder) {
        permissions[canonicalDocumentPath(documentPath)] = permission;
      }
    } catch {
      // Invalid sidecars intentionally remain untrusted in tests too.
    }
  }
  return permissions;
}

/**
 * A real Quill save stamps every review-bearing sidecar with `reviewSourceHash`
 * (the SHA-256 of the `.md` its coordinates were captured against) and
 * `reviewAnchorVersion`, so the next open reads it as BOUND and trusts the stored
 * positions — the steady state these tests mean to exercise. Hand-authored
 * fixtures omit that stamp, which would make every seeded document look like a
 * legacy file and send it through unbound relocation (conservative set-aside +
 * an "older version of Quill" migration notice whose modal overlay then blocks
 * the very interactions under test). So stamp any sidecar that carries review
 * records and no explicit provenance, mirroring `saveSidecar`. The hash matches
 * the shim's own read-side SHA-256 (UTF-8, lowercase hex). A fixture that WANTS
 * the legacy/unbound path expresses it by setting its own `reviewSourceHash`
 * (an intentional mismatch), which is left untouched.
 */
function stampBoundReviewAnchors(files: Record<string, string>): Record<string, string> {
  const stamped: Record<string, string> = { ...files };
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('.comments.json')) continue; // a document, not a sidecar
    const scPath = sidecarPath(path);
    const raw = files[scPath];
    if (raw === undefined) continue;
    let parsed: {
      comments?: unknown[];
      suggestions?: unknown[];
      reviewSourceHash?: unknown;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // an intentionally-malformed sidecar stays exactly as seeded
    }
    const hasReviewRecords =
      (Array.isArray(parsed.comments) && parsed.comments.length > 0) ||
      (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0);
    if (!hasReviewRecords || parsed.reviewSourceHash !== undefined) continue;
    stamped[scPath] = JSON.stringify({
      ...parsed,
      reviewSourceHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      reviewAnchorVersion: REVIEW_ANCHOR_VERSION,
    });
  }
  return stamped;
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
      folderPath,
      mockAI,
      aiReplyText,
      aiReplyOutcome,
      newSessionId,
      workspace,
      deferFirstWriteFile,
      failWritePaths,
      foundSession,
      claudeSessions,
      sessionPreviews,
      sidecarPermissions,
      pendingDeepLink,
      diagnostics,
      hasNativeMenu,
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
      if (Object.keys(sidecarPermissions).length > 0) {
        const key = 'quill-sidecar-permissions-v1';
        let existing: Record<string, SeededDocumentPermission> = {};
        try {
          existing = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<
            string,
            SeededDocumentPermission
          >;
        } catch {
          // The application also treats an invalid local registry as empty.
        }
        localStorage.setItem(key, JSON.stringify({ ...existing, ...sidecarPermissions }));
      }
      if (newSessionId) {
        Object.defineProperty(crypto, 'randomUUID', {
          configurable: true,
          value: () => newSessionId,
        });
      }

      // Faithful model of the Rust atomic-file contract (write_file_atomic /
      // delete_file_if_match): real SHA-256 over the exact content and honest
      // absent/present fingerprints, so conflict-detection tests exercise the true
      // semantics rather than a placeholder that would make them vacuous.
      type Fp = { state: 'absent' } | { state: 'present'; hash: string };
      const sha256Hex = async (content: string): Promise<string> => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      };
      const fingerprintOf = async (path: string): Promise<Fp> =>
        Object.prototype.hasOwnProperty.call(memoryFiles, path)
          ? { state: 'present', hash: await sha256Hex(memoryFiles[path] as string) }
          : { state: 'absent' };
      // Null when `expected` is satisfied by `current`; otherwise the conflicting
      // fingerprint. `any` always passes; `absent` requires no file; `match`
      // requires the exact hash (a changed or deleted file conflicts).
      const expectationConflict = (
        expected: { mode?: string; hash?: string } | undefined,
        current: Fp,
      ): Fp | null => {
        const mode = expected?.mode ?? 'any';
        if (mode === 'absent') return current.state === 'absent' ? null : current;
        if (mode === 'match') {
          return current.state === 'present' && current.hash === expected?.hash ? null : current;
        }
        return null; // 'any'
      };

      globals.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        convertFileSrc: (filePath: string, protocol = 'asset') =>
          `${protocol}://localhost/${encodeURIComponent(filePath)}`,
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
          if (cmd === 'take_pending_deep_link') return pendingDeepLink ?? null;
          if (cmd === 'has_native_menu') return hasNativeMenu;
          if (cmd === 'get_diagnostics') return diagnostics;
          if (cmd === 'show_open_dialog') return openPath ?? null;
          if (cmd === 'show_save_dialog') return savePath ?? null;
          if (cmd === 'show_folder_dialog') return folderPath ?? null;
          if (cmd === 'list_claude_sessions') return claudeSessions ?? [];
          if (cmd === 'read_claude_session_preview') {
            return sessionPreviews?.[args.jsonlPath as string] ?? null;
          }
          if (cmd === 'read_file') {
            const path = args.path as string;
            if (Object.prototype.hasOwnProperty.call(memoryFiles, path)) return memoryFiles[path];
            throw new Error(`File not found: ${path}`);
          }
          if (cmd === 'read_file_with_fingerprint') {
            const path = args.path as string;
            if (Object.prototype.hasOwnProperty.call(memoryFiles, path)) {
              const content = memoryFiles[path] as string;
              return { state: 'present', content, hash: await sha256Hex(content) };
            }
            return { state: 'absent' };
          }
          if (cmd === 'write_file_atomic') {
            if (failWritePaths?.includes(args.path as string)) {
              throw new Error(`Injected write failure: ${args.path as string}`);
            }
            if (deferFirstWriteFile && globals.__quillReleaseWriteFile === undefined) {
              globals.__quillWriteFileBlocked = true;
              await new Promise<void>((resolve) => {
                globals.__quillReleaseWriteFile = () => {
                  globals.__quillWriteFileBlocked = false;
                  resolve();
                };
              });
            }
            const writePath = args.path as string;
            const conflict = expectationConflict(
              args.expected as { mode?: string; hash?: string } | undefined,
              await fingerprintOf(writePath),
            );
            if (conflict) return { status: 'conflict', actual: conflict };
            const content = args.content as string;
            memoryFiles[writePath] = content;
            return { status: 'written', hash: await sha256Hex(content) };
          }
          if (cmd === 'delete_file_if_match') {
            const deletePath = args.path as string;
            const current = await fingerprintOf(deletePath);
            const conflict = expectationConflict(
              args.expected as { mode?: string; hash?: string } | undefined,
              current,
            );
            if (conflict) return { status: 'conflict', actual: conflict };
            if (current.state === 'absent') return { status: 'absent' };
            delete memoryFiles[deletePath];
            return { status: 'deleted' };
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
            queueMicrotask(() => {
              onEvent({ kind: 'delta', text: aiReplyText });
              // The terminal event: 'done' (default), 'error', or 'cancelled'.
              if (aiReplyOutcome === 'error') onEvent({ kind: 'error', message: 'mock error' });
              else if (aiReplyOutcome === 'cancelled') onEvent({ kind: 'cancelled' });
              else onEvent({ kind: 'done' });
            });
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
      files: stampBoundReviewAnchors(options.files ?? {}),
      openPath: options.openPath ?? null,
      savePath: options.savePath ?? null,
      folderPath: options.folderPath ?? null,
      mockAI: options.mockAI ?? false,
      aiReplyText: options.aiReplyText ?? 'Persist this answer.',
      aiReplyOutcome: options.aiReplyOutcome ?? 'done',
      newSessionId: options.newSessionId ?? null,
      workspace: options.workspace ?? null,
      deferFirstWriteFile: options.deferFirstWriteFile ?? false,
      failWritePaths: options.failWritePaths ?? [],
      foundSession: options.foundSession ?? null,
      claudeSessions: options.claudeSessions ?? [],
      sessionPreviews: options.sessionPreviews ?? {},
      sidecarPermissions: seededSidecarPermissions(options),
      pendingDeepLink: options.pendingDeepLink ?? null,
      diagnostics: options.diagnostics ?? {
        version: '1.1.2-test',
        os: 'macOS',
        arch: 'aarch64',
        log_dir: '/tmp/quill-logs',
      },
      hasNativeMenu: options.hasNativeMenu ?? false,
    },
  );

  await page.goto('/');
  await activeEditor(page).waitFor({ timeout: 5000 });
}

export function activeTabHost(page: Page) {
  return page.locator('.document-tab-host:not([hidden])');
}

export const LIVE_EDITOR_SELECTOR = '.ProseMirror[contenteditable="true"]';

export function activeEditor(page: Page) {
  return activeTabHost(page).locator(LIVE_EDITOR_SELECTOR);
}

export async function closeSessionPickerIfOpen(page: Page) {
  const picker = page.getByRole('dialog', { name: 'Link Claude Code session' });
  if (await picker.count()) {
    await picker.getByRole('button', { name: 'Close' }).click();
    // Wait for React to commit the close before callers proceed — otherwise a
    // still-mounted modal can intercept the next interaction under load.
    await expect(picker).toHaveCount(0);
  }
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
  await page.waitForFunction(() => {
    const location = document.querySelector('[aria-label="Document location"]');
    return location !== null && location.textContent?.trim() !== 'Untitled';
  });
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
