import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('no tauri in test')),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));

import { buildChatPrompt, useDocumentChat } from '../../hooks/useDocumentChat';
import type { ChunkEvent } from '../../hooks/useClaudeResumeStream';
import type { AISessionBinding, QuillEdit } from '../../types';
import type { EditResult } from '../../utils/trackedEdits';

const BINDING: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 'chat-session',
  cwd: '/docs',
  linkedAt: '2026-07-13T00:00:00.000Z',
};

class MockClaude {
  private sequence = 0;
  readonly dispatchers = new Map<string, (event: ChunkEvent) => void>();
  readonly cancelled: string[] = [];

  install() {
    window.__quillMock = {
      spawn: (_args, onEvent) => {
        const token = `chat-${++this.sequence}`;
        this.dispatchers.set(token, onEvent);
        return token;
      },
      cancel: (token) => this.cancelled.push(token),
      contextFiles: ['notes.md'],
    };
  }

  emit(token: string, event: ChunkEvent) {
    this.dispatchers.get(token)?.(event);
  }

  acknowledgeCancelsSynchronously() {
    window.__quillMock!.cancel = (token) => {
      this.cancelled.push(token);
      this.emit(token, { kind: 'cancelled' });
    };
  }
}

function makeOptions() {
  const applyTrackedEdits = vi.fn((_edits: QuillEdit[], _messageId: string) => ({
    results: _edits.map((edit) => ({ edit, status: 'applied' as const })) as EditResult[],
    suggestionIds: ['suggestion-1'],
  }));
  return {
    options: {
      getDocMarkdown: () => '# Current document',
      getCursorContext: () => ({ selectedText: 'selected words', blockText: 'whole block' }),
      applyTrackedEdits,
      getContextFolder: () => '/refs',
      getPendingSuggestions: () => [],
      getRunOptions: () => ({ model: 'sonnet' as const, effort: 'high' as const }),
      onModelObserved: vi.fn(),
      onChanged: vi.fn(),
      aiGate: {
        busy: false,
        acquire: () => true,
        owns: () => true,
        release: () => undefined,
      },
    },
    applyTrackedEdits,
  };
}

describe('buildChatPrompt', () => {
  it('frames selection, document, edit protocol, refs, and the new turn', () => {
    const prompt = buildChatPrompt(
      'Tighten the opening',
      '# Current document',
      { selectedText: 'the opening', blockText: 'the opening is long' },
      { folder: '/refs', files: ['notes.md'] },
    );
    expect(prompt).toContain("document they're editing in Quill");
    expect(prompt).toContain(
      "=== USER'S CURRENT SELECTION / CURSOR ===\nSelected text:\nthe opening",
    );
    expect(prompt).toContain('```quill-edits');
    expect(prompt).toContain('{"find":"some text","replace":"better text"}');
    expect(prompt).not.toContain('quill-comments');
    expect(prompt).toContain('=== REFERENCE FOLDER ===\nThe user attached a folder');
    expect(prompt).toContain('=== FULL DOCUMENT ===\nCurrent document:\n---\n# Current document');
    expect(prompt.endsWith('USER MESSAGE:\nTighten the opening')).toBe(true);
  });
});

describe('useDocumentChat', () => {
  let mock: MockClaude;

  beforeEach(() => {
    mock = new MockClaude();
    mock.install();
  });

  afterEach(() => {
    delete window.__quillMock;
    vi.clearAllMocks();
  });

  it('streams prose, hides the edits fence, and links suggestions to the assistant turn', async () => {
    const { options, applyTrackedEdits } = makeOptions();
    const { result } = renderHook(() => useDocumentChat(options));
    await act(async () => result.current.send('Fix it', BINDING));
    const assistantId = result.current.messages[1].id;

    act(() => {
      mock.emit('chat-1', { kind: 'model', model: 'claude-sonnet' });
      mock.emit('chat-1', { kind: 'delta', text: 'Done.\n``' });
      mock.emit('chat-1', {
        kind: 'delta',
        text: '`quill-edits\n{"summary":"Fixed it","edits":[{"find":"Current","replace":"Better"}]}\n```',
      });
      mock.emit('chat-1', { kind: 'done' });
    });

    const assistant = result.current.messages[1];
    expect(assistant.text).toBe('Done.\n');
    expect(assistant.model).toBe('claude-sonnet');
    expect(assistant.pending).toBe(false);
    expect(assistant.suggestionIds).toEqual(['suggestion-1']);
    expect(applyTrackedEdits).toHaveBeenCalledWith(
      [{ find: 'Current', replace: 'Better' }],
      assistantId,
    );
  });

  it('reports the exact skipped chat edit and reason', async () => {
    const { options, applyTrackedEdits } = makeOptions();
    applyTrackedEdits.mockReturnValue({
      results: [
        {
          edit: { find: '[same](https://one.example)', replace: 'new' },
          status: 'conflict',
          reason: 'ambiguous-link',
        },
      ],
      suggestionIds: [],
    });
    const { result } = renderHook(() => useDocumentChat(options));
    await act(async () => result.current.send('Fix it', BINDING));
    act(() => {
      mock.emit('chat-1', {
        kind: 'delta',
        text: 'I tried.\n```quill-edits\n{"summary":"Tried","edits":[{"find":"[same](https://one.example)","replace":"new"}]}\n```',
      });
      mock.emit('chat-1', { kind: 'done' });
    });

    expect(result.current.messages[1].text).toContain(
      '“[same](https://one.example)” — more than one link has that label.',
    );
    expect(result.current.messages[1].text).not.toContain("text wasn't found, was already");
  });

  it('stops without applying partial edits and retries the same assistant message', async () => {
    const { options, applyTrackedEdits } = makeOptions();
    mock.acknowledgeCancelsSynchronously();
    const { result } = renderHook(() => useDocumentChat(options));
    await act(async () => result.current.send('Fix it', BINDING));
    const assistantId = result.current.messages[1].id;
    act(() => mock.emit('chat-1', { kind: 'delta', text: 'partial' }));

    await act(async () => result.current.cancel(assistantId));
    expect(result.current.messages[1]).toMatchObject({ id: assistantId, cancelled: true });
    expect(applyTrackedEdits).not.toHaveBeenCalled();

    await act(async () => result.current.retry(assistantId));
    expect(result.current.messages[1]).toMatchObject({ id: assistantId, pending: true, text: '' });
    expect(mock.dispatchers.has('chat-2')).toBe(true);
  });

  it('keeps failed turns retryable and lets the user dismiss the terminal message', async () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useDocumentChat(options));
    await act(async () => result.current.send('Try this', BINDING));
    const assistantId = result.current.messages[1].id;

    act(() => mock.emit('chat-1', { kind: 'error', message: 'API Error: overloaded' }));
    expect(result.current.messages[1]).toMatchObject({
      id: assistantId,
      pending: false,
      error: 'API Error: overloaded',
    });

    await act(async () => result.current.retry(assistantId));
    expect(result.current.messages[1]).toMatchObject({
      id: assistantId,
      pending: true,
      error: undefined,
    });
    act(() => mock.emit('chat-2', { kind: 'error', message: 'Still unavailable' }));
    act(() => result.current.dismiss(assistantId));
    expect(result.current.messages.map((message) => message.id)).not.toContain(assistantId);
  });

  it('restores only a matching session and makes an interrupted turn retryable', async () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useDocumentChat(options));
    const thread = {
      sessionId: BINDING.sessionId,
      messages: [
        { id: 'u1', role: 'user' as const, text: 'Continue', createdAt: 'now' },
        {
          id: 'a1',
          role: 'assistant' as const,
          text: 'Half',
          createdAt: 'now',
          pending: true,
        },
      ],
    };
    act(() => result.current.restore(thread, BINDING));
    expect(result.current.messages[1]).toMatchObject({ pending: false, cancelled: true });

    await act(async () => result.current.retry('a1'));
    expect(mock.dispatchers.has('chat-1')).toBe(true);

    act(() => result.current.restore(thread, { ...BINDING, sessionId: 'different' }));
    expect(result.current.messages).toEqual([]);
  });

  it('cancels an active child when its document tab unmounts', async () => {
    const { options } = makeOptions();
    const { result, unmount } = renderHook(() => useDocumentChat(options));
    await act(async () => result.current.send('Keep working', BINDING));
    unmount();
    expect(mock.cancelled).toContain('chat-1');
  });
});
