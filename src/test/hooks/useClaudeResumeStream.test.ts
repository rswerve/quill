import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useClaudeResumeStream } from '../../hooks/useClaudeResumeStream';

const args = {
  sessionId: 'constructed-session',
  cwd: '/constructed',
  prompt: 'constructed prompt',
  addDir: null,
  allowCreate: false,
  model: null,
  effort: null,
};

const handlers = () => ({
  onVisibleChunk: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn(),
  onCancelled: vi.fn(),
});

afterEach(() => {
  delete window.__quillMock;
});

describe('useClaudeResumeStream generations', () => {
  it('refuses a cancelled preflight generation and permits the next generation', async () => {
    const spawn = vi.fn(() => 'constructed-token');
    window.__quillMock = { spawn };
    const { result } = renderHook(() => useClaudeResumeStream());
    const generation = result.current.begin('stream');
    await act(async () => {
      await result.current.cancel('stream');
      await result.current.run('stream', args, handlers(), generation);
    });
    expect(spawn).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.run('stream', args, handlers(), result.current.begin('stream'));
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('invalidates every preflight generation on unmount before a token exists', async () => {
    const spawn = vi.fn(() => 'unexpected-token');
    window.__quillMock = { spawn };
    const { result, unmount } = renderHook(() => useClaudeResumeStream());
    const stream = result.current;
    const first = stream.begin('first');
    const second = stream.begin('second');
    unmount();
    await act(async () => {
      await stream.run('first', args, handlers(), first);
      await stream.run('second', args, handlers(), second);
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
