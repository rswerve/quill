import { editFindLabel, editResultReason } from './trackedEdits';
import type {
  BatchOutcome,
  BatchResultEntry,
  StructuralDispatchOutcome,
} from './structuralBatchDispatch';
import type { StructuralPlanReason } from './structuralEditPlanner';
import type { StructuralMintRefusal } from './structuralMint';

/**
 * 6b-3: the honest, model-facing "N changes weren't applied" notice for a mixed
 * inline+structural batch. It is ONE input-order block that REUSES the inline wording
 * table (`editResultReason`) for inline outcomes and adds structural / XOR-violation
 * lines — never a divergent second table. Successful entries (inline `applied`,
 * structural `minted`) are silent. The original `entries` array is passed so each line
 * can quote the edit's find text via the same `editFindLabel` the inline notice uses.
 */

const CROSS_AXIS =
  'it changes a block that another edit in this batch is restructuring; ask for them one at a time.';

// The supported set is heading↔paragraph, list↔paragraph (a flat list of any item count),
// splitting a paragraph, and merging adjacent paragraphs. The requested op alone can't reveal
// which unsupported case was asked for, so the message names the whole boundary.
const UNSUPPORTED_STRUCTURAL =
  'that structural change isn’t available yet — heading↔paragraph, list↔paragraph, splitting a paragraph, and merging adjacent paragraphs are supported, but a list whose items nest or hold more than one block, a list-kind change (bulleted↔numbered↔checklist), a heading-level change, and merging across a heading or list aren’t.';

// System/provider faults are NOT the model's fault: keep the wording blameless and quiet.
const SYSTEM_FAULT = 'an internal error stopped it; try asking again.';

function structuralPlanReasonText(reason: StructuralPlanReason): string {
  switch (reason) {
    case 'text-not-found':
      return 'this text isn’t in the document.';
    case 'ambiguous-target':
      return 'more than one block matches it; make the text identify a single block.';
    case 'cross-block-target':
      return 'it spans more than one block; a structural change targets a single block.';
    case 'unsupported-op':
      return UNSUPPORTED_STRUCTURAL;
    case 'already-target':
      return 'that block is already the requested type.';
    case 'missing-level':
      return 'a heading target needs a level (1–6).';
    case 'invalid-level':
      return 'that heading level is invalid.';
    case 'invalid-edit':
      return 'the edit instruction is malformed.';
    default:
      return 'it couldn’t be applied.';
  }
}

function structuralMintRefusalText(reason: StructuralMintRefusal): string {
  switch (reason) {
    case 'unsupported-shape':
      return UNSUPPORTED_STRUCTURAL;
    case 'overlapping-structural':
      return 'it overlaps an existing structural change; resolve that one first.';
    // The comment being asked FROM is tolerated (Option-B carveout), so never name "a
    // comment" flatly — that points the reader at the very comment they're using. Name the
    // real blockers: an unresolved tracked suggestion, or a SECOND comment on the block.
    case 'annotated-footprint':
      return 'that block still has an unresolved suggestion or another comment on it — resolve those first.';
    case 'origin-comment-partial':
      return 'the originating comment doesn’t fully cover that block.';
    case 'invalid-structural-state':
      return 'the document has an unresolved structural change; resolve it first.';
    case 'native-no-op':
      return 'the conversion would make no change.';
    // The split pieces are model-supplied, so this is a model-facing message: the pieces
    // must reflow the paragraph's own text (its exact words, split only at whitespace).
    case 'split-source-mismatch':
      return 'the split pieces don’t match that paragraph’s text — they must be its exact words, split at the spaces.';
    // System faults, NOT the model's instruction: in 6b the changeId/author/timestamp/
    // origin are all injected by the orchestrator (allocateReservedId, the AI author,
    // now(), the comment/chat origin) and the op is planner-validated before the mint,
    // so a mint-level invalid-metadata can only be bad injected metadata; target-not-found
    // is a coordinate/translation fault on an already-located block. Both stay blameless.
    case 'invalid-metadata':
    case 'target-not-found':
    case 'id-unavailable':
    case 'self-check-failed':
      return SYSTEM_FAULT;
    default:
      return 'it couldn’t be applied.';
  }
}

function structuralReasonText(outcome: StructuralDispatchOutcome): string | null {
  switch (outcome.status) {
    case 'minted':
      return null; // success is silent
    case 'cross-axis-conflict':
      return CROSS_AXIS;
    case 'id-allocation-failed':
    case 'metadata-provider-failed':
      return SYSTEM_FAULT;
    case 'plan-refused':
      return structuralPlanReasonText(outcome.reason);
    case 'mint-refused':
      return structuralMintRefusalText(outcome.reason);
    default:
      return 'it couldn’t be applied.';
  }
}

/** The reason line for one outcome, or null when it succeeded (silent). */
function noticeReason(outcome: BatchOutcome): string | null {
  if (outcome.kind === 'inline') {
    if ('result' in outcome) {
      return outcome.result.status === 'applied' ? null : editResultReason(outcome.result);
    }
    return CROSS_AXIS; // inline cross-axis-conflict
  }
  if (outcome.kind === 'invalid') {
    return 'it asks for both a text/formatting change and a structural change; request just one.';
  }
  if (outcome.kind === 'unavailable') {
    return 'the document was not ready.'; // mirrors the inline document-unavailable wording
  }
  return structuralReasonText(outcome);
}

export function formatBatchResultNotice(
  results: BatchResultEntry[],
  entries: readonly unknown[],
): string {
  const lines: string[] = [];
  for (const { batchIndex, outcome } of results) {
    const reason = noticeReason(outcome);
    if (reason) lines.push(`• “${editFindLabel(entries[batchIndex])}” — ${reason}`);
  }
  if (lines.length === 0) return '';
  const heading =
    lines.length === 1 ? '1 change wasn’t applied:' : `${lines.length} changes weren’t applied:`;
  return `(${heading}\n${lines.join('\n')})`;
}
