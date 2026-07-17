import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { StructuralSuggestionRecord } from '../types';
import { projectBlockUnions } from './blockUnionProjection';
import { extractStructuralRecords, type StructuralRecordMetadata } from './structuralExtraction';
import {
  activeRecords,
  activeStructuralChangeIds,
  orphanStructuralChangeIds,
} from '../extensions/StructuralRecordStore';
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
  const activeIds = activeStructuralChangeIds(state.doc);
  if (activeIds.size === 0) {
    // No unions — the disk view is the live document. Keep the caller's exact
    // serialization so the write is byte-for-byte what it was before structural
    // support existed.
    return { ok: true, content: fallbackMarkdown, structural: [] };
  }

  // Fail closed: a live union whose canonical record is missing must never reach
  // disk — reconstruction could not restore it and Save/Reject would have no
  // metadata. The save aborts before writing anything.
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
  let content: string;
  try {
    structural = extractStructuralRecords(state.doc, metadata, serialize);
    content = serialize(projectBlockUnions(state.doc, 'source').doc);
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

  return { ok: true, content, structural };
}
