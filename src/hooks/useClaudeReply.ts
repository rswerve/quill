import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  AISessionBinding,
  Comment,
  EditScope,
  QuillEdit,
  QuillEditsBlock,
  ClaudeRunOptions,
  TrackedChangeInfo,
  TrackedEditOrigin,
} from '../types';
import { clip } from '../utils/format';
import {
  formatEditResultNotice,
  stripTrailingNewlines,
  type EditResult,
} from '../utils/trackedEdits';
import { QUILL_EDITS_FENCE, useClaudeResumeStream } from './useClaudeResumeStream';
import { DOCUMENT_AI_BUSY_MESSAGE, type DocumentAIRequestGate } from './useDocumentAIGate';

export type { ChunkEvent } from './useClaudeResumeStream';

/** Live text for a comment's anchored range and its enclosing paragraph. */
export interface RangeTexts {
  highlightText: string;
  paragraphText: string;
}

interface UseClaudeReplyOptions {
  startAIReply: (commentId: string) => string;
  appendAIReplyChunk: (commentId: string, replyId: string, chunk: string) => void;
  setAIReplyModel?: (commentId: string, replyId: string, model: string) => void;
  onModelObserved?: (model: string) => void;
  finishAIReply: (commentId: string, replyId: string) => void;
  failAIReply: (commentId: string, replyId: string, message: string) => void;
  cancelAIReply: (commentId: string, replyId: string) => void;
  retryAIReply: (commentId: string, replyId: string) => void;
  linkAIReplySuggestions: (commentId: string, replyId: string, suggestionIds: string[]) => void;
  getDocMarkdown: () => string;
  /** Read the current document text for a comment's range + paragraph. */
  getRangeTexts: (comment: Comment) => RangeTexts;
  /** Apply Claude's proposed edits as tracked-change suggestions, stamped
   *  with the comment that caused them. */
  applyTrackedEdits: (
    comment: Comment,
    edits: QuillEdit[],
    scope: EditScope,
    origin?: TrackedEditOrigin,
  ) => { results: EditResult[]; suggestionIds?: string[] };
  /** The document's linked context folder, if any (read at ask time). */
  getContextFolder: () => string | null;
  /** Pending tracked changes, read at ask time so the prompt can tell Claude
   *  what is already proposed and awaiting review. */
  getPendingSuggestions: () => TrackedChangeInfo[];
  /** Global model/effort choices, read immediately before each spawn. */
  getRunOptions?: () => ClaudeRunOptions;
  /** Shared with document chat so this document resumes only one request. */
  aiGate: DocumentAIRequestGate;
}

/** The linked context folder and its file manifest, for the prompt. */
export interface PromptContext {
  folder: string;
  files: string[];
}

const FENCE = QUILL_EDITS_FENCE;

/** How a failed @claude reply should be recovered from, derived from its message. */
export type ReplyErrorKind = 'transient' | 'session' | 'auth' | 'unknown';

export interface ReplyErrorClass {
  retryable: boolean;
  kind: ReplyErrorKind;
}

// Ordered specific-before-broad: a message like "No conversation found (timeout)"
// must classify as `session` (re-link is the fix), not `transient`. Each rule's
// `test` runs against a lowercased copy of the message, so patterns are lowercase.
const REPLY_ERROR_RULES: {
  kind: ReplyErrorKind;
  retryable: boolean;
  test: (m: string) => boolean;
}[] = [
  {
    kind: 'session',
    retryable: true, // retryable, but the UI leads with Re-link
    test: (m) =>
      m.includes('no conversation found') ||
      m.includes('session id') ||
      m.includes('session not found'),
  },
  {
    // Deliberately match the specific longer tokens, never a bare "auth" —
    // "author"/"authority" and similar appear in unrelated infra messages.
    // `401` and `login` are word-boundary-anchored so a port/line number like
    // "24010" or a hostname like "mylogin.example.com" can't force a
    // non-retryable auth verdict onto an otherwise retryable failure.
    kind: 'auth',
    retryable: false,
    test: (m) =>
      m.includes('authentication') ||
      m.includes('unauthorized') ||
      /\b401\b/.test(m) ||
      /\blogin\b/.test(m) ||
      m.includes('api key') ||
      m.includes('credentials'),
  },
  {
    kind: 'transient',
    retryable: true,
    test: (m) =>
      m.includes('api error') ||
      /\b(429|500|502|503|529)\b/.test(m) ||
      m.includes('overloaded') ||
      m.includes('timeout') ||
      m.includes('network') ||
      m.includes('rate limit') ||
      m.includes('econn') ||
      m.includes('thinking.type'),
  },
];

/**
 * Classify a failed @claude reply's error message to drive recovery UI.
 * Matching is case-insensitive and ordered (specific kinds win over broad ones).
 * Unmatched or empty input is `unknown` — deliberately retryable, since a wrong
 * Retry only costs one re-run while a wrong Re-link misdirects the user.
 */
export function classifyReplyError(message: string): ReplyErrorClass {
  const m = (message ?? '').toLowerCase();
  for (const rule of REPLY_ERROR_RULES) {
    if (rule.test(m)) return { retryable: rule.retryable, kind: rule.kind };
  }
  return { retryable: true, kind: 'unknown' };
}

/**
 * Split a raw Claude reply into the user-visible prose and the (optional)
 * quill-edits JSON. `visible` is everything before the fence (trimmed of the
 * trailing fence/newlines). `block` is the JSON text between the opening and
 * closing fences, or null if no complete block is present.
 */
export function splitVisible(raw: string): { visible: string; block: string | null } {
  const start = raw.indexOf(FENCE);
  if (start === -1) return { visible: raw, block: null };
  const visible = stripTrailingNewlines(raw.slice(0, start));
  const afterFence = raw.slice(start + FENCE.length);
  const close = afterFence.indexOf('```');
  if (close === -1) return { visible, block: null };
  return { visible, block: afterFence.slice(0, close).trim() };
}

interface UseClaudeReplyReturn {
  ask: (comment: Comment, userText: string, binding: AISessionBinding) => Promise<void>;
  cancel: (replyId: string) => Promise<void>;
  /** Re-issue the identical request for a failed reply, reusing its replyId. */
  retry: (replyId: string) => Promise<void>;
}

/** The inputs a reply was asked with, stashed so a retry can re-issue them. */
interface ReplyInputs {
  comment: Comment;
  userText: string;
  binding: AISessionBinding;
}

interface CompactionInfo {
  compacted: boolean;
  originalMarkdown: string | null;
}

/** Shared suggestions-only edit protocol used by comment replies and document chat. */
export function buildEditProtocolLines(): string[] {
  return [
    'HOW TO RESPOND:',
    'Calibrate your effort to the request: for simple mechanical edits (formatting, typos, italicizing, punctuation), act immediately without extended deliberation; reserve careful thinking for substantive work (restructuring, argument, tone, accuracy).',
    'If the user is asking a question or for an opinion, reply concisely in prose and do NOT propose edits.',
    'If the user is asking you to rewrite, fix, revise, restructure, shorten, expand, or otherwise change the text (e.g. "fix the grammar", "make this a list", "turn this into prose"), make the changes as tracked suggestions by appending EXACTLY ONE fenced block at the very end of your reply:',
    '',
    '```quill-edits',
    '{"summary":"<one short sentence describing what you changed>","edits":[{"find":"<exact original substring>","replace":"<new text>"},{"find":"<exact substring to restyle>","format":{"bold":true}}]}',
    '```',
    '',
    'Rules for the edits block:',
    '- The FULL DOCUMENT below is Markdown source for context, but every "find" and "replace" must contain only the PLAIN READING TEXT — the exact visible words, with Markdown delimiters removed.',
    '- Example: for Markdown source "**Q2 contrast needs work**", use {"find":"Q2 contrast needs work","replace":"Clearer Q2 contrast"}, NOT {"find":"**Q2 contrast needs work**",...}.',
    '- Never copy formatting or block syntax into either field: no "**" or "__" (bold), "*" or "_" (italic), backticks (code), "~~" (strike), leading "#" / "-" / "1." (headings and lists), or "[text](url)" (links). To change formatting, use a separate format edit.',
    '- For "[some text](url)", use {"find":"some text","replace":"better text"} — both fields are visible text only.',
    '- Your edits may touch any part of the document the request warrants. Keep changes minimal and relevant — no unrequested rewrites elsewhere.',
    '- Make "find" strings long/unique enough to be unambiguous. To turn a bullet list into prose, set "find" to the run of list-item text and "replace" to the prose.',
    '- To delete text, use an empty "replace". To insert, you may set "find" to a short unique substring and include it at the start of "replace".',
    '- For formatting-only changes, use a "format" edit instead of "replace": {"find":"<exact substring>","format":{"bold":true,"italic":false}}. true turns a style on, false turns it off; include only the styles being changed. Supported styles: "bold", "italic", "strikethrough". An edit carries either "replace" or "format", never both, and a format edit needs a non-empty "find".',
    '- Underline and other styles beyond those three cannot be suggested — if asked, explain that in prose. Never emit an edits block with identical "find" and "replace".',
    '- Keep any prose before the block to one or two sentences; the "summary" is what the user sees, so write it as a human editor would ("Fixed subject-verb agreement and tightened the opening.").',
    '- Output the block only when you actually changed something. If nothing needs changing, omit it.',
    '',
  ];
}

export function buildPendingSuggestionsLines(pendingSuggestions: TrackedChangeInfo[]): string[] {
  return [
    '=== PENDING SUGGESTIONS (already proposed, awaiting review) ===',
    'Do not re-propose or conflict with these pending tracked changes.',
    ...(pendingSuggestions.length > 0
      ? pendingSuggestions.map((suggestion) => {
          let origin = '';
          if (suggestion.originCommentId) {
            origin = ` (from comment ${suggestion.originCommentId})`;
          } else if (suggestion.originChatMessageId) {
            origin = ` (from chat ${suggestion.originChatMessageId})`;
          }
          const formatSegments = suggestion.segments.filter((segment) => segment.kind === 'format');
          const insertions = suggestion.segments.filter((segment) => segment.kind === 'insert');
          const deletions = suggestion.segments.filter((segment) => segment.kind === 'delete');
          if (formatSegments.length > 0 && insertions.length === 0 && deletions.length === 0) {
            const adds = [...new Set(formatSegments.flatMap((segment) => segment.adds))].sort();
            const removes = [
              ...new Set(formatSegments.flatMap((segment) => segment.removes)),
            ].sort();
            const delta = [
              ...adds.map((name) => `+${name}`),
              ...removes.map((name) => `-${name}`),
            ].join(' ');
            const text = formatSegments.map((segment) => segment.text).join(' … ');
            return `- [formatting ${delta}] "${clip(text, 80)}"${origin}`;
          }
          const inserted = insertions.map((segment) => segment.text).join(' … ');
          const deleted = deletions.map((segment) => segment.text).join(' … ');
          if (insertions.length > 0 && deletions.length > 0) {
            return `- [replacement] "${clip(deleted, 80)}" → "${clip(inserted, 80)}"${origin}`;
          }
          const kind = insertions.length > 0 ? 'insertion' : 'deletion';
          return `- [${kind}] "${clip(inserted || deleted, 80)}"${origin}`;
        })
      : ['(none)']),
    '',
  ];
}

export function buildReferenceContextLines(context: PromptContext | null): string[] {
  if (!context) return [];
  return [
    '=== REFERENCE FOLDER ===',
    `The user attached a folder of reference documents at: ${context.folder}`,
    'You have read access to it. When a file below is relevant to the request, read it before answering.',
    ...(context.files.length > 0
      ? context.files.map((file) => `- ${file}`)
      : ['(no readable documents found in the folder)']),
    '',
  ];
}

/**
 * Exported for tests. The prompt is document-scale: Claude always receives the
 * full current document (compaction only changes the note wording, never the
 * shape) plus the pending-review state, and its edits may land anywhere in the
 * document — the highlight is framing context, not a fence.
 */
export function buildPrompt(
  comment: Comment,
  userText: string,
  docMarkdown: string,
  ranges: RangeTexts,
  compaction: CompactionInfo | null,
  context: PromptContext | null,
  pendingSuggestions: TrackedChangeInfo[] = [],
  freshSession = false,
): string {
  // `userText` is appended explicitly as the final line below. Depending on
  // when React flushed state, the same message may or may not already be the
  // thread's last reply — drop that copy so Claude doesn't see it twice.
  const replies = comment.replies.filter((r) => !r.pending);
  const last = replies[replies.length - 1];
  if (last && last.authorKind !== 'ai' && last.text === userText) replies.pop();

  const threadLines: string[] = [];
  for (const reply of replies) {
    const who = reply.authorKind === 'ai' ? 'Claude' : reply.author;
    threadLines.push(`- ${who}: ${reply.text}`);
  }
  threadLines.push(`- User just said: ${userText}`);

  const head = [
    'You are responding inline on a markdown document the user is editing in Quill.',
    '',
    'Comment thread so far:',
    threadLines.join('\n'),
    '',
  ];

  const editContext = [
    `=== USER IS COMMENTING ON (highlighted) ===`,
    ranges.highlightText,
    `=== PARAGRAPH (context) ===`,
    ranges.paragraphText,
    '',
  ];

  let documentIntroduction = 'Current document (may have been edited since your last turn):';
  if (freshSession) {
    documentIntroduction = 'Here is the full current document:';
  } else if (compaction?.compacted) {
    documentIntroduction =
      'Your context was compacted since your last turn; full current document follows:';
  }

  return [
    ...head,
    ...buildEditProtocolLines(),
    ...editContext,
    ...buildPendingSuggestionsLines(pendingSuggestions),
    ...buildReferenceContextLines(context),
    '=== FULL DOCUMENT ===',
    documentIntroduction,
    '---',
    docMarkdown,
    '---',
  ].join('\n');
}

export function useClaudeReply(opts: UseClaudeReplyOptions): UseClaudeReplyReturn {
  const stream = useClaudeResumeStream();
  // Transient, in-memory only — NEVER persisted to the sidecar. Keyed by
  // replyId so a retry can re-issue the exact same request.
  const inputsRef = useRef<Map<string, ReplyInputs>>(new Map());
  // Per-replyId generation counter. A retry reuses the same replyId, so a late
  // event from the superseded original must not clobber the retried reply; each
  // spawn captures its generation and drops events once it's no longer current.
  // Guards against a double-fire retry (e.g. an impatient double-click) while a
  // retry for the same replyId is already being launched.
  const retryingRef = useRef<Set<string>>(new Set());

  // Shared spawn/stream core for both the first ask and a retry. `replyId` is
  // already reset to a pending state by the caller (startAIReply / retryAIReply).
  const runSpawn = useCallback(
    async (replyId: string, comment: Comment, userText: string, binding: AISessionBinding) => {
      const requestId = `comment:${replyId}`;
      if (!opts.aiGate.acquire(requestId)) {
        opts.failAIReply(comment.id, replyId, DOCUMENT_AI_BUSY_MESSAGE);
        return;
      }
      const releaseGate = () => opts.aiGate.release(requestId);
      // Claim this reply generation before any asynchronous preflight. A user
      // can cancel while compaction/context probes are still pending, before
      // the transport has enough information to spawn the child.
      const streamGeneration = stream.begin(replyId);
      try {
        const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;

        const fresh = binding.createdByQuill === true;
        let compaction: CompactionInfo | null = fresh ? null : (mock?.compaction ?? null);
        if (!mock && !fresh) {
          try {
            compaction = await invoke<CompactionInfo>('check_session_compacted', {
              sessionId: binding.sessionId,
            });
          } catch (e) {
            console.warn('check_session_compacted failed:', e);
          }
        }
        // Manifest for the linked context folder. A scan failure (folder moved,
        // permissions) must not block the reply — degrade to no context section.
        const contextFolder = opts.getContextFolder();
        let context: PromptContext | null = null;
        if (contextFolder) {
          let files: string[] = [];
          if (mock) {
            files = mock.contextFiles ?? [];
          } else {
            try {
              files = await invoke<string[]>('list_context_files', { folder: contextFolder });
            } catch (e) {
              console.warn('list_context_files failed:', e);
            }
          }
          context = { folder: contextFolder, files };
        }

        const ranges = opts.getRangeTexts(comment);
        const prompt = buildPrompt(
          comment,
          userText,
          opts.getDocMarkdown(),
          ranges,
          compaction,
          context,
          opts.getPendingSuggestions(),
          fresh,
        );

        const finalize = (rawText: string, visibleText: string) => {
          const { block } = splitVisible(rawText);
          let parsed: QuillEditsBlock | null = null;
          if (block) {
            try {
              parsed = JSON.parse(block) as QuillEditsBlock;
            } catch (e) {
              console.warn('Failed to parse quill-edits block:', e);
            }
          }

          if (parsed && Array.isArray(parsed.edits) && parsed.edits.length > 0) {
            // The prose we already streamed; if it was empty, surface the summary.
            if (visibleText.trim() === '' && parsed.summary) {
              opts.appendAIReplyChunk(comment.id, replyId, parsed.summary);
            }
            // Edits are document-scale: the highlight frames the request but
            // does not fence where changes may land.
            const { results, suggestionIds = [] } = opts.applyTrackedEdits(
              comment,
              parsed.edits,
              'doc',
              { commentId: comment.id },
            );
            if (suggestionIds.length > 0) {
              opts.linkAIReplySuggestions(comment.id, replyId, suggestionIds);
            }
            const skippedNotice = formatEditResultNotice(results);
            if (skippedNotice) {
              opts.appendAIReplyChunk(comment.id, replyId, `\n\n${skippedNotice}`);
            }
          }
        };

        // Cancellation during an async preflight releases the lane. Do not
        // launch a stale child after another surface has acquired it.
        if (!opts.aiGate.owns(requestId)) return;
        // Read after asynchronous preflight work so a just-changed footer choice
        // governs the child we are about to spawn.
        const runOptions = opts.getRunOptions?.() ?? { model: null, effort: null };
        await stream.run(
          replyId,
          {
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            prompt,
            addDir: contextFolder,
            allowCreate: fresh,
            model: runOptions.model,
            effort: runOptions.effort,
          },
          {
            onModel: (model) => {
              opts.setAIReplyModel?.(comment.id, replyId, model);
              opts.onModelObserved?.(model);
            },
            onVisibleChunk: (chunk) => opts.appendAIReplyChunk(comment.id, replyId, chunk),
            onDone: (rawText, visibleText) => {
              try {
                finalize(rawText, visibleText);
                opts.finishAIReply(comment.id, replyId);
                inputsRef.current.delete(replyId);
              } finally {
                releaseGate();
              }
            },
            onCancelled: () => {
              opts.cancelAIReply(comment.id, replyId);
              releaseGate();
            },
            onError: (message) => {
              opts.failAIReply(comment.id, replyId, message);
              releaseGate();
            },
          },
          streamGeneration,
        );
      } catch (error) {
        releaseGate();
        opts.failAIReply(comment.id, replyId, String(error));
      }
    },
    [opts, stream],
  );

  const ask = useCallback(
    async (comment: Comment, userText: string, binding: AISessionBinding) => {
      const replyId = opts.startAIReply(comment.id);
      inputsRef.current.set(replyId, { comment, userText, binding });
      await runSpawn(replyId, comment, userText, binding);
    },
    [opts, runSpawn],
  );

  const retry = useCallback(
    async (replyId: string) => {
      if (retryingRef.current.has(replyId)) return; // double-fire guard
      const inputs = inputsRef.current.get(replyId);
      if (!inputs) return; // nothing to re-issue (no-op, no throw)
      retryingRef.current.add(replyId);
      try {
        // Tear down any orphan the failed original may have left tracked, then
        // reset the reply in place (reuses the same entry, clears the error).
        void stream.cancel(replyId).catch(() => {
          // ignore — the child may already be gone
        });
        opts.retryAIReply(inputs.comment.id, replyId);
        // Re-issue the identical request against the same comment. Ranges are
        // re-read live inside runSpawn via opts.getRangeTexts.
        await runSpawn(replyId, inputs.comment, inputs.userText, inputs.binding);
      } finally {
        retryingRef.current.delete(replyId);
      }
    },
    [opts, runSpawn, stream],
  );

  const cancel = useCallback(
    async (replyId: string) => {
      // Supersede this reply synchronously — don't gate on a token that may not
      // exist yet. A Cancel click can land while runSpawn is still awaiting
      // spawn_claude_resume (no token tracked), or before the backend emits a
      // `cancelled` event it may never send. Bumping the generation makes the
      // pending runSpawn's post-await isCurrent() false, so it orphan-cancels
      // its own child instead of streaming to completion.
      const commentId = inputsRef.current.get(replyId)?.comment.id;
      if (commentId) opts.cancelAIReply(commentId, replyId);
      opts.aiGate.release(`comment:${replyId}`);
      try {
        await stream.cancel(replyId);
      } catch (e) {
        console.error('Failed to cancel claude reply:', e);
      }
    },
    [opts, stream],
  );

  return { ask, cancel, retry };
}
