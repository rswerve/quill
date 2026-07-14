import type { Editor as TiptapEditor } from '@tiptap/core';
import type { MarkType } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type {
  Comment,
  LegacyFormatSuggestion,
  LegacyTextSuggestion,
  LogicalSuggestion,
  Suggestion,
  PersistedSuggestion,
  TrackedChangeInfo,
  TrackedChangeSegment,
} from '../types';

export interface ReviewRestoreMismatch {
  suggestionId: string;
  from: number;
  to: number;
  expected: string;
  actual: string | null;
}

export interface ReviewRestoreResult {
  quarantinedSuggestions: Suggestion[];
  mismatches: ReviewRestoreMismatch[];
}

/** Keep quarantined sidecar records intact while live marks remain canonical. */
export function mergeQuarantinedSuggestions(
  live: Suggestion[],
  quarantined: Suggestion[],
): Suggestion[] {
  const liveIds = new Set(live.map((suggestion) => suggestion.id));
  return [...live, ...quarantined.filter((suggestion) => !liveIds.has(suggestion.id))];
}

/**
 * Review persistence: tracked-change and comment marks are the runtime truth,
 * but marks don't survive Markdown serialization — the .md keeps only their
 * text. So on save the live marks are flattened into `Suggestion` records for
 * the sidecar, and on load those records (plus the comments' stored ranges)
 * are stamped back onto the freshly parsed document. This works because the
 * saved Markdown contains the text of BOTH halves of every pending change
 * (deleted text is kept struck-through, inserted text is present), so the
 * reloaded document's positions line up with the positions captured at save.
 */

/** Serialize live tracked changes into sidecar-shaped suggestion records. */
export function suggestionsFromTrackedChanges(changes: TrackedChangeInfo[]): Suggestion[] {
  return changes
    .filter((c) => c.status === 'pending')
    .map(
      (change): LogicalSuggestion => ({
        id: change.id,
        author: change.authorID,
        createdAt: new Date(change.createdAt).toISOString(),
        status: 'pending',
        ...(change.originCommentId ? { originCommentId: change.originCommentId } : {}),
        ...(change.originChatMessageId ? { originChatMessageId: change.originChatMessageId } : {}),
        type: 'change',
        segments: change.segments.map((segment) =>
          segment.kind === 'format'
            ? {
                ...segment,
                adds: [...segment.adds],
                removes: [...segment.removes],
              }
            : { ...segment },
        ),
      }),
    );
}

function legacyTextSegment(suggestion: LegacyTextSuggestion): TrackedChangeSegment {
  return {
    kind: suggestion.type === 'insertion' ? 'insert' : 'delete',
    from: suggestion.from,
    to: suggestion.to,
    text: suggestion.type === 'insertion' ? suggestion.suggestedText : suggestion.originalText,
  };
}

function logicalFromLegacy(
  suggestion: LegacyTextSuggestion | LegacyFormatSuggestion,
  id = suggestion.id,
  segments?: TrackedChangeSegment[],
): LogicalSuggestion {
  return {
    id,
    author: suggestion.author,
    createdAt: suggestion.createdAt,
    status: suggestion.status,
    ...(suggestion.originCommentId ? { originCommentId: suggestion.originCommentId } : {}),
    ...(suggestion.originChatMessageId
      ? { originChatMessageId: suggestion.originChatMessageId }
      : {}),
    type: 'change',
    segments:
      segments ??
      (suggestion.type === 'format'
        ? suggestion.segments.map((segment) => ({ ...segment, kind: 'format' as const }))
        : [legacyTextSegment(suggestion)]),
  };
}

/** Normalize version-2 pair records into the one-record runtime contract. */
export function normalizePersistedSuggestions(
  suggestions: PersistedSuggestion[],
): LogicalSuggestion[] {
  const logical: LogicalSuggestion[] = [];
  const byPair = new Map<string, LegacyTextSuggestion[]>();
  for (const suggestion of suggestions) {
    if (suggestion.type === 'change') logical.push(suggestion);
    else if (suggestion.type === 'format') logical.push(logicalFromLegacy(suggestion));
    else if (suggestion.pairId) {
      const members = byPair.get(suggestion.pairId) ?? [];
      members.push(suggestion);
      byPair.set(suggestion.pairId, members);
    } else logical.push(logicalFromLegacy(suggestion));
  }
  for (const [pairId, members] of byPair) {
    const insertion = members.find((member) => member.type === 'insertion');
    const deletion = members.find((member) => member.type === 'deletion');
    if (insertion && deletion && members.length === 2) {
      logical.push(
        logicalFromLegacy(deletion, pairId, [
          legacyTextSegment(deletion),
          legacyTextSegment(insertion),
        ]),
      );
    } else {
      for (const member of members) logical.push(logicalFromLegacy(member));
    }
  }
  return logical;
}

function clampRange(from: number, to: number, size: number): { from: number; to: number } | null {
  const clampedFrom = Math.max(0, Math.min(from, size));
  const clampedTo = Math.max(0, Math.min(to, size));
  return clampedTo > clampedFrom ? { from: clampedFrom, to: clampedTo } : null;
}

function restoreCommentMarks(
  tr: Transaction,
  commentType: MarkType | undefined,
  comments: Comment[],
  size: number,
): void {
  if (!commentType) return;
  for (const comment of comments) {
    if (comment.resolved) continue;
    const range = clampRange(comment.from, comment.to, size);
    if (!range) continue;
    tr.addMark(
      range.from,
      range.to,
      commentType.create({ commentId: comment.id, kind: comment.kind, resolved: false }),
    );
  }
}

function restoreLogicalSuggestion(
  tr: Transaction,
  insertType: MarkType | undefined,
  deleteType: MarkType | undefined,
  formatType: MarkType | undefined,
  suggestion: LogicalSuggestion,
  createdAt: number,
  size: number,
): void {
  const logicalKind =
    suggestion.segments.some((segment) => segment.kind === 'insert') &&
    suggestion.segments.some((segment) => segment.kind === 'delete')
      ? ('replacement' as const)
      : undefined;
  for (const segment of suggestion.segments) {
    const range = clampRange(segment.from, segment.to, size);
    if (!range) continue;
    restoreLogicalSegment(
      tr,
      range,
      segment,
      suggestion,
      createdAt,
      logicalKind,
      insertType,
      deleteType,
      formatType,
    );
  }
}

function restoreLogicalSegment(
  tr: Transaction,
  range: { from: number; to: number },
  segment: TrackedChangeSegment,
  suggestion: LogicalSuggestion,
  createdAt: number,
  logicalKind: 'replacement' | undefined,
  insertType: MarkType | undefined,
  deleteType: MarkType | undefined,
  formatType: MarkType | undefined,
): void {
  const dataTracked = {
    id: suggestion.id,
    operation: segment.kind,
    authorID: suggestion.author,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    ...(logicalKind ? { logicalKind } : {}),
    ...(suggestion.originCommentId ? { originCommentId: suggestion.originCommentId } : {}),
    ...(suggestion.originChatMessageId
      ? { originChatMessageId: suggestion.originChatMessageId }
      : {}),
  };
  if (segment.kind === 'format') {
    if (!formatType) return;
    const formatData = {
      ...dataTracked,
      delta: { adds: [...segment.adds], removes: [...segment.removes] },
    };
    tr.addMark(
      range.from,
      range.to,
      formatType.create({ dataTracked: formatData, changeId: suggestion.id }),
    );
    return;
  }
  const type = segment.kind === 'insert' ? insertType : deleteType;
  if (type) tr.addMark(range.from, range.to, type.create({ dataTracked, changeId: suggestion.id }));
}

function restoreSuggestionMarks(
  tr: Transaction,
  schema: TiptapEditor['schema'],
  suggestions: LogicalSuggestion[],
  size: number,
): void {
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];

  for (const suggestion of suggestions) {
    if (suggestion.status !== 'pending') continue;
    const createdAt = Date.parse(suggestion.createdAt) || Date.now();
    restoreLogicalSuggestion(tr, insertType, deleteType, formatType, suggestion, createdAt, size);
  }
}

function exactRangeText(
  doc: TiptapEditor['state']['doc'],
  from: number,
  to: number,
): string | null {
  const size = doc.content.size;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > size || to <= from) {
    return null;
  }
  return doc.textBetween(from, to, '\n', ' ');
}

function suggestionMismatches(
  doc: TiptapEditor['state']['doc'],
  suggestion: LogicalSuggestion,
): ReviewRestoreMismatch[] {
  const spans = suggestion.segments.map(({ from, to, text }) => ({ from, to, expected: text }));
  return spans.flatMap(({ from, to, expected }) => {
    const actual = exactRangeText(doc, from, to);
    return actual === expected ? [] : [{ suggestionId: suggestion.id, from, to, expected, actual }];
  });
}

function quarantineMismatchedSuggestions(
  doc: TiptapEditor['state']['doc'],
  suggestions: LogicalSuggestion[],
): ReviewRestoreResult & { restorableSuggestions: LogicalSuggestion[] } {
  const mismatches = suggestions
    .filter((suggestion) => suggestion.status === 'pending')
    .flatMap((suggestion) => suggestionMismatches(doc, suggestion));
  const mismatchedIds = new Set(mismatches.map((mismatch) => mismatch.suggestionId));
  const isQuarantined = (suggestion: Suggestion) =>
    suggestion.status === 'pending' && mismatchedIds.has(suggestion.id);
  return {
    quarantinedSuggestions: suggestions.filter(isQuarantined),
    restorableSuggestions: suggestions.filter((suggestion) => !isQuarantined(suggestion)),
    mismatches,
  };
}

/**
 * Stamp comment and tracked-change marks back onto a freshly loaded document,
 * in one transaction that:
 *  - sets `preventUpdate`, so restoring marks can't fire onUpdate and mark a
 *    just-opened document dirty;
 *  - sets `skipTracking` (TrackChanges' meta), so the restore is never itself
 *    reinterpreted as an edit to track;
 *  - is excluded from history, so Cmd+Z after opening can't strip the marks.
 * Positions are clamped to the document; a range that collapses is skipped.
 */
export function restoreReviewMarks(
  editor: TiptapEditor,
  comments: Comment[],
  suggestions: PersistedSuggestion[],
): ReviewRestoreResult {
  const { state } = editor;
  const { tr, doc, schema } = state;
  const commentType = schema.marks['comment'];
  const size = doc.content.size;
  const logicalSuggestions = normalizePersistedSuggestions(suggestions);
  const { quarantinedSuggestions, restorableSuggestions, mismatches } =
    quarantineMismatchedSuggestions(doc, logicalSuggestions);

  restoreCommentMarks(tr, commentType, comments, size);
  restoreSuggestionMarks(tr, schema, restorableSuggestions, size);

  if (tr.steps.length) {
    tr.setMeta('preventUpdate', true);
    tr.setMeta('skipTracking', true);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
  }
  return { quarantinedSuggestions, mismatches };
}
