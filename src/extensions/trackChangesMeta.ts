/** Transactions carrying this key bypass Suggesting-mode transformation. */
export const SKIP_TRACKING_META = 'skipTracking';

/** Typed transaction meta emitted when Suggesting mode vetoes a gesture. */
export const TRACKING_BLOCKED_META = 'trackChangesBlocked';

/** A formatting gesture skipped spans owned by another pending change. */
export const FORMAT_BLOCKED_META = 'trackedFormatBlocked';

/** Internal identity used to coalesce adjacent tracked deletes in history. */
export const TRACKED_DELETE_HISTORY_GROUP_META = 'trackedDeleteHistoryGroup';
