import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Comment, Suggestion } from '../types';
import { buildAnchorMapper } from './reviewAnchorMap';
import { rangeText } from './trackedEdits';

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
    // Refresh the anchor text to the canonical range it now covers: a highlight that spanned
    // a collapsing double space anchors "foo bar", not the stale "foo  bar". The load path
    // validates a bound comment's anchorText against its range, so a stale one would be
    // dropped; keeping it in step also leaves the record honest for unbound relocation.
    return {
      ...comment,
      from: mapped.from,
      to: mapped.to,
      anchorText: rangeText(canonDoc, mapped.from, mapped.to),
    };
  });

  const mappedSuggestions = suggestions.map((suggestion) => {
    if (suggestion.detached) return suggestion; // known-bad range; self-declares non-authoritative
    const mapped = suggestion.segments.map((segment) => {
      const range = mapper.map(segment.from, segment.to);
      // A comment simply highlights, so a range that shrinks onto the surviving space is
      // fine. A TEXT segment also carries `text` that its range must still spell — validated
      // against BOTH documents: the LIVE range must equal segment.text (else the record is
      // already stale, e.g. a pre-canonicalized text over a live double space), and the
      // mapped CANONICAL range must too (else the collapse fell INSIDE the tracked content,
      // e.g. a tracked double space). Only then is the remap faithful; otherwise fail the
      // save closed. A LEAF segment (hard break, image) carries a placeholder text ("\n")
      // that `rangeText` never reproduces (it projects a leaf as a space) — its identity is
      // validated by the mapper's leaf match instead, so the text check does not apply.
      const isLeaf = segment.kind !== 'format' && segment.nodeType != null;
      const consistent =
        range !== null &&
        (isLeaf ||
          (rangeText(liveDoc, segment.from, segment.to) === segment.text &&
            rangeText(canonDoc, range.from, range.to) === segment.text));
      return { segment, range: consistent ? range : null };
    });
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
