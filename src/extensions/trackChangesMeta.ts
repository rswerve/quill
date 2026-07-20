/** Transactions carrying this key bypass Suggesting-mode transformation. */
export const SKIP_TRACKING_META = 'skipTracking';

/** Typed transaction meta emitted when Suggesting mode vetoes a gesture. */
export const TRACKING_BLOCKED_META = 'trackChangesBlocked';

/** A formatting gesture skipped spans owned by another pending change. */
export const FORMAT_BLOCKED_META = 'trackedFormatBlocked';

/** Internal identity used to coalesce adjacent tracked deletes in history. */
export const TRACKED_DELETE_HISTORY_GROUP_META = 'trackedDeleteHistoryGroup';

/**
 * Marks a transaction as an authorized structural (block-union) mutation, so the
 * structural freeze guard exempts it from the read-only lock over union
 * footprints. Discriminated (not a bare boolean) so the guard has a verifiable,
 * named contract for each authorized action rather than an ad-hoc exemption:
 * `mint` creates a union, `resolve` accepts/rejects one, `restore` reconstructs
 * unions on load. Stamped alongside {@link SKIP_TRACKING_META} (the union rides
 * `blockTrack` node attributes, never inline tracking marks).
 */
export const STRUCTURAL_BYPASS_META = 'structuralBypass';

export type StructuralBypass =
  | { kind: 'mint'; changeId: string }
  | { kind: 'resolve'; changeId: string | null; action: 'accept' | 'reject' }
  | { kind: 'restore' };
