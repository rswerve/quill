import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Comment, Suggestion } from '../types';
import { buildAnchorMapper } from './reviewAnchorMap';

/** One annotation whose live range could not be mapped into the canonical document. */
export interface UnmappableAnchor {
  kind: 'comment' | 'suggestion';
  id: string;
}

export type CanonicalCaptureResult =
  | { ok: true; comments: Comment[]; suggestions: Suggestion[] }
  | { ok: false; unmappable: UnmappableAnchor[] };

/**
 * Remap live review coordinates into the CANONICAL document — the one a reopen produces,
 * `parse(serialize(live))` — so a sidecar's stored positions match what a reload builds and
 * whitespace normalization ELSEWHERE no longer drifts anchors. Deterministic: `buildAnchorMapper`
 * carries the exact coordinate delta (no search), even when text repeats.
 *
 * ATOMIC + FAIL-CLOSED. A sidecar stamped with a source hash promises every stored position
 * corresponds to those exact bytes, so capture must NEVER silently store a position it knows is
 * wrong. If a non-detached annotation's range does not map — its content sits INSIDE a
 * normalization-changing zone, e.g. a highlight or tracked edit over a collapsing double space —
 * capture fails and returns the offending records; the caller aborts the ENTIRE save before either
 * file is written, rather than delaying a preventable failure until reopen. A suggestion maps
 * all-or-nothing (its segment text is never altered). A `detached` comment OR suggestion already
 * carries a known-bad range and self-declares non-authoritative, so it passes through untouched
 * and never blocks the save.
 *
 * ONE exception blocks nothing: a RESOLVED comment that fails to map is DETACHED rather than
 * blocking (Maz's call). A resolved comment is dismissed — mark-less, no live highlight — so
 * stopping a save over its stale anchor would only frustrate; detaching preserves the record and
 * lets a reopen relocate it by unique text. An ACTIVE (unresolved) comment still blocks.
 */
export function captureCanonicalReviewState(
  liveDoc: ProseMirrorNode,
  canonDoc: ProseMirrorNode,
  comments: Comment[],
  suggestions: Suggestion[],
): CanonicalCaptureResult {
  const mapper = buildAnchorMapper(liveDoc, canonDoc);
  const unmappable: UnmappableAnchor[] = [];

  const mappedComments = comments.map((comment) => {
    if (comment.detached) return comment;
    const mapped = mapper.map(comment.from, comment.to);
    if (!mapped) {
      // A RESOLVED comment is dismissed — it has no live highlight and must never block a
      // save (Maz's call). Detach it (its stored range is preserved best-effort) so capture
      // proceeds; a reopen relocates it by unique text or keeps it detached. An ACTIVE
      // comment still blocks: its live highlight is text the user is working with.
      if (comment.resolved) return { ...comment, detached: true as const };
      unmappable.push({ kind: 'comment', id: comment.id });
      return comment;
    }
    return { ...comment, from: mapped.from, to: mapped.to };
  });

  const mappedSuggestions = suggestions.map((suggestion) => {
    if (suggestion.detached) return suggestion; // known-bad range; self-declares non-authoritative
    const mapped = suggestion.segments.map((segment) => ({
      segment,
      range: mapper.map(segment.from, segment.to),
    }));
    if (!mapped.every((entry) => entry.range !== null)) {
      unmappable.push({ kind: 'suggestion', id: suggestion.id });
      return suggestion;
    }
    return {
      ...suggestion,
      segments: mapped.map(({ segment, range }) => ({
        ...segment,
        from: range!.from,
        to: range!.to,
      })),
    };
  });

  if (unmappable.length > 0) return { ok: false, unmappable };
  return { ok: true, comments: mappedComments, suggestions: mappedSuggestions };
}
