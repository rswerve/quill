import type {
  Comment,
  Reply,
  PersistedSuggestion,
  SuggestionStatus,
  AISessionBinding,
  FormatSegment,
  TrackedChangeSegment,
  ChatMessage,
  DocumentChatThread,
} from '../types';
import { isEffort } from './claudePreferences';

/**
 * Validation for deserialized annotation data (sidecar + recovery draft).
 *
 * The sidecar and draft are JSON files Quill reads back from disk. They are not
 * always Quill's own well-formed output: a file can be hand-edited, truncated by
 * a crash, corrupted, or — since `.comments.json` sits next to a shared `.md` —
 * supplied by someone else. The editor trusts annotation positions structurally:
 * a comment's `from`/`to` flow into `doc.resolve`, which **throws** on a negative,
 * fractional, `NaN`, or otherwise nonsensical position, white-screening the app
 * on open.
 *
 * So we validate at the deserialization boundary, before any record reaches React
 * state or the editor. The contract is deliberately lenient about *missing* data
 * (a malformed record is dropped, not fatal) and strict about *shape* (every
 * record that survives is structurally sound). Positions are coerced to
 * finite, non-negative integers; out-of-document positions are still clamped at
 * render time, so the only job here is to guarantee `doc.resolve` can't throw.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A finite, non-negative, integer position — or null if the input can't be one. */
function toPosition(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * The stream-observed `model` / `effort` for an AI reply or assistant message,
 * plus each value's observation timestamp. Shared by the reply and chat
 * sanitizers so both round-trips reopen with the same "last observed" state the
 * footer showed live. `model` is stored raw (custom provider/gateway ids are
 * legitimate — see `formatModelLabel`); `effort` must be a known level. A
 * timestamp is carried only alongside a surviving value: an orphan timestamp is
 * never read (the restore scan skips records with no value) but shouldn't linger.
 */
function sanitizeObservations(raw: Record<string, unknown>) {
  return {
    ...(isNonEmptyString(raw.model)
      ? {
          model: raw.model,
          ...(isNonEmptyString(raw.modelObservedAt)
            ? { modelObservedAt: raw.modelObservedAt }
            : {}),
        }
      : {}),
    ...(typeof raw.effort === 'string' && isEffort(raw.effort)
      ? {
          effort: raw.effort,
          ...(isNonEmptyString(raw.effortObservedAt)
            ? { effortObservedAt: raw.effortObservedAt }
            : {}),
        }
      : {}),
  };
}

function sanitizeReply(raw: unknown): Reply | null {
  if (!isObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  return {
    id: raw.id,
    author: typeof raw.author === 'string' ? raw.author : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    ...(raw.authorKind === 'user' || raw.authorKind === 'ai' ? { authorKind: raw.authorKind } : {}),
    ...sanitizeObservations(raw),
    ...(typeof raw.pending === 'boolean' ? { pending: raw.pending } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(Array.isArray(raw.suggestionIds)
      ? {
          suggestionIds: raw.suggestionIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
        }
      : {}),
    ...(raw.dismissed === true ? { dismissed: true } : {}),
  };
}

function sanitizeComment(raw: unknown): Comment | null {
  if (!isObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  const from = toPosition(raw.from);
  const to = toPosition(raw.to);
  if (from === null || to === null) return null;
  const replies = Array.isArray(raw.replies)
    ? raw.replies.map(sanitizeReply).filter((r): r is Reply => r !== null)
    : [];
  const kind: Comment['kind'] = raw.kind === 'claude' ? 'claude' : 'note';
  return {
    id: raw.id,
    anchorText: typeof raw.anchorText === 'string' ? raw.anchorText : '',
    from: Math.min(from, to),
    to: Math.max(from, to),
    author: typeof raw.author === 'string' ? raw.author : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    resolved: raw.resolved === true,
    kind,
    replies,
  };
}

const SUGGESTION_STATUSES: SuggestionStatus[] = ['pending', 'accepted', 'rejected'];
const FORMAT_MARKS = ['bold', 'italic', 'strike', 'code'] as const;

function sanitizeFormatNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter(
        (name): name is string =>
          typeof name === 'string' && (FORMAT_MARKS as readonly string[]).includes(name),
      ),
    ),
  ].sort();
}

function sanitizeFormatSegment(raw: unknown): FormatSegment | null {
  if (!isObject(raw)) return null;
  const from = toPosition(raw.from);
  const to = toPosition(raw.to);
  if (from === null || to === null) return null;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) return null;

  const adds = sanitizeFormatNames(raw.adds);
  const removes = sanitizeFormatNames(raw.removes);
  if (adds.length === 0 && removes.length === 0) return null;
  if (adds.some((name) => removes.includes(name))) return null;

  return {
    from: start,
    to: end,
    text: typeof raw.text === 'string' ? raw.text : '',
    adds,
    removes,
  };
}

function sanitizeTrackedChangeSegment(raw: unknown): TrackedChangeSegment | null {
  if (!isObject(raw)) return null;
  if (raw.kind === 'format') {
    const segment = sanitizeFormatSegment(raw);
    return segment ? { ...segment, kind: 'format' } : null;
  }
  if (raw.kind !== 'insert' && raw.kind !== 'delete') return null;
  const from = toPosition(raw.from);
  const to = toPosition(raw.to);
  if (from === null || to === null) return null;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end || typeof raw.text !== 'string') return null;
  const nodeType = raw.nodeType === 'hardBreak' && raw.text === '\n' ? 'hardBreak' : undefined;
  return {
    kind: raw.kind,
    from: start,
    to: end,
    text: raw.text,
    ...(nodeType ? { nodeType } : {}),
  };
}

function suggestionBase(raw: Record<string, unknown>) {
  const status = SUGGESTION_STATUSES.includes(raw.status as SuggestionStatus)
    ? (raw.status as SuggestionStatus)
    : 'pending';
  return {
    id: raw.id as string,
    author: typeof raw.author === 'string' ? raw.author : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    status,
    ...(isNonEmptyString(raw.originCommentId) ? { originCommentId: raw.originCommentId } : {}),
    ...(isNonEmptyString(raw.originChatMessageId)
      ? { originChatMessageId: raw.originChatMessageId }
      : {}),
  };
}

function sanitizeLogicalSuggestion(
  raw: Record<string, unknown>,
  base: ReturnType<typeof suggestionBase>,
): PersistedSuggestion | null {
  if (!Array.isArray(raw.segments)) return null;
  const segments = raw.segments.map(sanitizeTrackedChangeSegment);
  if (segments.length === 0 || segments.some((segment) => segment === null)) return null;
  return {
    ...base,
    type: 'change',
    segments: (segments as TrackedChangeSegment[]).sort(
      (a, b) => a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind),
    ),
  };
}

function sanitizeLegacyFormatSuggestion(
  raw: Record<string, unknown>,
  base: ReturnType<typeof suggestionBase>,
): PersistedSuggestion | null {
  if (!Array.isArray(raw.segments)) return null;
  const segments = raw.segments.map(sanitizeFormatSegment);
  if (segments.length === 0 || segments.some((segment) => segment === null)) return null;
  const canonical = (segments as FormatSegment[]).sort((a, b) => a.from - b.from || a.to - b.to);
  if (canonical.some((segment, index) => index > 0 && canonical[index - 1].to > segment.from)) {
    return null;
  }
  return { ...base, type: 'format', segments: canonical };
}

function sanitizeLegacyTextSuggestion(
  raw: Record<string, unknown>,
  base: ReturnType<typeof suggestionBase>,
): PersistedSuggestion | null {
  if (raw.type !== 'insertion' && raw.type !== 'deletion') return null;
  const from = toPosition(raw.from);
  const to = toPosition(raw.to);
  if (from === null || to === null) return null;
  return {
    ...base,
    type: raw.type,
    from: Math.min(from, to),
    to: Math.max(from, to),
    originalText: typeof raw.originalText === 'string' ? raw.originalText : '',
    suggestedText: typeof raw.suggestedText === 'string' ? raw.suggestedText : '',
    ...(isNonEmptyString(raw.pairId) ? { pairId: raw.pairId } : {}),
  };
}

function sanitizeSuggestion(raw: unknown): PersistedSuggestion | null {
  if (!isObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  const base = suggestionBase(raw);
  if (raw.type === 'change') return sanitizeLogicalSuggestion(raw, base);
  if (raw.type === 'format') return sanitizeLegacyFormatSuggestion(raw, base);
  return sanitizeLegacyTextSuggestion(raw, base);
}

/** Drop any non-array input and any record that fails the shape check. */
export function sanitizeComments(raw: unknown): Comment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeComment).filter((c): c is Comment => c !== null);
}

export function sanitizeSuggestions(raw: unknown): PersistedSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeSuggestion).filter((s): s is PersistedSuggestion => s !== null);
}

/**
 * An AI session binding is all-or-nothing: a partial binding can't resume a
 * conversation and would only mislead the UI, so anything missing a required
 * field becomes `undefined` (unbound).
 */
export function sanitizeAISession(raw: unknown): AISessionBinding | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.provider !== 'claude-code') return undefined;
  if (
    !isNonEmptyString(raw.sessionId) ||
    typeof raw.cwd !== 'string' ||
    typeof raw.linkedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    provider: 'claude-code',
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    linkedAt: raw.linkedAt,
    ...(raw.createdByQuill === true ? { createdByQuill: true } : {}),
  };
}

/** A context folder is a non-empty string path or nothing. */
export function sanitizeContextFolder(raw: unknown): string | undefined {
  return isNonEmptyString(raw) ? raw : undefined;
}

function sanitizeChatMessage(raw: unknown): ChatMessage | null {
  if (!isObject(raw) || !isNonEmptyString(raw.id)) return null;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  return {
    id: raw.id,
    role: raw.role,
    text: typeof raw.text === 'string' ? raw.text : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    ...sanitizeObservations(raw),
    ...(raw.pending === true ? { pending: true } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(raw.cancelled === true ? { cancelled: true } : {}),
    ...(Array.isArray(raw.suggestionIds)
      ? {
          suggestionIds: raw.suggestionIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
        }
      : {}),
  };
}

export function sanitizeDocumentChat(raw: unknown): DocumentChatThread | undefined {
  if (!isObject(raw) || !isNonEmptyString(raw.sessionId) || !Array.isArray(raw.messages)) {
    return undefined;
  }
  return {
    sessionId: raw.sessionId,
    messages: raw.messages
      .map(sanitizeChatMessage)
      .filter((message): message is ChatMessage => message !== null),
  };
}
