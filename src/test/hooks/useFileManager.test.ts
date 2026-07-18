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
import type {
  ChatMessage,
  Comment,
  DocumentChatThread,
  Reply,
  StructuralSuggestionRecord,
} from '../../types';

const SAMPLE_STRUCTURAL: StructuralSuggestionRecord = {
  changeId: 'sc1',
  author: 'claude',
  createdAt: '2026-01-01T00:00:00.000Z',
  op: { kind: 'headingToParagraph', level: 1 },
  anchor: { parentPath: [], childIndex: 0, childCount: 1 },
  sourceFingerprint: '# Title',
  proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
};

const mockInvoke = vi.mocked(invoke);

// Distinct fake SHA-256 hex values the atomic backend would return.
const HASH_DOC = 'a'.repeat(64);
const HASH_SIDECAR = 'b'.repeat(64);

/** A deterministic fake read fingerprint for a given content string. */
const readHash = (content: string) => `read-${content.length}`;
const fpPresent = (content: string) => ({ state: 'present', content, hash: readHash(content) });
const fpAbsent = () => ({ state: 'absent' });

/**
 * Route invoke() to the atomic-persistence contract so save tests get the shapes
 * useFileManager now expects: write_file_atomic → written{hash}, delete_file_if_match
 * → deleted, find_session_for_markdown → null, and read_file_with_fingerprint →
 * present{content,hash} / absent from `reads` (a path→content map). Individual tests
 * can still override with mockImplementation/mockResolvedValueOnce after calling this.
 */
function installSaveRouter(reads: Record<string, string> = {}) {
  mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
    const path = (args as { path?: string } | undefined)?.path;
    switch (command) {
      case 'read_file_with_fingerprint':
        return path && path in reads ? fpPresent(reads[path]) : fpAbsent();
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
      mockInvoke
        .mockResolvedValueOnce(fpPresent('# Hello'))
        .mockResolvedValueOnce(fpPresent(SAMPLE_SIDECAR));

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

    it('calls sidecarPath correctly — sidecar read uses .comments.json path', async () => {
      mockInvoke.mockResolvedValueOnce(fpPresent('content')).mockResolvedValueOnce(fpPresent('{}'));

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/file.md');
      });

      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'read_file_with_fingerprint', {
        path: '/docs/file.comments.json',
      });
    });

    it('falls back to empty sidecar when the sidecar is absent', async () => {
      mockInvoke.mockResolvedValueOnce(fpPresent('# Hello')).mockResolvedValueOnce(fpAbsent());

      const { result } = renderHook(() => useFileManager());
      let res: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        res = await result.current.openFilePath('/docs/test.md');
      });

      expect(res!.sidecar.comments).toEqual([]);
      expect(res!.sidecar.suggestions).toEqual([]);
      expect(res!.sidecarError).toBeNull();
    });

    it('returns null and does not update state when the main file read fails', async () => {
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
        .mockResolvedValueOnce(fpPresent('# Hello')) // read_file_with_fingerprint (md)
        .mockResolvedValueOnce(fpPresent('{ not valid json')) // sidecar — present but corrupt
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
      // The write is gated on the fingerprint seeded when the file was opened.
      expect(mockInvoke).toHaveBeenCalledWith('write_file_atomic', {
        path: '/docs/test.md',
        content: 'updated content',
        expected: { mode: 'match', hash: readHash('content') },
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
        if (command === 'read_file_with_fingerprint' && path === '/docs/test.md') {
          return fpPresent('saved content');
        }
        if (command === 'read_file_with_fingerprint') return fpAbsent();
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
      // Surfaces as a typed failed save (the caller presents it); never a false success.
      expect(outcome!.status).toBe('failed');
      expect((outcome! as Extract<SaveOutcome, { status: 'failed' }>).message).toContain(
        'Permission denied',
      );
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

      // The markdown is saved (gated on the fingerprint seeded at open)...
      expect(mockInvoke).toHaveBeenCalledWith('write_file_atomic', {
        path: '/docs/test.md',
        content: 'updated',
        expected: { mode: 'match', hash: readHash('# Hello') },
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

    it('adopts the Save As path even when an edit lands during the write (epoch vs revision)', async () => {
      // An edit is content churn, not an identity change, so the successfully-chosen
      // new path is still adopted; the concurrent edit only keeps the doc dirty.
      let releaseWrite: (() => void) | undefined;
      const writeBlocked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
        const path = (args as { path?: string } | undefined)?.path;
        if (command === 'write_file_atomic' && path === '/docs/new.md') {
          await writeBlocked;
          return { status: 'written', hash: HASH_DOC };
        }
        if (command === 'write_file_atomic') return { status: 'written', hash: HASH_SIDECAR };
        if (command === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });

      const { result } = renderHook(() => useFileManager());
      let savePromise: Promise<SaveOutcome>;
      await act(async () => {
        savePromise = result.current.saveFile('content', [], [], null, null, '/docs/new.md');
        await Promise.resolve();
      });
      act(() => result.current.markDirty()); // edit during the in-flight write
      releaseWrite?.();
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await savePromise;
      });

      expect(outcome!).toMatchObject({ status: 'saved', path: '/docs/new.md' });
      expect(result.current.filePath).toBe('/docs/new.md'); // new path ADOPTED despite the edit
      expect(result.current.isDirty).toBe(true); // the concurrent edit keeps it dirty
    });

    it('does not resurrect the old path when identity changes (New) during a write', async () => {
      let releaseWrite: (() => void) | undefined;
      const writeBlocked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
        const path = (args as { path?: string } | undefined)?.path;
        if (command === 'read_file_with_fingerprint' && path === '/docs/old.md') {
          return fpPresent('old');
        }
        if (command === 'read_file_with_fingerprint') return fpAbsent();
        if (command === 'find_session_for_markdown') return null;
        if (command === 'write_file_atomic' && path === '/docs/old.md') {
          await writeBlocked;
          return { status: 'written', hash: HASH_DOC };
        }
        if (command === 'write_file_atomic') return { status: 'written', hash: HASH_SIDECAR };
        if (command === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/old.md');
      });
      let savePromise: Promise<SaveOutcome>;
      await act(async () => {
        savePromise = result.current.saveFile('old edited', [], [], null, null); // → /docs/old.md
        await Promise.resolve();
      });
      act(() => result.current.newFile()); // identity changes to a fresh Untitled doc
      expect(result.current.filePath).toBeNull();
      releaseWrite?.();
      await act(async () => {
        await savePromise;
      });
      // The late write landed at /docs/old.md but must NOT resurrect it as the path.
      expect(result.current.filePath).toBeNull();
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
      mockInvoke.mockResolvedValueOnce(fpPresent('# Hello')).mockResolvedValueOnce(
        fpPresent(
          JSON.stringify({
            version: 2,
            comments: [],
            suggestions: [],
            aiSession: { provider: 'claude-code', sessionId: 's', cwd: '/x', linkedAt: 'now' },
            contextFolder: '/refs/research',
          }),
        ),
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
        .mockResolvedValueOnce(fpPresent('# Chat'))
        .mockResolvedValueOnce(
          fpPresent(
            JSON.stringify({ version: 2, comments: [], suggestions: [], chat: SAMPLE_CHAT }),
          ),
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

  describe('conflict detection', () => {
    type InvokeArgs = {
      path?: string;
      content?: string;
      expected?: { mode: string; hash?: string };
    };

    it('returns a doc conflict when the .md changed on disk, without adopting the actual fingerprint', async () => {
      const { result } = renderHook(() => useFileManager());
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          return a.path === '/d.md' ? fpPresent('orig') : fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          if (a.path === '/d.md' && a.expected?.mode === 'match') {
            return { status: 'conflict', actual: { state: 'present', hash: 'external' } };
          }
          return { status: 'written', hash: HASH_DOC };
        }
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/d.md'); // seeds expectedDoc from 'orig'
      });
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('edited', [], [], null, null);
      });
      expect(outcome!).toEqual({
        status: 'conflict',
        path: '/d.md',
        which: 'doc',
        actual: { state: 'present', hash: 'external' },
      });
    });

    it('advances the .md expectation after its write even when the sidecar conflicts (retry gates on the new .md hash)', async () => {
      const { result } = renderHook(() => useFileManager());
      let sidecarConflicts = true;
      const docExpectedHashes: (string | undefined)[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          if (a.path === '/d.md') return fpPresent('doc-orig');
          if (a.path === '/d.comments.json') return fpPresent('{}'); // valid, so not protected
          return fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          if (a.path?.endsWith('.comments.json')) {
            return sidecarConflicts
              ? { status: 'conflict', actual: { state: 'present', hash: 'sc-external' } }
              : { status: 'written', hash: 'sc-new' };
          }
          docExpectedHashes.push(a.expected?.hash);
          return { status: 'written', hash: `doc-${a.content}` }; // content-based hash
        }
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/d.md');
      });
      let first: SaveOutcome;
      await act(async () => {
        first = await result.current.saveFile('v1', [SAMPLE_COMMENT], [], null, null);
      });
      expect(first!).toMatchObject({ status: 'conflict', which: 'sidecar' });

      // Retry: the sidecar is fine now. The .md write must gate on the hash written
      // in the FIRST pass (doc-v1), not the stale open hash — proving the expectation
      // advanced right after the .md write despite the sidecar conflict.
      sidecarConflicts = false;
      let second: SaveOutcome;
      await act(async () => {
        second = await result.current.saveFile('v2', [SAMPLE_COMMENT], [], null, null);
      });
      expect(docExpectedHashes).toEqual([readHash('doc-orig'), 'doc-v1']);
      expect(second!.status).toBe('saved');
    });

    it('fails closed on an ambiguous sidecar read: opens protected, saves blocked, no sidecar write', async () => {
      const { result } = renderHook(() => useFileManager());
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          if (a.path === '/d.md') return fpPresent('doc');
          throw new Error('Permission denied'); // sidecar read is ambiguous
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') return { status: 'written', hash: HASH_DOC };
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      let opened: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        opened = await result.current.openFilePath('/d.md');
      });
      expect(opened!.sidecarError).toBeTruthy(); // protected

      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('edited', [SAMPLE_COMMENT], [], null, null);
      });
      expect(outcome!).toEqual({ status: 'blocked', reason: 'sidecar-protected' });
      const touchedSidecar = mockInvoke.mock.calls.some(
        (call) =>
          (call[0] === 'write_file_atomic' || call[0] === 'delete_file_if_match') &&
          (call[1] as InvokeArgs).path?.endsWith('.comments.json'),
      );
      expect(touchedSidecar).toBe(false);
    });

    it('replaces both baselines on re-open, and a FAILED re-open leaves the prior ones untouched', async () => {
      const { result } = renderHook(() => useFileManager());
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          if (a.path === '/a.md') return fpPresent('a-doc');
          if (a.path === '/b.md') throw new Error('Permission denied'); // Open B fails
          return fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') return { status: 'written', hash: HASH_DOC };
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/a.md'); // A: expectedDoc from 'a-doc'
      });
      let resB: Awaited<ReturnType<typeof result.current.openFilePath>>;
      await act(async () => {
        resB = await result.current.openFilePath('/b.md'); // fails
      });
      expect(resB!).toBeNull();
      expect(result.current.filePath).toBe('/a.md'); // still A

      // A save still gates on A's baseline and targets /a.md — B's failure didn't touch it.
      await act(async () => {
        await result.current.saveFile('a-edited', [], [], null, null);
      });
      const docWrite = mockInvoke.mock.calls.find(
        (call) => call[0] === 'write_file_atomic' && (call[1] as InvokeArgs).path === '/a.md',
      );
      expect((docWrite![1] as InvokeArgs).expected).toEqual({
        mode: 'match',
        hash: readHash('a-doc'),
      });
    });

    it('Save As writes a new path unconditionally, then gates the next save on the new fingerprint', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('v1', [], [], null, null, '/new.md'); // Save As, no prior baseline
      });
      const first = mockInvoke.mock.calls.find(
        (call) => call[0] === 'write_file_atomic' && (call[1] as InvokeArgs).path === '/new.md',
      );
      expect((first![1] as InvokeArgs).expected).toEqual({ mode: 'any' });

      mockInvoke.mockClear(); // keeps the router implementation
      await act(async () => {
        await result.current.saveFile('v2', [], [], null, null); // no forcePath → /new.md
      });
      const second = mockInvoke.mock.calls.find(
        (call) => call[0] === 'write_file_atomic' && (call[1] as InvokeArgs).path === '/new.md',
      );
      expect((second![1] as InvokeArgs).expected).toEqual({ mode: 'match', hash: HASH_DOC });
    });

    it('a FAILED Save As (sidecar I/O error) leaves the current document baseline untouched', async () => {
      const { result } = renderHook(() => useFileManager());
      const docWrites: { path?: string; expected?: unknown }[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          return a.path === '/a.md' ? fpPresent('a-doc') : fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          if (a.path === '/b.comments.json') throw new Error('Disk full'); // Save As sidecar I/O
          if (!a.path?.endsWith('.comments.json'))
            docWrites.push({ path: a.path, expected: a.expected });
          return { status: 'written', hash: `w-${a.content}` };
        }
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/a.md'); // baseline = readHash('a-doc')
      });
      let saveAs: SaveOutcome;
      await act(async () => {
        saveAs = await result.current.saveFile(
          'a-edited',
          [SAMPLE_COMMENT],
          [],
          null,
          null,
          '/b.md',
        );
      });
      expect(saveAs!.status).toBe('failed');
      expect(result.current.filePath).toBe('/a.md'); // B not adopted

      // A normal save now still gates on A's ORIGINAL hash, not B's write hash.
      await act(async () => {
        await result.current.saveFile('a-edited-2', [], [], null, null);
      });
      const aWrite = [...docWrites].reverse().find((w) => w.path === '/a.md');
      expect(aWrite!.expected).toEqual({ mode: 'match', hash: readHash('a-doc') });
    });

    it('a same-path Save As advances the current baseline immediately (no self-conflict on the next save)', async () => {
      const { result } = renderHook(() => useFileManager());
      const docWrites: { path?: string; expected?: unknown }[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          return a.path === '/a.md' ? fpPresent('a-doc') : fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          if (!a.path?.endsWith('.comments.json'))
            docWrites.push({ path: a.path, expected: a.expected });
          return { status: 'written', hash: `w-${a.content}` };
        }
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/a.md');
      });
      await act(async () => {
        await result.current.saveFile('v1', [], [], null, null, '/a.md'); // Save As to the SAME path
      });
      expect(docWrites[0].expected).toEqual({ mode: 'any' }); // unconditional write
      await act(async () => {
        await result.current.saveFile('v2', [], [], null, null); // normal save
      });
      // The normal save gates on the hash the same-path Save As wrote (w-v1), not the stale open hash.
      expect(docWrites[docWrites.length - 1].expected).toEqual({ mode: 'match', hash: 'w-v1' });
    });

    it('a successful re-open adopts the new file baselines (subsequent ops gate on B)', async () => {
      const { result } = renderHook(() => useFileManager());
      const ops: { path?: string; expected?: unknown }[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          if (a.path === '/a.md') return fpPresent('a-doc');
          if (a.path === '/b.md') return fpPresent('b-doc');
          if (a.path === '/b.comments.json') return fpPresent('{}');
          return fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          ops.push({ path: a.path, expected: a.expected });
          return { status: 'written', hash: 'w' };
        }
        if (cmd === 'delete_file_if_match') {
          ops.push({ path: a.path, expected: a.expected });
          return { status: 'deleted' };
        }
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/a.md');
      });
      await act(async () => {
        await result.current.openFilePath('/b.md'); // successful re-open
      });
      expect(result.current.filePath).toBe('/b.md');
      await act(async () => {
        await result.current.saveFile('b-edited', [], [], null, null); // empty → sidecar delete
      });
      expect(ops.find((o) => o.path === '/b.md')!.expected).toEqual({
        mode: 'match',
        hash: readHash('b-doc'),
      });
      expect(ops.find((o) => o.path === '/b.comments.json')!.expected).toEqual({
        mode: 'match',
        hash: readHash('{}'),
      });
    });

    it('a doc conflict keeps the original expectation across a retry (never adopts actual)', async () => {
      const { result } = renderHook(() => useFileManager());
      const docExpecteds: unknown[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          return a.path === '/d.md' ? fpPresent('orig') : fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          if (a.path === '/d.md') {
            docExpecteds.push(a.expected);
            return { status: 'conflict', actual: { state: 'present', hash: 'external' } };
          }
          return { status: 'written', hash: 'w' };
        }
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/d.md');
      });
      await act(async () => {
        await result.current.saveFile('e1', [], [], null, null);
      });
      await act(async () => {
        await result.current.saveFile('e2', [], [], null, null);
      });
      // Both attempts gate on the ORIGINAL open hash — the conflict never adopts 'external'.
      expect(docExpecteds).toEqual([
        { mode: 'match', hash: readHash('orig') },
        { mode: 'match', hash: readHash('orig') },
      ]);
    });

    it('blocks a saved-path save when its baseline is UNKNOWN (recovered without a baseline)', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      // A recovered saved-path draft with NO persisted baseline → unknown.
      act(() => {
        result.current.restoreDraft('/recovered.md', true);
      });
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('edited', [], [], null, null);
      });
      expect(outcome!).toEqual({ status: 'blocked', reason: 'baseline-unknown' });
      // Fail closed BEFORE any disk write.
      expect(mockInvoke).not.toHaveBeenCalledWith('write_file_atomic', expect.anything());
    });

    it('restores baselines so a save after recovery gates on the persisted fingerprint', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      act(() => {
        result.current.restoreDraft('/recovered.md', true, {
          expectedDoc: { state: 'present', hash: 'persisted-doc' },
          expectedSidecar: { state: 'absent' },
        });
      });
      await act(async () => {
        await result.current.saveFile('edited', [], [], null, null);
      });
      const docWrite = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file_atomic' && (call[1] as InvokeArgs).path === '/recovered.md',
      );
      expect((docWrite![1] as InvokeArgs).expected).toEqual({
        mode: 'match',
        hash: 'persisted-doc',
      });
    });

    it('restoring a saved path with an UNKNOWN sidecar baseline protects the sidecar', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      act(() => {
        result.current.restoreDraft('/recovered.md', true, {
          expectedDoc: { state: 'present', hash: 'doc' }, // doc known → .md may write
          expectedSidecar: null, // sidecar unknown → protect it
        });
      });
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('edited', [SAMPLE_COMMENT], [], null, null);
      });
      expect(outcome!).toEqual({ status: 'blocked', reason: 'sidecar-protected' });
    });

    it('normalizes an absent doc baseline for a saved path to unknown (fails closed)', async () => {
      installSaveRouter();
      const { result } = renderHook(() => useFileManager());
      // A saved .md cannot be absent — corrupt metadata → unknown, not "file gone".
      act(() => {
        result.current.restoreDraft('/saved.md', true, { expectedDoc: { state: 'absent' } });
      });
      let outcome: SaveOutcome;
      await act(async () => {
        outcome = await result.current.saveFile('edited', [], [], null, null);
      });
      expect(outcome!).toEqual({ status: 'blocked', reason: 'baseline-unknown' });
    });

    it('a same-path Save As whose sidecar fails still advances the doc baseline', async () => {
      const { result } = renderHook(() => useFileManager());
      let sidecarFails = true;
      const docWrites: { path?: string; expected?: unknown }[] = [];
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const a = (args ?? {}) as InvokeArgs;
        if (cmd === 'read_file_with_fingerprint') {
          return a.path === '/a.md' ? fpPresent('a-doc') : fpAbsent();
        }
        if (cmd === 'find_session_for_markdown') return null;
        if (cmd === 'write_file_atomic') {
          if (a.path?.endsWith('.comments.json')) {
            if (sidecarFails) throw new Error('Disk full');
            return { status: 'written', hash: 'sc' };
          }
          docWrites.push({ path: a.path, expected: a.expected });
          return { status: 'written', hash: `w-${a.content}` };
        }
        if (cmd === 'delete_file_if_match') return { status: 'deleted' };
        return undefined;
      });
      await act(async () => {
        await result.current.openFilePath('/a.md');
      });
      let saveAs: SaveOutcome;
      await act(async () => {
        saveAs = await result.current.saveFile('v1', [SAMPLE_COMMENT], [], null, null, '/a.md');
      });
      expect(saveAs!.status).toBe('failed'); // sidecar I/O threw
      // The .md hit the current file, so its baseline advanced despite the failure —
      // the next normal save gates on the hash just written (w-v1), not the open hash.
      sidecarFails = false;
      await act(async () => {
        await result.current.saveFile('v2', [], [], null, null);
      });
      expect(docWrites[docWrites.length - 1].expected).toEqual({ mode: 'match', hash: 'w-v1' });
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

    it('returns a typed failure for a failed save WITHOUT firing onError', async () => {
      // Save failures are presented by the caller, source-aware (a modal for a manual
      // save, quiet for autosave), so useFileManager returns the typed outcome and does
      // not pop a modal itself — an autosave must never interrupt with one.
      mockInvoke.mockRejectedValueOnce('Disk full (os error 28)');
      const onError = vi.fn();

      const { result } = renderHook(() => useFileManager(onError));
      let saved: SaveOutcome | null = null;
      await act(async () => {
        saved = await result.current.saveFile('content', [], [], null, null, '/docs/out.md');
      });

      expect(saved!.status).toBe('failed');
      expect((saved! as Extract<SaveOutcome, { status: 'failed' }>).message).toContain('Disk full');
      expect(onError).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce(fpPresent('# Hello'))
        .mockResolvedValueOnce(fpAbsent()) // sidecar absent — not an error
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
      mockInvoke.mockResolvedValueOnce(fpPresent('content')).mockResolvedValueOnce(fpPresent('{}'));

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

describe('structural envelope persistence', () => {
  const sidecarWrite = () =>
    mockInvoke.mock.calls.find(
      (call) =>
        call[0] === 'write_file_atomic' &&
        (call[1] as { path?: string })?.path?.endsWith('.comments.json'),
    );

  it('S1: a structural-only document still writes a sidecar (never deletes it)', async () => {
    installSaveRouter();
    const { result } = renderHook(() => useFileManager());
    await act(async () => {
      // No comments/suggestions/session/folder/chat — only a structural record.
      await result.current.saveFile('# Title', [], [], null, null, '/docs/s.md', null, {
        records: [SAMPLE_STRUCTURAL],
      });
    });
    // A delete would signal "nothing to persist"; the record must reach disk instead.
    const deleteCall = mockInvoke.mock.calls.find((call) => call[0] === 'delete_file_if_match');
    expect(deleteCall).toBeUndefined();
    const written = JSON.parse((sidecarWrite()![1] as { content: string }).content);
    expect(written.structural.records).toHaveLength(1);
    expect(written.structural.records[0].changeId).toBe('sc1');
  });

  it('stamps the envelope hash from the .md write, not the sidecar hash', async () => {
    installSaveRouter();
    const { result } = renderHook(() => useFileManager());
    await act(async () => {
      await result.current.saveFile('# Title', [], [], null, null, '/docs/s.md', null, {
        records: [SAMPLE_STRUCTURAL],
      });
    });
    const written = JSON.parse((sidecarWrite()![1] as { content: string }).content);
    expect(written.structural.version).toBe(1);
    // HASH_DOC is what write_file_atomic returns for the .md; HASH_SIDECAR is the
    // sidecar's own hash. The envelope must carry the SOURCE .md's hash (the F5 gate).
    expect(written.structural.sourceDocumentHash).toBe(HASH_DOC);
    expect(written.structural.sourceDocumentHash).not.toBe(HASH_SIDECAR);
  });

  it('omits the structural field entirely when there are no structural records', async () => {
    installSaveRouter();
    const { result } = renderHook(() => useFileManager());
    await act(async () => {
      await result.current.saveFile('body', [SAMPLE_COMMENT], [], null, null, '/docs/n.md');
    });
    const written = JSON.parse((sidecarWrite()![1] as { content: string }).content);
    expect(written.structural).toBeUndefined();
  });

  it('writes a preserved envelope verbatim, keeping its original (stale) hash', async () => {
    installSaveRouter();
    const { result } = renderHook(() => useFileManager());
    const preserved = {
      version: 1 as const,
      sourceDocumentHash: 'original-stale-hash',
      records: [SAMPLE_STRUCTURAL],
    };
    await act(async () => {
      await result.current.saveFile('# Title', [], [], null, null, '/docs/p.md', null, {
        envelope: preserved,
      });
    });
    const written = JSON.parse((sidecarWrite()![1] as { content: string }).content);
    // Verbatim: the ORIGINAL hash survives, NOT this write's .md hash, so the
    // quarantined records stay gated against the changed source on the next reload.
    expect(written.structural.sourceDocumentHash).toBe('original-stale-hash');
    expect(written.structural.sourceDocumentHash).not.toBe(HASH_DOC);
  });

  it('preserves a valid structural envelope on open and drops a malformed one', async () => {
    const withEnvelope = JSON.stringify({
      version: 2,
      comments: [],
      suggestions: [],
      structural: { version: 1, sourceDocumentHash: 'abc', records: [SAMPLE_STRUCTURAL] },
    });
    mockInvoke
      .mockResolvedValueOnce(fpPresent('# Title'))
      .mockResolvedValueOnce(fpPresent(withEnvelope));
    const { result } = renderHook(() => useFileManager());
    let good: Awaited<ReturnType<typeof result.current.openFilePath>>;
    await act(async () => {
      good = await result.current.openFilePath('/docs/g.md');
    });
    expect(good!.sidecar.structural?.records).toHaveLength(1);
    expect(good!.docHash).toBe(readHash('# Title'));

    const badEnvelope = JSON.stringify({
      version: 2,
      comments: [],
      suggestions: [],
      structural: { version: 2, sourceDocumentHash: 'abc', records: [] }, // wrong envelope version
    });
    mockInvoke
      .mockResolvedValueOnce(fpPresent('# Title'))
      .mockResolvedValueOnce(fpPresent(badEnvelope));
    let bad: Awaited<ReturnType<typeof result.current.openFilePath>>;
    await act(async () => {
      bad = await result.current.openFilePath('/docs/b.md');
    });
    expect(bad!.sidecar.structural).toBeUndefined();
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
