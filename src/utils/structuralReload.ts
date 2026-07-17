import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { StructuralReviewEnvelope, StructuralSuggestionRecord } from '../types';
import { reconstructFromEnvelope } from './structuralEnvelope';
import { resetStructuralRecords, type CanonicalRecord } from '../extensions/StructuralRecordStore';
import type { MarkdownSerialize } from './structuralFingerprint';

interface MarkdownStorage {
  markdown: { serializer: { serialize: (content: PMNode | Fragment) => string } };
}

function markdownSerializer(editor: TiptapEditor): MarkdownSerialize {
  const storage = editor.storage as unknown as MarkdownStorage;
  return (content) => storage.markdown.serializer.serialize(content);
}

function toCanonicalRecord(record: StructuralSuggestionRecord): CanonicalRecord {
  return {
    changeId: record.changeId,
    op: record.op,
    author: record.author,
    createdAt: record.createdAt,
    ...(record.originCommentId ? { originCommentId: record.originCommentId } : {}),
    ...(record.originChatMessageId ? { originChatMessageId: record.originChatMessageId } : {}),
  };
}

export interface StructuralReloadResult {
  restored: StructuralSuggestionRecord[];
  quarantined: StructuralSuggestionRecord[];
}

/**
 * Reconstruct block-union structural suggestions into a freshly loaded editor,
 * the FIRST step of the two-axis reload — it must run AFTER the source `.md` has
 * been parsed into the editor (`setContent`) and BEFORE inline/comment marks are
 * restored, because it rebuilds the review document those marks' positions were
 * captured against.
 *
 * The editor's current document is the pristine SOURCE (both branches collapsed
 * to the original). This:
 *  1. Gates reconstruction on `sourceHash` (the SHA-256 of the loaded `.md`) — a
 *     mismatch quarantines every record so nothing misbinds onto a shifted block.
 *  2. Replaces the editor document with the reconstructed review document (source
 *     + proposed branches, both flagged) when any record reconstructs.
 *  3. Resets the canonical record store to exactly the reconstructed records, so a
 *     prior document's records never leak in and every live union has its metadata.
 *
 * The replace + store reset run in one history-excluded, tracking-skipped,
 * update-suppressed transaction so a just-opened document is neither marked dirty
 * nor re-interpreted as a tracked edit. Passing `envelope: null` still resets the
 * store (clearing a previous document's records) and leaves the document untouched.
 */
export function reconstructStructuralIntoEditor(
  editor: TiptapEditor,
  envelope: StructuralReviewEnvelope | null,
  sourceHash: string,
): StructuralReloadResult {
  const { state } = editor;

  if (!envelope) {
    const tr = state.tr;
    resetStructuralRecords(tr, []);
    tr.setMeta('preventUpdate', true);
    tr.setMeta('skipTracking', true);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    return { restored: [], quarantined: [] };
  }

  const serialize = markdownSerializer(editor);
  const {
    doc: reviewDoc,
    restored,
    quarantined,
  } = reconstructFromEnvelope(state.doc, sourceHash, envelope, serialize);

  const tr = state.tr;
  if (restored.length > 0) {
    // Replace the whole document with the reconstructed review document. Its
    // top-level content reproduces reviewDoc exactly, so review-coordinate inline
    // and comment positions line up for the mark-restore step that follows.
    tr.replaceWith(0, state.doc.content.size, reviewDoc.content);
  }
  resetStructuralRecords(tr, restored.map(toCanonicalRecord));
  tr.setMeta('preventUpdate', true);
  tr.setMeta('skipTracking', true);
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);

  return { restored, quarantined };
}
