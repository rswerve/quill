import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from '@tiptap/pm/transform';
import { structuralFootprints } from '../utils/structuralFootprints';
import { STRUCTURAL_BYPASS_META, type StructuralBypass } from './trackChangesMeta';

/**
 * The V1 freeze rule: a pending structural union's region is read-only until it
 * is accepted or rejected. This module answers one question — does a transaction
 * illegally modify a frozen union? — as a pure function the dispatch interception
 * consults in both Editing and Suggesting mode.
 *
 * The check runs **per step against that step's own intermediate input document**
 * (`tr.docs[i]`), which sidesteps rebasing later steps' coordinates back onto the
 * original document. Each change id's two branches are merged into one **union
 * envelope** `{from,to}`, so an insertion at the internal source/proposed seam is
 * strictly inside the envelope and blocks, while inserting immediately before or
 * after the whole union stays allowed. Mark, attribute, and node-mark steps carry
 * an empty step map, so their ranges are read from the step directly rather than
 * from the map (which would miss comment, formatting, and attribute edits).
 */

export const STRUCTURAL_FREEZE_NOTICE =
  'This suggestion is locked — accept or reject it before editing.';

export type FreezeViolation = { reason: 'locked'; changeId: string } | { reason: 'unknown-step' };

interface Envelope {
  from: number;
  to: number;
}

/** Whole-union extents keyed by changeId — both branches of a change merged. */
function unionEnvelopes(doc: PMNode): Map<string, Envelope> {
  const envelopes = new Map<string, Envelope>();
  for (const footprint of structuralFootprints(doc)) {
    const existing = envelopes.get(footprint.changeId);
    if (!existing) {
      envelopes.set(footprint.changeId, { from: footprint.from, to: footprint.to });
    } else {
      existing.from = Math.min(existing.from, footprint.from);
      existing.to = Math.max(existing.to, footprint.to);
    }
  }
  return envelopes;
}

/**
 * The document range a step affects, in its input-document coordinates. `null`
 * means the range cannot be determined and the caller must fail closed; a range
 * with `from < 0` affects no block content (a document-level attribute) and is
 * ignored.
 */
function stepAffectedRange(step: Step, doc: PMNode): Envelope | null {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    return { from: step.from, to: step.to };
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    return { from: step.from, to: step.to };
  }
  if (
    step instanceof AttrStep ||
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep
  ) {
    const node = doc.nodeAt(step.pos);
    if (!node) return null;
    return { from: step.pos, to: step.pos + node.nodeSize };
  }
  if (step instanceof DocAttrStep) return { from: -1, to: -1 };
  return null; // an unrecognized doc-changing step → fail closed
}

/** A zero-width insertion blocks only strictly inside; a real range blocks on overlap. */
function rangeTouchesEnvelope(range: Envelope, envelope: Envelope): boolean {
  if (range.from === range.to) return envelope.from < range.from && range.from < envelope.to;
  return range.from < envelope.to && envelope.from < range.to;
}

type BypassScope = { kind: 'all' } | { kind: 'one'; changeId: string } | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Strictly validate the bypass meta and reduce it to a lock-scope authorization.
 * Every variant of {@link StructuralBypass} is checked exactly — kind, required
 * fields, and no extra keys — so a malformed or spoofed meta (e.g. a `resolve`
 * with a bogus `action`) receives NO exemption and fails closed against the lock.
 */
function bypassScope(raw: unknown): BypassScope {
  if (!isPlainObject(raw)) return null;
  const keys = Object.keys(raw);
  switch (raw.kind) {
    case 'restore':
      return keys.length === 1 ? { kind: 'all' } : null;
    case 'mint':
      return keys.length === 2 && nonBlankString(raw.changeId)
        ? { kind: 'one', changeId: raw.changeId }
        : null;
    case 'resolve': {
      // A whole-document resolution (`changeId: null`) bypasses every lock; a
      // scoped resolution bypasses only its own union. Either way `action` must
      // be a real resolution verb.
      if (keys.length !== 3 || (raw.action !== 'accept' && raw.action !== 'reject')) return null;
      if (raw.changeId === null) return { kind: 'all' };
      return nonBlankString(raw.changeId) ? { kind: 'one', changeId: raw.changeId } : null;
    }
    default:
      return null;
  }
}

/**
 * The first frozen union a transaction illegally modifies, or `null` when it is
 * allowed. A scoped bypass exempts only its own change id (a bypass for change A
 * can never mutate change B); a full bypass (`restore` / whole-document `resolve`)
 * and history (undo/redo) exempt everything; an unrecognized doc-changing step
 * fails closed while any lock exists.
 */
export function firstFrozenViolation(tr: Transaction): FreezeViolation | null {
  if (!tr.docChanged) return null;
  if (tr.getMeta('history$')) return null;
  const scope = bypassScope(tr.getMeta(STRUCTURAL_BYPASS_META));
  if (scope?.kind === 'all') return null;

  for (let i = 0; i < tr.steps.length; i += 1) {
    const doc = tr.docs[i];
    const envelopes = unionEnvelopes(doc);
    if (envelopes.size === 0) continue;
    const range = stepAffectedRange(tr.steps[i], doc);
    if (range === null) return { reason: 'unknown-step' };
    if (range.from < 0) continue; // a document-level attribute touches no union
    for (const [changeId, envelope] of envelopes) {
      if (scope?.kind === 'one' && scope.changeId === changeId) continue;
      if (rangeTouchesEnvelope(range, envelope)) return { reason: 'locked', changeId };
    }
  }
  return null;
}
