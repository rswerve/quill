import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { getTrackedChanges } from '../extensions/TrackChanges';
import { retainedRecords } from '../extensions/StructuralRecordStore';
import { analyzeStructuralUnions } from './structuralUnionIndex';
import type { ReservedIdSources } from './structuralReservedIds';
import type { ChatMessage, Comment, Suggestion } from '../types';

/**
 * 6b-3: extract the seven RAW identity sources a structural batch must reserve against,
 * from the live editor state and the durable side-tables. This is the caller-side glue
 * `collectReservedIds` (structuralReservedIds.ts) documents: it must gather RAW ids —
 * the malformed, filtered-out, inactive, and orphan ones the UI refuses to enumerate —
 * so a freshly minted change can never alias an id already in use anywhere. Pulled out of
 * `DocumentTab` as a pure function so it is independently testable; `DocumentTab` calls it
 * INSIDE `readReservedIds()` at dispatch time (post inline-apply) so every source is fresh.
 */

const TRACKED_MARK_NAMES = new Set(['tracked_insert', 'tracked_delete', 'tracked_format']);

/**
 * Every raw identity carried by a tracked inline mark — BOTH the top-level `attrs.changeId`
 * and the nested `attrs.dataTracked.id`. This scan is deliberately broader than
 * `getTrackedChanges`, which collapses/filters marks (dropping ones with no data id or a
 * non-insert/delete op); a mark it filters out still owns an id a fresh mint must not reuse.
 */
export function rawTrackedInlineIdentityIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (!TRACKED_MARK_NAMES.has(mark.type.name)) continue;
      const attrs = mark.attrs as { changeId?: unknown; dataTracked?: { id?: unknown } };
      if (typeof attrs.changeId === 'string' && attrs.changeId.length > 0) ids.push(attrs.changeId);
      const nested = attrs.dataTracked?.id;
      if (typeof nested === 'string' && nested.length > 0) ids.push(nested);
    }
  });
  return ids;
}

/**
 * Every durable suggestion id recorded on a comment reply or a chat message — across ALL
 * comments (including resolved ones) and ALL messages (including detached/history), since a
 * stale provenance link must not alias a freshly minted change even if its suggestion is no
 * longer live in the document.
 */
function durableSuggestionIds(
  comments: readonly Comment[],
  chatMessages: readonly ChatMessage[],
): string[] {
  const ids: string[] = [];
  for (const comment of comments) {
    for (const reply of comment.replies ?? []) {
      for (const id of reply.suggestionIds ?? []) ids.push(id);
    }
  }
  for (const message of chatMessages) {
    for (const id of message.suggestionIds ?? []) ids.push(id);
  }
  return ids;
}

export interface ReservedIdExtractionInput {
  /** The LIVE editor state, read at dispatch time (after inline apply). */
  state: EditorState;
  /** Quarantined inline suggestions held aside by reconstruction. */
  quarantinedSuggestions: readonly Suggestion[];
  /** Quarantined structural evidence (opaque records) held aside by reconstruction. */
  quarantinedStructural: readonly unknown[];
  /** Every comment (resolved included) — for durable reply suggestion ids. */
  comments: readonly Comment[];
  /** Every chat message (detached/history included) — for durable chat suggestion ids. */
  chatMessages: readonly ChatMessage[];
}

/** Assemble the seven-field {@link ReservedIdSources} for `collectReservedIds`. */
export function extractReservedIdSources(input: ReservedIdExtractionInput): ReservedIdSources {
  const { state, quarantinedSuggestions, quarantinedStructural, comments, chatMessages } = input;
  return {
    liveInlineIds: getTrackedChanges({ state })
      .filter((change) => change.status === 'pending')
      .map((change) => change.id),
    liveInlineIdentityHints: rawTrackedInlineIdentityIds(state.doc),
    liveStructuralIdentityIds: [...analyzeStructuralUnions(state.doc).allIdentityIds],
    retainedStructuralIds: [...retainedRecords(state).keys()],
    quarantinedInlineIds: quarantinedSuggestions.map((suggestion) => suggestion.id),
    quarantinedStructural,
    replyChatSuggestionIds: durableSuggestionIds(comments, chatMessages),
  };
}
