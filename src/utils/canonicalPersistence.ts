import type { Editor as TiptapEditor } from '@tiptap/core';
import type { Comment, StructuralSuggestionRecord, Suggestion } from '../types';
import { markdownSerializer } from './structuralFingerprint';
import { parseMarkdownToDoc } from './markdownDoc';
import { buildStructuralSavePayload } from './structuralSavePayload';
import {
  buildCanonicalStructuralReview,
  rebaseStructuralRecordsToCanonicalSource,
} from './structuralCanonical';
import { captureCanonicalReviewState, type UnmappableAnchor } from './canonicalCapture';

/** The live review axis (marks are the runtime truth) captured for a write. */
export interface LiveReviewState {
  comments: Comment[];
  suggestions: Suggestion[];
}

/**
 * The result of the combined pre-write capture: the exact source Markdown to write, the inline
 * records captured against the reconstructed canonical review union, and the re-anchored
 * structural records — or a fail-closed reason (an unanchorable inline annotation, or a
 * structural payload/rebase/reconstruction failure), which aborts the whole save.
 */
export type CanonicalSaveState =
  | {
      ok: true;
      markdown: string;
      comments: Comment[];
      suggestions: Suggestion[];
      structural: StructuralSuggestionRecord[];
    }
  | { ok: false; reason: 'review-blocked'; unmappable: UnmappableAnchor[] }
  | { ok: false; reason: 'structural'; error: string };

/**
 * The one combined pre-write pipeline every FILE save route funnels through. It composes the
 * structural (source) and inline (review) axes so a reopen rebuilds EXACTLY what was captured:
 *  1. validated structural SOURCE payload — fail-closed on a quarantined/orphan/incomplete
 *     union; its `content` is the source-only Markdown (never the live union);
 *  2. normalize that SOURCE (write the canonical Markdown when it is a round-trip fixed point,
 *     else the raw source), so the bytes match what a reopen rebuilds — never the union;
 *  3. rebase the structural records' anchors/fingerprints onto that canonical source;
 *  4. reconstruct the canonical review UNION (detached) from the canonical source + records;
 *  5. capture the inline comments/suggestions from the LIVE union INTO that reconstructed
 *     canonical review union, so a proposed-branch anchor maps instead of blocking.
 * Any step failing closed aborts the ENTIRE save before a byte is written.
 *
 * Pure and editor-scoped (no React): the caller supplies the editor, the live serialization
 * (`liveMarkdown`), the quarantined structural records, and the live review state, and receives
 * a typed result. The two projections it produces — canonical SOURCE and canonical review UNION
 * — are intentionally different views of the same content and are never collapsed into one.
 */
export function prepareCanonicalPersistence(
  editor: TiptapEditor,
  liveMarkdown: string,
  quarantinedStructural: readonly unknown[],
  live: LiveReviewState,
): CanonicalSaveState {
  // 1. Structural source payload; fail closed while unreconciled quarantined records exist.
  if (quarantinedStructural.length > 0) {
    return {
      ok: false,
      reason: 'structural',
      error: 'unreconciled structural suggestions on disk',
    };
  }
  const serialize = markdownSerializer(editor);
  const payload = buildStructuralSavePayload(editor, liveMarkdown);
  if (!payload.ok) return { ok: false, reason: 'structural', error: payload.error };
  // 2. Parse the SOURCE, then normalize it (fixed-point-guarded) — never the live union.
  const canonicalSourceDoc = parseMarkdownToDoc(editor, payload.content);
  const canonicalSourceMd = serialize(canonicalSourceDoc);
  const reparsed = parseMarkdownToDoc(editor, canonicalSourceMd);
  const markdown = reparsed.eq(canonicalSourceDoc) ? canonicalSourceMd : payload.content;
  // 3. Re-anchor + re-fingerprint the structural records onto the canonical source.
  const rebased = rebaseStructuralRecordsToCanonicalSource(
    editor.state.doc,
    canonicalSourceDoc,
    payload.structural,
    serialize,
  );
  if (!rebased.ok) return { ok: false, reason: 'structural', error: rebased.error };
  // 4. Reconstruct the canonical review union (detached) from the canonical source.
  const union = buildCanonicalStructuralReview(canonicalSourceDoc, rebased.records, serialize);
  if (!union.ok) return { ok: false, reason: 'structural', error: union.error };
  // 5. Capture inline comments/suggestions from the live union INTO the canonical review union.
  const capture = captureCanonicalReviewState(
    editor.state.doc,
    union.doc,
    live.comments,
    live.suggestions,
  );
  if (!capture.ok) return { ok: false, reason: 'review-blocked', unmappable: capture.unmappable };
  return {
    ok: true,
    markdown,
    comments: capture.comments,
    suggestions: capture.suggestions,
    structural: rebased.records,
  };
}

/**
 * Prepare the DEGRADED-recovery structural bundle for a workspace snapshot.
 *
 * A crash snapshot carries two coherent structural representations in DIFFERENT
 * coordinate spaces (they must never be conflated):
 *  - LOSSLESS: the byte-exact `docJSON` (live union) + live-coordinate records. On
 *    recovery these restore the user's exact unsaved document, whitespace included.
 *  - DEGRADED: the source Markdown + these REBASED records. Degraded recovery
 *    `setContent(sourceMarkdown)` reparses through the production pipeline —
 *    `parseMarkdownToDoc(editor, sourceMarkdown)` — which NORMALIZES whitespace, so
 *    a live-coordinate record's source fingerprint would no longer match and the
 *    proposal would spuriously quarantine. Rebasing the records onto that exact
 *    parsed canonical source makes the degraded reconstruction coordinate-correct.
 *
 * `sourceMarkdown` is the structural SOURCE (`payload.content`), never the union.
 * Returns `{ok:false}` when the rebase can't be built (a should-never-happen
 * malformed live union) so the caller can fail closed and keep the last good
 * snapshot rather than persist a degraded bundle that can't be reconstructed.
 */
export function rebaseForDegradedRecovery(
  editor: TiptapEditor,
  sourceMarkdown: string,
  liveStructural: readonly StructuralSuggestionRecord[],
): { ok: true; records: StructuralSuggestionRecord[] } | { ok: false } {
  if (liveStructural.length === 0) return { ok: true, records: [] };
  const canonicalSourceDoc = parseMarkdownToDoc(editor, sourceMarkdown);
  const serialize = markdownSerializer(editor);
  const rebased = rebaseStructuralRecordsToCanonicalSource(
    editor.state.doc,
    canonicalSourceDoc,
    liveStructural,
    serialize,
  );
  return rebased.ok ? { ok: true, records: rebased.records } : { ok: false };
}
