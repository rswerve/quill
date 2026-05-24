import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useFileManager } from '../../hooks/useFileManager';
import type { Comment } from '../../types';

const mockInvoke = vi.mocked(invoke);

const SAMPLE_COMMENT: Comment = {
  id: 'c1',
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
  });

  describe('saveFile', () => {
    it('returns null and does not invoke when no filePath is set', async () => {
      const { result } = renderHook(() => useFileManager());
      let res: string | null;
      await act(async () => {
        res = await result.current.saveFile('content', [], [], null);
      });
      expect(res!).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('writes file and sidecar, returns the path', async () => {
      mockInvoke
        .mockResolvedValueOnce('content')
        .mockResolvedValueOnce('{}')
        .mockResolvedValue(undefined);

      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.openFilePath('/docs/test.md');
      });

      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFile('updated content', [], [], null);
      });

      expect(savedPath!).toBe('/docs/test.md');
      expect(mockInvoke).toHaveBeenCalledWith('write_file', {
        path: '/docs/test.md',
        content: 'updated content',
      });
      expect(result.current.isDirty).toBe(false);
    });

    it('uses forcePath when provided, overriding stored filePath', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFile('content', [], [], null, '/override/path.md');
      });
      expect(savedPath!).toBe('/override/path.md');
      expect(mockInvoke).toHaveBeenCalledWith('write_file', {
        path: '/override/path.md',
        content: 'content',
      });
    });

    it('deletes sidecar when comments and suggestions are both empty', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [], [], null, '/docs/test.md');
      });
      expect(mockInvoke).toHaveBeenCalledWith('delete_file', {
        path: '/docs/test.comments.json',
      });
    });

    it('writes sidecar JSON when there are comments', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileManager());
      await act(async () => {
        await result.current.saveFile('content', [SAMPLE_COMMENT], [], null, '/docs/test.md');
      });
      const sidecarCall = mockInvoke.mock.calls.find(
        (call) =>
          call[0] === 'write_file' &&
          typeof call[1] === 'object' &&
          (call[1] as { path: string }).path.endsWith('.comments.json'),
      );
      expect(sidecarCall).toBeDefined();
      const written = JSON.parse((sidecarCall![1] as { content: string }).content);
      expect(written.version).toBe(2);
      expect(written.comments).toHaveLength(1);
    });
  });

  describe('saveFileAs', () => {
    it('appends .md when the dialog returns a path without it', async () => {
      mockInvoke.mockResolvedValueOnce('/docs/newfile').mockResolvedValue(undefined);

      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFileAs('content', [], [], null);
      });
      expect(savedPath!).toBe('/docs/newfile.md');
    });

    it('does not double-append .md when dialog already returns it', async () => {
      mockInvoke.mockResolvedValueOnce('/docs/newfile.md').mockResolvedValue(undefined);

      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFileAs('content', [], [], null);
      });
      expect(savedPath!).toBe('/docs/newfile.md');
    });

    it('returns null when the save dialog is cancelled', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      const { result } = renderHook(() => useFileManager());
      let savedPath: string | null;
      await act(async () => {
        savedPath = await result.current.saveFileAs('content', [], [], null);
      });
      expect(savedPath!).toBeNull();
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
