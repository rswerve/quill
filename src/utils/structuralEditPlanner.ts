import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { HeadingLevel, QuillStructuralEdit, StructuralOp } from '../types';

/**
 * 6b-1: plan Claude's structural edits (heading↔paragraph, list↔paragraph) against
 * a single document, in THAT document's coordinates. In the batch flow the caller
 * passes the CLEAN-SOURCE projection, so the returned positions are source
 * coordinates — the batch boundary (6b-2) translates them to live positions with
 * round-trip validation before cross-axis conflict detection and mint dispatch.
 * This module never touches live coordinates and never dispatches.
 *
 * V1 executes only heading↔paragraph (the compiler's V1a scope); every list
 * source or target is planned as a typed `unsupported-op` until the V1b mint
 * extension lands, so Claude's list proposals are refused honestly, not minted.
 */

export type StructuralPlanStatus =
  | 'planned'
  | 'not-found'
  | 'ambiguous'
  | 'unsupported'
  | 'no-op'
  | 'malformed';

export type StructuralPlanReason =
  | 'text-not-found'
  | 'ambiguous-target'
  | 'unsupported-op'
  | 'already-target'
  | 'missing-level'
  | 'invalid-level'
  | 'invalid-edit';

/** One structural edit's outcome, in input order. */
export interface StructuralPlanResult {
  edit: QuillStructuralEdit;
  status: StructuralPlanStatus;
  reason?: StructuralPlanReason;
}

/** A located, executable structural edit — positions in the planned doc's coords. */
export interface PlannedStructuralEdit {
  op: StructuralOp;
  /** A position strictly inside the target top-level textblock. */
  sourceTargetPos: number;
  /** The target block's node range [from, to). */
  sourceTarget: { from: number; to: number };
  editIndex: number;
}

const VALID_TARGETS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList']);

function isHeadingLevel(value: unknown): value is HeadingLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6;
}

/** Locate the single top-level block whose trimmed text equals the trimmed find. */
function locateBlock(
  doc: ProseMirrorNode,
  find: string,
): { node: ProseMirrorNode; pos: number } | 'not-found' | 'ambiguous' {
  const needle = find.trim();
  const hits: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.forEach((node, offset) => {
    if (node.textContent.trim() === needle) hits.push({ node, pos: offset });
  });
  if (hits.length === 0) return 'not-found';
  if (hits.length > 1) return 'ambiguous';
  return hits[0];
}

type OpDerivation = StructuralOp | 'unsupported-op' | 'already-target';

/**
 * Derive the directional {@link StructuralOp} from the source block's current type
 * and the requested target. Level validity is checked by the caller; here `to`
 * === 'heading' always carries a valid level. Only the compiler's V1a pairs
 * (heading↔paragraph) resolve; everything else — list source/target, a heading
 * level change (no such V1 op), any non-heading/paragraph source — is unsupported.
 */
function deriveOp(
  source: ProseMirrorNode,
  to: string,
  level: HeadingLevel | undefined,
): OpDerivation {
  const type = source.type.name;
  if (type === 'heading') {
    const currentLevel = source.attrs.level as number;
    if (to === 'paragraph') {
      return isHeadingLevel(currentLevel)
        ? { kind: 'headingToParagraph', level: currentLevel }
        : 'unsupported-op';
    }
    if (to === 'heading') return currentLevel === level ? 'already-target' : 'unsupported-op';
    return 'unsupported-op'; // heading → list
  }
  if (type === 'paragraph') {
    if (to === 'paragraph') return 'already-target';
    if (to === 'heading') return { kind: 'paragraphToHeading', level: level as HeadingLevel };
    return 'unsupported-op'; // paragraph → list (V1b)
  }
  return 'unsupported-op'; // list source, blockquote, code block, etc.
}

/** Validate the edit's shape; returns a refusal reason, or null when well-formed. */
function shapeRefusal(edit: QuillStructuralEdit): StructuralPlanReason | null {
  if (
    typeof edit !== 'object' ||
    edit === null ||
    typeof edit.find !== 'string' ||
    edit.find.trim().length === 0 ||
    typeof edit.structural !== 'object' ||
    edit.structural === null
  ) {
    return 'invalid-edit';
  }
  const { to, level } = edit.structural;
  if (typeof to !== 'string' || !VALID_TARGETS.has(to)) return 'invalid-edit';
  if (to === 'heading') {
    if (level === undefined) return 'missing-level';
    if (!isHeadingLevel(level)) return 'invalid-level';
  } else if (level !== undefined) {
    // A level on a non-heading target is contradictory — refuse rather than ignore.
    return 'invalid-level';
  }
  return null;
}

function refusalStatus(reason: StructuralPlanReason): StructuralPlanStatus {
  switch (reason) {
    case 'text-not-found':
      return 'not-found';
    case 'ambiguous-target':
      return 'ambiguous';
    case 'unsupported-op':
      return 'unsupported';
    case 'already-target':
      return 'no-op';
    default:
      return 'malformed';
  }
}

/**
 * Plan structural edits against `doc`. Pure and deterministic: returns the located
 * executable edits (in the doc's coordinates) plus an input-order result per edit
 * with a typed refusal reason. No dispatch, no live coordinates, no mutation.
 */
export function planStructuralEdits(
  doc: ProseMirrorNode,
  edits: QuillStructuralEdit[],
): { placed: PlannedStructuralEdit[]; results: StructuralPlanResult[] } {
  const placed: PlannedStructuralEdit[] = [];
  const results: StructuralPlanResult[] = [];

  edits.forEach((edit, editIndex) => {
    const shape = shapeRefusal(edit);
    if (shape) {
      results.push({ edit, status: refusalStatus(shape), reason: shape });
      return;
    }

    const located = locateBlock(doc, edit.find);
    if (located === 'not-found') {
      results.push({ edit, status: 'not-found', reason: 'text-not-found' });
      return;
    }
    if (located === 'ambiguous') {
      results.push({ edit, status: 'ambiguous', reason: 'ambiguous-target' });
      return;
    }

    const op = deriveOp(located.node, edit.structural.to, edit.structural.level);
    if (op === 'unsupported-op' || op === 'already-target') {
      results.push({ edit, status: refusalStatus(op), reason: op });
      return;
    }

    const from = located.pos;
    const to = located.pos + located.node.nodeSize;
    placed.push({
      op,
      sourceTargetPos: from + 1, // strictly inside the target textblock
      sourceTarget: { from, to },
      editIndex,
    });
    results.push({ edit, status: 'planned' });
  });

  return { placed, results };
}
