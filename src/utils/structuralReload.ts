import type { Editor as TiptapEditor } from '@tiptap/core';
import type { StructuralReviewEnvelope, StructuralSuggestionRecord } from '../types';
import { reconstructFromEnvelope } from './structuralEnvelope';
import { reconstructBlockUnions, type ReconstructionResult } from './structuralReconstruction';
import { resetStructuralRecords, toCanonicalRecord } from '../extensions/StructuralRecordStore';
import { markdownSerializer } from './structuralFingerprint';

export interface StructuralReloadResult {
  restored: StructuralSuggestionRecord[];
  quarantined: StructuralSuggestionRecord[];
}

/**
 * Apply a reconstruction result to the editor: replace the document with the
 * reconstructed review document when any record reconstructed, and reset the
 * canonical record store to exactly those records (so a prior document's records
 * never leak in and every live union has its metadata). One history-excluded,
 * tracking-skipped, update-suppressed transaction, so a just-opened document is
 * neither marked dirty nor re-interpreted as a tracked edit.
 */
function applyReconstruction(
  editor: TiptapEditor,
  result: ReconstructionResult,
): StructuralReloadResult {
  const { state } = editor;
  const tr = state.tr;
  if (result.restored.length > 0) {
    // The reconstructed review document's top-level content reproduces the review
    // document exactly, so review-coordinate inline and comment positions line up
    // for the mark-restore step that follows.
    tr.replaceWith(0, state.doc.content.size, result.doc.content);
  }
  resetStructuralRecords(tr, result.restored.map(toCanonicalRecord));
  tr.setMeta('preventUpdate', true);
  tr.setMeta('skipTracking', true);
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  return { restored: result.restored, quarantined: result.quarantined };
}

/**
 * Reconstruct block-union structural suggestions into a freshly loaded editor from
 * a persisted sidecar ENVELOPE — the FIRST step of the two-axis file reload. It
 * must run AFTER the source `.md` has been parsed into the editor (`setContent`)
 * and BEFORE inline/comment marks are restored, because it rebuilds the review
 * document those marks' positions were captured against.
 *
 * Reconstruction is gated on `sourceHash` (the SHA-256 of the loaded `.md`) — a
 * mismatch means the file changed outside Quill, so every record is quarantined
 * and nothing misbinds onto a shifted block. Passing `envelope: null` still resets
 * the store (clearing a previous document's records) and leaves the doc untouched.
 */
export function reconstructStructuralIntoEditor(
  editor: TiptapEditor,
  envelope: StructuralReviewEnvelope | null,
  sourceHash: string,
): StructuralReloadResult {
  if (!envelope) return applyReconstruction(editor, emptyReconstruction(editor));
  const serialize = markdownSerializer(editor);
  return applyReconstruction(
    editor,
    reconstructFromEnvelope(editor.state.doc, sourceHash, envelope, serialize),
  );
}

/**
 * Reconstruct block-union structural suggestions into a freshly recovered editor
 * from workspace-recovery RECORDS — the crash-recovery counterpart of
 * `reconstructStructuralIntoEditor`. A workspace snapshot's source Markdown and
 * records were captured together in memory, so there is no external-edit surface
 * and thus no whole-document hash gate; the per-record trust boundary in
 * `reconstructBlockUnions` still quarantines a malformed record. Same ordering
 * contract: run it after `setContent` and before the inline/comment mark restore.
 */
export function reconstructStructuralFromRecords(
  editor: TiptapEditor,
  records: StructuralSuggestionRecord[],
): StructuralReloadResult {
  if (records.length === 0) return applyReconstruction(editor, emptyReconstruction(editor));
  const serialize = markdownSerializer(editor);
  return applyReconstruction(editor, reconstructBlockUnions(editor.state.doc, records, serialize));
}

/** An empty result over the current document — resets the store, changes nothing. */
function emptyReconstruction(editor: TiptapEditor): ReconstructionResult {
  const { doc, tr } = editor.state;
  return { doc, mapping: tr.mapping, restored: [], quarantined: [] };
}
