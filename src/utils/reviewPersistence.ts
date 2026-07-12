import type { Editor as TiptapEditor } from '@tiptap/core';
import type { MarkType } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type {
  Comment,
  FormatSuggestion,
  Suggestion,
  TextSuggestion,
  TrackedChangeInfo,
} from '../types';

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
    .map((c): Suggestion => {
      const base = {
        id: c.id,
        author: c.authorID,
        createdAt: new Date(c.createdAt).toISOString(),
        status: 'pending' as const,
        ...(c.originCommentId ? { originCommentId: c.originCommentId } : {}),
      };
      if (c.operation === 'format') {
        return {
          ...base,
          type: 'format',
          segments: c.segments.map((segment) => ({
            ...segment,
            adds: [...segment.adds],
            removes: [...segment.removes],
          })),
        };
      }
      return {
        ...base,
        type: c.operation === 'insert' ? 'insertion' : 'deletion',
        from: c.from,
        to: c.to,
        originalText: c.operation === 'delete' ? c.text : '',
        suggestedText: c.operation === 'insert' ? c.text : '',
        ...(c.pairId ? { pairId: c.pairId } : {}),
      };
    });
}

/**
 * Refresh comments' stored anchor ranges from their live marks so the sidecar
 * captures where each comment actually sits after edits (the stored from/to
 * are creation-time snapshots; the marks are the truth). Comments without a
 * live mark (resolved ones) keep their stored range.
 */
export function refreshCommentRanges(
  comments: Comment[],
  findLiveRange: (id: string) => { from: number; to: number } | null,
): Comment[] {
  return comments.map((c) => {
    const live = findLiveRange(c.id);
    return live && (live.from !== c.from || live.to !== c.to)
      ? { ...c, from: live.from, to: live.to }
      : c;
  });
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
      commentType.create({ commentId: comment.id, resolved: false }),
    );
  }
}

function restoreFormatSuggestion(
  tr: Transaction,
  formatType: MarkType | undefined,
  suggestion: FormatSuggestion,
  createdAt: number,
  size: number,
): void {
  if (!formatType) return;
  for (const segment of suggestion.segments) {
    const range = clampRange(segment.from, segment.to, size);
    if (!range) continue;
    const dataTracked = {
      id: suggestion.id,
      operation: 'format',
      authorID: suggestion.author,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      ...(suggestion.originCommentId ? { originCommentId: suggestion.originCommentId } : {}),
      delta: { adds: [...segment.adds], removes: [...segment.removes] },
    };
    tr.addMark(range.from, range.to, formatType.create({ dataTracked, changeId: suggestion.id }));
  }
}

function restoreTextSuggestion(
  tr: Transaction,
  insertType: MarkType | undefined,
  deleteType: MarkType | undefined,
  suggestion: TextSuggestion,
  createdAt: number,
  size: number,
): void {
  if (!insertType || !deleteType) return;
  const range = clampRange(suggestion.from, suggestion.to, size);
  if (!range) return;
  const operation = suggestion.type === 'insertion' ? 'insert' : 'delete';
  const dataTracked = {
    id: suggestion.id,
    operation,
    authorID: suggestion.author,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    ...(suggestion.pairId ? { pairId: suggestion.pairId } : {}),
    ...(suggestion.originCommentId ? { originCommentId: suggestion.originCommentId } : {}),
  };
  const type = operation === 'insert' ? insertType : deleteType;
  tr.addMark(range.from, range.to, type.create({ dataTracked, changeId: suggestion.id }));
}

function restoreSuggestionMarks(
  tr: Transaction,
  schema: TiptapEditor['schema'],
  suggestions: Suggestion[],
  size: number,
): void {
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];

  for (const suggestion of suggestions) {
    if (suggestion.status !== 'pending') continue;
    const createdAt = Date.parse(suggestion.createdAt) || Date.now();
    if (suggestion.type === 'format') {
      restoreFormatSuggestion(tr, formatType, suggestion, createdAt, size);
    } else {
      restoreTextSuggestion(tr, insertType, deleteType, suggestion, createdAt, size);
    }
  }
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
  suggestions: Suggestion[],
): void {
  const { state } = editor;
  const { tr, doc, schema } = state;
  const commentType = schema.marks['comment'];
  const size = doc.content.size;

  restoreCommentMarks(tr, commentType, comments, size);
  restoreSuggestionMarks(tr, schema, suggestions, size);

  if (!tr.steps.length) return;
  tr.setMeta('preventUpdate', true);
  tr.setMeta('skipTracking', true);
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
