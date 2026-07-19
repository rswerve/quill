/**
 * 6b-2: the batch-local reserved changeId set for one structural-proposal batch.
 *
 * A structural mint refuses `id-unavailable` if its changeId is already taken, so a
 * batch of proposals needs collision-free ids that also never alias an EXISTING
 * identity — live or persisted, well-formed or quarantined, actionable or not. This
 * is an EPHEMERAL, batch-local set (never the plugin/store reservation): seed it
 * once from every id source, then allocate against it immediately before each
 * compile, reserving the candidate even if that compile later refuses, so an id is
 * never reused within the batch. Only a successful compiler transaction commits the
 * id to the document / store; a refusal leaves no persistent trace.
 * compileStructuralMint's own live-state check stays the final defense.
 *
 * Seed sources are EXTRACTED BY THE CALLER (the 6b-3 reply wiring) so the collector
 * stays pure and independently testable. Extraction must reserve RAW identities, not
 * just the actionable/enumerable subset — the malformed, incomplete, and orphan ids
 * the UI intentionally refuses to enumerate are exactly the ones a fresh mint must
 * not adopt:
 *  - liveInlineIds          — getTrackedChanges(state) pending change ids
 *  - liveInlineIdentityHints — raw scan of tracked-mark attrs (dataTracked.id /
 *                             changeId) so a mark getTrackedChanges filtered out
 *                             can't be aliased (collision hardening, not enumeration)
 *  - liveStructuralIdentityIds — analyzeStructuralUnions(state.doc).allIdentityIds
 *                             (raw live blockTrack identities, orphans/malformed too)
 *  - retainedStructuralIds  — EVERY retainedRecords key, including inactive records
 *  - quarantinedInlineIds   — every quarantined inline record id
 *  - quarantinedStructural  — quarantined structural evidence (unknown[]); each plain
 *                             object contributes its nonempty string `changeId` and
 *                             `id`, even if the rest of the record is malformed
 *  - replyChatSuggestionIds — all durable AIReply/ChatMessage suggestionIds, so an
 *                             old provenance link can't alias a freshly minted change
 */

export interface ReservedIdSources {
  liveInlineIds: readonly string[];
  liveInlineIdentityHints: readonly string[];
  liveStructuralIdentityIds: readonly string[];
  retainedStructuralIds: readonly string[];
  quarantinedInlineIds: readonly string[];
  quarantinedStructural: readonly unknown[];
  replyChatSuggestionIds: readonly string[];
}

/** The nonempty string `changeId` and `id` of a (possibly malformed) plain-object record. */
function changeIdHints(record: unknown): string[] {
  if (typeof record !== 'object' || record === null) return [];
  const obj = record as Record<string, unknown>;
  const hints: string[] = [];
  for (const key of ['changeId', 'id'] as const) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) hints.push(value);
  }
  return hints;
}

/**
 * Seed the batch-local reserved set from every id source. Non-string / empty ids are
 * dropped; ids are kept EXACT (never trimmed — a trimmed id is a different identity).
 * The quarantined structural evidence is scanned malformed-tolerantly for its
 * top-level `changeId` and `id`, even a record too broken to reconstruct.
 */
export function collectReservedIds(sources: ReservedIdSources): Set<string> {
  const reserved = new Set<string>();
  const add = (id: unknown): void => {
    if (typeof id === 'string' && id.length > 0) reserved.add(id);
  };
  sources.liveInlineIds.forEach(add);
  sources.liveInlineIdentityHints.forEach(add);
  sources.liveStructuralIdentityIds.forEach(add);
  sources.retainedStructuralIds.forEach(add);
  sources.quarantinedInlineIds.forEach(add);
  sources.replyChatSuggestionIds.forEach(add);
  for (const record of sources.quarantinedStructural) {
    for (const hint of changeIdHints(record)) add(hint);
  }
  return reserved;
}

/**
 * Allocate a changeId not already reserved, reserving it IN PLACE so it can't be
 * reused within the batch even if the subsequent compile refuses. `nextId` is
 * injected for deterministic tests (production supplies a UUID / counter source);
 * candidates colliding with an existing or already-allocated id are skipped.
 */
export function allocateReservedId(reserved: Set<string>, nextId: () => string): string {
  let id = nextId();
  while (reserved.has(id)) id = nextId();
  reserved.add(id);
  return id;
}
