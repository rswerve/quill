import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Comment, Suggestion, TrackedChangeInfo } from '../types';

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
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];
  const size = doc.content.size;
  const clamp = (p: number) => Math.max(0, Math.min(p, size));

  if (commentType) {
    for (const c of comments) {
      if (c.resolved) continue;
      const from = clamp(c.from);
      const to = clamp(c.to);
      if (to <= from) continue;
      tr.addMark(from, to, commentType.create({ commentId: c.id, resolved: false }));
    }
  }

  for (const s of suggestions) {
    if (s.status !== 'pending') continue;
    const createdAt = Date.parse(s.createdAt) || Date.now();

    if (s.type === 'format') {
      if (!formatType) continue;
      for (const segment of s.segments) {
        const from = clamp(segment.from);
        const to = clamp(segment.to);
        if (to <= from) continue;
        const dataTracked = {
          id: s.id,
          operation: 'format',
          authorID: s.author,
          status: 'pending',
          createdAt,
          updatedAt: createdAt,
          ...(s.originCommentId ? { originCommentId: s.originCommentId } : {}),
          delta: { adds: [...segment.adds], removes: [...segment.removes] },
        };
        tr.addMark(from, to, formatType.create({ dataTracked, changeId: s.id }));
      }
      continue;
    }

    if (insertType && deleteType) {
      const from = clamp(s.from);
      const to = clamp(s.to);
      if (to <= from) continue;
      const operation = s.type === 'insertion' ? 'insert' : 'delete';
      const dataTracked = {
        id: s.id,
        operation,
        authorID: s.author,
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
        ...(s.pairId ? { pairId: s.pairId } : {}),
        ...(s.originCommentId ? { originCommentId: s.originCommentId } : {}),
      };
      const type = operation === 'insert' ? insertType : deleteType;
      tr.addMark(from, to, type.create({ dataTracked, changeId: s.id }));
    }
  }

  if (!tr.steps.length) return;
  tr.setMeta('preventUpdate', true);
  tr.setMeta('skipTracking', true);
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}
