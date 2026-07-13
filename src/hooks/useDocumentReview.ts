import { useCallback, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  AISessionBinding,
  ClaudeRunOptions,
  QuillCommentsBlock,
  QuillEdit,
  QuillEditsBlock,
} from '../types';
import { stripTrailingNewlines } from '../utils/trackedEdits';
import type { ChunkEvent, PromptContext } from './useClaudeReply';

export const EDITS_FENCE = '```quill-edits';
export const COMMENTS_FENCE = '```quill-comments';

/** What the user asked for in the review modal. */
export interface ReviewOptions {
  guidance: string;
  makeComments: boolean;
  makeSuggestions: boolean;
}

export type ReviewPhase =
  | { status: 'idle' }
  | { status: 'streaming'; text: string }
  | {
      status: 'done';
      text: string;
      commentsAdded: number;
      suggestionsApplied: number;
      /** Items whose `find` couldn't be located in the document. */
      skipped: number;
    }
  | { status: 'error'; message: string };

interface UseDocumentReviewOptions {
  getDocMarkdown: () => string;
  /** The document's linked context folder, if any (read at review time). */
  getContextFolder: () => string | null;
  /** Apply Claude's proposed edits as doc-scoped tracked suggestions. */
  applyTrackedEdits: (edits: QuillEdit[]) => { applied: number; skipped: number };
  /** Anchor one Claude margin comment; false when `find` can't be located. */
  addClaudeComment: (find: string, body: string, model?: string) => boolean;
  /** Report the model named by this spawn's authoritative stream init event. */
  onModelObserved?: (model: string) => void;
  /** Global model/effort choices, read immediately before each spawn. */
  getRunOptions?: () => ClaudeRunOptions;
}

interface UseDocumentReviewReturn {
  phase: ReviewPhase;
  start: (options: ReviewOptions, binding: AISessionBinding) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

/**
 * Extract the text between a named opening fence and its closing ``` —
 * null until the block is complete. Exported for tests.
 */
export function extractFencedBlock(raw: string, fence: string): string | null {
  const start = raw.indexOf(fence);
  if (start === -1) return null;
  const afterFence = raw.slice(start + fence.length);
  const close = afterFence.indexOf('```');
  if (close === -1) return null;
  return afterFence.slice(0, close).trim();
}

/** The prose before the first review fence — the user-visible part. */
export function reviewVisible(raw: string): string {
  const starts = [raw.indexOf(COMMENTS_FENCE), raw.indexOf(EDITS_FENCE)].filter((i) => i !== -1);
  if (starts.length === 0) return raw;
  return stripTrailingNewlines(raw.slice(0, Math.min(...starts)));
}

/**
 * How many trailing characters of the accumulated stream could still grow
 * into a review fence: the longest suffix that is a prefix of either fence
 * string. Ordinary prose streams through with zero holdback. Exported for
 * tests.
 */
export function fenceHoldback(accum: string): number {
  let hold = 0;
  for (const fence of [COMMENTS_FENCE, EDITS_FENCE]) {
    const cap = Math.min(fence.length - 1, accum.length);
    for (let n = cap; n > hold; n--) {
      if (fence.startsWith(accum.slice(accum.length - n))) {
        hold = n;
        break;
      }
    }
  }
  return hold;
}

function addReviewComment(
  candidate: unknown,
  responseModel: string | undefined,
  addClaudeComment: UseDocumentReviewOptions['addClaudeComment'],
): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const { find, comment } = candidate as Record<string, unknown>;
  if (typeof find !== 'string' || typeof comment !== 'string') return false;
  if (responseModel) return addClaudeComment(find, comment, responseModel);
  return addClaudeComment(find, comment);
}

function applyReviewComments(
  raw: string,
  responseModel: string | undefined,
  addClaudeComment: UseDocumentReviewOptions['addClaudeComment'],
): { added: number; skipped: number } {
  const block = extractFencedBlock(raw, COMMENTS_FENCE);
  if (!block) return { added: 0, skipped: 0 };

  try {
    const parsed = JSON.parse(block) as QuillCommentsBlock;
    if (!Array.isArray(parsed.comments)) return { added: 0, skipped: 0 };
    let added = 0;
    let skipped = 0;
    for (const comment of parsed.comments) {
      if (addReviewComment(comment, responseModel, addClaudeComment)) added++;
      else skipped++;
    }
    return { added, skipped };
  } catch (error) {
    console.warn('Failed to parse quill-comments block:', error);
    return { added: 0, skipped: 0 };
  }
}

function applyReviewSuggestions(
  raw: string,
  applyTrackedEdits: UseDocumentReviewOptions['applyTrackedEdits'],
): { applied: number; skipped: number } {
  const block = extractFencedBlock(raw, EDITS_FENCE);
  if (!block) return { applied: 0, skipped: 0 };

  try {
    const parsed = JSON.parse(block) as QuillEditsBlock;
    if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) {
      return { applied: 0, skipped: 0 };
    }
    return applyTrackedEdits(parsed.edits);
  } catch (error) {
    console.warn('Failed to parse quill-edits block:', error);
    return { applied: 0, skipped: 0 };
  }
}

/** Exported for tests. */
export function buildReviewPrompt(
  options: ReviewOptions,
  docMarkdown: string,
  context: PromptContext | null,
): string {
  const guidance = options.guidance.trim();
  const head = [
    'You are reviewing a markdown document the user is editing in Quill.',
    '',
    'The user asked for a review of the FULL document.',
    // The user's ask is the ONLY substantive direction this prompt carries.
    // Everything else below is wire-format plumbing (how Quill parses the
    // reply) — never editorial guidance about the document.
    guidance ? `The user asked you to: ${guidance}` : 'The user gave no further instructions.',
    '',
  ];

  const respond: string[] = [
    'HOW TO RESPOND:',
    'Any prose you write outside the fenced blocks below is shown to the user as the review summary.',
  ];

  if (options.makeComments) {
    respond.push(
      '',
      'To leave margin comments (observations, questions, judgment calls the user should weigh), append a fenced block:',
      '',
      '```quill-comments',
      '{"comments":[{"find":"<exact substring of the document text>","comment":"<concise, actionable remark>"}]}',
      '```',
      '',
      'Each comment is anchored to the text matched by its "find".',
    );
  }
  if (options.makeSuggestions) {
    respond.push(
      '',
      'To propose concrete text changes (applied as tracked suggestions the user accepts or rejects one by one), append a fenced block:',
      '',
      '```quill-edits',
      '{"summary":"<one short sentence describing what you changed>","edits":[{"find":"<exact original substring>","replace":"<new text>"},{"find":"<exact substring to restyle>","format":{"bold":true}}]}',
      '```',
    );
  }

  respond.push(
    '',
    'Rules for "find" strings:',
    '- Each "find" must be an EXACT substring of the document text below, copied verbatim as PLAIN TEXT. Do NOT include markdown syntax such as leading "- ", "* ", or "#"; match only the visible characters.',
    '- Make "find" strings long/unique enough to be unambiguous.',
  );
  if (options.makeSuggestions) {
    respond.push(
      '- To delete text, use an empty "replace". To insert, set "find" to a short unique substring and include it at the start of "replace".',
      '- For formatting-only changes, use a "format" edit instead of "replace": {"find":"<exact substring>","format":{"bold":true,"italic":false}}. true turns a style on, false turns it off; supported styles are "bold", "italic", "strikethrough". An edit carries either "replace" or "format", never both, and a format edit needs a non-empty "find".',
    );
  }
  if (options.makeComments && options.makeSuggestions) {
    respond.push(
      '- Use comments for judgment calls the user should decide; use edits for changes you are confident in. Do not make the same point in both.',
    );
  } else if (options.makeComments) {
    respond.push(
      '- Do NOT propose text changes or output a quill-edits block — the user asked for comments only.',
    );
  } else {
    respond.push(
      '- Do NOT output a quill-comments block — the user asked for tracked-change suggestions only.',
    );
  }
  respond.push('- If the document needs no changes, say so in the prose and omit the blocks.', '');

  const contextSection = context
    ? [
        '=== REFERENCE FOLDER ===',
        `The user attached a folder of reference documents at: ${context.folder}`,
        'You have read access to it. When a file below is relevant to the review, read it before answering.',
        ...(context.files.length > 0
          ? context.files.map((f) => `- ${f}`)
          : ['(no readable documents found in the folder)']),
        '',
      ]
    : [];

  return [
    ...head,
    ...respond,
    ...contextSection,
    '=== DOCUMENT ===',
    '---',
    docMarkdown,
    '---',
  ].join('\n');
}

/**
 * Full-document review: sends the whole document (plus the user's guidance)
 * to the linked Claude session and turns the reply's quill-comments block
 * into anchored margin comments and its quill-edits block into doc-scoped
 * tracked-change suggestions. Reuses the same spawn/stream machinery (and
 * `window.__quillMock` test seam) as useClaudeReply, but streams into the
 * review modal instead of a comment thread.
 */
export function useDocumentReview(opts: UseDocumentReviewOptions): UseDocumentReviewReturn {
  const [phase, setPhase] = useState<ReviewPhase>({ status: 'idle' });
  const tokenRef = useRef<string | null>(null);
  // Generation guard (mirrors useClaudeReply's single-reply path). Each start
  // claims a generation; a cancel bumps it. Late events from a superseded run
  // and spawns that resolve after a cancel are dropped/orphan-cancelled, so a
  // user cancel supersedes any in-flight review regardless of backend timing.
  const genRef = useRef(0);

  const start = useCallback(
    async (options: ReviewOptions, binding: AISessionBinding) => {
      const generation = ++genRef.current;
      const isCurrent = () => genRef.current === generation;
      setPhase({ status: 'streaming', text: '' });
      const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;

      // Manifest for the linked context folder. A scan failure (folder moved,
      // permissions) must not block the review — degrade to no context section.
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

      // A cancel during the context scan supersedes this run — don't spawn a
      // review the user already backed out of.
      if (!isCurrent()) return;

      // A review always sends the full document, so the compaction check that
      // gates the comment-reply diff is irrelevant here.
      const fresh = binding.createdByQuill === true;
      const prompt = buildReviewPrompt(options, opts.getDocMarkdown(), context);

      let rawAccum = '';
      let responseModel: string | undefined;

      // The streamed text shown in the modal: everything before the first
      // fence, holding back any trailing run that could still grow into one.
      const visibleNow = (flush: boolean): string => {
        const hasFence = rawAccum.includes(COMMENTS_FENCE) || rawAccum.includes(EDITS_FENCE);
        if (hasFence || flush) return reviewVisible(rawAccum);
        return rawAccum.slice(0, rawAccum.length - fenceHoldback(rawAccum));
      };

      const finalize = () => {
        // Defense-in-depth: only reached via the already-guarded dispatch, but
        // finalize applies irreversible document mutations — never from a
        // superseded run.
        if (!isCurrent()) return;
        tokenRef.current = null;

        // Comments anchor first: marks don't move text, so the edits applied
        // below can't invalidate positions the comment `find`s located.
        // A block the user's checkboxes didn't ask for is ignored.
        let commentResult = { added: 0, skipped: 0 };
        if (options.makeComments) {
          commentResult = applyReviewComments(rawAccum, responseModel, opts.addClaudeComment);
        }

        let suggestionResult = { applied: 0, skipped: 0 };
        if (options.makeSuggestions) {
          suggestionResult = applyReviewSuggestions(rawAccum, opts.applyTrackedEdits);
        }

        setPhase({
          status: 'done',
          text: visibleNow(true),
          commentsAdded: commentResult.added,
          suggestionsApplied: suggestionResult.applied,
          skipped: commentResult.skipped + suggestionResult.skipped,
        });
      };

      const dispatch = (msg: ChunkEvent) => {
        // Drop late delta/done/error/cancelled events from a superseded run.
        if (!isCurrent()) return;
        if (msg.kind === 'model') {
          responseModel = msg.model;
          opts.onModelObserved?.(msg.model);
        } else if (msg.kind === 'delta') {
          rawAccum += msg.text;
          setPhase({ status: 'streaming', text: visibleNow(false) });
        } else if (msg.kind === 'done') {
          finalize();
        } else if (msg.kind === 'cancelled') {
          // The user pulled the plug — discard partial output, back to compose.
          tokenRef.current = null;
          setPhase({ status: 'idle' });
        } else {
          tokenRef.current = null;
          setPhase({ status: 'error', message: msg.message });
        }
      };

      // Read after asynchronous preflight work so a just-changed footer choice
      // governs the child we are about to spawn.
      const runOptions = opts.getRunOptions?.() ?? { model: null, effort: null };
      if (mock) {
        const token = mock.spawn(
          {
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            prompt,
            addDir: contextFolder,
            allowCreate: fresh,
            model: runOptions.model,
            effort: runOptions.effort,
          },
          dispatch,
        );
        if (isCurrent()) tokenRef.current = token;
        else mock.cancel?.(token);
        return;
      }

      const channel = new Channel<ChunkEvent>();
      channel.onmessage = dispatch;

      try {
        const token = await invoke<string>('spawn_claude_resume', {
          sessionId: binding.sessionId,
          cwd: binding.cwd,
          prompt,
          addDir: contextFolder,
          allowCreate: fresh,
          model: runOptions.model,
          effort: runOptions.effort,
          onEvent: channel,
        });
        // A cancel that landed during the spawn await orphaned this child —
        // cancel it instead of registering its token.
        if (isCurrent()) tokenRef.current = token;
        else await invoke('cancel_claude_resume', { cancelToken: token });
      } catch (e) {
        if (isCurrent()) setPhase({ status: 'error', message: String(e) });
      }
    },
    [opts],
  );

  const cancel = useCallback(async () => {
    // Supersede any in-flight run and reset the UI synchronously — don't wait
    // for a `cancelled` event that the backend may never emit.
    genRef.current += 1;
    const token = tokenRef.current;
    tokenRef.current = null;
    setPhase({ status: 'idle' });
    if (!token) return;
    const mock = typeof window !== 'undefined' ? window.__quillMock : undefined;
    if (mock) {
      mock.cancel?.(token);
      return;
    }
    try {
      await invoke('cancel_claude_resume', { cancelToken: token });
    } catch (e) {
      console.error('Failed to cancel document review:', e);
    }
  }, []);

  const reset = useCallback(() => setPhase({ status: 'idle' }), []);

  return { phase, start, cancel, reset };
}
