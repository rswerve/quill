import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import type { EditScope, QuillEdit, TrackedEditOrigin } from '../types';
import { getTrackedChanges, TRACKING_BLOCKED_META } from '../extensions/TrackChanges';
import { buildLinkReplacementContent } from './linkEditing';
import { planEdits, resolveScopeRange } from './trackedEdits';
import type { EditResult } from './trackedEdits';

export interface ApplyTrackedEditsInput {
  editor: Editor;
  /** Anchor range the scope resolves around (ignored for scope 'doc'). */
  comment: { from: number; to: number };
  edits: QuillEdit[];
  scope: EditScope;
  /**
   * The AI author id the suggestions are minted under. Doubles as the
   * cross-author filter: format ops touching another author's pending format
   * suggestion are skipped whole at plan time.
   */
  authorID: string;
  /** Author restored after the apply when the editor carries no track storage. */
  fallbackAuthor: string;
  origin?: TrackedEditOrigin;
}

export interface ApplyTrackedEditsOutcome {
  results: EditResult[];
  suggestionIds: string[];
}

/**
 * The plan→apply seam: turn model-proposed quote edits into tracked-change
 * suggestions through the LIVE editor, and report only what the engine
 * actually did. Forces suggesting mode on (under `authorID`, stamped with
 * `origin` when given) for the duration, applies each placed edit
 * back-to-front, then restores the prior mode/author.
 *
 * Honesty contract (the reason this unit exists — see
 * docs/solutions/ui-bugs/claude-edits-silently-dropped-or-rejected.md):
 * a result reads `applied` only when the tracking engine really dispatched
 * the change. The kernel can still veto a placed edit at dispatch time (a
 * structural case the planner didn't pre-detect, an overlap with another
 * author's pending insertion, table/leaf content); the veto is a no-op
 * transaction carrying TRACKING_BLOCKED_META, so this unit listens for it
 * per edit and flips that edit's result to `engine-blocked`.
 */
export function applyTrackedEditsToEditor(input: ApplyTrackedEditsInput): ApplyTrackedEditsOutcome {
  const { editor: ed, comment, edits, scope, authorID, fallbackAuthor, origin } = input;

  const suggestionIdsBefore = new Set(getTrackedChanges(ed).map((change) => change.id));

  const range = resolveScopeRange(ed.state.doc, comment, scope);
  const { placed, results } = planEdits(ed.state.doc, range.from, range.to, edits, authorID);

  const trackStorage = (
    ed.storage as unknown as Record<string, { enabled: boolean; authorID: string }>
  )['trackChanges'] as { enabled: boolean; authorID: string } | undefined;
  const priorEnabled = trackStorage?.enabled ?? false;
  const priorAuthor = trackStorage?.authorID ?? fallbackAuthor;

  let engineVetoed = false;
  const onEngineVeto = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.getMeta(TRACKING_BLOCKED_META)) engineVetoed = true;
  };
  ed.on('transaction', onEngineVeto);
  try {
    ed.commands.setTrackChangesEnabled(true);
    ed.commands.setTrackChangesAuthor(authorID);
    ed.commands.setTrackChangesOrigin(origin ?? null);
    for (const e of placed) {
      // Back-to-front: applying a later edit doesn't shift earlier offsets.
      engineVetoed = false;
      if (e.kind === 'format') {
        // One chain = one transaction = one gesture, so the engine mints
        // a single format suggestion per edit (with origin stamped).
        let chain = ed.chain().setTextSelection({ from: e.from, to: e.to });
        for (const op of e.marks) {
          chain = op.set ? chain.setMark(op.mark) : chain.unsetMark(op.mark);
        }
        chain.run();
      } else {
        const replacement = e.linkHref
          ? buildLinkReplacementContent(ed, e, e.linkHref, e.replace)
          : null;
        ed.chain()
          .setTextSelection({ from: e.from, to: e.to })
          .insertContent(replacement ?? e.replace)
          .run();
      }
      if (engineVetoed) {
        results[e.editIndex] = {
          edit: results[e.editIndex].edit,
          status: 'conflict',
          reason: 'engine-blocked',
        };
      }
    }
  } finally {
    ed.off('transaction', onEngineVeto);
    ed.commands.setTrackChangesEnabled(priorEnabled);
    ed.commands.setTrackChangesAuthor(priorAuthor);
    ed.commands.setTrackChangesOrigin(null);
  }
  const suggestionIds = getTrackedChanges(ed)
    .filter(
      (change) =>
        !suggestionIdsBefore.has(change.id) &&
        change.originCommentId === origin?.commentId &&
        change.originChatMessageId === origin?.chatMessageId,
    )
    .map((change) => change.id);
  return { results, suggestionIds };
}
