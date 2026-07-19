import type { Editor } from '@tiptap/core';
import type { QuillEdit, QuillStructuralEdit, TrackedEditOrigin } from '../types';
import { applyTrackedEditsToEditor } from './applyTrackedEdits';
import { planEdits, type EditResult } from './trackedEdits';
import {
  planStructuralEdits,
  type PlannedStructuralEdit,
  type StructuralPlanReason,
} from './structuralEditPlanner';
import {
  compileStructuralMint,
  type StructuralMintOrigin,
  type StructuralMintRefusal,
} from './structuralMint';
import { projectCleanSourceDocument } from './cleanSourceProjection';
import { allocateReservedId } from './structuralReservedIds';

/**
 * 6b-2: the deterministic, dependency-injected batch orchestrator that takes ONE
 * interleaved batch of Claude's edits (inline text/format XOR structural block
 * conversions) and lands them together as reviewable tracked suggestions. It is NOT
 * pure — it dispatches real inline and structural transactions through a live editor
 * — but every non-determinism (change id, timestamp, the reserved-id snapshot, the
 * origin) is injected, so the whole sequence is reproducible in a headless test.
 *
 * The batch is a single unit of Claude's intent, so its results are keyed by the
 * IMMUTABLE batch index (position in the original `quill-edits` array), NOT by the
 * per-axis subset index the planners assign after partitioning. `suggestionIds` is
 * the union of the inline ids the engine minted and the structural change ids the
 * compiler minted — exactly the durable provenance the reply / chat message records.
 *
 * The eight-step contract (verified with Codex):
 *  1. Plan BOTH axes on the same PRE-apply clean-source doc (the pending-ignored
 *     document Claude reasoned about) — inline for live positions, structural for
 *     source-coordinate target blocks.
 *  2. Freeze a cross-axis conflict graph over those INITIAL plans, then reject every
 *     node incident to any edge in one pass — two structural edits on the same block,
 *     and any inline edit touching a planned structural target, all refuse together.
 *     Removing the structural pair never retroactively frees the inline edit.
 *  3. Apply the surviving inline edits through the existing tracked-change engine.
 *  4. Re-plan the surviving structural edits on a FRESH clean-source projection of the
 *     now-mutated document (inline apply shifted positions), so dispatch coordinates
 *     are correct — and a re-plan that now refuses (e.g. an edit elsewhere made the
 *     find ambiguous) fails closed.
 *  5. Read the batch-local reserved-id set ONCE, from the POST-inline state.
 *  6. Sort the dispatch candidates back-to-front by live target position.
 *  7. Sequentially allocate an id, translate the target to live coordinates, compile,
 *     and dispatch. Back-to-front over DISTINCT blocks (same-block pairs were rejected
 *     in step 2) keeps every pre-computed target valid, because a mint only inserts
 *     its proposal AFTER the source block — so there is no re-find and no cross-mint
 *     remap. An allocated id stays reserved even when its mint refuses, so the next
 *     edit can never reuse it.
 *  8. Assemble input-order, axis-discriminated results and the minted-id union.
 */

/** Unified provenance for the batch; mapped to each axis's own origin shape. */
export interface BatchOrigin {
  kind: 'comment' | 'chat';
  id: string;
}

export interface StructuralBatchDeps {
  editor: Editor;
  /** AI author id for inline suggestions AND structural records. */
  authorID: string;
  /** Inline author restored after apply when the editor carries no track storage. */
  fallbackAuthor: string;
  origin?: BatchOrigin;
  /** Deterministic change-id source for structural mints (production: a UUID source). */
  nextId: () => string;
  /** ISO-timestamp source, one call per mint (production: `() => new Date().toISOString()`). */
  now: () => string;
  /**
   * The batch-local reserved change-id set, read ONCE after inline apply. Injected so
   * the orchestrator stays free of the extraction wiring (6b-3 builds it with
   * `collectReservedIds` over the live state + durable refs); tests inject a fixed set.
   */
  readReservedIds: () => Set<string>;
}

export type InlineDispatchOutcome =
  | { kind: 'inline'; result: EditResult }
  | { kind: 'inline'; status: 'cross-axis-conflict' };

export type StructuralDispatchOutcome =
  | { kind: 'structural'; status: 'minted'; changeId: string }
  | { kind: 'structural'; status: 'plan-refused'; reason: StructuralPlanReason }
  | { kind: 'structural'; status: 'cross-axis-conflict' }
  | { kind: 'structural'; status: 'id-allocation-failed' }
  | { kind: 'structural'; status: 'metadata-provider-failed' }
  | { kind: 'structural'; status: 'mint-refused'; reason: StructuralMintRefusal };

/** An entry that declared BOTH axes (structural AND replace/format) — a protocol XOR violation. */
export type InvalidDispatchOutcome = { kind: 'invalid'; reason: 'xor-violation' };

export type BatchOutcome =
  | InlineDispatchOutcome
  | StructuralDispatchOutcome
  | InvalidDispatchOutcome;

export interface BatchResultEntry {
  batchIndex: number;
  outcome: BatchOutcome;
}

export interface StructuralBatchDispatchOutcome {
  /** One entry per input edit, in original batch order. */
  results: BatchResultEntry[];
  /** Union of inline suggestion ids and structural change ids actually minted. */
  suggestionIds: string[];
}

/** Own-property presence, tolerant of non-object model JSON. */
function hasOwn(entry: unknown, key: string): boolean {
  return (
    typeof entry === 'object' && entry !== null && Object.prototype.hasOwnProperty.call(entry, key)
  );
}

/**
 * Classify one untrusted model entry by which axis's fields it declares — by PRESENCE,
 * not validated value shape, so a null-valued key still counts. An entry carrying BOTH
 * a `structural` key and a `replace`/`format` key violates the protocol's XOR and is
 * refused outright rather than silently steered into one axis; a structural-only entry
 * goes to the structural planner (which validates its shape), and everything else to the
 * inline planner (which keeps its own validation and Markdown tolerance).
 */
function classifyEntry(entry: unknown): 'inline' | 'structural' | 'invalid' {
  const hasStructural = hasOwn(entry, 'structural');
  const hasInline = hasOwn(entry, 'replace') || hasOwn(entry, 'format');
  if (hasStructural && hasInline) return 'invalid';
  return hasStructural ? 'structural' : 'inline';
}

function toInlineOrigin(origin: BatchOrigin | undefined): TrackedEditOrigin | undefined {
  if (!origin) return undefined;
  return origin.kind === 'comment' ? { commentId: origin.id } : { chatMessageId: origin.id };
}

function toStructuralOrigin(origin: BatchOrigin | undefined): StructuralMintOrigin | undefined {
  return origin ? { kind: origin.kind, id: origin.id } : undefined;
}

/**
 * Whether an inline range [from, to) touches a structural target's block envelope
 * [blockFrom, blockTo). Identical to the source-view gate's overlap semantics: a
 * zero-width inline edit (an insertion) conflicts only STRICTLY inside the envelope,
 * so an insertion exactly at the block's outer boundary is allowed; a nonempty range
 * conflicts on half-open overlap. Outer block boundaries stay clean either way.
 */
export function inlineTouchesBlock(
  from: number,
  to: number,
  blockFrom: number,
  blockTo: number,
): boolean {
  return from === to ? blockFrom < from && from < blockTo : from < blockTo && blockFrom < to;
}

/** Two block envelopes overlap (or coincide) on half-open bounds. */
function blocksOverlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to;
}

type SetOutcome = (batchIndex: number, outcome: BatchOutcome) => void;

interface DispatchCandidate {
  batchIndex: number;
  placed: PlannedStructuralEdit;
  liveTargetPos: number;
}

interface StructuralItem {
  batchIndex: number;
  edit: QuillStructuralEdit;
}

/**
 * STEP 4: re-plan the surviving structural edits on a FRESH clean-source projection
 * of the post-inline document, then pretranslate each target to live coordinates ONCE
 * (round-trip validated). A re-plan refusal or an un-round-trippable target fails
 * closed here; everything else becomes a dispatch candidate carrying a stable live
 * position — so step 7 never translates inside its loop.
 */
function buildStructuralDispatchCandidates(
  editor: Editor,
  survivorStructIndexes: number[],
  structuralEdits: QuillStructuralEdit[],
  structuralItems: StructuralItem[],
  setOutcome: SetOutcome,
): DispatchCandidate[] {
  const postProjection = projectCleanSourceDocument(editor.state.doc);
  const postInverse = postProjection.mapping.invert();
  const rePlan = planStructuralEdits(
    postProjection.doc,
    survivorStructIndexes.map((structEditIndex) => structuralEdits[structEditIndex]),
  );

  const candidates: DispatchCandidate[] = [];
  rePlan.results.forEach((result, k) => {
    const { batchIndex } = structuralItems[survivorStructIndexes[k]];
    if (result.status !== 'planned') {
      setOutcome(batchIndex, {
        kind: 'structural',
        status: 'plan-refused',
        reason: result.reason as StructuralPlanReason,
      });
      return;
    }
    const placed = rePlan.placed.find((entry) => entry.editIndex === k);
    if (!placed) {
      setOutcome(batchIndex, {
        kind: 'structural',
        status: 'mint-refused',
        reason: 'target-not-found',
      });
      return;
    }
    const liveTargetPos = postInverse.map(placed.sourceTargetPos, 1);
    // Round-trip guard: a target that doesn't map cleanly back to its source point is
    // not a placeable live preimage — refuse rather than dispatch a bad position.
    if (postProjection.mapping.map(liveTargetPos, 1) !== placed.sourceTargetPos) {
      setOutcome(batchIndex, {
        kind: 'structural',
        status: 'mint-refused',
        reason: 'target-not-found',
      });
      return;
    }
    candidates.push({ batchIndex, placed, liveTargetPos });
  });
  return candidates;
}

interface MintConfig {
  nextId: () => string;
  now: () => string;
  authorID: string;
  origin: StructuralMintOrigin | undefined;
}

/**
 * STEP 7: allocate an id, compile, and dispatch each candidate back-to-front, using
 * the PRETRANSLATED live position (no in-loop translation). An allocated id stays
 * reserved even when its mint refuses, so a later edit cannot reuse it. Back-to-front
 * over distinct blocks keeps every pretranslated position valid, because a successful
 * mint inserts its proposal only AFTER the (higher-position) source block. Returns the
 * change ids actually minted.
 */
function dispatchStructuralMints(
  editor: Editor,
  candidates: DispatchCandidate[],
  reserved: Set<string>,
  config: MintConfig,
  setOutcome: SetOutcome,
): string[] {
  const mintedIds: string[] = [];
  for (const candidate of candidates) {
    const allocation = allocateReservedId(reserved, config.nextId);
    if (!allocation.ok) {
      setOutcome(candidate.batchIndex, { kind: 'structural', status: 'id-allocation-failed' });
      continue;
    }
    // The timestamp provider is an injected boundary. If it throws, it must NOT abort a
    // partially-applied batch (inline edits and earlier mints have already landed): the
    // allocated id stays reserved, this one candidate is refused, and later candidates
    // still mint. (allocateReservedId already contains a throwing nextId the same way.)
    let createdAt: string;
    try {
      createdAt = config.now();
    } catch {
      setOutcome(candidate.batchIndex, { kind: 'structural', status: 'metadata-provider-failed' });
      continue;
    }
    const mint = compileStructuralMint(editor.state, {
      op: candidate.placed.op,
      targetPos: candidate.liveTargetPos,
      changeId: allocation.id,
      author: config.authorID,
      createdAt,
      origin: config.origin,
    });
    if (mint.ok) {
      editor.view.dispatch(mint.tr);
      mintedIds.push(mint.changeId);
      setOutcome(candidate.batchIndex, {
        kind: 'structural',
        status: 'minted',
        changeId: mint.changeId,
      });
    } else {
      setOutcome(candidate.batchIndex, {
        kind: 'structural',
        status: 'mint-refused',
        reason: mint.reason,
      });
    }
  }
  return mintedIds;
}

export function structuralBatchDispatch(
  entries: readonly unknown[],
  deps: StructuralBatchDeps,
): StructuralBatchDispatchOutcome {
  const { editor, authorID, fallbackAuthor, origin, nextId, now, readReservedIds } = deps;

  const outcomeByIndex = new Map<number, BatchOutcome>();

  // ---- Partition by axis, preserving the immutable batch index. Untrusted model JSON
  // is classified first (XOR-checked) and only THEN narrowed into each axis's type. ----
  const inlineItems: Array<{ batchIndex: number; edit: QuillEdit }> = [];
  const structuralItems: StructuralItem[] = [];
  entries.forEach((entry, batchIndex) => {
    const axis = classifyEntry(entry);
    if (axis === 'invalid') {
      outcomeByIndex.set(batchIndex, { kind: 'invalid', reason: 'xor-violation' });
    } else if (axis === 'structural') {
      structuralItems.push({ batchIndex, edit: entry as QuillStructuralEdit });
    } else {
      inlineItems.push({ batchIndex, edit: entry as QuillEdit });
    }
  });

  // ---- STEP 1: plan both axes on the SAME pre-apply clean-source document. ----
  // The conflict graph lives entirely in clean-source coordinates — the one document
  // both planners operate on, and the one Claude reasoned about.
  const preDoc = editor.state.doc;
  const preProjection = projectCleanSourceDocument(preDoc);

  const inlineEdits = inlineItems.map((item) => item.edit);
  // The FULL initial inline plan — both placements and per-edit results. Retaining the
  // results is load-bearing: an inline edit the initial planner rejected via a cross-edit
  // interaction (an exact duplicate deduped to already-applied, a format/text edit
  // overlapping a placed text edit) must keep that outcome. If it were re-planned in a
  // subset where its conflicting partner was removed (e.g. cross-axis-rejected), it would
  // be RETROACTIVELY FREED and applied — leaking a refused edit. So a non-placed inline
  // outcome is final, and pass 2 (the apply engine's re-plan) only ever sees survivors.
  const inlinePlan = planEdits(preDoc, 0, preDoc.content.size, inlineEdits, authorID);
  const placedInlineIndexes = new Set(inlinePlan.placed.map((placement) => placement.editIndex));
  // planEdits returns LIVE placements (already source-view gated); map each back to
  // clean-source coordinates for the graph. The gate accepted a placement only after
  // `mapping.map(liveFrom, 1) === sourceFrom` (trackedEdits.ts), so this recovers the
  // EXACT source range — no re-planning, and both axes share one coordinate system.
  const inlineSourceRanges = inlinePlan.placed.map((placement) => ({
    inlineEditIndex: placement.editIndex,
    from: preProjection.mapping.map(placement.from, 1),
    to: preProjection.mapping.map(placement.to, -1),
  }));

  const structuralEdits = structuralItems.map((item) => item.edit);
  const prePlan = planStructuralEdits(preProjection.doc, structuralEdits);

  // Every non-placed structural edit's step-1 refusal is its final outcome.
  prePlan.results.forEach((result, structEditIndex) => {
    if (result.status === 'planned') return;
    outcomeByIndex.set(structuralItems[structEditIndex].batchIndex, {
      kind: 'structural',
      status: 'plan-refused',
      reason: result.reason as StructuralPlanReason,
    });
  });

  // ---- STEP 2: freeze the cross-axis conflict graph over the initial plans. ----
  const conflictedStruct = new Set<number>(); // structEditIndex
  const conflictedInline = new Set<number>(); // inline subset index (planner editIndex)

  // structural ↔ structural: two edits on the same or overlapping source block.
  for (let i = 0; i < prePlan.placed.length; i += 1) {
    for (let j = i + 1; j < prePlan.placed.length; j += 1) {
      if (!blocksOverlap(prePlan.placed[i].sourceTarget, prePlan.placed[j].sourceTarget)) continue;
      conflictedStruct.add(prePlan.placed[i].editIndex);
      conflictedStruct.add(prePlan.placed[j].editIndex);
    }
  }
  // inline ↔ structural: an inline edit touching a planned structural target block.
  for (const inlineRange of inlineSourceRanges) {
    for (const placed of prePlan.placed) {
      if (
        !inlineTouchesBlock(
          inlineRange.from,
          inlineRange.to,
          placed.sourceTarget.from,
          placed.sourceTarget.to,
        )
      ) {
        continue;
      }
      conflictedInline.add(inlineRange.inlineEditIndex);
      conflictedStruct.add(placed.editIndex);
    }
  }

  for (const structEditIndex of conflictedStruct) {
    outcomeByIndex.set(structuralItems[structEditIndex].batchIndex, {
      kind: 'structural',
      status: 'cross-axis-conflict',
    });
  }
  inlineItems.forEach((item, inlineEditIndex) => {
    if (conflictedInline.has(inlineEditIndex)) {
      outcomeByIndex.set(item.batchIndex, { kind: 'inline', status: 'cross-axis-conflict' });
    }
  });

  // ---- STEP 3: apply the surviving inline edits through the existing engine. ----
  // Every initially non-placed inline edit keeps its pass-1 result verbatim — it is NEVER
  // re-planned (see the retroactive-freeing note in step 1). Cross-axis edits are always
  // placed, so the partition is exhaustive and disjoint: non-placed → pass-1 result;
  // placed + cross-axis → cross-axis-conflict (set above); placed + survivor → pass 2.
  inlineItems.forEach((item, inlineEditIndex) => {
    if (!placedInlineIndexes.has(inlineEditIndex)) {
      outcomeByIndex.set(item.batchIndex, {
        kind: 'inline',
        result: inlinePlan.results[inlineEditIndex],
      });
    }
  });
  const applyItems = inlineItems.filter(
    (_, inlineEditIndex) =>
      placedInlineIndexes.has(inlineEditIndex) && !conflictedInline.has(inlineEditIndex),
  );
  let inlineSuggestionIds: string[] = [];
  if (applyItems.length > 0) {
    const applied = applyTrackedEditsToEditor({
      editor,
      comment: { from: 0, to: 0 }, // scope 'doc' ignores the anchor
      edits: applyItems.map((item) => item.edit),
      scope: 'doc',
      authorID,
      fallbackAuthor,
      origin: toInlineOrigin(origin),
    });
    inlineSuggestionIds = applied.suggestionIds;
    applyItems.forEach((item, i) => {
      outcomeByIndex.set(item.batchIndex, { kind: 'inline', result: applied.results[i] });
    });
  }

  const setOutcome: SetOutcome = (batchIndex, outcome) => outcomeByIndex.set(batchIndex, outcome);

  // ---- STEP 4: re-plan the surviving structural edits on a FRESH projection. ----
  const survivorStructIndexes = prePlan.placed
    .map((placed) => placed.editIndex)
    .filter((structEditIndex) => !conflictedStruct.has(structEditIndex));
  const candidates = buildStructuralDispatchCandidates(
    editor,
    survivorStructIndexes,
    structuralEdits,
    structuralItems,
    setOutcome,
  );

  // ---- STEP 5 + 6: read reserved ids once, sort dispatch back-to-front. ----
  const reserved = readReservedIds();
  candidates.sort((a, b) => b.liveTargetPos - a.liveTargetPos);

  // ---- STEP 7: sequential allocate → compile → dispatch (pretranslated positions). ----
  const structuralSuggestionIds = dispatchStructuralMints(
    editor,
    candidates,
    reserved,
    { nextId, now, authorID, origin: toStructuralOrigin(origin) },
    setOutcome,
  );

  // ---- STEP 8: assemble input-order results + the minted-id union. ----
  const results: BatchResultEntry[] = [];
  for (let batchIndex = 0; batchIndex < entries.length; batchIndex += 1) {
    const outcome = outcomeByIndex.get(batchIndex);
    if (outcome) results.push({ batchIndex, outcome });
  }
  return { results, suggestionIds: [...inlineSuggestionIds, ...structuralSuggestionIds] };
}
