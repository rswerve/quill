import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { StructuralSuggestionRecord } from '../types';
import { structuralSkeletonEq } from './canonicalDocument';
import { markdownSerializer } from './structuralFingerprint';
import { projectBlockUnions } from './blockUnionProjection';
import {
  extractStructuralRecordsFromIndex,
  type StructuralRecordMetadata,
} from './structuralExtraction';
import { reconstructBlockUnions } from './structuralReconstruction';
import { retainedRecords } from '../extensions/StructuralRecordStore';
import { analyzeStructuralUnions } from './structuralUnionIndex';

/**
 * The disk projection of a document that may hold block-union structural
 * suggestions: the SOURCE Markdown (original branch only, no `blockTrack`) that
 * becomes the `.md`, plus the structural records the sidecar's envelope carries.
 * `structural` is empty for a document with no structural changes.
 */
export type StructuralSavePayload =
  | { ok: true; content: string; structural: StructuralSuggestionRecord[] }
  | { ok: false; error: string };

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
  const retained = retainedRecords(state);
  const index = analyzeStructuralUnions(state.doc, retained);
  if (!index.hasStructuralMarkup) {
    // No structural markup — the disk view is the live document. Keep the caller's
    // exact serialization so the write is byte-for-byte what it was before
    // structural support existed.
    return { ok: true, content: fallbackMarkdown, structural: [] };
  }

  const incompleteIds = new Set(
    index.issues
      .filter((issue) => issue.code === 'branch-count' && issue.changeId)
      .map((issue) => issue.changeId as string),
  );
  if (incompleteIds.size > 0) {
    return { ok: false, error: `incomplete structural union: ${[...incompleteIds].join(', ')}` };
  }
  // Any other topology or declared-op disagreement is malformed. Keep the
  // established reload-parity error surfaced by the old dry-run safeguard.
  if (index.issues.length > 0) {
    return { ok: false, error: 'structural union would not survive reload' };
  }
  // A complete union without canonical metadata cannot restore its proposal.
  if (index.missingMetadataIds.size > 0) {
    return {
      ok: false,
      error: `structural change without a record: ${[...index.missingMetadataIds].join(', ')}`,
    };
  }

  const activeIds = new Set(index.persistable.keys());

  const serialize = markdownSerializer(editor);
  const metadata = new Map<string, StructuralRecordMetadata>(
    [...index.persistable.keys()].map((changeId): [string, StructuralRecordMetadata] => {
      const record = retained.get(changeId) as StructuralRecordMetadata;
      return [
        changeId,
        {
          op: record.op,
          author: record.author,
          createdAt: record.createdAt,
          ...(record.originCommentId ? { originCommentId: record.originCommentId } : {}),
          ...(record.originChatMessageId
            ? { originChatMessageId: record.originChatMessageId }
            : {}),
        },
      ];
    }),
  );

  let structural: StructuralSuggestionRecord[];
  let sourceDoc: PMNode;
  try {
    structural = extractStructuralRecordsFromIndex(index, metadata, serialize);
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
