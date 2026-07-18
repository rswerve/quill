import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import type { StructuralSuggestionRecord } from '../types';
import { projectBlockUnions } from './blockUnionProjection';
import { extractStructuralRecords, type StructuralRecordMetadata } from './structuralExtraction';
import { reconstructBlockUnions } from './structuralReconstruction';
import {
  activeRecords,
  activeStructuralChangeIds,
  orphanStructuralChangeIds,
} from '../extensions/StructuralRecordStore';
import { structuralFootprints } from './structuralFootprints';
import type { MarkdownSerialize } from './structuralFingerprint';

/**
 * The disk projection of a document that may hold block-union structural
 * suggestions: the SOURCE Markdown (original branch only, no `blockTrack`) that
 * becomes the `.md`, plus the structural records the sidecar's envelope carries.
 * `structural` is empty for a document with no structural changes.
 */
export type StructuralSavePayload =
  | { ok: true; content: string; structural: StructuralSuggestionRecord[] }
  | { ok: false; error: string };

interface MarkdownStorage {
  markdown: { serializer: { serialize: (content: PMNode | Fragment) => string } };
}

function markdownSerializer(editor: TiptapEditor): MarkdownSerialize {
  const storage = editor.storage as unknown as MarkdownStorage;
  return (content) => storage.markdown.serializer.serialize(content);
}

/**
 * Build the two-axis disk payload for a save. This is the ONE synchronous
 * pre-write builder every save route funnels through (rule 3 of the consumer
 * map): it validates and projects BEFORE any byte is written, so a malformed
 * live union aborts the whole save (`.md` and sidecar) instead of writing a
 * half-valid document.
 *
 * Behavior is split by whether the document actually holds a structural union:
 *  - **No structural changes** (today's every-document case): the source
 *    projection is the live document, so the builder returns the caller's exact
 *    current serialization (`fallbackMarkdown` = `getMarkdown()`) verbatim and an
 *    empty record list. This keeps the non-structural save byte-identical to the
 *    pre-structural path — a provable no-op.
 *  - **Structural changes present**: it fails closed on a live union with no
 *    canonical record (orphan) or an incomplete union (extraction drops a change),
 *    projects the structural `source`, serializes it as the `.md`, and returns the
 *    extracted records for the envelope. The inline/comment axis is captured
 *    separately by the caller in review coordinates.
 */
export function buildStructuralSavePayload(
  editor: TiptapEditor,
  fallbackMarkdown: string,
): StructuralSavePayload {
  const { state } = editor;
  // Look at ALL block-track markup, not just complete unions: an INCOMPLETE union
  // (a lone delete or insert branch with no counterpart) has zero *active* ids, so
  // keying the fast path on `activeStructuralChangeIds` would route it down the
  // ordinary-document path and serialize the live document raw — silently ACCEPTING
  // an orphan insert branch into the source `.md`. The fast path is taken only when
  // there is no block-track markup at all.
  const footprints = structuralFootprints(state.doc);
  if (footprints.length === 0) {
    // No structural markup — the disk view is the live document. Keep the caller's
    // exact serialization so the write is byte-for-byte what it was before
    // structural support existed.
    return { ok: true, content: fallbackMarkdown, structural: [] };
  }

  // Fail closed on any block-track markup that is not a COMPLETE, recorded union:
  const activeIds = activeStructuralChangeIds(state.doc);
  // (a) an incomplete union — a footprint whose change has only one branch live.
  const incomplete = [...new Set(footprints.map((f) => f.changeId))].filter(
    (id) => !activeIds.has(id),
  );
  if (incomplete.length > 0) {
    return { ok: false, error: `incomplete structural union: ${incomplete.join(', ')}` };
  }
  // (b) an orphan — a complete union whose canonical record is missing, so
  // reconstruction could not restore it and Save/Reject would have no metadata.
  const orphans = orphanStructuralChangeIds(state);
  if (orphans.length > 0) {
    return {
      ok: false,
      error: `structural change without a record: ${orphans.join(', ')}`,
    };
  }

  const serialize = markdownSerializer(editor);
  const metadata = new Map<string, StructuralRecordMetadata>(
    activeRecords(state).map((record) => [
      record.changeId,
      {
        op: record.op,
        author: record.author,
        createdAt: record.createdAt,
        ...(record.originCommentId ? { originCommentId: record.originCommentId } : {}),
        ...(record.originChatMessageId ? { originChatMessageId: record.originChatMessageId } : {}),
      },
    ]),
  );

  let structural: StructuralSuggestionRecord[];
  let sourceDoc: PMNode;
  try {
    structural = extractStructuralRecords(state.doc, metadata, serialize);
    sourceDoc = projectBlockUnions(state.doc, 'source').doc;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Every active union must have produced exactly one record. A shortfall means a
  // structurally incomplete union (a branch without its counterpart) that
  // extraction dropped — persisting the source while silently losing the proposal
  // would be data loss, so fail closed.
  if (structural.length !== activeIds.size) {
    return { ok: false, error: 'incomplete structural union' };
  }

  // Dry-run the reload: reconstruct the extracted records against the source
  // projection and require it to reproduce the live structural arrangement
  // EXACTLY. Counts alone would miss a complete-but-malformed union — scattered or
  // interleaved branches whose record count matches but that reconstruct into a
  // different order and would quarantine (losing the proposal) on the real reload.
  // Exact parity makes "if it saves, it reloads exactly" true. Marks are ignored:
  // the inline/comment axis is dropped by the source Markdown and restored
  // separately, so it is not part of the structural round trip.
  const dryRun = reconstructBlockUnions(sourceDoc, structural, serialize);
  const restoredIds = new Set(dryRun.restored.map((record) => record.changeId));
  const idsMatch =
    dryRun.quarantined.length === 0 &&
    restoredIds.size === activeIds.size &&
    [...activeIds].every((id) => restoredIds.has(id));
  if (!idsMatch || !structuralSkeletonEq(dryRun.doc, state.doc)) {
    return { ok: false, error: 'structural union would not survive reload' };
  }

  return { ok: true, content: serialize(sourceDoc), structural };
}

const REVIEW_MARK_TYPES = ['tracked_insert', 'tracked_delete', 'tracked_format', 'comment'];

/**
 * Compare two documents' structural skeletons (block tree + `blockTrack` identity),
 * ignoring the inline review axis. Structural reconstruction restores blocks and
 * their branch flags but not inline tracked/comment marks (those are Markdown-
 * dropped and restored on top), so an exact `Node.eq` after stripping those marks
 * is the right "same structural arrangement" test.
 */
function structuralSkeletonEq(a: PMNode, b: PMNode): boolean {
  return stripReviewMarks(a).eq(stripReviewMarks(b));
}

function stripReviewMarks(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  for (const name of REVIEW_MARK_TYPES) {
    const markType = doc.type.schema.marks[name];
    if (markType) tr.removeMark(0, tr.doc.content.size, markType);
  }
  return tr.doc;
}
