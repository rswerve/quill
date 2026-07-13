export type SuggestingPolicy =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly notice: string };

const ALLOW = { decision: 'allow' } as const satisfies SuggestingPolicy;

function block(notice: string): SuggestingPolicy {
  return { decision: 'block', notice };
}

/**
 * The product contract for Suggesting mode. Transaction classification and UI
 * notices consume this table directly so unsupported gestures cannot silently
 * fall through as committed edits.
 */
export const SUGGESTING_OPERATION_MATRIX = {
  inlineInsert: ALLOW,
  inlineDelete: ALLOW,
  inlineReplace: ALLOW,
  hardBreak: ALLOW,
  annotationMark: ALLOW,
  paragraphStructure: block('Switch to Editing to change paragraph structure.'),
  blockTypeOrAttributes: block('Switch to Editing to change block formatting.'),
  blockOrLeafContent: block('Switch to Editing to insert or remove block content.'),
  tableStructure: block('Switch to Editing to change table structure.'),
  foreignInsertionOverlap: block(
    "Resolve the other author's suggestion before editing its proposed text.",
  ),
  unsafeMappedStep: block('This suggestion could not be applied safely. Nothing changed.'),
} as const satisfies Record<string, SuggestingPolicy>;

export type BlockedOperation =
  | 'paragraphStructure'
  | 'blockTypeOrAttributes'
  | 'blockOrLeafContent'
  | 'tableStructure'
  | 'foreignInsertionOverlap'
  | 'unsafeMappedStep';

export interface TrackingBlockedInfo {
  operation: BlockedOperation | 'inlineFormat';
  notice: string;
  markName?: string;
}

/** Mark-changing toolbar gestures have their own policy alongside text steps. */
export const INLINE_FORMAT_POLICIES = {
  bold: ALLOW,
  italic: ALLOW,
  strike: ALLOW,
  code: block('Switch to Editing to change inline code.'),
  link: block('Switch to Editing to change links.'),
} as const satisfies Record<string, SuggestingPolicy>;

export type InlineMarkCapability = 'track' | 'passthrough' | 'block';

/**
 * Canonical capability registry for every mark the editor may put through a
 * Suggesting-mode transaction. Classification consumes this registry; the
 * transformer never carries its own mark allowlist.
 */
export const INLINE_MARK_CAPABILITIES = {
  bold: 'track',
  italic: 'track',
  strike: 'track',
  code: 'block',
  link: 'block',
  comment: 'passthrough',
  tracked_insert: 'passthrough',
  tracked_delete: 'passthrough',
  tracked_format: 'passthrough',
} as const satisfies Record<string, InlineMarkCapability>;

/** The format tracker derives its capability allowlist from the matrix. */
export const TRACKED_INLINE_FORMAT_MARK_NAMES = new Set(
  Object.entries(INLINE_MARK_CAPABILITIES)
    .filter(([, capability]) => capability === 'track')
    .map(([markName]) => markName),
);

export function inlineMarkCapability(markName: string): InlineMarkCapability {
  return INLINE_MARK_CAPABILITIES[markName as keyof typeof INLINE_MARK_CAPABILITIES] ?? 'block';
}

export function inlineFormatPolicy(markName: string): SuggestingPolicy {
  return (
    INLINE_FORMAT_POLICIES[markName as keyof typeof INLINE_FORMAT_POLICIES] ??
    block('Switch to Editing to change this formatting.')
  );
}

export function blockedOperation(operation: BlockedOperation): TrackingBlockedInfo {
  const policy = SUGGESTING_OPERATION_MATRIX[operation];
  if (policy.decision !== 'block') throw new Error(`${operation} must be blocked`);
  return { operation, notice: policy.notice };
}
