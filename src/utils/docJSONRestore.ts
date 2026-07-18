import { TextSelection } from '@tiptap/pm/state';
import type { Editor as TiptapEditor } from '@tiptap/core';
import { validateSnapshot } from './reviewSnapshotIntegrity';
import { prepareStructuralRecordSeed } from './structuralCanonical';
import { markdownSerializer } from './structuralFingerprint';
import { resetStructuralRecords } from '../extensions/StructuralRecordStore';
import { FIND_KEY } from '../extensions/Find';
import { PENDING_COMMENT_KEY } from '../extensions/PendingComment';
import { ANNOTATION_FOCUS_KEY } from '../extensions/AnnotationFocus';
import { SKIP_TRACKING_META } from '../extensions/trackChangesMeta';
import type { Comment, JSONContent, StructuralSuggestionRecord, Suggestion } from '../types';

/** Outcome of a lossless (PM-JSON) recovery restore. */
export type DocJSONRestoreResult = { ok: true } | { ok: false; reason: string };

/**
 * Replace an editor's whole document with a persisted ProseMirror JSON (all review marks
 * embedded) so crash recovery is byte-exact and NOTHING relocates. Fails closed: the JSON
 * is validated (structure + doc↔records bijection) BEFORE any mutation; on failure the
 * editor is untouched. The single replacement transaction:
 *  - bypasses TrackChanges (`skipTracking` — without it, Suggesting mode re-tracks the
 *    restore and Editing mode strips the restored marks),
 *  - does not flag dirty (`preventUpdate`) and stays out of undo history (`addToHistory`),
 *  - resets the selection to the start and clears carried stored marks,
 *  - clears transient plugin decorations (pending-comment range, annotation focus, find),
 * so a restore never re-tracks itself or inherits stale UI state. PM JSON is the document,
 * not plugin state — hence the explicit resets.
 */
export function restoreDocJSONInto(
  editor: TiptapEditor,
  json: JSONContent,
  comments: Comment[],
  suggestions: Suggestion[],
  structural: readonly StructuralSuggestionRecord[] = [],
): DocJSONRestoreResult {
  const validation = validateSnapshot(editor.schema, json, comments, suggestions);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  // Validate the structural records against the to-be-restored review union BEFORE mutating: a
  // failure leaves the editor untouched so the caller degrades. The seed is metadata only
  // (CanonicalRecord[]) — seeding it in the SAME transaction preserves the restored docJSON
  // byte-for-byte, unlike a reconstruction, which would mutate the losslessly-restored document.
  const serialize = markdownSerializer(editor);
  const seed = prepareStructuralRecordSeed(validation.doc, [...structural], serialize);
  if (!seed.ok) return { ok: false, reason: seed.error };

  const { state, view } = editor;
  const tr = state.tr;
  tr.replaceWith(0, state.doc.content.size, validation.doc.content);
  tr.setSelection(TextSelection.atStart(tr.doc));
  tr.setStoredMarks(null);
  tr.setMeta(SKIP_TRACKING_META, true);
  tr.setMeta('preventUpdate', true);
  tr.setMeta('addToHistory', false);
  tr.setMeta(PENDING_COMMENT_KEY, null);
  tr.setMeta(ANNOTATION_FOCUS_KEY, null);
  tr.setMeta(FIND_KEY, { type: 'query', query: '' });
  resetStructuralRecords(tr, seed.records);
  view.dispatch(tr);
  return { ok: true };
}
