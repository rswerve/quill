import { useCallback, useRef } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AISessionBinding, ClaudeRunOptions } from '../types';

export type ChunkEvent =
  | { kind: 'model'; model: string }
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export const QUILL_EDITS_FENCE = '```quill-edits';

export interface ClaudeSpawnArgs {
  sessionId: string;
  cwd: string;
  prompt: string;
  addDir: string | null;
  allowCreate: boolean;
  model: ClaudeRunOptions['model'];
  effort: ClaudeRunOptions['effort'];
}

export interface ClaudeStreamHandlers {
  onModel?: (model: string) => void;
  onVisibleChunk: (chunk: string) => void;
  onDone: (rawText: string, visibleText: string) => void;
  onError: (message: string) => void;
  onCancelled: () => void;
}

export interface QuillMock {
  spawn: (args: ClaudeSpawnArgs, onEvent: (event: ChunkEvent) => void) => string;
  cancel?: (token: string) => void;
  compaction?: { compacted: boolean; originalMarkdown: string | null };
  /** Manifest returned in place of the list_context_files invoke. */
  contextFiles?: string[];
}

declare global {
  interface Window {
    __quillMock?: QuillMock;
    __quillTestSession?: AISessionBinding;
  }
}

async function sendCancel(token: string): Promise<void> {
  const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
  if (mock) {
    mock.cancel?.(token);
    return;
  }
  await invoke('cancel_claude_resume', { cancelToken: token });
}

interface ClaudeResumeStream {
  begin: (streamId: string) => number;
  run: (
    streamId: string,
    args: ClaudeSpawnArgs,
    handlers: ClaudeStreamHandlers,
    claimedGeneration?: number,
  ) => Promise<void>;
  cancel: (streamId: string) => Promise<void>;
}

/**
 * Shared Claude resume transport. Each stream id owns one current generation;
 * retries supersede late events from older children, cancellation also works
 * while the Tauri spawn call is still awaiting its token, and edit fences are
 * held out of visible prose even when the opening marker spans several deltas.
 */
export function useClaudeResumeStream(): ClaudeResumeStream {
  const tokensRef = useRef<Map<string, string>>(new Map());
  const generationsRef = useRef<Map<string, number>>(new Map());

  const begin = useCallback((streamId: string) => {
    const generation = (generationsRef.current.get(streamId) ?? 0) + 1;
    generationsRef.current.set(streamId, generation);
    return generation;
  }, []);

  const run = useCallback(
    async (
      streamId: string,
      args: ClaudeSpawnArgs,
      handlers: ClaudeStreamHandlers,
      claimedGeneration?: number,
    ) => {
      const generation = claimedGeneration ?? begin(streamId);
      const isCurrent = () => generationsRef.current.get(streamId) === generation;

      let rawText = '';
      let visibleEmitted = 0;
      let spawnToken: string | undefined;

      const emitVisible = (flush: boolean) => {
        const fenceStart = rawText.indexOf(QUILL_EDITS_FENCE);
        const visibleCap = fenceStart === -1 ? rawText.length : fenceStart;
        let holdback = 0;
        if (fenceStart === -1 && !flush) {
          for (
            let size = Math.min(QUILL_EDITS_FENCE.length - 1, rawText.length);
            size > 0;
            size--
          ) {
            if (QUILL_EDITS_FENCE.startsWith(rawText.slice(rawText.length - size))) {
              holdback = size;
              break;
            }
          }
        }
        const safeEnd = Math.max(visibleEmitted, visibleCap - holdback);
        if (safeEnd <= visibleEmitted) return;
        handlers.onVisibleChunk(rawText.slice(visibleEmitted, safeEnd));
        visibleEmitted = safeEnd;
      };

      const finishToken = () => {
        if (tokensRef.current.get(streamId) === spawnToken) tokensRef.current.delete(streamId);
      };

      const dispatch = (event: ChunkEvent) => {
        if (!isCurrent()) {
          if (
            spawnToken !== undefined &&
            (event.kind === 'done' || event.kind === 'cancelled' || event.kind === 'error')
          ) {
            void sendCancel(spawnToken).catch(() => {});
          }
          return;
        }
        if (event.kind === 'model') {
          handlers.onModel?.(event.model);
        } else if (event.kind === 'delta') {
          rawText += event.text;
          emitVisible(false);
        } else if (event.kind === 'done') {
          emitVisible(true);
          handlers.onDone(rawText, rawText.slice(0, visibleEmitted));
          finishToken();
        } else if (event.kind === 'cancelled') {
          handlers.onCancelled();
          finishToken();
        } else if (event.kind === 'error') {
          handlers.onError(event.message);
          finishToken();
        }
      };

      const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
      if (mock) {
        spawnToken = mock.spawn(args, dispatch);
        tokensRef.current.set(streamId, spawnToken);
        return;
      }

      const channel = new Channel<ChunkEvent>();
      channel.onmessage = dispatch;
      try {
        const cancelToken = await invoke<string>('spawn_claude_resume', {
          ...args,
          onEvent: channel,
        });
        spawnToken = cancelToken;
        if (!isCurrent()) {
          await sendCancel(cancelToken).catch(() => {});
          return;
        }
        tokensRef.current.set(streamId, cancelToken);
      } catch (error) {
        if (isCurrent()) handlers.onError(String(error));
      }
    },
    [begin],
  );

  const cancel = useCallback(async (streamId: string) => {
    generationsRef.current.set(streamId, (generationsRef.current.get(streamId) ?? 0) + 1);
    const token = tokensRef.current.get(streamId);
    if (!token) return;
    tokensRef.current.delete(streamId);
    await sendCancel(token);
  }, []);

  return { begin, run, cancel };
}
