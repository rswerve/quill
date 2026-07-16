import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  useFileManager,
  stripTransientReplyState,
  type SaveOutcome,
} from '../../hooks/useFileManager';
import type { ChatMessage, Comment, DocumentChatThread, Reply } from '../../types';

const mockInvoke = vi.mocked(invoke);

// Distinct fake SHA-256 hex values the atomic backend would return.
const HASH_DOC = 'a'.repeat(64);
const HASH_SIDECAR = 'b'.repeat(64);

/**
 * Route invoke() to the atomic-persistence contract so save tests get the shapes
 * useFileManager now expects: write_file_atomic → written{hash}, delete_file_if_match
 * → deleted, find_session_for_markdown → null. read_file resolves from `reads` (a
 * path→content map) and otherwise reports "not found". Individual tests can still
 * override with mockImplementation/mockResolvedValueOnce after calling this.
 */
function installSaveRouter(reads: Record<string, string> = {}) {
  mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
    const path = (args as { path?: string } | undefined)?.path;
    switch (command) {
      case 'read_file':
        if (path && path in reads) return reads[path];
        throw new Error('File not found');
      case 'write_file_atomic':
        return {
          status: 'written',
          hash: path?.endsWith('.comments.json') ? HASH_SIDECAR : HASH_DOC,
        };
      case 'delete_file_if_match':
        return { status: 'deleted' };
      case 'find_session_for_markdown':
        return null;
      default:
        return undefined;
    }
  });
}

const SAMPLE_COMMENT: Comment = {
  id: 'c1',
  kind: 'note',
  anchorText: 'hi',
  from: 0,
  to: 2,
  author: 'Alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  resolved: false,
  replies: [],
};

const SAMPLE_SIDECAR = JSON.stringify({
  version: 1,
  comments: [SAMPLE_COMMENT],
  suggestions: [],
});

const SAMPLE_CHAT: DocumentChatThread = {
  sessionId: 'session-chat',
  messages: [
    { id: 'u1', role: 'user', text: 'Tighten this', createdAt: 'now' },
    {
      id: 'a1',
      role: 'assistant',
      text: 'Done',
      createdAt: 'later',
      suggestionIds: ['s1'],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFileManager', () => {
  describe('openFilePath', () => {
    it('reads the file and sidecar, returns content and parsed sidecar', async () => {
      mockInvoke.mockResolvedValueOnce('# Hello').mockResolvedValueOnce(SAMPLE_SIDECAR);

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;

      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.content).toBe('# Hello');
      expect(res!.filePath).toBe('/docs/test.md');
      expect(res!.sidecar.comments).toHaveLength(1);
      expect(result.current.filePath).toBe('/docs/test.md');
      expect(result.current.isDirty).toBe(false);
    });

    it('calls sidecarPath correctly — sidecar invoke uses .comments.json path', async () => {
      mockInvoke.mockResolvedValueOnce('content').mockResolvedValueOnce('{}');

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/file.md');
      });

      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'read_file', {
        path: '/docs/file.comments.json',
      });
    });

    it('falls back to empty sidecar when sidecar read fails', async () => {
      mockInvoke
        .mockResolvedValueOnce('# Hello')
        .mockRejectedValueOnce(new Error('File not found'));

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.sidecar.comments).toEqual([]);
      expect(res!.sidecar.suggestions).toEqual([]);
    });

    it('returns null and does not update state when main file read fails', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Permission denied'));

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!).toBeNull();
      expect(result.current.filePath).toBeNull();
    });

    it('flags sidecarError when the sidecar exists but is invalid JSON', async () => {
      mockInvoke
        .mockResolvedValueOnce('# Hello') // read_file (md)
        .mockResolvedValueOnce('{ not valid json') // read_file (sidecar) — corrupt
        .mockResolvedValueOnce(null); // find_session_for_markdown

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.sidecarError).toBeTruthy();
      // We keep an empty in-memory model rather than dropping the user's data.
      expect(res!.sidecar.comments).toEqual([]);
      expect(res!.sidecar.suggestions).toEqual([]);
    });
  });

  describe('saveFile', () => {
    it('returns cancelled and does not invoke when no filePath is set', async () => {
      const { result } = renderHook(() => useFileManager());
      let res: SaveOutcome;
      await act(async () => {
        res = await result.current.saveFile('content', [], [], null, null);
      });
      expect(res!.status).toBe('cancelled');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('writes file and sidecar atomically, returns saved with hashes', async () => {
      installSaveRouter({ '/docs/test.md': 'content', '/docs/test.comments.json': '{}' });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('updated content', [], [], null, null);
      });

      expect(outcome!).toEqual({
        status: 'saved',
        path: '/docs/test.md',
        docHash: HASH_DOC,
        // Empty comments/suggestions → the sidecar is removed, so it's absent.
        sidecar: { state: 'absent' },
      });
      expect(mockInvoke).toHaveBeenCalledWith('write_file_atomic', {
        path: '/docs/test.md',
        content: 'updated content',
        expected: { mode: 'any' },
      });
      expect(result.current.isDirty).toBe(false);
    });

    it('does not clear a newer dirty revision when an older save finishes', async () => {
      let releaseWrite: (() => void) | undefined;
      const writeBlocked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      mockInvoke.mockImplementation(async (command, args) => {
        const path = (args as { path?: string } | undefined)?.path;
        if (command === 'read_file' && path === '/docs/test.md') return 'saved content';
        if (command === 'read_file') throw new Error('sidecar not found');
        if (command === 'find_session_for_markdown') return null;
        if (command === 'write_file_atomic' && path === '/docs/test.md') {
          await writeBlocked;
          return { status: 'written', hash: HASH_DOC };
        }
        if (command === 'write_file_atomic') return { status: 'written', hash: HASH_SIDECAR };
        if (command === 'delete_file_if_match') return { status: 'deleted' };
        return null;
      });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
        result.current.markDirty();
      });

      let savePromise: Promise<SaveOutcome>;
      await act(async () => {
        savePromise = result.current.saveFile('older snapshot', [], [], null, null);
        await Promise.resolve();
      });
      act(() => result.current.markDirty());
      releaseWrite?.();
      await act(async () => {
        await savePromise;
      });

      expect(result.current.isDirty).toBe(true);
    });

    it('uses forcePath when provided, overriding stored filePath', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('content', [], [], null, null, '/override/path.md');
      });
      expect(outcome!).toMatchObject({ status: 'saved', path: '/override/path.md' });
      expect(mockInvoke).toHaveBeenCalledWith('write_file_atomic', {
        path: '/override/path.md',
        content: 'content',
        expected: { mode: 'any' },
      });
    });

    it('deletes the sidecar (conditionally) when comments and suggestions are both empty', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [], [], null, null, '/docs/test.md');
      });
      expect(mockInvoke).toHaveBeenCalledWith('delete_file_if_match', {
        path: '/docs/test.comments.json',
        expected: { mode: 'any' },
      });
    });

    it('propagates a sidecar delete failure instead of swallowing it', async () => {
      // A swallowed delete failure can resurrect deleted annotations on reopen, so
      // a real I/O error must surface as a failed save (not a false success).
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'write_file_atomic') return { status: 'written', hash: HASH_DOC };
        if (command === 'delete_file_if_match') throw 'Permission denied (os error 13)';
        return undefined;
      });
      const onError = vi.fn();
      const { result } = renderHook(() => useFileManager(onError));
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('content', [], [], null, null, '/docs/test.md');
      });
      expect(outcome!.status).toBe('failed');
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('writes sidecar JSON when there are comments', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [SAMPLE_COMMENT], [], null, null, '/docs/test.md');
      });
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(sidecarCall).toBeDefined();
      const written = JSON.parse((sidecarCall![1] as { content: string }).content);
      expect(written.version).toBe(2);
      expect(written.comments).toHaveLength(1);
    });

    it('strips transient AI replies from the written sidecar', async () => {
      installSaveRouter();
      const commentWithReplies: Comment = {
        ...SAMPLE_COMMENT,
        replies: [
          { id: 'u1', author: 'Alice', text: 'nice', createdAt: '', authorKind: 'user' },
          {
            id: 'a1',
            author: 'Claude',
            text: 'done',
            createdAt: '',
            authorKind: 'ai',
          },
          { id: 'a2', author: 'Claude', text: '', createdAt: '', authorKind: 'ai', pending: true },
          {
            id: 'a3',
            author: 'Claude',
            text: 'oops',
            createdAt: '',
            authorKind: 'ai',
            error: 'API Error',
          },
          {
            id: 'a4',
            author: 'Claude',
            text: '',
            createdAt: '',
            authorKind: 'ai',
            cancelled: true,
          },
        ],
      };
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile(
          'content',
          [commentWithReplies],
          [],
          null,
          null,
          '/docs/t.md',
        );
      });
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      const written = JSON.parse((sidecarCall![1] as { content: string }).content);
      const persisted = written.comments[0].replies.map((r: Reply) => r.id);
      expect(persisted).toEqual(['u1', 'a1']); // pending a2 + errored a3 + cancelled a4 dropped
    });

    it('downgrades a half-streamed chat turn to cancelled in the written sidecar', async () => {
      // An autosave that lands mid-stream must not persist a live pending turn — it
      // would resurrect a spinner for a stream that no longer exists on reopen.
      installSaveRouter();
      const midStreamChat: DocumentChatThread = {
        sessionId: 'session-chat',
        messages: [
          { id: 'u1', role: 'user', text: 'Rewrite the intro', createdAt: 'now' },
          { id: 'a1', role: 'assistant', text: 'Half a resp', createdAt: 'now', pending: true },
        ],
      };
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [], [], null, null, '/docs/c.md', midStreamChat);
      });
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      const written = JSON.parse((sidecarCall![1] as { content: string }).content);
      const assistant = written.chat.messages.find((m: ChatMessage) => m.id === 'a1');
      expect(assistant.pending).toBe(false); // downgraded, matching restore's transform
      expect(assistant.cancelled).toBe(true);
      expect(assistant.text).toBe('Half a resp'); // partial text is kept, retryable
    });

    it('does not clobber the sidecar on same-path save when it was corrupt on open', async () => {
      // Open a file whose sidecar is present but unreadable, then save back to
      // the same path. The corrupt sidecar must be left untouched (no write, no
      // delete) so the user can recover it.
      installSaveRouter({ '/docs/test.md': '# Hello', '/docs/test.comments.json': '{ corrupt' });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      mockInvoke.mockClear();
      await act(async () => {
        await result.current.saveFile('updated', [], [], null, null);
      });

      // The markdown is saved...
      expect(mockInvoke).toHaveBeenCalledWith('write_file_atomic', {
        path: '/docs/test.md',
        content: 'updated',
        expected: { mode: 'any' },
      });
      // ...but nothing touches the sidecar path.
      const touchedSidecar = mockInvoke.mock.calls.some(
        (call) =>
          (call[0] === 'write_file_atomic' || call[0] === 'delete_file_if_match') &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(touchedSidecar).toBe(false);
    });

    it('reports blocked and STAYS dirty when saving over a protected sidecar', async () => {
      // The Phase-1 honesty fix: a corrupt sidecar must never let a save read as a
      // clean success. Previously this cleared dirty and returned the path, dropping
      // the recovery snapshot while annotations went unpersisted.
      installSaveRouter({ '/docs/test.md': '# Hello', '/docs/test.comments.json': '{ corrupt' });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
        result.current.markDirty();
      });

      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('updated', [SAMPLE_COMMENT], [], null, null);
      });

      expect(outcome!).toEqual({ status: 'blocked', reason: 'sidecar-protected' });
      expect(result.current.isDirty).toBe(true);
    });

    it('persists contextFolder in the sidecar and keeps the sidecar alive for it alone', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [], [], null, '/refs/folder', '/docs/test.md');
      });

      // No comments/suggestions/session, but a linked folder — the sidecar must
      // be written (not deleted) and must carry the folder.
      expect(mockInvoke).not.toHaveBeenCalledWith('delete_file_if_match', expect.anything());
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(sidecarCall).toBeDefined();
      const written = JSON.parse((sidecarCall![1] as { content: string }).content);
      expect(written.contextFolder).toBe('/refs/folder');
    });

    it('round-trips contextFolder through open', async () => {
      mockInvoke.mockResolvedValueOnce('# Hello').mockResolvedValueOnce(
        JSON.stringify({
          version: 2,
          comments: [],
          suggestions: [],
          aiSession: { provider: 'claude-code', sessionId: 's', cwd: '/x', linkedAt: 'now' },
          contextFolder: '/refs/research',
        }),
      );

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.sidecar.contextFolder).toBe('/refs/research');
    });

    it('writes and restores a document-local chat thread through the sidecar', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [], [], null, null, '/docs/chat.md', SAMPLE_CHAT);
      });
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(sidecarCall).toBeDefined();
      expect(JSON.parse((sidecarCall![1] as { content: string }).content).chat).toEqual(
        SAMPLE_CHAT,
      );

      mockInvoke.mockReset();
      mockInvoke
        .mockResolvedValueOnce('# Chat')
        .mockResolvedValueOnce(
          JSON.stringify({ version: 2, comments: [], suggestions: [], chat: SAMPLE_CHAT }),
        )
        .mockResolvedValueOnce(null);
      let opened: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        opened = await result.current.openFilePath('/docs/chat.md');
      });
      expect(opened!.sidecar.chat).toEqual(SAMPLE_CHAT);
    });

    it('still writes the sidecar on Save As (new path) after a corrupt open', async () => {
      // A Save As to a different path is a fresh file; the corruption guard only
      // protects the original path, so the new sidecar writes normally.
      installSaveRouter({ '/docs/test.md': '# Hello', '/docs/test.comments.json': '{ corrupt' });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      mockInvoke.mockClear();
      await act(async () => {
        await result.current.saveFile(
          'updated',
          [SAMPLE_COMMENT],
          [],
          null,
          null,
          '/docs/other.md',
        );
      });

      const wroteNewSidecar = mockInvoke.mock.calls.some(
        (call) =>
          call[0] === 'write_file_atomic' &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path === '/docs/other.comments.json',
      );
      expect(wroteNewSidecar).toBe(true);
    });

    it('clears corrupt-sidecar protection after Save As so later saves persist review data', async () => {
      installSaveRouter({
        '/docs/original.md': '# Hello',
        '/docs/original.comments.json': '{ corrupt',
      });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/original.md');
        await result.current.saveFile(
          'first save',
          [SAMPLE_COMMENT],
          [],
          null,
          null,
          '/docs/recovered.md',
        );
      });

      mockInvoke.mockClear();
      await act(async () => {
        await result.current.saveFile(
          'second save',
          [SAMPLE_COMMENT, { ...SAMPLE_COMMENT, id: 'c2', anchorText: 'second', from: 3, to: 9 }],
          [],
          null,
          null,
        );
      });

      const sidecarWrite = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' &&
          (call[1] as { path: string }).path === '/docs/recovered.comments.json',
      );
      expect(sidecarWrite).toBeDefined();
      const written = JSON.parse((sidecarWrite![1] as { content: string }).content);
      expect(written.comments).toHaveLength(2);
    });
  });

  describe('saveFileAs', () => {
    it('appends .md when the dialog returns a path without it', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'show_save_dialog') return '/docs/newfile';
        if (command === 'write_file_atomic') return { status: 'written', hash: HASH_DOC };
        if (command === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });

      const { result } = renderHook(() => useFileManager());
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFileAs('content', [], [], null, null);
      });
      expect(outcome!).toMatchObject({ status: 'saved', path: '/docs/newfile.md' });
    });

    it('does not double-append .md when dialog already returns it', async () => {
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === 'show_save_dialog') return '/docs/newfile.md';
        if (command === 'write_file_atomic') return { status: 'written', hash: HASH_DOC };
        if (command === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });

      const { result } = renderHook(() => useFileManager());
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFileAs('content', [], [], null, null);
      });
      expect(outcome!).toMatchObject({ status: 'saved', path: '/docs/newfile.md' });
    });

    it('returns cancelled when the save dialog is cancelled', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      const { result } = renderHook(() => useFileManager());
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFileAs('content', [], [], null, null);
      });
      expect(outcome!.status).toBe('cancelled');
    });

    it('returns cancelled when path ownership is declined', async () => {
      mockInvoke.mockResolvedValueOnce('/docs/taken.md');
      const { result } = renderHook(() => useFileManager());
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFileAs(
          'content',
          [],
          [],
          null,
          null,
          undefined,
          () => false,
        );
      });
      expect(outcome!.status).toBe('cancelled');
      // No write happens when ownership is refused.
      expect(mockInvoke).not.toHaveBeenCalledWith('write_file_atomic', expect.anything());
    });
  });

  describe('onError reporting', () => {
    it('reports an open failure with the path and underlying error', async () => {
      mockInvoke.mockRejectedValueOnce('Permission denied (os error 13)');
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      await act(async () => {
        await result.current.openFilePath('/docs/locked.md');
      });

      expect(onError).toHaveBeenCalledTimes(1);
      const [title, message] = onError.mock.calls[0];
      expect(title).toBe('Could not open file');
      expect(message).toContain('/docs/locked.md');
      expect(message).toContain('Permission denied');
    });

    it('reports a save failure with the path and underlying error', async () => {
      mockInvoke.mockRejectedValueOnce('Disk full (os error 28)');
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      let saved: SaveOutcome | null = null;
      await act(async () => {
        saved = await result.current.saveFile('content', [], [], null, null, '/docs/out.md');
      });

      expect(saved!.status).toBe('failed');
      expect(onError).toHaveBeenCalledTimes(1);
      const [title, message] = onError.mock.calls[0];
      expect(title).toBe('Could not save file');
      expect(message).toContain('/docs/out.md');
      expect(message).toContain('Disk full');
    });

    it('does not report when the open dialog is simply cancelled', async () => {
      mockInvoke.mockResolvedValueOnce(null); // show_open_dialog → cancelled
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      await act(async () => {
        await result.current.openFile();
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not report when the sidecar is merely missing', async () => {
      mockInvoke
        .mockResolvedValueOnce('# Hello')
        .mockRejectedValueOnce(new Error('File not found'))
        .mockResolvedValueOnce(null); // find_session_for_markdown
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('newFile', () => {
    it('clears filePath and resets isDirty', async () => {
      mockInvoke.mockResolvedValueOnce('content').mockResolvedValueOnce('{}');

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });
      act(() => {
        result.current.markDirty();
      });
      expect(result.current.isDirty).toBe(true);

      act(() => {
        result.current.newFile();
      });
      expect(result.current.filePath).toBeNull();
      expect(result.current.isDirty).toBe(false);
    });
  });

  describe('markDirty', () => {
    it('sets isDirty to true', () => {
      const { result } = renderHook(() => useFileManager());
      act(() => {
        result.current.markDirty();
      });
      expect(result.current.isDirty).toBe(true);
    });
  });
});

describe('stripTransientReplyState', () => {
  const reply = (over: Partial<Reply>): Reply => ({
    id: 'r',
    author: 'x',
    text: 't',
    createdAt: '',
    authorKind: 'user',
    ...over,
  });

  const commentWith = (replies: Reply[]): Comment => ({ ...SAMPLE_COMMENT, replies });

  it('drops an errored AI reply', () => {
    const out = stripTransientReplyState([
      commentWith([reply({ id: 'a', authorKind: 'ai', error: 'API Error' })]),
    ]);
    expect(out[0].replies).toEqual([]);
  });

  it('drops a pending AI reply', () => {
    const out = stripTransientReplyState([
      commentWith([reply({ id: 'a', authorKind: 'ai', text: '', pending: true })]),
    ]);
    expect(out[0].replies).toEqual([]);
  });

  it('keeps a finished AI reply', () => {
    const finished = reply({ id: 'a', authorKind: 'ai', text: 'done' });
    const out = stripTransientReplyState([commentWith([finished])]);
    expect(out[0].replies).toEqual([finished]);
  });

  it('keeps user replies, even pending/errored ones (only AI transient state is stripped)', () => {
    // pending/error should never appear on a user reply, but the guard is
    // scoped to authorKind 'ai' — a user reply is retained regardless.
    const userReplies = [
      reply({ id: 'u1', text: 'hi' }),
      reply({ id: 'u2', text: 'yo', pending: true }),
    ];
    const out = stripTransientReplyState([commentWith(userReplies)]);
    expect(out[0].replies).toEqual(userReplies);
  });

  it('returns the same comment reference when nothing is stripped', () => {
    const comment = commentWith([
      reply({ id: 'u1' }),
      reply({ id: 'a', authorKind: 'ai', text: 'x' }),
    ]);
    const out = stripTransientReplyState([comment]);
    expect(out[0]).toBe(comment); // referential identity preserved — no needless copy
  });

  it('strips only the transient replies from a mixed thread', () => {
    const out = stripTransientReplyState([
      commentWith([
        reply({ id: 'u1' }),
        reply({ id: 'a1', authorKind: 'ai', text: 'done' }),
        reply({ id: 'a2', authorKind: 'ai', text: '', pending: true }),
        reply({ id: 'a3', authorKind: 'ai', text: 'oops', error: 'boom' }),
      ]),
    ]);
    expect(out[0].replies.map((r) => r.id)).toEqual(['u1', 'a1']);
  });
});
