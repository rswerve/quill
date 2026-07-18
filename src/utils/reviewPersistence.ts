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
import {
  relocateComment,
  relocateSuggestion,
  spanAdmitsMark,
  suggestionMarksAdmissible,
  SEGMENT_MARK,
} from './reviewRelocation';
import { rangeText } from './trackedEdits';

export interface ReviewRestoreMismatch {
  suggestionId: string;
  from: number;
  to: number;
  expected: string;
  actual: string | null;
}

/**
 * Whether the persisted review coordinates are authoritative. `bound` — the sidecar's
 * source hash matched the document bytes, so positions are trusted (validated as a
 * corruption defense). `unbound` — legacy/missing hash, or an externally-edited `.md`,
 * so positions are only hints and every anchor is conservatively relocated by unique
 * text. See `src/utils/reviewRelocation.ts`.
 */
export type ReviewRestoreMode = 'bound' | 'unbound';

export interface ReviewRestoreResult {
  /**
   * The complete authoritative comment set after restore — validated/relocated comments
   * with corrected coordinates, plus any newly `detached` ones. Callers REPLACE their
   * comment state with this so the detached flags reach the reconciler.
   */
  comments: Comment[];
  /** Comments re-anchored by unbound relocation (for the "re-attached" notice count). */
  relocatedComments: Comment[];
  /** Comments that could not be re-anchored this load and are now `detached`. */
  detachedComments: Comment[];
  quarantinedSuggestions: Suggestion[];
  /** Suggestions re-anchored by unbound relocation, with corrected segment positions. */
  relocatedSuggestions: Suggestion[];
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

interface CommentRestoreOutcome {
  comments: Comment[];
  relocated: Comment[];
  detached: Comment[];
}

/**
 * A comment's live range in `bound` mode: its stored range, but ONLY while the anchor
 * text still sits there. The hash said the bytes match, so a mismatch is corruption —
 * we do NOT fuzzy-fallback; the caller detaches it.
 */
function locateBoundComment(
  doc: TiptapEditor['state']['doc'],
  comment: Comment,
): { from: number; to: number } | null {
  const range = clampRange(comment.from, comment.to, doc.content.size);
  if (!range) return null;
  return rangeText(doc, range.from, range.to) === comment.anchorText ? range : null;
}

/**
 * Restore comment marks and classify each comment. Resolution controls only whether a
 * MARK is stamped — never whether the anchor is validated, so a resolved comment's
 * coordinates are still checked/corrected (a later unresolve must not trust a stale
 * range). The locator is unique-only whenever the record is already `detached` OR the
 * document is unbound: a persisted detached comment must never re-bind through its stale
 * range on a bound reload. Otherwise a bound comment validates at its stored range. A
 * located range that will be stamped must also ADMIT the comment mark; an unlocatable or
 * ineligible one is preserved `detached` (keeping any `resolved`), with no mark.
 */
function restoreComments(
  tr: Transaction,
  commentType: MarkType | undefined,
  doc: TiptapEditor['state']['doc'],
  comments: Comment[],
  mode: ReviewRestoreMode,
): CommentRestoreOutcome {
  const result: Comment[] = [];
  const relocated: Comment[] = [];
  const detached: Comment[] = [];
  for (const comment of comments) {
    const requiresUnique = mode === 'unbound' || comment.detached === true;
    const willStamp = !comment.resolved;
    let located = requiresUnique ? relocateComment(doc, comment) : locateBoundComment(doc, comment);
    // Mark admissibility defines whether an anchor is USABLE at all — independent of
    // resolution. A resolved comment validated inside a code block would clear detached
    // and later fail silently when unresolved, so gate it here, not only when stamping.
    // (The unbound `relocateComment` already enforces this; the bound path does not.)
    if (located && !spanAdmitsMark(doc, located.from, located.to, 'comment')) {
      located = null;
    }
    if (!located) {
      const record = comment.detached ? comment : { ...comment, detached: true as const };
      result.push(record);
      if (!comment.detached) detached.push(record);
      continue;
    }
    if (willStamp && commentType) {
      tr.addMark(
        located.from,
        located.to,
        commentType.create({ commentId: comment.id, kind: comment.kind, resolved: false }),
      );
    }
    const record: Comment = { ...comment, from: located.from, to: located.to };
    delete record.detached; // adopting a live range clears any detached state
    result.push(record);
    const moved =
      located.from !== comment.from || located.to !== comment.to || comment.detached === true;
    if (requiresUnique && moved) relocated.push(record);
  }
  return { comments: result, relocated, detached };
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

function legacyRangeText(
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

function exactSegmentText(
  doc: TiptapEditor['state']['doc'],
  segment: TrackedChangeSegment,
): string | null {
  if (segment.kind !== 'format' && segment.nodeType === 'hardBreak') {
    if (segment.to !== segment.from + 1) return null;
    return doc.nodeAt(segment.from)?.type.name === 'hardBreak' ? '\n' : null;
  }
  // Ordinary text and records predating the discriminator retain the exact
  // historical leaf-space projection, including a legacy mixed text+break
  // span such as "one two".
  return legacyRangeText(doc, segment.from, segment.to);
}

function suggestionMismatches(
  doc: TiptapEditor['state']['doc'],
  suggestion: LogicalSuggestion,
): ReviewRestoreMismatch[] {
  return suggestion.segments.flatMap((segment) => {
    const { from, to, text: expected } = segment;
    const actual = exactSegmentText(doc, segment);
    return actual === expected ? [] : [{ suggestionId: suggestion.id, from, to, expected, actual }];
  });
}

interface SuggestionRestoreOutcome {
  quarantined: Suggestion[];
  relocated: Suggestion[];
  mismatches: ReviewRestoreMismatch[];
}

/**
 * Two segments cover an overlapping range AND carry mutually-excluding mark types
 * (`tracked_insert` excludes `tracked_delete`). Marks stamp sequentially, so the second
 * such mark EVICTS the first — leaving a span silently unmarked yet reported restored.
 */
function segmentsConflict(
  schema: TiptapEditor['schema'],
  a: TrackedChangeSegment,
  b: TrackedChangeSegment,
): boolean {
  if (a.from >= b.to || b.from >= a.to) return false; // disjoint
  const ma = schema.marks[SEGMENT_MARK[a.kind]];
  const mb = schema.marks[SEGMENT_MARK[b.kind]];
  return Boolean(ma && mb && (ma.excludes(mb) || mb.excludes(ma)));
}

/** A single suggestion whose OWN segments collide (a malformed record). */
function hasInternalConflict(
  schema: TiptapEditor['schema'],
  suggestion: LogicalSuggestion,
): boolean {
  const { segments } = suggestion;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      if (segmentsConflict(schema, segments[i], segments[j])) return true;
    }
  }
  return false;
}

/** Any segment of `a` collides with any segment of `b`. */
function suggestionsConflict(
  schema: TiptapEditor['schema'],
  a: LogicalSuggestion,
  b: LogicalSuggestion,
): boolean {
  return a.segments.some((sa) => b.segments.some((sb) => segmentsConflict(schema, sa, sb)));
}

/**
 * Independently-valid candidates can still collide once stamped — two suggestions on the
 * same span with excluding mark types, OR one malformed suggestion whose own segments
 * exclude each other. Split the batch so any conflicting record (internally, or paired)
 * is quarantined and never stamped, while disjoint ones survive. Applies in BOTH modes,
 * over the candidates' FINAL positions.
 */
function partitionByMarkConflict(
  schema: TiptapEditor['schema'],
  candidates: LogicalSuggestion[],
): { survivors: LogicalSuggestion[]; conflicted: LogicalSuggestion[] } {
  const conflicted = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1) {
    if (hasInternalConflict(schema, candidates[i])) conflicted.add(candidates[i].id);
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (suggestionsConflict(schema, candidates[i], candidates[j])) {
        conflicted.add(candidates[i].id);
        conflicted.add(candidates[j].id);
      }
    }
  }
  return {
    survivors: candidates.filter((suggestion) => !conflicted.has(suggestion.id)),
    conflicted: candidates.filter((suggestion) => conflicted.has(suggestion.id)),
  };
}

/** Mark a record non-authoritative (unless it already is). */
function markSuggestionDetached(suggestion: Suggestion): Suggestion {
  return suggestion.detached ? suggestion : { ...suggestion, detached: true };
}

/** Drop the detached flag on a record that just re-anchored. */
function clearSuggestionDetached(suggestion: LogicalSuggestion): LogicalSuggestion {
  if (!suggestion.detached) return suggestion;
  const next = { ...suggestion };
  delete next.detached;
  return next;
}

/**
 * Restore tracked-change marks. A pending suggestion is UNIQUE-relocated whenever the
 * document is unbound OR the record is already `detached` — its stored range is known-bad,
 * so it must never re-bind to a coincidental repeat, even in a bound sidecar. Otherwise a
 * bound record validates at its stored range (segment text + mark eligibility). A record
 * that re-anchors clears `detached` and adopts its corrected positions and is stamped; one
 * that cannot re-anchor — or loses a mark-exclusion conflict during stamping — is
 * quarantined AND marked `detached`, so a source-hashed sidecar can honestly cover it and
 * later loads treat its coordinates as non-authoritative.
 */
function restoreSuggestions(
  tr: Transaction,
  schema: TiptapEditor['schema'],
  doc: TiptapEditor['state']['doc'],
  suggestions: LogicalSuggestion[],
  mode: ReviewRestoreMode,
  size: number,
): SuggestionRestoreOutcome {
  const toStamp: LogicalSuggestion[] = [];
  const relocatedIds = new Set<string>();
  const quarantined: Suggestion[] = [];
  const mismatches: ReviewRestoreMismatch[] = [];

  for (const suggestion of suggestions) {
    if (suggestion.status !== 'pending') continue;
    const requiresUnique = mode === 'unbound' || suggestion.detached === true;
    if (requiresUnique) {
      const outcome = relocateSuggestion(doc, suggestion);
      if (outcome.status === 'relocated') {
        toStamp.push(clearSuggestionDetached(outcome.suggestion));
        relocatedIds.add(suggestion.id);
      } else {
        quarantined.push(markSuggestionDetached(suggestion));
      }
      continue;
    }
    // Bound + not detached: trust the stored range, validated as a corruption defense.
    const segMismatches = suggestionMismatches(doc, suggestion);
    if (segMismatches.length > 0) {
      mismatches.push(...segMismatches);
      quarantined.push(markSuggestionDetached(suggestion));
    } else if (!suggestionMarksAdmissible(doc, suggestion)) {
      quarantined.push(markSuggestionDetached(suggestion));
    } else {
      toStamp.push(suggestion);
    }
  }

  // Independently-valid candidates can still collide once stamped (excluding mark types
  // over an overlapping span, or a malformed internally-conflicting record).
  const { survivors, conflicted } = partitionByMarkConflict(schema, toStamp);
  restoreSuggestionMarks(tr, schema, survivors, size);
  return {
    quarantined: [...quarantined, ...conflicted.map(markSuggestionDetached)],
    relocated: survivors.filter((suggestion) => relocatedIds.has(suggestion.id)),
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
  mode: ReviewRestoreMode = 'bound',
): ReviewRestoreResult {
  const { state } = editor;
  const { tr, doc, schema } = state;
  const commentType = schema.marks['comment'];
  const size = doc.content.size;
  const logicalSuggestions = normalizePersistedSuggestions(suggestions);

  const suggestionOutcome = restoreSuggestions(tr, schema, doc, logicalSuggestions, mode, size);
  const commentOutcome = restoreComments(tr, commentType, doc, comments, mode);

  if (tr.steps.length) {
    tr.setMeta('preventUpdate', true);
    tr.setMeta('skipTracking', true);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
  }
  return {
    comments: commentOutcome.comments,
    relocatedComments: commentOutcome.relocated,
    detachedComments: commentOutcome.detached,
    quarantinedSuggestions: suggestionOutcome.quarantined,
    relocatedSuggestions: suggestionOutcome.relocated,
    mismatches: suggestionOutcome.mismatches,
  };
}
