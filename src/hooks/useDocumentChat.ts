import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  AISessionBinding,
  ChatMessage,
  ClaudeRunOptions,
  DocumentChatThread,
  QuillEditsBlock,
  StructuralPromptEntry,
  TrackedChangeInfo,
} from '../types';
import {
  buildEditProtocolLines,
  buildPendingSuggestionsLines,
  buildReferenceContextLines,
  splitVisible,
  type PromptContext,
} from './useClaudeReply';
import { useClaudeResumeStream } from './useClaudeResumeStream';
import { DOCUMENT_AI_BUSY_MESSAGE, type DocumentAIRequestGate } from './useDocumentAIGate';
import { formatBatchResultNotice } from '../utils/structuralBatchNotice';
import type { BatchResultEntry } from '../utils/structuralBatchDispatch';
import { stripTransientChatState } from '../utils/chatThread';

export interface ChatCursorContext {
  selectedText: string | null;
  blockText: string;
}

interface UseDocumentChatOptions {
  getDocMarkdown: () => string;
  getCursorContext: () => ChatCursorContext;
  applyTrackedEdits: (
    edits: unknown[],
    originChatMessageId: string,
  ) => { results: BatchResultEntry[]; suggestionIds?: string[] };
  getContextFolder: () => string | null;
  getPendingSuggestions: () => TrackedChangeInfo[];
  /** Pending structural (block-union) changes, flattened for the manifest. */
  getStructuralPending: () => StructuralPromptEntry[];
  getRunOptions: () => ClaudeRunOptions;
  onModelObserved?: (model: string) => void;
  onEffortObserved?: (effort: string) => void;
  onChanged: () => void;
  /**
   * Fired once a chat turn reaches a TERMINAL state (done / error / busy-reject /
   * cancel — both backend and user), AFTER its final message mutation is queued. The
   * host uses it to flush autosave immediately (a stream terminal is a save checkpoint),
   * so a completed/errored/cancelled turn reaches disk without waiting the debounce.
   */
  onTerminal?: () => void;
  /** Shared with @claude margin replies for this document. */
  aiGate: DocumentAIRequestGate;
}

interface ChatInputs {
  userText: string;
  binding: AISessionBinding;
}

export interface UseDocumentChatReturn {
  messages: ChatMessage[];
  send: (userText: string, binding: AISessionBinding) => Promise<void>;
  cancel: (assistantMessageId: string) => Promise<void>;
  retry: (assistantMessageId: string) => Promise<void>;
  dismiss: (assistantMessageId: string) => void;
  restore: (thread: DocumentChatThread | undefined, binding: AISessionBinding | null) => void;
  reset: () => void;
  getThread: (sessionId: string) => DocumentChatThread;
}

export function buildChatPrompt(
  userText: string,
  docMarkdown: string,
  cursor: ChatCursorContext,
  context: PromptContext | null,
  pendingSuggestions: TrackedChangeInfo[] = [],
  structuralPending: StructuralPromptEntry[] = [],
): string {
  const cursorLines = cursor.selectedText
    ? ['Selected text:', cursor.selectedText, 'Enclosing block:', cursor.blockText]
    : ['Cursor is in this block:', cursor.blockText];
  return [
    "You are having a conversation with the user about the markdown document they're editing in Quill. Your edits land as tracked suggestions they review.",
    '',
    ...buildEditProtocolLines(),
    "=== USER'S CURRENT SELECTION / CURSOR ===",
    ...cursorLines,
    '',
    ...buildPendingSuggestionsLines(pendingSuggestions, structuralPending),
    ...buildReferenceContextLines(context),
    '=== FULL DOCUMENT ===',
    'Current document:',
    '---',
    docMarkdown,
    '---',
    '',
    'USER MESSAGE:',
    userText,
  ].join('\n');
}

function updateMessage(
  messages: ChatMessage[],
  id: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message) => (message.id === id ? update(message) : message));
}

function newMessage(role: ChatMessage['role'], text: string, pending = false): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
    ...(pending ? { pending: true } : {}),
  };
}

export function useDocumentChat(opts: UseDocumentChatOptions): UseDocumentChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const inputsRef = useRef<Map<string, ChatInputs>>(new Map());
  const retryingRef = useRef<Set<string>>(new Set());
  const activeRef = useRef<Set<string>>(new Set());
  const stream = useClaudeResumeStream();

  const runSpawn = useCallback(
    async (assistantId: string, inputs: ChatInputs) => {
      const requestId = `chat:${assistantId}`;
      if (!opts.aiGate.acquire(requestId)) {
        setMessages((current) =>
          updateMessage(current, assistantId, (message) => ({
            ...message,
            pending: false,
            error: DOCUMENT_AI_BUSY_MESSAGE,
          })),
        );
        opts.onChanged();
        opts.onTerminal?.();
        return;
      }
      const releaseGate = () => opts.aiGate.release(requestId);
      const generation = stream.begin(assistantId);
      activeRef.current.add(assistantId);
      try {
        const contextFolder = opts.getContextFolder();
        const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
        let context: PromptContext | null = null;
        if (contextFolder) {
          let files: string[] = [];
          if (mock) {
            files = mock.contextFiles ?? [];
          } else {
            try {
              files = await invoke<string[]>('list_context_files', { folder: contextFolder });
            } catch (error) {
              console.warn('list_context_files failed:', error);
            }
          }
          context = { folder: contextFolder, files };
        }

        const prompt = buildChatPrompt(
          inputs.userText,
          opts.getDocMarkdown(),
          opts.getCursorContext(),
          context,
          opts.getPendingSuggestions(),
          opts.getStructuralPending(),
        );
        if (!opts.aiGate.owns(requestId)) return;
        const runOptions = opts.getRunOptions();
        await stream.run(
          assistantId,
          {
            sessionId: inputs.binding.sessionId,
            cwd: inputs.binding.cwd,
            prompt,
            addDir: contextFolder,
            allowCreate: inputs.binding.createdByQuill === true,
            model: runOptions.model,
            effort: runOptions.effort,
          },
          {
            onModel: (model) => {
              setMessages((current) =>
                updateMessage(current, assistantId, (message) => ({
                  ...message,
                  model,
                  modelObservedAt: new Date().toISOString(),
                })),
              );
              opts.onModelObserved?.(model);
            },
            onEffort: (effort) => {
              setMessages((current) =>
                updateMessage(current, assistantId, (message) => ({
                  ...message,
                  effort,
                  effortObservedAt: new Date().toISOString(),
                })),
              );
              opts.onEffortObserved?.(effort);
            },
            onVisibleChunk: (chunk) => {
              setMessages((current) =>
                updateMessage(current, assistantId, (message) => ({
                  ...message,
                  text: message.text + chunk,
                })),
              );
            },
            onDone: (rawText, visibleText) => {
              try {
                const { block } = splitVisible(rawText);
                let parsed: QuillEditsBlock | null = null;
                if (block) {
                  try {
                    parsed = JSON.parse(block) as QuillEditsBlock;
                  } catch (error) {
                    console.warn('Failed to parse chat quill-edits block:', error);
                  }
                }

                let appended = '';
                let suggestionIds: string[] = [];
                if (parsed && Array.isArray(parsed.edits) && parsed.edits.length > 0) {
                  if (visibleText.trim() === '' && parsed.summary) appended = parsed.summary;
                  const result = opts.applyTrackedEdits(parsed.edits, assistantId);
                  suggestionIds = result.suggestionIds ?? [];
                  const skippedNotice = formatBatchResultNotice(result.results, parsed.edits);
                  if (skippedNotice) {
                    appended += `${appended ? '\n\n' : ''}${skippedNotice}`;
                  }
                }
                setMessages((current) =>
                  updateMessage(current, assistantId, (message) => ({
                    ...message,
                    text: message.text + appended,
                    pending: false,
                    ...(suggestionIds.length > 0 ? { suggestionIds } : {}),
                  })),
                );
                activeRef.current.delete(assistantId);
                inputsRef.current.delete(assistantId);
                opts.onChanged();
                opts.onTerminal?.();
              } finally {
                releaseGate();
              }
            },
            onCancelled: () => {
              setMessages((current) =>
                updateMessage(current, assistantId, (message) => ({
                  ...message,
                  pending: false,
                  cancelled: true,
                })),
              );
              activeRef.current.delete(assistantId);
              opts.onChanged();
              opts.onTerminal?.();
              releaseGate();
            },
            onError: (error) => {
              setMessages((current) =>
                updateMessage(current, assistantId, (message) => ({
                  ...message,
                  pending: false,
                  error,
                })),
              );
              activeRef.current.delete(assistantId);
              opts.onChanged();
              opts.onTerminal?.();
              releaseGate();
            },
          },
          generation,
        );
      } catch (error) {
        activeRef.current.delete(assistantId);
        releaseGate();
        setMessages((current) =>
          updateMessage(current, assistantId, (message) => ({
            ...message,
            pending: false,
            error: String(error),
          })),
        );
        opts.onChanged();
        opts.onTerminal?.();
      }
    },
    [opts, stream],
  );

  const send = useCallback(
    async (userText: string, binding: AISessionBinding) => {
      const text = userText.trim();
      if (!text) return;
      const userMessage = newMessage('user', text);
      const assistantMessage = newMessage('assistant', '', true);
      setMessages((current) => [...current, userMessage, assistantMessage]);
      const inputs = { userText: text, binding };
      inputsRef.current.set(assistantMessage.id, inputs);
      opts.onChanged();
      await runSpawn(assistantMessage.id, inputs);
    },
    [opts, runSpawn],
  );

  const cancel = useCallback(
    async (assistantMessageId: string) => {
      setMessages((current) =>
        updateMessage(current, assistantMessageId, (message) => ({
          ...message,
          pending: false,
          cancelled: true,
        })),
      );
      activeRef.current.delete(assistantMessageId);
      opts.aiGate.release(`chat:${assistantMessageId}`);
      opts.onChanged();
      opts.onTerminal?.();
      try {
        await stream.cancel(assistantMessageId);
      } catch (error) {
        console.error('Failed to cancel document chat:', error);
      }
    },
    [opts, stream],
  );

  const retry = useCallback(
    async (assistantMessageId: string) => {
      if (retryingRef.current.has(assistantMessageId)) return;
      const inputs = inputsRef.current.get(assistantMessageId);
      if (!inputs) return;
      retryingRef.current.add(assistantMessageId);
      try {
        void stream.cancel(assistantMessageId).catch(() => {});
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            text: '',
            pending: true,
            error: undefined,
            cancelled: undefined,
            suggestionIds: undefined,
          })),
        );
        await runSpawn(assistantMessageId, inputs);
      } finally {
        retryingRef.current.delete(assistantMessageId);
      }
    },
    [runSpawn, stream],
  );

  const dismiss = useCallback(
    (assistantMessageId: string) => {
      setMessages((current) => current.filter((message) => message.id !== assistantMessageId));
      inputsRef.current.delete(assistantMessageId);
      opts.onChanged();
    },
    [opts],
  );

  const reset = useCallback(() => {
    for (const assistantId of activeRef.current) {
      opts.aiGate.release(`chat:${assistantId}`);
      void stream.cancel(assistantId).catch(() => {});
    }
    activeRef.current.clear();
    inputsRef.current.clear();
    setMessages([]);
  }, [opts.aiGate, stream]);

  const restore = useCallback(
    (thread: DocumentChatThread | undefined, binding: AISessionBinding | null) => {
      reset();
      if (!thread || !binding || thread.sessionId !== binding.sessionId) return;
      const restored = thread.messages.map((message) =>
        message.pending ? { ...message, pending: false, cancelled: true } : message,
      );
      for (let index = 0; index < restored.length; index++) {
        const message = restored[index];
        if (message.role !== 'assistant' || (!message.error && !message.cancelled)) continue;
        let user: ChatMessage | undefined;
        for (let prior = index - 1; prior >= 0; prior--) {
          if (restored[prior].role === 'user') {
            user = restored[prior];
            break;
          }
        }
        if (user) inputsRef.current.set(message.id, { userText: user.text, binding });
      }
      setMessages(restored);
    },
    [reset],
  );

  // Snapshot the thread for persistence (sidecar + workspace envelope). Strip
  // half-streamed assistant turns here — this is the single serialization source
  // for both on-disk paths — so a save that lands mid-stream never persists a
  // live spinner; the live in-memory `messages` keep the real pending state.
  const getThread = useCallback(
    (sessionId: string): DocumentChatThread => ({
      sessionId,
      messages: stripTransientChatState(messagesRef.current),
    }),
    [],
  );

  return { messages, send, cancel, retry, dismiss, restore, reset, getThread };
}
